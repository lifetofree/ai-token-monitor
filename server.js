const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

const PORT = 3000;
const STATIC_ROOT = path.resolve(__dirname);

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml'
};

const homeDir = process.env.HOME || '/Users/lifetofree';
const DB_PATH = process.env.RTK_DB_PATH || path.join(homeDir, 'Library/Application Support/rtk/history.db');

let sseClients = [];
let lastSeenDbId = 0;

// Mask secrets before sending to the browser — never expose full keys in JS memory/DOM.
function maskSecret(val) {
  if (!val) return '';
  if (val.length <= 8) return '****';
  return '****' + val.slice(-4);
}

const server = http.createServer((req, res) => {
  // CORS: restrict to localhost only — prevents third-party sites from reading API keys
  const origin = req.headers.origin || '';
  if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
    res.setHeader('Access-Control-Allow-Origin', origin || `http://localhost:${PORT}`);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API Endpoint: Get RTK Database Commands
  // Supports ?since=<id> for incremental fetches. Caps at 1000 rows to prevent OOM on large DBs.
  if (req.method === 'GET' && req.url.startsWith('/api/rtk') && !req.url.startsWith('/api/rtk/')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const sinceId = parseInt(urlObj.searchParams.get('since') || '0', 10) || 0;
    const whereClause = sinceId > 0 ? `WHERE id > ${sinceId}` : '';
    const query = `SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms FROM commands ${whereClause} ORDER BY id ASC LIMIT 1000`;

    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (error) {
        res.end(JSON.stringify({ error: error.message, commands: [] }));
        return;
      }
      try {
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        res.end(JSON.stringify({ commands: parsed }));
      } catch (e) {
        res.end(JSON.stringify({ error: 'Parse failed', commands: [], raw: stdout }));
      }
    });
    return;
  }

  // API Endpoint: Get aggregate summary from RTK DB (matches `rtk gain` output)
  if (req.method === 'GET' && req.url === '/api/rtk/summary') {
    const query = "SELECT COUNT(*) as total_commands, COALESCE(SUM(input_tokens),0) as total_input, COALESCE(SUM(output_tokens),0) as total_output, COALESCE(SUM(saved_tokens),0) as total_saved, COALESCE(SUM(exec_time_ms),0) as total_exec_ms FROM commands";

    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (error) {
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      try {
        const rows = stdout.trim() ? JSON.parse(stdout) : [{}];
        res.end(JSON.stringify(rows[0] || {}));
      } catch (e) {
        res.end(JSON.stringify({ error: 'Parse failed' }));
      }
    });
    return;
  }

  // API Endpoint: Server-Sent Events stream for Real-Time updates
  if (req.method === 'GET' && req.url === '/api/rtk/stream') {
    const allowedSseOrigin = (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))
      ? (origin || `http://localhost:${PORT}`)
      : null;
    if (!allowedSseOrigin) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': allowedSseOrigin
    });
    
    // Heartbeat handshake
    res.write('data: {"status":"connected"}\n\n');
    sseClients.push(res);
    
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // API Endpoint: Get Current .env Configurations (masked)
  if (req.method === 'GET' && req.url === '/api/env') {
    fs.readFile(path.join(STATIC_ROOT, '.env'), 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (err) {
        res.end(JSON.stringify({}));
        return;
      }
      const env = {};
      data.split('\n').forEach(line => {
        const index = line.indexOf('=');
        if (index > 0) {
          const key = line.substring(0, index).trim();
          const val = line.substring(index + 1).trim();
          // Return masked value to prevent full key exposure in browser DOM/JS memory
          env[key] = maskSecret(val);
        }
      });
      res.end(JSON.stringify(env));
    });
    return;
  }

  // API Endpoint: Save API key for a specific provider
  // Frontend reads masked value back, user types full key to overwrite.
  if (req.method === 'POST' && req.url.startsWith('/api/env/key')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const keyName = urlObj.searchParams.get('key');
    const ALLOWED_KEYS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY'];
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
        // Read existing .env, update only the requested key, preserve others
        const envPath = path.join(STATIC_ROOT, '.env');
        fs.readFile(envPath, 'utf8', (readErr, existing) => {
          const lines = existing ? existing.split('\n') : [];
          const map = {};
          lines.forEach(line => {
            const idx = line.indexOf('=');
            if (idx > 0) map[line.substring(0, idx).trim()] = line.substring(idx + 1);
          });
          if (sanitized === '') {
            delete map[keyName];
          } else {
            map[keyName] = sanitized;
          }
          const newContent = ALLOWED_KEYS.filter(k => map[k] !== undefined).map(k => `${k}=${map[k]}`).join('\n') + '\n';
          fs.writeFile(envPath, newContent, (writeErr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (writeErr) {
              res.end(JSON.stringify({ success: false, error: writeErr.message }));
              return;
            }
            res.end(JSON.stringify({ success: true, masked: maskSecret(sanitized) }));
          });
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // API Endpoint: Write and Update .env Configurations
  if (req.method === 'POST' && req.url === '/api/env') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const keys = JSON.parse(body);
        const ALLOWED_KEYS = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY'];
        let envContent = '';
        ALLOWED_KEYS.forEach(k => {
          if (keys[k] && typeof keys[k] === 'string') {
            // Strip newlines to prevent .env injection
            const sanitized = keys[k].replace(/[\r\n]/g, '');
            envContent += `${k}=${sanitized}\n`;
          }
        });

        fs.writeFile(path.join(STATIC_ROOT, '.env'), envContent, (err) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (err) {
            res.end(JSON.stringify({ success: false, error: err.message }));
            return;
          }
          res.end(JSON.stringify({ success: true }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // API Endpoint: Get brand quotas from DB
  if (req.method === 'GET' && req.url === '/api/seed-quotas') {
    // Route the read through seedBrandQuotas() so the cache-invalidation
    // logic (reset_at expiry, 3-min maxAge for short-window providers like
    // MiniMax) actually runs. Without this hop, the GET path would return
    // stale rows indefinitely and the dashboard would never see fresh data.
    seedBrandQuotas(false).then((out) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, cached: out.cached, quotas: out.results }));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // API Endpoint: Force seed/refresh brand quotas
  if (req.method === 'POST' && req.url === '/api/seed-quotas') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = body.trim() ? JSON.parse(body) : {};
        const force = !!parsed.force;
        const out = await seedBrandQuotas(force);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...out }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Static Assets Handler — path traversal protected AND whitelisted
  const urlPath = req.url === '/' ? 'index.html' : req.url.split('?')[0];
  const filePath = path.resolve(STATIC_ROOT, urlPath.replace(/^\/+/, ''));
  const relative = path.relative(STATIC_ROOT, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<h1>403 Forbidden</h1>');
    return;
  }

  // Whitelist: only these files are servable. Prevents accidental leak of .env, package.json, server.js, etc.
  const ALLOWED_STATIC = new Set(['index.html', 'app.js', 'styles.css', 'package.json', 'favicon.svg']);
  if (!ALLOWED_STATIC.has(relative)) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 Not Found</h1>', 'utf-8');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'text/plain';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end('Server Error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

function initWatcher() {
  // Sync the lastSeenDbId on startup to prevent broadcasting past history
  const query = "SELECT id FROM commands ORDER BY id DESC LIMIT 1";
  execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
    if (!error && stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.length > 0) {
          lastSeenDbId = parsed[0].id;
        }
      } catch (e) {}
    }
  });

  const dbDir = path.dirname(DB_PATH);
  let watchTimeout = null;

  if (fs.existsSync(dbDir)) {
    fs.watch(dbDir, (eventType, filename) => {
      if (filename && filename.startsWith('history.db')) {
        // Debounce database read by 300ms to allow SQLite write locks to release
        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = setTimeout(checkForNewCommands, 300);
      }
    });
  }
}

