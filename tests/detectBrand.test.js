// tests/detectBrand.test.js
// Tests for the brand detection heuristic used in app.js's detectBrand().
// The heuristic scans the RTK `original_cmd` text for Brand keywords.
// Shell commands that don't match any Brand return null (filtered from the feed).

import { describe, it, expect } from 'vitest';

// Mirror of app.js detectBrand — returns null for non-LLM commands.
// NOTE: server.js detectSpecificBrand uses the same patterns but returns 'claude'
// for unmatched (all unrecognised RTK commands are treated as Claude Code calls).
function detectBrand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const c = cmd.toLowerCase();
  if (c.includes('gemini') || c.includes('google-generative') || c.includes('genai')) return 'gemini';
  if (c.includes('minimax')) return 'minimax';
  if (c.includes('glm') || c.includes('zhipu')) return 'glm';
  if (c.includes('claude') || c.includes('anthropic')) return 'claude';
  return null;
}

// Mirror of server.js detectSpecificBrand — falls back to 'claude'.
function detectSpecificBrand(cmd) {
  if (!cmd || typeof cmd !== 'string') return 'claude';
  const c = cmd.toLowerCase();
  if (c.includes('gemini') || c.includes('google-generative') || c.includes('genai')) return 'gemini';
  if (c.includes('minimax')) return 'minimax';
  if (c.includes('glm') || c.includes('zhipu')) return 'glm';
  return 'claude';
}

describe('detectBrand (client — null fallback)', () => {
  it('detects claude via api.anthropic.com URL', () => {
    expect(detectBrand('curl -X POST https://api.anthropic.com/v1/messages claude-3-haiku test'))
      .toBe('claude');
  });

  it('detects claude via anthropic keyword', () => {
    expect(detectBrand('curl https://api.anthropic.com')).toBe('claude');
  });

  it('detects gemini in a curl call to generativelanguage', () => {
    expect(detectBrand('curl https://generativelanguage.googleapis.com gemini-1.5-flash'))
      .toBe('gemini');
  });

  it('detects gemini via google-generative keyword', () => {
    expect(detectBrand('google-generative-ai prompt')).toBe('gemini');
  });

  it('detects gemini via genai keyword', () => {
    expect(detectBrand('genai generate text')).toBe('gemini');
  });

  it('detects glm in a curl call to bigmodel', () => {
    expect(detectBrand('curl https://open.bigmodel.cn glm-4')).toBe('glm');
  });

  it('detects glm via zhipu keyword', () => {
    expect(detectBrand('zhipu api call')).toBe('glm');
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

  it('gemini wins over claude when both present (gemini checked first)', () => {
    expect(detectBrand('gemini claude')).toBe('gemini');
  });
});

describe('detectSpecificBrand (server — claude fallback)', () => {
  it('detects gemini', () => {
    expect(detectSpecificBrand('curl https://generativelanguage.googleapis.com gemini-1.5-flash'))
      .toBe('gemini');
  });

  it('detects glm', () => {
    expect(detectSpecificBrand('curl https://open.bigmodel.cn glm-4')).toBe('glm');
  });

  it('detects minimax', () => {
    expect(detectSpecificBrand('curl https://www.minimax.io token-count')).toBe('minimax');
  });

  it('falls back to claude for unrecognised commands (not null)', () => {
    expect(detectSpecificBrand('ls -la /tmp')).toBe('claude');
    expect(detectSpecificBrand('git status')).toBe('claude');
    expect(detectSpecificBrand('mcp_tool_use_call')).toBe('claude');
  });

  it('falls back to claude for null/empty input', () => {
    expect(detectSpecificBrand(null)).toBe('claude');
    expect(detectSpecificBrand('')).toBe('claude');
    expect(detectSpecificBrand(undefined)).toBe('claude');
  });
});
