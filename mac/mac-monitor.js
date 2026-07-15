// mac/mac-monitor.js
// Samples Mac system metrics every 2s via child_process (no new npm deps —
// see docs/research/mac-metrics-library-choice.md, wayfinder issue #5) and
// POSTs them to the server's /api/mac endpoint (issue #7), which publishes
// to Firebase as /display/mac (issue #6).
//
// CPU temperature is the one metric issue #5 found unreachable without
// either root (powermetrics) or native compilation. This daemon accepts the
// native-compile tradeoff: mac/temp-sensor.c is compiled once at startup (not
// per-sample) into mac/temp-sensor, then shelled out to like every other
// metric. If the compiled binary is missing or fails (e.g. non-Apple-Silicon
// hardware), temp/temp_hist are simply omitted from the payload — the server
// and schema already treat them as optional.
'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.MAC_MONITOR_SERVER_URL || 'http://127.0.0.1:3838/api/mac';
const SAMPLE_INTERVAL_MS = 2000;
const HISTORY_SIZE = 60;
const TEMP_SENSOR_SRC = path.join(__dirname, 'temp-sensor.c');
const TEMP_SENSOR_BIN = path.join(__dirname, 'temp-sensor');

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

let tempAvailable = false;

async function ensureTempSensorBuilt() {
  if (fs.existsSync(TEMP_SENSOR_BIN)) { tempAvailable = true; return; }
  console.log('[mac-monitor] compiling temp-sensor helper (one-time build)...');
  await new Promise((resolve) => {
    exec(`clang -O2 -framework CoreFoundation -framework IOKit -o "${TEMP_SENSOR_BIN}" "${TEMP_SENSOR_SRC}"`,
      { timeout: 30000 },
      (err, _stdout, stderr) => {
        if (err) {
          console.error('[mac-monitor] temp-sensor build failed, CPU temp will be unavailable:', stderr || err.message);
          tempAvailable = false;
        } else {
          console.log('[mac-monitor] temp-sensor built successfully');
          tempAvailable = true;
        }
        resolve();
      });
  });
}

async function readTempC() {
  if (!tempAvailable) return null;
  const out = await run(`"${TEMP_SENSOR_BIN}"`);
  const v = parseFloat(out);
  return Number.isFinite(v) ? v : null;
}

async function readCpuPct() {
  const out = await run('top -l 1 -n 0');
  const m = out.match(/CPU usage:\s*[\d.]+%\s*user,\s*[\d.]+%\s*sys,\s*([\d.]+)%\s*idle/);
  if (!m) return 0;
  return Math.max(0, Math.min(100, 100 - parseFloat(m[1])));
}

async function readMemPct() {
  const [vmOut, memSizeOut] = await Promise.all([run('vm_stat'), run('sysctl -n hw.memsize')]);
  const totalBytes = parseInt(memSizeOut.trim(), 10);
  if (!totalBytes) return 0;

  const pageSizeMatch = vmOut.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

  const pages = {};
  const re = /Pages\s+([a-zA-Z0-9 \-]+?):\s+(\d+)\./g;
  let m;
  while ((m = re.exec(vmOut))) pages[m[1].trim().toLowerCase()] = parseInt(m[2], 10);

  // Matches Activity Monitor's "Memory Used" definition: active + wired + compressed.
  const usedPages = (pages['active'] || 0) + (pages['wired down'] || 0) + (pages['occupied by compressor'] || 0);
  return Math.max(0, Math.min(100, Math.round((usedPages * pageSize / totalBytes) * 100)));
}

async function readBattery() {
  const out = await run('pmset -g batt');
  const pctMatch = out.match(/(\d+)%/);
  const percent = pctMatch ? parseInt(pctMatch[1], 10) : 0;
  let charging = false;
  if (/not charging/i.test(out) || /discharging/i.test(out) || /\bcharged\b/i.test(out)) {
    charging = false;
  } else if (/\bcharging\b/i.test(out)) {
    charging = true;
  }
  return { percent, charging };
}

