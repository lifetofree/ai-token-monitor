# System Design

> Owner: Architect. The data model, API contracts, component hierarchy, and data flow as they exist after the resolved ADRs. See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## 1. High-level architecture

A two-process, single-machine system:

- **Browser process**: `index.html` + `styles.css` + `app.js`. Renders the dashboard; reads/writes `localStorage`; renders synthetic traffic via the in-app simulator.
- **Server process**: `server.js`. Static file server + three JSON API endpoints for `.env` read/write. Reads and writes `.env` on demand; never persists anything else.

No build step. No bundler. No transpiler. The browser loads `app.js` directly and executes it as a classic script.

The Real RTK mode, the `/api/rtk` endpoint, the `execFile('sqlite3', …)` invocation, and the SQLite read from `~/Library/Application Support/rtk/history.db` are gone — see `../docs/adr/0005-remove-real-rtk-mode.md`.

## 2. Folder structure

```
.
├── app.js                  # All client logic (~880 lines)
├── index.html              # Static markup
├── styles.css              # Design system
├── server.js               # Node server (~190 lines)
├── package.json            # Zero dependencies
├── favicon.svg             # Static asset (whitelisted)
├── .env                    # User API keys (gitignored)
├── .env.example            # Template
├── .gitignore              # Excludes .env, node_modules, .claude/
├── CONTEXT.md              # Domain language
├── STATUS.md               # Project status snapshot
├── README.md               # Project overview and Known Gaps
├── docs/
│   ├── BUSINESS_GOALS.md
│   ├── REQUIREMENTS.md
│   ├── USER_JOURNEY.md
│   ├── TECH_STACK.md
│   ├── SYSTEM_DESIGN.md    # this file
│   ├── REVIEWS.md
│   └── adr/
│       ├── 0001-drop-antigravity-brand.md
│       ├── 0002-unify-request-stores-by-source.md
│       ├── 0003-cache-model-disjoint-input-and-saved.md
│       ├── 0004-fixed-rolling-windows.md
│       └── 0005-remove-real-rtk-mode.md
└── .ai.agents/             # Role rules (see *.md)
```

There is no `src/`, no `tests/`, no `dist/`. The single-file-per-layer structure is intentional given the project's small surface area.

## 3. Data model

### 3.1 Brand

```ts
type BrandKey = 'gemini' | 'claude' | 'minimax' | 'glm';

interface BrandMetadata {
  name: string;          // display name, e.g. "Gemini"
  inputCost: number;     // USD per 1M input tokens
  outputCost: number;    // USD per 1M output tokens
  limit5h: number;       // USD cap over the 5-Hour Window
  limitWeekly: number;   // USD cap over the Weekly Window
}
```

`Brand.color` is **derived** from CSS custom properties (`--color-<brand>`) at render time. Single source of truth: `styles.css`. JS reads via `getComputedStyle`.

The Brand `antigravity` is removed (see `../docs/adr/0001-drop-antigravity-brand.md`). The fields `meta.limit` and `meta.windowLabel` are still present in `DEFAULT_BRAND_METADATA` in `app.js`; deletion is tracked in `../docs/REVIEWS.md` R3 (see `../docs/adr/0004-fixed-rolling-windows.md`).

### 3.2 Request

```ts
interface Request {
  id: string;            // e.g. "req_…", "mock_<n>"
  timestamp: number;     // epoch ms
  brand: BrandKey;
  inputTokens: number;   // billed input (per ADR-0003; not yet applied — see status)
  outputTokens: number;
  savedTokens: number;   // cached input; disjoint from inputTokens (per ADR-0003; not yet applied)
  cost: number;          // computed
  savings: number;       // computed
}
```

Derived formulas (per `../docs/adr/0003-cache-model-disjoint-input-and-saved.md`; the cost side is **not yet applied** in code — the current `addRequest` and `generateInitialMockHistory` still use the subset model):

```
cost     = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000   // disjoint model (target)
savings  = (savedTokens  * inputRate)                          / 1_000_000
cacheRate = savedTokens / (inputTokens + savedTokens)   // [0, 1], display as %
```

The `source` and `cmdText` fields from earlier revisions are removed from the active schema; they are reserved for a future Real Mode re-introduction.

### 3.3 Request store

A single `state.requests: Request[]` array. Retention:

```
if (state.requests.length > MAX_REQUESTS_RETAINED) {
  state.requests.shift();
}
```

`MAX_REQUESTS_RETAINED = 500` is a single global cap; per-source retention is moot while there is only one source. See `../docs/adr/0002-unify-request-stores-by-source.md`.

### 3.4 Cursors

- `refreshTimer: number` — the seconds-remaining countdown for the next refresh.
- `simulationTimeoutId: number | null` — the in-flight simulator timeout.

`lastSeenCommandId` (the real-mode "log only new commands" cursor) is gone with Real Mode.

### 3.5 Persistence

| Key | Shape | Owner |
|---|---|---|
| `atm_requests` | `Request[]` | simulator output |
| `atm_brand_metadata` | `Record<BrandKey, BrandMetadata>` | user settings |
| `atm_theme` | `'light' \| 'dark'` | user settings |
| `atm_auto_sim` | `'true' \| 'false'` | simulator preference |

