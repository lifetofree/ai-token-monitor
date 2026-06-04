# User Journey

> Owner: Product Manager. The flow a single user takes through the dashboard. See `../CONTEXT.md` for the domain language and `../docs/REQUIREMENTS.md` for functional requirements.

## Persona

A developer using multiple LLM Brands in a single workday, who wants a glanceable answer to "what am I spending, am I near a self-imposed cap, **am I about to hit the vendor's cap, is the cache doing its job**". They also keep a parallel browser tab open to each provider's web console (e.g. the MiniMax Token Plan page) to sanity-check the dashboard. Single user, desktop browser, `localhost:3000`.

## Primary journey: "Did I just blow my 5-hour cap?"

1. **Open the dashboard.** The page loads at `http://localhost:3000`. The header shows the current Monitor Mode (default: Real RTK Monitor), the simulation status, and a 30-second refresh countdown.
2. **Glance at the four Brand cards.** Each card shows two horizontal bars: 5-Hour and Weekly. A red fill at or above 90% is the trigger. When the Brand has a provider-quota snapshot, the bar fill and color match the **vendor's** view, not just local spend.
3. **Hover the "Resets at HH:MM" badge** to confirm the source. The tooltip is one of two strings:
   - `"Reset time from the provider API (authoritative window boundary)."` — the badge time matches the vendor web console.
   - `"Rolling window: the oldest request in this window falls out at the shown time. With sustained traffic the window slides continuously rather than fully resetting."` — the badge time is the local rolling-log estimate.
4. **Hover the bar itself** to confirm the source of the fill. Tooltip is one of:
   - `"Bar driven by provider API quota (used %)"` — fill matches the vendor's used %.
   - `"Bar driven by local rolling-window spend in this dashboard."` — fill reflects only what flowed through the local monitor.
5. **Cross-check with the vendor's web console** (e.g. MiniMax Token Plan page). The badge time and bar percentage should match within ±1 minute / ±1%.
6. **Scroll to the table** if a per-Brand breakdown is needed (sortable by Cost, Requests, Saved Tokens, etc.).
7. **Open "Customize Rates"** if the cap itself is wrong (e.g. raise the 5h cap). Save.

## Primary journey: "Am I about to hit the vendor's 5-hour cap?"

This is the user explicitly checking the **provider-authoritative** view — the one the vendor uses to decide whether to throttle the next request.

1. **Open the dashboard in Real RTK Monitor mode** (the default). The header mode switcher confirms "Real RTK Monitor" is selected.
2. **Look at the Brand card** for the vendor in question (e.g. MiniMax). The bar fill should already reflect the API quota — if the user is at 78% remaining on the MiniMax web console, the dashboard's 5-hour bar should sit at ~22% width and read `~22%` in the percentage label, **not** the local spend percentage.
3. **Verify the source by hovering the bar.** The tooltip should explicitly say "Bar driven by provider API quota (used %)." If it instead says "local rolling-window spend," the API quota has not yet been fetched (or has fallen out of cache) — wait for the next 30s tick or force-refresh.
4. **Verify the reset time by hovering the badge.** The tooltip should say "Reset time from the provider API (authoritative window boundary)." The displayed absolute time should match the MiniMax web console within ±1 minute.
5. **If the bar looks wrong**, force a refresh by sending `POST /api/seed-quotas {"force": true}` and reload. The bar should update within one 30-second tick.
6. **If the API is down or the key is wrong**, the bar falls back to local spend silently (no error toast). The user checks the brand_quota row in the SQLite DB (`SELECT * FROM brand_quota WHERE brand='minimax';`) — the `error` column will contain the failure reason.

## Secondary journey: "Is the cache actually saving me money?"

1. **Open the dashboard.** The page loads at `http://localhost:3000`. The header shows the simulation status and a 30-second refresh countdown.
2. **Glance at the four Brand cards.** Each card shows two horizontal bars: 5-Hour and Weekly. A red fill at or above 90% is the trigger.
3. **Hover the "Resets at HH:MM" badge** to confirm the sliding-window semantics ("the oldest request in this window falls out at the shown time").
4. **Scroll to the table** if a per-Brand breakdown is needed (sortable by Cost, Requests, Saved Tokens, etc.).
5. **Open "Customize Rates"** if the cap itself is wrong (e.g. raise the 5h cap). Save.

