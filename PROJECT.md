# Project: AI Token Monitor - Async Parser Optimization

## Architecture
- **lib/antigravity-parser.js**: Scans `~/.gemini/antigravity-cli/brain` directory, stats the session transcripts, caches unchanged ones, parses changed transcripts asynchronously, and calculates token/cost metrics. When `GEMINI_API_KEY` is set in `.env`, each unique string is counted via the Gemini `countTokens` API with a process-local cache; otherwise the chars/4 heuristic is used.
- **lib/antigravity-context.js**: Resolves the active Antigravity CLI session's context-window consumption against the 1M Gemini token budget (overridable via `GEMINI_CONTEXT_WINDOW`). Returns the payload shape consumed by `/api/agent-usage`.
- **server.js**: Runs the HTTP server, handles API requests, and synchronizes agent session usage metrics into the SQLite database. On boot reads `GEMINI_API_KEY` from `.env` and hands it to the parser.
- **SQLite Database**: Table `agent_usage` stores per-conversation metrics (one row per `conversation_id`).

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration & Baseline | Run existing tests, analyze current synchronous implementation | none | DONE |
| 2 | Async Parser Refactoring | Rewrite `lib/antigravity-parser.js` using async/await and promises, implement mtime caching and path optimization | M1 | DONE |
| 3 | Server Integration | Update `syncAgentUsage` in `server.js` to handle async parser, ensuring zero sync filesystem calls | M2 | DONE |
| 4 | Test Suite & Verification | Update `tests/antigravityParser.test.js` to test async APIs, verify all tests pass | M3 | DONE |
| 5 | Integrity Audit | Run Forensic Auditor to verify no integrity violations and all criteria met | M4 | DONE |
| 6 | Real Token Counting (Gemini countTokens API) | Add the Gemini countTokens API path to `lib/antigravity-parser.js` with a process-local cache and try/catch fallback to chars/4; add 5 new tests; commit `1bb20bc` | M2 | DONE |
| 7 | Active-Session Context Window | Add `lib/antigravity-context.js` (active-session filter, 1M default size, env override); expose via `/api/agent-usage`; render Session Memory bar on Antigravity card; 6 new tests; commit `8e23249` | M3, M6 | DONE |
| 8 | Restore % Bars on Antigravity Card | Drop the `isAntiqravity` ternary so the gemini card uses the same two-bar template as the other three brands; remove dead locals; commit `8ee1283` | M7 | DONE |

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
