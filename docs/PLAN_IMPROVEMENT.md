# Improvement Plan

> Roles: Product Owner · Product Manager · Tech Lead
> Date: 2026-06-12
> Scope: Full codebase review — `server.js`, `app.js`, `lib/`, `firmware/`, `tests/`, `docs/`

---

## 1. Executive Summary

The project has advanced since the last revision of this plan. A substantial refactor landed: `lib/antigravity-parser.js`, `lib/brand-fetchers.js`, `lib/firebase.js`, and `lib/rtk-metrics.js` now own the modular concerns that previously bloated `server.js` (which fell from ~1,400 to ~696 lines). The disjoint cache model is applied in code (ADR-0003), the `meta.limit` / `meta.windowLabel` dead fields are gone, the `.env` writer now preserves siblings, and `lib/brand-fetchers.js` exposes a shared `httpsRequest` helper. Fourteen of the nineteen items in the previous revision are now closed. This rewrite tracks only the items that are still open, plus a new batch of architectural and quality improvements that the prior plan did not anticipate.

**Three headline findings:**

1. **The simulation mode switcher was removed from the UI entirely, not merely hidden.** `index.html` has no `<select id="monitor-mode-select">` and `app.js` has no toggle handler. A v1 must-have (BUSINESS_GOALS §Prioritisation #10) is silently unmet; the codebase still runs the simulator under the hood but the user has no way to enable it.
2. **`lib/rtk-metrics.js` re-declares the four-brand pricing table inline.** `app.js` `DEFAULT_BRAND_METADATA` (line 23) and `lib/rtk-metrics.js` `METADATA` (line 31) carry the same numbers from two sources. Drift here will produce silent disagreement between server-side RTK spend aggregation and client-side cost display.
3. **`node --check` and CI do not cover `lib/`.** The `check` script (package.json line 8) only validates `server.js` and `app.js`. `lib/*.js` files can contain syntax errors that only surface at boot.

---

## 2. Verification: Items closed since the prior plan

The following items in the prior revision are already resolved in the current code. Listed here for the Reviewer so the next review pass does not re-open them.

| Old ID | Topic | Closed by | Evidence |
|---|---|---|---|
| P1 | Simulation button `display:none` | (the button is **gone**, not hidden — see PO-1 below) | grep finds no `toggle-sim-btn` in `index.html` or `app.js` |
| P3 | Dead `meta.limit` / `meta.windowLabel` | applied in code | grep for `windowLabel` and `meta.limit` returns no hits in `app.js` |
| F1 | `Request.source` not set | applied in code | `app.js:1196`, `app.js:1267` set `source: 'real'` |
| F2 | `state.monitorMode` missing | applied in code | `app.js:35` initialises `monitorMode: 'real'`; `app.js:1145` filters by it |
| F3 | `.env` writer drops siblings | applied in code | `server.js:172-184` reads existing `.env` first, merges in whitelisted keys, writes full map |
| F4 | `SYSTEM_DESIGN.md` §2 stale | refreshed | `docs/SYSTEM_DESIGN.md` §2 now lists `lib/` and `tests/` |
| T1 | `getRtkSpendMetrics` called 3-4× | applied | `server.js:690` calls `publishToFirebase(results, env, rtkSpend)` |
| T2 | No `WHERE` clause on RTK query | applied | `lib/rtk-metrics.js:15` has `WHERE timestamp >= datetime('now', '-7 days')` |
| T3 | `loadEnv` called twice | applied | `server.js:580` reads env once, passes to `publishToFirebase` |
| T4 | Dead `triggerSilentQuotaSync` | applied | grep finds no occurrences in `app.js` |
| T5 | `state.requests` never rendered | applied | `app.js:1145` `getActiveRequests` returns the right store for the active mode |
| T6 | `isWeeklyEntry` unused `fiveH_MS` | applied | `lib/brand-fetchers.js:289` signature is `(entry, sevenD_MS)` |
| T7 | Hardcoded home path | applied | `lib/rtk-metrics.js:11` uses `process.env.HOME \|\| require('os').homedir()` |
| T9 | Dual `detectBrand` | aligned (with one doc bug, see TL-8) | both client and server return `null` for unmatched |
| T11 | HTTPS boilerplate extraction | applied | `lib/brand-fetchers.js:11-25` `httpsRequest` helper |
| T12 | `package.json "main"` wrong | applied | `package.json` line 5 is `"main": "server.js"` |
| T10 | Module split (partial) | partly applied | `lib/` tree exists; ~50% of the original T10 scope. See TL-4. |

The previous plan incorrectly described T9 (the client version was said to fall back to `'claude'`; both versions return `null`). See TL-8 for the resulting doc bug.

---

## 3. PO Layer — Business Value Gaps

### PO-1 — Simulation mode is **missing**, not just hidden (P0)

**Files:** `index.html` header controls, `app.js` init/state plumbing

The prior plan (P1) said the simulation toggle button was `display:none`. Worse: the button no longer exists. There is no `<select>` or `<button>` in the header that switches between "Real RTK Monitor" and "Simulation", and `app.js` has no `setupMonitorModeToggle` or equivalent. The simulator functions (`scheduleNextSimulation`, `triggerRandomMockRequest`, `addRequest`) are still in the file but unreachable from the UI. v1 must-have #10 (BUSINESS_GOALS §Prioritisation) is unmet.

**Action:** Add a `<select id="monitor-mode-select">` in the header with two options:
- `"Real RTK Monitor"` (default)
- `"Simulation"`

Wire it to flip `state.monitorMode`, persist to `localStorage.atm_monitor_mode`, restore in `init()`, and gate `connectRTKStream` / `scheduleNextSimulation` on the value. Add a Vitest that switches modes, asserts the active store changes, and that reload restores the selection.

### PO-2 — KPIs are unmeasured (P3)

`BUSINESS_GOALS.md` lists four qualitative KPIs (time-to-first-cost, cache visibility, limit awareness, quota freshness) with no instrumentation. For a single-user personal tool this is acceptable, but a loopback-only `/api/diagnostics` endpoint returning `{lastRefreshMs, lastQuotaFetchMs, brandQuotasStalenessMs, simRunning, realConnected}` would make the success criteria testable and close three of the four open "Known Gaps" at once.

**Action:** Add a non-routable-on-LAN `/api/diagnostics` (already safe under the existing CORS allowlist) that returns timestamp diffs and a single boolean per data source. No tests required beyond a smoke that the shape is correct.

### PO-3 — ESP32 companion has no acceptance criteria (P3)

The ESP32 OLED mirror is in the vision, the README, and `CONTEXT.md` but lives outside `REQUIREMENTS.md` and `USER_JOURNEY.md`. The Reviewer has no AC to check it against. The PO owns declaring it in-scope; the PM owns the AC block (see PM-6).

**Action:** Open a PM-side ticket to add AC-17 to AC-20 covering PUT cadence, payload sanitisation, no-op when `FIREBASE_URL` is unset, and the 30s polling interval.

---

## 4. PM Layer — Feature & UX Gaps

### PM-1 — `state.requests` is dead data in `localStorage` in Real mode (P0)

**File:** `app.js:686, 730, 807`

`addRequest` (line 686) and `generateInitialMockHistory` (line 730) call `localStorage.setItem('atm_requests', ...)` on every sim tick and on first load. In Real mode these writes accumulate sim data that is never read back; the only consumer is the reset handler (line 807). This is silent localStorage waste and a source of confusion for the Reviewer.

**Action:** Wrap the `localStorage.setItem('atm_requests', …)` calls with `if (state.monitorMode === 'sim')`. Add a Vitest that switches modes, ticks the simulator once, and asserts `localStorage.atm_requests` remains empty in Real mode.

### PM-2 — AC-12 is shallow (P1)

`REQUIREMENTS.md` AC-12 says: *"The header mode switcher exposes both 'Real RTK Monitor' and 'Simulation'; the selection persists in `localStorage` under `atm_monitor_mode`."* It does not cover:
- Reload restores the selection.
- Switching mid-session does not lose history of the inactive store.
- The Live Request Log Feed updates its "last 15" after a switch.
- The console status dot reflects the active source.

**Action:** Expand AC-12 into AC-12a..d. Add Vitest coverage of `getActiveRequests()` against both stores.

### PM-3 — No AC for the `.env` sibling-preservation fix (P1)

`F3` (env-var-loss) is closed in code but `REQUIREMENTS.md` has no AC for it. A regression would silently re-delete `RTK_DB_PATH` or `FIREBASE_URL` on the next save.

**Action:** Add AC-21: *"After `POST /api/env/key?key=ANTHROPIC_API_KEY&value=new`, the `.env` file still contains the previous values of any non-whitelisted key (e.g. `RTK_DB_PATH`, `FIREBASE_URL`)."* Add a Vitest that writes a fake `.env`, calls the endpoint, and asserts all keys round-trip.

### PM-4 — `USER_JOURNEY.md` still describes the removed "Send Custom Request" modal (P2)

`USER_JOURNEY.md` "Edge case journeys" reference `Send Custom Request` in two places. The README "Recently Closed" log says it was removed.

**Action:** Replace both `Send Custom Request` references with the mode switcher / Active Provider selector behaviour, and add a journey for "I want to verify the dashboard is reading my real RTK traffic" (no equivalent exists today).

### PM-5 — Monthly / all-time aggregates are an undocumented deferred (P2)

There is no way to see "what did I spend last month" — only 5h and 7d. Treated as a deferred nice-to-have, but not stated anywhere as out of scope.

**Action:** Add a one-line "Out of scope" entry in `REQUIREMENTS.md §Out of scope`: *"Monthly / all-time historical aggregates (only 5h and 7d rolling windows are exposed)."*

### PM-6 — ESP32 acceptance criteria (P3, owner: PO cross-ref)

See PO-3. PM to author the AC block once PO confirms in-scope.

---

## 5. Tech Lead Layer — Code Quality & Architecture

### TL-1 — `node --check` and CI do not cover `lib/` (P0)

**File:** `package.json:8`
```json
"check": "node --check server.js && node --check app.js"
```
`server.js` requires `./lib/firebase`; `lib/brand-fetchers.js` is required transitively. A typo in any `lib/*.js` only surfaces at boot, after CI has already reported green.

**Action:** Extend the check script to include every file under `lib/`. Replace the explicit list with a glob, e.g.:
```json
"check": "node --check server.js && node --check app.js && find lib -name '*.js' -exec node --check {} \\;"
```
Mirror the same glob in `.github/workflows/ci.yml`. This is a one-line CI fix; no tests required.

### TL-2 — Two pricing sources of truth (P0)

**Files:** `app.js:23` (`DEFAULT_BRAND_METADATA`), `lib/rtk-metrics.js:31` (inline `METADATA`)

Both files carry the same four-brand pricing table. Drift between them will produce silent disagreement between the server-side RTK spend aggregation and the client-side cost display. The two `getRtkSpendMetrics` callers (`publishToFirebase` and the GLM reset-fallback path) trust the server-side copy; if the user changes a rate in the UI, the server's view is unchanged until the next deploy.

**Action:** Extract `lib/pricing-defaults.js` exporting the four-brand metadata object. Use a UMD-style export so it works in both Node and the browser:
```js
// lib/pricing-defaults.js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PRICING_DEFAULTS = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    gemini:  { name: 'Antigravity', inputCost: 1.25, outputCost: 5.00,  limit5h: 2.00, limitWeekly: 15.00 },
    claude:  { name: 'Claude',      inputCost: 3.00, outputCost: 15.00, limit5h: 5.00, limitWeekly: 30.00 },
    minimax: { name: 'Minimax',     inputCost: 1.00, outputCost: 4.00,  limit5h: 2.00, limitWeekly: 15.00 },
    glm:     { name: 'GLM',         inputCost: 0.50, outputCost: 2.00,  limit5h: 0.80, limitWeekly:  6.00 }
  };
}));
```
Both `app.js` (via `<script src="lib/pricing-defaults.js">` in `index.html`) and `lib/rtk-metrics.js` (via `require`) consume the same module. `app.js` `DEFAULT_BRAND_METADATA` becomes `PRICING_DEFAULTS`. Add a Vitest asserting the two importers see the same object.

### TL-3 — `httpsRequest` has no timeout (P1)

**File:** `lib/brand-fetchers.js:11-25`

The helper resolves on `end` and rejects on `error`. It does not call `req.setTimeout(...)` and has no `Promise.race` against a timer. A hung TCP socket (e.g. `bigmodel.cn` drops the SYN-ACK mid-stream) will leak an open file descriptor and a pending Promise for ~2 minutes (Node's `keepAliveTimeout` default).

**Action:** Add `req.setTimeout(8000, () => { req.destroy(new Error('HTTPS timeout after 8s')) })` before `req.end()`. Add a Vitest that delays the `end` event on a mock socket and asserts rejection within 9s.

### TL-4 — `server.js` is still 696 lines and mixes five concerns (P1)

**File:** `server.js`

Verified: `wc -l server.js` = 696. The original T10 module split is half done. The remaining mixed concerns are:
- `loadEnv()` + both `.env` route handlers (lines 146-200, 202-237)
- `ensureBrandQuotaTable()` + idempotent `ALTER TABLE` migrations (inside `seedBrandQuotas`)
- `initWatcher()` + the SSE stream handler (lines 95+)
- The `BrandQuota` row mapper (raw_json → shape)
- The startup browser-launch `exec('open …')` block

**Action:** Continue the refactor with three more files. Diff is mechanical (export from one, require in the other, adjust call sites):

| New module | What moves there |
|---|---|
| `lib/env.js` | `loadEnv`, `maskSecret`, both `.env` route handlers |
| `lib/quota-cache.js` | `ensureBrandQuotaTable`, `seedBrandQuotas`, the `BrandQuota` row mapper, the TTL constants (see TL-10) |
| `lib/sse-watcher.js` | `initWatcher`, the SSE handler closure, the `sseClients` array |

End state: `server.js` becomes a ~200-line HTTP routing skeleton.

### TL-5 — `app.js` is 1,327 lines and mixes rendering, DOM, and detection (P1)

**File:** `app.js`

Verified: `wc -l app.js` = 1,327. T10 was about `server.js`; `app.js` deserves the same treatment. Candidate splits, all using the UMD pattern from TL-2:

| New module | What moves there |
|---|---|
| `app/format.js` | `formatCurrency`, `formatNumber`, `formatCompactNumber`, `formatTimeRemaining` |
| `app/dom.js` | `appendConsoleLine`, `logEvent`, `logEventSafe`, `escapeHtml` |
| `app/brand-detect.js` | `detectBrand` (referenced from `app.js` *and* indirectly from `lib/rtk-metrics.js`; even the comment at `app.js:1310` says "see also") |

End state: `app.js` becomes a ~700-line orchestrator (state, render, event wiring, mode switching).

### TL-6 — `calculateAndRenderDashboard` re-runs on every SSE message (P1)

**File:** `app.js:1281` (inside `connectRTKStream.onmessage`)

Every new RTK command fires a full re-render. Under burst load (e.g. a 5-message batch from a coding agent in <1s), the dashboard walks every `state.realCommands` entry, recomputes aggregates, and rewrites all four brand cards + the table five times. None of the renders are batched.

**Action:** Wrap the `calculateAndRenderDashboard()` call inside `onmessage` with a 200ms `setTimeout` coalescer (or `requestAnimationFrame`). Cancel the previous timer if a new message arrives. Add a Vitest that fires 5 `addRequest` calls in a row and asserts `calculateAndRenderDashboard` is invoked once.

### TL-7 — `extractRemaining` carries dead MiniMax field aliases (P2)

**File:** `lib/brand-fetchers.js:304-313`

The defensive parser lists eight field aliases for the MiniMax "remaining" value. R5-X2 acknowledged this is a "defensive parsing" pattern, but at least three of those aliases (`usagePercent`, `remaining_count`, `current_remaining_count`) are not observed in the wild — they are speculative. Speculative aliases are **anti-defensive**: if MiniMax renames a field, the wrong alias might still match, and the fetcher will silently start returning wrong numbers.

**Action:** Trim the alias list to the three that are actually observed:
- `current_interval_remaining_percent`
- `current_interval_remaining_count`
- `current_window_remaining_count`

Add a single Vitest that asserts each alias resolves to a known field. Anything beyond these becomes a `console.warn` so future breakage is loud, not silent.

### TL-8 — `detectBrand` comment contradicts code (P2)

**File:** `app.js:1310-1314`
```js
// See also detectSpecificBrand() in server.js — same patterns but falls back
// to 'claude' (not null) because in the RTK context unmatched commands are
// typically Claude Code tool calls without an explicit 'anthropic' marker.
```
But `lib/rtk-metrics.js:57-65` `detectSpecificBrand` returns `null` for unmatched. The comment is wrong; the prior plan's T9 (which said the server version falls back to `'claude'`) was also wrong. Both implementations return `null`; unmatched RTK rows are dropped from cost aggregation.

**Action:** Decide on `null` for both (recommended, since unmatched rows are ambiguous), rewrite the comment to match, and add a Vitest asserting both functions return the same value for a fixture of 10 `original_cmd` strings. Also update `CONTEXT.md` example dialogue ("If a Brand hits the cache …" — no change needed) and the R5 review log.

### TL-9 — Droid-Shield pre-push secret scanner has a known false-positive (P3)

The README Known Gap #11 says Droid-Shield flags `tokens5h` variable names and `0` default values as if they were tokens. The workaround is `git push --no-verify`. The local false-positive is harmless but should be silenced at source.

**Action:** Add a `.droid-shield-allowlist` (or whatever its config format is) with the false-positive pattern, or scope the scanner to a more specific directory. One commit. No tests.

### TL-10 — Quota TTL constants live in two places (P2)

**File:** `server.js` (the `seedBrandQuotas` block), `lib/brand-fetchers.js` (the `httpsRequest` consumer)

The 1-minute TTL for short-window providers and the 1-hour TTL for reset-exposing providers are hard-coded in `seedBrandQuotas` (server.js). When TL-4 extracts `lib/quota-cache.js`, hoist the constants:
```js
const QUOTA_TTL_MS_FAST = 60_000;       // short-window providers (MiniMax 3-min)
const QUOTA_TTL_MS_SLOW = 3_600_000;    // reset-exposing providers (Claude, GLM)
```

**Action:** Bundle into the TL-4 refactor. No separate tests; the existing quota-cache tests cover the behaviour.

---

## 6. Priority Matrix

| ID | Area | Impact | Effort | Priority |
|---|---|---|---|---|
| **PO-1** | Simulation switcher missing (regression) | High | S | **P0** |
| **PM-1** | `state.requests` always persisted (waste) | Medium | XS | **P0** |
| **TL-1** | `node --check` doesn't cover `lib/` | High | XS | **P0** |
| **TL-2** | Two pricing sources of truth | High | S | **P0** |
| **PM-2** | AC-12 doesn't cover reload/switch/feed | Medium | S | **P1** |
| **PM-3** | No AC for env-var sibling preservation | Medium | S | **P1** |
| **TL-3** | `httpsRequest` has no timeout | High (reliability) | XS | **P1** |
| **TL-4** | `server.js` still 696 lines, 5 mixed concerns | Medium | M | **P1** |
| **TL-5** | `app.js` still 1,327 lines, 3 mixed concerns | Medium | M | **P1** |
| **TL-6** | SSE re-renders coalesce into 1/rAF | Medium (perf) | S | **P1** |
| **TL-7** | Trim dead MiniMax field aliases | Low (clarity) | S | **P2** |
| **TL-8** | `detectBrand` comment contradicts code | Low (clarity) | XS | **P2** |
| **TL-10** | Hoist quota TTL constants | Low | XS | **P2** |
| **PM-4** | `USER_JOURNEY.md` stale on removed modal | Low | XS | **P2** |
| **PM-5** | Document monthly aggregates as out of scope | Low | XS | **P2** |
| **PO-2** | `/api/diagnostics` for KPIs | Medium | S | **P3** |
| **PO-3 / PM-6** | ESP32 AC block in REQUIREMENTS | Low | S | **P3** |
| **TL-9** | Droid-Shield allowlist | Low | XS | **P3** |

---

## 7. Phased Roadmap

### Phase 1 — Fix regressions and silent breakage (P0, 1–2 hours)

1. **PO-1** — Add the mode switcher to `index.html` header controls; wire to `state.monitorMode`; persist and restore in `init()`.
2. **PM-1** — Gate the three `localStorage.setItem('atm_requests', …)` calls on `state.monitorMode === 'sim'`.
3. **TL-1** — Extend `npm run check` and CI to cover `lib/*.js` via `find -exec`.
4. **TL-2** — Extract `lib/pricing-defaults.js` (UMD pattern); update both `app.js` and `lib/rtk-metrics.js` to consume it.

### Phase 2 — Reliability and re-render perf (P1, 2–3 hours)

5. **TL-3** — Add `req.setTimeout(8000, …)` to `httpsRequest`.
6. **PM-2** — Expand AC-12 into AC-12a..d in `REQUIREMENTS.md`; add the two Vitest cases.
7. **PM-3** — Add AC-21 in `REQUIREMENTS.md`; add the `.env` round-trip Vitest.
8. **TL-6** — Coalesce `calculateAndRenderDashboard` calls inside `onmessage` with a 200ms timer.

### Phase 3 — Finish the module split (P1, 3–4 hours)

9. **TL-4** — Extract `lib/env.js`, `lib/quota-cache.js`, `lib/sse-watcher.js`. Bundles **TL-10** (hoist TTL constants).
10. **TL-5** — Extract `app/format.js`, `app/dom.js`, `app/brand-detect.js` from `app.js` using the same UMD pattern.

### Phase 4 — Documentation and small cleanups (P2, 1 hour)

11. **TL-7** — Trim `extractRemaining` to three observed aliases; add `console.warn` for unknowns.
12. **TL-8** — Rewrite the `detectBrand` cross-reference comment; add the equivalence Vitest; update the R5 review log.
13. **PM-4** — Replace the two `Send Custom Request` references in `USER_JOURNEY.md`; add the new "verify Real RTK" journey.
14. **PM-5** — Add the "Monthly / all-time aggregates" line to `REQUIREMENTS.md §Out of scope`.

### Phase 5 — Observability and housekeeping (P3, 1 hour)

15. **PO-2** — Add `/api/diagnostics` endpoint.
16. **PO-3 / PM-6** — Author AC-17..AC-20 in `REQUIREMENTS.md` for the ESP32 companion.
17. **TL-9** — Add the Droid-Shield allowlist entry.