function checkForNewCommands() {
  const query = `SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms FROM commands WHERE id > ${lastSeenDbId} ORDER BY id ASC`;
  execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
    if (error || !stdout.trim()) return;
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.length > 0) {
        parsed.forEach(cmd => {
          lastSeenDbId = Math.max(lastSeenDbId, cmd.id);
          const payload = JSON.stringify(cmd);
          sseClients.forEach(client => {
            client.write(`data: ${payload}\n\n`);
          });
        });
      }
    } catch (e) {}
  });
}

server.listen(PORT, () => {
  console.log(`AI Token Monitor running at http://localhost:${PORT}/`);
  initWatcher();
  ensureBrandQuotaTable();
  seedBrandQuotas(false).then(out => {
    console.log(`Brand-quota seed (${out.cached ? 'cached' : 'fetched'}): ${out.results.length} records`);
  }).catch(err => {
    console.error('Initial brand-quota seed failed:', err);
  });

  try {
    const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${startCmd} http://localhost:${PORT}`);
  } catch (e) {
    // Ignore opening errors
  }
});

function loadEnv() {
  const env = {};
  try {
    const envPath = path.join(STATIC_ROOT, '.env');
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

function escapeSQLString(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function escapeSQLNumber(val) {
  if (val === null || val === undefined || isNaN(val)) return 'NULL';
  return parseInt(val, 10);
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
  });
}

async function seedBrandQuotas(force) {
  const existing = await new Promise((resolve) => {
    const query = "SELECT brand, remaining, limit_value, reset_at, reset_at_weekly, weekly_remaining, unit, raw_json, seeded_at, error FROM brand_quota";
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([]);
      } else {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve([]);
        }
      }
    });
  });

  if (!force) {
    let allValid = existing.length >= Object.keys(BRAND_FETCHERS).length;
    const recent = [];
    for (const r of existing) {
      if (!r.seeded_at) {
        allValid = false;
        break;
      }
      // Invalidate cache when EITHER provider reset window has elapsed.
      if (r.reset_at && Date.now() >= r.reset_at) {
        allValid = false;
        break;
      }
      if (r.reset_at_weekly && Date.now() >= r.reset_at_weekly) {
        allValid = false;
        break;
      }
      // Shorter cache for fast-reset providers (5h windows expire fast).
      // MiniMax quota changes every few minutes; refresh every 3 min.
      const maxAge = (r.reset_at || r.reset_at_weekly) ? (3 * 60 * 1000) : (60 * 1000);
      if (Date.now() - r.seeded_at >= maxAge) {
        allValid = false;
        break;
      }
      recent.push(r);
    }
    if (allValid && recent.length >= Object.keys(BRAND_FETCHERS).length) {
      return { cached: true, results: recent, forced: false };
    }
  }

  const env = loadEnv();
  const results = [];

  for (const brand of Object.keys(BRAND_FETCHERS)) {
    const config = BRAND_FETCHERS[brand];
    const apiKey = env[config.envKey];

    let row;
    if (!apiKey) {
      row = {
        brand,
        remaining: null,
        limit_value: null,
        reset_at: null,
        reset_at_weekly: null,
        weekly_remaining: null,
        unit: 'missing_key',
        raw_json: null,
        seeded_at: Date.now(),
        error: `no ${config.envKey} in .env`
      };
    } else {
      try {
        const fetched = await config.fetch(apiKey);
        row = {
          brand,
          remaining: fetched.remaining,
          limit_value: fetched.limit_value,
          reset_at: fetched.reset_at,
          reset_at_weekly: fetched.reset_at_weekly || null,
          weekly_remaining: fetched.weekly_remaining || null,
          unit: fetched.unit,
          raw_json: fetched.raw_json,
          seeded_at: Date.now(),
          error: fetched.error
        };
      } catch (err) {
        row = {
          brand,
          remaining: null,
          limit_value: null,
          reset_at: null,
          reset_at_weekly: null,
          weekly_remaining: null,
          unit: 'error',
          raw_json: null,
          seeded_at: Date.now(),
          error: err.message
        };
      }
    }

    await new Promise((resolve) => {
      const sql = `INSERT OR REPLACE INTO brand_quota (brand, remaining, limit_value, reset_at, reset_at_weekly, weekly_remaining, unit, raw_json, seeded_at, error) VALUES (
        ${escapeSQLString(row.brand)},
        ${escapeSQLNumber(row.remaining)},
        ${escapeSQLNumber(row.limit_value)},
        ${escapeSQLNumber(row.reset_at)},
        ${escapeSQLNumber(row.reset_at_weekly)},
        ${escapeSQLNumber(row.weekly_remaining)},
        ${escapeSQLString(row.unit)},
        ${escapeSQLString(row.raw_json ? JSON.stringify(row.raw_json) : null)},
        ${row.seeded_at},
        ${escapeSQLString(row.error)}
      );`;
      execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, sql], (error) => {
        resolve();
      });
    });

    results.push(row);
  }

  return { cached: false, results, forced: force };
}

