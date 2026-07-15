# System Design

> Owner: Architect. The data model, API contracts, component hierarchy, and data flow as they exist after the resolved ADRs. See `../CONTEXT.md` for the domain language and `../docs/adr/` for non-obvious decisions.

## 1. High-level architecture

A two-process, single-machine system, with an optional hardware companion:

- **Browser process**: `index.html` + `styles.css` + `app.js`. Renders the dashboard; reads/writes `localStorage`; supports both Real RTK Monitor (default) and Simulation modes; consumes the `/api/seed-quotas` snapshot to drive the API-aware progress bars and reset-time badges.
- **Server process**: `server.js`. Static file server plus **ten** JSON/SSE endpoints across four concerns:
  - **`.env` I/O**: `GET /api/env` (only ever returns the four provider keys, masked), `POST /api/env`, `POST /api/env/key`
  - **Real RTK Monitor**: `GET /api/rtk` (full snapshot), `GET /api/rtk/summary` (aggregate summary), `GET /api/rtk/stream` (SSE for incremental updates), `POST /api/rtk/ingest` (single-command ingest from non-RTK clients)
  - **Provider-quota cache**: `GET /api/seed-quotas` (cached snapshot), `POST /api/seed-quotas` (force-refresh)
  - **Antigravity CLI usage**: `GET /api/agent-usage` (per-conversation totals across `total` / `5h` / `weekly` windows plus an active-session Context Window payload — see §3.8 and §6.5)
- **Outbound HTTPS clients**: (1) `fetchMinimaxQuota` makes a `GET` to `https://www.minimax.io/v1/token_plan/remains` with `Authorization: Bearer <MINIMAX_API_KEY>`; (2) `lib/firebase.js` PUTs a sanitised snapshot to `<FIREBASE_URL>/display.json?auth=<FIREBASE_AUTH>` for the ESP32 companion. GLM reads quota from in-band response headers on a probe request. Claude makes **no** outbound call (RTK-only, `unit: 'local'`).
- **ESP32 companion** (optional): `firmware/esp32-display/esp32-display.ino` runs on an ESP32 + ST7789 240×280 TFT, polling the Firebase `display.json` node and rendering one brand per page. Enabled only when `FIREBASE_URL`/`FIREBASE_AUTH` are present in `.env`. See ADR-0007.

No build step. No bundler. No transpiler. The browser loads `app.js` directly and executes it as a classic script.

The server **owns** the `brand_quota` SQLite table (idempotent migrations for `reset_at_weekly` and `weekly_remaining`). It **does not own** the RTK `commands` table — that DB is read-only for our purposes.

## 2. Folder structure

```
.
├── app.js                  # All client logic (~1,450 lines)
├── index.html              # Static markup
├── styles.css              # Design system
├── server.js               # Node server (~700 lines)
├── package.json            # devDependency: vitest
├── favicon.svg             # Static asset (whitelisted)
├── .env                    # User API keys + Firebase/WiFi secrets (gitignored)
├── .env.example            # Template
├── .gitignore              # Excludes .env, node_modules, .claude/, *.db
├── CONTEXT.md              # Domain language
├── STATUS.md               # Project status snapshot
├── README.md               # Project overview and Known Gaps
├── lib/
│   ├── antigravity-parser.js  # Parses Antigravity CLI transcript .jsonl files; Gemini countTokens path with chars/4 fallback
│   ├── antigravity-context.js # Active-session context-window resolver for /api/agent-usage
│   ├── firebase.js            # Publishes quota snapshot to Firebase RTDB for the ESP32 mirror
├── tests/
│   ├── antigravityParser.test.js   # 13 tests; covers the countTokensFor() contract
│   ├── antigravityContext.test.js  # 6 tests; active-session filter, numerator, clamp, size override
│   ├── computeApiUsedPct.test.js
│   ├── cost.test.js
│   ├── csv.test.js
│   ├── detectBrand.test.js
│   ├── envRoundTrip.test.js   # AC-21: .env sibling preservation
│   ├── escapeHtml.test.js
│   ├── fetchGeminiQuota.test.js
│   ├── fetchMinimaxQuota.test.js
│   ├── format.test.js
│   ├── getRtkSpendMetrics.test.js
│   ├── ingest.test.js          # AC-22..AC-25: ingest validation + SQLi escape
│   ├── modeSwitch.test.js      # AC-12a/b: monitor-mode store selection
│   ├── pricingDefaults.test.js
│   ├── reset5hFallback.test.js
│   └── rollingLogFilter.test.js
├── firmware/
│   └── esp32-display/        # ESP32 + ST7789 companion (see ADR-0007)
│       ├── esp32-display.ino
│       └── secrets.h          # gitignored; copied from secrets.txt
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
│       ├── 0005-remove-real-rtk-mode.md          # SUPERSEDED by 0006
│       ├── 0006-reintroduce-real-rtk-mode.md
│       ├── 0007-esp32-firebase-companion-display.md
│       ├── 0008-claude-rtk-only-no-anthropic-probe.md
│       └── 0009-restore-antigravity-percent-bars.md
└── .ai.agents/             # Role rules (see *.md)
```

