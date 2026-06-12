// tests/envRoundTrip.test.js
// Tests for the .env sibling-preservation fix (PM-3: AC-21).
// Mirrors the env read/write logic from server.js since the server is not
// directly importable. Tests that non-whitelisted keys survive a write cycle.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ALLOWED_KEYS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY'];

// Mirror of the per-key env writer from server.js (POST /api/env/key)
function writeEnvKey(envPath, keyName, value) {
  const existing = (() => { try { return fs.readFileSync(envPath, 'utf8'); } catch (e) { return ''; } })();
  const lines = existing ? existing.split('\n') : [];
  const map = {};
  lines.forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) map[line.substring(0, idx).trim()] = line.substring(idx + 1);
  });
  if (value === '') {
    delete map[keyName];
  } else {
    map[keyName] = value;
  }
  const allKeys = Object.keys(map);
  const newContent = allKeys.map(k => `${k}=${map[k]}`).join('\n') + '\n';
  fs.writeFileSync(envPath, newContent);
}

// Mirror of the bulk env writer from server.js (POST /api/env)
function writeEnvBulk(envPath, keys) {
  const existing = (() => { try { return fs.readFileSync(envPath, 'utf8'); } catch (e) { return ''; } })();
  const map = {};
  existing.split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) map[line.substring(0, idx).trim()] = line.substring(idx + 1);
  });
  ALLOWED_KEYS.forEach(k => {
    if (keys[k] && typeof keys[k] === 'string') {
      map[k] = keys[k].replace(/[\r\n]/g, '');
    }
  });
  const envContent = Object.keys(map).map(k => `${k}=${map[k]}`).join('\n') + '\n';
  fs.writeFileSync(envPath, envContent);
}

function parseEnv(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const map = {};
  content.split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) map[line.substring(0, idx).trim()] = line.substring(idx + 1);
  });
  return map;
}

describe('.env sibling preservation (AC-21)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  const envPath = path.join(tmpDir, '.env');

  afterEach(() => {
    try { fs.unlinkSync(envPath); } catch (e) {}
  });

  it('preserves non-whitelisted keys when writing a single API key', () => {
    // Write initial .env with both whitelisted and non-whitelisted keys
    fs.writeFileSync(envPath, [
      'ANTHROPIC_API_KEY=old-key',
      'RTK_DB_PATH=/custom/path/db.sqlite',
      'FIREBASE_URL=https://example.firebaseio.com',
      'GEMINI_API_KEY=gem-key'
    ].join('\n') + '\n');

    // Update only ANTHROPIC_API_KEY
    writeEnvKey(envPath, 'ANTHROPIC_API_KEY', 'new-key');

    const map = parseEnv(envPath);

    // Whitelisted key updated
    expect(map.ANTHROPIC_API_KEY).toBe('new-key');
    // Other whitelisted key preserved
    expect(map.GEMINI_API_KEY).toBe('gem-key');
    // Non-whitelisted keys preserved
    expect(map.RTK_DB_PATH).toBe('/custom/path/db.sqlite');
    expect(map.FIREBASE_URL).toBe('https://example.firebaseio.com');
  });

  it('preserves non-whitelisted keys when writing bulk env', () => {
    fs.writeFileSync(envPath, [
      'ANTHROPIC_API_KEY=old-key',
      'MY_CUSTOM_VAR=hello',
      'RTK_DB_PATH=/another/path'
    ].join('\n') + '\n');

    writeEnvBulk(envPath, { ANTHROPIC_API_KEY: 'bulk-new', GEMINI_API_KEY: 'gem-new' });

    const map = parseEnv(envPath);

    expect(map.ANTHROPIC_API_KEY).toBe('bulk-new');
    expect(map.GEMINI_API_KEY).toBe('gem-new');
    expect(map.MY_CUSTOM_VAR).toBe('hello');
    expect(map.RTK_DB_PATH).toBe('/another/path');
  });

  it('deletes a key when value is empty string', () => {
    fs.writeFileSync(envPath, [
      'ANTHROPIC_API_KEY=to-delete',
      'RTK_DB_PATH=/keep'
    ].join('\n') + '\n');

    writeEnvKey(envPath, 'ANTHROPIC_API_KEY', '');

    const map = parseEnv(envPath);
    expect(map.ANTHROPIC_API_KEY).toBeUndefined();
    expect(map.RTK_DB_PATH).toBe('/keep');
  });

  it('creates .env from scratch if it does not exist', () => {
    // Ensure no file
    try { fs.unlinkSync(envPath); } catch (e) {}

    writeEnvKey(envPath, 'ANTHROPIC_API_KEY', 'brand-new');

    const map = parseEnv(envPath);
    expect(map.ANTHROPIC_API_KEY).toBe('brand-new');
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  });
});
