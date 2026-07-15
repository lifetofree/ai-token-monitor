// tests/snapshot.test.js
// Tests for the consolidated /display/snapshot.json schema
// (docs/mac_monitor_plan.md Ticket #6). Imports lib/snapshot.js directly —
// the module is pure (no I/O, no globals except an explicit `now` argument)
// so it can be tested without HTTP mocks.

import { describe, it, expect } from 'vitest';
import {
  SNAPSHOT_BRANDS,
  BRAND_DISPLAY_NAMES,
  MAC_HISTORY_LIMIT,
  MAC_STALENESS_MS,
  emptyMacNode,
  buildBrandNode,
  placeholderBrandNode,
  buildSnapshot,
  mergeMacState,
  validateMacPayload,
  appendMacSample,
} from '../lib/snapshot.js';

const NOW = 1720980000000;

describe('schema constants', () => {
  it('exposes the four brand keys in the expected order', () => {
    expect(SNAPSHOT_BRANDS).toEqual(['gemini', 'claude', 'minimax', 'glm']);
  });

  it('maps each brand to a display name', () => {
    expect(BRAND_DISPLAY_NAMES.gemini).toBe('Antigravity');
    expect(BRAND_DISPLAY_NAMES.claude).toBe('Claude');
    expect(BRAND_DISPLAY_NAMES.minimax).toBe('Minimax');
    expect(BRAND_DISPLAY_NAMES.glm).toBe('GLM');
  });

  it('caps the mac history ring buffer at 60 samples (matches mac-monitor.js and ESP32)', () => {
    expect(MAC_HISTORY_LIMIT).toBe(60);
  });

  it('declares the mac staleness window as 10 seconds', () => {
    expect(MAC_STALENESS_MS).toBe(10_000);
  });
});

describe('emptyMacNode', () => {
  it('returns the documented placeholder shape with all metric slots', () => {
    const node = emptyMacNode(NOW);
    expect(node.last_seen).toBe(0);
    expect(node.online).toBe(false);
    expect(node.timestamp).toBe(NOW);
    expect(node.current).toEqual({
      cpu: 0,
      memory: { used: 0, total: 0, percent: 0 },
      network: { down: 0, up: 0 },
      temperature: null,
      battery: null,
    });
    expect(node.history).toEqual({
      cpu: [],
      memory: [],
      network_down: [],
      network_up: [],
      temperature: [],
      battery: [],
    });
  });
});

describe('placeholderBrandNode', () => {
  it('produces a no_data placeholder with -1 sentinels for unknown brands', () => {
    const node = placeholderBrandNode('claude', NOW);
    expect(node.name).toBe('Claude');
    expect(node.remaining).toBe(-1);
    expect(node.limit_value).toBe(-1);
    expect(node.weekly_remaining).toBe(-1);
    expect(node.unit).toBe('not_exposed');
    expect(node.error).toBe('no_data');
    expect(node.seeded_at).toBe(NOW);
    expect(node.spend_pct5h).toBe(0);
    expect(node.spend_pct_weekly).toBe(0);
  });
});

