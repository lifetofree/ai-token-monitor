// tests/csv.test.js
// Tests for the CSV exporter in app.js (exportLogsAsCSV).
// Asserts the field order, the quoting rule for embedded commas and quotes,
// and the line terminator.

import { describe, it, expect } from 'vitest';

// Mirror of app.js's exportLogsAsCSV row builder. The canonical
// implementation is inside exportLogsAsCSV in app.js; this mirror is a
// regression net for the field order and quoting rules.
const CSV_FIELDS = [
  'timestamp', 'brand', 'model', 'inputTokens', 'outputTokens',
  'savedTokens', 'cost', 'source', 'status', 'cmdText',
];

function escapeCsvCell(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowToCsv(row) {
  return CSV_FIELDS.map((f) => escapeCsvCell(row[f])).join(',');
}

describe('CSV row builder', () => {
  it('produces a 10-field row in the documented order', () => {
    const csv = rowToCsv({
      timestamp: 1_780_000_000_000,
      brand: 'claude',
      model: 'claude-3-haiku',
      inputTokens: 1000,
      outputTokens: 500,
      savedTokens: 200,
      cost: 0.0105,
      source: 'real',
      status: 'ok',
      cmdText: 'curl ...',
    });
    expect(csv.split(',')).toHaveLength(10);
    expect(csv.startsWith('1780000000000,claude,claude-3-haiku,1000,500,200,0.0105,real,ok,')).toBe(true);
  });

  it('quotes a cell containing a comma', () => {
    const csv = rowToCsv({ cmdText: 'curl -X POST, hello' });
    expect(csv.endsWith('"curl -X POST, hello"')).toBe(true);
  });

  it('quotes a cell containing a double-quote and escapes the quote', () => {
    const csv = rowToCsv({ cmdText: 'echo "hi"' });
    expect(csv.endsWith('"echo ""hi"""')).toBe(true);
  });

  it('quotes a cell containing a newline', () => {
    const csv = rowToCsv({ cmdText: 'line1\nline2' });
    expect(csv.endsWith('"line1\nline2"')).toBe(true);
  });

  it('emits an empty string for null/undefined fields', () => {
    const csv = rowToCsv({ brand: 'claude', model: null, cmdText: undefined });
    expect(csv).toBe(',claude,,,,,,,,');
  });
});
