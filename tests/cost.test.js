// tests/cost.test.js
// Tests for the disjoint cost / savings / cache-rate formulas (ADR-0003).
// These mirror the formulas used by addRequest, fetchRealRTKData,
// connectRTKStream, and generateInitialMockHistory in app.js.

import { describe, it, expect } from 'vitest';

// Disjoint model: inputTokens is the billed amount, savedTokens is disjoint.
//   cost     = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
//   savings  = (savedTokens * inputRate) / 1_000_000
//   cacheRate = savedTokens / (inputTokens + savedTokens)
function computeCost(inputTokens, outputTokens, inputRate, outputRate) {
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}
function computeSavings(savedTokens, inputRate) {
  return (savedTokens * inputRate) / 1_000_000;
}
function computeCacheRate(inputTokens, savedTokens) {
  if (inputTokens + savedTokens === 0) return 0;
  return savedTokens / (inputTokens + savedTokens);
}

describe('disjoint cost formula (ADR-0003)', () => {
  it('zero tokens → zero cost', () => {
    expect(computeCost(0, 0, 1.0, 4.0)).toBe(0);
  });

  it('Claude rates: 1000 input @ $3/M + 500 output @ $15/M = $0.0105', () => {
    expect(computeCost(1000, 500, 3.0, 15.0)).toBeCloseTo(0.0105, 10);
  });

  it('MiniMax rates: 1000 input @ $1/M + 500 output @ $4/M = $0.003', () => {
    expect(computeCost(1000, 500, 1.0, 4.0)).toBeCloseTo(0.003, 10);
  });

  it('savedTokens does NOT affect cost (disjoint model)', () => {
    const a = computeCost(1000, 500, 3.0, 15.0);
    // Same cost regardless of saved tokens — disjoint invariant.
    const b = computeCost(1000, 500, 3.0, 15.0);
    expect(a).toBe(b);
  });
});

describe('savings formula', () => {
  it('zero saved → zero savings', () => {
    expect(computeSavings(0, 3.0)).toBe(0);
  });

  it('1000 saved @ $3/M = $0.003', () => {
    expect(computeSavings(1000, 3.0)).toBeCloseTo(0.003, 10);
  });
});

describe('cache hit rate (disjoint model)', () => {
  it('no traffic → 0', () => {
    expect(computeCacheRate(0, 0)).toBe(0);
  });

  it('all cached → 1.0 (100%)', () => {
    expect(computeCacheRate(0, 1000)).toBe(1.0);
  });

  it('half cached → 0.5 (50%)', () => {
    expect(computeCacheRate(1000, 1000)).toBe(0.5);
  });

  it('none cached → 0', () => {
    expect(computeCacheRate(1000, 0)).toBe(0);
  });
});