describe('buildBrandNode', () => {
  it('returns a fully populated node from a valid quota row', () => {
    const row = {
      brand: 'claude',
      remaining: 70,
      limit_value: 100,
      weekly_remaining: 850,
      reset_at: NOW + 3 * 3600 * 1000,
      reset_at_weekly: NOW + 4 * 24 * 3600 * 1000,
      unit: 'percent',
      error: '',
      seeded_at: NOW,
    };
    const node = buildBrandNode('claude', row, null, null);

    expect(node.name).toBe('Claude');
    expect(node.remaining).toBe(70);
    expect(node.limit_value).toBe(100);
    expect(node.weekly_remaining).toBe(850);
    // ESP32 wants SECONDS — the conversion is the whole point of this field.
    expect(node.reset_at).toBe(Math.round((NOW + 3 * 3600 * 1000) / 1000));
    expect(node.reset_at_weekly).toBe(Math.round((NOW + 4 * 24 * 3600 * 1000) / 1000));
    expect(node.error).toBe('');
    expect(node.seeded_at).toBe(NOW);
  });

  it('converts a 0 reset_at to 0 (not to "epoch seconds")', () => {
    const node = buildBrandNode('claude', {
      brand: 'claude', remaining: 50, limit_value: 100, weekly_remaining: 500,
      reset_at: 0, reset_at_weekly: 0, unit: 'percent', seeded_at: NOW,
    }, null, null);
    expect(node.reset_at).toBe(0);
    expect(node.reset_at_weekly).toBe(0);
  });

  it('derives reset windows from RTK spend when the provider does not expose one', () => {
    const allSpend = { claude: { reset5hAt: NOW + 2 * 3600 * 1000, resetWeeklyAt: NOW + 5 * 24 * 3600 * 1000, tokens5h: 1000, cost5h: 0.10 } };
    const node = buildBrandNode('claude', {
      brand: 'claude', remaining: 50, limit_value: 100, weekly_remaining: 500,
      reset_at: 0, reset_at_weekly: 0, unit: 'percent', seeded_at: NOW,
    }, allSpend, null);
    expect(node.reset_at).toBe(Math.round((NOW + 2 * 3600 * 1000) / 1000));
    expect(node.reset_at_weekly).toBe(Math.round((NOW + 5 * 24 * 3600 * 1000) / 1000));
    expect(node.tokens5h).toBe(1000);
    expect(node.cost5h).toBeCloseTo(0.1, 4);
  });

  it('falls back to raw_json._rtk_spend when allSpend has no entry', () => {
    const node = buildBrandNode('claude', {
      brand: 'claude', remaining: 50, limit_value: 100, weekly_remaining: 500,
      reset_at: 0, reset_at_weekly: 0, unit: 'percent', seeded_at: NOW,
      raw_json: JSON.stringify({ _rtk_spend: { tokens5h: 5000, cost5h: 0.50, requests5h: 12 } }),
    }, null, null);
    expect(node.tokens5h).toBe(5000);
    expect(node.cost5h).toBeCloseTo(0.5, 4);
    expect(node.spend_reqs5h).toBe(12);
  });

  it('adds agent_usage to gemini totals (cost + tokens + requests)', () => {
    const allSpend = { gemini: { tokens5h: 1000, cost5h: 0.10, requests5h: 5, earliest5hTimestamp: NOW - 2 * 3600 * 1000 } };
    const agentUsage = {
      window5h: { input: 500, output: 200, cost: 0.05, count: 3, earliest: NOW - 3600 * 1000 },
      weekly:   { input: 2000, output: 1000, cost: 0.25, count: 20, earliest: NOW - 3 * 24 * 3600 * 1000 },
      total:    { input: 0, output: 0, cost: 0, count: 0, earliest: null },
    };
    const node = buildBrandNode('gemini', {
      brand: 'gemini', remaining: 80, limit_value: 100, weekly_remaining: 600,
      reset_at: 0, reset_at_weekly: 0, unit: 'percent', seeded_at: NOW,
    }, allSpend, agentUsage);

    // tokens5h = 1000 (rtk) + 500 (agent input) + 200 (agent output) = 1700
    expect(node.tokens5h).toBe(1700);
    expect(node.cost5h).toBeCloseTo(0.15, 4); // 0.10 + 0.05
    expect(node.spend_reqs5h).toBe(8); // 5 + 3
    // Weekly tokens
    expect(node.tokens_wk).toBe(3000);
    // Reset at = earliest (rtk or agent) + 5h
    const expectedEarliest = Math.min(NOW - 2 * 3600 * 1000, NOW - 3600 * 1000);
    expect(node.reset_at).toBe(Math.round((expectedEarliest + 5 * 3600 * 1000) / 1000));
  });
});