function fetchClaudeQuota(apiKey) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let errorMsg = null;
        if (res.statusCode >= 400) {
          try {
            const parsed = JSON.parse(body);
            errorMsg = (parsed.error && parsed.error.message) ? parsed.error.message : `HTTP ${res.statusCode}`;
          } catch (e) {
            errorMsg = `HTTP ${res.statusCode}`;
          }
        }

        // Anthropic exposes per-MINUTE request rate limits, not 5h/weekly window quotas.
        // Store the count data for informational use but tag unit as 'per_minute' so
        // computeApiUsedPct (which handles 'percent' and 'requests') ignores it and the
        // 5h/weekly bars fall back to local rolling-spend. reset_at is the per-minute
        // boundary — nulled out so it never replaces the 5h rolling-window reset label.
        const remaining = parseInt(res.headers['anthropic-ratelimit-requests-remaining'], 10);
        const limitVal = parseInt(res.headers['anthropic-ratelimit-requests-limit'], 10);

        resolve({
          remaining: isNaN(remaining) ? null : remaining,
          limit_value: isNaN(limitVal) ? null : limitVal,
          reset_at: null,
          unit: 'per_minute',
          raw_json: res.headers,
          error: errorMsg
        });
      });
    });

    req.on('error', (e) => {
      resolve({
        remaining: null,
        limit_value: null,
        reset_at: null,
        unit: 'requests',
        raw_json: null,
        error: e.message
      });
    });

    req.write(postData);
    req.end();
  });
}

