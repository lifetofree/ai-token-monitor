# Remove the Real RTK Monitor Mode

The dashboard was originally designed to read proxy-routed LLM traffic from RTK's `history.db` SQLite file (`~/Library/Application Support/rtk/history.db`) in a "Real" Monitor Mode and contrast it with synthetic traffic from a "Simulation" Mode. The Real Mode is removed: there is no longer a mode switcher, no `fetchRealRTKData`, no `/api/rtk` endpoint, no `execFile('sqlite3', …)` invocation, and no `state.realCommands` collection. The dashboard is now **Simulation-only** for traffic generation. v1 is monitor-only on synthetic data; reconciliation with real RTK traffic is deferred.

## Status

**Superseded by [`0006-reintroduce-real-rtk-mode.md`](./0006-reintroduce-real-rtk-mode.md).** Real RTK Monitor Mode is the default Monitor Mode in v1; Simulation is preserved as the offline dev/demo mode. The consequences of this ADR (the things it removed) are now back. This file is preserved as historical context for the brief Simulation-only interlude.

## Considered Options

- **Keep Real Mode, fix the env-var-loss and favicon-404 issues** (chosen then reversed). Carrying RTK integration forward means carrying a SQLite reader, a polling loop, a per-key `cmdText` field on Request, and a Brand-detection heuristic — significant surface for a personal tool whose single user wasn't using it.
- **Remove Real Mode entirely (chosen).** Removes a feature; keeps the dashboard simple. Real-mode traffic can be reintroduced later as a v2 module with its own ADR.
- **Replace with a "watch folder" or file-tail mode** that reads RTK exports instead of the live DB. Lower coupling but still requires the user to keep exports flowing. Deferred.

## Consequences

- `state.realCommands`, `state.monitorMode`, and the mode switcher in `index.html` are deleted.
- `server.js` no longer reads `history.db`; the `execFile` import is gone; the `RTK_DB_PATH` env var is no longer recognised.
- The Request `source` attribute (introduced in `0002-unify-request-stores-by-source.md`) is now permanently `'sim'` and is no longer a meaningful field. It is kept in the schema for forward compatibility (a future Real Mode re-introduction would need it), but the Request store is not currently filtered by it.
- `cmdText` (the original RTK command) is no longer surfaced; the "Real" log path in `app.js` is gone.
- `CONTEXT.md` no longer lists `Real Mode`, `Source`, or `Monitor Mode` as separate terms; "Simulation Mode" is the (sole) data source.
- The `docs/REQUIREMENTS.md`, `docs/USER_JOURNEY.md`, `docs/TECH_STACK.md`, `docs/SYSTEM_DESIGN.md`, and `docs/REVIEWS.md` documents were rewritten to drop Real Mode references. The "env var loss" bug from the prior implementation is now historical context; the current `/api/env/key` still has the loss issue and is tracked in `docs/REVIEWS.md` R3.

## Supersedes

- Parts of `0001-drop-antigravity-brand.md` (the "Real-mode traffic is mapped to the underlying LLM Brand" branch): Real mode is gone, so this re-mapping is moot.
- The forward-looking bits of `0002-unify-request-stores-by-source.md` (the "filtered views preserve the persistence guarantee"): there is only one source now.
