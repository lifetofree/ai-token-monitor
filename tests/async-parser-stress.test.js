// tests/async-parser-stress.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { parseTranscriptFile, parseAllTranscripts, _setFs } from '../lib/antigravity-parser';

const ANTIGRAVITY_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

class TrackerFs {
  constructor() {
    this.calls = {
      readdir: 0,
      readFile: 0,
      stat: 0,
      syncCalls: 0
    };
    this.files = new Map(); // path -> { content, mtimeMs, isDirectory }

    this.promises = {
      readdir: async (dirPath) => {
        this.calls.readdir++;
        if (!this.files.has(dirPath)) {
          const err = new Error(`ENOENT: no such file or directory, readdir '${dirPath}'`);
          err.code = 'ENOENT';
          throw err;
        }
        const file = this.files.get(dirPath);
        if (!file.isDirectory) {
          const err = new Error(`ENOTDIR: not a directory, readdir '${dirPath}'`);
          err.code = 'ENOTDIR';
          throw err;
        }

        // Find items directly under dirPath
        const items = new Set();
        for (const k of this.files.keys()) {
          if (k.startsWith(dirPath) && k !== dirPath) {
            const rel = path.relative(dirPath, k);
            const part = rel.split(path.sep)[0];
            if (part) items.add(part);
          }
        }
        return Array.from(items);
      },
      stat: async (p) => {
        this.calls.stat++;
        const file = this.files.get(p);
        if (!file) {
          const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
          err.code = 'ENOENT';
          throw err;
        }
        return {
          isDirectory: () => file.isDirectory,
          mtimeMs: file.mtimeMs
        };
      },
      readFile: async (p, encoding) => {
        this.calls.readFile++;
        const file = this.files.get(p);
        if (!file) {
          const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
          err.code = 'ENOENT';
          throw err;
        }
        if (file.isDirectory) {
          const err = new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
          err.code = 'EISDIR';
          throw err;
        }
        if (file.throwOnRead) {
          throw file.throwOnRead;
        }
        return file.content;
      }
    };

    // Any sync method called throws an error
    const syncMethods = [
      'readdirSync', 'readFileSync', 'statSync', 'existsSync', 
      'lstatSync', 'accessSync', 'realpathSync'
    ];
    for (const m of syncMethods) {
      this[m] = () => {
        this.calls.syncCalls++;
        throw new Error(`Sync filesystem method ${m} was called!`);
      };
    }
  }

  addFile(p, content, mtimeMs = Date.now()) {
    this.files.set(p, { content, mtimeMs, isDirectory: false });
  }

  addDir(p, mtimeMs = Date.now()) {
    this.files.set(p, { content: null, mtimeMs, isDirectory: true });
  }

  setReadError(p, error) {
    if (this.files.has(p)) {
      this.files.get(p).throwOnRead = error;
    }
  }
}

