// lib/otel-usage.js
// Ingests Claude Code's native OpenTelemetry logs (OTLP/HTTP, JSON encoding —
// see docs/research/... discussion) and stores per-request usage in the same
// RTK sqlite DB. This is ground-truth data from Claude Code's own billing
// accounting (real cost_usd, real cache-read/creation split), not RTK's
// reconstruction from parsed command output.
//
// Only `claude_code.api_request` log records are consumed — verified against
// a real captured payload to carry every field needed in one flat event
// (model, token breakdown, cost_usd, request_id), rather than reconstructing
// from the separate claude_code.token.usage/cost.usage metric counters.
'use strict';

const { execFile } = require('child_process');
const path = require('path');

const homeDir = process.env.HOME || require('os').homedir();
const DB_PATH = process.env.RTK_DB_PATH || path.join(homeDir, 'Library/Application Support/rtk/history.db');

function escapeSQLString(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function escapeSQLNumber(val) {
  if (val === null || val === undefined || isNaN(val)) return 'NULL';
  return parseInt(val, 10);
}

function escapeSQLFloat(val) {
  if (val === null || val === undefined || isNaN(val)) return 'NULL';
  return parseFloat(val);
}

function ensureClaudeOtelTable() {
  const query = `CREATE TABLE IF NOT EXISTS claude_otel_usage (
    request_id TEXT PRIMARY KEY,
    session_id TEXT,
    ts INTEGER,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cost_usd REAL,
    duration_ms INTEGER,
    effort TEXT,
    speed TEXT
  );`;
  execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, query], (error) => {
    if (error) console.error('Failed to create claude_otel_usage table:', error);
  });
}

// OTLP JSON attribute values are typed wrappers: {stringValue|intValue|doubleValue|boolValue}.
// Flatten an attributes array into a plain object, taking whichever typed key is present.
function flattenAttributes(attrs) {
  const out = {};
  if (!Array.isArray(attrs)) return out;
  for (const a of attrs) {
    if (!a || typeof a.key !== 'string' || !a.value) continue;
    const v = a.value;
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null;
  }
  return out;
}

function insertClaudeOtelUsage(row) {
  const insertSql = `INSERT OR IGNORE INTO claude_otel_usage
    (request_id, session_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, effort, speed)
    VALUES (${escapeSQLString(row.request_id)}, ${escapeSQLString(row.session_id)}, ${escapeSQLNumber(row.ts)},
      ${escapeSQLString(row.model)}, ${escapeSQLNumber(row.input_tokens)}, ${escapeSQLNumber(row.output_tokens)},
      ${escapeSQLNumber(row.cache_read_tokens)}, ${escapeSQLNumber(row.cache_creation_tokens)},
      ${escapeSQLFloat(row.cost_usd)}, ${escapeSQLNumber(row.duration_ms)},
      ${escapeSQLString(row.effort)}, ${escapeSQLString(row.speed)});`;
  execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, insertSql], (error) => {
    if (error) console.error('[otel] Failed to insert claude_otel_usage row:', error.message);
  });
}

// Parses a POST /v1/logs OTLP/HTTP JSON body and stores every
// claude_code.api_request record found. Malformed/unrelated payloads are
// silently ignored — this endpoint always acks 200 regardless (see server.js)
// so the exporter never treats an ingest-side problem as an export failure.
function handleOtlpLogsPayload(bodyText) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (e) {
    return;
  }

  const resourceLogs = payload.resourceLogs;
  if (!Array.isArray(resourceLogs)) return;

  for (const rl of resourceLogs) {
    const scopeLogs = rl.scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;
    for (const sl of scopeLogs) {
      const logRecords = sl.logRecords;
      if (!Array.isArray(logRecords)) continue;
      for (const lr of logRecords) {
        if (!lr.body || lr.body.stringValue !== 'claude_code.api_request') continue;
        const attrs = flattenAttributes(lr.attributes);
        if (!attrs.request_id) continue; // malformed record — no primary key to dedupe on
        // event.timestamp is an ISO string; timeUnixNano is the OTLP record
        // timestamp (nanoseconds since epoch) — fall back to it if the
        // event-level timestamp is missing.
        const ts = attrs['event.timestamp']
          ? Math.floor(new Date(attrs['event.timestamp']).getTime() / 1000)
          : Math.floor(Number(lr.timeUnixNano) / 1e9);

        insertClaudeOtelUsage({
          request_id: attrs.request_id,
          session_id: attrs['session.id'],
          ts,
          model: attrs.model,
          input_tokens: attrs.input_tokens,
          output_tokens: attrs.output_tokens,
          cache_read_tokens: attrs.cache_read_tokens,
          cache_creation_tokens: attrs.cache_creation_tokens,
          cost_usd: attrs.cost_usd,
          duration_ms: attrs.duration_ms,
          effort: attrs.effort,
          speed: attrs.speed,
        });
      }
    }
  }
}

module.exports = { ensureClaudeOtelTable, handleOtlpLogsPayload };
