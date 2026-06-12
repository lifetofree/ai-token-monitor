// lib/sse-watcher.js
// SSE client management and DB file watcher for real-time RTK command push.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let sseClients = [];
let lastSeenDbId = 0;

function addSseClient(res) {
  sseClients.push(res);
}

function removeSseClient(res) {
  sseClients = sseClients.filter(c => c !== res);
}

function broadcastToClients(payload) {
  const data = JSON.stringify(payload);
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

function initWatcher(dbPath) {
  // Sync lastSeenDbId on startup
  const query = "SELECT id FROM commands ORDER BY id DESC LIMIT 1";
  execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', dbPath, query], (error, stdout) => {
    if (!error && stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.length > 0) lastSeenDbId = parsed[0].id;
      } catch (e) {}
    }
  });

  const dbDir = path.dirname(dbPath);
  let watchTimeout = null;

  if (fs.existsSync(dbDir)) {
    fs.watch(dbDir, (eventType, filename) => {
      if (filename && filename.startsWith('history.db')) {
        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = setTimeout(() => checkForNewCommands(dbPath), 300);
      }
    });
  }
}

function checkForNewCommands(dbPath) {
  const query = `SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms FROM commands WHERE id > ${lastSeenDbId} ORDER BY id ASC`;
  execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', dbPath, query], (error, stdout) => {
    if (error || !stdout.trim()) return;
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.length > 0) {
        parsed.forEach(cmd => {
          lastSeenDbId = Math.max(lastSeenDbId, cmd.id);
          broadcastToClients(cmd);
        });
      }
    } catch (e) {}
  });
}

module.exports = { sseClients: () => sseClients, addSseClient, removeSseClient, initWatcher };
