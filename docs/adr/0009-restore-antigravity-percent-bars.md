# Restore `%` Bars on the Antigravity (gemini) Brand Card

## Status

Accepted, **applied** in `8ee1283 fix(ui): restore % bars on the Antigravity (gemini) brand card`. The `isAntiqravity` ternary in `renderBrandCards()` is removed; the gemini brand now uses the same template as Claude / MiniMax / GLM.

## Context

The Antigravity CLI tier is "Unlimited": there is no per-window dollar or token cap. A previous pass introduced a `isAntiqravity ? token-counts-only : standard-bars` ternary in `app.js` on the rationale that a `%` bar against an arbitrary spend limit would be misleading for an uncapped tier. That pass was applied as a single-line behavioural split.

The user subsequently asked for the `%` bars back on the Antigravity card. We do that here. The bars now show `cost5h / limit5h` and `costWeekly / limitWeekly` from `lib/pricing-defaults.js` ($2.00 / $15.00 defaults), exactly as every other brand. The user understands the caveat and accepts the inaccuracy for v1.

## Considered Options

- **Keep token-counts-only on the Antigravity card.** Maintains the "no fake cap" invariant. Rejected — the user explicitly requested the bars.
- **Use the Gemini API-reported percent (when available) instead of the configured cost limit.** The cleanest semantic fit, but `BRAND_FETCHERS.gemini.fetchGeminiQuota` does not currently return a percent-remaining field the way the MiniMax / Claude probes do. Deferred.
- **Drop the `isAntiqravity` ternary entirely; use the standard template (chosen).** Simplest. Same visual treatment as the other three brands. The user is aware that the bar can saturate against an arbitrary limit and accepts that for v1.

## Consequences

- `app.js`: `isAntiqravity`, `tokens5h`, `tokensWeekly`, `cost5hDisplay`, `costWeeklyDisplay` locals are gone. The card template is unified.
- The server still returns `contextWindow` via `/api/agent-usage` (commit `8e23249`); the UI does not render it. The data is available for a future "context-window bar" option without server-side change.
- `lib/antigravity-parser.js` now uses the Gemini `countTokens` API when `GEMINI_API_KEY` is set (commit `1bb20bc`), so the numerator behind the bars is accurate even on code-heavy transcripts. The bar's denominator is still the configured cost limit; the bar's accuracy is bounded by that.
- Acceptance criterion AC-26 is added in `docs/REQUIREMENTS.md` to pin the "same template for all four brands" expectation.

## Related

- `0001-drop-antigravity-brand.md` — the gemini brand is the display slot for Antigravity CLI traffic; this ADR does not revisit that decision.
- `../REVIEWS.md` R8 — covers the three-commit chain (`1bb20bc`, `8e23249`, `8ee1283`) end-to-end.
