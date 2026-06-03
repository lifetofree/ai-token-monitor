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
- **`windowLabel` — apply ADR-0004 in code.** Remove `windowLabel` from `DEFAULT_BRAND_METADATA` and from the migration loop in `app.js`. Replace the read in `renderBrandCards()` with a literal `"5-Hour"`.
- **`meta.limit` — delete.** Dead field; remove from `DEFAULT_BRAND_METADATA` and the migration loop.
- **Env-var loss — preserve siblings on per-key write.** The current `POST /api/env/key` reconstructs `.env` from the four-key whitelist only. Replace the `newContent` line with one that preserves every existing key outside the whitelist while updating or deleting the targeted one. A one-line change: read existing lines, splice the targeted key, write back.
- **`Real Mode` artifacts in the docs.** The role-chain docs (`BUSINESS_GOALS`, `REQUIREMENTS`, `USER_JOURNEY`, `TECH_STACK`, `SYSTEM_DESIGN`) were rewritten to drop Real Mode. A line-by-line audit against the rewritten `index.html` is appropriate as a follow-up.
- **No automated tests.** Tracked in `../STATUS.md` and `../docs/TECH_STACK.md` §5. The natural target is Vitest.
- **No CI pipeline.** Tracked.
- **No accessibility audit.** Tracked.
- **No error boundary in the UI.** Tracked.
- **`localStorage`-only persistence.** Tracked.

## R4 — Verified by `STATUS.md` and `README.md`

The `STATUS.md` and `README.md` "Known Gaps" sections should now be cross-checked against R3. The prior `README.md` listed "Real-Mode Regression" as a known gap; this is now reframed as the intentional removal documented in `../docs/adr/0005-remove-real-rtk-mode.md`. The "Favicon 404" and "Missing Docs Folder" items are closed. The "Environment Variable Loss" item is still open and now lives in R3. The "No Automated Unit Tests" item is still open.
