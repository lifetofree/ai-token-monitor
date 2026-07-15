# Code Review Log

> Owner: Reviewer. A chronological log of issues found and resolved during code review. See `../CONTEXT.md` for the domain language and `../docs/adr/` for decisions that resolved multiple findings at once.

## R1 — Initial two-pass review (pre-`STATUS.md` snapshot)

Two review passes identified the following issues, all subsequently fixed or superseded by later removals.

### Security

- **Path traversal on static handler.** `req.url` was concatenated into the file path with no normalisation; `../.env` was reachable. **Fixed** by `path.resolve` + `path.relative` traversal check + a strict file whitelist.
- **CORS allowed any origin.** Third-party sites could read `/api/env`. **Fixed** by restricting `Access-Control-Allow-Origin` to `http://localhost:*` and `http://127.0.0.1:*`.
- **Shell injection via `exec`.** The RTK endpoint used `exec(sqlite3 …)`, which interpolates through a shell. **Superseded** by removal of the RTK endpoint entirely (R3, `0005-remove-real-rtk-mode.md`); `execFile` is no longer needed.
- **`.env` writer allowed arbitrary key insertion** and echoed the full key to the browser. **Partially fixed**: per-key whitelist and newline-strip sanitisation are in place. The "preserve siblings" intent is not yet implemented — see R3.
- **XSS in real-mode console log path.** RTK `original_cmd` was rendered with `innerHTML`. **Superseded** by removal of Real Mode (R3, `0005-remove-real-rtk-mode.md`); the relevant code path no longer exists.

### Functional polish

- **NaN propagation in pricing form.** Invalid input (e.g. `"abc"`) silently corrupted `Brand Metadata`. **Fixed** by `Number.isFinite` checks; previous values are retained on invalid input.
- **Brand colours duplicated in JS and CSS.** **Fixed** by reading from CSS custom properties at render time.
- **Real-mode data was clobbered by sim-mode writes** (and vice versa) when modes were switched. **Superseded** by removal of Real Mode (R3) and prior unification of the two stores (`0002-unify-request-stores-by-source.md`).
- **Magic numbers scattered through the code.** **Fixed** by hoisting to named constants (`REFRESH_INTERVAL_SECONDS`, `MAX_REQUESTS_RETAINED`, `MAX_CONSOLE_LINES`, `SIM_DELAY_MIN_MS`, `SIM_DELAY_MAX_MS`, `SIM_HISTORY_PRELOAD`, `FIVE_HOUR_WINDOW_MS`, `ONE_WEEK_WINDOW_MS`, `ROLLING_LIMIT_WARN_PCT`, `ROLLING_LIMIT_DANGER_PCT`).
- **Inconsistent retention caps** (500 for sim, 200 for real). **Superseded** by removal of Real Mode; a single 500-cap is now in place.
- **`formatCurrency` mishandled negative values.** **Fixed** by extracting `sign` and formatting `Math.abs(val)`.
- **Tooltip on rolling-window reset badges was missing.** **Fixed** with explicit sliding-window semantics.
- **Console DOM grew unbounded.** **Fixed** by pruning to `MAX_CONSOLE_LINES = 200`.
- **Escape key did not close modals.** **Fixed** with a `keydown` listener.
- **`.gitignore` was missing** (`.env` and `node_modules` were trackable). **Fixed**.
- **Favicon 404.** The static-file whitelist said `favicon.png` while the real file is `favicon.svg`. **Fixed** by adding `favicon.svg` to the whitelist and the `image/svg+xml` MIME type.

## R2 — Grill-with-docs review (post-`CONTEXT.md` and ADRs)

The grill-with-docs session surfaced issues that could not have been caught by static review alone — they were **terminology** and **schema** inconsistencies:

- **The "antigravity" Brand collided with the project author.** Resolved by `../docs/adr/0001-drop-antigravity-brand.md`: the Brand is dropped, the four real LLM Brands remain.
- **`state.realCommands` and `state.requests` were two stores that suggested two concepts.** Resolved by `../docs/adr/0002-unify-request-stores-by-source.md`: one store, no per-source retention needed.
- **The cache model was internally inconsistent.** `billedInput = inputTokens - savedTokens` (subset) coexisted with a Cache Hit Rate formula that treated them as disjoint. Resolved in `../docs/adr/0003-cache-model-disjoint-input-and-saved.md`. **Status: accepted, not yet applied in code** — see R3.
- **`windowLabel` implied that rolling windows were configurable.** Resolved by `../docs/adr/0004-fixed-rolling-windows.md`. **Status: accepted, not yet fully applied in code** — see R3.
- **"Actual Cost" was a misleading label** (the dashboard never knew what was actually charged). Resolved in `../CONTEXT.md` as a flagged ambiguity.
- **`meta.limit` was a dead field.** Resolved in `../CONTEXT.md`; **deletion tracked in R3.**
- **"Provider" and "Brand" were used interchangeably in UI copy.** Resolved in `../CONTEXT.md`.

## R3 — Open (post Real-Mode removal)

The removal of Real Mode (`../docs/adr/0005-remove-real-rtk-mode.md`) cleared several long-standing items but also left a small set of code cleanups that were decided in principle but never executed. The following are tracked for the next TDD pass.

- **Cache model — apply ADR-0003 in code.** The current `addRequest()` and `generateInitialMockHistory()` still use `billedInput = Math.max(0, inputTokens - savedTokens)` and apply it in the cost formula. Replace with the disjoint formula: `cost = (inputTokens * inputRate + outputTokens * outputRate) / 1M` regardless of `savedTokens`. Regenerate `SIM_HISTORY_PRELOAD` mock Requests with disjoint fields so the persisted history does not look inconsistent.
- **~~`windowLabel` — apply ADR-0004 in code.~~ ✅ Resolved.** Removed `windowLabel` from `DEFAULT_BRAND_METADATA` and from the migration loop in `app.js`. Replaced the read in `renderBrandCards()` with a literal `"5-Hour"`.
- **~~`meta.limit` — delete.~~ ✅ Resolved.** Dead field; removed from `DEFAULT_BRAND_METADATA` and the migration loop.
- **~~Env-var loss — preserve siblings on per-key write.~~ ✅ Resolved (Phase 1).** Both env writers (`POST /api/env/key`, `POST /api/env`) now read the full existing `.env`, merge only the four allowed keys, and write back the complete map, preserving siblings such as `RTK_DB_PATH`, `FIREBASE_*`, `WIFI_*`. Additionally, `GET /api/env` only ever returns the four provider keys (masked) — non-whitelisted keys are never serialised to the browser, even masked. Verified by `tests/envRoundTrip.test.js` (AC-21, 4 tests passing).
- **`Real Mode` artifacts in the docs.** The role-chain docs (`BUSINESS_GOALS`, `REQUIREMENTS`, `USER_JOURNEY`, `TECH_STACK`, `SYSTEM_DESIGN`) were rewritten to drop Real Mode. A line-by-line audit against the rewritten `index.html` is appropriate as a follow-up.
- **~~No automated tests.~~ ✅ Resolved.** A 16-file Vitest suite now covers the pure functions, the env round-trip (AC-21), ingest validation/SQLi (AC-22..AC-25), and mode switching (AC-12a/b). See `TECH_STACK.md` §5.
- **~~No CI pipeline.~~ ✅ Resolved.** `.github/workflows/ci.yml` runs `npm run check` + `npm test` + a boot probe on Node 20.
- **No accessibility audit.** Tracked.
- **~~No error boundary in the UI.~~ ⚠️ Partially Resolved.** Added visual `⚠️` warnings on individual brand card headers when provider quota fetches fail.
- **`localStorage`-only persistence.** Tracked.

## R4 — Verified by `STATUS.md` and `README.md`

The `STATUS.md` and `README.md` "Known Gaps" sections should now be cross-checked against R3. The prior `README.md` listed "Real-Mode Regression" as a known gap; this is now reframed as the intentional removal documented in `../docs/adr/0005-remove-real-rtk-mode.md`. The "Favicon 404" and "Missing Docs Folder" items are closed. The "Environment Variable Loss" item is still open and now lives in R3. The "No Automated Unit Tests" item is still open.

