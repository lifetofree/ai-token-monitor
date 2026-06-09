// tests/reset5hFallback.test.js
// Tests for the 5h reset fallback chain in app.js's renderBrandCards.
// Mirrors the calculation (canonical implementation is inline in app.js,
// not extractable without touching the surrounding render code).
//
// The fallback chain is:
//   1. apiReset5hMs         — from apiQuota.reset_at (provider API gives it)
//   2. windowStartedReset5hMs — from apiQuota.window_started_at + 5h
//                              (server tracks when the 5h window's contents
//                              were first observed; for brands whose API
//                              doesn't expose a 5h reset, e.g. GLM)
//   3. rolling5hMs          — from data.earliest5hTimestamp + 5h
//                              (browser's local RTK rolling window)
//   4. null                 — all sources absent, label becomes "no active usage"
//
// We also assert the tooltip source follows the same precedence so the
// user can tell which fallback is currently driving the badge.

import { describe, it, expect } from 'vitest';

const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const ONE_WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Mirror of the inline calculation in renderBrandCards (app.js).
function computeReset5h({ now, apiQuota, data }) {
  const apiReset5hMs = apiQuota && apiQuota.reset_at && apiQuota.reset_at > now
    ? apiQuota.reset_at - now : null;
  const windowStartedReset5hMs = (apiReset5hMs === null
    && apiQuota && typeof apiQuota.window_started_at === 'number'
    && apiQuota.window_started_at > 0)
    ? (apiQuota.window_started_at + FIVE_HOUR_WINDOW_MS) - now
    : null;
  const rolling5hMs = data && typeof data.earliest5hTimestamp === 'number'
    ? (data.earliest5hTimestamp + FIVE_HOUR_WINDOW_MS) - now
    : null;
  const reset5hMs = apiReset5hMs !== null
    ? apiReset5hMs
    : (windowStartedReset5hMs !== null ? windowStartedReset5hMs : rolling5hMs);
  const tooltipSource = apiReset5hMs !== null
    ? 'api'
    : (windowStartedReset5hMs !== null ? 'window_started' : (rolling5hMs !== null ? 'rolling' : 'none'));
  return { reset5hMs, tooltipSource };
}

describe('5h reset fallback chain', () => {
  const NOW = 1_780_000_000_000;

  it('uses apiQuota.reset_at when present and in the future', () => {
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: { reset_at: NOW + 3_600_000 }, // 1h from now
      data: {}
    });
    expect(reset5hMs).toBe(3_600_000);
    expect(tooltipSource).toBe('api');
  });

  it('falls back to window_started_at + 5h when API has no 5h reset (GLM case)', () => {
    const windowStartedAt = NOW - 2 * 3_600_000; // observed 2h ago
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: {
        reset_at: null,
        weekly_remaining: 59,
        window_started_at: windowStartedAt
      },
      data: {}
    });
    // 5h - 2h elapsed = 3h remaining
    expect(reset5hMs).toBe(3 * 3_600_000);
    expect(tooltipSource).toBe('window_started');
  });

  it('prefers apiQuota.reset_at over window_started_at when both are present', () => {
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: {
        reset_at: NOW + 60_000,           // 1 min from now (authoritative)
        window_started_at: NOW - 4 * 3_600_000 // would give 1h if used
      },
      data: {}
    });
    expect(reset5hMs).toBe(60_000);
    expect(tooltipSource).toBe('api');
  });

  it('ignores stale apiQuota.reset_at (in the past) and falls back to window_started_at', () => {
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: {
        reset_at: NOW - 1_000,            // already passed — stale
        window_started_at: NOW - 3_600_000 // 4h remaining
      },
      data: {}
    });
    expect(reset5hMs).toBe(4 * 3_600_000);
    expect(tooltipSource).toBe('window_started');
  });

  it('falls back to local rolling window (RTK) when neither API nor window_started_at is available', () => {
    const earliest5hTimestamp = NOW - 2 * 3_600_000; // 3h remaining
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: null,
      data: { earliest5hTimestamp }
    });
    expect(reset5hMs).toBe(3 * 3_600_000);
    expect(tooltipSource).toBe('rolling');
  });

  it('prefers window_started_at over local rolling window', () => {
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: { window_started_at: NOW - 1_000 },     // ~5h remaining
      data: { earliest5hTimestamp: NOW - 4 * 3_600_000 } // 1h remaining
    });
    expect(reset5hMs).toBe(FIVE_HOUR_WINDOW_MS - 1_000);
    expect(tooltipSource).toBe('window_started');
  });

  it('returns null when all sources are absent (label becomes "no active usage")', () => {
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: { reset_at: null, window_started_at: null },
      data: {}
    });
    expect(reset5hMs).toBeNull();
    expect(tooltipSource).toBe('none');
  });

  it('returns null when apiQuota is null and data has no earliest5hTimestamp', () => {
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: null,
      data: null
    });
    expect(reset5hMs).toBeNull();
    expect(tooltipSource).toBe('none');
  });

  it('ignores window_started_at when it is 0 (uninitialised) or non-numeric', () => {
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: { window_started_at: 0 },
      data: { earliest5hTimestamp: NOW - 3_600_000 } // 4h remaining
    });
    expect(reset5hMs).toBe(4 * 3_600_000);
    expect(tooltipSource).toBe('rolling');
  });

  it('handles window_started_at pointing to a time in the past beyond 5h (window already reset)', () => {
    // window_started_at is 6h ago — the 5h window has already reset.
    // reset5hMs goes negative, which the formatter handles by showing "now".
    const { reset5hMs, tooltipSource } = computeReset5h({
      now: NOW,
      apiQuota: { window_started_at: NOW - 6 * 3_600_000 },
      data: {}
    });
    expect(reset5hMs).toBe(-3_600_000);
    expect(tooltipSource).toBe('window_started');
  });
});
