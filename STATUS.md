# Project Status: Local Personal Tool (not production-deployed)

This file tracks the handoff and implementation status of the AI Token Monitor across the agent team roles.

## Status legend
- [x] = complete
- [~] = partially complete
- [ ] = not started

## Role Status Checkpoints

- [x] **👑 Product Owner (PO)**: Brand list defined (Gemini, Antigravity, Claude, Minimax, GLM); personal-dev target user; v1 monitor-only (no kill-switch).
- [~] **📋 Product Manager (PM)**: Functional scope + real-time 30s dashboard + sim/real mode toggle; **5h/Weekly rolling limits added**. Outstanding: no formal `docs/REQUIREMENTS.md` or `docs/USER_JOURNEY.md`.
- [~] **⚡ Technical Lead**: Vanilla HTML/CSS/JS, zero-dep, local Node server. Outstanding: no formal `docs/TECH_STACK.md`; no security baseline doc.
- [~] **🏗️ Architect**: Static SPA, localStorage persistence, dynamic SVG/DOM rendering. Outstanding: no formal `docs/SYSTEM_DESIGN.md`; data store is `localStorage` only (no SQLite for requests), which limits retention and mode-switch fidelity.
- [x] **💻 TDD Engineer**: Implemented formatters, simulation engine, real-RTK adapter. **Caveat: there are no automated tests.** Pure functions (cost calc, cache math, CSV builder) are good candidates for a Vitest suite — not yet written.
- [x] **🕵️ Reviewer**: Two-pass review complete. **`docs/REVIEWS.md` has been generated containing findings and regressions.**
- [~] **🚀 DevOps Engineer**: `package.json` and `node server.js` working. **Outstanding: no CI, no Docker, no `.gitignore` was added in a later pass (now present), no GitHub Actions.**

---

## ⚙️ Running Configuration

* **Local Port**: [http://localhost:3000](http://localhost:3000)
* **Storage**: `localStorage` (`atm_requests`, `atm_brand_metadata`, theme, monitor mode)
* **Real-mode data source**: `~/Library/Application Support/rtk/history.db` (macOS) — overridable via `RTK_DB_PATH` env var
* **Refresh frequency**: 30 s
* **Simulation interval**: 8–20 s (organic random)
* **Request retention cap**: 500 (sim and real)
* **Console log DOM cap**: 200 lines

---

## 🔒 Security posture (post-review fixes)

- [x] Path traversal blocked on static handler
- [x] CORS restricted to `localhost` / `127.0.0.1`
- [x] Shell injection avoided via `execFile` for sqlite
- [x] Env-var injection prevented in `.env` writer (whitelist + newline strip)
- [x] XSS prevented in real-mode log path (DOM-construction + `textContent` for untrusted input)
- [x] API keys returned masked (`****last4`) from `/api/env` GET
- [x] Per-key write endpoint `/api/env/key?key=...` preserves other keys on update
- [x] `.gitignore` added — `.env` and `node_modules` excluded

## ✅ Functional polish (post-review fixes)

- [x] NaN validation in pricing form
- [x] Brand colors read from CSS custom properties (single source of truth)
- [x] Real-mode commands stored separately from sim data (no cross-mode clobber)
- [x] Magic numbers hoisted to named constants
- [x] Unified request retention (sim + real = 500)
- [x] `formatCurrency` handles negative values
- [x] Tooltip on rolling-window reset badges explains the sliding-window semantics
- [x] Console DOM pruned to 200 lines to prevent unbounded growth
- [x] Escape key closes modals

---

## ❌ Known gaps

- No automated tests (cost calc, cache hit math, CSV builder, RTK mapper are all unit-testable)
- No CI pipeline
- No `docs/` folder (the entire PO/PM/Architect doc chain from `.ai.agents/` is unwritten)
- `localStorage` only — no SQLite/JSON persistence for real-mode data across restarts
- 5h/weekly limit labels are hardcoded English; would need i18n
- MacOS-specific RTK DB path; Linux/Windows require `RTK_DB_PATH` env var
- No accessibility audit (keyboard nav, screen reader labels)
- No error boundary in the UI — a single failed fetch silently degrades the dashboard

---

## 🚦 Bottom line

**Not "production ready" in the deployment sense**, but is a **functional, secure-enough local personal tool**. Safe to use on a single machine for the stated purpose. Not safe to expose to a network, not ready for multi-user/multi-tenant use.