function fetchGeminiQuota(apiKey) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      contents: [{ parts: [{ text: '.' }] }]
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          let errorMsg = null;
          if (res.statusCode >= 400 || parsed.error) {
            errorMsg = (parsed.error && parsed.error.message) ? parsed.error.message : `HTTP ${res.statusCode}`;
          }
          // The Gemini fetcher is best-effort — quota is not exposed; raw_json holds the body with usageMetadata
          resolve({
            remaining: null,
            limit_value: null,
            reset_at: null,
            unit: 'not_exposed',
            raw_json: parsed,
            error: errorMsg
          });
        } catch (e) {
          resolve({
            remaining: null,
            limit_value: null,
            reset_at: null,
            unit: 'not_exposed',
            raw_json: { usageMetadata: null, raw: body },
            error: e.message
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        remaining: null,
        limit_value: null,
        reset_at: null,
        unit: 'not_exposed',
        raw_json: null,
        error: e.message
      });
    });

    req.write(postData);
    req.end();
  });
}

function fetchGLMQuota(apiKey) {
  // Uses the Zhipu AI quota monitoring API to get 5-hour token limits
  // with remaining %, used/total tokens, and reset time.
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'bigmodel.cn',
      path: '/api/monitor/usage/quota/limit',
      method: 'GET',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.success || parsed.code !== 200) {
            resolve({
              remaining: null,
              limit_value: null,
              reset_at: null,
              reset_at_weekly: null,
              weekly_remaining: null,
              unit: 'error',
              raw_json: parsed,
              error: parsed.msg || `API code ${parsed.code}`
            });
            return;
          }

          const limits = parsed.data && parsed.data.limits ? parsed.data.limits : [];
          const tokensLimits = limits.filter(l => l.type === 'TOKENS_LIMIT');

          if (tokensLimits.length === 0) {
            resolve({
              remaining: null,
              limit_value: null,
              reset_at: null,
              reset_at_weekly: null,
              weekly_remaining: null,
              unit: 'not_exposed',
              raw_json: parsed,
              error: 'No TOKENS_LIMIT in response'
            });
            return;
          }

          // The API percentage field IS the used percentage (0-100).
          // First TOKENS_LIMIT is the 5-hour window.
          const fiveHour = tokensLimits[0];
          const remainPct = Math.max(0, 100 - fiveHour.percentage);
          const resetAt = fiveHour.nextResetTime || null;

          // Second TOKENS_LIMIT (if present) is the longer window (~weekly).
          let resetAtWeekly = null;
          let weeklyRemaining = null;
          if (tokensLimits.length > 1) {
            const weekly = tokensLimits[1];
            weeklyRemaining = Math.max(0, 100 - weekly.percentage);
            resetAtWeekly = weekly.nextResetTime || null;
          }

          resolve({
            remaining: remainPct,
            limit_value: 100,
            reset_at: resetAt,
            reset_at_weekly: resetAtWeekly,
            weekly_remaining: weeklyRemaining,
            unit: 'percent',
            raw_json: parsed,
            error: null
          });
        } catch (e) {
          resolve({
            remaining: null,
            limit_value: null,
            reset_at: null,
            reset_at_weekly: null,
            weekly_remaining: null,
            unit: 'error',
            raw_json: body.substring(0, 500),
            error: e.message
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        remaining: null,
        limit_value: null,
        reset_at: null,
        reset_at_weekly: null,
        weekly_remaining: null,
        unit: 'error',
        raw_json: null,
        error: e.message
      });
    });

    req.end();
  });
}

