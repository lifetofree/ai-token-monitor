// tests/parserVerification.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { parseTranscriptFile, parseAllTranscripts, _setFs } from '../lib/antigravity-parser';

describe('Antigravity Async Parser - Comprehensive Verification & Stress Test', () => {
  let mockReaddir;
  let mockReadFile;
  let mockStat;
  let syncSpyCalled;

  // A helper to create a mock fs object that will track sync and async operations.
  const createMockFs = () => {
    mockReaddir = vi.fn();
    mockReadFile = vi.fn();
    mockStat = vi.fn();
    syncSpyCalled = false;

    // Define standard sync operations that throw an error if called
    const syncAssert = (methodName) => {
      return (...args) => {
        syncSpyCalled = true;
        throw new Error(`Sync filesystem method ${methodName} called in async pathway!`);
      };
    };

    return {
      promises: {
        readdir: mockReaddir,
        readFile: mockReadFile,
        stat: mockStat,
      },
      // Spy on all sync filesystem methods
      readdirSync: syncAssert('readdirSync'),
      readFileSync: syncAssert('readFileSync'),
      statSync: syncAssert('statSync'),
      existsSync: syncAssert('existsSync'),
      lstatSync: syncAssert('lstatSync'),
      realpathSync: syncAssert('realpathSync'),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const mockFs = createMockFs();
    _setFs(mockFs);
  });

  describe('1. Event-Loop Safety (Zero Sync Calls)', () => {
    it('should complete parseAllTranscripts without calling any sync fs methods', async () => {
      mockReaddir.mockResolvedValue(['session1', 'session2']);
      mockStat.mockImplementation(async (path) => {
        if (path.endsWith('session1') || path.endsWith('session2')) {
          return { isDirectory: () => true };
        }
        if (path.includes('transcript.jsonl')) {
          return { isDirectory: () => false, mtimeMs: 1000 };
        }
        throw { code: 'ENOENT' };
      });
      mockReadFile.mockResolvedValue(JSON.stringify({ source: 'USER_EXPLICIT', content: 'test' }));

      const result = await parseAllTranscripts();
      expect(result.conversationsCount).toBe(2);
      expect(syncSpyCalled).toBe(false);
    });

    it('should complete parseTranscriptFile without calling any sync fs methods', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ source: 'USER_EXPLICIT', content: 'test' }));

      const result = await parseTranscriptFile('/some/path/transcript.jsonl');
      expect(result.inputTokens).toBe(1);
      expect(syncSpyCalled).toBe(false);
    });
  });

  describe('2. Cache Accuracy (Hits, Invalidation & Recovery)', () => {
    it('should avoid re-reading files when mtime remains unchanged, and re-read when it changes', async () => {
      mockReaddir.mockResolvedValue(['session1']);
      
      let mtime = 1000;
      mockStat.mockImplementation(async (path) => {
        if (path.endsWith('session1')) return { isDirectory: () => true };
        if (path.includes('transcript.jsonl')) return { isDirectory: () => false, mtimeMs: mtime };
        throw { code: 'ENOENT' };
      });

      mockReadFile.mockResolvedValue(JSON.stringify({ source: 'USER_EXPLICIT', content: 'test content' })); // 12 chars -> 3 tokens

      // First run: Parse and populate cache
      const run1 = await parseAllTranscripts();
      expect(run1.inputTokens).toBe(3);
      expect(mockReadFile).toHaveBeenCalledTimes(1);

      // Second run: Unchanged mtime -> cache hit (no readFile call)
      const run2 = await parseAllTranscripts();
      expect(run2.inputTokens).toBe(3);
      expect(mockReadFile).toHaveBeenCalledTimes(1); // Still 1

      // Third run: Update mtime -> cache invalidation -> re-read file
      mtime = 2000;
      mockReadFile.mockResolvedValue(JSON.stringify({ source: 'USER_EXPLICIT', content: 'new content' })); // 11 chars -> 3 tokens

      const run3 = await parseAllTranscripts();
      expect(run3.inputTokens).toBe(3);
      expect(mockReadFile).toHaveBeenCalledTimes(2); // Invalidated, so called again
    });
  });

  describe('3. Error Tolerance & Edge Cases', () => {
    it('should tolerate completely malformed JSON lines and skip them without throwing', async () => {
      const malformedJsonl = [
        'invalid json here',
        '{ "unclosed": json',
        JSON.stringify({ source: 'USER_EXPLICIT', content: 'valid message' }), // 13 chars -> 4 tokens
        '{"source": "MODEL", "content": "hello", ', // invalid json
      ].join('\n');

      mockReadFile.mockResolvedValue(malformedJsonl);

      const stats = await parseTranscriptFile('/some/path/transcript.jsonl');
      expect(stats.inputTokens).toBe(4);
      expect(stats.outputTokens).toBe(0);
    });

    it('should handle completely empty transcript files safely', async () => {
      mockReadFile.mockResolvedValue('');

      const stats = await parseTranscriptFile('/some/path/transcript.jsonl');
      expect(stats.inputTokens).toBe(0);
      expect(stats.outputTokens).toBe(0);
      expect(stats.totalCost).toBe(0);
    });

    it('should handle missing transcript directories gracefully (ENOENT)', async () => {
      mockReaddir.mockRejectedValue({ code: 'ENOENT' });

      const result = await parseAllTranscripts();
      expect(result.conversationsCount).toBe(0);
      expect(result.sessions.length).toBe(0);
    });

    it('should handle other directory errors (like EACCES permission denied) gracefully', async () => {
      // Mock error logger to keep test console clean
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      mockReaddir.mockRejectedValue({ code: 'EACCES', message: 'Permission denied' });

      const result = await parseAllTranscripts();
      expect(result.conversationsCount).toBe(0);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle partial filesystem errors on individual files (e.g. read failure)', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockReaddir.mockResolvedValue(['session1', 'session2']);
      
      mockStat.mockImplementation(async (path) => {
        if (path.endsWith('session1') || path.endsWith('session2')) return { isDirectory: () => true };
        if (path.includes('transcript.jsonl')) return { isDirectory: () => false, mtimeMs: 1000 };
        throw { code: 'ENOENT' };
      });

      // session1 fails to read, session2 succeeds
      mockReadFile.mockImplementation(async (path) => {
        if (path.includes('session1')) throw new Error('Simulated read error');
        return JSON.stringify({ source: 'USER_EXPLICIT', content: 'test' });
      });

      const result = await parseAllTranscripts();
      expect(result.conversationsCount).toBe(1); // Only session2 should be registered
      expect(result.inputTokens).toBe(1);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should not cache or count conversations that fail to read due to non-ENOENT transient errors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockReaddir.mockResolvedValue(['session-transient']);
      
      mockStat.mockImplementation(async (path) => {
        if (path.endsWith('session-transient')) return { isDirectory: () => true };
        if (path.includes('transcript.jsonl')) return { isDirectory: () => false, mtimeMs: 1000 };
        throw { code: 'ENOENT' };
      });

      // 1. First run: readFile throws a transient read error (e.g. EBUSY)
      mockReadFile.mockRejectedValueOnce(Object.assign(new Error('Device busy'), { code: 'EBUSY' }));

      const run1 = await parseAllTranscripts();
      expect(run1.conversationsCount).toBe(0); // Should not count it
      expect(mockReadFile).toHaveBeenCalledTimes(1);

      // 2. Second run: the transient error is resolved and it returns data
      mockReadFile.mockResolvedValue(JSON.stringify({ source: 'USER_EXPLICIT', content: 'test content' })); // 12 chars -> 3 tokens

      const run2 = await parseAllTranscripts();
      expect(run2.conversationsCount).toBe(1); // Should now count it
      expect(run2.inputTokens).toBe(3);
      expect(mockReadFile).toHaveBeenCalledTimes(2); // Should have read the file again (no cache hit on error)

      // 3. Third run: mtime remains unchanged, so it should hit the cache (no new readFile)
      const run3 = await parseAllTranscripts();
      expect(run3.conversationsCount).toBe(1);
      expect(run3.inputTokens).toBe(3);
      expect(mockReadFile).toHaveBeenCalledTimes(2); // Still 2

      consoleSpy.mockRestore();
    });
  });

  describe('4. Performance & Stress Test', () => {
    it('should handle a large number of sessions (1000 sessions) efficiently', async () => {
      const numSessions = 1000;
      const sessionsList = Array.from({ length: numSessions }, (_, i) => `session_${i}`);
      
      mockReaddir.mockResolvedValue(sessionsList);
      mockStat.mockImplementation(async (path) => {
        const isDir = sessionsList.some(s => path.endsWith(s));
        if (isDir) return { isDirectory: () => true };
        if (path.includes('transcript.jsonl')) return { isDirectory: () => false, mtimeMs: 1000 };
        throw { code: 'ENOENT' };
      });

      mockReadFile.mockResolvedValue(JSON.stringify({ source: 'USER_EXPLICIT', content: 'hello world' })); // 11 chars -> 3 tokens

      const startTime = performance.now();
      const result = await parseAllTranscripts();
      const endTime = performance.now();
      
      const duration = endTime - startTime;
      expect(result.conversationsCount).toBe(numSessions);
      expect(result.inputTokens).toBe(numSessions * 3);
      
      // Verification of parsing performance (usually completes in < 50ms with mocks)
      expect(duration).toBeLessThan(500); // Generous limit for safety
    });
  });
});
