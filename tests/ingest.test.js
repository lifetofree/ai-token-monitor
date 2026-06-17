// tests/ingest.test.js
// Tests for POST /api/rtk/ingest — validation, coercion, SQL injection
// protection, broadcast shape, and brand-field coercion.
// Mirror-function approach: no HTTP server needed; the SQL-building
// and validation logic is re-implemented here and kept in sync with
// server.js. Relies on lib/quota-cache.js escape helpers (same as server).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { escapeSQLString, escapeSQLNumber, escapeSQLFloat } = require('../lib/quota-cache');

// ─── Shared mirrors of server.js ingest handler ───────────────────────────

const VALID_BRANDS = ['claude', 'gemini', 'minimax', 'glm'];

function coerceBrandHint(payload) {
  return (typeof payload.brand === 'string'
    && VALID_BRANDS.includes(payload.brand.toLowerCase()))
    ? payload.brand.toLowerCase()
    : '';
}

// Full mirror of the server's per-request validator + SQL builder.
// Returns { ok, status, body, sql } — `sql` is the INSERT statement
// for inspection by SQL-injection and schema tests.
function buildIngestInsert(payload) {
  if (typeof payload.original_cmd !== 'string' || payload.original_cmd.trim() === '') {
    return { ok: false, status: 400, body: { success: false, error: 'original_cmd is required (non-empty string)' } };
  }

  const originalCmd  = String(payload.original_cmd);
  const inputTokens  = Number.isFinite(payload.input_tokens)  ? Math.max(0, parseInt(payload.input_tokens,  10)) : 0;
  const outputTokens = Number.isFinite(payload.output_tokens) ? Math.max(0, parseInt(payload.output_tokens, 10)) : 0;
  const savedTokens  = Number.isFinite(payload.saved_tokens)  ? Math.max(0, parseInt(payload.saved_tokens,  10)) : 0;
  const execTimeMs   = Number.isFinite(payload.exec_time_ms)  ? Math.max(0, parseInt(payload.exec_time_ms,  10)) : 0;
  const timestamp    = (typeof payload.timestamp === 'string' && payload.timestamp.trim())
    ? payload.timestamp.trim()
    : 'NOW_ISO';
  const rtkCmd      = (typeof payload.rtk_cmd      === 'string') ? payload.rtk_cmd      : '';
  const projectPath = (typeof payload.project_path === 'string') ? payload.project_path : '';
  const brandHint   = coerceBrandHint(payload);
  const total       = inputTokens + savedTokens;
  const savingsPct  = Number.isFinite(payload.savings_pct)
    ? Math.max(0, Math.min(100, parseFloat(payload.savings_pct)))
    : (total > 0 ? (savedTokens / total) * 100 : 0);

  const clientId = Number.isFinite(payload.id) ? parseInt(payload.id, 10) : null;
  const idClause = clientId !== null ? `${clientId}, ` : '';

  const sql = `INSERT INTO commands (${idClause}timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path, brand) VALUES (${escapeSQLString(timestamp)}, ${escapeSQLString(originalCmd)}, ${escapeSQLString(rtkCmd)}, ${escapeSQLNumber(inputTokens)}, ${escapeSQLNumber(outputTokens)}, ${escapeSQLNumber(savedTokens)}, ${escapeSQLFloat(savingsPct)}, ${escapeSQLNumber(execTimeMs)}, ${escapeSQLString(projectPath)}, ${escapeSQLString(brandHint)});`;

  return { ok: true, status: 200, body: { success: true }, sql };
}

// ─── Validation ───────────────────────────────────────────────────────────

