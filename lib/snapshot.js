// lib/snapshot.js
// Builds the consolidated Firebase snapshot at /display/snapshot.json — the
// single source of truth for the ESP32 companion display (Ticket #6 of
// docs/mac_monitor_plan.md).
//
// Snapshot shape (mirrors the plan's Step 1 verification mock):
//   {
//     lastUpdated: <ms>,                    // server clock when the snapshot was built
//     gemini:  { name, remaining, limit_value, weekly_remaining, unit,
//                reset_at, reset_at_weekly, error, seeded_at,
//                spend_pct5h, spend_pct_weekly, spend_reqs5h, spend_reqs_wk,
//                tokens5h, cost5h, tokens_wk, cost_wk },
//     claude:  { ...same fields... },
//     minimax: { ...same fields... },
//     glm:     { ...same fields... },
//     mac:     { last_seen, online, timestamp,
//                current:  { cpu, memory:{used,total,percent},
//                            network:{down,up}, temperature, battery:{percent,charging} },
//                history:  { cpu:[{t,v}], memory:[{t,v}], network_down:[{t,v}],
//                            network_up:[{t,v}], temperature:[{t,v}], battery:[{t,v}] } }
//   }
//
// Why brand nodes live at the top level: the ESP32 parser (Ticket #8) will
// read `snapshot.<brand>.remaining` directly. Nesting under `quotas` (the
// old layout) would force an extra JSON navigation step per metric.
//
// Pure functions only — no I/O, no globals, no time/date side effects except
// the explicit `now` argument. Validated by tests/snapshot.test.js.

'use strict';

const { calcSpendPct } = require('./quota-utils');

const SNAPSHOT_BRANDS = ['gemini', 'claude', 'minimax', 'glm'];
const BRAND_DISPLAY_NAMES = { gemini: 'Antigravity', claude: 'Claude', minimax: 'Minimax', glm: 'GLM' };
const SPEND_LIMITS = {
  gemini:  { limit5h: 2.00,  limitWeekly: 15.00 },
  claude:  { limit5h: 5.00,  limitWeekly: 30.00 },
  minimax: { limit5h: 2.00,  limitWeekly: 15.00 },
  glm:     { limit5h: 0.80,  limitWeekly:  6.00 },
};

// Ring-buffer cap (must match mac-monitor.js sampling cadence and the
// ESP32's MAC_HISTORY cap from Ticket #8).
const MAC_HISTORY_LIMIT = 60;

// Mac staleness threshold: a payload older than this makes mac.online = false.
// Ticket #7 plugs the live POST /api/mac state in; the constant lives here so
// the schema is documented in one place.
const MAC_STALENESS_MS = 10_000;

function emptyMacNode(now) {
  return {
    last_seen: 0,
    online: false,
    timestamp: now,
    current: {
      cpu: 0,
      memory: { used: 0, total: 0, percent: 0 },
      network: { down: 0, up: 0 },
      temperature: null,
      battery: null,
    },
    history: {
      cpu: [],
      memory: [],
      network_down: [],
      network_up: [],
      temperature: [],
      battery: [],
    },
  };
}

