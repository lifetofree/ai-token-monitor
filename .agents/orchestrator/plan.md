# Project: Mac System Monitor Planning
# Scope: Dependency mapping and recommended sequence for Mac System Monitor tickets

## Architecture
- Mac daemon (`mac-monitor.js`) collects CPU, RAM, net, temp, and battery stats, pushes every 2s via HTTP POST to `/api/mac`.
- Express Server (`server.js`) handles POST, merges with Quota snapshot, and publishes to Firebase Realtime Database at `/display/snapshot.json`.
- ESP32 Display pulls merged snapshot from Firebase every 2s, renders stats/sparklines.
- Web Dashboard receives snapshots via SSE, displays stats/sparklines.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| 1 | Setup & Analysis | Create workspace structure and analyze docs/new-feature.md tickets | None | DONE |
| 2 | Dependency Analysis & Verification Design (Explorer) | Spawn Explorer to map dependency edges for tickets 5-12 and design concrete verification mechanisms | Milestone 1 | DONE |
| 3 | Review Findings (Reviewer) | Spawn Reviewer to audit and verify dependency graph and verification strategies | Milestone 2 | DONE |
| 4 | Write Final Plan (Worker) | Spawn Worker to write final docs/mac_monitor_plan.md containing Mermaid diagram and detailed narrative | Milestone 3 | DONE |
| 5 | Review Final Artifact (Reviewer) | Spawn Reviewer to verify docs/mac_monitor_plan.md meets all user acceptance criteria | Milestone 4 | DONE |

## Interface Contracts
- `POST /api/mac` payload:
  ```json
  {
    "timestamp": 1720980000000,
    "current": {
      "cpu": 45.2,
      "memory": {
        "used": 12,
        "total": 16,
        "percent": 75
      },
      "network": {
        "down": 120,
        "up": 45
      },
      "temperature": 65,
      "battery": {
        "percent": 85,
        "charging": true
      }
    },
    "history": {
      "cpu": [{"t": 1720979940000, "v": 42.1}, ...],
      "memory": [{"t": 1720979940000, "v": 74}, ...],
      "network_down": [{"t": 1720979940000, "v": 115}, ...],
      "network_up": [{"t": 1720979940000, "v": 42}, ...],
      "temperature": [{"t": 1720979940000, "v": 64}, ...],
      "battery": [{"t": 1720979940000, "v": 84}, ...]
    }
  }
  ```
- Firebase path: `/display/snapshot.json`
- Firebase merge structure contains existing quota cards (gemini, claude, minimax, glm) + `mac` key containing last_seen, online, and payload.