There is no `src/` or `dist/`. The single-file-per-layer structure is intentional given the project's small surface area.

### Server-side SQLite caches (in `~/Library/Application Support/rtk/history.db`)

| Table | Owner | Purpose | Migrations |
|---|---|---|---|
| `commands` | RTK (read-only) | The raw RTK history. The dashboard never writes to it. | n/a |
| `brand_quota` | dashboard | Provider-quota snapshot per Brand. Idempotent `ALTER TABLE` migrations. | `ADD COLUMN reset_at_weekly INTEGER`, `ADD COLUMN weekly_remaining INTEGER`, `ADD COLUMN window_started_at INTEGER` |
| `parse_failures` | RTK (read-only) | RTK's own failure log; not consumed by the dashboard. | n/a |

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

The Brand `antigravity` is removed (see `../docs/adr/0001-drop-antigravity-brand.md`). The dead fields `meta.limit` and `meta.windowLabel` were removed from `DEFAULT_BRAND_METADATA` in Phase 2 (tracked in `../docs/REVIEWS.md` R3, `../docs/adr/0004-fixed-rolling-windows.md`).

### 3.2 Request

```ts
type RequestSource = 'real' | 'sim';

interface Request {
  id: string;            // e.g. "req_…", "mock_<n>", "rtk_<rtkId>"
  timestamp: number;     // epoch ms
  brand: BrandKey;
  source: RequestSource; // meaningful again in v1 (dual-monitor); see 0006
  inputTokens: number;   // billed input (disjoint from savedTokens per ADR-0003; applied)
  outputTokens: number;
  savedTokens: number;   // cached input; disjoint from inputTokens (per ADR-0003; applied)
  cost: number;          // computed
  savings: number;       // computed
  cmdText?: string;      // only populated for `source: 'real'` (the RTK `original_cmd`)
}
```

Derived formulas (disjoint model, per `../docs/adr/0003-cache-model-disjoint-input-and-saved.md`, **applied** in `addRequest`, `fetchRealRTKData`, `connectRTKStream`, and `generateInitialMockHistory`):

```
cost       = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
savings    = (savedTokens  * inputRate)                          / 1_000_000
cacheRate  = savedTokens / (inputTokens + savedTokens)            // [0, 1], display as %
```

### 3.3 Request store

Two arrays, selected by `state.monitorMode` via `getActiveRequests()`:

```
state.realCommands: Request[]  // source: 'real' — populated by fetchRealRTKData + connectRTKStream
state.requests:     Request[]  // source: 'sim'  — populated by the simulator and pre-populated history
```

Retention is unified at `MAX_REQUESTS_RETAINED = 500`; the cap is applied to whichever array is being appended to. See `../docs/adr/0002-unify-request-stores-by-source.md` (original unification) and `0006-reintroduce-real-rtk-mode.md` (re-split by Source).

### 3.4 Cursors

- `refreshTimer: number` — seconds-remaining countdown for the next refresh.
- `simulationTimeoutId: number | null` — the in-flight simulator timeout.
- `lastSeenCommandId: number` — Real RTK cursor; the next SSE/poll only logs commands with `id > lastSeenCommandId`.
- `sseClients: Response[]` — server-side array of open SSE connections; cleaned up on `req.on('close')`.

### 3.5 Client-side persistence

