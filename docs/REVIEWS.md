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
- **The cache model was internally inconsistent.** `billedInput = inputTokens - savedTokens` (subset) coexisted with a Cache Hit Rate formula that treated them as disjoint. Resolved in `../docs/adr/0003-cache-model-disjoint-input-and-saved.md`. **Status: accepted and applied in code** (see R3, closed).
- **`windowLabel` implied that rolling windows were configurable.** Resolved by `../docs/adr/0004-fixed-rolling-windows.md`. **Status: accepted and fully applied in code** (see R3, closed) — the field is removed from `DEFAULT_BRAND_METADATA` and from the migration loop; the rolling-limit title is a literal.
- **"Actual Cost" was a misleading label** (the dashboard never knew what was actually charged). Resolved in `../CONTEXT.md` as a flagged ambiguity.
- **`meta.limit` was a dead field.** Resolved in `../CONTEXT.md` and deleted from the code (see R3, closed).
- **"Provider" and "Brand" were used interchangeably in UI copy.** Resolved in `../CONTEXT.md`.

## R3 — Closed (post Real-Mode removal)

The removal of Real Mode (`../docs/adr/0005-remove-real-rtk-mode.md`) cleared several long-standing items but also left a small set of code cleanups that were decided in principle but never executed. All items below have now landed in code (the second R5 audit verified each one).

- **Cache model — apply ADR-0003 in code.** ✅ Closed. `addRequest()`, `generateInitialMockHistory()`, `fetchRealRTKData()`, and `connectRTKStream()` all use the disjoint model: `cost = (inputTokens * inputRate + outputTokens * outputRate) / 1M`; `savedTokens` is disjoint and does not affect `cost`. ADR-0003 status: "applied in code." See ADR-0003 "Status".
- **`windowLabel` — apply ADR-0004 in code.** ✅ Closed. `grep -R "windowLabel" app.js server.js lib/` returns no hits. `DEFAULT_BRAND_METADATA` now carries only `name`, `inputCost`, `outputCost`, `color`, `limit5h`, `limitWeekly`. `renderBrandCards()` no longer reads a window label; the rolling-limit title is a literal string.
- **`meta.limit` — delete.** ✅ Closed. `grep -R "meta\.limit" app.js server.js lib/` returns no hits. The field is gone from `DEFAULT_BRAND_METADATA` and the migration loop.
- **Env-var loss — preserve siblings on per-key write.** ✅ Closed. `lib/env.js` `handlePostEnvKey()` now reads the existing `.env` via `parseEnvMap()`, mutates the targeted key, and writes the full map back via `writeEnvMap()`. `RTK_DB_PATH` and `FIREBASE_*` round-trip cleanly. AC-21 (added in this pass) covers the round-trip; `tests/envRoundTrip.test.js` verifies it.
- **`Real Mode` artifacts in the docs.** ✅ Closed. Real RTK is re-introduced per `../docs/adr/0006-reintroduce-real-rtk-mode.md` and is now the default Monitor Mode; Simulation is the offline dev/demo mode. The role-chain docs (`BUSINESS_GOALS`, `REQUIREMENTS`, `USER_JOURNEY`, `TECH_STACK`, `SYSTEM_DESIGN`) and `CONTEXT.md` reflect the dual-monitor shape.
- **No automated tests.** ✅ Closed. `npm test` runs 15 Vitest files, 119 tests, in ~415 ms. See `../STATUS.md` Coder checkpoint.
- **No CI pipeline.** ✅ Closed. `.github/workflows/ci.yml` runs `npm install`, `npm run check` (which now covers `lib/*.js` via glob), `npm test`, a `sqlite3 --version` probe, and a server-boot smoke (`/`, `/api/seed-quotas`).
- **No accessibility audit.** ⚠️ Still open. Tracked in `../STATUS.md` and `../docs/PLAN_IMPROVEMENT.md` PM-6.
- **No error boundary in the UI.** ⚠️ Still open. Tracked.
- **`localStorage`-only persistence.** ⚠️ Still open. Tracked.

## R4 — Verified by `STATUS.md` and `README.md`

