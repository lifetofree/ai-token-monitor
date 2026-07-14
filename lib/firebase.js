// lib/firebase.js
// Publishes quota snapshot to Firebase Realtime Database for the ESP32 display.
// Payload shape matches firmware/esp32-display/esp32-display.ino expectations:
//   quotas.{brand}: remaining, limit_value, weekly_remaining, unit, reset_at,
//                   reset_at_weekly, error, seeded_at, spend_pct5h,
//                   spend_pct_weekly, spend_reqs5h, spend_reqs_wk,
//                   tokens5h, cost5h, tokens_wk, cost_wk
'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { calcSpendPct } = require('./quota-utils');

const homeDir = process.env.HOME || require('os').homedir();
const DB_PATH = process.env.RTK_DB_PATH || path.join(homeDir, 'Library/Application Support/rtk/history.db');

function parseRawJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (e) { return null; }
}

async function publishToFirebase(results, env, allSpend) {
  const dbUrl  = env.FIREBASE_URL  || env.FIREBASE_DB_URL  || process.env.FIREBASE_URL  || process.env.FIREBASE_DB_URL;
  const secret = env.FIREBASE_AUTH || env.FIREBASE_DB_SECRET || process.env.FIREBASE_AUTH || process.env.FIREBASE_DB_SECRET;
  if (!dbUrl || !secret) return;

  const NAMES = { gemini: 'Antigravity', claude: 'Claude', minimax: 'Minimax', glm: 'GLM' };
  const SPEND_LIMITS = {
    gemini:  { limit5h: 2.00,  limitWeekly: 15.00 },
    claude:  { limit5h: 5.00,  limitWeekly: 30.00 },
    minimax: { limit5h: 2.00,  limitWeekly: 15.00 },
    glm:     { limit5h: 0.80,  limitWeekly:  6.00 },
  };
  const agentUsage = await new Promise((resolve) => {
    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const query = `SELECT 'total' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage UNION ALL SELECT '5h' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage WHERE last_updated >= ${fiveHoursAgo} UNION ALL SELECT 'weekly' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage WHERE last_updated >= ${sevenDaysAgo};`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        const rows = JSON.parse(stdout);
        const res = {
          total:    { count: 0, input: 0, output: 0, cost: 0, earliest: null },
          window5h: { count: 0, input: 0, output: 0, cost: 0, earliest: null },
          weekly:   { count: 0, input: 0, output: 0, cost: 0, earliest: null }
        };
        rows.forEach(row => {
          const stats = { count: row.count || 0, input: row.input || 0, output: row.output || 0, cost: row.cost || 0, earliest: row.earliest || null };
          if (row.window === 'total')  res.total    = stats;
          if (row.window === '5h')     res.window5h = stats;
          if (row.window === 'weekly') res.weekly   = stats;
        });
        resolve(res);
      } catch (e) {
        resolve(null);
      }
    });
  });

  const payload = { lastUpdated: Date.now(), quotas: {} };

  for (const r of results) {
    // Prioritize the fresh allSpend metrics passed in. Fall back to cached raw_json if unavailable.
    let rtk = (allSpend && allSpend[r.brand]) || null;
    if (!rtk) {
      const raw = parseRawJson(r.raw_json);
      rtk = (raw && raw._rtk_spend) ? raw._rtk_spend : raw;
    }

    const lim  = SPEND_LIMITS[r.brand] || { limit5h: 2, limitWeekly: 15 };
    let tok5 = rtk && rtk.tokens5h     ? Math.round(rtk.tokens5h)     : 0;
    let tokW = rtk && rtk.tokensWeekly ? Math.round(rtk.tokensWeekly) : 0;
    let c5   = rtk && rtk.cost5h       ? rtk.cost5h       : 0;
    let cW   = rtk && rtk.costWeekly   ? rtk.costWeekly   : 0;
    let r5   = rtk && rtk.requests5h   ? rtk.requests5h   : 0;
    let rW   = rtk && rtk.requestsWeekly ? rtk.requestsWeekly : 0;

    let resetAt       = r.reset_at        || 0;
    let resetAtWeekly = r.reset_at_weekly || 0;

    // Brands tracked purely via RTK (Claude, unit: 'local') have no provider
    // reset time — derive 5h/weekly boundaries from the RTK rolling window
    // (earliest in-window request + window duration), which the web dashboard
    // already shows. Mirrors app.js's RTK-reset fallback.
    if (!resetAt       && rtk && rtk.reset5hAt)     resetAt       = rtk.reset5hAt;
    if (!resetAtWeekly && rtk && rtk.resetWeeklyAt) resetAtWeekly = rtk.resetWeeklyAt;

    if (r.brand === 'gemini') {
      const rtkGemini    = allSpend && allSpend.gemini ? allSpend.gemini : null;
      const agent5hTokens = agentUsage ? (agentUsage.window5h.input + agentUsage.window5h.output) : 0;
      const agentWkTokens = agentUsage ? (agentUsage.weekly.input   + agentUsage.weekly.output)   : 0;
      const agent5hCost   = agentUsage ? agentUsage.window5h.cost   : 0.0;
      const agentWkCost   = agentUsage ? agentUsage.weekly.cost     : 0.0;
      const agent5hCount  = agentUsage ? agentUsage.window5h.count  : 0;
      const agentWkCount  = agentUsage ? agentUsage.weekly.count    : 0;

      tok5 = (rtkGemini ? Math.round(rtkGemini.tokens5h)     : 0) + agent5hTokens;
      tokW = (rtkGemini ? Math.round(rtkGemini.tokensWeekly) : 0) + agentWkTokens;
      c5   = (rtkGemini ? rtkGemini.cost5h    : 0.0) + agent5hCost;
      cW   = (rtkGemini ? rtkGemini.costWeekly : 0.0) + agentWkCost;
      r5   = (rtkGemini ? rtkGemini.requests5h      : 0) + agent5hCount;
      rW   = (rtkGemini ? rtkGemini.requestsWeekly  : 0) + agentWkCount;

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

    // Claude reset_at is null (unit: 'local', RTK-only). The rtk.claude
    // rolling-window boundaries (reset5hAt / resetWeeklyAt) already drive
    // resetAt / resetAtWeekly via the allSpend path below, so no override is
    // needed here.

    payload.quotas[r.brand] = {
      name:             NAMES[r.brand] || r.brand,
      remaining:        r.remaining        !== null ? r.remaining        : -1,
      limit_value:      r.limit_value      !== null ? r.limit_value      : -1,
      weekly_remaining: r.weekly_remaining !== null ? r.weekly_remaining : -1,
      unit:             r.unit             || 'not_exposed',
      // ESP32 uses time(nullptr) which returns SECONDS. Divide ms→s here so
      // getResetString() and formatAbsoluteReset() on the firmware get correct
      // countdowns. Guard 0/null so the firmware's "--:--" path still fires.
      reset_at:         resetAt         ? Math.round(resetAt         / 1000) : 0,
      reset_at_weekly:  resetAtWeekly   ? Math.round(resetAtWeekly   / 1000) : 0,
      error:            r.error            || '',
      seeded_at:        r.seeded_at        || Date.now(),
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

  const firebaseUrl = `${dbUrl.replace(/\/$/, '')}/display.json?auth=${encodeURIComponent(secret)}`;
  const res = await fetch(firebaseUrl, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(8000),
  });
  if (!res.ok) console.error(`[firebase] PUT ${res.status}`);
}

module.exports = { publishToFirebase };
