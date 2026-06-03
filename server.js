const http = require('http');
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

  // API Endpoint: Get RTK Database Commands (all records)
  if (req.method === 'GET' && req.url === '/api/rtk') {
    const query = "SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms FROM commands ORDER BY timestamp ASC";

    execFile('sqlite3', ['-json', DB_PATH, query], (error, stdout) => {
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

    execFile('sqlite3', ['-json', DB_PATH, query], (error, stdout) => {
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
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
  execFile('sqlite3', ['-json', DB_PATH, query], (error, stdout) => {
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
        // Debounce database read by 100ms to allow SQLite write locks to release
        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = setTimeout(checkForNewCommands, 100);
      }
    });
  }
}

function checkForNewCommands() {
  const query = `SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms FROM commands WHERE id > ${lastSeenDbId} ORDER BY id ASC`;
  execFile('sqlite3', ['-json', DB_PATH, query], (error, stdout) => {
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

  try {
    const startCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${startCmd} http://localhost:${PORT}`);
  } catch (e) {
    // Ignore opening errors
  }
});
