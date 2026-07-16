// lib/claude-statusbar-cache.js
// Reads the real Claude Code rate-limit percentage — not RTK, not OTel, but
// the actual server-reported utilization Anthropic sends Claude Code on
// every turn, delivered via the built-in `statusLine` stdin mechanism and
// cached by the claude-statusbar tool ("cs"). This is the same number the
// terminal status bar shows, so using it here is how the dashboard's Claude
// card can actually match the status bar instead of approximating it from
// cost estimates.
//
// This is a soft dependency on a third-party local tool's cache, not a
// documented API — treat any read as best-effort and fall back to the
// existing RTK/OTel cost-based estimate if nothing usable is found.
//
// Deliberately scans per-session caches (sessions/<id>/last_stdin.json)
// rather than the top-level last_stdin.json. The top-level file is a
// global last-writer-wins cache shared by every active session, and — since
// rate_limits only applies to Pro/Max subscription auth, not API-key billing
// — a concurrent session authenticated a different way can legitimately have
// no rate_limits field at all. Reading the global file meant flickering
// between "real percentage" and "missing" depending purely on which session
// rendered most recently (confirmed empirically: ~60% miss rate). Scanning
// per-session caches and picking the freshest one that actually has
// rate_limits avoids that.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(os.homedir(), '.cache/claude-statusbar/sessions');
const MAX_STALENESS_MS = 15 * 60_000; // no active Claude Code session in 15min = treat as unavailable

function readSessionFile(dirName) {
  const file = path.join(SESSIONS_DIR, dirName, 'last_stdin.json');
  try {
    const stat = fs.statSync(file);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > MAX_STALENESS_MS) return null;

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fiveHour = data.rate_limits && data.rate_limits.five_hour;
    if (!fiveHour || typeof fiveHour.used_percentage !== 'number') return null;

    return { ageMs, data };
  } catch (e) {
    return null; // missing, unreadable, malformed, or no rate_limits — skip this session
  }
}

function getClaudeRealRateLimits() {
  let dirs;
  try {
    dirs = fs.readdirSync(SESSIONS_DIR);
  } catch (e) {
    return null; // claude-statusbar not installed / no sessions dir yet
  }

  // Collect all valid candidates
  const nowSec = Date.now() / 1000;
  const candidates = [];
  for (const dirName of dirs) {
    const candidate = readSessionFile(dirName);
    if (!candidate) continue;
    candidates.push(candidate);
  }
  if (candidates.length === 0) return null;

  // When multiple Claude Code sessions are active simultaneously, each gets
  // rate_limits updates at different times. Two bugs can occur:
  //
  //  1. STALE WINDOW: A session's resets_at is in the PAST — its 5h window
  //     already rolled over, so the used_percentage refers to the previous
  //     quota window, not the current one. These sessions are wrong.
  //
  //  2. MULTI-SESSION FLICKER: Among sessions in the current window, the one
  //     with the highest used_percentage has seen the most recent server-side
  //     accounting; lower values are just lagging. Pick the max.
  //
  // Strategy:
  //   a) Prefer sessions whose resets_at is in the FUTURE (current window).
  //   b) Among those, pick the one with the HIGHEST used_percentage.
  //   c) If ALL sessions have a past resets_at (edge case after a full reset),
  //      fall back to the freshest file (least stale data).

  const currentWindow = candidates.filter(c => {
    const resetsAt = c.data.rate_limits.five_hour.resets_at;
    return resetsAt && resetsAt > nowSec;
  });

  let best;
  if (currentWindow.length > 0) {
    // Pick highest usage among sessions in the current window
    best = currentWindow.reduce((a, b) =>
      a.data.rate_limits.five_hour.used_percentage >= b.data.rate_limits.five_hour.used_percentage ? a : b
    );
  } else {
    // All sessions have stale windows — fall back to freshest file
    best = candidates.reduce((a, b) => a.ageMs <= b.ageMs ? a : b);
  }

  const fiveHour = best.data.rate_limits.five_hour;
  const sevenDay = best.data.rate_limits.seven_day;

  return {
    used5h:       fiveHour.used_percentage,
    resets5h:     fiveHour.resets_at || null,
    usedWeekly:   sevenDay && typeof sevenDay.used_percentage === 'number' ? sevenDay.used_percentage : null,
    resetsWeekly: sevenDay && sevenDay.resets_at ? sevenDay.resets_at : null,
  };
}

module.exports = { getClaudeRealRateLimits };
