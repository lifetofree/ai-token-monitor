# Mac System Monitor - Dependency & Verification Analysis

## Executive Summary
This report maps the technical dependencies between the 8 implementation tickets for the Mac System Monitor feature and outlines a testing-first sequence. By decoupling data-contracts and server endpoints from hardware and background daemon execution, we establish a robust verification pipeline using mock payloads and emulator tests.

---

## 1. Ticket Analysis & Technical Bounds

### Ticket #5: Library Choice
* **File References**: `docs/research/mac-metrics-library-choice.md` (Lines 1–343), `docs/new-feature.md` (Lines 37–69).
* **Scope**: Choose a library or strategy to collect CPU load, memory usage, network bandwidth, CPU temperature, and battery stats in Node.js.
* **Findings**: `systeminformation` is not currently in `package.json` and behaves as a thin wrapper around shell commands anyway. On macOS, it fails to read CPU temperature without native-compiled helper packages (which violates "no native compilation"). Standard commands (`top -l 1`, `vm_stat`, `netstat -ib`, and `pmset -g batt`) can fetch all required metrics except CPU temperature. CPU temperature requires superuser (`powermetrics`) or native C-bindings wrapping private IOHIDEventSystemClient APIs.
* **Recommendation**: Stay dependency-free. Shell out via `child_process` to `top`/`vm_stat`/`netstat`/`pmset`, and set CPU temperature to `null`.

### Ticket #6: Firebase Schema
* **File References**: `docs/new-feature.md` (Lines 301–401), `lib/firebase.js` (Lines 161–169).
* **Scope**: Redefine the schema to merge brand quotas and Mac monitor statistics under a unified Firebase path (`/display/snapshot.json`).
* **Design**: Consolidate into `/display/snapshot.json` with standard quota keys (`gemini`, `claude`, etc.) alongside a `mac` key containing:
  - `last_seen` (timestamp)
  - `online` (boolean)
  - `current`: `{ cpu, memory: { used, total, percent }, network: { down, up }, temperature, battery: { percent, charging } }`
  - `history`: `{ cpu, memory, network_down, network_up, temperature, battery }` arrays of length 60 containing `{ t, v }` objects.

### Ticket #7: Server Endpoint
* **File References**: `server.js` (Lines 235–299 in `docs/new-feature.md`).
* **Scope**: Add `POST /api/mac` to `server.js`. Receive and validate the payload, update global state, merge it with the quota snapshot via `publishSnapshot()`, check for offline status (stale update > 10s old), and publish to `/display/snapshot.json`.

### Ticket #8: ESP32 Prototype
* **File References**: `firmware/esp32-display/esp32-display.ino` (Lines 405–518 in `docs/new-feature.md`, Lines 1196–1232 in base repo).
* **Scope**: Update firmware to fetch the merged snapshot from `/display/snapshot.json/mac` (or `/display/snapshot.json` to parse everything). Parse flat current values and historical arrays into the `MacData` struct.

### Ticket #9: Swipe Gesture
* **File References**: `firmware/esp32-display/esp32-display.ino` (Lines 520–569 in `docs/new-feature.md`).
* **Scope**: Update `handleTouch()` to recognize horizontal swipes (`abs(dx) > 80` and `abs(dx) > abs(dy) * 2`). Cycle through the state machine: `STATE_OVERVIEW` -> `STATE_MAC` -> `STATE_SETTINGS`.

### Ticket #10: Render Signature
* **File References**: `firmware/esp32-display/esp32-display.ino` (Lines 570–715 in `docs/new-feature.md`).
* **Scope**: Implement screen drawing for the Mac page, including the 5 metric rows, custom sparkline scaling (relative to 60-sample min/max), battery indicator at the bottom, and a "Mac Offline" splash screen.

### Ticket #11: launchd plist
* **File References**: `docs/new-feature.md` (Lines 180–230).
* **Scope**: Create `~/Library/LaunchAgents/com.ai-token-monitor.mac.plist` pointing to `node mac/mac-monitor.js` to ensure the daemon automatically loads and stays alive.

### Ticket #12: Sampling Cadence
* **File References**: `docs/new-feature.md` (Lines 71–145).
* **Scope**: Establish the 2-second interval loop in the daemon script (`mac/mac-monitor.js`). Maintain 60-sample in-memory ring buffers (`cpuHistory`, `memHistory`, etc.) by shifting out older entries.

---

## 2. Dependency Mapping

The relationship between the 8 tickets can be visualized as follows:

