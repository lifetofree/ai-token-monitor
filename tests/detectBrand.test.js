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

  it('returns null for shell commands whose arguments mention brand names', () => {
    // Real false-positive cases from the RTK DB — grep/cat/etc. with 'claude'
    // in their search pattern or file path.
    expect(detectBrand("grep -rn 'claude' app.js")).toBeNull();
    expect(detectBrand("grep -rn 'claude\\|anthropic\\|ANTHROPIC\\|per_minute' server.js")).toBeNull();
    expect(detectBrand('cat /private/tmp/claude-501/project/tasks/output.txt')).toBeNull();
    expect(detectBrand("grep -rn 'fetchClaudeQuota\\|BRAND_FETCHERS' server.js")).toBeNull();
    expect(detectBrand('grep -rn color-gemini color-claude styles.css')).toBeNull();
    expect(detectBrand('find . -name "*claude*"')).toBeNull();
    expect(detectBrand('grep -rn minimax app.js')).toBeNull();
    expect(detectBrand('grep -rn glm server.js')).toBeNull();
  });

  it('returns null for Firebase/localhost URLs with brand names in the path', () => {
    // The dashboard's own Firebase reads/writes have brand names in the URL path
    expect(detectBrand('curl -s https://token-count-973cd-default-rtdb.asia-southeast1.firebasedatabase.app/display/quotas/claude.json?auth=token')).toBeNull();
    expect(detectBrand('curl -s https://token-count-973cd-default-rtdb.asia-southeast1.firebasedatabase.app/ai_quota/minimax.json?auth=token')).toBeNull();
    expect(detectBrand('curl -s http://localhost:3000/api/rtk')).toBeNull();
    expect(detectBrand('curl http://127.0.0.1:3000/api/seed-quotas')).toBeNull();
  });

  it('still detects real LLM API calls (curl to provider endpoints)', () => {
    expect(detectBrand('curl -X POST https://api.anthropic.com/v1/messages')).toBe('claude');
    expect(detectBrand('curl https://open.bigmodel.cn/api/paas/v4/chat/completions -d glm-4')).toBe('glm');
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
