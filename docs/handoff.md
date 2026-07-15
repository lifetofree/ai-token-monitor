# Handoff — Mac System Monitor feature (ESP32 + daemon + web dashboard)

Written 2026-07-15. Picks up from a long session that took the Mac System Monitor
feature (wayfinder map: GitHub issue #4, sub-tickets #5-#12) from open decisions
all the way to a working, real-data end-to-end pipeline. Nothing in this session's
work has been committed to git yet — everything below is still in the working tree.

## Where things stand

**Resolved on GitHub** (comments posted, read these instead of re-deriving):
- #5 (library choice): resolved via `/research` → `docs/research/mac-metrics-library-choice.md`.
  Verdict: stay zero-dependency, shell out to `top`/`vm_stat`/`netstat`/`pmset`. CPU temp
  needs either root or native compilation — see below, this got revisited later in the session.
- #6 (Firebase schema): resolved via `/grilling` (comment on the issue has the full schema).
  Key call: `mac` is a **sibling key** under `/display`, not nested in `quotas`, no wholesale
  `/display/snapshot.json` rename. Flat value-only history arrays (no per-sample timestamps).
  No explicit online/stale flag — client derives staleness from a single `ts` (unix seconds).
- #7 (server endpoint): resolved via `/grilling` (comment on the issue). `POST /api/mac`, no auth
  (loopback CORS), hard-400 on missing/wrong-type required fields, clamp in-range values.

**Not yet posted back to GitHub, but actually implemented and working:**
- #8 (ESP32 prototype): built 3 variants as a throwaway prototype, user picked **Variant B
  (2x3 card grid)**. The 3-variant comparison is preserved at
  `docs/research/esp32-mac-page-prototype-3-variants.ino` (plain file copy, not a git branch —
  committing was never explicitly authorized).
- #10 (render signature/data model): implemented for real in `esp32-display.ino` — see
  `MacData`/`MacMetric` structs, `fetchMacData()`, `drawMacScreen()`. Not yet posted as a
  resolution comment on issue #10.
- #11 (launchd plist): implemented and installed for real —
  `~/Library/LaunchAgents/com.ai-token-monitor.mac.plist`, loaded and running. Not yet posted
  as a resolution comment on issue #11.

**Still open, not addressed this session:**
- #9 (swipe gesture navigation) — currently there's only a placeholder: tap the footer from
  Overview to enter the Mac page, tap the header to go back. No swipe.
- #12 (sampling cadence vs. battery drain) — daemon just always samples every 2s, no
  adaptive/on-battery throttling.

## What's built and verified working on real hardware

1. **`mac/temp-sensor.c`** — standalone C helper reading real CPU die temperature on Apple
   Silicon via the private `IOHIDEventSystemClient` IOKit API (no root needed, but does need
   native compilation — this was an explicit user tradeoff decision partway through the
   session, overriding #5's original "temp unavailable" conclusion). **Important, hard-won
   fact**: the sensor name prefix that actually works on this machine (macOS 26.5.2) is
   `"PMU tdie"` — reference implementations elsewhere assume `"pACC/eACC MTR Temp Sensor"`,
   which does not exist on this hardware. Verified empirically with a debug dump of all 141
   HID services before landing on the right prefix.
2. **`mac/mac-monitor.js`** — the daemon. Samples cpu/mem/net/battery via `child_process`
   (top/vm_stat/netstat/pmset) and temp via the compiled helper (built once at startup if
   missing, not per-sample). Posts to `POST /api/mac` every 2s. Currently running under
   launchd (`com.ai-token-monitor.mac`, PID visible via `launchctl list`).
3. **`server.js`** — `POST /api/mac` (validates, publishes to Firebase via
   `publishMacToFirebase`) and `GET /api/mac` (serves last in-memory sample for the web
   dashboard). `lib/firebase.js` has the new `publishMacToFirebase()` export.
4. **`firmware/esp32-display/esp32-display.ino`** — real `STATE_MAC` page, `drawMacScreen()`
   (Variant B card grid), `fetchMacData()` polling `/display/mac.json` every 2s while that
   page is showing, offline banner when `ts` is >10s stale.
5. **`index.html` / `app.js` / `styles.css`** — new "Mac System Metrics" panel on the web
   dashboard (`#mac-section`), polls `GET /api/mac` every 3s. All element IDs cross-checked
   against JS references — no typos.

**Just fixed, needs a recompile+flash to confirm**: `parseMacHistoryArray()` was calling
`json.get(FirebaseJsonArray&, path)`, which doesn't exist on this Firebase_ESP32_Client
version. Fixed to go through `FirebaseJsonData::getArray()` instead (verified against the
actual installed header, not guessed). **This was never tested on hardware after the fix** —
that's the most likely next thing to break.

## Known gotchas for the next agent

- **I cannot flash the ESP32 or take real screenshots in this environment.** No
  `arduino-cli`/board toolchain, no working `screencapture` (no Screen Recording permission),
  no puppeteer install, and the `vc-chrome-devtools` skill's expected script path isn't
  installed on this machine. All hardware/visual verification needs the user.
- **A separate autonomous "teamwork_preview" agent team was running concurrently on this same
  repo earlier in the session** (launched from `docs/prompt_draft.md`'s plan) and built a
  conflicting architecture (single `/display/snapshot.json`, `lib/snapshot.js`,
  `docs/mac_monitor_plan.md`). It was killed (PID 24987) at the user's request. Its leftover
  files are still untracked and unaddressed — user hasn't said what to do with them:
  `.agents/`, `docs/mac_monitor_plan.md`, `docs/prompt_draft.md`, `docs/new-feature.md`,
  `lib/snapshot.js`, `tests/snapshot.test.js`, and a couple of stray files under
  `firmware/esp32-display/` (`esp32-display copy-color.txt`, `minimal-test/`). **Don't build on
  any of these** — they reflect the abandoned architecture, not the one actually implemented.
- **Nothing has been committed.** Per this project's standing rule, only commit when the user
  explicitly asks. A `docs/research/mac-metrics-library-choice.md`-style research doc and this
  handoff are both currently uncommitted, alongside all the feature code.
- The real Firebase secrets live in `~/Library/LaunchAgents/com.ai-token-monitor.plist` and the
  repo's `.env` (both gitignored) — don't read/echo them without the user's privacy-hook
  approval prompt.

## Suggested next steps

1. Ask the user whether the ESP32 recompiled/flashed cleanly after the `parseMacHistoryArray`
   fix, and whether the Mac page renders correctly on the actual device.
2. Post resolution comments to GitHub issues #10 and #11 (decisions were made and implemented,
   just never recorded on the tracker — keeps the wayfinder map honest).
3. Ask what to do with the killed agent team's leftover files (delete, review, or ignore).
4. If continuing the wayfinder map: #9 (swipe gesture) and #12 (sampling cadence) are still open.

## Suggested skills

- **`/code-review`** — a large amount of code landed this session (daemon, native helper,
  server endpoints, firmware, web panel) with no formal review pass yet. Run before committing
  anything.
- **`/grilling`** — if picking #9 or #12 back up, both are labeled `wayfinder:grilling` on the
  issue tracker and should go through the same interview-and-record pattern used for #6/#7.
- **`/verify`** — once the ESP32 fix is confirmed flashed, use this to re-exercise the daemon →
  server → Firebase → ESP32/web-dashboard path end-to-end rather than trusting the fix blind.
- **`/run`** — useful if the user wants the web dashboard actually launched and driven in a
  browser for a real visual check, since this session couldn't do that itself.
