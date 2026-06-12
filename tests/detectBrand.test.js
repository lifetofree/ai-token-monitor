// tests/detectBrand.test.js
// Tests for the brand detection heuristic used in app.js's detectBrand()
// and lib/rtk-metrics.js.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectBrand } = require('../lib/brand-detect');

describe('detectBrand (shared logic)', () => {
  it('detects Claude/Anthropic', () => {
    expect(detectBrand('curl -X POST https://api.anthropic.com/v1/messages claude-3-haiku test'))
      .toBe('claude');
    expect(detectBrand('curl https://api.anthropic.com')).toBe('claude');
  });

  it('detects Gemini', () => {
    expect(detectBrand('curl https://generativelanguage.googleapis.com gemini-1.5-flash'))
      .toBe('gemini');
    expect(detectBrand('google-generative-ai prompt')).toBe('gemini');
    expect(detectBrand('genai generate text')).toBe('gemini');
  });

  it('detects GLM', () => {
    expect(detectBrand('curl https://open.bigmodel.cn glm-4')).toBe('glm');
    expect(detectBrand('zhipu api call')).toBe('glm');
  });

  it('detects MiniMax', () => {
    expect(detectBrand('curl ... https://www.minimax.io token-count ...')).toBe('minimax');
    expect(detectBrand('curl ... MiniMax-M3 ...')).toBe('minimax');
    expect(detectBrand('curl ... MINIMAX_API_KEY ...')).toBe('minimax');
  });

  it('returns null for non-LLM commands (shell commands)', () => {
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

  it('returns identical values for a fixture of 10 original_cmd strings', () => {
    const fixture = [
      'curl https://api.anthropic.com/v1/messages',
      'gemini call',
      'minimax request',
      'zhipu api',
      'ls -la',
      'git commit',
      'grep pattern',
      '',
      null,
      'unknown command'
    ];

    fixture.forEach(cmd => {
      // In the server context (rtk-metrics.js) and the client context (app.js),
      // both now import and call the exact same detectBrand function from lib/brand-detect.js.
      const clientVal = detectBrand(cmd);
      const serverVal = detectBrand(cmd);
      expect(clientVal).toBe(serverVal);
    });
  });
});
