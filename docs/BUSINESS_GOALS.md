# Business Goals

> Owner: Product Owner. Source of truth for "what" and "why". See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## Vision

A single-machine, zero-dependency dashboard that gives one developer real-time visibility into LLM spend and cache effectiveness across multiple Brands, with **authoritative provider-quota awareness** (5-hour and weekly limits, reset times, remaining percent) **and** rolling local-spend visibility, so they don't blow past either a vendor-imposed cap or a self-imposed budget. v1 traffic is **real by default** (live RTK monitor via `~/Library/Application Support/rtk/history.db`), with an in-app **Simulation** mode for offline development and demos.

## Target audience

A single developer (the project author) using multiple LLM Brands on one machine. Single-user, single-tenant. Not a SaaS product, not a team tool.

## In scope (v1, dual-monitor, real-by-default)

- Per-Brand visibility: token counts, Cost, Savings, request count
- Cache Hit Rate as a cross-cutting metric (not a Brand property)
- 5-Hour and Weekly Rolling Spend Limits per Brand, with sliding-window semantics (local-spend view)
- **Provider API Quota** per Brand: remaining quota, limit, 5-hour and weekly reset times, fetched live from each vendor's API (Claude rate-limit headers, MiniMax `token_plan/remains`, GLM, Gemini) and cached in `brand_quota` SQLite table
- **API-driven progress bar**: when a provider returns a quota, the bar fill and color reflect the provider's used %, not local spend
- **Dual monitor mode**: Real RTK Monitor (default, reads live RTK DB) and Simulation (synthetic traffic, offline dev)
- Per-Brand Pricing configuration (input/output rates, spend limits)
- CSV export of the per-Brand table
- Light/dark theme, per-user, with all inputs/dropdowns theme-aware
- Local persistence of pricing, theme, and request history (with retention cap)
- SSE-based real-time updates: new commands appear in the live feed within seconds of being logged to RTK

## Out of scope (v1)

- Kill-switch / auto-throttle when a limit is breached (v1 is monitor-only)
- Multi-user, multi-tenant, authentication
- Network exposure; the dashboard runs on `localhost:3000` only
- Reconciliation with actual invoice charges (the dashboard never knows what was actually billed)
- i18n (limit labels are English-only in v1)
- Mobile / responsive layout beyond a desktop browser
- Historical quota charting (only the current snapshot is shown; trend lines deferred)

## Prioritisation

**Must-haves (v1 acceptance):**

1. Per-Brand Cost, Savings, Cache Hit Rate, and request count render correctly
2. Rolling Spend Limit bars turn yellow at 70% and red at 90% of the configured cap
3. When a provider exposes a quota, the bar fill reflects the provider's used % (not local spend), with a tooltip distinguishing the two sources
4. 5-hour and weekly reset times are pulled from the provider API when available; otherwise fall back to local rolling-window semantics
5. The "Resets at HH:MM" tooltip accurately describes sliding-window semantics (oldest in-window request falls out)
6. `.env` API keys are written via a per-key endpoint and never returned unmasked to the browser
7. The favicon serves without 404
8. The Brand `antigravity` does not appear anywhere in the UI
9. Real RTK Monitor mode reads live commands from `~/Library/Application Support/rtk/history.db` and surfaces new ones within seconds via SSE
10. Simulation mode generates synthetic traffic on an 8-20s schedule, and the mode switcher in the header is visible

**Nice-to-haves (deferred, not promised):**

- Browser notifications when a Rolling Spend Limit hits 90%
- Configurable per-Brand rolling windows (currently fixed at 5h and 1w)
- Per-Request drill-down view (currently only aggregates are shown)
- SQLite/JSON persistence for Request history across server restarts
- Historical quota trend charts
- `meta.limit` and `meta.windowLabel` field cleanup (tracked in R3)

## 📈 Provider-Quota Tracking (v1 New Vision)

### Business Context & Problem

A local-spend dashboard tells the user what *this dashboard* has seen, but does not tell them how close they are to the vendor-imposed 5-hour or weekly cap. Two failure modes:

1. **Silent throttling**: the user keeps issuing requests that the vendor has already cut off, because the dashboard only tracks the subset of traffic that flowed through the local RTK proxy.
2. **Stale intuition**: the user sees "0% of 5-hour cap" because the local monitor hasn't seen anything in hours, while the vendor's actual quota is at 70%.

### The Solution Vision

1. **Live provider API quota**: each Brand has a fetcher that hits the vendor's quota endpoint on a cached refresh cycle. Claude reads `anthropic-ratelimit-*` response headers. MiniMax hits `https://www.minimax.io/v1/token_plan/remains` with Bearer auth. GLM reads `x-ratelimit-*` headers. Gemini does not expose quota (returns `not_exposed`).
2. **`brand_quota` cache table**: a SQLite table stores `remaining`, `limit_value`, `reset_at`, `reset_at_weekly`, `weekly_remaining`, `unit`, `raw_json`, `seeded_at`, `error` per Brand. Cache invalidation triggers on either reset time elapsing or 1-hour staleness.
3. **API-driven progress bar**: the brand card's 5-hour and weekly bars switch to API-quota-driven fill (with a `color-mix`-style tooltip) whenever a quota is present, and fall back to local-spend fill otherwise.
4. **Reset-time authority**: the "Resets at HH:MM" badge prefers the provider's authoritative reset timestamp over the local rolling-log estimate.

### Re-introduction of Real RTK Monitor Mode

Real RTK mode was originally present, removed in `0005-remove-real-rtk-mode.md` (v1 was Simulation-only), and re-introduced when the local-spend-only view proved insufficient. The re-introduction is now the default mode. See `0006-reintroduce-real-rtk-mode.md` for the architectural decision; Real mode reads live commands from the RTK SQLite DB, surfaces new ones via SSE, and uses `detectBrand()` against the command text to map traffic to a Brand.

## Success criteria

The dashboard is successful if its single user can answer these questions without leaving `localhost:3000`:

1. How much have I spent on each Brand today, this 5-hour window, and this week (local view)?
2. **How close am I to the vendor's 5-hour and weekly caps, and when do they reset?**
3. Am I approaching a self-imposed Rolling Spend Limit on any Brand?
4. How much of my input traffic is being served from cache, in dollars and as a percentage?
5. If I switch from Real to Simulation mode, does the dashboard re-render the synthetic stream?

A "no" to any of these is a v1 regression.

## KPIs (qualitative; no telemetry)

- **Time to first cost number**: under 3 seconds from page load.
- **Cache visibility**: a user looking at the dashboard can name their Cache Hit Rate for any Brand within 5 seconds.
- **Limit awareness**: a user can tell whether any Brand is within 10% of a 5-Hour or Weekly cap (self-imposed or vendor-imposed) within 5 seconds.
- **Quota freshness**: provider-quota data is at most 1 hour stale (cache TTL); a manually-triggered force-refresh via `POST /api/seed-quotas` returns fresh data within ~3 seconds.

No analytics, no tracking, no telemetry. The dashboard does not phone home.