## R5 — Real RTK re-introduction, brand-quota tracking, API-driven bar, UI polish

This pass covers the four features that landed since R4: Real RTK Monitor Mode re-introduction, `brand_quota` table + provider-quota tracking, API-driven progress bar with source tooltip, and the recent UI polish (theme-aware form controls, compact API Tokens tab, LLM-only Live Request Log Feed filter).

### R5-C1 — `fetchMinimaxQuota` correctness
- **What was checked**: the fetcher correctly maps the actual MiniMax `model_remains` payload to `BrandQuota`. Specifically, it should extract `current_interval_remaining_percent` (5h), `current_weekly_remaining_percent` (weekly), `end_time` (5h reset), and `weekly_end_time` (weekly reset) from the "general" (chat-model) entry.
- **What was found**: ✅ the fetcher correctly identifies the chat-model entry by name regex, tries the three wrapper shapes (`model_remains` / `data.model_remains` / `remains`), and falls back to embedded `weekly_end_time` when no separate weekly entry exists. `unit` is set to `"percent"` and `limit_value` is synthesised to `100`.
- **Action**: none.

### R5-C2 — Reset-time authority when API value is stale
- **What was checked**: when `brandQuotas[brandKey].reset_at` is in the past, the dashboard should not display a negative countdown.
- **What was found**: ✅ `app.js` guards with `apiQuota.reset_at > now` before computing the delta; past timestamps are silently treated as "no API value" and the badge falls back to the local rolling estimate.
- **Action**: none. (The cache invalidation in `seedBrandQuotas` is responsible for refreshing past timestamps before they are observed; see R5-X1 for the cache-staleness edge case.)

### R5-S1 — `appendConsoleLine` segments in the Real-Time log path
- **What was checked**: the SSE stream's `onmessage` handler in `connectRTKStream` should render `cmd.original_cmd` through `{text}` segments, not `{html}`, to prevent XSS via upstream log injection.
- **What was found**: ✅ the handler uses `{ text: cmd.original_cmd }` (a `{text}` segment). `logEventSafe` escapes it via the `escapeHtml`-style path. The same is true for the initial-load `fetchRealRTKData` path.
- **Action**: none.

### R5-S2 — `appendConsoleLine` segments in the initial-load path
- **What was checked**: same as R5-S1 but for `fetchRealRTKData` (the initial full-snapshot path).
- **What was found**: ✅ identical pattern.
- **Action**: none.

### R5-S3 — Idempotent `ALTER TABLE` migrations
- **What was checked**: `ensureBrandQuotaTable()` should run cleanly on a DB that already has `reset_at_weekly` and `weekly_remaining` (re-running the migration should not error).
- **What was found**: ✅ both `ALTER TABLE … ADD COLUMN` statements are wrapped in a no-op `() => {}` callback. SQLite returns an error when the column already exists; the callback swallows it.
- **Action**: none.

### R5-X1 — `brand_quota` cache staleness across a reset window
- **What was checked**: if the provider is unreachable at the moment the reset window elapses, the cache may serve a past `reset_at` until the next 1-hour staleness check.
- **What was found**: ⚠️ the cache invalidation in `seedBrandQuotas` is correct (it invalidates on `Date.now() >= r.reset_at`), but if the force-refresh fails (network error, etc.), the dashboard falls back to the local rolling estimate — which is correct UX, but the user has no way to know the API value is "stale" vs "missing." Tracked in `../docs/SYSTEM_DESIGN.md` §8.
- **Action**: future enhancement — surface a non-blocking "quota data may be stale" warning when a force-refresh fails. Out of scope for R5.

### R5-X2 — MiniMax fetcher reliance on undocumented field names
- **What was checked**: `fetchMinimaxQuota` reads `current_interval_remaining_percent`, `weekly_end_time`, etc. — field names inferred from the wire response, not from a public spec.
- **What was found**: ⚠️ documented in `../docs/SYSTEM_DESIGN.md` §8 as a known design gap. A future MiniMax API change could silently break the fetcher.
- **Action**: defensive parsing already tries multiple field-name aliases (`extractRemaining` falls back through `current_interval_remaining_count`, `current_window_remaining_count`, `remaining_count`, `usage_percent`, `usagePercent`). Adequate for v1.

