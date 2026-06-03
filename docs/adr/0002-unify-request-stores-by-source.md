# Unify sim and real Request stores with a `source` attribute

`state.requests` (sim) and `state.realCommands` (real) were two stores that suggested two concepts. They shared a schema; the only real difference was persistence (so switching Monitor Mode didn't clobber data). Collapse them into a single `state.requests` collection; each Request carries a `source ∈ {sim, real}` attribute. The "switch modes without clobber" guarantee is preserved by filtered views, not by separate stores.

## Status

Accepted, **applied** in two stages:

1. The two stores were collapsed into one `state.requests` collection in the current code.
2. With the subsequent removal of Real RTK mode (`0005-remove-real-rtk-mode.md`), the `source` attribute is no longer meaningfully exercised — every Request in the current code has `source: 'sim'` (the field is not even present on Request objects; see "Consequences").

## Considered Options

- **Keep two stores, rename the real one** (e.g. `TrackedCall`). Two concepts in the glossary, two stores in the code, twice the surface area. Rejected.
- **Unify on Request with a `source` attribute (chosen).** One concept, one store, filtered views preserve the persistence guarantee.
- **Unify and drop the clobber guarantee.** Mode switches lose prior data. Rejected; the user explicitly values not losing data on a mode switch.

## Consequences

- `state.realCommands` is removed.
- The retention cap (`MAX_REQUESTS_RETAINED = 500`) is currently applied to the single `state.requests` array as a whole (`state.requests.shift()` on overflow). The "per-source retention cap" described in earlier revisions is moot while there is only one source.
- `lastSeenCommandId` (the real-mode "log only new commands" cursor) is gone with Real Mode.
- The `getActiveRequests()` filter is now a no-op pass-through (`state.requests`).
- A future re-introduction of Real Mode (per `0005-remove-real-rtk-mode.md`) would need to add the `source` attribute back. The TypeScript signature in `docs/SYSTEM_DESIGN.md` keeps `source?: 'sim' | 'real'` for that reason.
