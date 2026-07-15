// lib/antigravity-context.js
//
// Resolves the "active session memory" block on the Antigravity brand card.
// Source of truth: the agent_usage table populated by server.syncAgentUsage().
// The "active" conversation is the most recently updated one within the last
// ACTIVE_SESSION_MS (default 30 minutes). The used numerator is
// `inputTokens + cachedTokens` (per-token-window semantics) and the size
// denominator defaults to 1,000,000 — the Gemini 1.5 Pro / 2.0 Flash /
// 2.5 Pro context window. Override via GEMINI_CONTEXT_WINDOW env var.

'use strict';

const cp = require('child_process');

const ACTIVE_SESSION_MS = 30 * 60 * 1000;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * @param {string} dbPath   - absolute path to monitor.db
 * @param {object} [opts]
 * @param {number} [opts.activeMs]   - override ACTIVE_SESSION_MS
 * @param {number} [opts.size]       - override default context window
 * @param {number} [opts.now]        - override current time (for tests)
 * @param {Function} [opts.execFile] - inject execFile (test seam)
 * @returns {Promise<null | { used: number, remaining: number, usedPct: number, size: number, source: 'active' }>}
 */
function computeContextWindow(dbPath, opts) {
  const activeMs = (opts && opts.activeMs) || ACTIVE_SESSION_MS;
  const size = (opts && opts.size)
    || (parseInt(process.env.GEMINI_CONTEXT_WINDOW, 10) > 0
        ? parseInt(process.env.GEMINI_CONTEXT_WINDOW, 10)
        : DEFAULT_CONTEXT_WINDOW);
  const now = (opts && opts.now) || Date.now();
  const cutoffMs = now - activeMs;
  const exec = (opts && opts.execFile) || cp.execFile;

  const query = `
    SELECT input_tokens, output_tokens, cached_tokens, total_cost, last_updated
      FROM agent_usage
     WHERE last_updated >= ${Math.floor(cutoffMs)}
     ORDER BY last_updated DESC
     LIMIT 1;
  `;

  return new Promise((resolve) => {
    exec('sqlite3', ['-cmd', '.timeout 5000', '-json', dbPath, query], (error, stdout) => {
      if (error || !stdout || !stdout.trim()) return resolve(null);
      let row;
      try { row = JSON.parse(stdout)[0]; } catch (e) { return resolve(null); }
      if (!row) return resolve(null);

      const used = (Number(row.input_tokens) || 0) + (Number(row.cached_tokens) || 0);
      const usedPct = Math.min(100, Math.max(0, Math.round((used / size) * 100)));
      resolve({
        used,
        remaining: Math.max(0, 100 - usedPct),
        usedPct,
        size,
        source: 'active',
        lastUpdated: row.last_updated
      });
    });
  });
}

module.exports = { computeContextWindow, ACTIVE_SESSION_MS, DEFAULT_CONTEXT_WINDOW };
