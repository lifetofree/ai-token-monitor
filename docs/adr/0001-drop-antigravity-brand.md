# Drop "antigravity" as a Brand

The Brand `antigravity` was a synthetic entry in `DEFAULT_BRAND_METADATA` that represented traffic routed through the user's own RTK/proxy optimizer. The name collided with the project author "Antigravity" (in `package.json`). We drop the Brand; v1 supports four real LLM Brands: `gemini`, `claude`, `minimax`, `glm`. Cache Savings is a cross-cutting metric on the Request, not a property of a Brand.

## Status

Accepted, **applied**. `DEFAULT_BRAND_METADATA` in `app.js` lists exactly four Brands; the `sim-brand-select` in `index.html` and the `--color-*` custom properties in `styles.css` are aligned with this list.

## Considered Options

- **Keep "antigravity" as a Brand, rename the author.** Loses the ability to track personal-optimized traffic separately, which some users want.
- **Drop "antigravity" as a Brand (chosen).** Cache savings travel with the Request as a cross-cutting metric; the four real LLM Brands are the only categorisation.
- **Track personal traffic as a separate dimension (not a Brand).** More expressive, but adds a second axis to every aggregate. Deferred.

## Consequences

- `DEFAULT_BRAND_METADATA` is reduced from 5 to 4 Brands: `gemini`, `claude`, `minimax`, `glm`.
- The simulator's `isAntigravity` special case (60-90% cache hit rate) was removed. Cache hit rates are now uniform per-Request (0-45% in the current simulator).
- UI: the Brand picker and Brand cards show only the four real Brands.
- With the subsequent removal of Real RTK mode (`0005-remove-real-rtk-mode.md`), the "map RTK traffic to the underlying LLM Brand" branch is no longer relevant.

## Related

- `0005-remove-real-rtk-mode.md` — removed the Real mode that was the original justification for this Brand.
