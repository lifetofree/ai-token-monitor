// lib/rtk-metrics.js
// Server-side RTK database spend aggregation.
'use strict';

const path = require('path');
const { execFile } = require('child_process');

// Shared with the browser via lib/pricing-defaults.js (UMD module). The
// server-side aggregator always uses defaults; the client may override
// inputCost/outputCost/limit5h/limitWeekly through the "Customize Rates"
// modal and persist the override to localStorage.
const PRICING_DEFAULTS = require('./pricing-defaults');
const { detectBrand } = require('./brand-detect');

const homeDir = process.env.HOME || require('os').homedir();
const DB_PATH = process.env.RTK_DB_PATH || path.join(homeDir, 'Library/Application Support/rtk/history.db');

function getRtkSpendMetrics() {
  return new Promise((resolve) => {
    const query = `SELECT timestamp, original_cmd, input_tokens, output_tokens, saved_tokens FROM commands WHERE timestamp >= datetime('now', '-7 days') ORDER BY id ASC`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({});
        return;
      }
      try {
        const rows = JSON.parse(stdout);
        // PRICING_DEFAULTS includes display name, color, and rolling-window
        // caps too; the aggregator only reads inputCost/outputCost.
        const METADATA = PRICING_DEFAULTS;

        const now     = Date.now();
        const limit5h = 5 * 3600 * 1000;
        const limitWk = 7 * 24 * 3600 * 1000;

        const spend = {};
        Object.keys(METADATA).forEach(key => {
          spend[key] = {
            cost5h: 0, costWeekly: 0,
            requests5h: 0, requestsWeekly: 0,
            input5h: 0, inputWeekly: 0,
            output5h: 0, outputWeekly: 0,
            savedTokens5h: 0, savedTokensWeekly: 0,
            tokens5h: 0, tokensWeekly: 0,
            earliest5hTimestamp: null, earliestWeeklyTimestamp: null
          };
        });

        rows.forEach(row => {
          // Skip zero-token rows first — pure shell noise with no billing impact.
          const inputTok  = row.input_tokens  || 0;
          const outputTok = row.output_tokens || 0;
          if (inputTok === 0 && outputTok === 0) return;

          // detectBrand returns null for shell-prefix commands (grep, cat, git …)
          // and non-LLM infrastructure URLs (Firebase, localhost).
          // Only fall back to 'claude' when the command is NOT a known shell
          // command or infra URL — RTK records Claude Code tool-use calls that
          // carry token data but don't match any brand keyword.
          const brandKey = detectBrand(row.original_cmd);
          if (!brandKey) return; // shell command or non-LLM URL — skip
          const meta = METADATA[brandKey];
          if (!meta) return;

          const ts = new Date(row.timestamp).getTime();
          if (isNaN(ts)) return;
          const age = now - ts;
          if (age < 0) return;

          const cost = ((inputTok * meta.inputCost) + (outputTok * meta.outputCost)) / 1000000;
          const s = spend[brandKey];

          if (age <= limit5h) {
            s.cost5h += cost;
            s.requests5h++;
            s.input5h += inputTok;
            s.output5h += outputTok;
            s.savedTokens5h += row.saved_tokens || 0;
            s.tokens5h += inputTok + outputTok;
            if (s.earliest5hTimestamp === null || ts < s.earliest5hTimestamp) {
              s.earliest5hTimestamp = ts;
            }
          }

          if (age <= limitWk) {
            s.costWeekly += cost;
            s.requestsWeekly++;
            s.inputWeekly += inputTok;
            s.outputWeekly += outputTok;
            s.savedTokensWeekly += row.saved_tokens || 0;
            s.tokensWeekly += inputTok + outputTok;
            if (s.earliestWeeklyTimestamp === null || ts < s.earliestWeeklyTimestamp) {
              s.earliestWeeklyTimestamp = ts;
            }
          }
        });

        // Add reset timestamps
        Object.keys(spend).forEach(key => {
          const s = spend[key];
          s.reset5hAt     = s.earliest5hTimestamp     ? s.earliest5hTimestamp     + limit5h : null;
          s.resetWeeklyAt = s.earliestWeeklyTimestamp ? s.earliestWeeklyTimestamp + limitWk  : null;
        });

        resolve(spend);
      } catch (e) {
        console.error('Failed to parse RTK spend metrics:', e);
        resolve({});
      }
    });
  });
}

module.exports = { getRtkSpendMetrics };
