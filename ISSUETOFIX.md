# Issues to Fix — Multi-Project Ingest

> Scope: `POST /api/rtk/ingest` — combining usage from another project into this dashboard.
> Date: 2026-06-16
> Source: Code review of server.js, lib/rtk-metrics.js, lib/brand-detect.js

---

## Issue 1 — Brand attribution breaks for generic `original_cmd` values

### Problem

`detectBrand(original_cmd)` scans the command string for brand keywords
(`claude`, `anthropic`, `gemini`, `minimax`, `glm`, `zhipu`). When a
project uses generic names that contain no keyword, the server falls back
to `'claude'` — silently mis-attributing traffic from any LLM to Claude.

```
detectBrand("call_llm(prompt)")       → null → fallback: 'claude'  ← WRONG if it's Gemini
detectBrand("ai.generate(prompt)")    → null → fallback: 'claude'  ← WRONG
detectBrand("claude messages.create") → 'claude'                   ← correct
detectBrand("gemini generateContent") → 'gemini'                   ← correct
```

The fallback was added in `lib/rtk-metrics.js` for RTK tool calls, where
the entire DB is known to be Claude Code traffic. For custom ingest from a
multi-brand project the same fallback produces wrong numbers on every
brand card.

### Fix

**Step 1 — Accept an explicit `brand` field on the ingest payload**

In `server.js`, inside the `POST /api/rtk/ingest` handler, read an
optional `brand` field after the existing coercions:

```js
// After the existing coercions (line ~150 in server.js)
const VALID_BRANDS = ['claude', 'gemini', 'minimax', 'glm'];
const brandHint = (typeof payload.brand === 'string'
  && VALID_BRANDS.includes(payload.brand.toLowerCase()))
  ? payload.brand.toLowerCase()
  : null;
```

Store it alongside the row — either embed it in `original_cmd` as a prefix
(`claude::call_llm(prompt)`) or add a `brand` column to the `commands`
table. The column approach is cleaner:

```sql
-- Run once (idempotent migration, same pattern as reset_at_weekly):
ALTER TABLE commands ADD COLUMN brand TEXT DEFAULT '';
```

And in the INSERT statement, include the new column:

```js
const brandCol   = escapeSQLString(brandHint || '');
// add 'brand' to the column list and brandCol to the VALUES list
```

**Step 2 — Use the stored `brand` in `getRtkSpendMetrics`**

In `lib/rtk-metrics.js`, after detecting the brand from `original_cmd`,
fall back to the stored `brand` column before falling back to `'claude'`:

```js
// SELECT must include `brand` column
const query = `SELECT timestamp, original_cmd, brand, input_tokens, ...`;

// In the forEach loop:
const brandKey = detectBrand(row.original_cmd)
  || (row.brand && METADATA[row.brand] ? row.brand : null)
  || 'claude';   // last resort: untagged RTK tool call → Claude
```

This preserves the existing Claude Code tool-call behaviour (no brand in
`original_cmd`, no `brand` column value → 'claude') while letting custom
ingests declare their actual LLM explicitly.

**Step 3 — Update the SQL query in `server.js` to fetch the `brand` col**

The lookup query after INSERT must also return `brand` so the SSE broadcast
carries it to the live feed. The live feed already uses `detectBrand` on
`original_cmd` for display, so this is a minor enhancement.

**Step 4 — Update `tests/ingest.test.js`**

Add cases for the new `brand` field:

```js
it('accepts a valid brand override and includes it in the INSERT', () => {
  const r = buildIngestInsert({
    original_cmd: 'generate_image(prompt)',
    input_tokens: 500,
    brand: 'gemini'
  });
  expect(r.ok).toBe(true);
  expect(r.sql).toMatch(/'gemini'/);
});

it('ignores unknown brand values (not in VALID_BRANDS)', () => {
  const r = buildIngestInsert({
    original_cmd: 'call_ai()',
    brand: 'openai'  // not tracked
  });
  expect(r.ok).toBe(true);
  // brand column should be empty string, not 'openai'
  expect(r.sql).toMatch(/, ''\);$/);
});
```

