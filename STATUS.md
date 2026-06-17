# Project Status: Local Personal Tool (not production-deployed)

This file tracks the handoff and implementation status of the AI Token Monitor across the agent team roles. Current state is **v1, dual-monitor (Real RTK by default + Simulation), four LLM Brands, provider-quota tracking**. The prior `antigravity` Brand is still dropped (`0001`). Real RTK Monitor Mode was removed in `0005` and re-introduced (tracked under `0006` by the Architect); the cache-model ADR (`0003`) is now applied in code.

## Status legend
- [x] = complete
- [~] = partially complete
- [ ] = not started

## Role Status Checkpoints

- [x] **👑 Product Owner (PO)**: Defined target brand list, dual-monitor scope, SQLite backend, **and provider-quota tracking vision** in [docs/BUSINESS_GOALS.md](./docs/BUSINESS_GOALS.md). Vision covers Real RTK (default), Simulation, and live vendor-quota awareness.
- [x] **📋 Product Manager (PM)**: `docs/REQUIREMENTS.md` and `docs/USER_JOURNEY.md` written and refreshed; `§2.8 Provider-Quota Tracking` added, 4 new acceptance criteria (AC-13 to AC-16), AC-12 corrected for the re-introduced mode switcher, new primary journey "Am I about to hit the vendor's 5-hour cap?".
- [x] **⚡ Technical Lead**: Vanilla HTML/CSS/JS, zero-dep, local Node server; `docs/TECH_STACK.md` written and refreshed to cover the `/api/seed-quotas` endpoint, SSE stream, MiniMax HTTPS integration, server-side SQLite layer, and outbound-network security baseline.
- [x] **🏗️ Architect**: `docs/SYSTEM_DESIGN.md` rewritten with `brand_quota` schema, new API contracts (`/api/rtk`, `/api/rtk/summary`, `/api/rtk/stream`, `/api/rtk/ingest`, `/api/seed-quotas`), dual-monitor data flow, and the "Defensive API parsing" design pattern. `docs/adr/0006-reintroduce-real-rtk-mode.md` written; `0005` and `0003` status updated. **R7** added the `POST /api/rtk/ingest` contract for non-RTK clients.
- [x] **💻 TDD Engineer**: Implemented formatters, simulation engine, settings form, **Real RTK mode with SSE streaming**, **provider-quota tracking with live MiniMax fetcher**, **API-driven progress bar**, and **single-command ingest endpoint** (`POST /api/rtk/ingest`) for any project on this machine. **Vitest suite**: 16 test files, 140 tests. `lib/` now has 12 shared modules (`antigravity-parser`, `brand-detect`, `brand-fetchers`, `dom-utils`, `env`, `firebase`, `format`, `pricing-defaults`, `quota-cache`, `quota-utils`, `rtk-metrics`, `sse-watcher`). The mirror-function approach is documented at the top of each test file.
- [x] **🕵️ Reviewer**: Six review passes complete (R1, R2, R3, R4, R5, R7) and logged in `docs/REVIEWS.md`. R5 covers the Real RTK re-introduction, `brand_quota` schema, MiniMax fetcher, API-driven bar, and the recent UI polish — 8 ✅, 3 ⚠️ documented gaps, 0 ❌ regressions. R7 covers the custom-project ingest endpoint — 5 ✅, 0 ❌, 0 ⚠️.
- [x] **🚀 DevOps Engineer**: `package.json` and `node server.js` working. `.gitignore` is in place. CI pipeline landed at `.github/workflows/ci.yml` (Node 20, `npm install`, `npm run check`, `npm test`, sqlite3 smoke test, GET `/`, `/api/summary`, `/api/seed-quotas` boot probe). Container image landed: `Dockerfile` (node:20-slim + system sqlite3, unprivileged user, loopback bind, healthcheck on `/api/summary`) and `.dockerignore` (mirrors `.gitignore`, excludes tests/docs/agent scaffolding). Server now binds to `127.0.0.1` (loopback-only). Uncaught exception handlers added.

---

## ⚙️ Running Configuration

