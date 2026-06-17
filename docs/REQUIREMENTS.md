# Functional Requirements

> Owner: Product Manager. Translates Business Goals into testable behavior. See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## 1. Data model

### 1.1 Brand

A Brand is an LLM provider tracked by the dashboard. v1 supports five: `gemini`, `claude`, `minimax`, `glm`, `mimo`. The Brand `antigravity` was removed (see `../docs/adr/0001-drop-antigravity-brand.md`).

Each Brand has a `Brand Metadata` record containing:
- `name`: display name
- `inputCost`: per-million-token input rate, user-configured
- `outputCost`: per-million-token output rate, user-configured
- `limit5h`: 5-Hour Spend Limit cap, user-configured
- `limitWeekly`: Weekly Spend Limit cap, user-configured

The fields `meta.limit` and `meta.windowLabel` are **still present in `DEFAULT_BRAND_METADATA` in code** but are no longer conceptually part of the schema; deletion is tracked in `../docs/REVIEWS.md` R3 (see `../docs/adr/0004-fixed-rolling-windows.md`).

### 1.2 Request

A Request is one LLM API call as recorded by the dashboard. Fields:

- `id`: stable string (e.g. `req_…`, `mock_…`)
- `timestamp`: epoch milliseconds
- `brand`: one of the five Brand keys
- `inputTokens`: integer; the billed input (per `../docs/adr/0003-cache-model-disjoint-input-and-saved.md`; not yet applied in code — see ADR-0003 status)
- `outputTokens`: integer
- `savedTokens`: integer; cached input, conceptually disjoint from `inputTokens` (subject to the same caveat)
- `cost`: float, computed
- `savings`: float, computed

The `source` and `cmdText` fields are reserved for a future Real Mode re-introduction (see `../docs/adr/0005-remove-real-rtk-mode.md`); the current code does not set or read them.

### 1.3 Request store

A single `state.requests: Request[]` array. The retention cap (`MAX_REQUESTS_RETAINED = 500`) is applied to the array as a whole (`state.requests.shift()` on overflow). See `../docs/adr/0002-unify-request-stores-by-source.md`.

## 2. Functional behavior

### 2.1 Simulation

- v1 has a single data source: the in-app Simulation. There is no mode switcher.
- The simulator generates a synthetic Request every 8-20s (uniformly random) while it is running.
- `Pause Simulation` / `Resume Simulation` controls the simulator; the button toggles a state flag persisted in `localStorage` under `atm_auto_sim`.
- The "Send Custom Request" modal lets the user fire a single Request with chosen Brand, input, output, and cache hit rate.
- On first load with an empty `state.requests`, the dashboard pre-populates `SIM_HISTORY_PRELOAD = 40` mock requests spread over the last two days so the aggregates and rolling-window bars have non-zero data to render.

### 2.2 Rolling Spend Limit

- Two windows: 5-Hour and Weekly. Fixed durations, not configurable. See `../docs/adr/0004-fixed-rolling-windows.md`.
- The dashboard shows two bars per Brand: `cost5h / limit5h` and `costWeekly / limitWeekly`.
- Bar colour: green below 70%, yellow 70-90%, red at or above 90%.
- "Resets at HH:MM" label shows the time at which the oldest in-window Request will fall out, plus a `formatTimeRemaining` countdown. The tooltip explicitly states that with sustained traffic the window slides continuously rather than fully resetting.

### 2.3 Cache visibility

- A global Cache Hit Rate is displayed: `sum(savedTokens) / (sum(inputTokens) + sum(savedTokens)) * 100`, as a percentage with one decimal.
- The percentage is shown next to "Caching & Proxy Savings" in the top stats.
- A per-Brand cache hit rate is implicit in the table's "Tokens Saved" sortable column.

### 2.4 Pricing configuration