```
                  [Ticket #5: Library Choice]
                              │
                              ▼
                 [Ticket #12: Sampling Cadence]
                              │
                              ▼
                 [Ticket #6: Firebase Schema]
                 (defines contract for all data)
                              │
            ┌─────────────────┴─────────────────┐
            ▼                                   ▼
  [Ticket #7: Server Endpoint]     [Ticket #8: ESP32 Prototype]
            │                                   │
            ▼                                   ▼
  [Ticket #11: launchd plist]      [Ticket #9: Swipe Gesture]
                                                │
                                                ▼
                                   [Ticket #10: Render Signature]
```

### Key Dependency Rules:
1. **Core Data Contract First**: Ticket #6 (Firebase Schema) defines the structure that passes through both the server (Ticket #7) and the ESP32 (Ticket #8). It is the single source of truth and must be defined first.
2. **Server Before Client**: Ticket #7 (Server Endpoint) must be functional so the database contains valid structures. Flashing the ESP32 (Ticket #8) is blocked by having a reliable database path to query.
3. **Daemon Core Before launchd**: The daemon metrics logic (Ticket #5) and loop/buffering logic (Ticket #12) must be written and running in a manual Node process before installing launchd configuration (Ticket #11).
4. **Parsing Before Rendering**: Fetching and parsing JSON data (Ticket #8) must occur before rendering graphs or rows (Ticket #10).
5. **Navigation Enables UI Testing**: Detecting swipes (Ticket #9) enables navigating to the Mac page to verify UI layout (Ticket #10) in physical testing.

---

## 3. Recommended Testing-First Sequence

To achieve maximum efficiency and verify contracts before physical deployment, implement in this order:

| Step | Ticket | Component | Focus | Pre-requisites |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **#6** | Firebase Schema | Define data contract and path transition | None |
| **2** | **#7** | Server Endpoint | Add `/api/mac`, validation, merging, and staleness checks | #6 |
| **3** | **#5** | Library Choice | Code system metrics capture shell commands | None |
| **4** | **#12** | Sampling Cadence | Implement local daemon script, loop, and ring buffers | #5 |
| **5** | **#11** | launchd plist | Deploy plist daemon configuration | #12, #7 |
| **6** | **#8** | ESP32 Prototype | Parse Firebase nested JSON payload into C-structs | #6 |
| **7** | **#9** | Swipe Gesture | Integrate horizontal touch swipe | #8 |
| **8** | **#10** | Render Signature | Render rows, sparkline formulas, and battery icon | #9, #8 |

---

## 4. Step-by-Step Verification Plan

For each stage in the implementation sequence, run these specific verification protocols.

### Step 1: Firebase Schema (Ticket #6)
* **Objective**: Define the data structure and verify Firebase can hold the shape.
* **Verification Method**:
  Create a file `mock_snapshot.json` locally and write to the mock path `/display/snapshot.json` using `curl`:
  ```bash
  curl -X PUT \
    -H "Content-Type: application/json" \
    -d '{
      "gemini": { "name": "Gemini", "remaining": 85, "limit_value": 100, "weekly_remaining": 70 },
      "mac": {
        "last_seen": 1720980000000,
        "online": true,
        "timestamp": 1720980000000,
        "current": {
          "cpu": 45.2,
          "memory": { "used": 12, "total": 16, "percent": 75 },
          "network": { "down": 120, "up": 45 },
          "temperature": null,
          "battery": { "percent": 85, "charging": true }
        },
        "history": {
          "cpu": [{"t": 1720979940000, "v": 42.1}, {"t": 1720979942000, "v": 43.5}],
          "memory": [{"t": 1720979940000, "v": 74}, {"t": 1720979942000, "v": 75}],
          "network_down": [{"t": 1720979940000, "v": 115}, {"t": 1720979942000, "v": 120}],
          "network_up": [{"t": 1720979940000, "v": 42}, {"t": 1720979942000, "v": 45}],
          "temperature": [],
          "battery": [{"t": 1720979940000, "v": 84}, {"t": 1720979942000, "v": 85}]
        }
      }
    }' \
    "http://127.0.0.1:9000/display/snapshot.json?auth=test-token" # (or staging Firebase endpoint)
  ```
  Verify the database resolves the JSON structure successfully without schema or permission rule rejections.

### Step 2: Server Endpoint (Ticket #7)
* **Objective**: Add `POST /api/mac`, ensure data parses and merges correctly, and check that staleness transitions automatically.
* **Verification Method**:
  1. **Start Server**: Run `npm run dev` to start `server.js` at port `3838`.
  2. **Valid Payload Ingestion**: Send a correct request.
     ```bash
     curl -i -X POST http://127.0.0.1:3838/api/mac \
       -H "Content-Type: application/json" \
       -d '{"timestamp":1720980000000,"current":{"cpu":50.5,"memory":{"used":8,"total":16,"percent":50},"network":{"down":100,"up":30},"temperature":null,"battery":null},"history":{"cpu":[]}}'
     ```
     Verify that the server returns `200 OK` / `{"ok":true}`.
  3. **Invalid Input Guard**: Send an out-of-bounds CPU metric.
     ```bash
     curl -i -X POST http://127.0.0.1:3838/api/mac \
       -H "Content-Type: application/json" \
       -d '{"timestamp":1720980000000,"current":{"cpu":-5,"memory":{"used":8,"total":16,"percent":50},"network":{"down":100,"up":30},"temperature":null},"history":{}}'
     ```
     Verify that the server returns `400 Bad Request` and does not update Firebase.
  4. **Staleness Logic Test**: Post a valid payload. Verify that `online` is `true`. Wait 10.5 seconds, then query Firebase or request the diagnostics endpoint. Verify the server-published `online` flag has flipped to `false`.

### Step 3: Library Choice & Sampling Cadence (Tickets #5 & #12)
* **Objective**: Ensure the local daemon gathers correct statistics and buffers exactly 60 samples.
* **Verification Method**:
  1. **Run Local Daemon**: Run `node mac/mac-monitor.js` manually.
  2. **Audit Logs**: Add verbose local console logging to output data every tick:
     ```javascript
     console.log(`[DAEMON] CPU: ${metrics.cpu}%, Mem: ${metrics.memory.percent}%, Net: D=${metrics.network.down} U=${metrics.network.up}, Temp: ${metrics.temperature}`);
     ```
  3. **Verify Ring Buffer Size**: Inspect the log payload to confirm history lists grow step-by-step up to exactly 60 entries and then stay capped at 60.
  4. **Post to Staging Endpoint**: Verify that it sends a POST request every 2s and receives `200 OK` from our running server.

### Step 4: Daemon launchd Configuration (Ticket #11)
* **Objective**: Verify plist auto-starts and runs daemon in background.
* **Verification Method**:
  1. **Load configuration**:
     ```bash
     launchctl load -w ~/Library/LaunchAgents/com.ai-token-monitor.mac.plist
     ```
  2. **Verify Process status**:
     ```bash
     launchctl list | grep ai-token-monitor.mac
     ```
     Ensure status code is `0` (running) or has a stable PID.
  3. **Monitor logs**:
     ```bash
     tail -n 20 ~/Library/Logs/ai-token-monitor.mac.log
     tail -n 20 ~/Library/Logs/ai-token-monitor.mac.error.log
     ```
     Check for runtime module pathing problems or permissions errors.

### Step 5: ESP32 Parsing (Ticket #8)
* **Objective**: Parse the JSON array of structures on the ESP32 memory footprint.
* **Verification Method**:
  Compile the ESP32 code with serial debugging outputs:
  ```cpp
  Serial.printf("[TEST] Mac parsed online: %s, CPU: %.1f\n", 
                macData.online ? "true" : "false", macData.cpu.current);
  Serial.printf("[TEST] History elements read: cpu_len=%d, mem_len=%d\n",
                macData.cpu.historyLen, macData.memory.historyLen);
  ```
  Ensure history loops run without triggering a heap overflow or stack crash on the ESP32.

### Step 6: ESP32 Swipe Gesture Navigation (Ticket #9)
* **Objective**: Check if swipes register reliably without being blocked by UI renders or loops.
* **Verification Method**:
  Add serial logs to the touch swipe logic block:
  ```cpp
  if (abs(dx) > 80 && abs(dx) > abs(dy) * 2) {
    Serial.printf("[TEST-TOUCH] Swipe Registered! DX: %d, DY: %d. Transition state: %d -> %d\n",
                  dx, dy, prevDisplayState, displayState);
  }
  ```
  Test horizontal swipes across the screen and verify the transition prints correctly to the serial monitor.

### Step 7: ESP32 UI Rendering (Ticket #10)
* **Objective**: Confirm sparklines, battery elements, and labels draw correctly.
* **Verification Method**:
  1. **Offline Screen**: Terminate the Mac daemon. Wait 10 seconds. Verify the display updates to show the "Mac Offline" splash screen.
  2. **Online Screen**: Start the Mac daemon. Verify the metric rows render immediately with values.
  3. **Scale/MinMax Visuals**: Inject history arrays containing values ranging from very small to very large (e.g. CPU 1% to 99%). Verify the sparkline draws lines connecting points and maps coordinates inside its row boundary (between `y + 20` and `y + 50`).
  4. **Battery Icon**: Test a state where battery exists, and then a state where it is `null`. Verify the battery icon and percentage text are only drawn when battery stats are available.
