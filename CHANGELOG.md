# Changelog

> Owner: Product Owner. Release history for the AI Token Monitor. Versions track the merged state of `dev`; the most recent entry is at the top.

The format is loosely inspired by [Keep a Changelog](https://keepachangelog.com/). Dates are in GMT+7 (project default per `CONTEXT.md`).

## Unreleased

### Added
- Real token counting for the Antigravity CLI parser: `lib/antigravity-parser.js` calls Gemini `countTokens` for each unique string when `GEMINI_API_KEY` is set in `.env`, with a process-local text cache and a `chars/4` heuristic fallback for the no-key / error paths. (`1bb20bc`)
- New `lib/antigravity-context.js` helper exposing the most recently updated `agent_usage` row within `ACTIVE_SESSION_MS = 30 minutes`. Numerator is `inputTokens + cachedTokens`; denominator defaults to `1_000_000` (Gemini 1.5 Pro / 2.0 Flash / 2.5 Pro context window) and is overridable via `GEMINI_CONTEXT_WINDOW`. Wired into `GET /api/agent-usage` as the `contextWindow` field. (`8e23249`)
- `server.js` now reads `GEMINI_API_KEY` from `.env` on boot and hands it to the parser so the real `countTokens` path activates without a server restart.
- Acceptance criteria AC-26, AC-27, AC-28 in `docs/REQUIREMENTS.md`.
- ADR `0009-restore-antigravity-percent-bars.md` documenting the bar-restoration decision.
- R8 review pass in `docs/REVIEWS.md` covering the three commits end-to-end.
- New test file `tests/antigravityContext.test.js` (6 tests); `tests/antigravityParser.test.js` extended with 5 new `countTokensFor` cases.

### Changed
- `app.js`: the `isAntiqravity ? … : …` ternary in `renderBrandCards()` is removed. The gemini brand card now uses the same two-bar template (5-Hour and Weekly) as claude / minimax / glm. Dead locals (`tokens5h`, `tokensWeekly`, `cost5hDisplay`, `costWeeklyDisplay`) are gone. (`8ee1283`)
- `package.json`: `@google/generative-ai` is now a runtime dependency.
- Vitest suite: **20 files, 223 tests, ~530 ms** (was 19 files / 217 tests pre-R8).

### Removed
- Nothing. The `contextWindowHtml` interpolation block in `app.js` from `8e23249` is no longer referenced by the unified template but is intentionally kept on disk as scaffolding for a future context-window bar (see R8-X1).

### Known regressions / follow-ups
- None at this time. The 1M default is the modern Gemini context window; users on a 2M Pro plan can set `GEMINI_CONTEXT_WINDOW=2000000` to match. Documented in the ADR.