| Key | Shape | Owner |
|---|---|---|
| `atm_requests` | `Request[]` | simulator output (`source: 'sim'`) |
| `atm_brand_metadata` | `Record<BrandKey, BrandMetadata>` | user settings |
| `atm_theme` | `'light' \| 'dark'` | user settings |
| `atm_auto_sim` | `'true' \| 'false'` | simulator preference |
| `atm_monitor_mode` | `'real' \| 'sim'` | user settings (re-introduced; see 0006) |

`localStorage` is the only client-side persistence. `.env` is the only user-mutable server-side state.

### 3.6 BrandQuota (server-side cache)

```ts
interface BrandQuota {
  brand: BrandKey;
  remaining: number | null;      // count for "requests" unit, percent (0-100) for "percent" unit
  limit_value: number | null;    // count or 100 (synthesised cap for percent)
  reset_at: number | null;       // 5-hour window end, epoch ms
  reset_at_weekly: number | null;// weekly window end, epoch ms
  weekly_remaining: number | null;
  unit: 'requests' | 'percent' | 'local' | 'not_exposed' | 'missing_key' | 'error';
  raw_json: object | null;       // full provider response (for debugging)
  seeded_at: number;             // epoch ms — when this row was last refreshed
  error: string | null;          // error message when unit === 'error'
}
```

`unit` semantics live in **exactly one place** in the client: `computeApiUsedPct()` in `app.js`. The conversion rule is: `percent` → `100 - remaining`; `requests` → `(limit_value - remaining) / limit_value * 100`; `local`/`not_exposed`/`missing_key`/`error` → `null` (bar falls back to local/RTK spend). For `local` (Claude), the amounts and reset times are drawn from the RTK spend object embedded in `raw_json`.

### 3.7 `Request.source` is back in the schema

The `source` field is no longer a vestigial `'sim'` constant. It is set to:
- `'real'` by `fetchRealRTKData()` and `connectRTKStream()` (mapped from RTK rows via `detectBrand(original_cmd)`)
- `'sim'` by the simulator and the pre-populated mock history

The `getActiveRequests()` filter selects the active array based on `state.monitorMode`.

### 3.8 ContextWindow (Antigravity active session)

The dashboard surfaces the active Antigravity CLI session's consumption against the model's context window on the gemini brand card. The `agent_usage` table (one row per `conversation_id`, populated by `syncAgentUsage()` from `lib/antigravity-parser.js`) is the source of truth.

```ts
interface ContextWindow {
  used: number;          // inputTokens + cachedTokens (cached is part of the window but not re-billed)
  remaining: number;     // 100 - usedPct, clamped to [0, 100]
  usedPct: number;       // Math.min(100, Math.round((used / size) * 100))
  size: number;          // 1_000_000 default; GEMINI_CONTEXT_WINDOW env override (e.g. 2_000_000 for 2.0 Pro max)
  source: 'active';      // reserved for future multi-source aggregation
  lastUpdated: number;   // epoch ms — the active row's last_updated
}
```

The "active" filter is `last_updated >= now - ACTIVE_SESSION_MS` where `ACTIVE_SESSION_MS = 30 * 60 * 1000`. The resolver lives in `lib/antigravity-context.js` (`computeContextWindow(dbPath, opts)`) and accepts an `opts.execFile` injection seam so unit tests can mock `child_process.execFile` cleanly — see §7 for the DI pattern rationale.

The UI renders the payload as a single Session Memory bar (used % vs the size cap). It is gated to `bKey === 'gemini'` because the Antigravity CLI is the only client tracked via `agent_usage`. The server still returns the payload for every brand key in `/api/agent-usage`; the UI ignores it for the other three.

## 4. API contracts

All endpoints are JSON (or SSE for `/api/rtk/stream`). CORS is restricted to localhost. `RTK_DB_PATH` env var (if set) overrides the default RTK DB location.

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

