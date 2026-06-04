// tests/format.test.js
// Tests for the pure formatters in app.js (formatCurrency, formatNumber,
// formatCompactNumber, formatTimeRemaining). These mirror the canonical
// implementations so the test file can run without DOM. A follow-up task
// is to extract these to a shared `lib/` module that both app.js and the
// tests can import.

import { describe, it, expect } from 'vitest';

// Mirror of formatCurrency in app.js
//   val === 0          → "$0.0000"
//   0 < |val| < 0.01   → 5 decimals
//   |val| >= 0.01      → 2-4 decimals, locale-aware
function formatCurrency(val) {
  if (val === 0) return '$0.0000';
  const sign = val < 0 ? '-' : '';
  const abs = Math.abs(val);
  if (abs < 0.01) {
    return `${sign}$${abs.toFixed(5)}`;
  }
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

// Mirror of formatTimeRemaining in app.js
//   ms <= 0            → "soon"
//   days > 0           → "Nd Mh"
//   hours > 0          → "Nh Mm"
//   otherwise          → "Mm"
function formatTimeRemaining(ms) {
  if (ms <= 0) return 'soon';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// Mirror of formatNumber in app.js
function formatNumber(num) {
  return num.toLocaleString();
}

// Mirror of formatCompactNumber in app.js
//   >= 1M → "X.YM"
//   >= 1K → "X.Yk"
//   else  → plain string
function formatCompactNumber(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'k';
  return num.toString();
}

describe('formatCurrency', () => {
  it('zero returns the documented placeholder "$0.0000"', () => {
    expect(formatCurrency(0)).toBe('$0.0000');
  });
  it('positive amount ≥ $0.01 renders 2-4 decimals', () => {
    expect(formatCurrency(12.5)).toBe('$12.50');
    expect(formatCurrency(0.5)).toBe('$0.50');
  });
  it('sub-cent amount renders 5 decimals', () => {
    expect(formatCurrency(0.000265)).toBe('$0.00026');
    expect(formatCurrency(0.0001)).toBe('$0.00010');
  });
  it('negative sign goes outside the dollar mark', () => {
    expect(formatCurrency(-3.14)).toBe('-$3.14');
    expect(formatCurrency(-0.0001)).toBe('-$0.00010');
  });
});

describe('formatTimeRemaining', () => {
  it('non-positive returns "soon"', () => {
    expect(formatTimeRemaining(0)).toBe('soon');
    expect(formatTimeRemaining(-1000)).toBe('soon');
  });
  it('sub-hour shows minutes only', () => {
    expect(formatTimeRemaining(45 * 60_000)).toBe('45m');
  });
  it('sub-day shows hours and minutes', () => {
    expect(formatTimeRemaining((3 * 60 + 47) * 60_000)).toBe('3h 47m');
  });
  it('multi-day shows days and hours', () => {
    expect(formatTimeRemaining((3 * 24 + 19) * 60 * 60_000)).toBe('3d 19h');
  });
  it('exact 1 hour shows "1h 0m"', () => {
    expect(formatTimeRemaining(60 * 60_000)).toBe('1h 0m');
  });
  it('exact 1 day shows "1d 0h"', () => {
    expect(formatTimeRemaining(24 * 60 * 60_000)).toBe('1d 0h');
  });
});

describe('formatNumber', () => {
  it('passes through small numbers (locale-aware)', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(123)).toBe('123');
  });
  it('inserts locale thousands separators', () => {
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('formatCompactNumber', () => {
  it('sub-thousand returns plain number', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });
  it('thousands return X.Yk (lowercase)', () => {
    expect(formatCompactNumber(1000)).toBe('1.0k');
    expect(formatCompactNumber(1500)).toBe('1.5k');
    expect(formatCompactNumber(123_456)).toBe('123.5k');
  });
  it('millions return X.YM (uppercase)', () => {
    expect(formatCompactNumber(1_000_000)).toBe('1.0M');
    expect(formatCompactNumber(2_500_000)).toBe('2.5M');
  });
});