describe('Async Parser Stress and Verification Test Suite', () => {
  let mockFs;

  beforeEach(() => {
    mockFs = new TrackerFs();
    _setFs(mockFs);
  });

  describe('Event-Loop Safety (No Sync Calls)', () => {
    it('scans and parses transcripts without calling any synchronous fs methods', async () => {
      // Setup minimal mock directory structure
      mockFs.addDir(ANTIGRAVITY_BRAIN_DIR);
      const convId = 'session-1';
      const convDir = path.join(ANTIGRAVITY_BRAIN_DIR, convId);
      mockFs.addDir(convDir);
      const transcriptDir = path.join(convDir, '.system_generated', 'logs');
      mockFs.addDir(transcriptDir);
      const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
      mockFs.addFile(transcriptFile, JSON.stringify({
        source: 'USER_EXPLICIT',
        content: 'Hello'
      }));

      // Execute parsing
      const stats = await parseAllTranscripts();
      
      expect(stats.conversationsCount).toBe(1);
      expect(mockFs.calls.syncCalls).toBe(0);
      expect(mockFs.calls.readdir).toBeGreaterThan(0);
      expect(mockFs.calls.readFile).toBeGreaterThan(0);
      expect(mockFs.calls.stat).toBeGreaterThan(0);
    });
  });

  describe('Cache Accuracy and Invalidation', () => {
    it('correctly caches unchanged files and invalidates updated files', async () => {
      mockFs.addDir(ANTIGRAVITY_BRAIN_DIR);
      
      const convId = 'session-cache';
      const convDir = path.join(ANTIGRAVITY_BRAIN_DIR, convId);
      mockFs.addDir(convDir);
      const transcriptDir = path.join(convDir, '.system_generated', 'logs');
      mockFs.addDir(transcriptDir);
      const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
      
      const mtime1 = 1000000000;
      mockFs.addFile(transcriptFile, JSON.stringify({
        source: 'USER_EXPLICIT',
        content: 'Initial request' // 15 chars -> 4 tokens
      }), mtime1);

      // Run 1: First parse (Cache Miss)
      const res1 = await parseAllTranscripts();
      expect(res1.inputTokens).toBe(4);
      expect(mockFs.calls.readFile).toBe(1);

      // Run 2: Second parse without changes (Cache Hit)
      const res2 = await parseAllTranscripts();
      expect(res2.inputTokens).toBe(4);
      // readFile should NOT be incremented because we returned cached stats
      expect(mockFs.calls.readFile).toBe(1);

      // Run 3: Modify content but keep mtimeMs the same (Cache Hit - no update expected)
      mockFs.addFile(transcriptFile, JSON.stringify({
        source: 'USER_EXPLICIT',
        content: 'Initial request but modified without mtime change' // 47 chars
      }), mtime1);
      const res3 = await parseAllTranscripts();
      expect(res3.inputTokens).toBe(4); // still 4 (uses old cache)
      expect(mockFs.calls.readFile).toBe(1);

      // Run 4: Invalidate by changing mtimeMs
      const mtime2 = 2000000000;
      mockFs.addFile(transcriptFile, JSON.stringify({
        source: 'USER_EXPLICIT',
        content: 'Updated content request' // 24 chars -> 6 tokens
      }), mtime2);
      const res4 = await parseAllTranscripts();
      expect(res4.inputTokens).toBe(6); // parsed new file
      expect(mockFs.calls.readFile).toBe(2); // read again
    });
  });

  describe('Error Tolerance and Resilience', () => {
    it('gracefully handles missing brain directory', async () => {
      // brain directory does not exist at all in mockFs
      const res = await parseAllTranscripts();
      expect(res.conversationsCount).toBe(0);
      expect(res.sessions.length).toBe(0);
    });

    it('gracefully handles missing transcript file inside session directory', async () => {
      mockFs.addDir(ANTIGRAVITY_BRAIN_DIR);
      const convDir = path.join(ANTIGRAVITY_BRAIN_DIR, 'session-no-transcript');
      mockFs.addDir(convDir);
      // Note: We do not add the logs directory or the transcript.jsonl file

      const res = await parseAllTranscripts();
      expect(res.conversationsCount).toBe(0);
      expect(mockFs.calls.readdir).toBe(1);
    });

    it('gracefully handles empty transcript file', async () => {
      mockFs.addDir(ANTIGRAVITY_BRAIN_DIR);
      const convDir = path.join(ANTIGRAVITY_BRAIN_DIR, 'session-empty');
      mockFs.addDir(convDir);
      const transcriptDir = path.join(convDir, '.system_generated', 'logs');
      mockFs.addDir(transcriptDir);
      const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
      mockFs.addFile(transcriptFile, ''); // Empty file

      const res = await parseAllTranscripts();
      expect(res.conversationsCount).toBe(1);
      expect(res.inputTokens).toBe(0);
      expect(res.outputTokens).toBe(0);
    });

    it('skips non-directory items in brain directory without failing', async () => {
      mockFs.addDir(ANTIGRAVITY_BRAIN_DIR);
      
      // Add a regular file directly inside brain directory
      const regularFile = path.join(ANTIGRAVITY_BRAIN_DIR, 'random-file.txt');
      mockFs.addFile(regularFile, 'some text');

      // Add a valid session directory
      const convDir = path.join(ANTIGRAVITY_BRAIN_DIR, 'valid-session');
      mockFs.addDir(convDir);
      const transcriptDir = path.join(convDir, '.system_generated', 'logs');
      mockFs.addDir(transcriptDir);
      const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
      mockFs.addFile(transcriptFile, JSON.stringify({ source: 'USER_EXPLICIT', content: 'test' }));

      const res = await parseAllTranscripts();
      expect(res.conversationsCount).toBe(1);
      expect(res.sessions[0].conversationId).toBe('valid-session');
    });

    it('handles malformed JSONL content by skipping corrupted lines', async () => {
      mockFs.addDir(ANTIGRAVITY_BRAIN_DIR);
      const convDir = path.join(ANTIGRAVITY_BRAIN_DIR, 'session-malformed');
      mockFs.addDir(convDir);
      const transcriptDir = path.join(convDir, '.system_generated', 'logs');
      mockFs.addDir(transcriptDir);
      const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
      
      const content = [
        'invalid json here',
        JSON.stringify({ source: 'USER_EXPLICIT', content: 'valid content' }), // 13 chars -> 4 tokens
        '{ incomplete json...',
        JSON.stringify({ source: 'MODEL', content: 'another response' }) // 16 chars -> 4 tokens
      ].join('\n');
      mockFs.addFile(transcriptFile, content);

      const res = await parseAllTranscripts();
      expect(res.conversationsCount).toBe(1);
      expect(res.inputTokens).toBe(4);
      expect(res.outputTokens).toBe(4);
    });

    it('isolates errors if reading one transcript file fails', async () => {
      mockFs.addDir(ANTIGRAVITY_BRAIN_DIR);
      
      // Session 1: will fail on read
      const convDir1 = path.join(ANTIGRAVITY_BRAIN_DIR, 'session-fail');
      mockFs.addDir(convDir1);
      const transcriptDir1 = path.join(convDir1, '.system_generated', 'logs');
      mockFs.addDir(transcriptDir1);
      const transcriptFile1 = path.join(transcriptDir1, 'transcript.jsonl');
      mockFs.addFile(transcriptFile1, 'mock content');
      mockFs.setReadError(transcriptFile1, new Error('Permission Denied'));

      // Session 2: valid
      const convDir2 = path.join(ANTIGRAVITY_BRAIN_DIR, 'session-ok');
      mockFs.addDir(convDir2);
      const transcriptDir2 = path.join(convDir2, '.system_generated', 'logs');
      mockFs.addDir(transcriptDir2);
      const transcriptFile2 = path.join(transcriptDir2, 'transcript.jsonl');
      mockFs.addFile(transcriptFile2, JSON.stringify({ source: 'USER_EXPLICIT', content: 'ok content' })); // 10 chars -> 3 tokens

      const res = await parseAllTranscripts();
      // Only the OK session is counted successfully
      expect(res.conversationsCount).toBe(1);
      expect(res.inputTokens).toBe(3);
      expect(res.sessions.length).toBe(1);
      expect(res.sessions[0].conversationId).toBe('session-ok');
    });
  });

  describe('Stress / High Volume Performance', () => {
    it('efficiently parses 150 directories concurrently without crashing', async () => {
      mockFs.addDir(ANTIGRAVITY_BRAIN_DIR);
      
      const count = 150;
      for (let i = 0; i < count; i++) {
        const convId = `session-${i}`;
        const convDir = path.join(ANTIGRAVITY_BRAIN_DIR, convId);
        mockFs.addDir(convDir);
        const transcriptDir = path.join(convDir, '.system_generated', 'logs');
        mockFs.addDir(transcriptDir);
        const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
        
        mockFs.addFile(transcriptFile, JSON.stringify({
          source: 'USER_EXPLICIT',
          content: `stress test content for directory ${i}`
        }));
      }

      const start = performance.now();
      const res = await parseAllTranscripts();
      const duration = performance.now() - start;

      expect(res.conversationsCount).toBe(count);
      expect(res.sessions.length).toBe(count);
      
      // Performance constraint: should process 150 files very quickly in memory (typically < 30ms)
      expect(duration).toBeLessThan(100);
      
      const beforeCachedReads = mockFs.calls.readFile;

      // Verify caching is fast and does not trigger new read operations
      const startCached = performance.now();
      const resCached = await parseAllTranscripts();
      const durationCached = performance.now() - startCached;
      
      expect(resCached.conversationsCount).toBe(count);
      expect(mockFs.calls.readFile).toBe(beforeCachedReads); // No new read operations
      expect(durationCached).toBeLessThan(50); // Loose upper bound for cached run
    });
  });
});