## Secondary journey: "Is the cache actually saving me money?"

1. **Look at the "Caching & Proxy Savings" card** in the top stats grid. The dollar value is the total Savings across all Brands; the percentage is the global Cache Hit Rate.
2. **Open the table** and sort by "Tokens Saved" (descending) to see which Brand is benefiting most.
3. **Drill into a Brand card** to see its 5-Hour and Weekly bars; the cache effect is implicitly visible in the lower-than-expected Cost.
4. **Export CSV** to share the numbers (e.g. paste into a notebook).

## Tertiary journey: "Show me what the dashboard looks like."

1. **Reload the page** with the simulator running. The simulator generates synthetic Requests every 8-20s.
2. **Open "Send Custom Request"** to fire a one-off Request with chosen Brand, token counts, and cache hit rate. Useful for verifying a Pricing change.
3. **Pause the simulator** with the play/pause button to lock the dashboard in a stable state for a screenshot.

## Edge case journeys

### "I want to silence the simulator."

- Click `Pause Simulation` in the header. The status dot turns gray. The 5-Hour and Weekly bars continue to reflect the current Request set; no new Requests are generated.

### "I want to add a new API key."

- Open `Customize Rates` → `API Tokens (Keys)` tab. The input is masked on initial load (shows `****last4`).
- Type the full key, click Save. The key is written to `.env` via a per-key endpoint.

### "I want to reset everything."

- Click `Reset Data` in the header. A confirm dialog appears. On confirm, the Request store is cleared, the console log is cleared, and the dashboard re-renders empty.

### "I want to take a screenshot in a stable state."

- Click `Pause Simulation`. Open `Send Custom Request` and fire a few one-off Requests to populate the aggregates to the desired shape. The dashboard now reflects the manually-built state and will not change until you `Resume Simulation`.

## UI design system

### Layout

- Single column, max-width container (`var(--container-max)`).
- Vertical stack: header → top stats grid (4 cards) → Brand cards (4 cards in a responsive grid) → table → console.
- Header is sticky; on narrow viewports the header controls wrap.

### Visual themes

- Light and dark themes, switched via the moon/sun button. Persisted in `localStorage` under `atm_theme`. Default: light.
- Brand colours are read from CSS custom properties (`--color-gemini`, `--color-claude`, etc.) — single source of truth, no hardcoded hex in JS.

### Typography

- System font stack; sizes: 12px (small), 14px (body), 16px (heading), 20px+ (top stats).
- Monetary values use tabular figures for column alignment.

### Components

- `Card`: white/dark surface, 12px radius, 1px border, soft shadow.
- `Brand dot`: 8x8 colored circle next to a Brand name.
- `Limit bar`: 6px tall, rounded ends, fills from left, colour changes at 70% / 90%.
- `Reset badge`: small pill with a clock glyph; tooltip explains sliding-window semantics.
- `Modal`: centred overlay, focus-trapped, closes on Escape or backdrop click.

### Accessibility

- All interactive controls have a `title` or `aria-label`.
- Modals use `role="dialog"` and `aria-hidden` toggles.
- Tab controls use `role="tablist"` / `role="tab"` / `aria-selected`.
- Theme toggle is `aria-label`'d.
- **Known gap**: no formal accessibility audit; keyboard navigation in the table has not been verified end-to-end.

## Empty / loading / error states

- **Empty Request store**: cards and table show zeros; console log shows a single "System initialized. Awaiting API request stream..." line. The simulator pre-populates 40 mock requests on first load to avoid this state.
- **Failed `GET /api/env`**: API key inputs render empty; the user can still type and save.
- **No other external fetches**: the dashboard no longer polls RTK (see `../docs/adr/0005-remove-real-rtk-mode.md`); the only network call is `GET /api/env` on load. **Known gap**: no user-facing error boundary.
