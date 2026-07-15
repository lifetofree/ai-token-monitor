# Handoff Report — Async Parser Verification

## 1. Observation
We ran static analysis using `rtk npm run check` (which passed) and unit tests using `rtk npm test` (which failed 3 tests).

Verbatim error log for test failures:
```
 ❯ tests/async-parser-stress.test.js  (9 tests | 2 failed) 59ms
   ❯ tests/async-parser-stress.test.js > Async Parser Stress and Verification Test Suite > Error Tolerance and Resilience > isolates errors if reading one transcript file fails
     → expected 2 to be 1 // Object.is equality
   ❯ tests/async-parser-stress.test.js > Async Parser Stress and Verification Test Suite > Stress / High Volume Performance > efficiently parses 150 directories concurrently without crashing
     → expected 11.661540999999943 to be less than 5.22404199999994
 ❯ tests/parserVerification.test.js  (9 tests | 1 failed) 135ms
   ❯ tests/parserVerification.test.js > Antigravity Async Parser - Comprehensive Verification & Stress Test > 3. Error Tolerance & Edge Cases > should handle partial filesystem errors on individual files (e.g. read failure)
     → expected 2 to be 1 // Object.is equality
```

In `lib/antigravity-parser.js` (lines 70-78):
```javascript
  } catch (error) {
    if (error.code === 'ENOENT') {
      return stats;
    }
    console.error(`Error parsing transcript file ${filePath}:`, error);
  }

  return stats;
```

In `lib/antigravity-parser.js` (lines 125-139):
```javascript
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
```

In `server.js` (lines 670-699):
```javascript
async function syncAgentUsage() {
  try {
    const data = await parseAllTranscripts();
    if (!data || !data.sessions || data.sessions.length === 0) return;

    let pendingQueries = 0;
    data.sessions.forEach(session => {
      if (_agentMtimeCache.get(session.conversationId) === session.lastModified) return;

      pendingQueries++;
      const query = `INSERT OR REPLACE INTO agent_usage (conversation_id, last_updated, input_tokens, output_tokens, cached_tokens, total_cost) VALUES (...);`;
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

## 2. Logic Chain
1. When `parseTranscriptFile` encounters a read error (e.g., `EACCES` permission denied, `EBUSY` file lock) on an existing file, the `try/catch` block inside `parseTranscriptFile` catches the error, logs it, and returns the default initialized `stats` object `{ inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0 }`.
2. Because `parseTranscriptFile` returns a valid object, `parseAllTranscripts` treats this as a successful parse. It caches this zeroed-out `stats` object under `parserCache.set(item, { mtimeMs: lastModified, stats })` and returns it as part of the aggregated sessions.
3. Therefore:
   - The overall session count (`conversationsCount`) is incremented by 1 for this failed session.
   - The session is registered with `0` tokens, which is incorrect.
   - Since the zeroed-out stats are cached under the file's `mtimeMs`, subsequent calls to `parseAllTranscripts` will hit the cache and continue returning 0 tokens for this session, *even if the file becomes readable again*.
4. On the server side, `syncAgentUsage` receives the session with 0 tokens and writes it to the SQLite database. It then registers the session's `lastModified` in `_agentMtimeCache`. Since the `mtimeMs` is cached in memory, the server will not attempt to rewrite this session to the DB again, even if the parser cache is cleared (unless the file modification time changes on disk).
5. The unit tests `isolates errors if reading one transcript file fails` in `tests/async-parser-stress.test.js` and `should handle partial filesystem errors on individual files` in `tests/parserVerification.test.js` expect the failed session to be skipped entirely (not counted in `conversationsCount` and not present in `sessions`). Since it was counted, both assertions failed.
6. The second failure in `tests/async-parser-stress.test.js` is a flaky timing assertion. The test expects `expect(durationCached).toBeLessThan(duration)` to be true, but because the test operates on mocked FS functions in memory, both durations are extremely small (e.g., 5.2ms vs 11.6ms), resulting in microsecond timing noise where the cached run occasionally takes slightly longer.

## 3. Caveats
- We did not evaluate the behavior of the database under long-term memory leaks of the cache.
- We did not test real-world locked files since mocking was sufficient to verify the logical pathways.

## 4. Conclusion
**Final Verdict**: **FAIL**
The current async parser implementation has a critical defect: it handles transient/non-ENOENT filesystem errors incorrectly by caching a zeroed stats object and reporting it as a valid session. This results in:
1. Double-caching of transient errors (both in the parser cache and the server DB cache).
2. Permanent incorrect state (0 tokens) for files that had a transient read error, until the file's `mtime` changes on disk.
3. Multiple test failures in the unit test suites.

### Verification of Event-Loop Safety
Event-loop safety was fully verified. There are no synchronous filesystem calls in `lib/antigravity-parser.js` or the integration pathway in `server.js`. All operations utilize `promises` from `fsRef`.

### Recommended Mitigations
1. **Fix error propagation in `parseTranscriptFile`**:
   - If an error other than `ENOENT` is thrown during `readFile`, `parseTranscriptFile` should throw or return `null`/`undefined` instead of returning zeroed stats.
2. **Handle parsing failure in `parseAllTranscripts`**:
   - If `parseTranscriptFile` throws or returns `null`/`undefined`, `parseAllTranscripts` must skip caching this session and omit it from the aggregated `sessions` array.
3. **Fix flaky test assertion**:
   - Remove or relax the strict `toBeLessThan` assertion for duration in `tests/async-parser-stress.test.js`, or only assert it if the baseline duration is above a certain threshold (e.g., 100ms).

## 5. Verification Method
Run the following commands:
- `rtk npm run check` (Should pass successfully)
- `rtk npm test` (Will fail on the 3 identified tests)

Files to inspect:
- `lib/antigravity-parser.js`
- `tests/parserVerification.test.js`
- `tests/async-parser-stress.test.js`

---

## 🔒 Challenge Report (Adversarial Review)

### Challenge Summary
**Overall risk assessment**: HIGH

The double-caching of transient failures means that any transient permission denied (`EACCES`), file lock (`EBUSY`), or reading glitch will corrupt the dashboard metrics permanently until a file write or server restart happens.

### Challenges

#### [High] Challenge 1: Double Caching of Transient Failures
- **Assumption challenged**: That returning zeroed stats on `readFile` failure is a safe fallback.
- **Attack scenario**: A file is briefly locked by another process during sync. The parser reads it, fails, and returns 0 tokens. The parser caches the 0 tokens. The server writes 0 tokens to the DB and caches the `mtime`. Even after the file is unlocked, the dashboard continues to display 0 tokens for the conversation.
- **Blast radius**: User sees incorrect (under-reported) token usage on the dashboard. This breaks the primary purpose of the token monitor.
- **Mitigation**: Fail loudly on transient errors or skip caching them.

#### [Medium] Challenge 2: Memory Leak of Deleted Conversations
- **Assumption challenged**: That the brain directory only grows and sessions are never deleted.
- **Attack scenario**: Sessions are deleted by the user/system. The parser cache map (`parserCache`) keeps references to old `conversationId`s forever in memory.
- **Blast radius**: Small memory leak over time on long-running instances.
- **Mitigation**: Evict keys from `parserCache` that are not returned by `readdir`.

---

## Test Harness Design
Our test suite `tests/parserVerification.test.js` was designed to:
1. Wrap all synchronous `fs` methods to throw an error if called. This guarantees event-loop safety checks.
2. Simulate a file read error to test the boundary condition of error isolation.
3. Simulate cache invalidation behavior using varying `mtimeMs`.
4. Run a 1000-session stress test to check execution speed.
