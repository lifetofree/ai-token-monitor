// lib/mimo-parser.js
// Parses MiMo CLI session data from ~/.local/share/mimocode/mimocode.db
// and aggregates token usage per project for the dashboard.
'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const MIMO_DB_PATH = path.join(
  process.env.HOME || require('os').homedir(),
  '.local/share/mimocode/mimocode.db'
);

function parseMimoUsage() {
  return new Promise((resolve) => {
    if (!fs.existsSync(MIMO_DB_PATH)) {
      resolve({ sessions: [], totalTokens: 0, totalCost: 0 });
      return;
    }

    const query = `
      SELECT 
        p.worktree as project,
        p.name as project_name,
        COUNT(*) as messages,
        SUM(json_extract(m.data, '$.tokens.input')) as input_tokens,
        SUM(json_extract(m.data, '$.tokens.output')) as output_tokens,
        SUM(json_extract(m.data, '$.tokens.cache.read')) as cache_read_tokens,
        SUM(json_extract(m.data, '$.tokens.cache.write')) as cache_write_tokens,
        SUM(json_extract(m.data, '$.tokens.total')) as total_tokens,
        SUM(json_extract(m.data, '$.cost')) as total_cost,
        MIN(json_extract(m.data, '$.time.created')) as earliest,
        MAX(json_extract(m.data, '$.time.created')) as latest
      FROM message m
      JOIN session s ON m.session_id = s.id
      JOIN project p ON s.project_id = p.id
      WHERE json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(m.data, '$.tokens.total') > 0
      GROUP BY p.worktree
      ORDER BY total_tokens DESC
    `;

    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', MIMO_DB_PATH, query], (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({ sessions: [], totalTokens: 0, totalCost: 0 });
        return;
      }
      try {
        const rows = JSON.parse(stdout);
        let totalTokens = 0;
        let totalCost = 0;
        const sessions = rows.map(r => {
          const input = r.input_tokens || 0;
          const output = r.output_tokens || 0;
          const cached = r.cache_read_tokens || 0;
          const total = r.total_tokens || 0;
          const cost = r.total_cost || 0;
          totalTokens += total;
          totalCost += cost;
          return {
            project: r.project || '',
            projectName: r.project_name || r.project || 'unknown',
            messages: r.messages || 0,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cached,
            cacheWriteTokens: r.cache_write_tokens || 0,
            totalTokens: total,
            totalCost: cost,
            earliest: r.earliest || null,
            latest: r.latest || null
          };
        });
        resolve({ sessions, totalTokens, totalCost });
      } catch (e) {
        resolve({ sessions: [], totalTokens: 0, totalCost: 0 });
      }
    });
  });
}

module.exports = { parseMimoUsage, MIMO_DB_PATH };
