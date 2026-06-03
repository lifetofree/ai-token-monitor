# User Journey

> Owner: Product Manager. The flow a single user takes through the dashboard. See `../CONTEXT.md` for the domain language and `../docs/REQUIREMENTS.md` for functional requirements.

## Persona

A developer using multiple LLM Brands in a single workday, who wants a glanceable answer to "what am I spending, am I near a cap, is the cache doing its job". Single user, desktop browser, `localhost:3000`.

## Primary journey: "Did I just blow my 5-hour cap?"

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
