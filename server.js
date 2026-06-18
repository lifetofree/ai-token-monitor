process.on('uncaughtException', (e) => { console.error('[FATAL] uncaughtException:', e); });
process.on('unhandledRejection', (e) => { console.error('[UNHANDLED] unhandledRejection:', e); });

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { parseAllTranscripts } = require('./lib/antigravity-parser');
const { BRAND_FETCHERS } = require('./lib/brand-fetchers');
const { getRtkSpendMetrics } = require('./lib/rtk-metrics');
const { publishToFirebase } = require('./lib/firebase');
const { loadEnv, maskSecret, handleGetEnv, handlePostEnvKey, handlePostEnv } = require('./lib/env');
const { DB_PATH, escapeSQLString, escapeSQLNumber, escapeSQLFloat, ensureBrandQuotaTable, readBrandQuotaRows, writeBrandQuotaRow, isCacheValid } = require('./lib/quota-cache');
const { addSseClient, removeSseClient, broadcastToClients, initWatcher } = require('./lib/sse-watcher');

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
    // Initial load: fetch the LATEST 1000 commands (DESC + reverse).
    // Incremental: fetch commands after sinceId (ASC).
    const sortOrder = sinceId > 0 ? 'ASC' : 'DESC';
    const query = `SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path, brand FROM commands ${whereClause} ORDER BY id ${sortOrder} LIMIT 1000`;

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

  // API Endpoint: Per-project 7-day spend breakdown
  if (req.method === 'GET' && req.url === '/api/rtk/projects') {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    // Return all projects with a non-empty project_path. Brand is resolved
    // client-side via detectBrand(original_cmd) when the column is empty.
    // We return a sample original_cmd per group so the client can attribute brand.
    const query = `SELECT project_path AS project, brand, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(saved_tokens) AS saved_tokens, (SELECT original_cmd FROM commands c2 WHERE c2.project_path = commands.project_path AND c2.brand = commands.brand AND c2.timestamp >= ${escapeSQLString(sevenDaysAgo)} AND (c2.input_tokens > 0 OR c2.output_tokens > 0) LIMIT 1) AS sample_cmd FROM commands WHERE timestamp >= ${escapeSQLString(sevenDaysAgo)} AND project_path != '' GROUP BY project_path, brand ORDER BY project_path, brand`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query], (error, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (error || !stdout.trim()) {
        res.end(JSON.stringify({ projects: [] }));
        return;
      }
      try { res.end(JSON.stringify({ projects: JSON.parse(stdout) })); }
      catch (e) { res.end(JSON.stringify({ projects: [] })); }
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
    addSseClient(res);
    
    req.on('close', () => {
      removeSseClient(res);
    });
    return;
  }

  // API Endpoint: Ingest a single RTK-shaped command from a non-RTK client
  // (e.g. another project on this machine that wants its LLM usage to count
  // toward this dashboard). Mirrors the RTK `commands` schema 1:1 and
  // broadcasts the new row to all SSE clients so the live dashboard updates
  // within ~1 s. No auth — the loopback CORS allowlist is the trust boundary.
  if (req.method === 'POST' && req.url === '/api/rtk/ingest') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try {
        payload = body.trim() ? JSON.parse(body) : {};
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      // Required field
      if (typeof payload.original_cmd !== 'string' || payload.original_cmd.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'original_cmd is required (non-empty string)' }));
        return;
      }

      // Coerce / default. Token counts are non-negative integers; timestamps
      // default to "now" in ISO 8601; savings_pct defaults to the disjoint
      // formula (saved / (input + saved) * 100, or 0 if both are zero).
      const originalCmd = String(payload.original_cmd);
      const inputTokens  = Number.isFinite(payload.input_tokens)  ? Math.max(0, parseInt(payload.input_tokens, 10))  : 0;
      const outputTokens = Number.isFinite(payload.output_tokens) ? Math.max(0, parseInt(payload.output_tokens, 10)) : 0;
      const savedTokens  = Number.isFinite(payload.saved_tokens)  ? Math.max(0, parseInt(payload.saved_tokens, 10))  : 0;
      const execTimeMs   = Number.isFinite(payload.exec_time_ms)  ? Math.max(0, parseInt(payload.exec_time_ms, 10))  : 0;
      const timestamp    = (typeof payload.timestamp === 'string' && payload.timestamp.trim())
        ? payload.timestamp.trim()
        : new Date().toISOString();
      // RTK schema requires NOT NULL on rtk_cmd. Custom ingests have no
      // RTK-side command; default to '' (empty) unless the client supplies
      // one. project_path defaults to '' to match the schema's column default.
      const rtkCmd = (typeof payload.rtk_cmd === 'string') ? payload.rtk_cmd : '';
      const projectPath = (typeof payload.project_path === 'string') ? payload.project_path : '';
      const VALID_BRANDS = ['claude', 'gemini', 'minimax', 'glm'];
      const brandHint = (typeof payload.brand === 'string'
        && VALID_BRANDS.includes(payload.brand.toLowerCase()))
        ? payload.brand.toLowerCase()
        : '';
      const total = inputTokens + savedTokens;
      const savingsPct = Number.isFinite(payload.savings_pct)
        ? Math.max(0, Math.min(100, parseFloat(payload.savings_pct)))
        : (total > 0 ? (savedTokens / total) * 100 : 0);

      // Optional client-supplied id for idempotency. If a row with that id
      // already exists, the INSERT will fail (PK conflict) and we return 409.
      const clientId = Number.isFinite(payload.id) ? parseInt(payload.id, 10) : null;
      const idClause = clientId !== null ? `${clientId}, ` : '';

      const insertSql = `INSERT INTO commands (${idClause}timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path, brand) VALUES (${escapeSQLString(timestamp)}, ${escapeSQLString(originalCmd)}, ${escapeSQLString(rtkCmd)}, ${escapeSQLNumber(inputTokens)}, ${escapeSQLNumber(outputTokens)}, ${escapeSQLNumber(savedTokens)}, ${escapeSQLFloat(savingsPct)}, ${escapeSQLNumber(execTimeMs)}, ${escapeSQLString(projectPath)}, ${escapeSQLString(brandHint)});`;

      execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, insertSql], (insertErr) => {
        if (insertErr) {
          // PK conflict → row already exists
          if (clientId !== null && /UNIQUE constraint failed: commands\.id/i.test(insertErr.message)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Command with this id already exists', id: clientId }));
            return;
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: insertErr.message }));
          return;
        }

        // Read back the inserted row. If the client supplied an id, fetch by
        // id; otherwise look up the last row matching the timestamp + cmd
        // (rare race, but bounded to the just-inserted row in practice).
        const lookupSql = clientId !== null
          ? `SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path, brand FROM commands WHERE id = ${clientId}`
          : `SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path, brand FROM commands WHERE timestamp = ${escapeSQLString(timestamp)} AND original_cmd = ${escapeSQLString(originalCmd)} ORDER BY id DESC LIMIT 1`;

        execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, lookupSql], (lookupErr, lookupStdout) => {
          if (lookupErr || !lookupStdout.trim()) {
            // Insert succeeded but we couldn't read back — return success without broadcast
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, id: clientId, broadcast: false }));
            return;
          }
          try {
            const rows = JSON.parse(lookupStdout);
            const row = rows[0];
            if (row) {
              broadcastToClients(row);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, id: row ? row.id : clientId, command: row || null, broadcast: !!row }));
          } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, id: clientId, broadcast: false }));
          }
        });
      });
    });
    return;
  }

  // API Endpoint: Get Current .env Configurations (masked)
  if (req.method === 'GET' && req.url === '/api/env') {
    handleGetEnv(req, res, STATIC_ROOT);
    return;
  }

  // API Endpoint: Save API key for a specific provider
  if (req.method === 'POST' && req.url.startsWith('/api/env/key')) {
    handlePostEnvKey(req, res, STATIC_ROOT);
    return;
  }

  // API Endpoint: Write and Update .env Configurations
  if (req.method === 'POST' && req.url === '/api/env') {
    handlePostEnv(req, res, STATIC_ROOT);
    return;
  }

  // API Endpoint: Get brand quotas from DB
  if (req.method === 'GET' && req.url === '/api/seed-quotas') {
    // Route the read through seedBrandQuotas() so the cache-invalidation
    // logic (reset_at expiry, 3-min maxAge for short-window providers like
    // MiniMax) actually runs. Without this hop, the GET path would return
    // stale rows indefinitely and the dashboard would never see fresh data.
    seedBrandQuotas(false).then((out) => {
      if (!out.cached) {
        publishToFirebase(out.results, out.env, out.rtkSpend).catch(e => console.error('[firebase]', e?.message));
      }
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
        publishToFirebase(out.results, out.env, out.rtkSpend).catch(e => console.error('[firebase]', e?.message));
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

  // API Endpoint: Diagnostics — self-test for KPI measurement
  if (req.method === 'GET' && req.url === '/api/diagnostics') {
    const now = Date.now();
    const diag = {
      uptime: Math.round(process.uptime()),
      lastRefreshMs: now,
      brandQuotaCacheAgeMs: null,
      brandQuotas: {}
    };
    readBrandQuotaRows().then(rows => {
      for (const r of rows) {
        diag.brandQuotas[r.brand] = {
          cached: !!r.seeded_at,
          ageMs: r.seeded_at ? now - r.seeded_at : null,
          unit: r.unit,
          error: r.error || null
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(diag));
    }).catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(diag));
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
  const ALLOWED_STATIC = new Set(['index.html', 'app.js', 'styles.css', 'package.json', 'favicon.svg', 'lib/pricing-defaults.js', 'lib/format.js', 'lib/dom-utils.js', 'lib/brand-detect.js', 'lib/quota-utils.js']);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Token Monitor running at http://localhost:${PORT}/`);
  initWatcher(DB_PATH);
  ensureBrandQuotaTable();
  ensureBrandColumn();
  ensureAgentUsageTable();
  syncAgentUsage();
  setInterval(syncAgentUsage, 2 * 60 * 1000);
  seedBrandQuotas(false).then(out => {
    console.log(`Brand-quota seed (${out.cached ? 'cached' : 'fetched'}): ${out.results.length} records`);
    publishToFirebase(out.results, out.env, out.rtkSpend).catch(e => console.error('[firebase]', e?.message));
  }).catch(err => {
    console.error('Initial brand-quota seed failed:', err);
  });

  try {
    const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${startCmd} http://localhost:${PORT}`);
  } catch (e) {}
});

function ensureBrandColumn() {
  const query = `ALTER TABLE commands ADD COLUMN brand TEXT DEFAULT '';`;
  execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, query], (error) => {
    if (error && !/duplicate column name/i.test(error.message)) {
      console.error('Failed to add brand column:', error);
    }
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
  const existing = await readBrandQuotaRows();

  if (!force) {
    const cached = isCacheValid(existing, BRAND_FETCHERS);
    if (cached) return { cached: true, results: cached, forced: false };
  }

  const env = loadEnv(STATIC_ROOT);
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
      // No API key — but still include RTK spend data so Firebase/ESP32
      // can display token counts and cost from the local database.
      const brandRtk = rtkSpend[brand] || null;
      row = {
        brand,
        remaining: null,
        limit_value: null,
        reset_at: null,
        reset_at_weekly: null,
        weekly_remaining: null,
        unit: 'missing_key',
        raw_json: brandRtk ? { _rtk_spend: brandRtk } : null,
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

    await writeBrandQuotaRow(row);

    results.push(row);
  }

  return { cached: false, results, forced: force, env, rtkSpend };
}