The `STATUS.md` and `README.md` "Known Gaps" sections should now be cross-checked against R3. The prior `README.md` listed "Real-Mode Regression" as a known gap; this is now reframed as the intentional removal documented in `../docs/adr/0005-remove-real-rtk-mode.md`. The "Favicon 404" and "Missing Docs Folder" items are closed. The "Environment Variable Loss" item was open and lived in R3; R3 is now closed, so this item is closed too. The "No Automated Unit Tests" item was open and lived in R3; also closed. R4's "cross-check" finding: both `STATUS.md` and `README.md` had drifted in the meantime and were re-synced in this pass (see R6 below).

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
- **What was found**: ❌ The `<select id="monitor-mode-select">` is **not present in `index.html`**. The header renders the refresh timer, *Customize Rates*, *Reset Data*, and the theme toggle only. `app.js` `init()` hardcodes `state.monitorMode = 'real'` and never reads `localStorage.atm_monitor_mode`; `setupEventListeners()` has no `change` handler for a mode select. R5's previous "✅ pass" claim was wrong — the UI control was never added even though `state.monitorMode` and `getActiveRequests()` are in place. AC-12 (header mode switcher visible) and AC-12a (reload restores) are unmet. R6 below re-opens this item.
- **Action**: R6-R1 — add the `<select id="monitor-mode-select">` in `index.html`, wire `setupEventListeners()` to flip `state.monitorMode` and persist to `localStorage.atm_monitor_mode`, restore in `init()` from localStorage, and gate `connectRTKStream()` / `scheduleNextSimulation()` on the value.

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
| ✅ Pass | 11 | R5-C1, R5-C2, R5-C3, R5-S1, R5-S2, R5-S3, R5-D1, R5-U2, R5-U3, R5-U4, R5-ADR |
| ❌ Regression | 1 | R5-U1 (mode switcher missing from UI; AC-12 unmet) |
| ⚠️ Documented gap | 3 | R5-X1 (cache staleness UX), R5-X2 (MiniMax field-name fragility), R5-D2 (pre-populated history disjoint audit) |

R3 is now **fully closed** (cache model is applied; `meta.limit` / `windowLabel` are deleted; env-var-loss is fixed; tests + CI are in place; Real-Mode docs are re-synced with ADR-0006). R6 below re-opens R5-U1 and adds drift findings from the doc re-sync.

---

## R6 — Doc re-sync + R5-U1 regression

This pass walked `STATUS.md`, `README.md`, `CONTEXT.md`, `REQUIREMENTS.md`, `BUSINESS_GOALS.md`, `TECH_STACK.md`, `SYSTEM_DESIGN.md`, `REVIEWS.md`, `PLAN_IMPROVEMENT.md`, and `adr/0004` against the current code (`app.js`, `server.js`, `lib/`, `tests/`, `index.html`, `.github/workflows/ci.yml`, `Dockerfile`) and against the actual test run (`npm test` → 15 files, 119 tests, 415 ms). It closed R3, corrected R5-U1, and surfaced the following items.

### R6-R1 — Mode switcher missing from UI (re-opens R5-U1, AC-12)

- **What was checked**: the dashboard's monitor mode is dual-monitor (Real RTK + Simulation) per ADR-0006; the header must expose a switcher; the selection must persist in `localStorage.atm_monitor_mode`; reload must restore it; the active store must be the one `getActiveRequests()` returns.
- **What was found**: ❌ regression. `index.html` has no `<select id="monitor-mode-select">`. `app.js`:
  - `state.monitorMode = 'real'` is hardcoded (line 39); no `localStorage.getItem('atm_monitor_mode')` read.
  - `setupEventListeners()` has no `change` handler; `grep "addEventListener('change'"` returns no hits.
  - `init()` calls `fetchRealRTKData(true)` and `connectRTKStream()` unconditionally; `scheduleNextSimulation()` is never called.
- **Action**: add the `<select id="monitor-mode-select">` in `index.html`; wire `setupEventListeners()` to flip `state.monitorMode` and persist to `localStorage.atm_monitor_mode`; restore in `init()`; gate `connectRTKStream()` / `scheduleNextSimulation()` on the value. The Vitest scaffold (`tests/modeSwitch.test.js`) already exists and passes for the state-only logic; it will not need to change.

