# Re-introduce Real RTK Monitor Mode

`0005-remove-real-rtk-mode.md` (v1 was Simulation-only) is superseded. The local-spend-only view proved insufficient for users with multi-tool workflows: the dashboard could show "0% of 5-hour cap" because nothing had flowed through the local monitor in hours, while the vendor had already cut the user off. Real RTK Monitor Mode is re-introduced as the **default** Monitor Mode, with Simulation preserved as the offline development and demo mode.

## Status

Accepted, **applied**. `server.js` exposes `/api/rtk`, `/api/rtk/summary`, and `/api/rtk/stream`; `app.js` reads the RTK `commands` SQLite table, populates `state.realCommands`, and consumes the SSE stream. `index.html` has a mode switcher in the header. `state.monitorMode` is persisted in `localStorage` under `atm_monitor_mode`. `Request.source` is a meaningful field again (`'real'` for RTK-sourced, `'sim'` for synthetic).

## Context

When `0005` was written, the dashboard's single user (the project author) wasn't using Real RTK mode in practice — the surface area (SQLite reader, polling loop, `cmdText` field, Brand-detection heuristic) was deemed disproportionate to the value. Two things changed:

1. **The user actually started using RTK in production**, and noticed the dashboard silently disagreed with reality. A request that had clearly been made and answered (and billed) was absent from the dashboard because the local monitor had no record of it.
2. **Provider-quota tracking** (`brand_quota` table, `/api/seed-quotas`) was added in the same wave. The provider-quota view is necessary-but-not-sufficient: it tells the user how close they are to the vendor's cap, but not what they spent. The local-spend view is the other half, and it is hollow without Real RTK data.

The author concluded that the v1 single-mode simplification was a misjudgment: dual-monitor is a feature, not a bug, and the additional surface area is bounded (~150 lines in `server.js`, ~50 lines in `app.js`).

## Decision

Re-introduce Real RTK Monitor Mode as the **default** Monitor Mode. Preserve Simulation Mode for offline dev and demos. The header gets a mode switcher; `state.monitorMode` selects the active Request array; `Request.source` is a meaningful field again.

**Out of scope for this ADR** (intentionally not bundled):
- Brand attribution from the SQLite source (e.g. a `brand` column on `commands`). Still uses `detectBrand(original_cmd)`. The author of this ADR believes this is fine for v1's traffic shape; a future v2 module can revisit.
- Reconciliation between the local-spend view and the provider-quota view (a "did I miss a request?" check). Deferred.
- Multi-user / multi-machine. The `~/Library/Application Support/rtk/history.db` path is per-user on macOS; the dashboard is single-user.

## Considered Options

- **Keep Simulation-only, add a "watch folder" for RTK exports** (rejected). The user already has the live SQLite DB; an export-based flow would require the user to keep exports flowing, and would lag the live view by however often they exported. Defeats the point.
- **Re-introduce Real RTK as the only mode, drop Simulation** (rejected). Useful for offline dev and demos, especially when iterating on the renderer without a live RTK DB. Keeping both is cheap (~50 lines of switching glue).
- **Re-introduce Real RTK as the default, preserve Simulation (chosen).** Default to Real RTK so the user gets the live view on a fresh page load. The mode switcher in the header is the escape hatch. `state.monitorMode` is the single source of truth.
- **Read both stores, merge by timestamp** (rejected). Conceptually appealing but practically confusing: when the simulator generates a request that happens to coincide with a real RTK event, which wins? The user's mental model is "I'm in Real mode" or "I'm in Sim mode," not "I'm in a merged mode."

## Consequences

- `state.realCommands` is back. `state.requests` (sim) is preserved. `getActiveRequests()` selects the active array based on `state.monitorMode`.
- `state.monitorMode` is a meaningful field. Persisted in `localStorage` under `atm_monitor_mode`. Switchable from the header.
- `Request.source` is set explicitly by each write path: `'real'` for `fetchRealRTKData` and `connectRTKStream`; `'sim'` for the simulator and pre-populated history.
- `lastSeenCommandId` (the real-mode "log only new commands" cursor) is back. Initialised to 0 on first load (forces full-log on initial load), then bumped to the max `id` seen.
- `cmdText` is back on `Request` for `source: 'real'` rows; it's the RTK `original_cmd`. The Live Request Log Feed renders this through `{text}` segments (no XSS).
- `server.js` gains three endpoints: `/api/rtk`, `/api/rtk/summary`, `/api/rtk/stream`. Plus an `initWatcher()` that `fs.watch()`es the RTK DB directory and broadcasts new commands to `sseClients[]`.
- `RTK_DB_PATH` env var is honoured (overrides the default `~/Library/Application Support/rtk/history.db`). Note: the per-key `.env` writer drops this key, so the user must set it via the shell (R3 env-var-loss regression).
- The mode switcher in the header is visible. Switching modes re-renders the dashboard immediately.
- `0005-remove-real-rtk-mode.md` is now historical context. Its consequences section is still accurate (the things it removed are now back), but the "Removal" framing no longer applies.
- The `BUSINESS_GOALS.md`, `REQUIREMENTS.md`, `USER_JOURNEY.md`, `TECH_STACK.md`, `SYSTEM_DESIGN.md`, `REVIEWS.md`, and `CONTEXT.md` documents are all updated to reflect the re-introduction (PM/Tech Lead/Architect pass; this ADR is the canonical reference).

## Supersedes

- `0005-remove-real-rtk-mode.md` — the removal ADR is now historical context. The current authoritative position is this ADR.
- The "Real RTK Monitor re-introduction is deferred" entry in `BUSINESS_GOALS.md` (older revision) is no longer accurate; the new vision is dual-monitor, real-by-default.

## Related

- `0002-unify-request-stores-by-source.md` — the original unification that collapsed `state.realCommands` and `state.requests` into one. This ADR re-splits them by Source, but the *single per-source retention cap* (500) is preserved.
- `0005-remove-real-rtk-mode.md` — historical context; status now reads "Superseded by `0006`."
- `TECH_STACK.md` §1.1 — endpoint inventory now lists the three Real RTK endpoints.
- `SYSTEM_DESIGN.md` §4.4–§4.6 — API contracts for the Real RTK endpoints; §6.2 — the Real RTK data flow.
