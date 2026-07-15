# Handoff Report: Antigravity Parser Async Refactoring Plan

## 1. Observation

### Current Synchronous Implementations

#### A. In `lib/antigravity-parser.js`
The following synchronous methods are used for I/O:
* `existsSync` for checking file existence.
* `readFileSync` for reading transcript contents.
* `readdirSync` for listing the brain directory.
* `statSync` for reading directory and transcript file stats (like `mtimeMs`).

Verbatim code lines:
```javascript
// Lines 30-36
try {
  if (!fsRef.existsSync(filePath)) {
    return stats;
  }

  const content = fsRef.readFileSync(filePath, 'utf-8');
```

```javascript
// Lines 91-121
try {
  if (!fsRef.existsSync(ANTIGRAVITY_BRAIN_DIR)) {
    return aggregated;
  }

  const items = fsRef.readdirSync(ANTIGRAVITY_BRAIN_DIR);

  items.forEach(item => {
    const dirPath = path.join(ANTIGRAVITY_BRAIN_DIR, item);
    const stat = fsRef.statSync(dirPath);

    if (stat.isDirectory()) {
      const transcriptPath = path.join(dirPath, '.system_generated', 'logs', 'transcript.jsonl');
      
      if (fsRef.existsSync(transcriptPath)) {
        const stats = parseTranscriptFile(transcriptPath);
        
        aggregated.conversationsCount++;
        // ...
        aggregated.sessions.push({
          conversationId: item,
          lastModified: fsRef.statSync(transcriptPath).mtimeMs,
          ...stats
        });
      }
    }
  });
```

#### B. In `server.js`
`parseAllTranscripts` is run synchronously on startup and periodically within the event loop via `syncAgentUsage`:
```javascript
// Lines 610-611
ensureAgentUsageTable();
syncAgentUsage();
setInterval(syncAgentUsage, 2 * 60 * 1000);
```

```javascript
// Lines 668-697
function syncAgentUsage() {
  const data = parseAllTranscripts();
  if (!data || !data.sessions || data.sessions.length === 0) return;

  let pendingQueries = 0;
  data.sessions.forEach(session => {
    if (_agentMtimeCache.get(session.conversationId) === session.lastModified) return;

    pendingQueries++;
    const query = `INSERT OR REPLACE INTO agent_usage (conversation_id, last_updated, input_tokens, output_tokens, cached_tokens, total_cost) VALUES (
      ${escapeSQLString(session.conversationId)},
      ${escapeSQLNumber(session.lastModified)},
      ${escapeSQLNumber(session.inputTokens)},
      ${escapeSQLNumber(session.outputTokens)},
      ${escapeSQLNumber(session.cachedTokens)},
      ${escapeSQLFloat(session.totalCost)}
    );`;
    execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, query], (error) => {
      pendingQueries--;
      if (error) {
        console.error(`Failed to sync agent session ${session.conversationId}:`, error);
      } else {
        _agentMtimeCache.set(session.conversationId, session.lastModified);
        if (pendingQueries === 0) {
          triggerFirebaseUpdate();
        }
      }
    });
  });
}
```

#### C. In `tests/antigravityParser.test.js`
The unit tests mock the standard synchronous `fs` methods:
```javascript
// Lines 6-23
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
```

---

## 2. Logic Chain

