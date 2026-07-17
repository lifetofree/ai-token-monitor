// lib/brand-fetchers.js
// HTTPS quota fetchers for each LLM brand.
// httpsRequest is the shared transport; each fetcher owns its own result shape.
'use strict';

const https = require('https');
const { getClaudeRealRateLimits } = require('./claude-statusbar-cache');

// Shared HTTPS helper — resolves {statusCode, headers, body} or rejects on
// network error. Each fetcher builds its own result shape from these primitives.
function httpsRequest(options, postData = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTPS timeout after ${timeoutMs}ms`));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

function fetchClaudeQuota(apiKey, rtkSpend) {
  const rtkClaude = rtkSpend && rtkSpend.claude ? rtkSpend.claude : null;

  // Prefer Claude Code's own real rate-limit percentage — the same number
  // the terminal status bar shows, sourced from Anthropic's actual
  // server-reported utilization (see lib/claude-statusbar-cache.js), not an
  // estimate. unit: 'percent' + a numeric remaining/weekly_remaining routes
  // through the exact same bar-fill logic already used for MiniMax/GLM
  // (QuotaUtils.computeApiUsedPct) — no separate rendering path needed.
  const realRateLimits = getClaudeRealRateLimits();
  if (realRateLimits) {
    return {
      remaining:        100 - realRateLimits.used5h,
      limit_value:      100,
      reset_at:         realRateLimits.resets5h ? realRateLimits.resets5h * 1000 : null,
      reset_at_weekly:  realRateLimits.resetsWeekly ? realRateLimits.resetsWeekly * 1000 : null,
      weekly_remaining: realRateLimits.usedWeekly !== null ? 100 - realRateLimits.usedWeekly : null,
      unit:             'percent',
      raw_json:         rtkClaude ? { _rtk_spend: rtkClaude } : null,
      error:            null
    };
  }

  // Fallback: no fresh status-bar reading available (tool not installed, or
  // no Claude Code session has rendered in the last 15 minutes). Track from
  // the local RTK database instead. The Anthropic API itself doesn't expose
  // a usable quota window this way: the rate-limit headers are a per-minute
  // token bucket (not 5h/weekly) and are absent when the account has
  // insufficient credit (the probe 400s before any header is set).
  //
  // unit: 'local' tells the UI the bar/amounts/reset come from RTK, not the
  // provider API. computeApiUsedPct returns null for 'local', so the card's
  // 5h/weekly bars fall back to the RTK cost-based percentage.
  return {
    remaining:        null,
    limit_value:      null,
    reset_at:         null,
    reset_at_weekly:  null,
    weekly_remaining: null,
    unit:             'local',
    raw_json:         rtkClaude,
    error:            null
  };
}

async function fetchGeminiQuota(apiKey) {
  const postData = JSON.stringify({ contents: [{ parts: [{ text: '.' }] }] });

  try {
    const { statusCode, body } = await httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      // gemini-2.5-flash is the current stable Flash model on v1beta as of
      // July 2026; gemini-1.5-flash and gemini-2.0-flash have been retired.
      // Quota is still not exposed via the generateContent endpoint, so this
      // probe only verifies that the key is valid and returns the response
      // body in raw_json.
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(postData) }
    }, postData);

    try {
      const parsed = JSON.parse(body);
      let errorMsg = null;
      if (statusCode >= 400 || parsed.error) {
        errorMsg = (parsed.error && parsed.error.message) ? parsed.error.message : `HTTP ${statusCode}`;
      }
      // The Gemini fetcher is best-effort — quota is not exposed; raw_json holds the body with usageMetadata
      return { remaining: null, limit_value: null, reset_at: null, unit: 'not_exposed', raw_json: parsed, error: errorMsg };
    } catch (e) {
      return { remaining: null, limit_value: null, reset_at: null, unit: 'not_exposed', raw_json: { usageMetadata: null, raw: body }, error: e.message };
    }
  } catch (e) {
    return { remaining: null, limit_value: null, reset_at: null, unit: 'not_exposed', raw_json: null, error: e.message };
  }
}

async function fetchGLMQuota(apiKey, rtkSpend) {
  // Uses the Zhipu AI quota monitoring API to get 5-hour token limits
  // with remaining %, used/total tokens, and reset time.
  // RTK spend metrics are passed in from the caller (fetched once per cycle)
  // so the dashboard can show cost and token counts alongside API quota data.
  const rtkGlm = rtkSpend && rtkSpend.glm ? rtkSpend.glm : null;
  const nullResult = (unit, error, extra = {}) =>
    ({ remaining: null, limit_value: null, reset_at: null, reset_at_weekly: null, weekly_remaining: null, unit, raw_json: null, error, ...extra, rtk_spend: rtkGlm });

  try {
    const { body } = await httpsRequest({
      hostname: 'bigmodel.cn',
      path: '/api/monitor/usage/quota/limit',
      method: 'GET',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' }
    });

    let parsed;
    try { parsed = JSON.parse(body); }
    catch (e) { return nullResult('error', e.message, { raw_json: body.substring(0, 500) }); }

    if (!parsed.success || parsed.code !== 200) {
      return { ...nullResult('error', parsed.msg || `API code ${parsed.code}`), raw_json: parsed };
    }

    const limits = parsed.data && parsed.data.limits ? parsed.data.limits : [];
    const tokensLimits = limits.filter(l => l.type === 'TOKENS_LIMIT');

    if (tokensLimits.length === 0) {
      return { ...nullResult('not_exposed', 'No TOKENS_LIMIT in response'), raw_json: parsed };
    }

    // The API percentage field IS the used percentage (0-100).
    // First TOKENS_LIMIT is the 5-hour window.
    const fiveHour   = tokensLimits[0];
    const remainPct  = Math.max(0, 100 - fiveHour.percentage);
    const resetAt    = fiveHour.nextResetTime || null;

    // Second TOKENS_LIMIT (if present) is the longer window (~weekly).
    let resetAtWeekly = null, weeklyRemaining = null;
    if (tokensLimits.length > 1) {
      const weekly   = tokensLimits[1];
      weeklyRemaining = Math.max(0, 100 - weekly.percentage);
      resetAtWeekly  = weekly.nextResetTime || null;
    }

    return {
      remaining: remainPct, limit_value: 100,
      reset_at: resetAt, reset_at_weekly: resetAtWeekly, weekly_remaining: weeklyRemaining,
      unit: 'percent', raw_json: parsed, error: null, rtk_spend: rtkGlm
    };
  } catch (e) {
    return nullResult('error', e.message);
  }
}

function fetchMinimaxQuota(apiKey, rtkSpend) {
  // MiniMax Token Plan remains endpoint (international). Returns 5-hour and
  // weekly rolling-window quota for the user's coding plan subscription key.
  // API key may be a standard MiniMax Open Platform key or a subscription key.
  const rtkMinimax = rtkSpend && rtkSpend.minimax ? rtkSpend.minimax : null;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.minimax.io',
      path: '/v1/token_plan/remains',
      method: 'GET',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'accept': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = body.trim() ? JSON.parse(body) : null; } catch (e) {}

        if (res.statusCode >= 400) {
          const errMsg = (parsed && parsed.base_resp && parsed.base_resp.status_msg)
            ? parsed.base_resp.status_msg
            : (parsed && parsed.message) ? parsed.message : `HTTP ${res.statusCode}`;
          resolve({
            remaining: null, limit_value: null, reset_at: null,
            reset_at_weekly: null, weekly_remaining: null,
            unit: 'error', raw_json: parsed || body, error: errMsg,
            rtk_spend: rtkMinimax
          });
          return;
        }

        if (!parsed) {
          resolve({
            remaining: null, limit_value: null, reset_at: null,
            reset_at_weekly: null, weekly_remaining: null,
            unit: 'error', raw_json: body, error: 'empty response',
            rtk_spend: rtkMinimax
          });
          return;
        }

        // The API may wrap the array in different containers. Try common paths.
        const candidates = []
          .concat(Array.isArray(parsed) ? [{ model_remains: parsed }] : [])
          .concat(parsed.model_remains || [])
          .concat(parsed.data && parsed.data.model_remains || [])
          .concat(parsed.remains || [])
          .concat(parsed.data && parsed.data.remains || []);
        // Normalize into [entry, ...] of windowed records.
        const entries = [];
        for (const c of candidates) {
          if (Array.isArray(c)) entries.push(...c);
          else if (c && typeof c === 'object') entries.push(c);
        }

        // Pick the chat-model entry first (M3 / M2.x), fall back to first entry.
        const chatPick = entries.find(e => /M3|M2\.7|M2\.5|M2\b/i.test(String(e.model_name || e.model || '')));
        const primary = chatPick || entries[0];

        const fiveH_MS  = 5 * 60 * 60 * 1000;
        const sevenD_MS = 7 * 24 * 60 * 60 * 1000;

        // Identify a separate weekly window if the response exposes one.
        let weeklyEntry = null;
        if (entries.length > 1) {
          weeklyEntry = entries.find(e => e !== primary && isWeeklyEntry(e, sevenD_MS)) || null;
        }
        if (!weeklyEntry && primary && primary.end_time && primary.start_time) {
          const startMs = toEpochMs(primary.start_time);
          const endMs   = toEpochMs(primary.end_time);
          if (startMs && endMs && (endMs - startMs) > fiveH_MS * 2) {
            // Primary window itself is longer than 5h — treat as weekly.
            weeklyEntry = primary;
          }
        }

        const resetAtWeekly = weeklyEntry
          ? extractEndTime(weeklyEntry)
          : (primary ? extractWeeklyEndTime(primary) : null);

        // Detect unit: MiniMax returns percent fields (0-100) rather than
        // a hard count cap, so we synthesize limit_value=100 in that mode
        // and tag the unit so the UI can render "% left" instead of "N / M".
        const isPercent  = primary && (
          typeof primary.current_interval_remaining_percent === 'number' ||
          typeof primary.usage_percent === 'number' ||
          typeof primary.usagePercent === 'number'
        );
        const hasCount   = primary && extractLimit(primary) > 0;
        const unit       = !primary ? 'not_exposed' : (isPercent && !hasCount ? 'percent' : (hasCount ? 'requests' : 'not_exposed'));
        const limitValue = primary ? (extractLimit(primary) || (isPercent ? 100 : null)) : null;

        resolve({
          remaining:        primary ? extractRemaining(primary) : null,
          limit_value:      limitValue,
          reset_at:         (primary && weeklyEntry !== primary) ? extractEndTime(primary) : null,
          reset_at_weekly:  resetAtWeekly,
          weekly_remaining: primary ? extractWeeklyRemaining(primary) : null,
          unit,
          raw_json: parsed,
          error: null,
          rtk_spend: rtkMinimax
        });
      });
    });

    req.on('error', (e) => {
      resolve({
        remaining: null, limit_value: null, reset_at: null,
        reset_at_weekly: null, weekly_remaining: null,
        unit: 'error', raw_json: null, error: e.message,
        rtk_spend: rtkMinimax
      });
    });

    req.end();
  });
}

// --- MiniMax parsing helpers ---

function toEpochMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // seconds vs ms heuristic
  const parsed = Date.parse(v);
  return isNaN(parsed) ? null : parsed;
}

function isWeeklyEntry(entry, sevenD_MS) {
  const startMs = toEpochMs(entry.start_time);
  const endMs   = toEpochMs(entry.end_time);
  if (!startMs || !endMs) return false;
  const delta = endMs - startMs;
  return delta >= sevenD_MS / 2 && delta <= sevenD_MS * 2;
}

function pickField(obj, ...keys) {
  for (const k of keys) {
    if (obj != null && obj[k] != null) return obj[k];
  }
  return null;
}

function extractRemaining(entry) {
  const value = pickField(entry,
    'current_interval_remaining_percent',
    'current_interval_remaining_count',
    'current_window_remaining_count'
  );
  if (value !== null) return value;

  if (entry != null) {
    const unobserved = [
      'current_remaining_percent',
      'current_remaining_count',
      'remaining_count',
      'usage_percent',
      'usagePercent'
    ];
    const found = unobserved.find(k => entry[k] != null);
    if (found) {
      console.warn(`Unobserved MiniMax quota field detected: "${found}" with value ${entry[found]}`);
      return entry[found];
    }
  }
  return null;
}

function extractWeeklyRemaining(entry) {
  return pickField(entry,
    'current_weekly_remaining_percent',
    'current_week_remaining_percent',
    'weekly_remaining_percent',
    'weekly_remaining_count'
  );
}

function extractLimit(entry) {
  return pickField(entry,
    'current_interval_total_count',
    'current_window_quota_count',
    'window_quota_count',
    'quota_count',
    'total_count',
    'limit',
    'quota'
  );
}

function extractEndTime(entry) {
  return toEpochMs(pickField(entry, 'end_time', 'current_end_time', 'reset_at', 'interval_end_time'));
}

function extractWeeklyEndTime(entry) {
  return toEpochMs(pickField(entry, 'weekly_end_time', 'current_week_end_time', 'week_end_time'));
}

const BRAND_FETCHERS = {
  claude:  { envKey: 'ANTHROPIC_API_KEY', fetch: fetchClaudeQuota },
  gemini:  { envKey: 'GEMINI_API_KEY',    fetch: fetchGeminiQuota },
  glm:     { envKey: 'GLM_API_KEY',       fetch: fetchGLMQuota    },
  minimax: { envKey: 'MINIMAX_API_KEY',   fetch: fetchMinimaxQuota }
};

module.exports = { BRAND_FETCHERS, httpsRequest, fetchClaudeQuota, fetchGeminiQuota, fetchGLMQuota, fetchMinimaxQuota };
