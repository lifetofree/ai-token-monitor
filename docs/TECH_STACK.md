# Tech Stack & Engineering Standards

> Owner: Technical Lead. Finalised stack, coding standards, branching strategy, and security baseline. See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## 1. Stack

### 1.1 Runtime & languages

- **Server**: Node.js (no framework). `server.js` (~750 lines) handles static asset serving, eight API endpoints, CORS, path-traversal protection, an SSE handler, an outbound HTTPS client, and a `child_process.execFile('sqlite3', …)` reader. No Express, no Koa, no Fastify. Endpoints in scope:
  - `GET /api/env`, `POST /api/env`, `POST /api/env/key` — `.env` read/write
  - `GET /api/rtk`, `GET /api/rtk/summary`, `GET /api/rtk/stream` — Real RTK Monitor (snapshot, summary, SSE)
  - `GET /api/seed-quotas`, `POST /api/seed-quotas` — provider-quota cache
- **Client**: vanilla ES2020 in the browser. No bundler, no transpiler, no framework. `app.js` (~1,200 lines) attaches one `DOMContentLoaded` handler and renders into pre-existing DOM nodes.
- **Templating**: none. The HTML is a static `index.html`; dynamic content is built by `document.createElement` and `appendChild` (not `innerHTML` for untrusted data).
- **CSS**: hand-written `styles.css` with CSS custom properties for the design system. No preprocessor, no utility framework, no component library.

### 1.2 Persistence

- **Client**: `localStorage` under `atm_*` keys (`atm_requests`, `atm_brand_metadata`, `atm_theme`, `atm_auto_sim`, `atm_monitor_mode`).
- **Server-side SQLite caches** (in the same DB the server uses for the RTK history read; distinct from any user-owned DB):
  - `brand_quota` — provider-quota snapshot per Brand, with idempotent `ALTER TABLE` migrations for `reset_at_weekly` and `weekly_remaining`. Cache invalidation lives in `seedBrandQuotas()`.
  - **The dashboard does not own the RTK `commands` table** — that DB is read-only for our purposes; we never write to it.
- **`.env`**: the dashboard writes user-supplied API keys to `.env` in its own working directory. Per-key writes **preserve** every key outside the four-key whitelist (the writer reads the existing `.env`, mutates the targeted key, and writes the full map back). `RTK_DB_PATH` and `FIREBASE_*` round-trip cleanly. Closed in `../docs/REVIEWS.md` R3; covered by AC-21 and `tests/envRoundTrip.test.js`.

### 1.3 External integrations

- **MiniMax Token Plan API**: `https://www.minimax.io/v1/token_plan/remains`, `GET` with `Authorization: Bearer <MINIMAX_API_KEY>`. Returns `model_remains` entries with `end_time` (5h), `weekly_end_time` (weekly), `current_interval_remaining_percent` (5h), `current_weekly_remaining_percent` (weekly). Implemented in `fetchMinimaxQuota()` with defensive field-name extraction and chat-model entry selection by name regex.
- **Claude, GLM**: quota is read from response headers on a probe request (`anthropic-ratelimit-requests-*` for Claude, `x-ratelimit-remaining-requests` / `x-ratelimit-limit-requests` for GLM).
- **Gemini**: no quota API; the fetcher returns `unit: "not_exposed"` and the dashboard falls back to local-spend view.
- **`.env`**: the dashboard writes user-supplied API keys to `.env` in its own working directory. Per-key writes **preserve** every key outside the four-key whitelist; `RTK_DB_PATH` and `FIREBASE_*` round-trip cleanly. Closed in `../docs/REVIEWS.md` R3.

### 1.4 Dependencies

Zero runtime dependencies. `package.json` has no `dependencies` block. `devDependencies` is `vitest` (^1.6.0); see §5 for the suite (15 files, 119 tests, ~415 ms).

The Node built-ins in use: `http`, `https` (`https.request` for the MiniMax fetcher), `fs`, `path`, `child_process` (`execFile` for the `sqlite3` reader; `exec` only to launch the browser at startup), `url`.

The system also depends on the **`sqlite3` CLI** being on `PATH` (not a Node dependency, but a host-level one). This is documented in the README's Prerequisites.

### 1.5 Tooling

