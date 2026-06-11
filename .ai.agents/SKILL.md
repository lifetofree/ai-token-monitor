---
name: multi-agent-sdlc
description: Coordinate a role-based multi-agent SDLC workflow (Product Owner, PM, Tech Lead, Architect, Coder, Reviewer, DevOps) that partitions work into handoffs tracked via STATUS.md. Use when the user references .ai.agents roles, the SDLC team personas, or wants structured agent handoffs for feature work.
---

# Multi-Agent SDLC Framework

## Quick Start

1. Read [README.md](README.md) for the team overview and handoff diagram.
2. Identify which role owns the current task and load its rule file (`NN_ROLE_RULES.md`).
3. Operate only inside that role's allowed workspace, then update [../STATUS.md](../STATUS.md) and ping the next agent.

## The Seven Roles (in order)

| # | Role | Rule File | Allowed Workspace |
|---|------|-----------|-------------------|
| 1 | Product Owner | [00_PO_RULES.md](00_PO_RULES.md) | `docs/BUSINESS_GOALS.md` |
| 2 | Product Manager | [01_PM_RULES.md](01_PM_RULES.md) | `docs/REQUIREMENTS.md`, `docs/USER_JOURNEY.md` |
| 3 | Tech Lead | [02_TECH_LEAD_RULES.md](02_TECH_LEAD_RULES.md) | `docs/TECH_STACK.md` |
| 4 | Architect | [03_ARCHITECT_RULES.md](03_ARCHITECT_RULES.md) | `docs/SYSTEM_DESIGN.md` |
| 5 | TDD Coder | [04_CODER_RULES.md](04_CODER_RULES.md) | `src/`, `tests/` |
| 6 | Reviewer | [05_REVIEWER_RULES.md](05_REVIEWER_RULES.md) | reads `src/`+`tests/`, writes `docs/REVIEWS.md` |
| 7 | DevOps | [06_DEVOPS_RULES.md](06_DEVOPS_RULES.md) | `.github/`, `scripts/`, `Dockerfile`, CI |

## Handoff Workflow

1. **PO** defines vision and KPIs, writes `BUSINESS_GOALS.md`, updates STATUS, pings PM.
2. **PM** translates goals into functional + UX requirements with Acceptance Criteria, updates STATUS, pings Tech Lead.
3. **Tech Lead** runs feasibility, picks stack, sets standards, updates STATUS, pings Architect.
4. **Architect** designs schema, APIs, component hierarchy, updates STATUS, pings Coder.
5. **Coder** writes failing tests first, then implementation (Red-Green-Refactor), updates STATUS, pings Reviewer.
6. **Reviewer** audits code, verifies AC, writes `docs/REVIEWS.md`. Approved: ping DevOps. Rejected: ping Coder with rollback in STATUS.
7. **DevOps** keeps CI green, deploys, marks STATUS as Production Ready.

## Core Rules

- Stay in your role's allowed workspace. Cross-workspace edits are out of scope.
- Every handoff updates [../STATUS.md](../STATUS.md) with a checkpoint and ping.
- Reviewer rejections roll STATUS back to Coder's stage and log the regression in `docs/REVIEWS.md`.
- Coder must follow Red-Green-Refactor and respect the Architect's contracts and Tech Lead's standards.

## Status Tracking

The single source of truth for progress is [../STATUS.md](../STATUS.md). Check it before starting work, update it on every handoff, and reference the current stage before invoking a role.
