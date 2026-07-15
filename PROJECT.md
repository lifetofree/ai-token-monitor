# Project: AI Token Monitor - Async Parser Optimization

## Architecture
- **lib/antigravity-parser.js**: Scans `~/.gemini/antigravity-cli/brain` directory, stats the session transcripts, caches unchanged ones, parses changed transcripts asynchronously, and calculates token/cost metrics.
- **server.js**: Runs the HTTP server, handles API requests, and synchronizes agent session usage metrics into the SQLite database.
- **SQLite Database**: Table `agent_usage` stores conversation metrics.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration & Baseline | Run existing tests, analyze current synchronous implementation | none | DONE |
| 2 | Async Parser Refactoring | Rewrite `lib/antigravity-parser.js` using async/await and promises, implement mtime caching and path optimization | M1 | DONE |
| 3 | Server Integration | Update `syncAgentUsage` in `server.js` to handle async parser, ensuring zero sync filesystem calls | M2 | DONE |
| 4 | Test Suite & Verification | Update `tests/antigravityParser.test.js` to test async APIs, verify all tests pass | M3 | DONE |
| 5 | Integrity Audit | Run Forensic Auditor to verify no integrity violations and all criteria met | M4 | DONE |

## Interface Contracts
### `lib/antigravity-parser.js` API
- `parseTranscriptFile(filePath)`:
  - Returns: `Promise<{ inputTokens: number, outputTokens: number, cachedTokens: number, totalCost: number }>`
- `parseAllTranscripts()`:
  - Returns: `Promise<{ conversationsCount: number, inputTokens: number, outputTokens: number, cachedTokens: number, totalCost: number, sessions: Array }>`
- `_setFs(mockFs)`:
  - Configures the module to use a mocked filesystem object. Must support Promise-based methods or we adapt the mock helper.

## Code Layout
- `lib/antigravity-parser.js`: Parser implementation.
- `server.js`: Server and sync loop.
- `tests/antigravityParser.test.js`: Parser tests.