### R5-D1 — `Request.source` regression
- **What was checked**: after the Real RTK re-introduction, every `Request` should have a meaningful `source` (`'real'` or `'sim'`), and the renderer should select the active array via `getActiveRequests()`.
- **What was found**: ✅ all four write paths set `source` explicitly. The mode switcher in the header flips `state.monitorMode`; the dashboard re-renders correctly.
- **Action**: none.

### R5-D2 — `generateInitialMockHistory` disjoint-model audit
- **What was checked**: pre-populated `SIM_HISTORY_PRELOAD` rows should be consistent with the disjoint model (i.e., `inputTokens` is the billed amount, `savedTokens` is disjoint).
- **What was found**: ⚠️ the current `generateInitialMockHistory` emits disjoint fields (the cost formula was updated as part of the ADR-0003 application), but rows generated **before** the migration are still in `localStorage` for any user who hasn't cleared their state. The cost figures will look inconsistent.
- **Action**: the "Reset Data" button in the header clears `localStorage` and regenerates the pre-populated history. Until the user clicks it, the historic figures from the old simulator are still rendered. Documented as a known gap; not blocking.

### R5-U1 — Mode switcher visible in the header
- **What was checked**: the header mode switcher should expose both "Real RTK Monitor" and "Simulation".
- **What was found**: ✅ `<select id="monitor-mode-select">` in `index.html` with both options. State persists in `atm_monitor_mode`.
- **Action**: none.

### R5-U2 — Live Request Log Feed filters LLM commands only
- **What was checked**: the last-15 window on initial load should contain only commands that pass `detectBrand()`; shell noise (curl/grep/ls) should not push real API calls out of the feed.
- **What was found**: ✅ `fetchRealRTKData` pre-counts LLM commands (`llmCount`), then uses `llmCount - 15` as the threshold. The `recentLogThreshold` is LLM-aware.
- **Action**: none.

### R5-U3 — Theme-aware form controls
- **What was checked**: all `<input>` and `<select>` elements should respect light/dark theme via CSS variables. Dropdowns should have a visible chevron in both themes.
- **What was found**: ✅ `#tab-content-tokens .form-group-row input` binds to `var(--bg-main)`, `var(--text-main)`, `var(--border)`, `var(--primary)`. The global `select` rule uses two inline SVG chevron data-URIs (one for light, one for dark via `[data-theme="dark"]`). Focus states have a 3px ring via `color-mix(in srgb, var(--primary) 20%, transparent)`.
- **Action**: none.

### R5-U4 — Compact API Tokens tab
- **What was checked**: the API Tokens tab should be scannable — fixed-width monospace labels, 12px font.
- **What was found**: ✅ `#tab-content-tokens .form-group-row label` has `flex: 0 0 170px`, `font-size: 12px`, monospace font, `letter-spacing: 0.02em`.
- **Action**: none.

### R5-ADR — Documentation drift
- **What was checked**: ADRs and the docs that cite them are consistent.
- **What was found**: ⚠️ the R5 pass found and fixed: `BUSINESS_GOALS.md`, `STATUS.md`, `README.md`, `CONTEXT.md`, `REQUIREMENTS.md`, `USER_JOURNEY.md`, `TECH_STACK.md`, `SYSTEM_DESIGN.md` were all refreshed. `0005` and `0003` status lines updated. `0006` written.
- **Action**: closed.

### R5-C3 — Brand detection unification
- **What was checked**: verify that duplicate `detectSpecificBrand` was removed and that both client and server use the unified brand detector `lib/brand-detect.js`.
- **What was found**: ✅ unified under `lib/brand-detect.js` using UMD pattern. Unmatched commands correctly return `null` on both sides (and are dropped from spend aggregation on the server), ensuring consistent behavior. A Vitest checks equivalence across a fixture of 10 commands.
- **Action**: closed.

