// tests/getRtkSpendMetrics.test.js
// Tests for the server-side RTK DB spend aggregation logic in server.js.
// Mirrors the calculation of getRtkSpendMetrics (canonical implementation
// is inline in server.js, not extractable without touching the SQLite harness).

import { describe, it, expect } from 'vitest';

// Mirror of detectSpecificBrand from lib/rtk-metrics.js (falls back to 'claude').
// RTK only records proxied commands, so unmatched = Claude Code tool call.
function detectSpecificBrand(cmd) {
  if (!cmd || typeof cmd !== 'string') return 'claude';
  const c = cmd.toLowerCase();
  if (c.includes('gemini') || c.includes('google-generative') || c.includes('genai')) return 'gemini';
  if (c.includes('minimax')) return 'minimax';
  if (c.includes('glm') || c.includes('zhipu')) return 'glm';
  if (c.includes('claude') || c.includes('anthropic')) return 'claude';
  return 'claude';
}

// Mirror of the core aggregation logic inside getRtkSpendMetrics
function processRtkRows(rows, now) {
  const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const metrics = {
    gemini: { cost5h: 0, costWeekly: 0, requests5h: 0, requestsWeekly: 0, earliest5hTimestamp: null, earliestWeeklyTimestamp: null },
    claude: { cost5h: 0, costWeekly: 0, requests5h: 0, requestsWeekly: 0, earliest5hTimestamp: null, earliestWeeklyTimestamp: null },
    minimax: { cost5h: 0, costWeekly: 0, requests5h: 0, requestsWeekly: 0, earliest5hTimestamp: null, earliestWeeklyTimestamp: null },
    glm: { cost5h: 0, costWeekly: 0, requests5h: 0, requestsWeekly: 0, earliest5hTimestamp: null, earliestWeeklyTimestamp: null }
  };

  const rates = {
    gemini: { inputCost: 1.25, outputCost: 5.00 },
    claude: { inputCost: 3.00, outputCost: 15.00 },
    minimax: { inputCost: 1.00, outputCost: 4.00 },
    glm: { inputCost: 0.50, outputCost: 2.00 }
  };

  rows.forEach(row => {
    const brandKey = detectSpecificBrand(row.original_cmd);
    if (!metrics[brandKey]) return;

    const reqTime = new Date(row.timestamp).getTime();
    const inputTok  = parseInt(row.input_tokens  || 0, 10);
    const outputTok = parseInt(row.output_tokens || 0, 10);
    if (inputTok === 0 && outputTok === 0) return; // shell commands — no billing

    const brandRates = rates[brandKey];
    const cost = ((inputTok * brandRates.inputCost) + (outputTok * brandRates.outputCost)) / 1000000;

    // Weekly accumulation
    metrics[brandKey].requestsWeekly++;
    metrics[brandKey].costWeekly += cost;
    if (metrics[brandKey].earliestWeeklyTimestamp === null || reqTime < metrics[brandKey].earliestWeeklyTimestamp) {
      metrics[brandKey].earliestWeeklyTimestamp = reqTime;
    }

    // 5-Hour accumulation
    if (reqTime >= fiveHoursAgo) {
      metrics[brandKey].requests5h++;
      metrics[brandKey].cost5h += cost;
      if (metrics[brandKey].earliest5hTimestamp === null || reqTime < metrics[brandKey].earliest5hTimestamp) {
        metrics[brandKey].earliest5hTimestamp = reqTime;
      }
    }
  });

  // Round costs to 6 decimal places to match client rounding
  Object.keys(metrics).forEach(key => {
    metrics[key].cost5h = parseFloat(metrics[key].cost5h.toFixed(6));
    metrics[key].costWeekly = parseFloat(metrics[key].costWeekly.toFixed(6));
  });

  return metrics;
}