* **Local Port**: [http://localhost:3000](http://localhost:3000)
* **Storage**: `localStorage` (`atm_requests`, `atm_brand_metadata`, `atm_theme`, `atm_auto_sim`)
* **Data sources** (dual monitor):
  * **Real RTK Monitor** (default): reads `~/Library/Application Support/rtk/history.db` (overridable via `RTK_DB_PATH`), served via `/api/rtk` (full snapshot) and `/api/rtk/stream` (SSE for incremental updates). **Custom-project ingest**: any project on this machine can `POST /api/rtk/ingest` to count its own LLM usage toward the dashboard.
  * **Simulation**: in-app synthetic traffic on an 8-20s schedule.
* **Provider quota cache**: `brand_quota` SQLite table, populated by `seedBrandQuotas()` in `server.js`, surfaced via `GET /api/seed-quotas`. Force-refresh via `POST /api/seed-quotas {"force": true}`.
* **Refresh frequency**: 30 s (local recompute); brand-quota cache TTL is 1 hour when a reset window is exposed, 1 minute otherwise.
* **Simulation interval**: 8–20 s (organic random)
* **Request retention cap**: 500 (single store, applied in both modes)
* **Console log DOM cap**: 200 lines
* **Favicon**: `favicon.svg` (whitelisted)

---

## 🔒 Security posture

- [x] Path traversal blocked on static handler
- [x] CORS restricted to `localhost` / `127.0.0.1`
- [x] Env-var injection prevented in `.env` writer (whitelist + newline strip)
- [x] API keys returned masked (`****last4`) from `/api/env` GET
- [x] Per-key write endpoint `/api/env/key?key=...` validates against the four-key whitelist
- [x] `.gitignore` added — `.env`, `node_modules`, and `.claude/` excluded
- [x] No `eval`, `Function`, or third-party scripts in `index.html`
- [x] `appendConsoleLine` segments distinguish trusted `{html}` from escaped `{text}`; all untrusted RTK `original_cmd` text goes through `{text}`

### Security caveats

- The per-key `/api/env/key` writer **drops** any `.env` keys outside the four-key whitelist on update. Tracked in `docs/REVIEWS.md` R3. `RTK_DB_PATH` (a non-whitelisted key the Real RTK mode honours via `process.env`) is one such key — adding it via the UI is silently lost; the user must set it via the shell.
- The server binds to `0.0.0.0:3000` (Node default). Should be `127.0.0.1` in any deployment scenario; not a problem for a personal tool behind a CORS allowlist that already blocks cross-origin reads.

## ✅ Functional polish

- [x] NaN validation in pricing form
- [x] Brand colors read from CSS custom properties (single source of truth)
- [x] Request store: `state.realCommands` for Real mode, `state.requests` for Simulation; `getActiveRequests()` selects by `state.monitorMode`
- [x] Magic numbers hoisted to named constants
- [x] Request retention unified at 500
- [x] `formatCurrency` handles negative values
- [x] Tooltip on rolling-window reset badges explains the sliding-window semantics
- [x] Console DOM pruned to 200 lines
- [x] Escape key closes modals
- [x] Brand `antigravity` removed from `DEFAULT_BRAND_METADATA`
- [x] Real-time SSE stream for new RTK commands
- [x] **Provider-quota tracking**: `brand_quota` table, `/api/seed-quotas`, `BRAND_FETCHERS` registry, MiniMax HTTPS fetcher, Claude/Gemini/GLM header-based fetchers
- [x] **API-driven progress bar**: bar fill and color reflect provider's used % when a quota is present, with a tooltip distinguishing API vs local-spend source
- [x] **Authoritative reset times**: badge prefers the provider's `reset_at` / `reset_at_weekly` over the local rolling-log estimate
- [x] **Theme-aware form controls**: all `<input>`, `<select>`, and tab content use CSS variables; custom SVG chevron for dropdowns; focus glow in both light and dark modes
- [x] **Compact API Tokens tab**: monospace labels, fixed 170px width, 12px font
- [x] **Live Request Log Feed** filters to the last 15 LLM-classified commands on initial load (shell noise no longer pushes real API calls out of the feed)
- [x] Idempotent `ALTER TABLE` migrations for `reset_at_weekly` and `weekly_remaining` columns
- [x] **Multi-project tracking and log badges**: included `project_path` in SQLite and SSE queries, prepended project name badges to console logs, and displayed individual project-and-brand usage breakdown in the "Usage by Project (7-day)" section.

---

## 📂 Relevant Documentation Files

- **[README.md](./README.md)**: Project overview, setup guide, current Known Gaps.
- **[.ai.agents/README.md](./.ai.agents/README.md)**: Concept and workflow details for the role-based multi-agent development team.
- **[CONTEXT.md](./CONTEXT.md)**: Reference dictionary defining the project's ubiquitous language.
- **[docs/](./docs/)**: Role-chain artifacts (BUSINESS_GOALS, REQUIREMENTS, USER_JOURNEY, TECH_STACK, SYSTEM_DESIGN, REVIEWS) plus `docs/adr/0001` through `0006`.
- **[STATUS.md](./STATUS.md)**: Central state tracker showing role progress and status checkpoints.

---

## ❌ Known gaps

- **Env-var loss bug**: per-key writer drops `.env` keys outside the four-key whitelist (including `RTK_DB_PATH` which the Real RTK mode honours) — see `docs/REVIEWS.md` R3
- **Cache model in pre-populated history**: `generateInitialMockHistory()` and the cost path now use the disjoint model (per ADR-0003), but the pre-populated `SIM_HISTORY_PRELOAD` may still emit `inputTokens` values that look small relative to historical `savedTokens`; a follow-up audit is in the Reviewer's R5 scope
- **`windowLabel` and `meta.limit` still in `DEFAULT_BRAND_METADATA`** — see ADR-0004 and `docs/REVIEWS.md` R3
- `localStorage` only — no cross-restart persistence for Request history
- Limit labels are hardcoded English; would need i18n
- No accessibility audit (keyboard nav, screen reader labels)
- No error boundary in the UI — a single failed fetch silently degrades the dashboard
- `RTK_DB_PATH` honoured from `process.env` but not from `.env` due to the env-var-loss bug above
- No historical quota trend chart (only current snapshot)

---

## 🚦 Bottom line

**Not "production ready" in the deployment sense**, but is a **functional, secure-enough local personal tool** that now supports both **real RTK traffic** and **in-app simulation**, plus **live provider-quota awareness** across all four brands. Safe to use on a single machine for the stated purpose. Not safe to expose to a network, not ready for multi-user/multi-tenant use.