// Build a single brand node. Mirrors the inner loop from the pre-Ticket #6
// lib/firebase.js so the ESP32 firmware sees the same field names — the only
// change is the brand lives at the snapshot top level instead of under
// `quotas`.
function buildBrandNode(brand, quotaRow, allSpend, agentUsage) {
  const row = quotaRow || {};

  // RTK spend: prefer the live snapshot from getRtkSpendMetrics(); fall back
  // to the cached raw_json (which is the only place spend lives when the
  // API path didn't return it, e.g. no API key configured).
  let rtk = (allSpend && allSpend[brand]) || null;
  if (!rtk && row.raw_json) {
    let raw = row.raw_json;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (e) { raw = null; }
    }
    rtk = (raw && raw._rtk_spend) ? raw._rtk_spend : raw;
  }

  const lim = SPEND_LIMITS[brand] || { limit5h: 2, limitWeekly: 15 };
  let tok5 = rtk && rtk.tokens5h     ? Math.round(rtk.tokens5h)     : 0;
  let tokW = rtk && rtk.tokensWeekly ? Math.round(rtk.tokensWeekly) : 0;
  let c5   = rtk && rtk.cost5h       ? rtk.cost5h       : 0;
  let cW   = rtk && rtk.costWeekly   ? rtk.costWeekly   : 0;
  let r5   = rtk && rtk.requests5h   ? rtk.requests5h   : 0;
  let rW   = rtk && rtk.requestsWeekly ? rtk.requestsWeekly : 0;

  let resetAt       = row.reset_at        || 0;
  let resetAtWeekly = row.reset_at_weekly || 0;

  // Brands tracked purely via RTK (Claude, unit: 'local') have no provider
  // reset time — derive 5h/weekly boundaries from the RTK rolling window,
  // which the web dashboard already shows.
  if (!resetAt       && rtk && rtk.reset5hAt)     resetAt       = rtk.reset5hAt;
  if (!resetAtWeekly && rtk && rtk.resetWeeklyAt) resetAtWeekly = rtk.resetWeeklyAt;

  if (brand === 'gemini') {
    const rtkGemini    = allSpend && allSpend.gemini ? allSpend.gemini : null;
    const agent5hTokens = agentUsage ? (agentUsage.window5h.input + agentUsage.window5h.output) : 0;
    const agentWkTokens = agentUsage ? (agentUsage.weekly.input   + agentUsage.weekly.output)   : 0;
    const agent5hCost   = agentUsage ? agentUsage.window5h.cost   : 0.0;
    const agentWkCost   = agentUsage ? agentUsage.weekly.cost     : 0.0;
    const agent5hCount  = agentUsage ? agentUsage.window5h.count  : 0;
    const agentWkCount  = agentUsage ? agentUsage.weekly.count    : 0;

    tok5 = (rtkGemini && rtkGemini.tokens5h     != null ? Math.round(rtkGemini.tokens5h)     : 0) + agent5hTokens;
    tokW = (rtkGemini && rtkGemini.tokensWeekly != null ? Math.round(rtkGemini.tokensWeekly) : 0) + agentWkTokens;
    c5   = (rtkGemini && rtkGemini.cost5h      != null ? rtkGemini.cost5h      : 0.0) + agent5hCost;
    cW   = (rtkGemini && rtkGemini.costWeekly  != null ? rtkGemini.costWeekly  : 0.0) + agentWkCost;
    r5   = (rtkGemini && rtkGemini.requests5h   != null ? rtkGemini.requests5h   : 0) + agent5hCount;
    rW   = (rtkGemini && rtkGemini.requestsWeekly != null ? rtkGemini.requestsWeekly : 0) + agentWkCount;

    const agentEarliest5h = agentUsage && agentUsage.window5h.earliest ? agentUsage.window5h.earliest : null;
    const agentEarliestWk = agentUsage && agentUsage.weekly.earliest   ? agentUsage.weekly.earliest   : null;
    const rtkEarliest5h   = rtkGemini && rtkGemini.earliest5hTimestamp     ? rtkGemini.earliest5hTimestamp     : null;
    const rtkEarliestWk   = rtkGemini && rtkGemini.earliestWeeklyTimestamp ? rtkGemini.earliestWeeklyTimestamp : null;

    let earliest5h = null;
    if (agentEarliest5h !== null && rtkEarliest5h !== null) {
      earliest5h = Math.min(agentEarliest5h, rtkEarliest5h);
    } else {
      earliest5h = agentEarliest5h !== null ? agentEarliest5h : rtkEarliest5h;
    }

    let earliestWk = null;
    if (agentEarliestWk !== null && rtkEarliestWk !== null) {
      earliestWk = Math.min(agentEarliestWk, rtkEarliestWk);
    } else {
      earliestWk = agentEarliestWk !== null ? agentEarliestWk : rtkEarliestWk;
    }

    if (earliest5h !== null) resetAt       = earliest5h + 5 * 3600 * 1000;
    if (earliestWk !== null) resetAtWeekly = earliestWk + 7 * 24 * 3600 * 1000;
  }

  return {
    name:             BRAND_DISPLAY_NAMES[brand] || brand,
    remaining:        row.remaining        !== null && row.remaining        !== undefined ? row.remaining        : -1,
    limit_value:      row.limit_value      !== null && row.limit_value      !== undefined ? row.limit_value      : -1,
    weekly_remaining: row.weekly_remaining !== null && row.weekly_remaining !== undefined ? row.weekly_remaining : -1,
    unit:             row.unit             || 'not_exposed',
    // ESP32 uses time(nullptr) which returns SECONDS. Divide ms→s here so
    // getResetString() and formatAbsoluteReset() on the firmware get correct
    // countdowns. Guard 0/null so the firmware's "--:--" path still fires.
    reset_at:         resetAt         ? Math.round(resetAt         / 1000) : 0,
    reset_at_weekly:  resetAtWeekly   ? Math.round(resetAtWeekly   / 1000) : 0,
    error:            row.error            || '',
    seeded_at:        row.seeded_at        || 0,
    spend_pct5h:      tok5 > 0 ? Math.round(calcSpendPct(c5, lim.limit5h))     : 0,
    spend_pct_weekly: tokW > 0 ? Math.round(calcSpendPct(cW, lim.limitWeekly)) : 0,
    spend_reqs5h:     r5,
    spend_reqs_wk:    rW,
    tokens5h:         tok5,
    cost5h:           parseFloat(c5.toFixed(4)),
    tokens_wk:        tokW,
    cost_wk:          parseFloat(cW.toFixed(4)),
  };
}

