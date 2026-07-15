## 2026-07-15T05:06:25Z
You are teamwork_preview_worker.
Your working directory is /Users/lifetofree/documents/projects/ai-token-monitor/.agents/teamwork_preview_worker_document_plan.
Your task is to write a comprehensive markdown implementation plan file at `/Users/lifetofree/documents/projects/ai-token-monitor/docs/mac_monitor_plan.md`.

Use the analysis and findings from the Explorer:
- Analysis: `/Users/lifetofree/documents/projects/ai-token-monitor/.agents/teamwork_preview_explorer_analysis/analysis.md`
- Handoff Report: `/Users/lifetofree/documents/projects/ai-token-monitor/.agents/teamwork_preview_explorer_analysis/handoff.md`

Your document `docs/mac_monitor_plan.md` MUST include:
1. A clear title and executive summary.
2. A Mermaid diagram representing the recommended sequence and blocking dependency edges.
3. Detailed breakdown of all 8 tickets:
   - Ticket #5 (Library choice)
   - Ticket #6 (Firebase schema)
   - Ticket #7 (Server endpoint)
   - Ticket #8 (ESP32 prototype)
   - Ticket #9 (Swipe gesture)
   - Ticket #10 (Render signature)
   - Ticket #11 (launchd plist)
   - Ticket #12 (Sampling cadence)
4. A testing-first recommended implementation order, explaining how to build and test the backend contracts and Firebase schemas before flashing hardware or deploying the background daemon.
5. Concrete verification mechanisms for each of the 8 steps (e.g. `curl` payloads, mock Firebase nodes/rules, serial logging) that can be run before downstream work begins.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Please write the file, ensure it is fully compliant, and write your completion handoff report to `handoff.md` in your working directory.