- `npm run dev` → `node server.js`
- `npm run check` runs `node --check` on `server.js`, `app.js`, and every `lib/*.js` (glob). Wired into CI.
- `npm test` runs the Vitest suite (15 files, 119 tests, ~415 ms). Wired into CI.
- No linter, no formatter, no type checker.

## 2. Coding standards

### 2.1 JavaScript style

- `const` by default; `let` only when reassignment is needed; never `var`.
- Single quotes for strings; backticks for template literals.
- 2-space indent.
- No semicolons are required; the existing code is consistent. New code matches.
- Function declarations (`function foo() { … }`) at module scope; arrow functions inside expressions and callbacks.
- `===` / `!==`; no `==` / `!=`.

### 2.2 Naming

- Functions and variables: `camelCase`.
- Constants: `UPPER_SNAKE_CASE` (e.g. `REFRESH_INTERVAL_SECONDS`, `MAX_REQUESTS_RETAINED`).
- DOM element references: `elements.camelCase` on a single `elements` object.
- CSS classes: `kebab-case`.
- `localStorage` keys: `atm_snake_case` (the `atm_` prefix is the namespace).
- SQLite column names: `snake_case` (matches the existing RTK schema, which we read but do not own).

### 2.3 Comments

- "Why" comments for non-obvious decisions (e.g. the cache-model derivation caveat, the per-source retention cap, the masked-key round-trip, the 5h-vs-weekly separation in `fetchMinimaxQuota`).
- "What" comments only for code that is genuinely hard to read.
- No banner comments, no decorative dividers, no JSDoc.

### 2.4 DOM construction

- Build DOM via `createElement` and `appendChild`.
- `innerHTML` is allowed only for **trusted, internal-only** content (system events, formatted sim output). Never for user input.
- A safe helper `appendConsoleLine(source, parts)` accepts an array of `{html}` (trusted) or `{text}` (escaped) segments. **All RTK `original_cmd` text goes through `{text}`** so an upstream log injection cannot break out of the log panel.

### 2.5 Numbers and units

- Money: always dollars, 4-5 decimal places. See `formatCurrency` in `app.js`.
- Time: epoch milliseconds internally; human strings via `toLocaleTimeString` and `formatTimeRemaining`.
- Tokens: integers.
- **Provider-quota `unit`**: the `brand_quota` table stores a `unit` column with one of `"requests"` (count-based; for Claude/GLM), `"percent"` (0-100; for MiniMax, with synthesised `limit_value: 100`), `"not_exposed"` (for Gemini), `"missing_key"` (no API key in `.env`), or `"error"` (fetch failed). The UI's `computeApiUsedPct()` switches on `unit`; this is the only place unit semantics live — never inline the conversion in render code.

## 3. Branching & release

- Single `master` branch; no `develop` / `staging` / `release/*` split. The project is a personal tool.
- No tags, no versioned releases, no changelog file. `package.json` is pinned at `1.0.0`.
- No pull-request workflow; the author commits directly to `master`.

## 4. Security baseline

### 4.1 Server hardening

- **CORS**: restricted to `http://localhost:*` and `http://127.0.0.1:*`. Third-party sites cannot read API keys from `/api/env`.
- **Path traversal**: `path.relative(STATIC_ROOT, filePath)` is checked for `..` or absolute. Traversal attempts get `403`.
- **Static file whitelist**: only `index.html`, `app.js`, `styles.css`, `package.json`, `favicon.svg` are servable. `.env`, `server.js`, and any other file in the working directory are not.
- **`.env` writer**: per-key endpoint whitelists the four allowed key names. Newlines are stripped from values to prevent `.env` injection.
- **Per-key writer preserves siblings**: `POST /api/env/key` whitelists a key name, but the writer reads the existing `.env` first and writes the full map back. `RTK_DB_PATH` (a non-whitelisted key the server honours via `process.env`) and `FIREBASE_*` round-trip cleanly. Closed in `../docs/REVIEWS.md` R3; verified by `tests/envRoundTrip.test.js`. Note: the per-key endpoint still rejects non-whitelisted *key names* in the write body — only the existing siblings are preserved.
- **SQLite query construction**: all SQL is constructed via `escapeSQLString` / `escapeSQLNumber` helpers; no string interpolation of user-supplied values. `child_process.execFile('sqlite3', …)` is used (not `exec`) so the command is array-form and not subject to shell parsing.
- **SSE stream**: the `/api/rtk/stream` endpoint holds connections open; a `req.on('close')` handler removes the client from `sseClients` to avoid leaks. No inbound user input is reflected back in the stream payload.