**Usage from another project after the fix:**

```bash
# Gemini call — explicit brand so it lands on the Gemini card
curl -s -X POST http://localhost:3000/api/rtk/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "original_cmd": "generate_content(user_prompt)",
    "brand": "gemini",
    "input_tokens": 800,
    "output_tokens": 300,
    "project_path": "/path/to/my-project"
  }'

# Claude call — keyword in original_cmd is enough, brand field optional
curl -s -X POST http://localhost:3000/api/rtk/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "original_cmd": "claude messages.create",
    "input_tokens": 1200,
    "output_tokens": 400,
    "project_path": "/path/to/my-project"
  }'
```

**Files to change:**
- `server.js` — add `brand` coercion + include in INSERT + lookup SQL
- `lib/rtk-metrics.js` — add `brand` column to SELECT, use it in fallback chain
- `lib/quota-cache.js` or a new migration helper — `ALTER TABLE ADD COLUMN brand`
- `tests/ingest.test.js` — new cases for brand field

---

## Issue 2 — `project_path` is stored but never shown in the UI

### Problem

The `project_path` column is stored for every custom-ingest row and indexed
(`idx_project_path_timestamp`), but nothing in the dashboard reads or renders
it. All usage from Project A, Project B, and the RTK proxy is merged into a
single number per brand card. The user cannot answer:

> "Which of my projects is spending the most Claude budget this week?"

### Fix

**Step 1 — Add a `/api/rtk/projects` endpoint**

In `server.js`, add a new GET endpoint that aggregates spend broken down by
`project_path` for the rolling windows:

```js
if (req.method === 'GET' && req.url === '/api/rtk/projects') {
  const now = Date.now();
  const fiveHoursAgo = new Date(now - 5 * 3600 * 1000).toISOString();
  const sevenDaysAgo = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

  // Aggregate by project_path + brand for each window.
  // project_path='' rows are native RTK proxy commands.
  const query = `
    SELECT
      CASE WHEN project_path = '' THEN '(rtk-proxy)' ELSE project_path END AS project,
      brand,
      COUNT(*)                          AS requests,
      SUM(input_tokens)                 AS input_tokens,
      SUM(output_tokens)                AS output_tokens,
      SUM(saved_tokens)                 AS saved_tokens
    FROM commands
    WHERE timestamp >= ${escapeSQLString(sevenDaysAgo)}
    GROUP BY project, brand
    ORDER BY project, brand
  `;
  execFile('sqlite3', ['-cmd', '.timeout 5000', '-json', DB_PATH, query],
    (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (err || !stdout.trim()) {
        res.end(JSON.stringify({ projects: [] }));
        return;
      }
      try { res.end(JSON.stringify({ projects: JSON.parse(stdout) })); }
      catch (e) { res.end(JSON.stringify({ projects: [] })); }
    }
  );
  return;
}
```

Note: requires the `brand` column from Issue 1 to be meaningful per-project.
Without it, all rows would show `brand = ''` and the breakdown is only by
`project_path`.

**Step 2 — Add a "Projects" section to the dashboard UI**

In `index.html`, add a collapsible section below the brand cards:

```html
<section id="projects-section" class="card" style="display:none;">
  <h2 class="section-title">Usage by Project (7-day)</h2>
  <div id="projects-table-container"></div>
</section>
```

Show it only when at least one custom-ingest row exists (i.e., any row with
`project_path !== ''`).

**Step 3 — Render the project breakdown in `app.js`**

Add a `fetchProjectData()` function called on the same 30-second refresh
cycle as the quota data:

```js
async function fetchProjectData() {
  try {
    const res = await fetch('/api/rtk/projects');
    const { projects } = await res.json();
    renderProjectBreakdown(projects);
  } catch (e) {}
}

function renderProjectBreakdown(projects) {
  const container = document.getElementById('projects-table-container');
  const section   = document.getElementById('projects-section');
  if (!projects || projects.length === 0) {
    section.style.display = 'none';
    return;
  }

  // Show only rows with a real project_path (not RTK proxy)
  const custom = projects.filter(p => p.project !== '(rtk-proxy)');
  if (custom.length === 0) { section.style.display = 'none'; return; }

  section.style.display = '';
  const METADATA = window.PRICING_DEFAULTS || {};
  const rows = custom.map(p => {
    const meta = METADATA[p.brand] || {};
    const cost = ((p.input_tokens * (meta.inputCost || 3))
                + (p.output_tokens * (meta.outputCost || 15))) / 1_000_000;
    return `<tr>
      <td class="project-name" title="${escapeHtml(p.project)}">${escapeHtml(shortPath(p.project))}</td>
      <td>${escapeHtml(p.brand || '—')}</td>
      <td>${p.requests}</td>
      <td>${formatCompactNumber(p.input_tokens + p.output_tokens)}</td>
      <td>${formatCurrency(cost)}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="projects-table">
      <thead><tr>
        <th>Project</th><th>Brand</th><th>Reqs</th>
        <th>Tokens (7d)</th><th>Cost (7d)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function shortPath(p) {
  // Show only the last two path segments so the table stays readable
  return p.split('/').filter(Boolean).slice(-2).join('/');
}
```

**Step 4 — Add CSS for `.projects-table`**

In `styles.css`, next to the existing table styles:

```css
.projects-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.projects-table th,
.projects-table td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.projects-table th {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 600;
  letter-spacing: 0.04em;
}
.project-name {
  font-family: var(--font-mono);
  font-size: 11px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

**Step 5 — Add `/api/rtk/projects` to the server's static allowlist**

It is an API route, not a static file, so no whitelist change is needed —
just ensure it is routed before the static file handler in `server.js`.

**Step 6 — Add to the API surface table in `README.md`**

```
| `GET` | `/api/rtk/projects` | Per-project 7-day spend breakdown (brand + token counts + cost) |
```

**Files to change:**
- `server.js` — new `/api/rtk/projects` GET endpoint
- `index.html` — projects section HTML
- `app.js` — `fetchProjectData()` + `renderProjectBreakdown()`
- `styles.css` — `.projects-table` styles
- `README.md` — API surface table

---

## Dependency between the two issues

Issue 2's per-project breakdown is **more useful** after Issue 1 is fixed,
because without the `brand` column every custom-ingest row shows `brand = ''`
and the project table can only show totals, not which LLM each project used.

**Recommended order:** fix Issue 1 first (schema + ingest handler), then
build Issue 2 on top of the correct `brand` data.

---

## Quick-reference checklist

### Issue 1 — Brand field
- [x] `ALTER TABLE commands ADD COLUMN brand TEXT DEFAULT ''` (migration) — `ensureBrandColumn()` in `server.js`
- [x] Add `brand` coercion to `POST /api/rtk/ingest` in `server.js` — `VALID_BRANDS` + `brandHint` at line 170
- [x] Include `brand` in INSERT and lookup SQL — INSERT at line 185, lookup at lines 204-205
- [x] Update SELECT in `lib/rtk-metrics.js` to read `brand` column — `SELECT ... brand, rtk_cmd ...`
- [x] Update fallback chain: `detectBrand(cmd) || row.brand || (row.rtk_cmd ? 'claude' : null)` — preserves RTK tool-call attribution while preventing mis-attribution of untagged custom ingests
- [x] Add `brand` test cases to `tests/ingest.test.js` — 12 brand coercion tests (33 total in file)

### Issue 2 — Project breakdown UI
- [x] `GET /api/rtk/projects` endpoint in `server.js` — filters to `brand != '' AND project_path != ''` (custom ingests only)
- [x] Projects section in `index.html` — `display:none` until custom ingests exist
- [x] `fetchProjectData()` + `renderProjectBreakdown()` in `app.js` — called on init + 30s refresh cycle
- [x] `shortPath()` helper in `app.js` — inline `p.project.split('/').filter(Boolean).slice(-2).join('/')`
- [x] `.projects-table` CSS in `styles.css` — lines 836-860
- [x] Update `README.md` API table — line 159