Writes a single key to `.env`. **Allowed `KEY_NAME` values**: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GLM_API_KEY`, `MINIMAX_API_KEY`. Any other value returns 400.

Both writers (`POST /api/env/key` and `POST /api/env`) read the existing `.env` first, merge only the allowed keys, and write back the full map — preserving non-whitelisted keys such as `RTK_DB_PATH` and `FIREBASE_*`. Fixed in Phase 1 (was tracked in `../docs/REVIEWS.md` R3).

### 4.3 `POST /api/env`

Bulk write endpoint. Accepts a JSON object with any of the four allowed key names; writes them all to `.env` after newline-strip sanitisation.

### 4.4 `GET /api/rtk`

Reads `~/Library/Application Support/rtk/history.db` (or `RTK_DB_PATH`) via `execFile('sqlite3', …)` and returns the full command history.

**Response (200)**

```json
{
  "commands": [
    {
      "id": 454,
      "timestamp": "2026-05-29T09:56:20.265014+00:00",
      "original_cmd": "curl -s https://…",
      "rtk_cmd": "MiniMax-M3",
      "input_tokens": 53,
      "output_tokens": 53,
      "saved_tokens": 0,
      "savings_pct": 0,
      "exec_time_ms": 0,
      "project_path": ""
    }
  ]
}
```

The `commands` array is sorted ascending by `id`. `error` is present in the response if the `sqlite3` invocation failed.

### 4.5 `GET /api/rtk/summary`

Returns the aggregate summary (matches `rtk gain` CLI output).

**Response (200)**

```json
{
  "total_commands": 523,
  "total_input": 12345,
  "total_output": 6789,
  "total_saved": 0,
  "total_exec_ms": 0
}
```

### 4.6 `GET /api/rtk/stream` (SSE)

Server-Sent Events stream. Sends a heartbeat `data: {"status":"connected"}\n\n` immediately, then `data: <command>\n\n` for each new RTK row. The server uses `fs.watch()` on the RTK DB directory; on a write event, it debounces 300ms and reads rows with `id > lastSeenDbId` (per-connection, in-memory). `req.on('close')` removes the client from `sseClients`.

### 4.7 `GET /api/seed-quotas`

Returns the cached `brand_quota` rows.

**Response (200)**

```json
{
  "success": true,
  "quotas": [
    {
      "brand": "minimax",
      "remaining": 78,
      "limit_value": 100,
      "reset_at": 1780567200000,
      "reset_at_weekly": 1780876800000,
      "weekly_remaining": 90,
      "unit": "percent",
      "raw_json": { /* full provider response */ },
      "seeded_at": 1780548609886,
      "error": null
    }
  ]
}
```

### 4.8 `POST /api/seed-quotas`

Force-refreshes the `brand_quota` cache. Body: `{"force": true}`. Calls each Brand's `BRAND_FETCHERS[brand].fetch(apiKey)` and replaces the cached row.

**Response (200)**

```json
{ "success": true, "cached": false, "results": [...], "forced": true }
```

### 4.9 `POST /api/rtk/ingest`

Ingest a single RTK-shaped command from a non-RTK client (any project on this machine that wants its LLM usage to count toward the dashboard). The endpoint mirrors the RTK `commands` schema 1:1, INSERTs the row, and broadcasts it over the existing SSE channel so the live dashboard updates within ~1 s.

**Request body** (JSON):

```json
{
  "id": 4711,                                              // optional — for idempotency
  "timestamp": "2026-06-16T12:34:56.000Z",                 // optional — ISO 8601; defaults to now
  "original_cmd": "claude code --print 'hello'",           // required — non-empty string
  "input_tokens":  1234,                                   // optional — non-negative integer; default 0
  "output_tokens": 256,                                    // optional — non-negative integer; default 0
  "saved_tokens":  100,                                    // optional — non-negative integer; default 0
  "exec_time_ms":  842,                                    // optional — non-negative integer; default 0
  "savings_pct":   7.5                                     // optional — [0, 100]; defaults to saved / (input + saved) * 100
}
```

Brand attribution is derived server-side via `detectBrand(original_cmd)`. Token fields are validated with `Number.isFinite` and `Math.max(0, …)`; string values that aren't parseable as numbers default to 0. `original_cmd` and `timestamp` are escaped with `escapeSQLString` (single quotes doubled) so SQL-injection attempts (e.g. `claude ' OR 1=1; DROP TABLE commands; --`) remain inside a single string literal.

**Response (200)**

```json
{ "success": true, "id": 4711, "command": { ...row... }, "broadcast": true }
```

**Response (409 — duplicate id)**

```json
{ "success": false, "error": "Command with this id already exists", "id": 4711 }
```

**Response (400 — missing or empty `original_cmd`)**

