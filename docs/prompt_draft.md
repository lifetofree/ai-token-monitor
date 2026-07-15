# Teamwork Project Prompt — Draft

> Status: Ready for launch — awaiting user approval
> Goal: Craft prompt → get user approval → delegate to teamwork_preview

An autonomous multi-agent review task to audit the AI Token Monitor codebase and suggest high-value architectural, performance, and robustness improvements.

Working directory: /Users/lifetofree/documents/projects/ai-token-monitor
Integrity mode: development

## Requirements

### R1. Codebase Audit
Perform a deep-dive audit of the project structure, including the core server ([server.js](file:///Users/lifetofree/documents/projects/ai-token-monitor/server.js)), client script ([app.js](file:///Users/lifetofree/documents/projects/ai-token-monitor/app.js)), helper modules in [lib/](file:///Users/lifetofree/documents/projects/ai-token-monitor/lib/), and the test suite in [tests/](file:///Users/lifetofree/documents/projects/ai-token-monitor/tests/). Identify performance bottlenecks, code duplication, security weaknesses, or reliability concerns.

### R2. Architectural & Quality Proposals
Document concrete, actionable improvement recommendations. For each recommendation, describe:
- The current problem/limitation.
- The proposed solution/refactoring.
- The specific files and modules that would be impacted.
- Expected impact (e.g. performance gains, cleaner code, higher robustness).

### R3. Preservation of Project Posture
Ensure all suggestions respect the project's golden rules:
- Keep the project **zero-dependency** (no new external runtime dependencies).
- Retain the dual-monitor mode (Real RTK + Simulation) and the SQLite-backed state schema.

## Acceptance Criteria

### Audit Depth & Breadth
- [ ] The audit analyzes the SQLite process-spawning mechanism (`execFile('sqlite3', ...)`) and proposes potential optimizations or library-less alternatives (e.g., standardizing input validation or buffering queries).
- [ ] The audit reviews the API quota defensive parsing in [lib/brand-fetchers.js](file:///Users/lifetofree/documents/projects/ai-token-monitor/lib/brand-fetchers.js) and identifies robustness improvements.
- [ ] The audit reviews test coverage and identifies any missing test scenarios.

### Actionable Deliverables
- [ ] A detailed markdown report is generated containing at least 3 concrete, high-value improvement proposals.
- [ ] Each proposal includes specific implementation examples or pseudo-code showing how to implement the recommendation.