- The "Customize Rates" modal has two tabs: "Rates & Limits" and "API Tokens (Keys)".
- "Rates & Limits" edits `Brand Metadata` for all five Brands (input rate, output rate, 5h cap, weekly cap). Invalid inputs (NaN, negative) are rejected; previous values are retained.
- "API Tokens (Keys)" writes one of five allowed env keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY`, `MIMO_API_KEY`) to `.env` via a per-key endpoint.
- API keys are returned masked (`****last4`) from `GET /api/env`. The full key is never sent to the browser.
- **Known bug** (tracked in `../docs/REVIEWS.md` R3): the per-key writer still drops any `.env` keys outside the five-key whitelist. The author name `RTK_DB_PATH` is no longer relevant (RTK is gone), but the loss-of-custom-config behaviour remains for any other env keys the user adds.

### 2.5 Export

- "Export CSV" downloads a CSV of the per-Brand table.
- Columns: Brand, Requests, Input Tokens, Output Tokens, Saved Tokens, Actual Cost (USD), Saved Cost (USD).
- Note: column header is "Actual Cost" for legacy reasons; the value is the computed `Cost`. See `../CONTEXT.md` flagged ambiguities.

### 2.6 Persistence

- All user preferences (theme, auto-sim, brand metadata) and Request history are stored in `localStorage` under `atm_*` keys.
- Request history is capped at 500 entries (single store, no per-source split).
- `localStorage` is the only persistence layer. There is no server-side database for Request history (see Known Gaps).

### 2.7 Refresh

- The dashboard recomputes aggregates from the in-memory store every 30s. A circular countdown shows the time-to-next-refresh.

### 2.8 Provider-Quota Tracking

- The dashboard fetches **live quota data** from each provider's API and caches it in the server-side `brand_quota` SQLite table. This is **distinct** from local spend — it is the vendor's authoritative view of how much quota is left.
- **Per-Brand `unit` semantics**:
  - `claude` and `glm` return `unit: "requests"` (count-based) with `limit_value` from response headers.
  - `minimax` returns `unit: "percent"` (0–100) from the `token_plan/remains` body. The fetcher synthesises `limit_value: 100` and reads `current_interval_remaining_percent` / `current_weekly_remaining_percent`.
  - `gemini` returns `unit: "not_exposed"` — no quota API, bar falls back to local spend.
- **Cache lifecycle** (in `server.js` → `seedBrandQuotas()`):
  - Lazy seed on dashboard load; force-refresh via `POST /api/seed-quotas {"force": true}`.
  - **Cache invalidation** triggers when either the 5h `reset_at` or the weekly `reset_at_weekly` has elapsed, OR the cache is older than 1 hour (when a reset window is exposed) / 1 minute (when it is not).
  - The cached row includes `raw_json` (full provider response) for debugging and `error` (string) when the fetch failed.
- **API-driven progress bar rule**: when `state.brandQuotas[brandKey].remaining` is present, the brand card's 5-hour and weekly bar **fill and color reflect the provider's used %**, not local spend. The bar's `title` tooltip distinguishes the source: `"Bar driven by provider API quota (used %)"` vs `"Bar driven by local rolling-window spend in this dashboard."`
- **Reset-time authority rule**: when `state.brandQuotas[brandKey].reset_at` (or `reset_at_weekly`) is in the future, the "Resets at HH:MM" badge uses the provider's timestamp and a different tooltip (`"Reset time from the provider API (authoritative window boundary)"`). The local rolling-log estimate is the fallback.
- **Failures are silent-degrade, not error-bubble**: a failed fetch stores `unit: "error"` and an `error` string; the bar falls back to local spend without a user-facing error toast (consistent with the existing "no error boundary" stance in §4). A future enhancement may surface a non-blocking warning.

## 3. Acceptance criteria

| ID | Criterion | Verification |
|---|---|---|
| AC-1 | Four Brand cards render | Manual: load dashboard |
| AC-2 | Cache Hit Rate is between 0% and 100% inclusive | Manual: confirm value under sustained traffic |
| AC-3 | 5-Hour bar turns yellow at 70% and red at 90% | Manual: configure a low cap and drive traffic |
| AC-4 | Pause / resume the simulator works without losing Request history | Manual: pause, observe counts; resume, observe new traffic |
| AC-5 | Invalid pricing input is rejected without mutating Brand Metadata | Manual: enter `"abc"` in a rate field |
| AC-6 | `GET /api/env` returns masked keys; full keys never reach the browser | Code review + DevTools network tab |
| AC-7 | CSV export opens in a spreadsheet with seven columns and one row per Brand | Manual: open in Numbers / Excel |
| AC-8 | "Resets at HH:MM" tooltip text matches the sliding-window semantics when no API quota is present | Manual: hover the badge with a Brand that has no API key configured |
| AC-9 | Escape closes any open modal | Manual: open modal, press Escape |
| AC-10 | The Brand `antigravity` does not appear in the Brand picker or Brand cards | Manual: open "Send Custom Request" |
| AC-11 | Favicon loads without 404 | Manual: load `/favicon.svg` and inspect the network tab |
| AC-12 | The header mode switcher exposes both "Real RTK Monitor" and "Simulation"; the selection persists in `localStorage` under `atm_monitor_mode` | Manual: switch modes, reload the page |
| AC-12a | After page reload, the previously selected mode is restored from `localStorage.atm_monitor_mode` and `getActiveRequests()` returns the correct store | Vitest: set localStorage, call init, assert mode and store |
| AC-12b | Switching mid-session from Real to Simulation does not lose `state.realCommands`; switching back restores them | Vitest: populate realCommands, switch to sim, switch back, assert length unchanged |
| AC-12c | After a mode switch, the Live Request Log Feed updates to show the last 15 entries from the newly active store | Manual: switch modes, observe feed updates |
| AC-12d | The console status dot reflects the active data source (green for Real SSE, yellow for Simulation) | Manual: observe dot after switching |
| AC-13 | With a MiniMax API key present, the brand card's 5-hour bar fill width equals `100 - brandQuotas.minimax.remaining` (±1%) and the bar tooltip reads "Bar driven by provider API quota (used %)" | Manual: hover the bar, compare to the MiniMax web console |
| AC-14 | When `brandQuotas[brandKey].reset_at` is in the future, the "Resets at HH:MM" badge shows the provider's timestamp (matching the MiniMax web console within ±1 minute), and the badge tooltip reads "Reset time from the provider API (authoritative window boundary)" | Manual: compare the badge time to the MiniMax web console |
| AC-15 | `POST /api/seed-quotas {"force": true}` updates `brand_quota` rows within 3 seconds, and the dashboard re-renders the new values within one 30-second refresh tick | Manual: change a Provider cap externally, force-refresh, observe |
| AC-16 | On initial load, the Live Request Log Feed contains only commands that pass `detectBrand()` (shell commands such as `curl`, `grep`, `ls` are filtered out of the last-15 window) | Manual: insert one LLM and one shell command via `sqlite3` directly, reload, confirm the feed shows only the LLM command |
| AC-21 | After `POST /api/env/key?key=ANTHROPIC_API_KEY&value=new`, the `.env` file still contains the previous values of any non-whitelisted key (e.g. `RTK_DB_PATH`, `FIREBASE_URL`) | Vitest: write a multi-key `.env`, call the endpoint, assert all keys round-trip |
| AC-22 | `POST /api/rtk/ingest` with a valid body (`original_cmd` + token counts) returns 200 and a JSON object with `success: true`, `id: <number>`, `command: <row>`, and `broadcast: true` | Vitest: build a valid payload, assert the response shape |
| AC-23 | `POST /api/rtk/ingest` coerces numeric fields (default 0), computes the default `savings_pct` from the disjoint formula `saved / (input + saved) * 100`, and clamps `savings_pct` to `[0, 100]` | Vitest: assert SQL row order and float format |
| AC-24 | `POST /api/rtk/ingest` accepts an optional client-supplied `id`; on duplicate, returns 409 with `{"success":false,"error":"Command with this id already exists","id":…}` | Vitest: insert twice with the same id, assert 409 |
| AC-25 | `POST /api/rtk/ingest` escapes single quotes in `original_cmd` (canonical SQL-injection attempt: `claude ' OR 1=1; DROP TABLE commands; --`); the malicious payload must remain inside a single SQL string literal | Vitest: assert the SQL contains exactly the expected number of semicolons and the doubled quotes |

