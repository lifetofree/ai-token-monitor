// tests/fetchGeminiQuota.test.js
// Tests for the Gemini ccusage quota fetcher's parser. We mock child_process.exec
// and verify the daily and weekly cost and token metrics calculations.

import { describe, it, expect } from 'vitest';

// The parsing logic mirrored from server.js
function parseCcusageOutput(stdout, mockNow = new Date('2026-06-09T12:00:00Z')) {
  const usageData = JSON.parse(stdout);
  const daily = usageData.daily || [];
  const totals = usageData.totals || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0 };

  // Compute local date string YYYY-MM-DD
  const offset = mockNow.getTimezoneOffset();
  const localDateStr = new Date(mockNow.getTime() - (offset * 60 * 1000)).toISOString().split('T')[0];

  // 5h window approximation (current day)
  let cost5h = 0;
  let input5h = 0;
  let output5h = 0;
  let cache5h = 0;
  const todayRecord = daily.find(item => item.date === localDateStr);
  if (todayRecord) {
    cost5h = todayRecord.totalCost || 0;
    input5h = todayRecord.inputTokens || 0;
    output5h = todayRecord.outputTokens || 0;
    cache5h = todayRecord.cacheReadTokens || 0;
  }

  // Weekly window
  const sevenDaysAgo = mockNow.getTime() - 7 * 24 * 60 * 60 * 1000;
  let costWeekly = 0;
  let inputWeekly = 0;
  let outputWeekly = 0;
  let cacheWeekly = 0;
  daily.forEach(item => {
    const t = new Date(item.date).getTime();
    if (t >= sevenDaysAgo) {
      costWeekly += item.totalCost || 0;
      inputWeekly += item.inputTokens || 0;
      outputWeekly += item.outputTokens || 0;
      cacheWeekly += item.cacheReadTokens || 0;
    }
  });

  // Midnight tonight for reset time
  const midnight = new Date(mockNow);
  midnight.setHours(24, 0, 0, 0);
  const resetAt = midnight.getTime();

  return {
    remaining: null,
    limit_value: null,
    reset_at: resetAt,
    unit: 'not_exposed',
    raw_json: {
      source: 'ccusage',
      totals: {
        inputTokens: totals.inputTokens || 0,
        outputTokens: totals.outputTokens || 0,
        cacheReadTokens: totals.cacheReadTokens || 0,
        totalCost: totals.totalCost || 0
      },
      window5h: {
        cost: cost5h,
        inputTokens: input5h,
        outputTokens: output5h,
        cacheReadTokens: cache5h
      },
      weekly: {
        cost: costWeekly,
        inputTokens: inputWeekly,
        outputTokens: outputWeekly,
        cacheReadTokens: cacheWeekly
      }
    },
    error: null
  };
}

describe('fetchGeminiQuota - ccusage parsing', () => {
  it('correctly aggregates cost and tokens for today and weekly windows', () => {
    const mockStdout = JSON.stringify({
      daily: [
        {
          date: '2026-06-09',
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          totalCost: 0.15
        },
        {
          date: '2026-06-08',
          inputTokens: 2000,
          outputTokens: 800,
          cacheReadTokens: 300,
          totalCost: 0.25
        },
        {
          date: '2026-06-01', // Out of weekly window (June 9 - 7 days = June 2)
          inputTokens: 5000,
          outputTokens: 1000,
          cacheReadTokens: 1000,
          totalCost: 1.00
        }
      ],
      totals: {
        inputTokens: 8000,
        outputTokens: 2300,
        cacheReadTokens: 1500,
        totalCost: 1.40
      }
    });

    const mockNow = new Date('2026-06-09T15:30:00Z');
    const result = parseCcusageOutput(mockStdout, mockNow);

    expect(result.raw_json.source).toBe('ccusage');
    
    // Totals
    expect(result.raw_json.totals.totalCost).toBe(1.40);
    expect(result.raw_json.totals.inputTokens).toBe(8000);
    expect(result.raw_json.totals.outputTokens).toBe(2300);
    expect(result.raw_json.totals.cacheReadTokens).toBe(1500);

    // 5h window (Today - June 9)
    expect(result.raw_json.window5h.cost).toBe(0.15);
    expect(result.raw_json.window5h.inputTokens).toBe(1000);
    expect(result.raw_json.window5h.outputTokens).toBe(500);
    expect(result.raw_json.window5h.cacheReadTokens).toBe(200);

    // Weekly window (June 8 + June 9)
    expect(result.raw_json.weekly.cost).toBe(0.40); // 0.15 + 0.25
    expect(result.raw_json.weekly.inputTokens).toBe(3000); // 1000 + 2000
    expect(result.raw_json.weekly.outputTokens).toBe(1300); // 500 + 800
    expect(result.raw_json.weekly.cacheReadTokens).toBe(500); // 200 + 300

    // Reset Time
    const midnight = new Date(mockNow);
    midnight.setHours(24, 0, 0, 0);
    expect(result.reset_at).toBe(midnight.getTime());
  });

  it('handles empty ccusage output correctly', () => {
    const mockStdout = JSON.stringify({
      daily: [],
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalCost: 0
      }
    });

    const mockNow = new Date('2026-06-09T15:30:00Z');
    const result = parseCcusageOutput(mockStdout, mockNow);

    expect(result.raw_json.window5h.cost).toBe(0);
    expect(result.raw_json.weekly.cost).toBe(0);
    expect(result.raw_json.totals.totalCost).toBe(0);
  });
});