// Cumulative byte counters are diffed across samples to get a rate — see
// readNetworkDeltaKBs. Dedupe netstat's per-address-family duplicate rows by
// keeping only the <Link#N> row per interface (confirmed in research doc).
let prevNet = null; // { atMs, inBytes, outBytes }

async function readNetworkDeltaKBs() {
  const out = await run('netstat -ib');
  let inBytes = 0, outBytes = 0;
  for (const line of out.split('\n')) {
    if (!line.includes('<Link#')) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7) continue;
    const iface = cols[0];
    if (iface === 'lo0') continue; // exclude loopback from the aggregate
    const last7 = cols.slice(-7); // Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    inBytes += parseInt(last7[2], 10) || 0;
    outBytes += parseInt(last7[5], 10) || 0;
  }

  const now = Date.now();
  if (!prevNet) {
    prevNet = { atMs: now, inBytes, outBytes };
    return { down: 0, up: 0 }; // no prior sample yet — first tick has no rate
  }

  const elapsedSec = (now - prevNet.atMs) / 1000;
  const down = elapsedSec > 0 ? Math.max(0, Math.round((inBytes - prevNet.inBytes) / elapsedSec / 1024)) : 0;
  const up = elapsedSec > 0 ? Math.max(0, Math.round((outBytes - prevNet.outBytes) / elapsedSec / 1024)) : 0;
  prevNet = { atMs: now, inBytes, outBytes };
  return { down, up };
}

class RingBuffer {
  constructor(size) { this.size = size; this.buffer = []; }
  push(v) { this.buffer.push(v); if (this.buffer.length > this.size) this.buffer.shift(); }
  values() { return this.buffer; }
}

const cpuHist = new RingBuffer(HISTORY_SIZE);
const memHist = new RingBuffer(HISTORY_SIZE);
const netDownHist = new RingBuffer(HISTORY_SIZE);
const netUpHist = new RingBuffer(HISTORY_SIZE);
const battHist = new RingBuffer(HISTORY_SIZE);
const tempHist = new RingBuffer(HISTORY_SIZE);

async function collectAndPost() {
  const [cpu, mem, net, batt, temp] = await Promise.all([
    readCpuPct(), readMemPct(), readNetworkDeltaKBs(), readBattery(), readTempC(),
  ]);

  cpuHist.push(cpu);
  memHist.push(mem);
  netDownHist.push(net.down);
  netUpHist.push(net.up);
  battHist.push(batt.percent);
  if (temp !== null) tempHist.push(temp);

  const payload = {
    ts: Math.floor(Date.now() / 1000),
    cpu, mem,
    net_down: net.down, net_up: net.up,
    batt_pct: batt.percent, batt_chg: batt.charging,
    cpu_hist: cpuHist.values(),
    mem_hist: memHist.values(),
    net_down_hist: netDownHist.values(),
    net_up_hist: netUpHist.values(),
    batt_pct_hist: battHist.values(),
  };
  if (temp !== null) {
    payload.temp = temp;
    payload.temp_hist = tempHist.values();
  }

  try {
    const res = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error('[mac-monitor] POST failed:', res.status, await res.text());
    } else {
      const tempStr = temp !== null ? ` temp=${temp.toFixed(1)}C` : '';
      console.log(`[mac-monitor] cpu=${cpu}% mem=${mem}% net=↓${net.down}KB/s ↑${net.up}KB/s batt=${batt.percent}%${batt.charging ? ' (charging)' : ''}${tempStr}`);
    }
  } catch (err) {
    console.error('[mac-monitor] POST error:', err.message);
  }
}

async function sampleLoop() {
  for (;;) {
    try {
      await collectAndPost();
    } catch (err) {
      console.error('[mac-monitor] sample error:', err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
  }
}

async function main() {
  console.log('[mac-monitor] starting, posting to', SERVER_URL);
  await ensureTempSensorBuilt();
  await sampleLoop();
}

main();