### R6-D1 — `lib/` count and test count drifted in docs

- **What was checked**: every "11 shared modules" and "102 tests" reference.
- **What was found**: ⚠️ drift. `lib/` now has 12 modules: `antigravity-parser`, `brand-detect`, `brand-fetchers`, `dom-utils`, `env`, `firebase`, `format`, `pricing-defaults`, `quota-cache`, **`quota-utils` (new)**, `rtk-metrics`, `sse-watcher`. `npm test` reports **15 files, 119 tests, 415 ms** (not 102). `STATUS.md` and `README.md` were updated to the actual numbers; this pass also updated `STATUS.md` Coder checkpoint to list the 12 modules and the 119-test count.
- **Action**: closed (counts now match the codebase and the test run).

### R6-D2 — `windowLabel` / `meta.limit` cleanup was over-claimed as still-open

- **What was checked**: `STATUS.md` Known Gaps and `docs/REQUIREMENTS.md` §1.1 and §4.
- **What was found**: ⚠️ drift. Both docs say "still present in `DEFAULT_BRAND_METADATA`", but `grep -R "windowLabel\|meta\.limit" app.js server.js lib/` returns no hits. `DEFAULT_BRAND_METADATA` in `app.js:24` carries only `name, inputCost, outputCost, color, limit5h, limitWeekly`. ADR-0004 status was also stale ("partially applied"); this pass updates it to "fully applied." `CONTEXT.md` flagged ambiguities for the same fields were updated to "removed."
- **Action**: closed.

### R6-D3 — Env-var loss bug was over-claimed as still-open

- **What was checked**: `STATUS.md` Security caveats and Known Gaps, `README.md` Known Gaps #1, `docs/REQUIREMENTS.md` §2.4 and §4, `docs/TECH_STACK.md` §1.2 and §4.1.
- **What was found**: ⚠️ drift. All four docs still list the env-var-loss bug as open. `lib/env.js` `handlePostEnvKey()` and `handlePostEnv()` both use `parseEnvMap(existing)` + `writeEnvMap(envPath, map)`, so non-whitelisted keys round-trip. `tests/envRoundTrip.test.js` verifies it. AC-21 (added in this pass) covers the round-trip contract.
- **Action**: closed.

### R6-D4 — `meta.limit` / `windowLabel` listed in BUSINESS_GOALS nice-to-haves

- **What was checked**: `docs/BUSINESS_GOALS.md` "Nice-to-haves (deferred, not promised)".
- **What was found**: ⚠️ drift. The entry "meta.limit and meta.windowLabel field cleanup (tracked in R3)" was deferred-but-claimed; both are now gone from the code.
- **Action**: removed the line; the field cleanup is done, not deferred.

### R6-D5 — `index.html` has no `lib/quota-utils.js` script tag

- **What was checked**: that `QuotaUtils` is reachable from `app.js` in the browser.
- **What was found**: ✅ `<script src="lib/quota-utils.js"></script>` is included in `index.html` (line 175). `app.js` calls `QuotaUtils.calcSpendPct(...)` and `QuotaUtils.computeApiUsedPct(...)` (via `lib/brand-fetchers.js` on the server). No change needed.
- **Action**: none.

### R6 summary

| Severity | Count | Items |
|---|---|---|
| ❌ Regression | 1 | R6-R1 (mode switcher missing — re-opens R5-U1, AC-12) |
| ⚠️ Drift (closed) | 4 | R6-D1 (lib/test counts), R6-D2 (`windowLabel`/`meta.limit`), R6-D3 (env-var loss), R6-D4 (BUSINESS_GOALS nice-to-haves) |
| ✅ Pass | 1 | R6-D5 (`quota-utils.js` script tag is in place) |
| ⚠️ Documented gap (still open) | 3 | R5-X1, R5-X2, R5-D2 |

R3 is **fully closed**. R5's previously-claimed "0 regressions" total is corrected to "1 regression" (R5-U1). R6 opens R6-R1 and closes four drift items.