describe('mergeMacState', () => {
  it('marks online=true when last_seen is within the staleness window', () => {
    const state = {
      last_seen: NOW - 2000,
      timestamp: NOW - 2000,
      current: { cpu: 50, memory: { used: 8, total: 16, percent: 50 }, network: { down: 100, up: 30 }, temperature: null, battery: null },
      history: { cpu: [{ t: NOW - 2000, v: 50 }] },
    };
    const merged = mergeMacState(state, NOW);
    expect(merged.online).toBe(true);
    expect(merged.current.cpu).toBe(50);
  });

  it('marks online=false when last_seen is older than the staleness window', () => {
    const state = {
      last_seen: NOW - 15_000,
      timestamp: NOW - 15_000,
      current: { cpu: 50, memory: { used: 8, total: 16, percent: 50 }, network: { down: 100, up: 30 }, temperature: null, battery: null },
      history: { cpu: [] },
    };
    const merged = mergeMacState(state, NOW);
    expect(merged.online).toBe(false);
  });

  it('marks online=false when last_seen is zero (no data ever posted)', () => {
    const merged = mergeMacState({ current: {}, history: {} }, NOW);
    expect(merged.online).toBe(false);
  });

  it('uses timestamp as a fallback when last_seen is missing', () => {
    const state = { timestamp: NOW - 1000, current: {}, history: {} };
    const merged = mergeMacState(state, NOW);
    expect(merged.online).toBe(true);
  });
});

describe('buildSnapshot', () => {
  it('emits the documented top-level shape with brand nodes and a mac node', () => {
    const snap = buildSnapshot({ now: NOW });
    expect(snap.lastUpdated).toBe(NOW);
    expect(Object.keys(snap).sort()).toEqual(['claude', 'gemini', 'glm', 'lastUpdated', 'mac', 'minimax']);
    expect(snap.gemini.name).toBe('Antigravity');
    expect(snap.claude.name).toBe('Claude');
    expect(snap.minimax.name).toBe('Minimax');
    expect(snap.glm.name).toBe('GLM');
    expect(snap.mac).toEqual(emptyMacNode(NOW));
  });

  it('inserts placeholder nodes for brands that have no quota row', () => {
    const snap = buildSnapshot({ brandQuotas: [], now: NOW });
    expect(snap.claude.error).toBe('no_data');
    expect(snap.claude.remaining).toBe(-1);
  });

  it('merges a posted mac state and computes online status', () => {
    const macState = {
      last_seen: NOW - 1000,
      timestamp: NOW - 1000,
      current: { cpu: 33, memory: { used: 6, total: 16, percent: 37.5 }, network: { down: 50, up: 10 }, temperature: null, battery: { percent: 90, charging: true } },
      history: { cpu: [{ t: NOW - 1000, v: 33 }] },
    };
    const snap = buildSnapshot({ macState, now: NOW });
    expect(snap.mac.online).toBe(true);
    expect(snap.mac.current.cpu).toBe(33);
    expect(snap.mac.current.battery.percent).toBe(90);
  });

  it('keeps brand nodes at the top level (not under a `quotas` key)', () => {
    // The old shape had `quotas.{brand}`; the new shape has `{brand}`.
    // Regression guard so a future "tidy up" doesn't accidentally nest
    // them again.
    const snap = buildSnapshot({ now: NOW });
    expect(snap.quotas).toBeUndefined();
    expect(snap.gemini.remaining).toBeDefined();
  });
});

