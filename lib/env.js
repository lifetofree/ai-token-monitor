// lib/env.js
// .env file I/O: load, mask, read, write. Preserves non-whitelisted keys.
// Only the four provider API keys in ALLOWED_KEYS are ever exposed to the
// browser (masked). Other keys (FIREBASE_*, WIFI_*, RTK_DB_PATH, etc.) are
// read/written on the server but never serialised to the client.
'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED_KEYS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY'];

function maskSecret(val) {
  if (!val) return '';
  if (val.length <= 8) return '****';
  return '****' + val.slice(-4);
}

function loadEnv(envDir) {
  const env = {};
  try {
    const envPath = path.join(envDir, '.env');
    if (fs.existsSync(envPath)) {
      const data = fs.readFileSync(envPath, 'utf8');
      data.split('\n').forEach(line => {
        const index = line.indexOf('=');
        if (index > 0) {
          const key = line.substring(0, index).trim();
          const val = line.substring(index + 1).trim();
          env[key] = val;
        }
      });
    }
  } catch (e) {}
  return env;
}

function parseEnvMap(content) {
  const map = {};
  (content || '').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) map[line.substring(0, idx).trim()] = line.substring(idx + 1);
  });
  return map;
}

function writeEnvMap(envPath, map) {
  const content = Object.keys(map).map(k => `${k}=${map[k]}`).join('\n') + '\n';
  fs.writeFileSync(envPath, content);
}

function handleGetEnv(req, res, envDir) {
  fs.readFile(path.join(envDir, '.env'), 'utf8', (err, data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Always return an object keyed by the four provider keys, so the
    // browser's "API Tokens" tab sees a stable shape. Non-whitelisted keys
    // (FIREBASE_*, WIFI_*, RTK_DB_PATH, …) are never serialised to the
    // client — even masked, their tails must not leak. Missing keys are "".
    const env = {};
    ALLOWED_KEYS.forEach(k => { env[k] = ''; });
    if (err) {
      res.end(JSON.stringify(env));
      return;
    }
    data.split('\n').forEach(line => {
      const index = line.indexOf('=');
      if (index > 0) {
        const key = line.substring(0, index).trim();
        if (ALLOWED_KEYS.includes(key)) {
          const val = line.substring(index + 1).trim();
          env[key] = maskSecret(val);
        }
      }
    });
    res.end(JSON.stringify(env));
  });
}

function handlePostEnvKey(req, res, envDir) {
  const urlObj = new URL(req.url, `http://localhost:3838`);
  const keyName = urlObj.searchParams.get('key');
  if (!ALLOWED_KEYS.includes(keyName)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unknown key' }));
    return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { value } = JSON.parse(body);
      if (typeof value !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'value must be a string' }));
        return;
      }
      const sanitized = value.replace(/[\r\n]/g, '');
      const envPath = path.join(envDir, '.env');
      fs.readFile(envPath, 'utf8', (readErr, existing) => {
        const map = parseEnvMap(existing);
        if (sanitized === '') {
          delete map[keyName];
        } else {
          map[keyName] = sanitized;
        }
        writeEnvMap(envPath, map);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, masked: maskSecret(sanitized) }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
    }
  });
}

function handlePostEnv(req, res, envDir) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const keys = JSON.parse(body);
      const envPath = path.join(envDir, '.env');
      const existing = (() => { try { return fs.readFileSync(envPath, 'utf8'); } catch (e) { return ''; } })();
      const map = parseEnvMap(existing);
      ALLOWED_KEYS.forEach(k => {
        if (keys[k] && typeof keys[k] === 'string') {
          map[k] = keys[k].replace(/[\r\n]/g, '');
        }
      });
      writeEnvMap(envPath, map);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
    }
  });
}

module.exports = { loadEnv, maskSecret, handleGetEnv, handlePostEnvKey, handlePostEnv, ALLOWED_KEYS };
