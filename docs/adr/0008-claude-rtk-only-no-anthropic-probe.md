# Track Claude via RTK Only (No Anthropic API Probe)

Claude's quota is tracked purely from the local RTK database. The Anthropic API probe that previously read `anthropic-ratelimit-*` response headers is removed. Claude's `BRAND_FETCHER` returns `unit: 'local'` with RTK spend metrics; no outbound call is made.

## Status

Accepted, **applied**. `lib/brand-fetchers.js` `fetchClaudeQuota` no longer calls `https://api.anthropic.com`; it returns a synchronous object derived from the `rtkSpend` argument. `computeApiUsedPct()` returns `null` for `unit: 'local'`, so Claude's 5h/weekly bars and reset badges fall back to RTK cost-based spend and the RTK rolling-window boundary — exactly what the web dashboard already displayed in practice. The ESP32 mirror (`lib/firebase.js`) derives Claude's reset times from `rtk.reset5hAt` / `rtk.resetWeeklyAt`.

## Context

The previous Claude fetcher sent a probe request to `POST /v1/messages` with model `claude-3-haiku-20240307` and read the `anthropic-ratelimit-tokens-*` response headers. Two problems made this value incorrect:

1. **The probe always 400'd.** The account has insufficient credit, so the API returns `400 "Your credit balance is too low..."` **before any rate-limit header is set**. The fetcher then returned `remaining: null`, `unit: 'per_minute'`, `error: "Your credit balance is too low..."` — and the `error` string was never surfaced in the UI, so Claude's card silently showed RTK-only data with no indication the probe was failing.
2. **Even when the probe succeeded, the value was wrong for this dashboard.** Anthropic's `anthropic-ratelimit-tokens-*` headers describe a **per-minute** token bucket, not a 5h or weekly window. `lib/firebase.js` already overrode Claude's `reset_at` with the RTK rolling window, explicitly commenting the API value as "useless for the OLED display." The per-minute number was not meaningful as a 5h/weekly budget indicator.

Meanwhile RTK already records every Claude Code call completely: input/output/saved tokens, timestamps, and the `rtk_cmd` column. `lib/rtk-metrics.js` aggregates these into 5h/weekly cost, token counts, request counts, and rolling-window reset boundaries — which is exactly what the dashboard's Claude card needs.

## Decision

Drop the Anthropic API probe. Track Claude purely via RTK:

- `fetchClaudeQuota(apiKey, rtkSpend)` returns `{ remaining: null, limit_value: null, reset_at: null, reset_at_weekly: null, weekly_remaining: null, unit: 'local', raw_json: <rtkSpend.claude>, error: null }` — no network call, no API key used.
- `computeApiUsedPct()` returns `null` for `unit: 'local'` (the bar falls back to RTK cost-based spend).
- The amounts label uses RTK tokens + cost (`isLocal` branch in `renderBrandCards()`).
- Reset times come from the RTK rolling window (`rtkSpend.reset5hAt` / `resetWeeklyAt`), both on the web and the ESP32.

**Out of scope**:
- Re-introducing the probe if Anthropic ever exposes a true 5h/weekly quota API. If that happens, a new fetcher variant returning a real `unit` (`'percent'` or `'requests'`) can replace this without touching the renderer.
- Surfacing the previous `error` string. With no probe, there is no fetch error to surface for Claude.

## Consequences

- **One fewer outbound integration**: Claude no longer hits `api.anthropic.com`. The `ANTHROPIC_API_KEY` is still required for Claude Code itself (the user's actual usage) but the dashboard never reads it. `seedBrandQuotas()` still passes the key to the fetcher, but it is ignored.
- **Claude's `unit` changes from `'per_minute'` to `'local'`** in the `brand_quota` table. Existing rows with `'per_minute'` are overwritten on the next `seedBrandQuotas()` pass; no migration is needed because `unit` is a free-text column the renderer switches on.
- **No more silent failure mode.** There is no probe to fail — Claude's data is always the RTK aggregation, which is the same source the card was effectively showing anyway.
- **The `claude-3-haiku-20240307` model constant is gone**, removing a deprecation landmine.

## Relationships

- Supersedes the Claude branch of the provider-quota vision in `docs/BUSINESS_GOALS.md` §"Provider-Quota Tracking".
- Aligns with `0006` (Real RTK Monitor): Claude traffic is read from the RTK DB, the same source the dashboard already trusted for spend.