```json
{ "success": false, "error": "original_cmd is required (non-empty string)" }
```

**Response (400 — invalid JSON body)**

```json
{ "success": false, "error": "Invalid JSON body" }
```

**Response (500 — DB error)**

```json
{ "success": false, "error": "<sqlite3 stderr>" }
```

After a successful INSERT the row is broadcast to all open SSE clients via `broadcastToClients()` (exported from `lib/sse-watcher.js`). The `connectRTKStream()` handler in `app.js` picks the event up with no code change because the broadcast payload is the same shape `fs.watch()` produces.

No auth — the loopback CORS allowlist (`http://localhost:*` / `http://127.0.0.1:*`) is the trust boundary. Documented in `docs/REVIEWS.md` R7.

### 4.10 `GET /api/agent-usage`

Returns aggregated token and cost metrics from the `agent_usage` table (one row per Antigravity CLI conversation, populated by `syncAgentUsage()` in `server.js`), plus a ContextWindow payload (§3.8) for the most recently updated conversation within `ACTIVE_SESSION_MS`.

**Response (200)**

```json
{
  "total":     { "conversationsCount": 67, "inputTokens": 132276, "outputTokens": 3186379, "cachedTokens": 0, "totalCost": 16.09724, "earliestTimestamp": 1779268093845 },
  "window5h":  { "conversationsCount": 16, "inputTokens": 30695,  "outputTokens": 420523,  "cachedTokens": 0, "totalCost": 2.14098375, "earliestTimestamp": 1784112692294 },
  "weekly":    { "conversationsCount": 21, "inputTokens": 36664,  "outputTokens": 499847,  "cachedTokens": 0, "totalCost": 2.545065, "earliestTimestamp": 1784091975209 },
  "contextWindow": { "used": 11716, "remaining": 99, "usedPct": 1, "size": 1000000, "source": "active", "lastUpdated": 1784117434448 }
}
```

`contextWindow` is `null` when no `agent_usage` row has been updated within `ACTIVE_SESSION_MS = 30 minutes`. The "size" field defaults to `1_000_000` (Gemini 1.5 Pro / 2.0 Flash / 2.5 Pro context window) and is overridable via the `GEMINI_CONTEXT_WINDOW` env var.

The underlying counts (`inputTokens`, `outputTokens`) come from `lib/antigravity-parser.js countTokensFor()`. When `GEMINI_API_KEY` is set in `.env` the parser calls the Gemini `countTokens` API for each unique string with a process-local cache; on error (429, network) or when no key is configured it falls back to `Math.ceil(text.length / 4)`. See §7.

## 5. Component hierarchy

### 5.1 Client

```
init()
├── applyTheme()
├── buildSettingsFormFields()
├── setupEventListeners()
├── setupTabs()
├── fetchAPIKeys()              # GET /api/env
├── fetchBrandQuotas()          # GET /api/seed-quotas
├── startCountdownTimer()       # 30s loop
├── if monitorMode === 'real':
│     ├── fetchRealRTKData()    # initial snapshot
│     └── connectRTKStream()    # EventSource('/api/rtk/stream')
│   else (sim):
│     ├── scheduleNextSimulation()
│     └── generateInitialMockHistory()
└── calculateAndRenderDashboard()
```

The render path is:

```
calculateAndRenderDashboard()
├── aggregate per Brand         # requests, tokens, cost, savings, cost5h, costWeekly
├── renderBrandCards()          # uses state.brandQuotas for API-driven bar + reset
└── renderTable()               # sortable
```

### 5.2 Server

