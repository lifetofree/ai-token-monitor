const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { parseAllTranscripts } = require('./lib/antigravity-parser');

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

function parseRawJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (e) { return null; }
}

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
          // Write back all keys from the file (not just the whitelist) so non-API
          // keys like RTK_DB_PATH and FIREBASE_* are preserved across saves.
          const allKeys = Object.keys(map);
          const newContent = allKeys.map(k => `${k}=${map[k]}`).join('\n') + '\n';
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
        const envPath = path.join(STATIC_ROOT, '.env');
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

        fs.writeFile(envPath, envContent, (err) => {
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

  // API Endpoint: Get Antigravity CLI transcript/agent usage metrics
  if (req.method === 'GET' && req.url === '/api/agent-usage') {
    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const query = `SELECT 'total' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage UNION ALL SELECT '5h' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage WHERE last_updated >= ${fiveHoursAgo} UNION ALL SELECT 'weekly' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage WHERE last_updated >= ${sevenDaysAgo};`;

    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (error) {
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      try {
        const rows = stdout.trim() ? JSON.parse(stdout) : [];
        const result = {
          total: { conversationsCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, earliestTimestamp: null },
          window5h: { conversationsCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, earliestTimestamp: null },
          weekly: { conversationsCount: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, earliestTimestamp: null }
        };

        rows.forEach(row => {
          const stats = {
            conversationsCount: row.count || 0,
            inputTokens: row.input || 0,
            outputTokens: row.output || 0,
            cachedTokens: row.cached || 0,
            totalCost: row.cost || 0,
            earliestTimestamp: row.earliest || null
          };
          if (row.window === 'total') result.total = stats;
          if (row.window === '5h') result.window5h = stats;
          if (row.window === 'weekly') result.weekly = stats;
        });

        res.end(JSON.stringify(result));
      } catch (e) {
        res.end(JSON.stringify({ error: 'Parse failed' }));
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
  ensureAgentUsageTable();
  syncAgentUsage();
  setInterval(syncAgentUsage, 2 * 60 * 1000); // Sync every 2 minutes
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
    // window_started_at = epoch ms when the 5h window's *current* contents were
    // first observed. Used as a fallback 5h reset boundary for brands whose
    // API doesn't expose nextResetTime on the 5h window (e.g. GLM). The reset
    // is at most window_started_at + 5h; the actual reset is when the oldest
    // request in the window drops out, which we don't have direct visibility
    // into. Persisted across server restarts.
    execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, "ALTER TABLE brand_quota ADD COLUMN window_started_at INTEGER"], () => {});
  });
}

function ensureAgentUsageTable() {
  const query = `CREATE TABLE IF NOT EXISTS agent_usage (
    conversation_id TEXT PRIMARY KEY,
    last_updated INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    total_cost REAL
  );`;
  execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, query], (error) => {
    if (error) {
      console.error('Failed to create agent_usage table:', error);
    }
  });
}

function syncAgentUsage() {
  const data = parseAllTranscripts();
  if (!data || !data.sessions || data.sessions.length === 0) return;

  data.sessions.forEach(session => {
    const query = `INSERT OR REPLACE INTO agent_usage (conversation_id, last_updated, input_tokens, output_tokens, cached_tokens, total_cost) VALUES (
      ${escapeSQLString(session.conversationId)},
      ${escapeSQLNumber(session.lastModified)},
      ${escapeSQLNumber(session.inputTokens)},
      ${escapeSQLNumber(session.outputTokens)},
      ${escapeSQLNumber(session.cachedTokens)},
      ${escapeSQLFloat(session.totalCost)}
    );`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, query], (error) => {
      if (error) {
        console.error(`Failed to sync agent session ${session.conversationId}:`, error);
      }
    });
  });
}

