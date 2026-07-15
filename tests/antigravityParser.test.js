// tests/antigravityParser.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { parseTranscriptFile, parseAllTranscripts, countTokensFor, _setFs, _setGeminiKey, _setGeminiClient } from '../lib/antigravity-parser';

// Create explicit mock functions
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();

vi.mock('fs', () => ({
  default: {
    promises: {
      readdir: (...a) => mockReaddir(...a),
      readFile: (...a) => mockReadFile(...a),
      stat: (...a) => mockStat(...a)
    }
  },
  promises: {
    readdir: (...a) => mockReaddir(...a),
    readFile: (...a) => mockReadFile(...a),
    stat: (...a) => mockStat(...a)
  }
}));

describe('Antigravity CLI Transcript Parser (Async)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setFs(fs);
    _setGeminiKey(null);
    _setGeminiClient(null);
  });

  describe('parseTranscriptFile', () => {
    it('returns empty stats if file does not exist', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      const stats = await parseTranscriptFile('/path/to/nonexistent/file.jsonl');
      expect(stats.inputTokens).toBe(0);
      expect(stats.outputTokens).toBe(0);
      expect(stats.totalCost).toBe(0);
    });

    it('correctly parses user and model inputs/outputs', async () => {
      const mockJsonl = [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          content: 'Hello agent' // 11 chars -> 3 tokens
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          content: 'Hello human. I will help.', // 25 chars -> 7 tokens
          tool_calls: [
            {
              name: 'run_command',
              args: { CommandLine: 'git status' } // JSON serialization -> ~30 chars -> 8 tokens
            }
          ]
        })
      ].join('\n');
      
      mockReadFile.mockResolvedValue(mockJsonl);

      const stats = await parseTranscriptFile('/path/to/mock/file.jsonl');
      expect(stats.inputTokens).toBe(3); // Math.ceil(11 / 4)
      expect(stats.outputTokens).toBe(14); // Math.ceil(25 / 4) + Math.ceil(28 / 4) -> 7 + 7
      expect(stats.totalCost).toBeGreaterThan(0);
    });

    it('ignores malformed lines', async () => {
      const mockJsonl = [
        'invalid json',
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          content: 'Hello' // 5 chars -> 2 tokens
        })
      ].join('\n');

      mockReadFile.mockResolvedValue(mockJsonl);

      const stats = await parseTranscriptFile('/path/to/mock/file.jsonl');
      expect(stats.inputTokens).toBe(2);
      expect(stats.outputTokens).toBe(0);
    });

    it('correctly handles mixed session types (SUBAGENT, SYSTEM)', async () => {
      const mockJsonl = [
        JSON.stringify({
          source: 'SYSTEM',
          content: 'System instruction' // 18 chars -> 5 tokens
        }),
        JSON.stringify({
          source: 'SUBAGENT',
          content: 'Subagent response', // 17 chars -> 5 tokens
          tool_calls: [
            {
              args: { value: 42 } // {"value":42} -> 12 chars -> 3 tokens
            }
          ]
        })
      ].join('\n');

      mockReadFile.mockResolvedValue(mockJsonl);

      const stats = await parseTranscriptFile('/path/to/mock/file.jsonl');
      expect(stats.inputTokens).toBe(5);
      expect(stats.outputTokens).toBe(8); // 5 + 3
    });
  });

  describe('parseAllTranscripts', () => {
    it('aggregates multiple conversation directories with caching', async () => {
      mockReaddir.mockResolvedValue(['conv1', 'conv2']);
      mockStat.mockImplementation(async (p) => {
        if (p.endsWith('conv1') || p.endsWith('conv2')) {
          return { isDirectory: () => true };
        }
        if (p.includes('transcript.jsonl')) {
          return { isDirectory: () => false, mtimeMs: 12345678 };
        }
        throw { code: 'ENOENT' };
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          source: 'USER_EXPLICIT',
          content: 'hi' // 2 chars -> 1 token
        })
      );

      const aggregated1 = await parseAllTranscripts();
      expect(aggregated1.conversationsCount).toBe(2);
      expect(aggregated1.inputTokens).toBe(2); // 1 token from each
      expect(aggregated1.sessions.length).toBe(2);
      expect(aggregated1.sessions[0].conversationId).toBe('conv1');
      expect(aggregated1.sessions[0].lastModified).toBe(12345678);

      // Verify caching works
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          source: 'USER_EXPLICIT',
          content: 'longer content' // 14 chars -> 4 tokens
        })
      );

      const aggregated2 = await parseAllTranscripts();
      expect(aggregated2.inputTokens).toBe(2); // still 2 because it's cached!

      // Cache invalidation by changing mtime of conv1
      mockStat.mockImplementation(async (p) => {
        if (p.endsWith('conv1') || p.endsWith('conv2')) {
          return { isDirectory: () => true };
        }
        if (p.includes('conv1') && p.includes('transcript.jsonl')) {
          return { isDirectory: () => false, mtimeMs: 88888888 }; // new mtime
        }
        if (p.includes('conv2') && p.includes('transcript.jsonl')) {
          return { isDirectory: () => false, mtimeMs: 12345678 }; // same mtime
        }
        throw { code: 'ENOENT' };
      });

      const aggregated3 = await parseAllTranscripts();
      // conv1 gets re-parsed (4 tokens), conv2 is still cached (1 token). Total = 5.
      expect(aggregated3.inputTokens).toBe(5);
    });

    it('returns empty aggregated stats if brain directory does not exist', async () => {
      mockReaddir.mockRejectedValue({ code: 'ENOENT' });

      const aggregated = await parseAllTranscripts();
      expect(aggregated.conversationsCount).toBe(0);
      expect(aggregated.sessions.length).toBe(0);
    });

    it('skips non-directory items in brain directory', async () => {
      mockReaddir.mockResolvedValue(['conv1', 'file.txt']);
      mockStat.mockImplementation(async (p) => {
        if (p.endsWith('conv1')) {
          return { isDirectory: () => true };
        }
        if (p.endsWith('file.txt')) {
          return { isDirectory: () => false };
        }
        if (p.includes('transcript.jsonl')) {
          return { isDirectory: () => false, mtimeMs: 12345678 };
        }
        throw { code: 'ENOENT' };
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          source: 'USER_EXPLICIT',
          content: 'hi' // 1 token
        })
      );

      const aggregated = await parseAllTranscripts();
      expect(aggregated.conversationsCount).toBe(1);
      expect(aggregated.sessions[0].conversationId).toBe('conv1');
    });

    it('ignores directory if transcript file does not exist', async () => {
      mockReaddir.mockResolvedValue(['conv1']);
      mockStat.mockImplementation(async (p) => {
        if (p.endsWith('conv1')) {
          return { isDirectory: () => true };
        }
        throw { code: 'ENOENT' };
      });

      const aggregated = await parseAllTranscripts();
      expect(aggregated.conversationsCount).toBe(0);
      expect(aggregated.sessions.length).toBe(0);
    });
  });

  describe('countTokensFor (Gemini API path)', () => {
    it('falls back to chars/4 heuristic when no key or client is set', async () => {
      _setGeminiKey(null);
      _setGeminiClient(null);
      // 11 chars -> 3 tokens
      const n = await countTokensFor('Hello agent');
      expect(n).toBe(3);
    });

    it('uses injected Gemini client when one is set', async () => {
      const mock = { countTokens: vi.fn(async (text) => 42) };
      _setGeminiClient(mock);

      const n = await countTokensFor('anything');
      expect(n).toBe(42);
      expect(mock.countTokens).toHaveBeenCalledWith('anything');
    });

    it('caches Gemini client responses by text', async () => {
      const mock = { countTokens: vi.fn(async () => 7) };
      _setGeminiClient(mock);

      const a = await countTokensFor('repeat me');
      const b = await countTokensFor('repeat me');
      expect(a).toBe(7);
      expect(b).toBe(7);
      // Cache hit on second call — only one upstream request.
      expect(mock.countTokens).toHaveBeenCalledTimes(1);
    });

    it('integrates real counts into parseTranscriptFile', async () => {
      const mock = { countTokens: vi.fn(async (text) => 100) };
      _setGeminiClient(mock);

      mockReadFile.mockResolvedValue([
        JSON.stringify({ source: 'USER_EXPLICIT', content: 'hi' }),
        JSON.stringify({ source: 'MODEL', content: 'world' })
      ].join('\n'));

      const stats = await parseTranscriptFile('/path/to/mock/file.jsonl');
      expect(stats.inputTokens).toBe(100);
      expect(stats.outputTokens).toBe(100);
      // 100 input * 1.25 + 100 output * 5.00 = 0.000625
      expect(stats.totalCost).toBeCloseTo(0.000625, 6);
    });

    it('Gemini client errors fall back to heuristic per call (no cache poisoning)', async () => {
      const mock = {
        countTokens: vi.fn(async () => { throw new Error('429 quota'); })
      };
      _setGeminiClient(mock);

      // 11 chars -> 3 tokens (heuristic), not thrown
      const n = await countTokensFor('Hello agent');
      expect(n).toBe(3);
    });
  });
});