```
http.createServer()
├── OPTIONS preflight  → 200
├── GET  /api/env
├── POST /api/env/key
├── POST /api/env
├── GET  /api/rtk              # execFile('sqlite3', …, DB_PATH, query)
├── GET  /api/rtk/summary       # execFile(... aggregate query)
├── GET  /api/rtk/stream        # SSE; fs.watch() on dbDir
├── POST /api/rtk/ingest        # INSERT INTO commands + broadcastToClients (R7)
├── GET  /api/seed-quotas       # SELECT FROM brand_quota
├── POST /api/seed-quotas       # seedBrandQuotas(force)
├── GET  /api/agent-usage       # totals UNION ALL + computeContextWindow(DB_PATH) (R8)
└── static fallback             # whitelist check, fs.readFile

ensureBrandQuotaTable()         # CREATE + idempotent ALTER TABLE
seedBrandQuotas(force)
├── read existing rows
├── if not force and all valid → return cached
└── for each Brand in BRAND_FETCHERS:
      ├── if no apiKey → store unit:'missing_key' row
      ├── else: await config.fetch(apiKey)
      └── INSERT OR REPLACE INTO brand_quota

BRAND_FETCHERS = {
  claude:   fetchClaudeQuota,    // RTK-only (unit: 'local'); no Anthropic API call
  gemini:   fetchGeminiQuota,    // probe; not_exposed
  glm:      fetchGLMQuota,        // probe + read x-ratelimit-* headers
  minimax:  fetchMinimaxQuota,    // https.request to /v1/token_plan/remains
}
```

## 6. Data flow

### 6.1 Simulation

```
scheduleNextSimulation()  (8-20s random delay)
   │
   ▼
triggerRandomMockRequest()
   │
   ▼
addRequest(brand, input, output, saved)
   │
   ├── compute cost (disjoint model), savings
   ├── push to state.requests  (source: 'sim')
   ├── truncate if > 500
   ├── persist to localStorage
   └── logEvent to console
```

### 6.2 Real RTK Monitor

```
fetchRealRTKData() (initial)
   │
   ├── GET /api/rtk
   ├── sort by id ASC
   ├── for each cmd:
   │     ├── brandKey = detectBrand(cmd.original_cmd)
   │     ├── if !brandKey → skip
   │     ├── compute cost (disjoint model), savings
   │     ├── push to state.realCommands (source: 'real')
   │     ├── if isInitialLoad and idx >= total-15: logEventSafe
   │     └── if cmd.id > lastSeenCommandId: logEventSafe
   └── lastSeenCommandId = max id seen

connectRTKStream()
   │
   ├── EventSource('/api/rtk/stream')
   ├── onmessage:
   │     ├── parse cmd
   │     ├── if cmd.status === 'connected' → return
   │     ├── brandKey = detectBrand(cmd.original_cmd)
   │     ├── compute cost, savings
   │     ├── push to state.realCommands (idempotent on rtk_<id>)
   │     ├── logEventSafe (Real-Time prefix)
   │     └── if monitorMode === 'real' → calculateAndRenderDashboard()
   └── onerror → warn and let EventSource auto-retry

initWatcher() (server-side)
   │
   ├── sync lastSeenDbId on startup
   ├── fs.watch(dbDir, …)
   └── on 'history.db*' event → debounce 300ms → checkForNewCommands()
```

### 6.3 Provider-Quota Tracking

```
init() → fetchBrandQuotas()
   │
   ├── GET /api/seed-quotas
   ├── state.brandQuotas = { brand: row }
   └── calculateAndRenderDashboard()

calculateAndRenderDashboard() (every 30s, or after brandQuotas change)
   │
   └── renderBrandCards():
         for each brand:
           apiQuota = state.brandQuotas[brandKey]
           barPct5h = apiQuota ? computeApiUsedPct(apiQuota, '5h') ?? pct5h : pct5h
           reset5hMs = apiQuota && apiQuota.reset_at > now ? apiQuota.reset_at - now : rolling5hMs
           render <bar width=barPct5h% title=barSourceTooltip(...)>
           render <badge reset time, tooltip apiTooltip or rollingTooltip>

seedBrandQuotas(force) (server-side, every 30s via dashboard tick)
   │
   ├── read existing brand_quota rows
   ├── if !force and all valid → return cached
   └── for each Brand:
         ├── if no apiKey → row{unit:'missing_key'}
         ├── else: result = await BRAND_FETCHERS[brand].fetch(apiKey)
         │     ├── Claude: no API call; returns unit:'local' with RTK spend in raw_json
         │     ├── Gemini: probe with gemini-1.5-flash, not_exposed
         │     ├── GLM: probe with glm-4, read x-ratelimit-remaining-requests / -limit-requests
         │     └── MiniMax: GET /v1/token_plan/remains (Bearer)
         │                 parse model_remains[0] (chat-model pick)
         │                 end_time → reset_at; weekly_end_time → reset_at_weekly
         │                 current_interval_remaining_percent → remaining
         │                 current_weekly_remaining_percent → weekly_remaining
         └── INSERT OR REPLACE INTO brand_quota
```