async function seedBrandQuotas(force) {
  const existing = await new Promise((resolve) => {
    const query = "SELECT brand, remaining, limit_value, reset_at, reset_at_weekly, weekly_remaining, unit, raw_json, seeded_at, error, window_started_at FROM brand_quota";
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

    // Existing row from the DB (used to preserve window_started_at when the
    // current fetch's data looks consistent with the previous observation).
    const prev = existing.find(r => r.brand === brand) || null;

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
        window_started_at: null,
        error: `no ${config.envKey} in .env`
      };
    } else {
      try {
        const fetched = await config.fetch(apiKey);
        // 5h-window observation: if the API returned a usable 5h signal
        // (remaining or limit_value is a number), record when we first saw
        // THIS window's contents. If the signal looks consistent with the
        // previous fetch (same remaining within tolerance), preserve the
        // original window_started_at so the countdown keeps ticking down.
        // Otherwise (reset detected: number dropped significantly, or first
        // observation ever), start a fresh window at Date.now().
        let windowStartedAt = prev ? prev.window_started_at : null;
        const hasFreshSignal = fetched && (
          (typeof fetched.remaining === 'number') ||
          (typeof fetched.limit_value === 'number' && fetched.limit_value > 0)
        );
        if (hasFreshSignal) {
          if (windowStartedAt === null || windowStartedAt === undefined) {
            windowStartedAt = Date.now();
          } else if (prev && typeof prev.remaining === 'number' && typeof fetched.remaining === 'number') {
            // If remaining jumped UP significantly (>= 5%), the window reset
            // (oldest request dropped out and a fresh window started).
            if (fetched.remaining - prev.remaining >= 5) {
              windowStartedAt = Date.now();
            }
          }
        } else {
          windowStartedAt = null;
        }
        row = {
          brand,
          remaining: fetched.remaining,
          limit_value: fetched.limit_value,
          reset_at: fetched.reset_at,
          reset_at_weekly: fetched.reset_at_weekly || null,
          weekly_remaining: fetched.weekly_remaining || null,
          unit: fetched.unit,
          raw_json: fetched.rtk_spend
            ? Object.assign({}, fetched.raw_json, { _rtk_spend: fetched.rtk_spend })
            : fetched.raw_json,
          seeded_at: Date.now(),
          window_started_at: windowStartedAt,
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
          window_started_at: null,
          error: err.message
        };
      }
    }

    await new Promise((resolve) => {
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
      execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, sql], (error) => {
        resolve();
      });
    });

    results.push(row);
  }

  // Push to Firebase for ESP32 companion — await so the PUT completes before returning.
  await publishToFirebase(results).catch(e => console.error('[firebase]', e?.message));

  return { cached: false, results, forced: force };
}