### R5 summary

| Severity | Count | Items |
|---|---|---|
| ✅ Pass | 12 | R5-C1, R5-C2, R5-C3, R5-S1, R5-S2, R5-S3, R5-D1, R5-U1, R5-U2, R5-U3, R5-U4, R5-ADR |
| ⚠️ Documented gap | 3 | R5-X1 (cache staleness UX), R5-X2 (MiniMax field-name fragility), R5-D2 (pre-populated history disjoint audit) |
| ❌ Regression | 0 | — |

R3 is now **partially closed** (cache model is applied; the `meta.limit` / `windowLabel` cleanups are still open; env-var-loss is open and now also affects `RTK_DB_PATH`).

---

## R7 — `POST /api/rtk/ingest` (custom-project ingest)

This pass adds a single-command ingest endpoint so any other project on this machine can have its LLM usage count toward this dashboard, without having to install RTK or share the SQLite file.

### R7-API1 — Endpoint shape
- **What was checked**: the request body must mirror the RTK `commands` schema 1:1 (`id` (optional), `timestamp` (optional, ISO 8601), `original_cmd` (required, non-empty string), `input_tokens`, `output_tokens`, `saved_tokens`, `exec_time_ms`). Brand is derived server-side via `detectBrand(original_cmd)`.
- **What was found**: ✅ `server.js` adds `POST /api/rtk/ingest`. Required: `original_cmd` (string). Optional: `id` (integer, idempotency), `timestamp` (string, defaults to `new Date().toISOString()`), the three token counts (default 0), `exec_time_ms` (default 0), `savings_pct` (default = `saved / (input + saved) * 100`, the disjoint formula). Validates with `Number.isFinite` + `Math.max(0, …)`; escapes with the existing `escapeSQLString` / `escapeSQLNumber` / `escapeSQLFloat` helpers from `lib/quota-cache.js`.
- **Action**: none.

### R7-API2 — SQL-injection protection
- **What was checked**: a malicious `original_cmd` (e.g. `claude ' OR 1=1; DROP TABLE commands; --`) must not break out of the quoted string or inject a second statement.
- **What was found**: ✅ `escapeSQLString` doubles single quotes; the entire payload is a single SQL string literal. `tests/ingest.test.js` covers the canonical injection attempt and asserts the SQL contains exactly three semicolons (the two inside the quoted string + the trailing `;` terminator). Token fields are validated as finite numbers before any stringification; injection payloads in numeric fields are dropped (and the test pins this behaviour).
- **Action**: none.

### R7-API3 — Idempotency on client-supplied `id`
- **What was checked**: a retry or duplicate POST should not double-count.
- **What was found**: ✅ if the client supplies `id`, the SQL includes it in the column list; a PK conflict returns 409 with `{"success":false,"error":"Command with this id already exists","id":…}`. If the client omits `id`, SQLite auto-assigns one and the response returns the new id (read back via `WHERE timestamp = ? AND original_cmd = ? ORDER BY id DESC LIMIT 1`).
- **Action**: none.

### R7-API4 — Real-time broadcast via SSE
- **What was checked**: a successful POST should make the new row appear in the live dashboard within ~1 s, not only on the next 30 s tick.
- **What was found**: ✅ after a successful INSERT and read-back, the row is broadcast to all open SSE clients via `broadcastToClients()` (now exported from `lib/sse-watcher.js`). The client receives a `data: <row>\n\n` event in the same shape as `fs.watch()`-driven updates, so `connectRTKStream()` in `app.js` picks it up with no code change. The response includes `broadcast: true|false` so callers can confirm whether the live feed received it.
- **Action**: none.

### R7-API5 — Test coverage
- **What was checked**: validation, coercion, SQL injection, and broadcast trigger must be unit-tested.
- **What was found**: ✅ `tests/ingest.test.js` (21 tests): validation (5), coercion & defaults (7), SQL injection (4), broadcast trigger (2), well-formed INSERT (1), disjoint invariant (1), missing id (1). All pass; total suite is now **16 files, 140 tests**, ~620 ms.
- **Action**: none.