### 6.4 ESP32 companion mirror (Firebase)

```
triggerFirebaseUpdate(cmds)  (debounced, on new SSE-broadcast command)
   │
   ├── setTimeout(…) 500ms debounce
   ├── seedBrandQuotas()  → fresh results + rtkSpend
   └── publishToFirebase(results, env, rtkSpend)
         │
         ├── read FIREBASE_URL / FIREBASE_AUTH from env (skip if absent)
         ├── build payload { lastUpdated, quotas: { <brand>: {remaining, spend_pct5h,
         │     reset_at (s, not ms), …} } }  — see lib/firebase.js header
         └── fetch PUT <FIREBASE_URL>/display.json?auth=<secret>  (8s timeout)

periodic publish (every 30s quota tick, after seedBrandQuotas)
   └── publishToFirebase(…)  (same path)

ESP32 firmware (firmware/esp32-display/esp32-display.ino)
   ├── WiFi.begin(WIFI_SSID, WIFI_PASS)
   ├── Firebase.RTDB.getString("display")  on a poll interval
   └── render one brand per page on the ST7789 240×280 TFT
```

The mirror is **append-only output**: the server only ever PUTs to `display.json`; the ESP32 only reads. No inbound path from the ESP32 to the dashboard. Reset timestamps are divided ms→s in `lib/firebase.js` because the firmware uses `time(nullptr)` (seconds).

### 6.5 Antigravity CLI usage + active session context window

```
boot (server.js)
   │
   ├── loadEnv(STATIC_ROOT)
   └── if env.GEMINI_API_KEY → _setGeminiKey(env.GEMINI_API_KEY)
                                   (parser module-level switch from chars/4 to real countTokens path)

syncAgentUsage()  (debounced after transcript mtime change)
   │
   ├── parseAllTranscripts()              # lib/antigravity-parser.js
   │     ├── read brain directory         # ~/.gemini/antigravity-cli/brain
   │     ├── skip conversations whose transcript mtimeMs is unchanged  (parserCache)
   │     └── for each changed transcript:
   │           ├── read lines
   │           └── for each line:
   │                 ├── USER_EXPLICIT / SYSTEM → inputTokens += countTokensFor(content)
   │                 └── MODEL / SUBAGENT    → outputTokens += countTokensFor(content + tool_args)
   └── INSERT OR REPLACE INTO agent_usage (conversation_id, last_updated, input_tokens, output_tokens, cached_tokens, total_cost)

GET /api/agent-usage
   │
   ├── totals UNION ALL: total | window5h (last_updated >= now-5h) | weekly (last_updated >= now-7d)
   └── computeContextWindow(DB_PATH, { now })
         │
         ├── SELECT input_tokens, cached_tokens, last_updated FROM agent_usage
         │   WHERE last_updated >= now - ACTIVE_SESSION_MS (30 min)
         │   ORDER BY last_updated DESC LIMIT 1
         │
         ├── if no row → contextWindow = null
         └── else:
               used = input_tokens + cached_tokens
               usedPct = Math.min(100, Math.round((used / size) * 100))   # size defaults to 1_000_000
               return { used, remaining: 100 - usedPct, usedPct, size, source: 'active', lastUpdated }

Client (app.js)
   │
   ├── state.agentUsage = response
   └── renderBrandCards():
         for bKey === 'gemini':
           cw = state.agentUsage.contextWindow
           if cw → render Session Memory bar (width = cw.usedPct%, tooltip names the 1M model cap)
```

The parser's `countTokensFor` is wrapped in `wrapCounter()` (§7) which provides a process-local cache keyed by the input string and a try/catch that falls back to `chars/4` on any error. The wrapper is the same code path for the live `@google/generative-ai` SDK and for any injected test client, so production and tests share the contract.

## 7. Design patterns in use

