# Tech Stack & Engineering Standards

> Owner: Technical Lead. Finalised stack, coding standards, branching strategy, and security baseline. See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## 1. Stack

### 1.1 Runtime & languages

- **Server**: Node.js (no framework). A ~190-line `server.js` handles static asset serving, three API endpoints (`/api/env` GET, `/api/env` POST, `/api/env/key` POST), CORS, and path-traversal protection. No Express, no Koa, no Fastify.
- **Client**: vanilla ES2020 in the browser. No bundler, no transpiler, no framework. `app.js` (~880 lines) attaches one `DOMContentLoaded` handler and renders into pre-existing DOM nodes.
- **Templating**: none. The HTML is a static `index.html`; dynamic content is built by `document.createElement` and `appendChild` (not `innerHTML` for untrusted data).
- **CSS**: hand-written `styles.css` with CSS custom properties for the design system. No preprocessor, no utility framework, no component library.

### 1.2 Persistence

- **Client**: `localStorage` under `atm_*` keys (`atm_requests`, `atm_brand_metadata`, `atm_theme`, `atm_auto_sim`).
- **Server**: none. The server is stateless; it reads and writes `.env` on demand.
- **Database**: none. The dashboard is Simulation-only; the prior RTK `history.db` SQLite reader and `execFile('sqlite3', …)` invocation are gone (see `../docs/adr/0005-remove-real-rtk-mode.md`).

### 1.3 External integrations

- **`.env`**: the dashboard writes user-supplied API keys to `.env` in its own working directory. Per-key writes are supposed to preserve siblings but currently drop any non-whitelisted keys — see `../docs/REVIEWS.md` R3.

### 1.4 Dependencies

Zero runtime dependencies. `package.json` has no `dependencies` block. `devDependencies` is empty.

The only Node built-ins used: `http`, `fs`, `path`, `child_process` (`exec` — only to launch the browser at startup), `url`.

### 1.5 Tooling

- `npm run dev` → `node server.js`
- No linter, no formatter, no type checker, no test runner. **Known gap**: a Vitest suite is the natural next step for the pure functions (cost, savings, cache rate, CSV builder).

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

### 2.3 Comments

- "Why" comments for non-obvious decisions (e.g. the cache-model derivation caveat, the per-source retention cap, the masked-key round-trip).
- "What" comments only for code that is genuinely hard to read.
- No banner comments, no decorative dividers, no JSDoc.

### 2.4 DOM construction

- Build DOM via `createElement` and `appendChild`.
- `innerHTML` is allowed only for **trusted, internal-only** content (system events, formatted sim output). Never for user input.
- A safe helper `appendConsoleLine(source, parts)` accepts an array of `{html}` (trusted) or `{text}` (escaped) segments.

### 2.5 Numbers and units

- Money: always dollars, 4-5 decimal places. See `formatCurrency` in `app.js`.
- Time: epoch milliseconds internally; human strings via `toLocaleTimeString` and `formatTimeRemaining`.
- Tokens: integers.

## 3. Branching & release

- Single `master` branch; no `develop` / `staging` / `release/*` split. The project is a personal tool.
- No tags, no versioned releases, no changelog file. `package.json` is pinned at `1.0.0`.
- No pull-request workflow; the author commits directly to `master`.

## 4. Security baseline

### 4.1 Server hardening

- **CORS**: restricted to `http://localhost:*` and `http://127.0.0.1:*`. Third-party sites cannot read API keys from `/api/env`.
- **Path traversal**: `path.relative(STATIC_ROOT, filePath)` is checked for `..` or absolute. Traversal attempts get `403`.
- **Static file whitelist**: only `index.html`, `app.js`, `styles.css`, `package.json`, `favicon.svg` are servable. `.env`, `server.js`, and any other file in the working directory are not. (The favicon issue from a prior revision — whitelist said `favicon.png` while the real file is `favicon.svg` — is fixed.)
- **`.env` writer**: per-key endpoint whitelists the four allowed key names. Newlines are stripped from values to prevent `.env` injection.
- **Env-var loss bug** (tracked in `../docs/REVIEWS.md` R3): the per-key writer currently drops any `.env` keys outside the four-key whitelist on update. The bug is no longer triggered by the prior `RTK_DB_PATH` use case (RTK is gone) but is still live for any other custom keys the user adds.

### 4.2 Secret handling

- API keys are written to `.env` (excluded from git via `.gitignore`).
- `GET /api/env` returns masked values (`****last4`).
- The full key is never serialised to the browser; the user types it into the password input and the form posts it to the per-key endpoint.
- The form does not log the key, does not store it in `localStorage`, and does not include it in error messages.

### 4.3 XSS prevention

- All untrusted strings (user-typed input) are inserted into the DOM via `textContent` or escaped via `escapeHtml`.
- No use of `eval`, `new Function`, or `document.write`.
- No third-party scripts loaded into `index.html`. (The prior real-mode log path, which inserted RTK `original_cmd` via `appendConsoleLine` segments, is gone with Real Mode.)

### 4.4 Network exposure

- The server binds to `0.0.0.0:3000` only because Node's default `listen(port)` does so. **Known gap**: in production this should bind to `127.0.0.1` explicitly. The CORS allowlist already blocks cross-origin reads, but binding to localhost removes a class of LAN-access risks.

## 5. Testing

- No tests today. The natural target is Vitest with no DOM dependency, covering the pure functions:
  - `formatCurrency`, `formatNumber`, `formatCompactNumber`, `formatTimeRemaining`
  - The cost / savings / cache-rate calculations
  - The CSV builder
  - The Brand detection heuristic (no longer exercised, but trivial to test)
- No e2e tests. The dashboard is small enough that the manual acceptance criteria in `REQUIREMENTS.md` are the current contract.