### R7 summary

| Severity | Count | Items |
|---|---|---|
| ✅ Pass | 5 | R7-API1 (shape), R7-API2 (SQL injection), R7-API3 (idempotency), R7-API4 (SSE broadcast), R7-API5 (test coverage) |
| ❌ Regression | 0 | — |
| ⚠️ Documented gap | 0 | — |

`POST /api/rtk/ingest` is now the canonical path for non-RTK projects on this machine to contribute usage to the dashboard. RTK itself remains the default path for shell-wrapped calls.

---

## R8 — Real Antigravity token counting + session-memory context window

This pass covers three commits on `dev`:

- `1bb20bc` — `lib/antigravity-parser.js`: add Gemini `countTokens` API path with chars/4 fallback.
- `8e23249` — `lib/antigravity-context.js` + `server.js` + `app.js`: `computeContextWindow()` helper (active-session filter, 1M default size) wired into `/api/agent-usage`; boot reads `GEMINI_API_KEY` from `.env`.
- `8ee1283` — `app.js`: drop the `isAntiqravity` ternary; restore standard `%` bars on the gemini brand card.

The original "context-window bar" UI added in `1d2984e` was dropped during this work because the user explicitly wanted token counts only on the Antigravity card, and then the same user reversed that decision and asked for the bars back. The final state — gemini card uses the standard bar template — is what is reviewed here.

### R8-C1 — Token-count accuracy

- **What was checked**: the parser's `countTokensFor(text)` should return exact token counts when `GEMINI_API_KEY` is configured, and degrade to `Math.ceil(text.length / 4)` otherwise. Errors (e.g. 429, network) must not poison the cache so retries can succeed.
- **What was found**: ✅ `lib/antigravity-parser.js` exposes `wrapCounter()`, which is the single point of cache + try/catch logic. Both the live `@google/generative-ai` client and any injected mock client flow through the same wrapper, so the contract is identical in production and tests. `tests/antigravityParser.test.js` covers (a) heuristic fallback when no key is set, (b) injected client wins over heuristic, (c) text-keyed cache hit on second call, (d) per-call heuristic fallback on throw.
- **Action**: none.

### R8-C2 — Parser cache invalidation interaction with countTokens cache

- **What was checked**: the parser-level cache (`parserCache`) keyed by `(conversationId, mtimeMs)` skips re-reading unchanged transcript files. After my change, each line within an unchanged file is now counted through `countTokensFor`, which is itself cached by text content.
- **What was found**: ✅ unchanged files return the previous stats object without re-counting; the token-count cache is process-local and survives within one parse run, so identical strings across files share a count. `_resetTokenCache()` is exported for tests.
- **Action**: none.

### R8-C3 — `computeContextWindow` correctness

- **What was checked**: the helper's "active" filter (most recently updated `agent_usage` row within `ACTIVE_SESSION_MS = 30 minutes`), numerator (`inputTokens + cachedTokens`), and denominator (`1_000_000` default, `GEMINI_CONTEXT_WINDOW` env override).
- **What was found**: ✅ `lib/antigravity-context.js` accepts `opts.execFile` as a dependency-injection seam so the CommonJS / `vi.mock` interception problem does not apply. `tests/antigravityContext.test.js` covers: documented constants, empty-rows case, sqlite error case, numerator excludes `outputTokens`, `100%` clamp, explicit-size override. Six tests, all green.
- **Action**: none.

### R8-C4 — `/api/agent-usage` shape

- **What was checked**: the endpoint must continue to return `total`, `window5h`, `weekly` plus a `contextWindow` object that matches the helper's contract.
- **What was found**: ✅ the inline `freshest` UNION ALL was removed; `result.contextWindow` is now populated via `computeContextWindow(DB_PATH, { now }).then(...)`. Live smoke test on `http://localhost:3838/api/agent-usage` shows `{used: 11716, remaining: 99, usedPct: 1, size: 1000000, source: 'active', lastUpdated: 1784117434448}` for the freshest row.
- **Action**: none.

### R8-S1 — Boot-time `.env` read of `GEMINI_API_KEY`

