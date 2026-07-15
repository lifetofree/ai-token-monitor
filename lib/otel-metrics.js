// lib/otel-metrics.js
// Aggregates claude_otel_usage (Claude Code's own OTel telemetry — see
// lib/otel-usage.js) into the exact shape lib/rtk-metrics.js produces per
// brand, so it's a drop-in replacement for rtkSpend.claude: real cost_usd
// and real token counts from Claude Code's own billing accounting, instead
// of RTK's reconstruction from parsed command output.
'use strict';

const path = require('path');
const { execFile } = require('child_process');

const homeDir = process.env.HOME || require('os').homedir();
const DB_PATH = process.env.RTK_DB_PATH || path.join(homeDir, 'Library/Application Support/rtk/history.db');

// Resolves null when there's no OTel data yet (table missing/empty), so
// callers can fall back to the RTK-derived value rather than showing zeros.
function getClaudeOtelSpendMetrics() {
  return new Promise((resolve) => {
    const query = `SELECT ts, input_tokens, output_tokens, cost_usd FROM claude_otel_usage WHERE ts >= strftime('%s', 'now', '-7 days') ORDER BY ts ASC`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        const rows = JSON.parse(stdout);
        if (rows.length === 0) {
          resolve(null);
          return;
        }

        const now     = Date.now();
        const limit5h = 5 * 3600 * 1000;
        const limitWk = 7 * 24 * 3600 * 1000;

        const s = {
          cost5h: 0, costWeekly: 0,
          requests5h: 0, requestsWeekly: 0,
          input5h: 0, inputWeekly: 0,
          output5h: 0, outputWeekly: 0,
          tokens5h: 0, tokensWeekly: 0,
          earliest5hTimestamp: null, earliestWeeklyTimestamp: null,
        };

        rows.forEach(row => {
          const ts = (row.ts || 0) * 1000; // stored as unix seconds
          const age = now - ts;
          if (age < 0) return;

          const inputTok = row.input_tokens || 0;
          const outputTok = row.output_tokens || 0;
          const cost = row.cost_usd || 0;

          if (age <= limit5h) {
            s.cost5h += cost;
            s.requests5h++;
            s.input5h += inputTok;
            s.output5h += outputTok;
            s.tokens5h += inputTok + outputTok;
            if (s.earliest5hTimestamp === null || ts < s.earliest5hTimestamp) s.earliest5hTimestamp = ts;
          }
          if (age <= limitWk) {
            s.costWeekly += cost;
            s.requestsWeekly++;
            s.inputWeekly += inputTok;
            s.outputWeekly += outputTok;
            s.tokensWeekly += inputTok + outputTok;
            if (s.earliestWeeklyTimestamp === null || ts < s.earliestWeeklyTimestamp) s.earliestWeeklyTimestamp = ts;
          }
        });

        s.reset5hAt     = s.earliest5hTimestamp     ? s.earliest5hTimestamp     + limit5h : null;
        s.resetWeeklyAt = s.earliestWeeklyTimestamp ? s.earliestWeeklyTimestamp + limitWk  : null;

        resolve(s);
      } catch (e) {
        console.error('Failed to parse Claude OTel spend metrics:', e);
        resolve(null);
      }
    });
  });
}

module.exports = { getClaudeOtelSpendMetrics };