1. **Event Loop Blocking**: Since `parseAllTranscripts()` is called inside `syncAgentUsage` which runs every 2 minutes directly on the server thread, any file read, directory listing, or file stat operation blocks the single-threaded Node.js event loop.
2. **FileSystem Call Reduction**:
   - Currently, processing a conversation directory requires `fsRef.statSync(dirPath)` (to check if it's a directory), `fsRef.existsSync(transcriptPath)` (to check if the transcript file exists), `fsRef.existsSync(transcriptPath)` (repeated inside `parseTranscriptFile`), `fsRef.readFileSync(transcriptPath)` (to read the file), and `fsRef.statSync(transcriptPath).mtimeMs` (to get the mtime).
   - We can optimize this sequence down to **one single `stat` call** per unchanged conversation. If `fs.promises.stat(transcriptPath)` is successful, we verify it exists, get its `mtimeMs`, and check against the cache. Only if `mtimeMs` differs do we perform the `fs.promises.readFile` call.
3. **Module-Level Caching**:
   - Introducing an in-memory `Map` inside `lib/antigravity-parser.js` matching `conversationId` to `{ mtimeMs, stats }` allows `parseAllTranscripts` to return cached results instantly.
   - Since `server.js` maintains its own `_agentMtimeCache` before inserting to SQLite, this parser-level caching ensures we also skip the raw file parsing overhead itself, completely eliminating unnecessary parsing execution.
4. **Mocking Promises in Test Suite**:
   - Because our new implementation will use `fs.promises` (or `fsRef.promises`), we must replace the mocked synchronous functions with mocked promise-resolving functions.
   - Vitest's `vi.mock('fs')` must provide a mocked `promises` object containing `stat`, `readdir`, and `readFile`.

---

## 3. Caveats

* **In-Memory Cache Lifecycle**: The parser's cache will reside in memory inside the module instance. When the server restarts, this cache is flushed, and the next run will parse all files once. This is expected behavior and ensures the cache never gets corrupt or out of sync with actual files on disk.
* **Concurrency Limits**: `Promise.all` executes filesystem requests in parallel. If the number of conversations in the brain directory reaches thousands, this could exhaust file descriptors. Given that this is a developer dashboard CLI with a typically modest number of local conversations, `Promise.all` is suitable. We do not need a throttled semaphore pool unless the brain size scales exceptionally large.

---

## 4. Conclusion

### Actionable Refactoring Plan & Code Blueprints

#### Phase 1: Refactor `lib/antigravity-parser.js` to Async

**Signature Changes:**
* `parseTranscriptFile(filePath)`: `function` $\rightarrow$ `async function`. Returns `Promise<stats>`.
* `parseAllTranscripts()`: `function` $\rightarrow$ `async function`. Returns `Promise<aggregated>`.

**Proposed Code Structure (`lib/antigravity-parser.js`):**

```javascript
// lib/antigravity-parser.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const ANTIGRAVITY_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

let fsRef = fs;

// Parser-level cache to skip reading and parsing unchanged transcript files.
const parserCache = new Map(); // key: conversationId, value: { mtimeMs, stats }

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Parses a single JSONL transcript file and aggregates estimated tokens (Async).
 */
async function parseTranscriptFile(filePath) {
  const stats = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalCost: 0
  };

  try {
    const content = await fsRef.promises.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    lines.forEach(line => {
      if (!line.trim()) return;

      try {
        const step = JSON.parse(line);
        if (step.source === 'USER_EXPLICIT' || step.source === 'SYSTEM') {
          const text = step.content || '';
          stats.inputTokens += estimateTokens(text);
        } else if (step.source === 'MODEL' || step.source === 'SUBAGENT') {
          const text = step.content || '';
          stats.outputTokens += estimateTokens(text);

          if (step.tool_calls && Array.isArray(step.tool_calls)) {
            step.tool_calls.forEach(tc => {
              if (tc.args) {
                stats.outputTokens += estimateTokens(JSON.stringify(tc.args));
              }
            });
          }
        }
      } catch (err) {
        // Skip malformed lines
      }
    });

    stats.totalCost = ((stats.inputTokens * 1.25) + (stats.outputTokens * 5.00)) / 1000000;

  } catch (error) {
    if (error.code === 'ENOENT') {
      return stats; // Return empty stats if file is missing
    }
    console.error(`Error parsing transcript file ${filePath}:`, error);
  }

  return stats;
}

/**
 * Scans the brain directory and aggregates stats across all conversations (Async).
 */
async function parseAllTranscripts() {
  const aggregated = {
    conversationsCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalCost: 0,
    sessions: []
  };

  try {
    let items;
    try {
      items = await fsRef.promises.readdir(ANTIGRAVITY_BRAIN_DIR);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return aggregated;
      }
      throw err;
    }

    const promises = items.map(async (item) => {
      const dirPath = path.join(ANTIGRAVITY_BRAIN_DIR, item);
      try {
        const dirStat = await fsRef.promises.stat(dirPath);
        if (!dirStat.isDirectory()) return;

        const transcriptPath = path.join(dirPath, '.system_generated', 'logs', 'transcript.jsonl');
        
        let fileStat;
        try {
          // A single stat call retrieves file metadata and verifies existence
          fileStat = await fsRef.promises.stat(transcriptPath);
        } catch (err) {
          // File does not exist, ignore directory
          return;
        }

        const lastModified = fileStat.mtimeMs;
        let stats;

        // Cache hit check
        const cached = parserCache.get(item);
        if (cached && cached.mtimeMs === lastModified) {
          stats = cached.stats;
        } else {
          stats = await parseTranscriptFile(transcriptPath);
          parserCache.set(item, { mtimeMs: lastModified, stats });
        }

        return {
          conversationId: item,
          lastModified,
          stats
        };
      } catch (err) {
        console.error(`Error processing conversation ${item}:`, err);
      }
    });

    const results = await Promise.all(promises);

    results.forEach(res => {
      if (!res) return;
      aggregated.conversationsCount++;
      aggregated.inputTokens += res.stats.inputTokens;
      aggregated.outputTokens += res.stats.outputTokens;
      aggregated.cachedTokens += res.stats.cachedTokens;
      aggregated.totalCost += res.stats.totalCost;

      aggregated.sessions.push({
        conversationId: res.conversationId,
        lastModified: res.lastModified,
        ...res.stats
      });
    });

  } catch (error) {
    console.error('Error scanning Antigravity brain directory:', error);
  }

  return aggregated;
}

module.exports = {
  parseTranscriptFile,
  parseAllTranscripts,
  _setFs: (mockFs) => { fsRef = mockFs; }
};
```

---

#### Phase 2: Refactor `server.js` Integration

`syncAgentUsage` will be converted to an async function, preserving current query flow, but awaiting the async parsing step.

**Proposed Code Structure (`server.js`):**

```javascript
// server.js updates

// Changes in the server startup flow:
server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Token Monitor running at http://localhost:${PORT}/`);
  initWatcher(DB_PATH, (cmds) => {
    triggerFirebaseUpdate(cmds);
  });
  ensureBrandQuotaTable();
  ensureBrandColumn();
  ensureAgentUsageTable();
  
  // Call the async function, catching errors
  syncAgentUsage().catch(err => console.error('Initial agent usage sync failed:', err));
  
  // Periodically invoke the async sync
  setInterval(() => {
    syncAgentUsage().catch(err => console.error('Periodic agent usage sync failed:', err));
  }, 2 * 60 * 1000);

  // ... rest of listening hook
});

