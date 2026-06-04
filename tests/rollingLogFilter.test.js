// tests/rollingLogFilter.test.js
// Tests for the Live Request Log Feed LLM-only filter added in R5-U2.
// The feed shows the last 15 LLM-classified commands on initial load.
// Shell noise (curl/grep/ls/git) must not push real API calls out of the feed.
//
// Mirrors the logic in app.js's fetchRealRTKData:
//   1. Pre-count how many commands pass detectBrand() (llmCount).
//   2. recentLogThreshold = max(0, llmCount - 15).
//   3. As commands are iterated, increment llmSeen; emit the console
//      line only when llmSeen > recentLogThreshold.
//
// On incremental (non-initial) loads, the threshold is 0 and the filter
// reduces to "id > lastSeenCommandId" (no pre-counting).

import { describe, it, expect } from 'vitest';

// Mirror of detectBrand from app.js.
function detectBrand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const c = cmd.toLowerCase();
  if (c.includes('claude')) return 'claude';
  if (c.includes('gemini')) return 'gemini';
  if (c.includes('glm')) return 'glm';
  if (c.includes('minimax')) return 'minimax';
  return null;
}

// Mirror of the filter pipeline. Returns the list of commands that
// survive the LLM filter AND pass the recentLogThreshold on initial load.
function filterInitialLoad(cmds, feedSize = 15) {
  let llmCount = 0;
  for (const cmd of cmds) {
    if (detectBrand(cmd.original_cmd)) llmCount++;
  }
  const recentLogThreshold = Math.max(0, llmCount - feedSize);
  let llmSeen = 0;
  const out = [];
  for (const cmd of cmds) {
    const brandKey = detectBrand(cmd.original_cmd);
    if (!brandKey) continue;
    llmSeen++;
    if (llmSeen > recentLogThreshold) out.push({ ...cmd, brandKey });
  }
  return out;
}

describe('Live Request Log Feed LLM filter (R5-U2)', () => {
  it('emits the most recent N LLM commands when there are exactly N', () => {
    const cmds = [
      { id: 1, original_cmd: 'curl ... claude-3' },
      { id: 2, original_cmd: 'curl ... gemini-1.5' },
      { id: 3, original_cmd: 'curl ... glm-4' },
    ];
    const out = filterInitialLoad(cmds, 15);
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('emits the LAST 15 when there are more than 15 LLM commands', () => {
    const cmds = [];
    for (let i = 1; i <= 20; i++) cmds.push({ id: i, original_cmd: `curl ... claude ${i}` });
    const out = filterInitialLoad(cmds, 15);
    expect(out).toHaveLength(15);
    expect(out[0].id).toBe(6);  // first emitted = threshold+1 = 6
    expect(out[14].id).toBe(20); // last emitted
  });

  it('shell noise does NOT push real API calls out of the feed', () => {
    // 10 shell commands followed by 5 LLM commands. Without the filter,
    // a "last 5" window would show all 10 shell commands and zero API calls.
    const cmds = [
      { id: 1, original_cmd: 'ls -la' },
      { id: 2, original_cmd: 'git status' },
      { id: 3, original_cmd: 'grep -rn foo' },
      { id: 4, original_cmd: 'curl -s /api/rtk' },
      { id: 5, original_cmd: 'pwd' },
      { id: 6, original_cmd: 'echo hi' },
      { id: 7, original_cmd: 'cat file' },
      { id: 8, original_cmd: 'tail -n 5' },
      { id: 9, original_cmd: 'wc -l' },
      { id: 10, original_cmd: 'ps aux' },
      { id: 11, original_cmd: 'curl ... claude' },
      { id: 12, original_cmd: 'curl ... gemini' },
      { id: 13, original_cmd: 'curl ... glm' },
      { id: 14, original_cmd: 'curl ... minimax' },
      { id: 15, original_cmd: 'curl ... claude 2' },
    ];
    const out = filterInitialLoad(cmds, 15);
    expect(out).toHaveLength(5);
    expect(out.map((c) => c.id)).toEqual([11, 12, 13, 14, 15]);
  });

  it('returns an empty array when there are zero LLM commands', () => {
    const cmds = [
      { id: 1, original_cmd: 'ls' },
      { id: 2, original_cmd: 'pwd' },
    ];
    expect(filterInitialLoad(cmds, 15)).toEqual([]);
  });

  it('handles a mix of brands in chronological order', () => {
    const cmds = [
      { id: 1, original_cmd: 'curl ... claude' },
      { id: 2, original_cmd: 'ls' },
      { id: 3, original_cmd: 'curl ... minimax' },
      { id: 4, original_cmd: 'git status' },
      { id: 5, original_cmd: 'curl ... gemini' },
    ];
    const out = filterInitialLoad(cmds, 15);
    expect(out.map((c) => c.brandKey)).toEqual(['claude', 'minimax', 'gemini']);
  });
});
