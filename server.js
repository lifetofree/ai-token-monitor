const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { parseAllTranscripts } = require('./lib/antigravity-parser');
const { BRAND_FETCHERS } = require('./lib/brand-fetchers');
const { getRtkSpendMetrics } = require('./lib/rtk-metrics');
const { publishToFirebase } = require('./lib/firebase');

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

// mtimeMs of each transcript file seen on the last sync — skip unchanged files.
const _agentMtimeCache = new Map();

function syncAgentUsage() {
  const data = parseAllTranscripts();
  if (!data || !data.sessions || data.sessions.length === 0) return;

  data.sessions.forEach(session => {
    if (_agentMtimeCache.get(session.conversationId) === session.lastModified) return;

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
      } else {
        _agentMtimeCache.set(session.conversationId, session.lastModified);
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
  const rtkSpend = await getRtkSpendMetrics();
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
        const fetched = await config.fetch(apiKey, rtkSpend);
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
  await publishToFirebase(results, env, rtkSpend).catch(e => console.error('[firebase]', e?.message));

  return { cached: false, results, forced: force };
}

// publishToFirebase, getRtkSpendMetrics, httpsRequest, and all brand fetchers
// live in lib/firebase.js, lib/rtk-metrics.js, and lib/brand-fetchers.js.