## 4. Known gaps

- No automated tests for the pure functions (cost, savings, cache rate, CSV builder, `computeApiUsedPct`, MiniMax response parsing).
- No CI pipeline.
- `localStorage` only — no cross-restart persistence for Request history.
- Cache model: the **disjoint model is applied** in `addRequest`, `fetchRealRTKData`, `connectRTKStream`, and `generateInitialMockHistory` per `../docs/adr/0003-cache-model-disjoint-input-and-saved.md`; the `SIM_HISTORY_PRELOAD` rows pre-dating the migration may still look inconsistent (Reviewer R5 scope).
- `windowLabel` and `meta.limit` still in `DEFAULT_BRAND_METADATA` — see `../docs/adr/0004-fixed-rolling-windows.md` status and `../docs/REVIEWS.md` R3.
- Env-var loss bug: per-key writer drops `.env` keys outside the five-key whitelist (now also affects `RTK_DB_PATH`, which Real RTK mode honours) — see `../docs/REVIEWS.md` R3.
- No historical quota trend chart (only the current snapshot is shown).
- i18n not in scope (limit labels are English-only).
- No accessibility audit (keyboard nav, screen reader labels).
- No error boundary in the UI — a single failed provider-quota fetch silently degrades the dashboard to local-spend view.

## 5. Out of scope

- Monthly / all-time historical aggregates (only 5-hour and 7-day rolling windows are exposed).
- Reconciliation with actual invoice charges (the dashboard never knows what was actually billed).
- i18n (limit labels are English-only in v1).
- Mobile / responsive layout beyond a desktop browser.
- Multi-user, multi-tenant, authentication.
- Network exposure; the dashboard runs on `localhost:3000` only.
- Kill-switch / auto-throttle when a limit is breached (v1 is monitor-only).
