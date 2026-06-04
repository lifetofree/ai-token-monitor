// tests/detectBrand.test.js
// Tests for the brand detection heuristic used in app.js's detectBrand().
// The heuristic scans the RTK `original_cmd` text for Brand keywords.
// Shell commands that don't match any Brand are filtered out of the
// Live Request Log Feed's last-15 window (per R5-U2 in docs/REVIEWS.md).

import { describe, it, expect } from 'vitest';

// Mirror of app.js's detectBrand. Case-insensitive substring match,
// first-match-wins in the order: claude, gemini, glm, minimax.
function detectBrand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const c = cmd.toLowerCase();
  if (c.includes('claude')) return 'claude';
  if (c.includes('gemini')) return 'gemini';
  if (c.includes('glm')) return 'glm';
  if (c.includes('minimax')) return 'minimax';
  return null;
}

describe('detectBrand', () => {
  it('detects claude in a curl call to anthropic', () => {
    expect(detectBrand('curl -X POST https://api.anthropic.com/v1/messages claude-3-haiku test'))
      .toBe('claude');
  });

  it('detects gemini in a curl call to generativelanguage', () => {
    expect(detectBrand('curl https://generativelanguage.googleapis.com gemini-1.5-flash'))
      .toBe('gemini');
  });

  it('detects glm in a curl call to bigmodel', () => {
    expect(detectBrand('curl https://open.bigmodel.cn glm-4')).toBe('glm');
  });

  it('detects minimax (case-insensitive across multiple spellings)', () => {
    expect(detectBrand('curl ... https://www.minimax.io token-count ...')).toBe('minimax');
    expect(detectBrand('curl ... MiniMax-M3 ...')).toBe('minimax');
    expect(detectBrand('curl ... MINIMAX_API_KEY ...')).toBe('minimax');
  });

  it('returns null for shell commands (filtered out of feed)', () => {
    expect(detectBrand('curl -s http://localhost:3000/api/rtk')).toBeNull();
    expect(detectBrand('grep -rn detectBrand app.js')).toBeNull();
    expect(detectBrand('ls -la /tmp')).toBeNull();
    expect(detectBrand('git status')).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(detectBrand('')).toBeNull();
    expect(detectBrand(null)).toBeNull();
    expect(detectBrand(undefined)).toBeNull();
    expect(detectBrand(42)).toBeNull();
  });

  it('first-match wins (claude before gemini when both present)', () => {
    expect(detectBrand('claude gemini')).toBe('claude');
  });
});