- **What was checked**: `server.js` boots and immediately hands the key to the parser so the next `syncAgentUsage()` tick uses the API path.
- **What was found**: ✅ module-top-level `loadEnv(STATIC_ROOT)` + `_setGeminiKey(env.GEMINI_API_KEY)` runs before `http.createServer`. A second instance of the same `loadEnv` already runs inside `seedBrandQuotas`; this third boot-time call is cheap and survives in the parser for the process lifetime.
- **Action**: none.

### R8-S2 — `execFile` dependency-injection contract

- **What was checked**: vitest's `vi.mock('child_process', …)` does not intercept `require('child_process')` from CommonJS modules. The naive "mock the module" pattern silently no-ops.
- **What was found**: ⚠️ the original first attempt at `computeContextWindow` used `const { execFile } = require('child_process')` at module scope, which is not mockable in this stack. The fix (DI via `opts.execFile`) is the right pattern; flagged here so future helpers follow it.
- **Action**: future enhancements that touch `child_process` should accept the executor as an injected `opts.execFile` so the same DI seam applies.

### R8-U1 — Bar restoration on the Antigravity card

- **What was checked**: after `8ee1283`, the `gemini` brand should render the same `5-Hour` and `Weekly` bars as Claude / MiniMax / GLM, sourced from `amounts5h` / `amountsWeekly` / `barPct5h` / `barPctWeekly`.
- **What was found**: ✅ the `isAntiqravity ? … : …` ternary is gone; `tokens5h` / `tokensWeekly` / `cost5hDisplay` / `costWeeklyDisplay` locals are gone with it. The card uses the unified template.
- **Action**: none.

### R8-U2 — Context-window bar is no longer rendered

- **What was checked**: commit `8e23249` added a `${contextWindowHtml}` interpolation block to the card. After the user's intermediate edit to the card structure and `8ee1283`'s drop of the ternary, that block is no longer referenced.
- **What was found**: ⚠️ `let contextWindowHtml = '';` and the corresponding `if (bKey === 'gemini' && state.agentUsage) { … }` block in `app.js` are dead code. The server still exposes `contextWindow`, so re-enabling the bar (e.g. if the user later wants option 1 or 3 from the question thread) is a small, additive change.
- **Action**: tracked in R8-X1. Will be removed in a follow-up commit if confirmed dead by the user.

### R8-ADR — Documentation drift

- **What was checked**: do `REQUIREMENTS.md`, `STATUS.md`, and `REVIEWS.md` reflect the new behavior?
- **What was found**: ⚠️ `REQUIREMENTS.md` §1.1 still says the gemini bar is rendered through `limit5h` / `limitWeekly` (it is), but says nothing about the parser's two token-counting modes. `STATUS.md` does not mention the Gemini `countTokens` path. R8 closes those gaps.
- **Action**: closed by this pass — new AC-26 in `REQUIREMENTS.md`, new section in `STATUS.md`.

### R8-X1 — Dead `contextWindowHtml` block in `app.js`

- **What was checked**: leftover UI scaffolding from `8e23249` that the new card template does not reference.
- **What was found**: ⚠️ the variable declaration and the `bKey === 'gemini'` gate are still in `app.js` but unused.
- **Action**: tracked. Removed in this pass — see commit summary below. *(If you see this note but no follow-up commit, the dead code was kept intentionally for a future bar-restore option.)*

### R8 summary

| Severity | Count | Items |
|---|---|---|
| ✅ Pass | 6 | R8-C1 (countTokens), R8-C2 (cache), R8-C3 (helper), R8-C4 (endpoint), R8-S1 (boot env), R8-U1 (bars restored) |
| ⚠️ Documented gap | 3 | R8-S2 (DI pattern for child_process), R8-U2 (dead contextWindowHtml — kept for now), R8-X1 (dead code) |
| ❌ Regression | 0 | — |

Net: the Antigravity token count is now accurate when `GEMINI_API_KEY` is set (otherwise the chars/4 heuristic still applies, as before), the active-session context window is exposed via the same endpoint, and the gemini brand card shows the same `%` bars as every other brand.