`atm_monitor_mode` (a pre-Removal key) is no longer read or written. `localStorage` is the only client-side persistence. `.env` is the only server-side mutable state.

## 4. API contracts

The server exposes three JSON endpoints. All requests/responses are `application/json`; CORS is restricted to localhost.

### 4.1 `GET /api/env`

Reads `.env` and returns each key with its value masked.

**Response (200)**

```json
{
  "ANTHROPIC_API_KEY": "****abcd",
  "GEMINI_API_KEY": "",
  "GLM_API_KEY": "****wxyz",
  "MINIMAX_API_KEY": ""
}
```

Missing keys are returned as `""`. The full key is never sent to the browser.

### 4.2 `POST /api/env/key?key=<KEY_NAME>`

Writes a single key to `.env`.

**Allowed `KEY_NAME` values**: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY`. Any other value returns 400.

**Request body**

```json
{ "value": "<full key value>" }
```

Empty `value` deletes the key from `.env`.

**Response (200)**

```json
{ "success": true, "masked": "****abcd" }
```

**Response (400)** — unknown key, invalid JSON, or non-string value.

**Known bug** (tracked in `../docs/REVIEWS.md` R3): the writer currently reconstructs `.env` from the four-key whitelist only, dropping any other keys the user has added. The original "preserve siblings" intent is not implemented.

### 4.3 `POST /api/env`

Bulk write endpoint. Accepts a JSON object with any of the four allowed key names; writes them all to `.env` after newline-strip sanitisation. Used by the legacy initial-form path; the per-key endpoint above is the preferred path for current UI.

**Response (200)**

```json
{ "success": true }
```

**Response (400)** — invalid JSON.

## 5. Component hierarchy

### 5.1 Client

```
init()
├── applyTheme()
├── buildSettingsFormFields()   # one fieldset per Brand
├── setupEventListeners()
│   ├── theme toggle
│   ├── simulation pause/resume
│   ├── clear logs (confirm)
│   ├── export CSV
│   ├── modal open/close
│   ├── pricing form submit
│   ├── custom request form submit
│   └── table sort
├── setupTabs()
├── fetchAPIKeys()              # GET /api/env
├── startCountdownTimer()       # 30s loop
├── calculateAndRenderDashboard()  # initial render with any persisted data
├── scheduleNextSimulation()    # if auto-sim is on
└── generateInitialMockHistory()  # if state.requests is empty
```

The render path is:

```
calculateAndRenderDashboard()
├── aggregate per Brand         # requests, tokens, cost, savings, cost5h, costWeekly
├── renderBrandCards()
└── renderTable()               # sortable
```

### 5.2 Server

```
http.createServer()
├── OPTIONS preflight  → 200
├── GET  /api/env      → fs.readFile('.env'), mask
├── POST /api/env/key  → parse, whitelist, sanitise, write (buggy: drops other keys)
├── POST /api/env      → bulk write
└── static fallback    → whitelist check, fs.readFile
```

## 6. Data flow

### 6.1 Simulation (the only mode in v1)

```
scheduleNextSimulation()  (8-20s random delay)
   │
   ▼
triggerRandomMockRequest()
   │
   ▼
addRequest(brand, input, output, saved)
   │
   ├── compute cost (subset model — see ADR-0003 status), savings
   ├── push to state.requests
   ├── truncate if > 500
   ├── persist to localStorage
   └── logEvent to console
```

There is no other data source. The browser does not poll any backend endpoint on a timer; the 30s refresh is a local recompute.

## 7. Design patterns in use

- **Safe DOM construction**: `appendConsoleLine(source, parts)` distinguishes `{html}` (trusted) from `{text}` (escaped). All untrusted input goes through `{text}`.
- **Per-key env writer**: `POST /api/env/key` whitelists a key name. The "preserve siblings" intent is documented but not yet implemented (see `../docs/REVIEWS.md` R3).
- **Pre-populated history**: `generateInitialMockHistory()` seeds 40 mock Requests on first load so the rolling-window bars have non-zero data to render immediately.

## 8. Known design gaps (from `../STATUS.md`)

- **Cache model bug**: `billedInput = input - saved` (subset) coexists with a disjoint rate formula. Tracked in `../docs/adr/0003-cache-model-disjoint-input-and-saved.md` and `../docs/REVIEWS.md` R3.
- **Dead fields in `DEFAULT_BRAND_METADATA`**: `meta.limit` and `meta.windowLabel` are still in the schema. Tracked in `../docs/adr/0004-fixed-rolling-windows.md` and `../docs/REVIEWS.md` R3.
- **Env-var loss**: per-key writer drops `.env` keys outside the four-key whitelist. Tracked in `../docs/REVIEWS.md` R3.
- **Single-store history**: `localStorage` is the only client-side persistence. A server restart loses Request history.
- **No error boundary**: a single failed fetch silently degrades the dashboard; the user sees zeros and a system log message.
- **No accessibility audit**: focus traps, keyboard nav, and screen reader labels are partially implemented; not verified end-to-end.
