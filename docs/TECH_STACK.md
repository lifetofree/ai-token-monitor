# Tech Stack & Engineering Standards

> Owner: Technical Lead. Finalised stack, coding standards, branching strategy, and security baseline. See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## 1. Stack

### 1.1 Runtime & languages

- **Server**: Node.js (no framework). `server.js` (~520 lines, with the heavy lifting in `lib/`) handles static asset serving, nine API endpoints, CORS, path-traversal protection, an SSE handler, an outbound HTTPS client, and a `child_process.execFile('sqlite3', …)` reader. No Express, no Koa, no Fastify. Endpoints in scope:
  - `GET /api/env`, `POST /api/env`, `POST /api/env/key` — `.env` read/write
  - `GET /api/rtk`, `GET /api/rtk/summary`, `GET /api/rtk/stream`, `POST /api/rtk/ingest` — Real RTK Monitor (snapshot, summary, SSE, custom-project ingest from any project on this machine)
  - `GET /api/seed-quotas`, `POST /api/seed-quotas` — provider-quota cache
- **Client**: vanilla ES2020 in the browser. No bundler, no transpiler, no framework. `app.js` (~1,200 lines) attaches one `DOMContentLoaded` handler and renders into pre-existing DOM nodes.
- **Templating**: none. The HTML is a static `index.html`; dynamic content is built by `document.createElement` and `appendChild` (not `innerHTML` for untrusted data).
- **CSS**: hand-written `styles.css` with CSS custom properties for the design system. No preprocessor, no utility framework, no component library.

### 1.2 Persistence

- **Client**: `localStorage` under `atm_*` keys (`atm_requests`, `atm_brand_metadata`, `atm_theme`, `atm_auto_sim`, `atm_monitor_mode`).
- **Server-side SQLite caches** (in the same DB the server uses for the RTK history read; distinct from any user-owned DB):
  - `brand_quota` — provider-quota snapshot per Brand, with idempotent `ALTER TABLE` migrations for `reset_at_weekly` and `weekly_remaining`. Cache invalidation lives in `seedBrandQuotas()`.
  - **The dashboard does not own the RTK `commands` table** — that DB is read-only for our purposes; we never write to it.
- **`.env`**: the dashboard writes user-supplied API keys to `.env` in its own working directory. Per-key writes are supposed to preserve siblings but currently drop any non-whitelisted keys (including `RTK_DB_PATH`, which Real RTK mode honours via `process.env`) — see `../docs/REVIEWS.md` R3.

### 1.3 External integrations

- **MiniMax Token Plan API**: `https://www.minimax.io/v1/token_plan/remains`, `GET` with `Authorization: Bearer <MINIMAX_API_KEY>`. Returns `model_remains` entries with `end_time` (5h), `weekly_end_time` (weekly), `current_interval_remaining_percent` (5h), `current_weekly_remaining_percent` (weekly). Implemented in `fetchMinimaxQuota()` with defensive field-name extraction and chat-model entry selection by name regex.
- **Claude, GLM**: quota is read from response headers on a probe request (`anthropic-ratelimit-requests-*` for Claude, `x-ratelimit-remaining-requests` / `x-ratelimit-limit-requests` for GLM).
- **Gemini**: no quota API; the fetcher returns `unit: "not_exposed"` and the dashboard falls back to local-spend view.
- **`.env`**: the dashboard writes user-supplied API keys to `.env` in its own working directory. Per-key writes are supposed to preserve siblings but currently drop any non-whitelisted keys — see `../docs/REVIEWS.md` R3.

### 1.4 Dependencies

Zero runtime dependencies. `package.json` has no `dependencies` block. `devDependencies` is empty (a Vitest devDep is the natural next step — see §5).

The Node built-ins in use: `http`, `https` (`https.request` for the MiniMax fetcher), `fs`, `path`, `child_process` (`execFile` for the `sqlite3` reader; `exec` only to launch the browser at startup), `url`.

The system also depends on the **`sqlite3` CLI** being on `PATH` (not a Node dependency, but a host-level one). This is documented in the README's Prerequisites.

### 1.5 Tooling

- `npm run dev` → `node server.js`
- `node --check server.js` and `node --check app.js` are run manually during feature work as a syntax gate. A future CI step should automate this (DevOps task).
- No linter, no formatter, no type checker, no test runner. **Known gap**: a Vitest suite is the natural next step for the pure functions (cost, savings, cache rate, CSV builder, `computeApiUsedPct`, MiniMax response parsing).

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
- **Env-var loss bug** (tracked in `../docs/REVIEWS.md` R3): the per-key writer currently drops any `.env` keys outside the four-key whitelist on update. The bug now **also affects Real RTK mode** because `RTK_DB_PATH` is a non-whitelisted key the server honours via `process.env`. Workaround: set `RTK_DB_PATH` in the shell, not via the API Tokens UI.
- **SQLite query construction**: all SQL is constructed via `escapeSQLString` / `escapeSQLNumber` helpers; no string interpolation of user-supplied values. `child_process.execFile('sqlite3', …)` is used (not `exec`) so the command is array-form and not subject to shell parsing.
- **SSE stream**: the `/api/rtk/stream` endpoint holds connections open; a `req.on('close')` handler removes the client from `sseClients` to avoid leaks. No inbound user input is reflected back in the stream payload. The same `sseClients` array is used by `POST /api/rtk/ingest` to broadcast a successfully-inserted row to all open clients (`broadcastToClients()` is exported from `lib/sse-watcher.js`).
- **Ingest endpoint** (`POST /api/rtk/ingest`): single-command INSERT into the live RTK `commands` table, scoped to a non-RTK client. Body validated with `Number.isFinite` + `Math.max(0, …)` for numeric fields and `escapeSQLString` for `original_cmd` / `timestamp`; escaped with the same helpers used by `lib/quota-cache.js` so the SQL pipeline is uniform. No auth — the loopback CORS allowlist is the trust boundary. R7 in `../docs/REVIEWS.md`.

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

- No tests today. The natural target is Vitest with no DOM dependency, covering the pure functions:
  - `formatCurrency`, `formatNumber`, `formatCompactNumber`, `formatTimeRemaining`
  - The cost / savings / cache-rate calculations (disjoint model, per ADR-0003)
  - The CSV builder
  - The Brand detection heuristic
  - `computeApiUsedPct` (percent unit, requests unit, weekly, null-safety)
  - MiniMax response parsing (mock `https.request`, feed a sample `model_remains` payload, assert the resolved shape)
- No e2e tests. The dashboard is small enough that the manual acceptance criteria in `REQUIREMENTS.md` are the current contract.
