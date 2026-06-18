#!/usr/bin/env node
// Syncs MiMo CLI usage from ~/.local/share/mimocode/mimocode.db
// into the RTK database so the dashboard shows accurate totals.
'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const MIMO_DB = path.join(process.env.HOME, '.local/share/mimocode/mimocode.db');
const RTK_DB = process.env.RTK_DB_PATH || path.join(process.env.HOME, 'Library/Application Support/rtk/history.db');

function query(db, sql) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', db, sql], (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout || '[]')); } catch (e) { resolve([]); }
    });
  });
}

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-cmd', '.timeout 5000', db, sql], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

async function sync() {
  if (!fs.existsSync(MIMO_DB)) {
    console.log('MiMo DB not found:', MIMO_DB);
    return;
  }

  // Get MiMo CLI usage per project
  const usage = await query(MIMO_DB, `
    SELECT p.worktree as project,
      SUM(json_extract(m.data, '$.tokens.input')) as input_tokens,
      SUM(json_extract(m.data, '$.tokens.output')) as output_tokens,
      SUM(json_extract(m.data, '$.tokens.cache.read')) as cache_read,
      SUM(json_extract(m.data, '$.tokens.total')) as total_tokens,
      COUNT(*) as messages
    FROM message m
    JOIN session s ON m.session_id = s.id
    JOIN project p ON s.project_id = p.id
    WHERE json_extract(m.data, '$.role') = 'assistant'
      AND json_extract(m.data, '$.tokens.total') > 0
    GROUP BY p.worktree
  `);

  // Delete old MiMo commands and insert fresh ones
  await exec(RTK_DB, "DELETE FROM commands WHERE brand = 'mimo'");

  const now = new Date().toISOString();
  for (const u of usage) {
    if (!u.project || u.total_tokens === 0) continue;
    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    const saved = u.cache_read || 0;
    const savingsPct = (input + saved) > 0 ? ((saved / (input + saved)) * 100).toFixed(1) : '0';
    const sql = `INSERT INTO commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path, brand) VALUES ('${now}', 'mimo cli api inference call', '', ${input}, ${output}, ${saved}, ${savingsPct}, 0, '${u.project.replace(/'/g, "''")}', 'mimo');`;
    await exec(RTK_DB, sql);
  }

  // Update brand_quota with totals
  let totalInput = 0, totalOutput = 0, totalSaved = 0, totalTokens = 0, totalReqs = 0;
  for (const u of usage) {
    totalInput += u.input_tokens || 0;
    totalOutput += u.output_tokens || 0;
    totalSaved += u.cache_read || 0;
    totalTokens += u.total_tokens || 0;
    totalReqs += u.messages || 0;
  }
  const inputCost = 1.0, outputCost = 4.0;
  const totalCost = ((totalInput * inputCost) + (totalOutput * outputCost)) / 1000000;
  const ts = Date.now();
  const rtk = { cost5h: totalCost, costWeekly: totalCost, requests5h: totalReqs, requestsWeekly: totalReqs, tokens5h: totalTokens, tokensWeekly: totalTokens, earliest5hTimestamp: ts, earliestWeeklyTimestamp: ts };
  const rawJson = JSON.stringify({_rtk_spend: rtk}).replace(/'/g, "''");
  await exec(RTK_DB, `UPDATE brand_quota SET raw_json = '${rawJson}' WHERE brand = 'mimo'`);

  console.log(`Synced ${usage.length} projects, ${totalReqs} messages, ${totalTokens} tokens, $${totalCost.toFixed(4)}`);
}

sync().catch(e => console.error(e));
