# Improvement Plan

> Roles: Product Owner · Product Manager · Tech Lead  
> Date: 2026-06-12  
> Scope: Full codebase review — `server.js`, `app.js`, `lib/`, `firmware/`, `tests/`, `docs/`

---

## 1. Executive Summary

The project delivers on its core vision: a real-time, single-user LLM spend dashboard with provider-quota awareness and an ESP32 companion display. The architecture is intentionally minimal (no bundler, no framework, single file per layer) and that is correct for the stated scope. What follows are the gaps that reduce reliability, maintainability, or accuracy — ordered by impact.

**Three headline findings:**

1. **Simulation mode is a regression** — the toggle button is `display:none` in `index.html`, making Simulation (a v1 must-have per `BUSINESS_GOALS.md`) inaccessible without editing HTML.
2. **`server.js` at 1,400 lines has accrued significant dead weight** — `getRtkSpendMetrics()` is called 3–4 times per seed cycle, `loadEnv()` twice, and the MiniMax fetcher scans all commands from the beginning of time on every refresh.
3. **Dead code in `app.js`** — `triggerSilentQuotaSync()` is never called, `state.requests` (simulation store) is never rendered, and the documented `Request.source` / `state.monitorMode` fields are never populated.

---

## 2. PO Layer — Business Value Gaps

These gaps affect whether the dashboard fulfills its stated success criteria.

### P1 — Simulation mode is inaccessible (regression against must-have #10)

**File:** `index.html:37`  
```html
<button id="toggle-sim-btn" ... style="display:none;">
```
`BUSINESS_GOALS.md` explicitly lists "the mode switcher in the header is visible" as a v1 must-have. The button is hidden. Users cannot switch to Simulation mode without editing the HTML.

**Action:** Remove `style="display:none;"` from `toggle-sim-btn`. Verify simulation starts/stops correctly.

---

### P2 — Browser notification at 90% is unimplemented (deferred but high-value)