// Fill in a placeholder for any brand that has no row in the DB. Keeps the
// snapshot shape stable for the ESP32 parser — it can rely on all four
// keys being present even before the first seed completes.
function placeholderBrandNode(brand, now) {
  return {
    name:             BRAND_DISPLAY_NAMES[brand] || brand,
    remaining:        -1,
    limit_value:      -1,
    weekly_remaining: -1,
    unit:             'not_exposed',
    reset_at:         0,
    reset_at_weekly:  0,
    error:            'no_data',
    seeded_at:        now,
    spend_pct5h:      0,
    spend_pct_weekly: 0,
    spend_reqs5h:     0,
    spend_reqs_wk:    0,
    tokens5h:         0,
    cost5h:           0,
    tokens_wk:        0,
    cost_wk:          0,
  };
}

// Merge a posted /api/mac payload into the mac node, computing `online`
// from the staleness threshold. Caller is responsible for validating the
// payload shape (use validateMacPayload).
function mergeMacState(macState, now) {
  const lastSeen = (macState && macState.last_seen) || (macState && macState.timestamp) || 0;
  return {
    last_seen: lastSeen,
    online:    lastSeen > 0 && (now - lastSeen) < MAC_STALENESS_MS,
    timestamp: (macState && macState.timestamp) || now,
    current:   (macState && macState.current)   || emptyMacNode(now).current,
    history:   (macState && macState.history)   || emptyMacNode(now).history,
  };
}

// Build the full /display/snapshot.json payload.
// Inputs:
//   brandQuotas: array of rows from brand_quota table (see lib/quota-cache.js)
//   allSpend:    result of getRtkSpendMetrics() — keyed by brand
//   agentUsage:  { total, window5h, weekly } aggregated SQLite result (or null)
//   macState:    raw mac node from /api/mac (or null for empty placeholder)
//   now:         override the wall clock (used in tests)
function buildSnapshot({ brandQuotas = [], allSpend = null, agentUsage = null, macState = null, now = Date.now() } = {}) {
  const snapshot = { lastUpdated: now };

  for (const brand of SNAPSHOT_BRANDS) {
    const row = brandQuotas.find(r => r.brand === brand) || null;
    snapshot[brand] = row
      ? buildBrandNode(brand, row, allSpend, agentUsage)
      : placeholderBrandNode(brand, now);
  }

  snapshot.mac = macState ? mergeMacState(macState, now) : emptyMacNode(now);

  return snapshot;
}

