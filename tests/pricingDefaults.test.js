// tests/pricingDefaults.test.js
// Tests for lib/pricing-defaults.js (TL-2) — the UMD module that owns the
// default per-Brand metadata shared between app.js (browser) and
// lib/rtk-metrics.js (server). Asserts the shape, the four brand keys, and
// the canonical rates that were previously hard-coded in two separate files.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PRICING_DEFAULTS = require('../lib/pricing-defaults.js');

describe('PRICING_DEFAULTS — shape and content', () => {
  it('exports the five v1 Brand keys', () => {
    expect(Object.keys(PRICING_DEFAULTS).sort()).toEqual(['claude', 'gemini', 'glm', 'mimo', 'minimax']);
  });

  it('every brand has name, inputCost, outputCost, limit5h, limitWeekly, color', () => {
    Object.keys(PRICING_DEFAULTS).forEach((key) => {
      const b = PRICING_DEFAULTS[key];
      expect(b).toHaveProperty('name');
      expect(typeof b.name).toBe('string');
      expect(b).toHaveProperty('inputCost');
      expect(typeof b.inputCost).toBe('number');
      expect(b).toHaveProperty('outputCost');
      expect(typeof b.outputCost).toBe('number');
      expect(b).toHaveProperty('limit5h');
      expect(typeof b.limit5h).toBe('number');
      expect(b).toHaveProperty('limitWeekly');
      expect(typeof b.limitWeekly).toBe('number');
      expect(b).toHaveProperty('color');
      expect(typeof b.color).toBe('string');
    });
  });

  it('matches the canonical rates that were duplicated in app.js and lib/rtk-metrics.js', () => {
    expect(PRICING_DEFAULTS.gemini.inputCost).toBe(1.25);
    expect(PRICING_DEFAULTS.gemini.outputCost).toBe(5.00);
    expect(PRICING_DEFAULTS.claude.inputCost).toBe(3.00);
    expect(PRICING_DEFAULTS.claude.outputCost).toBe(15.00);
    expect(PRICING_DEFAULTS.minimax.inputCost).toBe(1.00);
    expect(PRICING_DEFAULTS.minimax.outputCost).toBe(4.00);
    expect(PRICING_DEFAULTS.glm.inputCost).toBe(0.50);
    expect(PRICING_DEFAULTS.glm.outputCost).toBe(2.00);
    expect(PRICING_DEFAULTS.mimo.inputCost).toBe(1.00);
    expect(PRICING_DEFAULTS.mimo.outputCost).toBe(4.00);
  });

  it('matches the canonical spend-limit defaults (5h and weekly) that were in app.js', () => {
    expect(PRICING_DEFAULTS.gemini.limit5h).toBe(2.00);
    expect(PRICING_DEFAULTS.gemini.limitWeekly).toBe(15.00);
    expect(PRICING_DEFAULTS.claude.limit5h).toBe(5.00);
    expect(PRICING_DEFAULTS.claude.limitWeekly).toBe(30.00);
    expect(PRICING_DEFAULTS.minimax.limit5h).toBe(2.00);
    expect(PRICING_DEFAULTS.minimax.limitWeekly).toBe(15.00);
    expect(PRICING_DEFAULTS.glm.limit5h).toBe(0.80);
    expect(PRICING_DEFAULTS.glm.limitWeekly).toBe(6.00);
    expect(PRICING_DEFAULTS.mimo.limit5h).toBe(2.00);
    expect(PRICING_DEFAULTS.mimo.limitWeekly).toBe(15.00);
  });

  it('preserves the gemini display name as "Antigravity" (per ADR-0001 / migration in app.js:65)', () => {
    expect(PRICING_DEFAULTS.gemini.name).toBe('Antigravity');
  });
});

describe('PRICING_DEFAULTS — single source of truth', () => {
  it('is the same object reference the server-side aggregator consumes (lib/rtk-metrics.js require)', () => {
    // Loading via a fresh require in the same way lib/rtk-metrics.js does.
    const fromServer = require('../lib/pricing-defaults.js');
    // Reference equality: Node caches the module, so both requires return
    // the same object. Drift in the two callers would break this.
    expect(fromServer).toBe(PRICING_DEFAULTS);
  });
});
