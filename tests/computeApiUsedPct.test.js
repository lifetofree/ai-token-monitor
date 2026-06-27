// tests/computeApiUsedPct.test.js
// Tests for computeApiUsedPct, calcSpendPct, and calcForecast from lib/quota-utils.js.
// Previously a mirror-function test; now imports the canonical implementation.

import { describe, it, expect } from 'vitest';
import { computeApiUsedPct, calcSpendPct, calcForecast } from '../lib/quota-utils.js';

// ─── computeApiUsedPct ────────────────────────────────────────────────────────

describe('computeApiUsedPct — 5h scope', () => {
  it('returns used % for percent-unit brand (100 - remaining)', () => {
    expect(computeApiUsedPct({ unit: 'percent', remaining: 78 }, '5h')).toBe(22);
    expect(computeApiUsedPct({ unit: 'percent', remaining: 0  }, '5h')).toBe(100);
    expect(computeApiUsedPct({ unit: 'percent', remaining: 100}, '5h')).toBe(0);
  });

  it('returns used % for requests-unit brand ((limit - remaining) / limit)', () => {
    expect(computeApiUsedPct({ unit: 'requests', remaining: 30, limit_value: 100 }, '5h')).toBe(70);
    expect(computeApiUsedPct({ unit: 'requests', remaining: 0,  limit_value: 200 }, '5h')).toBe(100);
  });

  it('returns null for local unit (Claude — tracked via RTK, no provider window)', () => {
    expect(computeApiUsedPct({ unit: 'local' }, '5h')).toBeNull();
    expect(computeApiUsedPct({ unit: 'local', remaining: 40000, limit_value: 50000 }, '5h')).toBeNull();
  });

  it('returns null for not_exposed unit', () => {
    expect(computeApiUsedPct({ unit: 'not_exposed' }, '5h')).toBeNull();
  });

  it('returns null when apiQuota is null/undefined', () => {
    expect(computeApiUsedPct(null, '5h')).toBeNull();
    expect(computeApiUsedPct(undefined, '5h')).toBeNull();
  });

  it('returns null for requests-unit when limit_value is 0 or missing', () => {
    expect(computeApiUsedPct({ unit: 'requests', remaining: 30, limit_value: 0 }, '5h')).toBeNull();
    expect(computeApiUsedPct({ unit: 'requests', remaining: 30 }, '5h')).toBeNull();
  });

  it('clamps to [0, 100] for out-of-range values', () => {
    // remaining > 100 (impossible but defensive): used% < 0 → clamped to 0
    expect(computeApiUsedPct({ unit: 'percent', remaining: 120 }, '5h')).toBe(0);
    // remaining < 0 (impossible): used% > 100 → clamped to 100
    expect(computeApiUsedPct({ unit: 'percent', remaining: -10 }, '5h')).toBe(100);
  });
});

describe('computeApiUsedPct — weekly scope', () => {
  it('returns used % for weekly_remaining (100 - weekly_remaining)', () => {
    expect(computeApiUsedPct({ weekly_remaining: 60 }, 'weekly')).toBe(40);
    expect(computeApiUsedPct({ weekly_remaining: 0  }, 'weekly')).toBe(100);
  });

  it('returns null when weekly_remaining is missing', () => {
    expect(computeApiUsedPct({ unit: 'percent', remaining: 50 }, 'weekly')).toBeNull();
    expect(computeApiUsedPct({}, 'weekly')).toBeNull();
  });

  it('clamps weekly to [0, 100]', () => {
    expect(computeApiUsedPct({ weekly_remaining: 110 }, 'weekly')).toBe(0);
    expect(computeApiUsedPct({ weekly_remaining: -5  }, 'weekly')).toBe(100);
  });
});

// ─── calcSpendPct ─────────────────────────────────────────────────────────────

describe('calcSpendPct', () => {
  it('returns cost / limit * 100', () => {
    expect(calcSpendPct(1.00, 5.00)).toBeCloseTo(20);
    expect(calcSpendPct(5.00, 5.00)).toBeCloseTo(100);
    expect(calcSpendPct(0,    5.00)).toBe(0);
  });

  it('clamps to 100 when over budget', () => {
    expect(calcSpendPct(6.00, 5.00)).toBe(100);
  });

  it('returns 0 for zero or missing limit', () => {
    expect(calcSpendPct(1.00, 0)).toBe(0);
    expect(calcSpendPct(1.00, null)).toBe(0);
    expect(calcSpendPct(1.00, undefined)).toBe(0);
  });
});

// ─── calcForecast ─────────────────────────────────────────────────────────────

describe('calcForecast', () => {
  const NOW = 1_750_000_000_000; // fixed epoch for determinism

  it('returns null when no requests yet', () => {
    expect(calcForecast(0.5, 5, null, null, NOW)).toBeNull();
  });

  it('returns null when costSpent is zero (no burn rate)', () => {
    expect(calcForecast(0, 5, NOW - 3_600_000, null, NOW)).toBeNull();
  });

  it('returns null when budget is already exhausted', () => {
    expect(calcForecast(5.5, 5, NOW - 3_600_000, null, NOW)).toBeNull();
  });

  it('returns absolute forecast ms when budget depletes before reset', () => {
    // Spent $1 in 1 hour → burn rate $1/h. $4 remaining → 4h to exhaustion.
    // Reset is in 6h → 4h < 6h → show forecast.
    const elapsed = 3_600_000;         // 1 hour
    const resetMs = 6 * 3_600_000;    // 6 hours remaining
    const result = calcForecast(1, 5, NOW - elapsed, resetMs, NOW);
    expect(result).not.toBeNull();
    // 4h from now
    expect(result).toBeCloseTo(NOW + 4 * 3_600_000, -3);
  });

  it('returns null when budget outlasts the reset window', () => {
    // Spent $0.10 in 1 hour → budget runs out in 49h. Reset is in 2h → null.
    const elapsed = 3_600_000;
    const resetMs = 2 * 3_600_000;
    expect(calcForecast(0.1, 5, NOW - elapsed, resetMs, NOW)).toBeNull();
  });

  it('returns forecast even with no reset time (null resetRemainingMs)', () => {
    const elapsed = 3_600_000;
    const result = calcForecast(2.5, 5, NOW - elapsed, null, NOW);
    expect(result).not.toBeNull(); // $2.5 remaining at $2.5/h → 1h
    expect(result).toBeCloseTo(NOW + 3_600_000, -3);
  });
});
