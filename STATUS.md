# Project Status: Local Personal Tool (not production-deployed)

This file tracks the handoff and implementation status of the AI Token Monitor across the agent team roles. Current state is **v1, Simulation-only, four LLM Brands**; the prior Real RTK Monitor Mode and the synthetic `antigravity` Brand were removed (see `docs/adr/0005-remove-real-rtk-mode.md` and `docs/adr/0001-drop-antigravity-brand.md`).

## Status legend
- [x] = complete
- [~] = partially complete
- [ ] = not started

## Role Status Checkpoints

- [x] **👑 Product Owner (PO)**: Brand list is now four real LLM Brands (gemini, claude, minimax, glm); `docs/BUSINESS_GOALS.md` written; v1 monitor-only and Simulation-only.
- [x] **📋 Product Manager (PM)**: `docs/REQUIREMENTS.md` and `docs/USER_JOURNEY.md` written; 10 acceptance criteria; flow covers the (sole) Simulation Mode.
- [x] **⚡ Technical Lead**: Vanilla HTML/CSS/JS, zero-dep, local Node server; `docs/TECH_STACK.md` written; security baseline documented.
- [x] **🏗️ Architect**: Static SPA, `localStorage` persistence, dynamic DOM rendering; `docs/SYSTEM_DESIGN.md` written; data model and API contracts documented.
- [~] **💻 TDD Engineer**: Implemented formatters, simulation engine, settings form. **Caveat: there are no automated tests.** Pure functions (cost calc, cache math, CSV builder) are good candidates for a Vitest suite — not yet written.
- [x] **🕵️ Reviewer**: Three review passes complete (R1, R2, R3, R4) and logged in `docs/REVIEWS.md`. Outstanding items are tracked as R3 in that file.
- [~] **🚀 DevOps Engineer**: `package.json` and `node server.js` working. `.gitignore` is in place. **Outstanding: no CI, no Docker, no GitHub Actions.**

---

## ⚙️ Running Configuration

* **Local Port**: [http://localhost:3000](http://localhost:3000)
* **Storage**: `localStorage` (`atm_requests`, `atm_brand_metadata`, `atm_theme`, `atm_auto_sim`)
* **Data source**: in-app Simulation only. Real RTK ingestion is removed — see `docs/adr/0005-remove-real-rtk-mode.md`.
* **Refresh frequency**: 30 s (local recompute)
* **Simulation interval**: 8–20 s (organic random)
* **Request retention cap**: 500 (single store)
* **Console log DOM cap**: 200 lines
* **Favicon**: `favicon.svg` (whitelisted; previously caused a 404 — fixed)

---

## 🔒 Security posture

- [x] Path traversal blocked on static handler
- [x] CORS restricted to `localhost` / `127.0.0.1`
- [x] Env-var injection prevented in `.env` writer (whitelist + newline strip)
- [x] API keys returned masked (`****last4`) from `/api/env` GET
- [x] Per-key write endpoint `/api/env/key?key=...` validates against the four-key whitelist
- [x] `.gitignore` added — `.env`, `node_modules`, and `.claude/` excluded
- [x] No `eval`, `Function`, or third-party scripts in `index.html`
- [x] No untrusted-string `innerHTML` (the prior real-mode log path is gone with Real Mode)

### Security caveats

- The per-key `/api/env/key` writer **drops** any `.env` keys outside the four-key whitelist on update. Tracked in `docs/REVIEWS.md` R3. The original `RTK_DB_PATH` use case is no longer relevant (RTK is gone), but the loss-of-custom-config behaviour is still live for any other env keys the user adds.
- The server binds to `0.0.0.0:3000` (Node default). Should be `127.0.0.1` in any deployment scenario; not a problem for a personal tool behind a CORS allowlist that already blocks cross-origin reads.

## ✅ Functional polish

- [x] NaN validation in pricing form
- [x] Brand colors read from CSS custom properties (single source of truth)
- [x] Single Request store; Real-mode data store removed
- [x] Magic numbers hoisted to named constants
- [x] Request retention unified at 500
- [x] `formatCurrency` handles negative values
- [x] Tooltip on rolling-window reset badges explains the sliding-window semantics
- [x] Console DOM pruned to 200 lines
- [x] Escape key closes modals
- [x] Brand `antigravity` removed from `DEFAULT_BRAND_METADATA`
- [x] Mode switcher dropdown removed from `index.html` (Real Mode is gone)
- [x] `favicon.svg` whitelisted; `.svg` MIME type added

---

## 📂 Relevant Documentation Files

- **[README.md](./README.md)**: Project overview, setup guide, current Known Gaps.
- **[.ai.agents/README.md](./.ai.agents/README.md)**: Concept and workflow details for the role-based multi-agent development team.
- **[CONTEXT.md](./CONTEXT.md)**: Reference dictionary defining the project's ubiquitous language.
- **[docs/](./docs/)**: Role-chain artifacts (BUSINESS_GOALS, REQUIREMENTS, USER_JOURNEY, TECH_STACK, SYSTEM_DESIGN, REVIEWS) plus `docs/adr/0001` through `0005`.
- **[STATUS.md](./STATUS.md)**: Central state tracker showing role progress and status checkpoints.

---

## ❌ Known gaps

- No automated tests (cost calc, cache hit math, CSV builder are all unit-testable)
- No CI pipeline
- Cache model is internally inconsistent in code (`billedInput = input - saved` coexists with a disjoint rate formula) — see `docs/adr/0003-cache-model-disjoint-input-and-saved.md` and `docs/REVIEWS.md` R3
- `windowLabel` and `meta.limit` still in `DEFAULT_BRAND_METADATA` — see `docs/adr/0004-fixed-rolling-windows.md` and `docs/REVIEWS.md` R3
- Env-var loss bug: per-key writer drops `.env` keys outside the four-key whitelist — see `docs/REVIEWS.md` R3
- `localStorage` only — no cross-restart persistence for Request history
- Limit labels are hardcoded English; would need i18n
- No accessibility audit (keyboard nav, screen reader labels)
- No error boundary in the UI — a single failed fetch silently degrades the dashboard
- No `tests/` directory yet; TDD role is `[~]` not `[x]` for that reason

---

## 🚦 Bottom line

**Not "production ready" in the deployment sense**, but is a **functional, secure-enough local personal tool**. Safe to use on a single machine for the stated purpose. Not safe to expose to a network, not ready for multi-user/multi-tenant use.
