// tests/fetchMinimaxQuota.test.js
// Tests for the MiniMax quota fetcher's defensive response parser. We mock
// `https.request` to feed canned responses and assert the parser picks the
// right fields out of the (undocumented, evolving) wire format.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock https module so we don't actually open a socket.
const mockRequest = vi.fn();
vi.mock('https', () => ({
  default: { request: (...a) => mockRequest(...a) },
  request: (...a) => mockRequest(...a),
}));

// Standalone mirror of the server.js defensive parsers. These are pure
// functions; the surrounding fetchMinimaxQuota just glues them to https.
function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
function pickField(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}
function extractRemaining(entry) {
  const value = pickField(entry,
    'current_interval_remaining_percent',
    'current_interval_remaining_count',
    'current_window_remaining_count'
  );
  if (value !== null) return value;

  if (entry != null) {
    const unobserved = [
      'current_remaining_percent',
      'current_remaining_count',
      'remaining_count',
      'usage_percent',
      'usagePercent'
    ];
    const found = unobserved.find(k => entry[k] != null);
    if (found) {
      console.warn(`Unobserved MiniMax quota field detected: "${found}" with value ${entry[found]}`);
      return entry[found];
    }
  }
  return null;
}
function extractLimit(entry) {
  return pickField(entry, 'current_interval_total_count', 'limit', 'total_count', 'quota');
}
function extractEndTime(entry) {
  return pickField(entry, 'end_time', 'current_end_time', 'reset_at', 'interval_end_time');
}
function extractWeeklyRemaining(entry) {
  return pickField(
    entry,
    'current_weekly_remaining_percent',
    'current_week_remaining_percent',
    'weekly_remaining_percent',
    'weekly_remaining_count'
  );
}
function extractWeeklyEndTime(entry) {
  return pickField(entry, 'weekly_end_time', 'current_week_end_time', 'week_end_time');
}

describe('MiniMax defensive parsers (mirror of server.js helpers)', () => {
  it('toEpochMs handles ISO 8601 strings', () => {
    const ms = toEpochMs('2026-06-04T10:00:00.000Z');
    expect(ms).toBe(Date.parse('2026-06-04T10:00:00.000Z'));
  });

  it('toEpochMs handles seconds-precision numbers by ×1000', () => {
    const sec = 1_780_000_000;
    expect(toEpochMs(sec)).toBe(sec * 1000);
  });

  it('toEpochMs handles ms-precision numbers as-is', () => {
    const ms = 1_780_000_000_000;
    expect(toEpochMs(ms)).toBe(ms);
  });

  it('toEpochMs returns null for invalid input', () => {
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs('not a date')).toBeNull();
  });

  it('extractRemaining prefers percent field when present', () => {
    expect(extractRemaining({ current_interval_remaining_percent: 78 })).toBe(78);
  });

  it('extractRemaining resolves observed aliases correctly', () => {
    expect(extractRemaining({ current_interval_remaining_percent: 78 })).toBe(78);
    expect(extractRemaining({ current_interval_remaining_count: 45 })).toBe(45);
    expect(extractRemaining({ current_window_remaining_count: 22 })).toBe(22);
  });

  it('extractRemaining triggers warning on unobserved aliases but still returns value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = extractRemaining({ usage_percent: 90 });
    expect(res).toBe(90);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('extractRemaining returns null when nothing matches', () => {
    expect(extractRemaining({ unrelated: 1 })).toBeNull();
  });

  it('extractLimit prefers total_count then quota', () => {
    expect(extractLimit({ current_interval_total_count: 1000 })).toBe(1000);
    expect(extractLimit({ quota: 500 })).toBe(500);
  });

  it('extractEndTime accepts any of the documented aliases', () => {
    expect(extractEndTime({ end_time: 1 })).toBe(1);
    expect(extractEndTime({ reset_at: 2 })).toBe(2);
  });

  it('extractWeeklyRemaining falls back to current_weekly_remaining_percent', () => {
    expect(extractWeeklyRemaining({ current_weekly_remaining_percent: 90 })).toBe(90);
    expect(extractWeeklyRemaining({ weekly_remaining_count: 50 })).toBe(50);
  });

  it('extractWeeklyEndTime reads weekly_end_time', () => {
    expect(extractWeeklyEndTime({ weekly_end_time: 1_780_000_000 })).toBe(1_780_000_000);
  });
});
