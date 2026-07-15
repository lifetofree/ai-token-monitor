# Fixed 5-Hour and Weekly Rolling Windows; drop `windowLabel`

Rolling Spend Limits were a mix of fixed and configurable: window durations (`FIVE_HOUR_WINDOW_MS`, `ONE_WEEK_WINDOW_MS`) were hardcoded, but each Brand had a `windowLabel` string that defaulted to `"5-Hour"`. The label implied the window length was per-Brand configurable when only the spend cap and the cosmetic label were. We fix the windows at 5 hours and 1 week for all Brands and drop `windowLabel`. The dashboard always says "5-Hour" and "Weekly".

## Status

Accepted, **applied**. Both `windowLabel` and `meta.limit` have been completely removed from `DEFAULT_BRAND_METADATA` and the migration loop. The titles on the brand cards have been replaced with literal `"5-Hour"` and `"Weekly"` strings.

## Considered Options

- **Make window duration per-Brand configurable** (e.g. 1h / 5h / 24h / 1w). More flexible, matches vendor-specific rate-limit policies. Schema grows; aggregation math gets harder.
- **Keep `windowLabel` as a cosmetic string** (chosen then reversed). Cheap to ship, but the implicit promise that windows were configurable was a footgun for future readers.
- **Fix the windows, drop the label (chosen).** The dashboard is honest about what's actually configurable.

## Consequences (once fully applied)

- `meta.windowLabel` is removed from Brand Metadata and from the migration loop in `app.js`.
- `renderBrandCards()` no longer reads `meta.windowLabel`; the rolling-limit title is a literal `"5-Hour"`.
- `meta.limit` is also removed (was dead code; tracked separately as part of the same cleanup pass).
- If a vendor later publishes a 1-hour or 24-hour rate-limit policy, this is the ADR to supersede.
