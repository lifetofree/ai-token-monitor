// lib/quota-cache.js
// Brand quota SQLite cache: table management, seeding, TTL constants.
'use strict';

const { execFile } = require('child_process');
const path = require('path');

const homeDir = process.env.HOME || require('os').homedir();
const DB_PATH = process.env.RTK_DB_PATH || path.join(homeDir, 'Library/Application Support/rtk/history.db');

// Quota TTL constants (TL-10: hoisted from inline in seedBrandQuotas).
const QUOTA_TTL_MS_FAST = 60_000;    // providers without a reset signal (1 min)
const QUOTA_TTL_MS_SLOW = 3 * 60_000; // providers with reset_at exposed (3 min)

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

function ensureBrandQuotaTable() {
  const query = `CREATE TABLE IF NOT EXISTS brand_quota (
    brand TEXT PRIMARY KEY,
    remaining INTEGER,
    limit_value INTEGER,
    reset_at INTEGER,
    reset_at_weekly INTEGER,
    weekly_remaining INTEGER,
    unit TEXT,
    raw_json TEXT,
    seeded_at INTEGER,
    error TEXT
  );`;
  execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, query], (error) => {
    if (error) {
      console.error('Failed to create brand_quota table:', error);
      return;
    }
    // Idempotent migrations: older DBs may lack these columns.
    execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, "ALTER TABLE brand_quota ADD COLUMN reset_at_weekly INTEGER"], () => {});
    execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, "ALTER TABLE brand_quota ADD COLUMN weekly_remaining INTEGER"], () => {});
    execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, "ALTER TABLE brand_quota ADD COLUMN window_started_at INTEGER"], () => {});
  });
}

function readBrandQuotaRows() {
  return new Promise((resolve) => {
    const query = "SELECT brand, remaining, limit_value, reset_at, reset_at_weekly, weekly_remaining, unit, raw_json, seeded_at, error, window_started_at FROM brand_quota";
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([]);
      } else {
        try { resolve(JSON.parse(stdout)); } catch (e) { resolve([]); }
      }
    });
  });
}

function writeBrandQuotaRow(row) {
  return new Promise((resolve) => {
    const sql = `INSERT OR REPLACE INTO brand_quota (brand, remaining, limit_value, reset_at, reset_at_weekly, weekly_remaining, unit, raw_json, seeded_at, error, window_started_at) VALUES (
      ${escapeSQLString(row.brand)},
      ${escapeSQLNumber(row.remaining)},
      ${escapeSQLNumber(row.limit_value)},
      ${escapeSQLNumber(row.reset_at)},
      ${escapeSQLNumber(row.reset_at_weekly)},
      ${escapeSQLNumber(row.weekly_remaining)},
      ${escapeSQLString(row.unit)},
      ${escapeSQLString(row.raw_json ? JSON.stringify(row.raw_json) : null)},
      ${row.seeded_at},
      ${escapeSQLString(row.error)},
      ${escapeSQLNumber(row.window_started_at)}
    );`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, sql], () => resolve());
  });
}

function isCacheValid(existing, brandFetchers) {
  let allValid = existing.length >= Object.keys(brandFetchers).length;
  const recent = [];
  for (const r of existing) {
    if (!r.seeded_at) { allValid = false; break; }
    if (r.reset_at && Date.now() >= r.reset_at) { allValid = false; break; }
    if (r.reset_at_weekly && Date.now() >= r.reset_at_weekly) { allValid = false; break; }
    const maxAge = (r.reset_at || r.reset_at_weekly) ? QUOTA_TTL_MS_SLOW : QUOTA_TTL_MS_FAST;
    if (Date.now() - r.seeded_at >= maxAge) { allValid = false; break; }
    recent.push(r);
  }
  return (allValid && recent.length >= Object.keys(brandFetchers).length) ? recent : null;
}

module.exports = {
  DB_PATH, escapeSQLString, escapeSQLNumber, escapeSQLFloat,
  ensureBrandQuotaTable, readBrandQuotaRows, writeBrandQuotaRow,
  isCacheValid, QUOTA_TTL_MS_FAST, QUOTA_TTL_MS_SLOW
};