**File:** `BUSINESS_GOALS.md` (nice-to-have #1)  
The dashboard has no alert when a brand approaches a quota hard stop. A user working through the ESP32 display could miss a red bar.

**Action:** Add a `Notification.requestPermission()` opt-in during init. Fire a desktop notification when `barPct` crosses `ROLLING_LIMIT_DANGER_PCT = 90` for any brand. Debounce to once per 30-minute window per brand.

---

### P3 — `meta.limit` and `meta.windowLabel` are dead schema fields

**File:** `app.js:24–28`  
Tracked in `REVIEWS.md R3` and `ADR-0004`. These fields exist in `DEFAULT_BRAND_METADATA` and are migrated into `localStorage` on every load, but they drive no rendered output. `windowLabel` is used in card HTML but its value is always `'5-Hour'` — the label is constant, not configurable.

**Action:** Remove `meta.limit` and `meta.windowLabel` from `DEFAULT_BRAND_METADATA`. Replace the single `windowLabel` reference in `renderBrandCards` with the string literal `'5-Hour'`. Update `REVIEWS.md` R3 to closed.

---

## 3. PM Layer — Feature & UX Gaps

### F1 — `Request.source` is documented but never set

**File:** `app.js` (all Request-building sites), `SYSTEM_DESIGN.md §3.2`  
The design document defines `source: 'real' | 'sim'` and states it is "set to `'real'` by `fetchRealRTKData()` and `connectRTKStream()`". It is not. Every constructed Request object omits the `source` field entirely.

**Action:** Add `source: 'real'` to the Request literal in `fetchRealRTKData` and `connectRTKStream`. Add `source: 'sim'` to `addRequest` and `generateInitialMockHistory`. Update `getActiveRequests()` to filter by `source === 'real'` instead of always returning `state.realCommands`.

---

### F2 — `state.monitorMode` is documented but absent from state

**File:** `app.js:31–39`, `SYSTEM_DESIGN.md §3.5`  
The design documents `atm_monitor_mode` localStorage key and `state.monitorMode`, but neither exists in the actual `state` initializer. `getActiveRequests()` hard-returns `state.realCommands` unconditionally, making Simulation mode non-functional even if the button were visible.

**Action:** Add `monitorMode: localStorage.getItem('atm_monitor_mode') || 'real'` to the `state` object. Update `getActiveRequests()` to `return state.monitorMode === 'sim' ? state.requests : state.realCommands`. Wire the toggle button to flip `state.monitorMode` and persist to `localStorage`.

---

### F3 — `.env` writer drops non-whitelisted keys (known bug, tracked R3)

**File:** `server.js:184`, `server.js:211`  
Both `POST /api/env/key` and `POST /api/env` reconstruct `.env` from the four-key whitelist only. Any key outside that set (`RTK_DB_PATH`, `FIREBASE_URL`, `FIREBASE_AUTH`, `FIREBASE_DB_SECRET`) is silently dropped on the next save. This is a data-loss bug.

**Action:** In both writers, read the full existing `.env` into a map first, then merge only the allowed keys into it, then write the full merged map back. Non-whitelisted keys are preserved unchanged. Update `REVIEWS.md` R3 to closed.

---

### F4 — SYSTEM_DESIGN.md folder structure is stale

**File:** `docs/SYSTEM_DESIGN.md §2`  
The document says "There is no `src/`, no `tests/`, no `dist/`." Both `lib/` and `tests/` now exist. Server line count is listed as ~750; actual is ~1,400.

**Action:** Update §2 folder structure to include `lib/` and `tests/`. Update server line count. Note the `window_started_at` column added to `brand_quota` table in §2 table.

---

## 4. Tech Lead Layer — Code Quality & Architecture

### T1 — `getRtkSpendMetrics()` called 3–4 times per seed cycle (performance)

**File:** `server.js:703` (publishToFirebase), `server.js:1016` (fetchClaudeQuota), `server.js:1193` (fetchGLMQuota)

Each call opens `sqlite3`, reads the full `commands` table, and scans every row in process. On a seed cycle: `publishToFirebase` calls it once, and inside `seedBrandQuotas`, `fetchClaudeQuota` and `fetchGLMQuota` each call it independently — totalling 3 full DB reads per cycle.

**Action:** Call `getRtkSpendMetrics()` once at the top of `seedBrandQuotas()`, pass the result into `fetchClaudeQuota(apiKey, rtkSpend)` and `fetchGLMQuota(apiKey, rtkSpend)` as a second argument. Remove the internal calls from those fetchers. Pass the same result into `publishToFirebase(results, rtkSpend)`.

---

### T2 — `getRtkSpendMetrics()` scans the entire command history (performance)

**File:** `server.js:840`
```js
const query = `SELECT timestamp, original_cmd, input_tokens, output_tokens, saved_tokens FROM commands ORDER BY id ASC`;
```
No `WHERE` clause. On a mature DB with thousands of rows, this scans all of them to compute 5h and 7d windows. Only rows within the last 7 days matter.

**Action:** Add `WHERE timestamp >= datetime('now', '-7 days')` to the query. This reduces the result set to at most one week of data regardless of total history size.

---

### T3 — `loadEnv()` called redundantly per seed cycle

**File:** `server.js:569` (seedBrandQuotas), `server.js:690` (publishToFirebase)

`seedBrandQuotas` calls `loadEnv()` to get API keys, then calls `publishToFirebase(results)` which calls `loadEnv()` again for Firebase credentials. Two file reads per cycle.

**Action:** Merge the two `loadEnv()` calls — pass `env` as a parameter to `publishToFirebase(results, env)` from `seedBrandQuotas`.

---

### T4 — Dead function: `triggerSilentQuotaSync()` is never called

**File:** `app.js:1140–1171`

The function exists, takes a `brandKey` parameter it never uses internally (the POST body does not include `brandKey`), and is never invoked anywhere in the codebase. It's likely a leftover from an earlier design.

**Action:** Delete `triggerSilentQuotaSync()` entirely.

---

### T5 — Dead store: `state.requests` is never rendered

**File:** `app.js:1173–1175`
```js
function getActiveRequests() {
  return state.realCommands;
}
```
`state.requests` (the simulation store) is populated, persisted to `localStorage`, and truncated — but `getActiveRequests()` always returns `state.realCommands`. The simulation data is computed but never displayed. This is a consequence of F2 (missing `monitorMode`). Fix T4 and F2 together.

**Note:** This is resolved by F2. Tracking here for completeness.

---

### T6 — `isWeeklyEntry` has an unused parameter

**File:** `server.js:1339`
```js
function isWeeklyEntry(entry, fiveH_MS, sevenD_MS) {
  // fiveH_MS is never read inside the function body
  const delta = endMs - startMs;
  return delta >= sevenD_MS / 2 && delta <= sevenD_MS * 2;
}
```
This generates the TS diagnostic `'fiveH_MS' is declared but its value is never read.`

**Action:** Remove the `fiveH_MS` parameter. Update the two call sites to pass only `(entry, sevenD_MS)`.

---

### T7 — `antigravity-parser.js` hardcodes the user's home directory path

**File:** `lib/antigravity-parser.js:5`
```js
const ANTIGRAVITY_BRAIN_DIR = '/Users/lifetofree/.gemini/antigravity-cli/brain';
```
Hardcoded absolute path. Will silently return empty results if deployed on any other machine or if the username changes.

**Action:** Replace with:
```js
const os = require('os');
const ANTIGRAVITY_BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
```

---

### T8 — `syncAgentUsage()` rescans all transcript files every 2 minutes (performance)

**File:** `server.js:501–520`

`parseAllTranscripts()` walks the brain directory, reads every `.jsonl` file, and counts tokens from scratch on every 2-minute tick. There is no incremental update based on file modification time.

**Action:** Track the `mtimeMs` of each file across calls. In `syncAgentUsage`, skip files whose `mtime` matches the last-seen value. Only re-parse files that have changed. Cache the per-file stats in memory.

---

### T9 — Duplicate `detectBrand` logic between client and server

**File:** `app.js:1337–1344` vs `server.js:883–890`

Two independent implementations with diverging logic:
- Client (`detectBrand`): returns `'claude'` as a hard default even when `cmd` is null/undefined.
- Server (`detectSpecificBrand`): explicit match, `'claude'` as fallback for unmatched strings.

The client version will misclassify a null/empty `cmd` as Claude; the server version also does so but documents the reason ("unmatched = Claude Code tool calls"). No shared source of truth.

**Action:** Move the brand-detection regex table to a shared constant object. Since this runs in Node (server) and browser (client), the simplest approach is to inline the agreed-upon logic in both places but add a comment cross-referencing the server counterpart, and add a unit test that runs both against the same fixture data. Long term: expose it via `/api/rtk` metadata so the client doesn't need to re-implement it.

---

### T10 — `server.js` at 1,400 lines should be split into modules

**File:** `server.js`

The file contains HTTP routing, SQLite helpers, four brand fetchers, RTK metrics computation, Firebase publishing, env I/O, and SSE watcher logic — all in one flat file. This makes targeted testing difficult and PR diffs noisy.

**Proposed split:**

| Module | What goes there |
|---|---|
| `lib/brand-fetchers.js` | `fetchClaudeQuota`, `fetchGeminiQuota`, `fetchGLMQuota`, `fetchMinimaxQuota`, `BRAND_FETCHERS`, all MiniMax helpers (`toEpochMs`, `pickField`, `extract*`, `isWeeklyEntry`) |
| `lib/rtk-metrics.js` | `getRtkSpendMetrics`, `detectSpecificBrand` |
| `lib/firebase.js` | `publishToFirebase` |
| `lib/env.js` | `loadEnv`, env read/write route handlers |
| `server.js` | HTTP routing skeleton only, startup, SSE watcher |

This is a refactor, not a rewrite. The exports/imports keep the public API identical.

---

### T11 — Repeated HTTPS request boilerplate across three fetchers

**File:** `server.js:957–1013` (Claude), `server.js:1029–1082` (Gemini), `server.js:1091–1191` (GLM)

All three follow the identical pattern: `https.request(options, (res) => { body += chunk; ... })` with the same error handler. The only differences are the URL, method, headers, and response parser.

**Action:** Extract a `httpsRequest(options, postData?)` helper that returns a `Promise<{statusCode, headers, body}>`. Each fetcher calls it and handles only its own parsing logic. Reduces boilerplate by ~60 lines.

---

### T12 — `package.json` "main" is wrong

**File:** `package.json:5`
```json
"main": "index.html"
```
`"main"` is the Node.js entry point. Should be `"server.js"`. `index.html` is an HTML file and is not loadable via `require()`.

**Action:** Change to `"main": "server.js"`.

---

## 5. Priority Matrix

| ID | Area | Impact | Effort | Priority |
|---|---|---|---|---|
| P1 | Simulation button hidden | High (regression) | XS | **P0** |
| F3 | .env writer drops keys | High (data loss) | S | **P0** |
| T2 | getRtkSpendMetrics scans all history | High (perf) | XS | **P1** |
| T1 | getRtkSpendMetrics called 3× | Medium (perf) | S | **P1** |
| T4 | triggerSilentQuotaSync dead code | Low | XS | **P1** |
| T6 | isWeeklyEntry unused param | Low | XS | **P1** |
| T7 | antigravity-parser hardcoded path | Medium (portability) | XS | **P1** |
| T12 | package.json main wrong | Low | XS | **P1** |
| P3 | Dead schema fields (meta.limit etc.) | Low | XS | **P2** |
| F1 | Request.source never set | Medium | S | **P2** |
| F2 | state.monitorMode missing | Medium | S | **P2** |
| T3 | loadEnv called twice | Low | XS | **P2** |
| T8 | syncAgentUsage rescans all files | Medium | M | **P2** |
| T9 | Dual detectBrand logic | Low | S | **P2** |
| F4 | SYSTEM_DESIGN.md stale | Low | XS | **P2** |
| P2 | Browser notifications at 90% | High value | M | **P3** |
| T10 | server.js module split | Medium | L | **P3** |
| T11 | HTTPS boilerplate extraction | Low | S | **P3** |
| T5 | state.requests never rendered | Resolved by F2 | — | — |

---

## 6. Phased Roadmap

### Phase 1 — Fix regressions & data loss (P0, 1–2 hours)

1. `P1` — Remove `display:none` from simulation toggle button
2. `F3` — Fix `.env` writer to preserve non-whitelisted keys
3. `T6` — Remove unused `fiveH_MS` param from `isWeeklyEntry`
4. `T12` — Fix `package.json "main"`

### Phase 2 — Clean up dead code & quick wins (P1, 1 hour)

5. `T2` — Add 7-day WHERE clause to `getRtkSpendMetrics` query
6. `T4` — Delete `triggerSilentQuotaSync`
7. `T7` — Replace hardcoded path in `antigravity-parser.js` with `os.homedir()`
8. `P3` — Remove `meta.limit` and `meta.windowLabel` from DEFAULT_BRAND_METADATA

### Phase 3 — Wire simulation mode correctly (P2, 2–3 hours)

9. `F1` — Set `source` field on all Request objects
10. `F2` — Add `state.monitorMode`, fix `getActiveRequests()`, wire toggle button
11. `T1` & `T3` — Call `getRtkSpendMetrics()` and `loadEnv()` once per cycle, pass results down

### Phase 4 — Documentation & observability (P2, 1 hour)

12. `F4` — Update `SYSTEM_DESIGN.md` folder structure and line counts
13. `T9` — Align `detectBrand` logic and add cross-reference comment

### Phase 5 — Performance & architecture (P3, 4–6 hours)

14. `T8` — Incremental `syncAgentUsage` (skip unchanged files)
15. `P2` — Browser notification at 90% quota
16. `T11` — Extract `httpsRequest()` helper
17. `T10` — Split `server.js` into `lib/brand-fetchers.js`, `lib/rtk-metrics.js`, `lib/firebase.js`
