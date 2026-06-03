# Business Goals

> Owner: Product Owner. Source of truth for "what" and "why". See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## Vision

A single-machine, zero-dependency dashboard that gives one developer real-time visibility into LLM spend and cache effectiveness across multiple Brands, with Rolling Spend Limit awareness so they don't blow past a 5-hour or weekly cap. v1 traffic is **synthetic** (the in-app Simulation). Real RTK traffic reconciliation is deferred — see `../docs/adr/0005-remove-real-rtk-mode.md`.

## Target audience

A single developer (the project author) using multiple LLM Brands on one machine. Single-user, single-tenant. Not a SaaS product, not a team tool.

## In scope (v1, monitor-only, Simulation-only)

- Per-Brand visibility: token counts, Cost, Savings, request count
- Cache Hit Rate as a cross-cutting metric (not a Brand property)
- 5-Hour and Weekly Rolling Spend Limits per Brand, with sliding-window semantics
- Per-Brand Pricing configuration (input/output rates, spend limits)
- CSV export of the per-Brand table
- Light/dark theme, per-user
- Local persistence of pricing, theme, and request history (with retention cap)
- In-app synthetic traffic generator (8-20s randomised, with "Send Custom Request" modal for one-off fires)

## Out of scope (v1)

- Real RTK traffic ingestion (deferred; the `~/Library/Application Support/rtk/history.db` reader, `/api/rtk` endpoint, and `execFile('sqlite3', …)` invocation are gone — see `../docs/adr/0005-remove-real-rtk-mode.md`)
- Kill-switch / auto-throttle when a limit is breached (v1 is monitor-only)
- Multi-user, multi-tenant, authentication
- Network exposure; the dashboard runs on `localhost:3000` only
- Reconciliation with actual invoice charges (the dashboard never knows what was actually billed)
- i18n (limit labels are English-only in v1)
- Mobile / responsive layout beyond a desktop browser

## Prioritisation

**Must-haves (v1 acceptance):**
1. Per-Brand Cost, Savings, Cache Hit Rate, and request count render correctly
2. Rolling Spend Limit bars turn yellow at 70% and red at 90% of the configured cap
3. The "Resets at HH:MM" tooltip accurately describes sliding-window semantics (oldest in-window request falls out)
4. `.env` API keys are written via a per-key endpoint and never returned unmasked to the browser (the env-var-loss bug from the prior implementation is tracked in `../docs/REVIEWS.md` R3)
5. The favicon serves without 404 (the prior `favicon.png`/`favicon.svg` whitelist mismatch is fixed)
6. The Brand `antigravity` does not appear anywhere in the UI (it was dropped in `../docs/adr/0001-drop-antigravity-brand.md`)

**Nice-to-haves (deferred, not promised):**
- Browser notifications when a Rolling Spend Limit hits 90%
- Configurable per-Brand rolling windows (currently fixed at 5h and 1w; see `../docs/adr/0004-fixed-rolling-windows.md`)
- Per-Request drill-down view (currently only aggregates are shown)
- SQLite/JSON persistence for Request history across server restarts (currently `localStorage` only)
- Re-introduction of Real RTK mode (superseded by `../docs/adr/0005-remove-real-rtk-mode.md`)
- Real-Mode Precise Brand Attribution (New Vision): Fix the brand detection bug in real usage by logging the client brand directly in the SQLite database during command execution.

## 📈 Real-Mode Brand Detection & Attribution (SQLite Schema Extension)

### Business Context & Problem
In the previous implementation of Real RTK Mode, the dashboard used a client-side heuristic (`detectBrand`) that scanned command strings (e.g. `git status`) for keywords like "gemini" or "rtk". If no keyword was found, it defaulted to "claude". Consequently, in real usage, standard developer commands executed under Gemini or other assistants were incorrectly cataloged under "claude" or "antigravity".

To display correct data for each brand in real usage, the system must precisely identify the calling LLM client at the source.

### The Solution Vision
1. **Database Schema Extension**: Introduce a `brand` column in the SQLite `commands` table of `history.db` to store the active brand string (`gemini`, `claude`, `minimax`, `glm`, `antigravity`).
2. **Hook Attribution**: Since `rtk` intercepts calls using tool-specific hook subcommands (`rtk hook claude`, `rtk hook gemini`), the `rtk` binary must log the corresponding brand into the `brand` column of the database automatically when logging the command.
3. **Dashboard Consumption**: The `/api/rtk` endpoint and the client-side rendering engine should read the logged `brand` value directly, completely replacing the fragile command-text regex heuristic.

## Success criteria

The dashboard is successful if its single user can answer these questions without leaving `localhost:3000`:

1. How much have I spent on each Brand today, this 5-hour window, and this week?
2. Am I approaching a Rolling Spend Limit on any Brand?
3. How much of my input traffic is being served from cache, in dollars and as a percentage?
4. If I pause and resume the simulator, did the dashboard re-render as expected?

A "no" to any of these is a v1 regression.

## KPIs (qualitative; no telemetry)

- **Time to first cost number**: under 3 seconds from page load.
- **Cache visibility**: a user looking at the dashboard can name their Cache Hit Rate for any Brand within 5 seconds.
- **Limit awareness**: a user can tell whether any Brand is within 10% of a 5-Hour or Weekly cap within 5 seconds.

No analytics, no tracking, no telemetry. The dashboard does not phone home.