// Publishes the quota snapshot to Firebase Realtime Database.
// Payload shape matches firmware/esp32-display/esp32-display.ino expectations:
//   quotas.{brand}: remaining, limit_value, weekly_remaining, unit, reset_at,
//                   reset_at_weekly, error, seeded_at, spend_pct5h,
//                   spend_pct_weekly, spend_reqs5h, spend_reqs_wk,
//                   tokens5h, cost5h, tokens_wk, cost_wk
async function publishToFirebase(results) {
  const env    = loadEnv();
  const dbUrl  = env.FIREBASE_URL  || env.FIREBASE_DB_URL  || process.env.FIREBASE_URL  || process.env.FIREBASE_DB_URL;
  const secret = env.FIREBASE_AUTH || env.FIREBASE_DB_SECRET || process.env.FIREBASE_AUTH || process.env.FIREBASE_DB_SECRET;
  if (!dbUrl || !secret) return;

  const NAMES = { gemini: 'Antigravity', claude: 'Claude', minimax: 'Minimax', glm: 'GLM' };
  const SPEND_LIMITS = {
    gemini:  { limit5h: 2.00,  limitWeekly: 15.00 },
    claude:  { limit5h: 5.00,  limitWeekly: 30.00 },
    minimax: { limit5h: 2.00,  limitWeekly: 15.00 },
    glm:     { limit5h: 0.80,  limitWeekly:  6.00 },
  };

  const allSpend = await getRtkSpendMetrics();
  const agentUsage = await new Promise((resolve) => {
    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const query = `SELECT 'total' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage UNION ALL SELECT '5h' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage WHERE last_updated >= ${fiveHoursAgo} UNION ALL SELECT 'weekly' as window, COUNT(*) as count, COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output, COALESCE(SUM(cached_tokens), 0) as cached, COALESCE(SUM(total_cost), 0.0) as cost, MIN(last_updated) as earliest FROM agent_usage WHERE last_updated >= ${sevenDaysAgo};`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        const rows = JSON.parse(stdout);
        const res = {
          total: { count: 0, input: 0, output: 0, cost: 0, earliest: null },
          window5h: { count: 0, input: 0, output: 0, cost: 0, earliest: null },
          weekly: { count: 0, input: 0, output: 0, cost: 0, earliest: null }
        };
        rows.forEach(row => {
          const stats = { count: row.count || 0, input: row.input || 0, output: row.output || 0, cost: row.cost || 0, earliest: row.earliest || null };
          if (row.window === 'total') res.total = stats;
          if (row.window === '5h') res.window5h = stats;
          if (row.window === 'weekly') res.weekly = stats;
        });
        resolve(res);
      } catch (e) {
        resolve(null);
      }
    });
  });

  const payload = { lastUpdated: Date.now(), quotas: {} };

  for (const r of results) {
    let rtk  = parseRawJson(r.raw_json);
    
    // For GLM, check if raw_json has _rtk_spend
    if (r.brand === 'glm' && rtk && rtk._rtk_spend) {
      rtk = rtk._rtk_spend;
    }

    const lim  = SPEND_LIMITS[r.brand] || { limit5h: 2, limitWeekly: 15 };
    let tok5 = rtk && rtk.tokens5h    ? Math.round(rtk.tokens5h)    : 0;
    let tokW = rtk && rtk.tokensWeekly ? Math.round(rtk.tokensWeekly) : 0;
    let c5   = rtk && rtk.cost5h      ? rtk.cost5h      : 0;
    let cW   = rtk && rtk.costWeekly  ? rtk.costWeekly  : 0;
    let r5   = rtk && rtk.requests5h  ? rtk.requests5h  : 0;
    let rW   = rtk && rtk.requestsWeekly ? rtk.requestsWeekly : 0;

    let resetAt = r.reset_at || 0;
    let resetAtWeekly = r.reset_at_weekly || 0;

    if (r.brand === 'gemini') {
      const rtkGemini = allSpend && allSpend.gemini ? allSpend.gemini : null;
      const agent5hTokens = agentUsage ? (agentUsage.window5h.input + agentUsage.window5h.output) : 0;
      const agentWkTokens = agentUsage ? (agentUsage.weekly.input + agentUsage.weekly.output) : 0;
      const agent5hCost = agentUsage ? agentUsage.window5h.cost : 0.0;
      const agentWkCost = agentUsage ? agentUsage.weekly.cost : 0.0;
      const agent5hCount = agentUsage ? agentUsage.window5h.count : 0;
      const agentWkCount = agentUsage ? agentUsage.weekly.count : 0;

      tok5 = (rtkGemini ? Math.round(rtkGemini.tokens5h) : 0) + agent5hTokens;
      tokW = (rtkGemini ? Math.round(rtkGemini.tokensWeekly) : 0) + agentWkTokens;
      c5   = (rtkGemini ? rtkGemini.cost5h : 0.0) + agent5hCost;
      cW   = (rtkGemini ? rtkGemini.costWeekly : 0.0) + agentWkCost;
      r5   = (rtkGemini ? rtkGemini.requests5h : 0) + agent5hCount;
      rW   = (rtkGemini ? rtkGemini.requestsWeekly : 0) + agentWkCount;

      const agentEarliest5h = agentUsage && agentUsage.window5h.earliest ? agentUsage.window5h.earliest : null;
      const agentEarliestWk = agentUsage && agentUsage.weekly.earliest ? agentUsage.weekly.earliest : null;
      const rtkEarliest5h = rtkGemini && rtkGemini.earliest5hTimestamp ? rtkGemini.earliest5hTimestamp : null;
      const rtkEarliestWk = rtkGemini && rtkGemini.earliestWeeklyTimestamp ? rtkGemini.earliestWeeklyTimestamp : null;

      let earliest5h = null;
      if (agentEarliest5h !== null && rtkEarliest5h !== null) {
        earliest5h = Math.min(agentEarliest5h, rtkEarliest5h);
      } else {
        earliest5h = agentEarliest5h !== null ? agentEarliest5h : rtkEarliest5h;
      }

      let earliestWk = null;
      if (agentEarliestWk !== null && rtkEarliestWk !== null) {
        earliestWk = Math.min(agentEarliestWk, rtkEarliestWk);
      } else {
        earliestWk = agentEarliestWk !== null ? agentEarliestWk : rtkEarliestWk;
      }

      if (earliest5h !== null) {
        resetAt = earliest5h + 5 * 3600 * 1000;
      }
      if (earliestWk !== null) {
        resetAtWeekly = earliestWk + 7 * 24 * 3600 * 1000;
      }
    }

    // Claude: reset_at from Anthropic API is the per-minute token-bucket reset
    // (~1 min away) — useless for the OLED display. Override with RTK rolling
    // window boundaries so the ESP32 shows the same 5h/weekly times as the web.
    if (r.brand === 'claude') {
      const rtkClaude = allSpend && allSpend.claude ? allSpend.claude : null;
      if (rtkClaude && rtkClaude.reset5hAt)     resetAt       = rtkClaude.reset5hAt;
      if (rtkClaude && rtkClaude.resetWeeklyAt) resetAtWeekly = rtkClaude.resetWeeklyAt;
    }

    payload.quotas[r.brand] = {
      name:             NAMES[r.brand] || r.brand,
      remaining:        r.remaining        !== null ? r.remaining        : -1,
      limit_value:      r.limit_value      !== null ? r.limit_value      : -1,
      weekly_remaining: r.weekly_remaining !== null ? r.weekly_remaining : -1,
      unit:             r.unit             || 'not_exposed',
      reset_at:         resetAt,
      reset_at_weekly:  resetAtWeekly,
      error:            r.error            || '',
      seeded_at:        r.seeded_at        || Date.now(),
      spend_pct5h:      tok5 > 0 ? Math.min(100, Math.round((c5  / lim.limit5h)     * 100)) : 0,
      spend_pct_weekly: tokW > 0 ? Math.min(100, Math.round((cW  / lim.limitWeekly) * 100)) : 0,
      spend_reqs5h:     r5,
      spend_reqs_wk:    rW,
      tokens5h:         tok5,
      cost5h:           parseFloat(c5.toFixed(4)),
      tokens_wk:        tokW,
      cost_wk:          parseFloat(cW.toFixed(4)),
    };
  }

  const firebaseUrl = `${dbUrl.replace(/\/$/, '')}/display.json?auth=${encodeURIComponent(secret)}`;
  const res = await fetch(firebaseUrl, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(8000),
  });
  if (!res.ok) console.error(`[firebase] PUT ${res.status}`);
}