### 4.2 Secret handling

- API keys are written to `.env` (excluded from git via `.gitignore`).
- `GET /api/env` returns masked values (`****last4`).
- The full key is never serialised to the browser; the user types it into the password input and the form posts it to the per-key endpoint.
- The form does not log the key, does not store it in `localStorage`, and does not include it in error messages.
- **Outbound API calls** (MiniMax fetcher) attach the key in an `Authorization: Bearer` header only. The full response body (which may echo back quota state but never the key) is stored in `brand_quota.raw_json` for debugging.

### 4.3 XSS prevention

- All untrusted strings (user-typed input, RTK `original_cmd`) are inserted into the DOM via `textContent` or escaped via `escapeHtml`.
- No use of `eval`, `new Function`, or `document.write`.
- No third-party scripts loaded into `index.html`. The real-mode log path uses `appendConsoleLine` segments with `{text}` for the command body.

### 4.4 Network exposure

- **Inbound**: the server binds to `0.0.0.0:3000` only because Node's default `listen(port)` does so. **Known gap**: in production this should bind to `127.0.0.1` explicitly. The CORS allowlist already blocks cross-origin reads, but binding to localhost removes a class of LAN-access risks.
- **Outbound**: the server makes HTTPS calls to `https://www.minimax.io/v1/token_plan/remains` from the MiniMax fetcher. This is the first outbound integration. There is no outbound traffic for Claude/GLM (quota is read from in-band response headers on a probe request). The MiniMax TLS handshake validates the system CA store; no pinning, no client certs.

## 5. Testing

- `npm test` runs the Vitest suite: 15 files, 119 tests, ~415 ms. Coverage includes the pure functions and the modular `lib/` helpers that are importable in Node:
  - `formatCurrency`, `formatNumber`, `formatCompactNumber`, `formatTimeRemaining` (`lib/format.js`, UMD)
  - The cost / savings / cache-rate calculations (disjoint model, per ADR-0003)
  - The CSV builder
  - The Brand detection heuristic (`lib/brand-detect.js`, UMD)
  - `computeApiUsedPct` and `calcSpendPct` (`lib/quota-utils.js`, UMD; percent unit, requests unit, weekly, null-safety, per-minute skip)
  - MiniMax response parsing (`lib/brand-fetchers.js` + `tests/fetchMinimaxQuota.test.js`)
  - Gemini response parsing (`lib/brand-fetchers.js` + `tests/fetchGeminiQuota.test.js`)
  - `getRtkSpendMetrics` against the live RTK DB (`lib/rtk-metrics.js`)
  - GLM 5h reset fallback (`lib/brand-fetchers.js` + `tests/reset5hFallback.test.js`)
  - Antigravity CLI transcript parser (`lib/antigravity-parser.js`, UMD)
  - `escapeHtml` (`lib/dom-utils.js`, UMD)
  - LLM-only log feed filter (mirrored from `app.js`)
  - Monitor-mode switching (mirrored from `app.js`; `getActiveRequests` covers AC-12a/b)
  - `.env` sibling-preservation round-trip (`lib/env.js` + `tests/envRoundTrip.test.js`; covers AC-21)
  - `PRICING_DEFAULTS` shape and single-source-of-truth (`lib/pricing-defaults.js` + `tests/pricingDefaults.test.js`)
- The mirror-function approach is documented at the top of each test file that re-implements a formula. The natural next step is to continue extracting `format*` / `cost*` into the `lib/` tree so the tests can import them directly.
- CI runs `npm install`, `npm run check` (which covers `lib/*.js` via glob), `npm test`, a `sqlite3 --version` probe, and a server-boot smoke (`/`, `/api/seed-quotas`). See `.github/workflows/ci.yml`.
- No e2e tests. The dashboard is small enough that the manual acceptance criteria in `REQUIREMENTS.md` are the current contract.
