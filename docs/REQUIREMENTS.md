# Functional Requirements

> Owner: Product Manager. Translates Business Goals into testable behavior. See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## 1. Data model

### 1.1 Brand

A Brand is an LLM provider tracked by the dashboard. v1 supports four: `gemini`, `claude`, `minimax`, `glm`. The Brand `antigravity` was removed (see `../docs/adr/0001-drop-antigravity-brand.md`).

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
- `brand`: one of the four Brand keys
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
- "Rates & Limits" edits `Brand Metadata` for all four Brands (input rate, output rate, 5h cap, weekly cap). Invalid inputs (NaN, negative) are rejected; previous values are retained.
- "API Tokens (Keys)" writes one of four allowed env keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY`) to `.env` via a per-key endpoint.
- API keys are returned masked (`****last4`) from `GET /api/env`. The full key is never sent to the browser.
- **Known bug** (tracked in `../docs/REVIEWS.md` R3): the per-key writer still drops any `.env` keys outside the four-key whitelist. The author name `RTK_DB_PATH` is no longer relevant (RTK is gone), but the loss-of-custom-config behaviour remains for any other env keys the user adds.

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
| AC-8 | "Resets at HH:MM" tooltip text matches the sliding-window semantics | Manual: hover the badge |
| AC-9 | Escape closes any open modal | Manual: open modal, press Escape |
| AC-10 | The Brand `antigravity` does not appear in the Brand picker or Brand cards | Manual: open "Send Custom Request" |
| AC-11 | Favicon loads without 404 | Manual: load `/favicon.svg` and inspect the network tab |
| AC-12 | The mode switcher dropdown is not in the header | Manual: inspect the page |

## 4. Known gaps

- No automated tests for the pure functions (cost, savings, cache rate, CSV builder).
- No CI pipeline.
- `localStorage` only — no cross-restart persistence for Request history.
- Cache model is internally inconsistent in code (`billedInput = input - saved` coexists with a disjoint rate formula) — see `../docs/adr/0003-cache-model-disjoint-input-and-saved.md` status.
- `windowLabel` and `meta.limit` still in `DEFAULT_BRAND_METADATA` — see `../docs/adr/0004-fixed-rolling-windows.md` status and `../docs/REVIEWS.md` R3.
- Env-var loss bug: per-key writer drops `.env` keys outside the four-key whitelist — see `../docs/REVIEWS.md` R3.
- i18n not in scope (limit labels are English-only).
- No accessibility audit (keyboard nav, screen reader labels).
- No error boundary in the UI — a single failed fetch silently degrades the dashboard.