// Update function signature to async
async function syncAgentUsage() {
  try {
    const data = await parseAllTranscripts();
    if (!data || !data.sessions || data.sessions.length === 0) return;

    let pendingQueries = 0;
    data.sessions.forEach(session => {
      if (_agentMtimeCache.get(session.conversationId) === session.lastModified) return;

      pendingQueries++;
      const query = `INSERT OR REPLACE INTO agent_usage (conversation_id, last_updated, input_tokens, output_tokens, cached_tokens, total_cost) VALUES (
        ${escapeSQLString(session.conversationId)},
        ${escapeSQLNumber(session.lastModified)},
        ${escapeSQLNumber(session.inputTokens)},
        ${escapeSQLNumber(session.outputTokens)},
        ${escapeSQLNumber(session.cachedTokens)},
        ${escapeSQLFloat(session.totalCost)}
      );`;
      execFile('sqlite3', ['-cmd', '.timeout 5000', DB_PATH, query], (error) => {
        pendingQueries--;
        if (error) {
          console.error(`Failed to sync agent session ${session.conversationId}:`, error);
        } else {
          _agentMtimeCache.set(session.conversationId, session.lastModified);
          if (pendingQueries === 0) {
            triggerFirebaseUpdate();
          }
        }
      });
    });
  } catch (error) {
    console.error('Error in syncAgentUsage:', error);
  }
}
```

---

#### Phase 3: Mocking Promises in Unit Tests

**Proposed Test Structure (`tests/antigravityParser.test.js`):**

```javascript
// tests/antigravityParser.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { parseTranscriptFile, parseAllTranscripts, _setFs } from '../lib/antigravity-parser';

// Define standard mock functions
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
  });

  describe('parseTranscriptFile', () => {
    it('returns empty stats if file does not exist', async () => {
      // Mock fs.promises.readFile throwing ENOENT
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
              args: { CommandLine: 'git status' } // ~30 chars -> 8 tokens
            }
          ]
        })
      ].join('\n');
      
      mockReadFile.mockResolvedValue(mockJsonl);

      const stats = await parseTranscriptFile('/path/to/mock/file.jsonl');
      expect(stats.inputTokens).toBe(3);
      expect(stats.outputTokens).toBe(14);
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
  });

  describe('parseAllTranscripts', () => {
    it('aggregates multiple conversation directories with caching', async () => {
      mockReaddir.mockResolvedValue(['conv1', 'conv2']);
      
      // First stat for dir, second stat for transcript file
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

      const aggregated = await parseAllTranscripts();
      expect(aggregated.conversationsCount).toBe(2);
      expect(aggregated.inputTokens).toBe(2);
      expect(aggregated.sessions.length).toBe(2);
      expect(aggregated.sessions[0].conversationId).toBe('conv1');
    });
  });
});
```

---

## 5. Verification Method

To independently verify this design plan:
1. Review the proposed blueprints for signature compliance against the `PROJECT.md` contracts.
2. Verify that mock structures correctly return Promises for all nested `fs.promises` calls in Vitest.
3. Validate that standard build, lint, and test validation commands will pass:
   ```bash
   rtk npm test
   rtk npm run check
   ```