describe('POST /api/rtk/ingest — validation', () => {
  it('rejects an empty body with 400 (AC-22)', () => {
    const r = buildIngestInsert({});
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/original_cmd/);
  });

  it('rejects a missing original_cmd with 400', () => {
    const r = buildIngestInsert({ input_tokens: 10 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects a whitespace-only original_cmd with 400', () => {
    const r = buildIngestInsert({ original_cmd: '   \n\t  ' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects a non-string original_cmd with 400', () => {
    const r = buildIngestInsert({ original_cmd: 12345 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('accepts a valid payload with defaults (AC-22)', () => {
    const r = buildIngestInsert({ original_cmd: 'claude code --help' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.sql).toMatch(/INSERT INTO commands \(timestamp, original_cmd/);
    expect(r.sql).toMatch(/'claude code --help'/);
  });
});

// ─── Coercion & defaults ──────────────────────────────────────────────────

describe('POST /api/rtk/ingest — coercion & defaults', () => {
  it('coerces numeric token values to non-negative integers (AC-23)', () => {
    const r = buildIngestInsert({
      original_cmd: 'rtk gemini "hello"',
      input_tokens: 1500,
      output_tokens: 250,
      saved_tokens: 300
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/1500, 250, 300/);
  });

  it('rejects string token values (Number.isFinite does not coerce strings)', () => {
    const r = buildIngestInsert({
      original_cmd: 'rtk gemini',
      input_tokens: '1500',
      output_tokens: '250',
      saved_tokens: '300'
    });
    expect(r.ok).toBe(true);
    // All token counts default to 0; brand='' (no brand field supplied)
    expect(r.sql).toMatch(/'rtk gemini', '', 0, 0, 0, 0, 0, '', ''\);$/);
  });

  it('clamps negative token values to 0', () => {
    const r = buildIngestInsert({
      original_cmd: 'claude',
      input_tokens: -100,
      saved_tokens: -5
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/'claude', '', 0, 0, 0, 0, 0, '', ''\);$/);
  });

  it('treats NaN token values as 0', () => {
    const r = buildIngestInsert({
      original_cmd: 'claude',
      input_tokens: 'not-a-number',
      output_tokens: null,
      saved_tokens: undefined
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/'claude', '', 0, 0, 0, 0, 0, '', ''\);$/);
  });

  it('computes default savings_pct from disjoint formula when not provided (AC-23)', () => {
    // saved/(input+saved)*100 = 200/1200*100 = 16.666...
    const r = buildIngestInsert({
      original_cmd: 'claude',
      input_tokens: 1000,
      saved_tokens: 200
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/16\.666666666666664/);
  });

  it('returns savings_pct = 0 when both input and saved are 0', () => {
    const r = buildIngestInsert({ original_cmd: 'claude' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/'claude', '', 0, 0, 0, 0, 0, '', ''\);$/);
  });

  it('clamps a user-supplied savings_pct to [0, 100]', () => {
    const r1 = buildIngestInsert({ original_cmd: 'claude', savings_pct: 150 });
    const r2 = buildIngestInsert({ original_cmd: 'claude', savings_pct: -10 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.sql).toMatch(/'claude', '', 0, 0, 0, 100, 0, '', ''\);$/);
    expect(r2.sql).toMatch(/'claude', '', 0, 0, 0, 0, 0, '', ''\);$/);
  });

  it('includes client-supplied id in the column list (AC-24)', () => {
    const r = buildIngestInsert({ id: 42, original_cmd: 'claude' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/INSERT INTO commands \(42, timestamp, original_cmd, rtk_cmd/);
  });

  it('omits the id column when the client does not provide one', () => {
    const r = buildIngestInsert({ original_cmd: 'claude' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/INSERT INTO commands \(timestamp, original_cmd, rtk_cmd/);
    expect(r.sql).not.toMatch(/INSERT INTO commands \(\d+, timestamp/);
  });
});

// ─── SQL injection protection ─────────────────────────────────────────────

describe('POST /api/rtk/ingest — SQL injection protection', () => {
  it('escapes single quotes in original_cmd (AC-25)', () => {
    const r = buildIngestInsert({ original_cmd: "claude ' OR 1=1; DROP TABLE commands; --" });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/'claude '' OR 1=1; DROP TABLE commands; --'/);
    expect(r.sql).toMatch(/^INSERT INTO commands /);
    expect(r.sql).toMatch(/;\s*$/);
    // The injection payload contains 2 `;` chars; plus the trailing terminator = 3 total.
    const semicolons = r.sql.match(/;/g);
    expect(semicolons.length).toBe(3);
  });

  it('escapes single quotes in timestamp', () => {
    const r = buildIngestInsert({
      original_cmd: 'claude',
      timestamp: "2026-06-16T12:00:00Z'; DROP TABLE commands; --"
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/'2026-06-16T12:00:00Z''; DROP TABLE commands; --'/);
  });

  it('ignores token injection attempts (numeric path is type-coerced)', () => {
    const r = buildIngestInsert({
      original_cmd: 'claude',
      input_tokens: "1500; DROP TABLE commands",
      saved_tokens: "200 OR 1=1"
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/'claude', '', 0, 0, 0, 0, 0, '', ''\);$/);
    expect(r.sql).not.toMatch(/1500/);
    expect(r.sql).not.toMatch(/DROP/);
    expect(r.sql).not.toMatch(/OR 1=1/);
  });

  it('accepts numeric strings that Number.isFinite accepts (actual numbers)', () => {
    // JSON.parse converts numeric literals to numbers, not strings. Pins the
    // current behaviour so any future change to accept string-numbers is intentional.
    const r = buildIngestInsert({
      original_cmd: 'claude',
      input_tokens: 1500,   // actual number
      saved_tokens: 200     // actual number
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/'claude', '', 1500, 0, 200/);
  });

  it('rejects NaN strings that cannot be coerced (becomes 0)', () => {
    const r = buildIngestInsert({
      original_cmd: 'claude',
      input_tokens: 'NaN'
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/'claude', '', 0, 0, 0, 0, 0, '', ''\);$/);
  });
});

// ─── Broadcast / INSERT shape ─────────────────────────────────────────────

describe('POST /api/rtk/ingest — broadcast trigger', () => {
  it('builds a well-formed INSERT with all required columns (AC-22)', () => {
    const r = buildIngestInsert({
      original_cmd: 'rtk gemini "Hello, world"',
      input_tokens: 100,
      output_tokens: 50,
      saved_tokens: 25,
      exec_time_ms: 1234,
      timestamp: '2026-06-16T12:34:56.000Z'
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toContain('INSERT INTO commands');
    expect(r.sql).toContain("'2026-06-16T12:34:56.000Z'");
    expect(r.sql).toContain("'rtk gemini \"Hello, world\"'");
    // Row ends: rtk_cmd='', input=100, output=50, saved=25, savings_pct=20, exec=1234, project='', brand=''
    expect(r.sql).toMatch(/, '', 100, 50, 25, 20, 1234, '', ''\);$/);
  });

  it('preserves the input_tokens + saved_tokens disjoint invariant (AC-23)', () => {
    // savings_pct = saved/(input+saved)*100 = 200/1200*100 = 16.666...
    const r = buildIngestInsert({
      original_cmd: 'claude',
      input_tokens: 1000,
      output_tokens: 500,
      saved_tokens: 200
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/16\.666666666666664/);
  });
});

// ─── Brand-field coercion ─────────────────────────────────────────────────

describe('ingest brand coercion', () => {
  it('accepts a valid brand override and writes it to the INSERT', () => {
    const r = buildIngestInsert({
      original_cmd: 'generate_content(prompt)',
      input_tokens: 500,
      brand: 'gemini'
    });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, 'gemini'\);$/);
  });

  it('accepts claude brand', () => {
    const r = buildIngestInsert({ original_cmd: 'call_ai()', brand: 'claude' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, 'claude'\);$/);
  });

  it('accepts glm brand', () => {
    const r = buildIngestInsert({ original_cmd: 'zhipu_call()', brand: 'glm' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, 'glm'\);$/);
  });

  it('accepts minimax brand', () => {
    const r = buildIngestInsert({ original_cmd: 'mm_call()', brand: 'minimax' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, 'minimax'\);$/);
  });

  it('ignores unknown brand values (not in VALID_BRANDS)', () => {
    const r = buildIngestInsert({ original_cmd: 'call_ai()', brand: 'openai' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, ''\);$/);
  });

  it('defaults to empty string when brand is missing', () => {
    const r = buildIngestInsert({ original_cmd: 'call_ai()', input_tokens: 100 });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, ''\);$/);
  });

  it('defaults to empty string when brand is null', () => {
    const r = buildIngestInsert({ original_cmd: 'call_ai()', brand: null });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, ''\);$/);
  });

  it('normalises uppercase brand to lowercase', () => {
    const r = buildIngestInsert({ original_cmd: 'call_ai()', brand: 'GEMINI' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, 'gemini'\);$/);
  });

  it('normalises mixed-case brand to lowercase', () => {
    const r = buildIngestInsert({ original_cmd: 'call_ai()', brand: 'Claude' });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, 'claude'\);$/);
  });

  it('ignores non-string brand (number)', () => {
    const r = buildIngestInsert({ original_cmd: 'call_ai()', brand: 42 });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, ''\);$/);
  });

  it('ignores non-string brand (object)', () => {
    const r = buildIngestInsert({ original_cmd: 'call_ai()', brand: { name: 'gemini' } });
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/, ''\);$/);
  });

  it('escapes single quotes in brand value via escapeSQLString', () => {
    // coerceBrandHint would return '' for an unrecognised value, but test the
    // escape path directly to confirm the helper handles injection in that field.
    const escaped = escapeSQLString("it's a test");
    expect(escaped).toBe("'it''s a test'");
  });
});