- **Safe DOM construction**: `appendConsoleLine(source, parts)` distinguishes `{html}` (trusted) from `{text}` (escaped). All untrusted input goes through `{text}`. RTK `original_cmd` is rendered through `{text}` segments in the Real-Time log path.
- **Per-key env writer**: `POST /api/env/key` whitelists a key name. Both writers read the full `.env`, merge only the allowed keys, and write back the complete map — preserving non-whitelisted siblings. `GET /api/env` exposes only the four provider keys (masked). Verified by `tests/envRoundTrip.test.js` (AC-21).
- **Pre-populated history**: `generateInitialMockHistory()` seeds 40 mock Requests on first load so the rolling-window bars have non-zero data to render immediately.
- **API-driven bar with local fallback**: `computeApiUsedPct()` returns `null` when the API doesn't expose a quota; the renderer falls back to the local-spend percentage. The bar tooltip names the source so the user can tell which one is driving the fill.
- **Idempotent `ALTER TABLE` migrations**: `ensureBrandQuotaTable()` runs `CREATE TABLE IF NOT EXISTS` followed by two `ALTER TABLE … ADD COLUMN` statements; each is wrapped in a no-op handler so re-running is safe.
- **Defensive API parsing** (MiniMax fetcher): `fetchMinimaxQuota` tries three wrapper shapes (`model_remains` / `data.model_remains` / `remains`), prefers chat-model entries by name regex (`/M3|M2\.7|M2\.5|M2\b/`), separates the 5h vs weekly window by `(end_time - start_time)` delta, and falls back to the embedded `weekly_end_time` field when no separate weekly entry exists. Multiple field-name aliases are tried for `remaining` / `limit_value` / `weekly_remaining` to absorb API drift.
- **SQLite query construction**: all SQL is built via `escapeSQLString` / `escapeSQLNumber` helpers; no string interpolation of user-supplied values. `child_process.execFile('sqlite3', …)` is used (not `exec`) so the command is array-form and not subject to shell parsing.
- **SSE connection cleanup**: the server holds open SSE clients in `sseClients[]`; `req.on('close')` removes the client. New commands are broadcast by `forEach(client => client.write(...))`. No backpressure handling — clients are expected to be fast.
- **Counter wrapping (`lib/antigravity-parser.js wrapCounter`)**: any upstream token counter — the real `@google/generative-ai` `countTokens`, or a test mock — is funneled through a single function that adds a process-local text-keyed cache and a try/catch fallback to the `chars/4` heuristic. Production and tests share the contract because the wrapping is the contract.
- **Dependency injection for `child_process`**: helpers that need `execFile` (e.g. `lib/antigravity-context.js computeContextWindow`) accept `opts.execFile` rather than calling `require('child_process').execFile` at module scope. `vi.mock('child_process', …)` does not intercept `require()` from CommonJS modules in this stack, so DI is the only way to keep unit tests honest.

## 8. Known design gaps (from `../STATUS.md`)

- **Cache model audit on pre-populated history**: the disjoint model is now applied across all four write paths, but `SIM_HISTORY_PRELOAD` rows pre-dating the migration may still look inconsistent (Reviewer R5 scope).
- **MiniMax fetcher reliance on undocumented field names**: `current_interval_remaining_percent`, `weekly_end_time`, etc. are inferred from the wire response, not a public spec. A future MiniMax API change could silently break the fetcher.
- **`brand_quota` cache can serve 1-hour-stale data** if the provider is unreachable at the moment the reset window elapses. There is no out-of-band staleness signal.
- **Single-store history**: `localStorage` is the only client-side persistence. A server restart loses Request history (only the brand_quota cache survives).
- **No error boundary**: a single failed fetch silently degrades the dashboard; the user sees zeros and a system log message.
- **No accessibility audit**: focus traps, keyboard nav, and screen reader labels are partially implemented; not verified end-to-end.
- **No historical quota trend chart**: only the current snapshot is shown.
- **Dead `contextWindowHtml` block in `app.js`**: the interpolation block added in commit `8e23249` is no longer referenced by the unified card template (commit `8ee1283`). Kept on disk for now as scaffolding; tracked in R8-X1.
- **Antigravity CLI `unit: 'not_exposed'`**: `BRAND_FETCHERS.gemini.fetchGeminiQuota` reports `not_exposed` because Google does not publish a 5h/weekly quota API. The gemini brand bar therefore always shows local-spend fill; the bar in `8ee1283` does not improve on this. To get API-driven fill on the gemini card, `fetchGeminiQuota` would need to gain a percent-remaining signal (not currently feasible).