function getRtkSpendMetrics() {
  return new Promise((resolve) => {
    const query = `SELECT timestamp, original_cmd, input_tokens, output_tokens, saved_tokens FROM commands ORDER BY id ASC`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({});
        return;
      }
      try {
        const rows = JSON.parse(stdout);
        const METADATA = {
          gemini: { inputCost: 1.25, outputCost: 5.00 },
          claude: { inputCost: 3.00, outputCost: 15.00 },
          minimax: { inputCost: 1.00, outputCost: 4.00 },
          glm: { inputCost: 0.50, outputCost: 2.00 }
        };

        const now = Date.now();
        const limit5h = 5 * 3600 * 1000;
        const limitWk = 7 * 24 * 3600 * 1000;

        const spend = {};
        Object.keys(METADATA).forEach(key => {
          spend[key] = {
            cost5h: 0,
            costWeekly: 0,
            requests5h: 0,
            requestsWeekly: 0,
            input5h: 0,
            inputWeekly: 0,
            output5h: 0,
            outputWeekly: 0,
            savedTokens5h: 0,
            savedTokensWeekly: 0,
            tokens5h: 0,
            tokensWeekly: 0,
            earliest5hTimestamp: null,
            earliestWeeklyTimestamp: null
          };
        });

        // Explicit-match only — no lastLlmBrand fallback.
        // Commands that don't match Gemini/MiniMax/GLM patterns are Claude tool
        // calls (Claude Code shell interceptions). This stays correct when multiple
        // providers are active (e.g. after `rtk init --gemini`).
        function detectSpecificBrand(cmd) {
          if (!cmd || typeof cmd !== 'string') return 'claude'; // unmatched = Claude
          const c = cmd.toLowerCase();
          if (c.includes('gemini-proxy:') || c.includes('generativelanguage.googleapis.com') || c.includes('google-generative')) return 'gemini';
          if (c.includes('minimax')) return 'minimax';
          if (c.includes('glm') || c.includes('zhipu')) return 'glm';
          return 'claude'; // everything else is a Claude Code tool call
        }

        rows.forEach(row => {
          const brandKey = detectSpecificBrand(row.original_cmd);
          const meta = METADATA[brandKey];
          if (!meta) return;

          const ts = new Date(row.timestamp).getTime();
          if (isNaN(ts)) return;
          const age = now - ts;
          if (age < 0) return;

          const cost = ((row.input_tokens * meta.inputCost) + (row.output_tokens * meta.outputCost)) / 1000000;
          const s = spend[brandKey];

          if (age <= limit5h) {
            s.cost5h += cost;
            s.requests5h++;
            s.input5h += row.input_tokens || 0;
            s.output5h += row.output_tokens || 0;
            s.savedTokens5h += row.saved_tokens || 0;
            s.tokens5h += (row.input_tokens || 0) + (row.output_tokens || 0) + (row.saved_tokens || 0);
            if (s.earliest5hTimestamp === null || ts < s.earliest5hTimestamp) {
              s.earliest5hTimestamp = ts;
            }
          }

          if (age <= limitWk) {
            s.costWeekly += cost;
            s.requestsWeekly++;
            s.inputWeekly += row.input_tokens || 0;
            s.outputWeekly += row.output_tokens || 0;
            s.savedTokensWeekly += row.saved_tokens || 0;
            s.tokensWeekly += (row.input_tokens || 0) + (row.output_tokens || 0) + (row.saved_tokens || 0);
            if (s.earliestWeeklyTimestamp === null || ts < s.earliestWeeklyTimestamp) {
              s.earliestWeeklyTimestamp = ts;
            }
          }
        });

        // Add reset timestamps
        Object.keys(spend).forEach(key => {
          const s = spend[key];
          s.reset5hAt = s.earliest5hTimestamp ? s.earliest5hTimestamp + limit5h : null;
          s.resetWeeklyAt = s.earliestWeeklyTimestamp ? s.earliestWeeklyTimestamp + limitWk : null;
        });

        resolve(spend);
      } catch (e) {
        console.error('Failed to parse RTK spend metrics:', e);
        resolve({});
      }
    });
  });
}

