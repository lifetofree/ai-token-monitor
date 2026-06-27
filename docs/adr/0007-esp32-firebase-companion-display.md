# ESP32 Firebase Companion Display

Add a hardware companion: an ESP32 + ST7789 240×280 color TFT that mirrors the dashboard's per-Brand quota/spend state, fed via a Firebase Realtime Database `display.json` node that the server writes after each quota refresh.

## Status

Accepted, **applied**. `lib/firebase.js` (`publishToFirebase`) runs after every `seedBrandQuotas()` pass and on each new SSE-broadcast command (debounced). The firmware lives in `firmware/esp32-display/esp32-display.ino`. Enabled only when `FIREBASE_URL` (or `FIREBASE_DB_URL`) and `FIREBASE_AUTH` (or `FIREBASE_DB_SECRET`) are present in `.env`; otherwise the publish path is a silent no-op and the dashboard is unaffected.

## Context

The dashboard's single user wanted a glanceable, always-on physical display of "am I about to hit a cap?" without keeping a browser tab foregrounded. The web dashboard already computes the per-Brand spend percentages and provider-quota used-%; the missing piece was a delivery channel to a low-power device on the desk.

Options considered:

1. **ESP32 polls the dashboard's HTTP API directly.** Rejected: would require exposing the server beyond loopback (violates the `127.0.0.1` bind posture in `TECH_STACK.md` §4.4) or running a separate inbound port with auth. Either erodes the "loopback-only" security baseline for a convenience feature.
2. **ESP32 reads a Firebase RTDB node the server writes.** Accepted. Firebase is the trust boundary's egress: the server makes one outbound `PUT` to a hosted database; the ESP32 reads the same node over its own WiFi. The dashboard never opens an inbound port for the device, and the secret (`FIREBASE_AUTH`) never needs to leave `.env` on the server side beyond the outbound call.

## Decision

Add a **write-only Firebase mirror**:

- **Server → Firebase**: `lib/firebase.js` builds a payload of `{ lastUpdated, quotas: { <brand>: { remaining, limit_value, weekly_remaining, unit, reset_at (seconds), reset_at_weekly (seconds), spend_pct5h, spend_pct_weekly, spend_reqs5h, spend_reqs_wk, tokens5h, cost5h, tokens_wk, cost_wk, … } } }` and `PUT`s it to `<FIREBASE_URL>/display.json?auth=<FIREBASE_AUTH>` using the global `fetch` with an 8s `AbortSignal.timeout`.
- **Firebase → ESP32**: the firmware (`firmware/esp32-display/esp32-display.ino`) joins WiFi with `WIFI_SSID`/`WIFI_PASS`, polls the `display` node on an interval, and renders one brand per page on the ST7789 240×280 TFT.
- **Trigger points**: (a) after every `seedBrandQuotas()` pass (the periodic 30s quota tick and force-refresh), and (b) on each new SSE-broadcast command via `triggerFirebaseUpdate()` (500ms debounce).
- **Unit handling**: reset timestamps are divided ms→s in `lib/firebase.js` because the firmware uses `time(nullptr)` (seconds). Claude's per-minute Anthropic reset is overridden with the RTK rolling-window boundary so the OLED shows the same 5h/weekly times as the web. Gemini merges in `agent_usage` table totals (the Gemini "Antigravity" CLI path) since Gemini has no provider quota API.

**Out of scope**:
- Bidirectional control (the ESP32 never writes back). The mirror is append-only output.
- A second display protocol (e.g. MQTT, WebSocket). Firebase RTDB is the single channel.
- Encryption of the `display.json` payload beyond Firebase's HTTPS transport and the `auth` query secret.

## Consequences

- **One new outbound dependency**: Firebase RTDB. If Firebase is down or the secret is wrong, `publishToFirebase` logs `[firebase] PUT <status>` and returns; the dashboard is otherwise unaffected (failures are `.catch`-handled at every call site and never block the response cycle).
- **One new secret class in `.env`**: `FIREBASE_URL` / `FIREBASE_AUTH` (plus `WIFI_SSID` / `WIFI_PASS`, used only by the firmware via `secrets.h`). These are non-whitelisted keys: the env writers preserve them across write cycles (see `0007` ↔ R3 resolution), and `GET /api/env` never serialises them to the browser.
- **Firmware is a separate build artefact**: flashed via the Arduino IDE, not part of the Node test suite. `firmware/esp32-display/secrets.h` is gitignored; the user copies from `secrets.txt`.

## Relationships

- Builds on `0006` (Real RTK Monitor) for the `triggerFirebaseUpdate` hook on new commands.
- Relies on the resolved env-var-loss fix (R3) so `FIREBASE_*` keys survive `.env` writes.
- Adds the first **non-browser, non-loopback** consumer of the dashboard's state.
