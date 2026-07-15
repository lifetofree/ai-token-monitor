# Handoff Report: Mac System Monitor Dependency & Verification Analysis

## 1. Observation
I have analyzed the current codebase, implementation guides, and research files:

1. **Firebase Path and Schema Transition**:
   - In `docs/new-feature.md` at lines 305–306:
     > `305: /display/snapshot.json (changed from /display/quotas.json to accommodate merged data)`
   - In `firmware/esp32-display/esp32-display.ino` at line 1205, the existing codebase expects the old endpoint:
     > `1205: String url = String("https://") + FIREBASE_HOST + "/display/quotas.json?auth=" + FIREBASE_AUTH;`
   - In `lib/firebase.js` at line 161, the server currently writes to the base `display.json` path:
     > `161: const firebaseUrl = \`\${dbUrl.replace(/\\/$/, '')}/display.json?auth=\${encodeURIComponent(secret)}\`;`

2. **Metrics Library Tradeoffs (Ticket #5)**:
   - In `docs/research/mac-metrics-library-choice.md` at lines 101–102:
     > `101: Conclusion for (b): systeminformation would be a real new runtime dependency (not already present), and for 4 of 5 metrics it buys convenience/parsing only — the underlying macOS calls are identical child_process invocations to option (c).`
   - In the same research file at lines 152–153, the permission issue for CPU temperature collection is documented:
     > `152: $ powermetrics -n 1 -i 1000`
     > `153: powermetrics must be invoked as the superuser`
   - The final recommendation in the research file at lines 258–261 states:
     > `258: Bottom line: stay dependency-free. Use child_process calls to top -l 1, vm_stat + sysctl vm.memory_pressure, netstat -ib (diffed across samples), and pmset -g batt for CPU, memory (+ pressure), network, and battery respectively. Do not add systeminformation or any other runtime dependency. Mark CPU temperature as unavailable (null) in the JSON payload...`

3. **Server Endpoint Requirements (Ticket #7)**:
   - In `docs/new-feature.md` at lines 242–245:
     > `242: app.post('/api/mac', async (req, res) => {`
     > `243:   try {`
     > `244:     const { timestamp, current, history } = req.body;`
   - And the validation rules at lines 251–252:
     > `251:     if (typeof current.cpu !== 'number' || current.cpu < 0 || current.cpu > 100) {`
     > `252:       return res.status(400).json({ error: 'Invalid CPU value' });`

4. **ESP32 Navigation & State Machine (Ticket #9 & #10)**:
   - In `docs/new-feature.md` at lines 523–525:
     > `523: enum DisplayState { STATE_OVERVIEW, STATE_MAC, STATE_SETTINGS };`
   - And the touch/swipe recognition threshold at line 551:
     > `551:       if (abs(dx) > 80 && abs(dx) > abs(dy) * 2) {`

---

## 2. Logic Chain

Based on these observations, the implementation must proceed in the following order:

1. **Step 1: Firebase Schema definition (Ticket #6)** must be established first because it defines the payload shape of `/display/snapshot.json`, forming the shared API contract for the backend (Ticket #7) and the ESP32 firmware (Ticket #8). (Based on Obs #1)
2. **Step 2: Server API endpoint development (Ticket #7)** must occur next. Once the schema is defined, we can build the `POST /api/mac` route and the merge logic. Since this runs on the server, we can verify it immediately in isolation using `curl` requests without needing any hardware or client-side daemons. (Based on Obs #3)
3. **Step 3: Metrics library choice (Ticket #5) and Sampling loop/buffering (Ticket #12)** must follow. The daemon uses shell commands (`child_process`) to populate the ring buffers (up to 60 items) and formats the JSON payload. We test the script manually by running it and checking that it logs metrics and successfully POSTs data to the verified endpoint from Step 2. (Based on Obs #2)
4. **Step 4: Daemon launchd agent installation (Ticket #11)** can only occur after the daemon script is stable and verified. This step registers it as a background service.
5. **Step 5: ESP32 REST fetch & JSON parse prototype (Ticket #8)** should be the first client-side task. By decoupling JSON parser verification (inspecting parsed variables via serial `Serial.printf`) from screen layout, we prevent crash loops caused by bad JSON parsing or memory leaks on the microcontroller. (Based on Obs #1)
6. **Step 6: ESP32 Touch swipe navigation (Ticket #9)** is implemented to support state transitions. (Based on Obs #4)
7. **Step 7: ESP32 UI Renderer (Ticket #10)** is implemented last. It uses the variables parsed in Step 5 and is accessed using the gesture in Step 6 to display rows, draw sparklines, and show the "Mac Offline" splash screen if no updates arrive within 10s. (Based on Obs #4)

This sequence satisfies the testing-first priority, validating data contracts on mock nodes and testing local APIs before flashing hardware or installing launchd agents.

---

## 3. Caveats
- **CPU Temperature**: If the project decides to show a real temperature on macOS, it must introduce a compiled C-based helper or run the daemon with `sudo` privileges. The current recommendation defaults to `null` to comply with the "no native compilation" and "no sudo" constraints.
- **Undocumented macOS APIs**: Using `sysctl vm.memory_pressure` for memory pressure is a proxy and is not guaranteed to remain stable across future macOS releases.
- **Hardware constraints**: This analysis assumes standard ESP32 JC3248W535C touch panel drivers are already fully functional.

---

## 4. Conclusion
We recommend implementing the Mac System Monitor feature in a strict bottom-up sequence:
1. **Schema & API Contract** (Ticket #6)
2. **Backend Server Endpoint & Staleness Logic** (Ticket #7)
3. **Daemon Core Script & Loop** (Ticket #5, Ticket #12)
4. **Daemon Launch Agent Service** (Ticket #11)
5. **ESP32 Data Fetch & Ingestion Parser** (Ticket #8)
6. **ESP32 Navigation Routing** (Ticket #9)
7. **ESP32 Rendering & Sparkline Drawing** (Ticket #10)

This sequence facilitates continuous integration and verification without relying on physical hardware availability for early milestones.

---

## 5. Verification Method

To verify the accuracy of this dependency layout and implementation plan:

1. **Verify Backend Contracts (Simulated)**:
   - Start the local server: `npm run dev` (running at `http://127.0.0.1:3838`).
   - Mock a valid metrics report from the daemon using `curl`:
     ```bash
     curl -i -X POST http://127.0.0.1:3838/api/mac \
       -H "Content-Type: application/json" \
       -d '{"timestamp":1720980000000,"current":{"cpu":25.3,"memory":{"used":8,"total":16,"percent":50},"network":{"down":500,"up":100},"temperature":null,"battery":{"percent":90,"charging":false}},"history":{"cpu":[]}}'
     ```
   - Ensure the server returns `200 OK` and correctly merges the payload into Firebase.
   - Test validation handling by sending `{"cpu": 150}` or sending an empty payload. Confirm the server responds with `400 Bad Request`.
2. **Verify Process Execution**:
   - Run syntax and lint checks: `npm run check`.
   - Run the vitest test suite: `npm test` to verify no regressions occur in existing endpoints.
3. **Invalidation Conditions**:
   - The sequence is invalidated if the ESP32's available heap memory is too small to handle the 60-sample JSON histories (about 15KB per payload). If so, the history limit (currently 60) must be reduced, or parsing must be optimized to parse on-the-fly instead of keeping the full DOM tree in memory.