function fetchClaudeQuota(apiKey) {
  // Run the Anthropic API probe (for per-minute token bucket headers) and the
  // RTK DB aggregation in parallel. RTK stats are stored in raw_json so the
  // dashboard card gets Claude usage data even when the API key has zero credit.
  const apiPromise = new Promise((resolve) => {
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

        // Anthropic exposes per-MINUTE token rate limits via response headers.
        // We read the token bucket (tokens-remaining/limit/reset) and tag the unit as
        // 'per_minute' so the UI labels the bar "Per Minute" rather than "5-Hour".
        // reset_at carries the per-minute window boundary so the reset badge is accurate.
        const remaining = parseInt(res.headers['anthropic-ratelimit-tokens-remaining'], 10);
        const limitVal = parseInt(res.headers['anthropic-ratelimit-tokens-limit'], 10);
        const resetHeader = res.headers['anthropic-ratelimit-tokens-reset'];
        const resetMs = resetHeader ? new Date(resetHeader).getTime() : null;

        resolve({
          remaining: isNaN(remaining) ? null : remaining,
          limit_value: isNaN(limitVal) ? null : limitVal,
          reset_at: (resetMs && !isNaN(resetMs)) ? resetMs : null,
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

  return Promise.all([apiPromise, getRtkSpendMetrics()])
    .then(([apiResult, allSpend]) => {
      const rtkClaude = allSpend && allSpend.claude ? allSpend.claude : null;
      return { ...apiResult, raw_json: rtkClaude };
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
  // Also fetches RTK spend metrics so the dashboard can show cost,
  // token counts, and reset times from the RTK database alongside
  // the percentage-based quota API data.
  const apiPromise = new Promise((resolve) => {
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

  return Promise.all([apiPromise, getRtkSpendMetrics()])
    .then(([apiResult, allSpend]) => {
      const rtkGlm = allSpend && allSpend.glm ? allSpend.glm : null;
      return { ...apiResult, rtk_spend: rtkGlm };
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
          weeklyEntry = entries.find(e => e !== primary && isWeeklyEntry(e, sevenD_MS)) || null;
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

function isWeeklyEntry(entry, sevenD_MS) {
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