describe('getRtkSpendMetrics aggregation logic', () => {
  const NOW = Date.parse('2026-06-09T10:00:00.000Z'); // Tuesday 10:00 UTC

  it('aggregates no rows into zero metrics', () => {
    const res = processRtkRows([], NOW);
    expect(res.gemini).toEqual({ cost5h: 0, costWeekly: 0, requests5h: 0, requestsWeekly: 0, earliest5hTimestamp: null, earliestWeeklyTimestamp: null });
  });

  it('classifies brands and computes cost based on rates', () => {
    const rows = [
      {
        timestamp: '2026-06-09T09:30:00.000Z', // 30m ago (in 5h)
        original_cmd: 'curl --model gemini-1.5-flash ...',
        input_tokens: 100000, // 0.1M
        output_tokens: 20000   // 0.02M
      },
      {
        timestamp: '2026-06-09T08:00:00.000Z', // 2h ago (in 5h)
        original_cmd: 'curl --model claude-3-opus ...',
        input_tokens: 50000,
        output_tokens: 10000
      }
    ];

    const res = processRtkRows(rows, NOW);

    // Gemini cost: (100k * 1.25 + 20k * 5.00) / 1M = (125k + 100k) / 1M = 0.225
    expect(res.gemini.cost5h).toBe(0.225);
    expect(res.gemini.requests5h).toBe(1);

    // Claude cost: (50k * 3.00 + 10k * 15.00) / 1M = (150k + 150k) / 1M = 0.3
    expect(res.claude.cost5h).toBe(0.3);
    expect(res.claude.requests5h).toBe(1);
  });

  it('correctly partitions requests into 5-hour and weekly windows', () => {
    const rows = [
      {
        timestamp: '2026-06-09T09:00:00.000Z', // 1h ago (in both)
        original_cmd: 'gemini call',
        input_tokens: 100000,
        output_tokens: 0
      },
      {
        timestamp: '2026-06-09T04:00:00.000Z', // 6h ago (weekly only)
        original_cmd: 'gemini call',
        input_tokens: 100000,
        output_tokens: 0
      }
    ];

    const res = processRtkRows(rows, NOW);

    // Gemini: 1 in 5h, 2 in weekly
    expect(res.gemini.requests5h).toBe(1);
    expect(res.gemini.requestsWeekly).toBe(2);

    expect(res.gemini.cost5h).toBe(0.125);
    expect(res.gemini.costWeekly).toBe(0.25);
  });

  it('tracks earliest timestamp for both windows', () => {
    const t1 = '2026-06-09T09:00:00.000Z'; // 1h ago
    const t2 = '2026-06-09T08:00:00.000Z'; // 2h ago
    const t3 = '2026-06-09T03:00:00.000Z'; // 7h ago

    const rows = [
      { timestamp: t1, original_cmd: 'gemini', input_tokens: 100, output_tokens: 0 },
      { timestamp: t2, original_cmd: 'gemini', input_tokens: 100, output_tokens: 0 },
      { timestamp: t3, original_cmd: 'gemini', input_tokens: 100, output_tokens: 0 }
    ];

    const res = processRtkRows(rows, NOW);

    expect(res.gemini.earliest5hTimestamp).toBe(Date.parse(t2));
    expect(res.gemini.earliestWeeklyTimestamp).toBe(Date.parse(t3));
  });

  it('classifies unmatched commands as claude but excludes 0-token rows', () => {
    // detectSpecificBrand falls back to 'claude' — RTK only records proxied
    // commands, so unmatched = Claude Code tool call. But 0-token rows
    // (pure shell noise) are excluded from billing.
    const rows = [
      { timestamp: '2026-06-09T09:00:00.000Z', original_cmd: 'ls -la',            input_tokens: 500, output_tokens: 200 },
      { timestamp: '2026-06-09T09:00:00.000Z', original_cmd: 'git commit -m "x"', input_tokens: 300, output_tokens: 100 },
      { timestamp: '2026-06-09T09:00:00.000Z', original_cmd: 'grep -rn pattern',  input_tokens: 0,   output_tokens: 0   },
      { timestamp: '2026-06-09T09:00:00.000Z', original_cmd: 'curl https://api.anthropic.com/v1/messages', input_tokens: 500, output_tokens: 200 }
    ];

    const res = processRtkRows(rows, NOW);

    // ls and git have tokens and are classified as Claude (tool calls).
    // grep has 0 tokens and is excluded. The explicit anthropic call counts.
    expect(res.claude.requestsWeekly).toBe(3);
    expect(res.claude.requests5h).toBe(3);
    expect(res.claude.costWeekly).toBeGreaterThan(0);
    expect(res.claude.cost5h).toBeGreaterThan(0);
  });
});
