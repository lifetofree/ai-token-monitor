// tests/antigravityParser.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { parseTranscriptFile, parseAllTranscripts, _setFs } from '../lib/antigravity-parser';

// Create explicit mock functions
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('fs', () => ({
  default: {
    existsSync: (...a) => mockExistsSync(...a),
    readFileSync: (...a) => mockReadFileSync(...a),
    readdirSync: (...a) => mockReaddirSync(...a),
    statSync: (...a) => mockStatSync(...a)
  },
  existsSync: (...a) => mockExistsSync(...a),
  readFileSync: (...a) => mockReadFileSync(...a),
  readdirSync: (...a) => mockReaddirSync(...a),
  statSync: (...a) => mockStatSync(...a)
}));

describe('Antigravity CLI Transcript Parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setFs(fs);
  });


  describe('parseTranscriptFile', () => {
    it('returns empty stats if file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      const stats = parseTranscriptFile('/path/to/nonexistent/file.jsonl');
      expect(stats.inputTokens).toBe(0);
      expect(stats.outputTokens).toBe(0);
      expect(stats.totalCost).toBe(0);
    });

    it('correctly parses user and model inputs/outputs', () => {
      mockExistsSync.mockReturnValue(true);
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
      
      mockReadFileSync.mockReturnValue(mockJsonl);

      const stats = parseTranscriptFile('/path/to/mock/file.jsonl');
      expect(stats.inputTokens).toBe(3); // Math.ceil(11 / 4)
      expect(stats.outputTokens).toBe(14); // Math.ceil(25 / 4) + Math.ceil(28 / 4) -> 7 + 7
      expect(stats.totalCost).toBeGreaterThan(0);
    });

    it('ignores malformed lines', () => {
      mockExistsSync.mockReturnValue(true);
      const mockJsonl = [
        'invalid json',
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          content: 'Hello' // 5 chars -> 2 tokens
        })
      ].join('\n');

      mockReadFileSync.mockReturnValue(mockJsonl);

      const stats = parseTranscriptFile('/path/to/mock/file.jsonl');
      expect(stats.inputTokens).toBe(2);
      expect(stats.outputTokens).toBe(0);
    });
  });

  describe('parseAllTranscripts', () => {
    it('aggregates multiple conversation directories', () => {
      mockExistsSync.mockImplementation((p) => p.includes('brain') || p.includes('transcript.jsonl'));
      mockReaddirSync.mockReturnValue(['conv1', 'conv2']);
      mockStatSync.mockReturnValue({ isDirectory: () => true, mtimeMs: 12345678 });
      
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          source: 'USER_EXPLICIT',
          content: 'hi' // 2 chars -> 1 token
        })
      );

      const aggregated = parseAllTranscripts();
      expect(aggregated.conversationsCount).toBe(2);
      expect(aggregated.inputTokens).toBe(2); // 1 token from each of the 2 conversations
      expect(aggregated.sessions.length).toBe(2);
      expect(aggregated.sessions[0].conversationId).toBe('conv1');
    });
  });
});