function fetchMinimaxQuota(apiKey) {
  // MiniMax Token Plan remains endpoint (international). Returns 5-hour and
  // weekly rolling-window quota for the user's coding plan subscription key.
  // API key may be a standard MiniMax Open Platform key or a subscription key.
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.minimax.io',
      path: '/v1/token_plan/remains',
      method: 'GET',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'accept': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = body.trim() ? JSON.parse(body) : null; } catch (e) {}

        if (res.statusCode >= 400) {
          const errMsg = (parsed && parsed.base_resp && parsed.base_resp.status_msg)
            ? parsed.base_resp.status_msg
            : (parsed && parsed.message) ? parsed.message : `HTTP ${res.statusCode}`;
          resolve({
            remaining: null,
            limit_value: null,
            reset_at: null,
            reset_at_weekly: null,
            weekly_remaining: null,
            unit: 'error',
            raw_json: parsed || body,
            error: errMsg
          });
          return;
        }

        if (!parsed) {
          resolve({
            remaining: null,
            limit_value: null,
            reset_at: null,
            reset_at_weekly: null,
            weekly_remaining: null,
            unit: 'error',
            raw_json: body,
            error: 'empty response'
          });
          return;
        }

        // The API may wrap the array in different containers. Try common paths.
        const candidates = []
          .concat(Array.isArray(parsed) ? [{ model_remains: parsed }] : [])
          .concat(parsed.model_remains || [])
          .concat(parsed.data && parsed.data.model_remains || [])
          .concat(parsed.remains || [])
          .concat(parsed.data && parsed.data.remains || []);
        // Normalize into [entry, ...] of windowed records.
        const entries = [];
        for (const c of candidates) {
          if (Array.isArray(c)) entries.push(...c);
          else if (c && typeof c === 'object') entries.push(c);
        }

        // Pick the chat-model entry first (M3 / M2.x), fall back to first entry.
        const chatPick = entries.find(e => /M3|M2\.7|M2\.5|M2\b/i.test(String(e.model_name || e.model || '')));
        const primary = chatPick || entries[0];

        const fiveH_MS = 5 * 60 * 60 * 1000;
        const sevenD_MS = 7 * 24 * 60 * 60 * 1000;

        // Identify a separate weekly window if the response exposes one.
        let weeklyEntry = null;
        if (entries.length > 1) {
          weeklyEntry = entries.find(e => e !== primary && isWeeklyEntry(e, fiveH_MS, sevenD_MS)) || null;
        }
        if (!weeklyEntry && primary && primary.end_time && primary.start_time) {
          const startMs = toEpochMs(primary.start_time);
          const endMs = toEpochMs(primary.end_time);
          if (startMs && endMs && (endMs - startMs) > fiveH_MS * 2) {
            // Primary window itself is longer than 5h — treat as weekly.
            weeklyEntry = primary;
          }
        }

        const resetAtWeekly = weeklyEntry
          ? extractEndTime(weeklyEntry)
          : (primary ? extractWeeklyEndTime(primary) : null);

        // Detect unit: MiniMax returns percent fields (0-100) rather than
        // a hard count cap, so we synthesize limit_value=100 in that mode
        // and tag the unit so the UI can render "% left" instead of "N / M".
        const isPercent = primary && (
          typeof primary.current_interval_remaining_percent === 'number' ||
          typeof primary.usage_percent === 'number' ||
          typeof primary.usagePercent === 'number'
        );
        const hasCount = primary && extractLimit(primary) > 0;
        const unit = !primary ? 'not_exposed' : (isPercent && !hasCount ? 'percent' : (hasCount ? 'requests' : 'not_exposed'));
        const limitValue = primary ? (extractLimit(primary) || (isPercent ? 100 : null)) : null;

        resolve({
          remaining: primary ? extractRemaining(primary) : null,
          limit_value: limitValue,
          reset_at: (primary && weeklyEntry !== primary) ? extractEndTime(primary) : null,
          reset_at_weekly: resetAtWeekly,
          weekly_remaining: primary ? extractWeeklyRemaining(primary) : null,
          unit,
          raw_json: parsed,
          error: null
        });
      });
    });

    req.on('error', (e) => {
      resolve({
        remaining: null,
        limit_value: null,
        reset_at: null,
        reset_at_weekly: null,
        weekly_remaining: null,
        unit: 'error',
        raw_json: null,
        error: e.message
      });
    });

    req.end();
  });
}

function toEpochMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // seconds vs ms heuristic
  const parsed = Date.parse(v);
  return isNaN(parsed) ? null : parsed;
}

function isWeeklyEntry(entry, fiveH_MS, sevenD_MS) {
  const startMs = toEpochMs(entry.start_time);
  const endMs = toEpochMs(entry.end_time);
  if (!startMs || !endMs) return false;
  const delta = endMs - startMs;
  return delta >= sevenD_MS / 2 && delta <= sevenD_MS * 2;
}

function pickField(obj, ...keys) {
  for (const k of keys) {
    if (obj != null && obj[k] != null) return obj[k];
  }
  return null;
}

function extractRemaining(entry) {
  return pickField(entry,
    'current_interval_remaining_percent',
    'current_remaining_percent',
    'current_remaining_count',
    'current_interval_remaining_count',
    'current_window_remaining_count',
    'remaining_count',
    'usage_percent',
    'usagePercent'
  );
}

function extractWeeklyRemaining(entry) {
  return pickField(entry,
    'current_weekly_remaining_percent',
    'current_week_remaining_percent',
    'weekly_remaining_percent',
    'weekly_remaining_count'
  );
}

function extractLimit(entry) {
  return pickField(entry,
    'current_interval_total_count',
    'current_window_quota_count',
    'window_quota_count',
    'quota_count',
    'total_count',
    'limit',
    'quota'
  );
}

function extractEndTime(entry) {
  return toEpochMs(pickField(entry, 'end_time', 'current_end_time', 'reset_at', 'interval_end_time'));
}

function extractWeeklyEndTime(entry) {
  return toEpochMs(pickField(entry, 'weekly_end_time', 'current_week_end_time', 'week_end_time'));
}

const BRAND_FETCHERS = {
  claude: { envKey: 'ANTHROPIC_API_KEY', fetch: fetchClaudeQuota },
  gemini: { envKey: 'GEMINI_API_KEY', fetch: fetchGeminiQuota },
  glm: { envKey: 'GLM_API_KEY', fetch: fetchGLMQuota },
  minimax: { envKey: 'MINIMAX_API_KEY', fetch: fetchMinimaxQuota }
};