describe('validateMacPayload (POST /api/mac body validation)', () => {
  const validPayload = {
    timestamp: NOW,
    current: {
      cpu: 50.5,
      memory: { used: 8, total: 16, percent: 50 },
      network: { down: 100, up: 30 },
      temperature: null,
      battery: { percent: 85, charging: true },
    },
    history: { cpu: [{ t: NOW, v: 50.5 }] },
  };

  it('accepts a fully-formed payload', () => {
    const r = validateMacPayload(validPayload);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a payload with no battery (desktop Macs)', () => {
    const r = validateMacPayload({ ...validPayload, current: { ...validPayload.current, battery: null } });
    expect(r.ok).toBe(true);
  });

  it('accepts a payload with omitted history (treated as empty {})', () => {
    const { history, ...withoutHistory } = validPayload;
    const r = validateMacPayload(withoutHistory);
    expect(r.ok).toBe(true);
  });

  it('rejects a non-object body', () => {
    expect(validateMacPayload(null).ok).toBe(false);
    expect(validateMacPayload('hello').ok).toBe(false);
    expect(validateMacPayload(42).ok).toBe(false);
    expect(validateMacPayload([]).ok).toBe(false);
  });

  it('rejects missing or non-positive timestamp', () => {
    expect(validateMacPayload({ ...validPayload, timestamp: 0 }).ok).toBe(false);
    expect(validateMacPayload({ ...validPayload, timestamp: -1 }).ok).toBe(false);
    expect(validateMacPayload({ ...validPayload, timestamp: 'now' }).ok).toBe(false);
  });

  it('rejects cpu outside 0..100', () => {
    expect(validateMacPayload({ ...validPayload, current: { ...validPayload.current, cpu: -1 } }).ok).toBe(false);
    expect(validateMacPayload({ ...validPayload, current: { ...validPayload.current, cpu: 101 } }).ok).toBe(false);
    expect(validateMacPayload({ ...validPayload, current: { ...validPayload.current, cpu: '50' } }).ok).toBe(false);
  });

  it('rejects memory.percent outside 0..100', () => {
    const bad = { ...validPayload, current: { ...validPayload.current, memory: { used: 8, total: 16, percent: 150 } } };
    expect(validateMacPayload(bad).ok).toBe(false);
  });

  it('rejects negative network bytes', () => {
    const bad = { ...validPayload, current: { ...validPayload.current, network: { down: -1, up: 30 } } };
    expect(validateMacPayload(bad).ok).toBe(false);
  });

  it('rejects battery with non-boolean charging', () => {
    const bad = { ...validPayload, current: { ...validPayload.current, battery: { percent: 85, charging: 'yes' } } };
    expect(validateMacPayload(bad).ok).toBe(false);
  });

  it('allows temperature to be null (no sudo per Ticket #5)', () => {
    const r = validateMacPayload(validPayload); // already null
    expect(r.ok).toBe(true);
  });

  it('rejects temperature that is neither null nor a number', () => {
    const bad = { ...validPayload, current: { ...validPayload.current, temperature: 'hot' } };
    expect(validateMacPayload(bad).ok).toBe(false);
  });

  it('rejects history that is an array instead of an object', () => {
    const bad = { ...validPayload, history: [] };
    expect(validateMacPayload(bad).ok).toBe(false);
  });

  it('reports ALL errors at once, not just the first', () => {
    const r = validateMacPayload({ timestamp: -1, current: { cpu: 200, memory: { percent: 150 }, network: { down: -1, up: -1 } } });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe('appendMacSample (ring buffer)', () => {
  it('appends a sample to an empty buffer', () => {
    const out = appendMacSample([], { t: 1, v: 10 });
    expect(out).toEqual([{ t: 1, v: 10 }]);
  });

  it('caps the buffer at MAC_HISTORY_LIMIT and shifts the oldest out', () => {
    let buf = [];
    for (let i = 0; i < MAC_HISTORY_LIMIT + 5; i++) {
      buf = appendMacSample(buf, { t: i, v: i * 2 });
    }
    expect(buf.length).toBe(MAC_HISTORY_LIMIT);
    // The first 5 samples should have been shifted out.
    expect(buf[0].t).toBe(5);
    expect(buf[buf.length - 1].t).toBe(MAC_HISTORY_LIMIT + 4);
  });

  it('returns a copy (does not mutate the input buffer)', () => {
    const original = [{ t: 1, v: 10 }];
    const out = appendMacSample(original, { t: 2, v: 20 });
    expect(original.length).toBe(1);
    expect(out.length).toBe(2);
  });

  it('rejects malformed samples (missing t or v)', () => {
    const buf = [{ t: 1, v: 1 }];
    expect(appendMacSample(buf, { t: 2 })).toEqual(buf);
    expect(appendMacSample(buf, { v: 2 })).toEqual(buf);
    expect(appendMacSample(buf, null)).toEqual(buf);
  });

  it('returns an empty array for non-array input', () => {
    expect(appendMacSample(null, { t: 1, v: 1 })).toEqual([]);
    expect(appendMacSample(undefined, { t: 1, v: 1 })).toEqual([]);
  });
});
