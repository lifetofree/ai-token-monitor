// tests/antigravityContext.test.js
import { describe, it, expect, vi } from 'vitest';
import { computeContextWindow, ACTIVE_SESSION_MS, DEFAULT_CONTEXT_WINDOW } from '../lib/antigravity-context';

function makeExec(mockImpl) {
  return vi.fn((_cmd, _args, cb) => {
    mockImpl(cb);
  });
}

describe('computeContextWindow', () => {
  it('exposes the documented default size (1M tokens) and 30-min active window', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
    expect(ACTIVE_SESSION_MS).toBe(30 * 60 * 1000);
  });

  it('returns null when no agent_usage rows are recent', async () => {
    const exec = makeExec((cb) => cb(null, ''));
    const cw = await computeContextWindow('/tmp/monitor.db', {
      now: 1_000_000_000_000, execFile: exec
    });
    expect(cw).toBeNull();
  });

  it('returns null on sqlite error', async () => {
    const exec = makeExec((cb) => cb(new Error('database is locked'), ''));
    const cw = await computeContextWindow('/tmp/monitor.db', {
      now: 1_000_000_000_000, execFile: exec
    });
    expect(cw).toBeNull();
  });

  it('uses inputTokens + cachedTokens as the numerator', async () => {
    const exec = makeExec((cb) => cb(null, JSON.stringify([{
      input_tokens: 8000,
      output_tokens: 4000,   // not counted
      cached_tokens: 2000,
      total_cost: 0.01,
      last_updated: 1_000_000_000_000
    }])));
    const cw = await computeContextWindow('/tmp/monitor.db', {
      now: 1_000_000_000_000,
      size: 1_000_000,
      execFile: exec
    });
    expect(cw.used).toBe(10000);
    expect(cw.usedPct).toBe(1);          // 10000/1M
    expect(cw.remaining).toBe(99);
    expect(cw.size).toBe(1_000_000);
    expect(cw.source).toBe('active');
  });

  it('clamps to 100% when used exceeds size', async () => {
    const exec = makeExec((cb) => cb(null, JSON.stringify([{
      input_tokens: 1_200_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_cost: 0,
      last_updated: 1_000_000_000_000
    }])));
    const cw = await computeContextWindow('/tmp/monitor.db', {
      now: 1_000_000_000_000,
      size: 1_000_000,
      execFile: exec
    });
    expect(cw.usedPct).toBe(100);
    expect(cw.remaining).toBe(0);
  });

  it('respects an explicit size override', async () => {
    const exec = makeExec((cb) => cb(null, JSON.stringify([{
      input_tokens: 500,
      output_tokens: 0,
      cached_tokens: 0,
      total_cost: 0,
      last_updated: 1_000_000_000_000
    }])));
    const cw = await computeContextWindow('/tmp/monitor.db', {
      now: 1_000_000_000_000,
      size: 1_000,                  // 1K window
      execFile: exec
    });
    expect(cw.usedPct).toBe(50);
  });
});