// Validate the body of POST /api/mac (Ticket #7 will use this). The function
// is pure: same input → same output. Tests assert each failure mode.
function validateMacPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }

  const errors = [];

  if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp) || body.timestamp <= 0) {
    errors.push('timestamp must be a positive number (ms since epoch)');
  }

  if (!body.current || typeof body.current !== 'object' || Array.isArray(body.current)) {
    errors.push('current must be an object');
  } else {
    const c = body.current;

    if (typeof c.cpu !== 'number' || !Number.isFinite(c.cpu) || c.cpu < 0 || c.cpu > 100) {
      errors.push('current.cpu must be a number between 0 and 100');
    }

    if (!c.memory || typeof c.memory !== 'object' || Array.isArray(c.memory)) {
      errors.push('current.memory must be an object');
    } else {
      if (typeof c.memory.used !== 'number' || c.memory.used < 0) {
        errors.push('current.memory.used must be a non-negative number');
      }
      if (typeof c.memory.total !== 'number' || c.memory.total < 0) {
        errors.push('current.memory.total must be a non-negative number');
      }
      if (typeof c.memory.percent !== 'number' || c.memory.percent < 0 || c.memory.percent > 100) {
        errors.push('current.memory.percent must be a number between 0 and 100');
      }
    }

    if (!c.network || typeof c.network !== 'object' || Array.isArray(c.network)) {
      errors.push('current.network must be an object');
    } else {
      if (typeof c.network.down !== 'number' || c.network.down < 0) {
        errors.push('current.network.down must be a non-negative number');
      }
      if (typeof c.network.up !== 'number' || c.network.up < 0) {
        errors.push('current.network.up must be a non-negative number');
      }
    }

    // temperature is allowed to be null (no sudo / no native compile per Ticket #5)
    if (c.temperature !== null && c.temperature !== undefined &&
        (typeof c.temperature !== 'number' || !Number.isFinite(c.temperature))) {
      errors.push('current.temperature must be a number or null');
    }

    if (c.battery !== null && c.battery !== undefined) {
      if (typeof c.battery !== 'object' || Array.isArray(c.battery)) {
        errors.push('current.battery must be an object or null');
      } else {
        if (typeof c.battery.percent !== 'number' || c.battery.percent < 0 || c.battery.percent > 100) {
          errors.push('current.battery.percent must be a number between 0 and 100');
        }
        if (typeof c.battery.charging !== 'boolean') {
          errors.push('current.battery.charging must be a boolean');
        }
      }
    }
  }

  if (body.history !== undefined && body.history !== null &&
      (typeof body.history !== 'object' || Array.isArray(body.history))) {
    errors.push('history must be an object (may be empty {})');
  }

  return { ok: errors.length === 0, errors };
}

// Append a {t, v} sample to a ring buffer, capping at MAC_HISTORY_LIMIT.
function appendMacSample(buffer, sample) {
  if (!Array.isArray(buffer)) return [];
  if (!sample || typeof sample.t !== 'number' || typeof sample.v !== 'number') return buffer.slice();
  const next = buffer.length >= MAC_HISTORY_LIMIT ? buffer.slice(1) : buffer.slice();
  next.push({ t: sample.t, v: sample.v });
  return next;
}

module.exports = {
  SNAPSHOT_BRANDS,
  BRAND_DISPLAY_NAMES,
  MAC_HISTORY_LIMIT,
  MAC_STALENESS_MS,
  emptyMacNode,
  buildBrandNode,
  placeholderBrandNode,
  buildSnapshot,
  mergeMacState,
  validateMacPayload,
  appendMacSample,
};
