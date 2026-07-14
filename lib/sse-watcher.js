// lib/sse-watcher.js
// SSE client management and DB file watcher for real-time RTK command push.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let sseClients = [];
const lastSeenCommandsMap = new Map();

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

function initWatcher(dbPath, onNewCommand) {
  // Sync lastSeenCommandsMap on startup so we don't broadcast old commands
  const query = "SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path, brand FROM commands ORDER BY id DESC LIMIT 15";
  execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', dbPath, query], (error, stdout) => {
    if (!error && stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout);
        parsed.forEach(cmd => {
          lastSeenCommandsMap.set(cmd.id, JSON.stringify(cmd));
        });
      } catch (e) {}
    }
  });

  const dbDir = path.dirname(dbPath);
  let watchTimeout = null;

  if (fs.existsSync(dbDir)) {
    fs.watch(dbDir, (eventType, filename) => {
      if (filename && filename.startsWith('history.db')) {
        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = setTimeout(() => checkForNewCommands(dbPath, onNewCommand), 300);
      }
    });
  }
}

function checkForNewCommands(dbPath, onNewCommand) {
  const query = "SELECT id, timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path, brand FROM commands ORDER BY id DESC LIMIT 15";
  execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', dbPath, query], (error, stdout) => {
    if (error || !stdout.trim()) return;
    try {
      const parsed = JSON.parse(stdout);
      if (parsed.length > 0) {
        // Reverse to process oldest first (ascending order)
        const rows = parsed.reverse();
        let changed = false;

        const newCmds = [];
        rows.forEach(cmd => {
          const key = cmd.id;
          const currentStr = JSON.stringify(cmd);
          const prevStr = lastSeenCommandsMap.get(key);

          if (prevStr !== currentStr) {
            lastSeenCommandsMap.set(key, currentStr);
            broadcastToClients(cmd);
            changed = true;
            newCmds.push(cmd);
          }
        });

        // Prune map size
        if (lastSeenCommandsMap.size > 100) {
          const keys = Array.from(lastSeenCommandsMap.keys());
          keys.slice(0, keys.length - 50).forEach(k => lastSeenCommandsMap.delete(k));
        }

        if (changed && typeof onNewCommand === 'function') {
          onNewCommand(newCmds);
        }
      }
    } catch (e) {}
  });
}

module.exports = { sseClients: () => sseClients, addSseClient, removeSseClient, broadcastToClients, initWatcher };
