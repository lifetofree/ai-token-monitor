# Mac System Monitor Feature - Complete Implementation Guide

## Destination

The ESP32 JC3248W535C companion display shows a **third page** (alongside the 4 AI brand cards) with real-time Mac system stats: CPU, memory, network bandwidth, CPU temperature, and battery percentage. Each metric is a row with current value + 60-sample sparkline, refreshed every 2 seconds, sourced from a Mac daemon that posts to the existing server, which merges with the quota snapshot and publishes to Firebase RTDB. The web dashboard gains a Mac tab consuming the same data.

---

## Architecture & Data Flow

```
Mac (mac-monitor.js)
  ↓ POST /api/mac (every 2s)
Server (server.js)
  ↓ merge with quota snapshot
  ↓ publish to Firebase
Firebase RTDB (/display/snapshot.json)
  ↓
  ├─→ ESP32 (polls every 2s, renders Mac page)
  └─→ Web Dashboard (SSE stream, renders Mac tab)
```

**Key decisions:**
- Mac daemon owns the 60-sample ring buffer
- Server merges Mac + quota data into single snapshot
- ESP32 detects "Mac offline" via stale timestamp (>10s old)
- Hand-rolled sparkline rendering (no graph library)
- Swipe gesture for page navigation (horizontal swipe >80px)
- launchd plist for auto-start (sibling to existing com.ai-token-monitor.plist)

---

## 1. Mac Daemon (`mac/mac-monitor.js`)

### 1.1 Metrics Collection

Use the `systeminformation` npm package (already in package.json) for cross-platform system metrics:

```javascript
const si = require('systeminformation');

async function collectMetrics() {
  const [cpu, mem, net, temp, battery] = await Promise.all([
    si.currentLoad(),           // {currentLoad: 45.2}
    si.mem(),                   // {total, used, free, active, available}
    si.networkStats(),          // [{iface, rx_sec, tx_sec}]
    si.cpuTemperature(),        // {main, cores[], max}
    si.battery()                // {hasBattery, percent, isCharging}
  ]);
  
  return {
    cpu: Math.round(cpu.currentLoad * 10) / 10,  // 0-100, 1 decimal
    memory: {
      used: Math.round(mem.used / 1024 / 1024),  // GB
      total: Math.round(mem.total / 1024 / 1024), // GB
      percent: Math.round((mem.used / mem.total) * 100)
    },
    network: {
      down: Math.round(net[0]?.rx_sec / 1024) || 0,  // KB/s
      up: Math.round(net[0]?.tx_sec / 1024) || 0      // KB/s
    },
    temperature: Math.round(temp.main) || 0,  // Celsius
    battery: battery.hasBattery ? {
      percent: Math.round(battery.percent),
      charging: battery.isCharging
    } : null
  };
}
```

### 1.2 Ring Buffer

Maintain a 60-sample history in memory:

```javascript
class RingBuffer {
  constructor(size = 60) {
    this.size = size;
    this.buffer = [];
  }
  
  push(sample) {
    this.buffer.push(sample);
    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }
  }
  
  getHistory() {
    return this.buffer;
  }
  
  getCurrent() {
    return this.buffer[this.buffer.length - 1];
  }
}

const cpuHistory = new RingBuffer(60);
const memHistory = new RingBuffer(60);
const netDownHistory = new RingBuffer(60);
const netUpHistory = new RingBuffer(60);
const tempHistory = new RingBuffer(60);
const batteryHistory = new RingBuffer(60);
```

### 1.3 Sampling Loop

```javascript
const SAMPLE_INTERVAL = 2000;  // 2 seconds

async function sampleLoop() {
  while (true) {
    try {
      const metrics = await collectMetrics();
      const timestamp = Date.now();
      
      cpuHistory.push({ t: timestamp, v: metrics.cpu });
      memHistory.push({ t: timestamp, v: metrics.memory.percent });
      netDownHistory.push({ t: timestamp, v: metrics.network.down });
      netUpHistory.push({ t: timestamp, v: metrics.network.up });
      tempHistory.push({ t: timestamp, v: metrics.temperature });
      if (metrics.battery) {
        batteryHistory.push({ t: timestamp, v: metrics.battery.percent });
      }
      
      await postToServer({
        timestamp,
        current: metrics,
        history: {
          cpu: cpuHistory.getHistory(),
          memory: memHistory.getHistory(),
          network_down: netDownHistory.getHistory(),
          network_up: netUpHistory.getHistory(),
          temperature: tempHistory.getHistory(),
          battery: batteryHistory.getHistory()
        }
      });
    } catch (err) {
      console.error('Sample error:', err);
    }
    
    await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL));
  }
}
```

### 1.4 POST to Server

```javascript
const SERVER_URL = 'http://127.0.0.1:3838/api/mac';

async function postToServer(payload) {
  try {
    const res = await fetch(SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    
    if (!res.ok) {
      console.error('POST failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('POST error:', err.message);
  }
}
```

### 1.5 Entry Point

```javascript
console.log('Mac monitor daemon starting...');
sampleLoop().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

### 1.6 launchd Plist

Create `~/Library/LaunchAgents/com.ai-token-monitor.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-token-monitor.mac</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/lifetofree/Documents/Projects/ai-token-monitor/mac/mac-monitor.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/lifetofree/Documents/Projects/ai-token-monitor</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/Users/lifetofree/Library/Logs/ai-token-monitor.mac.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/lifetofree/Library/Logs/ai-token-monitor.mac.error.log</string>
</dict>
</plist>
```

**Install:**
```bash
launchctl load -w ~/Library/LaunchAgents/com.ai-token-monitor.mac.plist
launchctl list | grep ai-token-monitor  # verify
```

**Uninstall:**
```bash
launchctl unload -w ~/Library/LaunchAgents/com.ai-token-monitor.mac.plist
```

---

## 2. Server Changes (`server.js`)

### 2.1 New Endpoint: `POST /api/mac`

```javascript
// Global state
let macData = null;  // { timestamp, current, history }
let lastMacUpdate = 0;

app.post('/api/mac', async (req, res) => {
  try {
    const { timestamp, current, history } = req.body;
    
    // Validate
    if (!timestamp || !current || !history) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (typeof current.cpu !== 'number' || current.cpu < 0 || current.cpu > 100) {
      return res.status(400).json({ error: 'Invalid CPU value' });
    }
    
    // Store
    macData = { timestamp, current, history };
    lastMacUpdate = Date.now();
    
    // Trigger merge + publish
    await publishSnapshot();
    
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/mac error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

### 2.2 Merge Logic

Modify `publishSnapshot()` to include Mac data:

```javascript
async function publishSnapshot() {
  try {
    const quotaSnapshot = await buildQuotaSnapshot();  // existing logic
    
    const merged = {
      ...quotaSnapshot,
      mac: macData ? {
        last_seen: lastMacUpdate,
        online: (Date.now() - lastMacUpdate) < 10000,  // 10s threshold
        ...macData
      } : null
    };
    
    await firebasePublish('/display/snapshot.json', merged);
  } catch (err) {
    console.error('Snapshot publish error:', err);
  }
}
```

### 2.3 Staleness Check

The server marks Mac as offline if `lastMacUpdate` is >10s old. The ESP32 also checks the `online` flag and `last_seen` timestamp.

---

## 3. Firebase Schema

### 3.1 Path

`/display/snapshot.json` (changed from `/display/quotas.json` to accommodate merged data)

### 3.2 Structure

```json
{
  "gemini": {
    "name": "Gemini",
    "remaining": 85,
    "limit_value": 100,
    "weekly_remaining": 70,
    "reset_at": 1720987200,
    "reset_at_weekly": 1721246400,
    "spend_pct5h": 15,
    "spend_pct_weekly": 30,
    "tokens5h": 150000,
    "tokens_wk": 300000,
    "unit": "percent"
  },
  "claude": { ... },
  "minimax": { ... },
  "glm": { ... },
  "mac": {
    "last_seen": 1720980000000,
    "online": true,
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
      "cpu": [
        { "t": 1720979940000, "v": 42.1 },
        { "t": 1720979942000, "v": 43.5 },
        ...
      ],
      "memory": [
        { "t": 1720979940000, "v": 74 },
        { "t": 1720979942000, "v": 75 },
        ...
      ],
      "network_down": [
        { "t": 1720979940000, "v": 115 },
        { "t": 1720979942000, "v": 120 },
        ...
      ],
      "network_up": [
        { "t": 1720979940000, "v": 42 },
        { "t": 1720979942000, "v": 45 },
        ...
      ],
      "temperature": [
        { "t": 1720979940000, "v": 64 },
        { "t": 1720979942000, "v": 65 },
        ...
      ],
      "battery": [
        { "t": 1720979940000, "v": 84 },
        { "t": 1720979942000, "v": 85 },
        ...
      ]
    }
  }
}
```

### 3.3 Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `mac.last_seen` | int64 | Unix timestamp (ms) of last successful POST |
| `mac.online` | bool | true if last_seen < 10s ago |
| `mac.current.cpu` | float | CPU usage 0-100% |
| `mac.current.memory.used` | int | Used RAM in GB |
| `mac.current.memory.total` | int | Total RAM in GB |
| `mac.current.memory.percent` | int | Memory usage 0-100% |
| `mac.current.network.down` | int | Download speed KB/s |
| `mac.current.network.up` | int | Upload speed KB/s |
| `mac.current.temperature` | int | CPU temp in Celsius |
| `mac.current.battery.percent` | int/null | Battery 0-100% (null if desktop) |
| `mac.current.battery.charging` | bool/null | true if charging (null if desktop) |
| `mac.history.*` | array | 60 samples of `{t: timestamp, v: value}` |

---

## 4. ESP32 Implementation

### 4.1 Data Structures

Add to `esp32-display.ino`:

```cpp
struct MacSample {
  long long timestamp;
  float value;
};

struct MacMetric {
  String name;
  String unit;
  float current;
  MacSample history[60];
  int historyLen;
  uint16_t color;
};

struct MacData {
  bool online;
  long long last_seen;
  MacMetric cpu;
  MacMetric memory;
  MacMetric network_down;
  MacMetric network_up;
  MacMetric temperature;
  MacMetric battery;
};

MacData macData;
bool macDataFetched = false;
```

### 4.2 Fetch Function

```cpp
void fetchMacData() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  
  String url = String("https://") + FIREBASE_HOST + "/display/snapshot.json/mac?auth=" + FIREBASE_AUTH;
  http.begin(client, url);
  http.setTimeout(5000);
  
  int httpCode = http.GET();
  if (httpCode != 200) {
    Serial.printf("[MAC] HTTP %d\n", httpCode);
    http.end();
    return;
  }
  
  String body = http.getString();
  http.end();
  
  FirebaseJson json;
  if (!json.setJsonData(body)) {
    Serial.println("[MAC] Parse failed");
    return;
  }
  
  FirebaseJsonData data;
  
  // Parse online status
  if (json.get(data, "online")) {
    macData.online = data.boolValue;
  }
  if (json.get(data, "last_seen")) {
    macData.last_seen = data.intValue;
  }
  
  // Parse current values
  if (json.get(data, "current/cpu")) macData.cpu.current = data.doubleValue;
  if (json.get(data, "current/memory/percent")) macData.memory.current = data.doubleValue;
  if (json.get(data, "current/network/down")) macData.network_down.current = data.doubleValue;
  if (json.get(data, "current/network/up")) macData.network_up.current = data.doubleValue;
  if (json.get(data, "current/temperature")) macData.temperature.current = data.doubleValue;
  if (json.get(data, "current/battery/percent")) macData.battery.current = data.doubleValue;
  
  // Parse history arrays
  parseHistoryArray(json, "history/cpu", macData.cpu);
  parseHistoryArray(json, "history/memory", macData.memory);
  parseHistoryArray(json, "history/network_down", macData.network_down);
  parseHistoryArray(json, "history/network_up", macData.network_up);
  parseHistoryArray(json, "history/temperature", macData.temperature);
  parseHistoryArray(json, "history/battery", macData.battery);
  
  macDataFetched = true;
  Serial.println("[MAC] Data updated");
}

void parseHistoryArray(FirebaseJson &json, const char* path, MacMetric &metric) {
  FirebaseJsonArray arr;
  if (json.get(arr, path)) {
    metric.historyLen = min((size_t)60, arr.size());
    for (int i = 0; i < metric.historyLen; i++) {
      FirebaseJsonData sample;
      if (arr.get(sample, i)) {
        FirebaseJsonData t, v;
        FirebaseJson sampleJson;
        sampleJson.setJsonData(sample.stringValue);
        if (sampleJson.get(t, "t") && sampleJson.get(v, "v")) {
          metric.history[i].timestamp = t.intValue;
          metric.history[i].value = v.doubleValue;
        }
      }
    }
  }
}
```

### 4.3 Page Navigation

Add to the display state enum:

```cpp
enum DisplayState { STATE_OVERVIEW, STATE_MAC, STATE_SETTINGS };
```

Update `handleTouch()` to detect horizontal swipe:

```cpp
void handleTouch() {
  uint16_t tx, ty;
  bool touching = axs_touch_read(&tx, &ty);
  unsigned long now = millis();
  
  if (touching) {
    if (!touchActive) {
      touchActive = true;
      touchStartTime = now;
      touchStartX = tx;
      touchStartY = ty;
      touchLongFired = false;
    }
  } else if (touchActive) {
    touchActive = false;
    
    if (dataFetched && (now - touchStartTime < LONG_PRESS_MS)) {
      int dx = tx - touchStartX;
      int dy = ty - touchStartY;
      
      // Detect horizontal swipe (>80px, mostly horizontal)
      if (abs(dx) > 80 && abs(dx) > abs(dy) * 2) {
        if (dx > 0) {
          // Swipe right: overview -> mac -> settings -> overview
          displayState = (DisplayState)((displayState + 1) % 3);
        } else {
          // Swipe left: reverse
          displayState = (DisplayState)((displayState + 2) % 3);
        }
        renderCurrent();
        return;
      }
      
      // Otherwise, treat as tap
      handleTap(touchStartX, touchStartY);
    }
  }
}
```

### 4.4 Mac Page Renderer

```cpp
void drawMacPage() {
  gfx->fillScreen(COLOR_DARK_BG);
  drawHeader();
  
  if (!macDataFetched || !macData.online) {
    // Show "Mac offline" message
    gfx->setTextSize(3);
    gfx->setTextColor(COLOR_TXT_MUTED);
    gfx->setCursor(120, 150);
    gfx->print("Mac Offline");
    
    gfx->setTextSize(1);
    gfx->setCursor(100, 200);
    gfx->print("Waiting for data...");
    
    drawFooter();
    gfx->flush();
    return;
  }
  
  // Draw 5 metric rows
  int rowHeight = 56;
  int startY = 50;
  
  drawMetricRow(startY + 0 * rowHeight, "CPU", macData.cpu, "%", COLOR_WHITE);
  drawMetricRow(startY + 1 * rowHeight, "MEM", macData.memory, "%", COLOR_WHITE);
  drawMetricRow(startY + 2 * rowHeight, "NET ↓", macData.network_down, "KB/s", COLOR_NET_OK);
  drawMetricRow(startY + 3 * rowHeight, "NET ↑", macData.network_up, "KB/s", COLOR_NET_OK);
  drawMetricRow(startY + 4 * rowHeight, "TEMP", macData.temperature, "°C", COLOR_WHITE);
  
  // Battery (conditional, smaller at bottom)
  if (macData.battery.current > 0) {
    drawBatteryIndicator(400, 280);
  }
  
  drawFooter();
  gfx->flush();
}

void drawMetricRow(int y, const char* label, const MacMetric& metric, const char* unit, uint16_t color) {
  int x = 10;
  int w = 460;
  
  // Label (left)
  gfx->setTextSize(2);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(x, y + 8);
  gfx->print(label);
  
  // Current value (right)
  gfx->setTextSize(3);
  gfx->setTextColor(color);
  char valueStr[16];
  if (metric.current >= 100) {
    sprintf(valueStr, "%.0f%s", metric.current, unit);
  } else {
    sprintf(valueStr, "%.1f%s", metric.current, unit);
  }
  int valueW = strlen(valueStr) * 18;
  gfx->setCursor(x + w - valueW, y + 4);
  gfx->print(valueStr);
  
  // Sparkline (middle)
  int sparkX = x + 80;
  int sparkW = w - 160;
  int sparkY = y + 20;
  int sparkH = 30;
  
  drawSparkline(sparkX, sparkY, sparkW, sparkH, metric, color);
}

void drawSparkline(int x, int y, int w, int h, const MacMetric& metric, uint16_t color) {
  if (metric.historyLen < 2) return;
  
  // Find min/max for scaling
  float minVal = metric.history[0].value;
  float maxVal = metric.history[0].value;
  for (int i = 1; i < metric.historyLen; i++) {
    if (metric.history[i].value < minVal) minVal = metric.history[i].value;
    if (metric.history[i].value > maxVal) maxVal = metric.history[i].value;
  }
  
  float range = maxVal - minVal;
  if (range < 1) range = 1;  // avoid division by zero
  
  // Draw line
  int prevX = x;
  int prevY = y + h - (int)((metric.history[0].value - minVal) / range * h);
  
  for (int i = 1; i < metric.historyLen; i++) {
    int currX = x + (i * w) / metric.historyLen;
    int currY = y + h - (int)((metric.history[i].value - minVal) / range * h);
    
    gfx->drawLine(prevX, prevY, currX, currY, color);
    
    prevX = currX;
    prevY = currY;
  }
}

void drawBatteryIndicator(int x, int y) {
  int percent = (int)macData.battery.current;
  
  // Battery icon
  gfx->drawRect(x, y, 40, 20, COLOR_WHITE);
  gfx->fillRect(x + 40, y + 6, 4, 8, COLOR_WHITE);
  
  // Fill based on percentage
  int fillW = (percent * 38) / 100;
  uint16_t fillColor = percent > 20 ? COLOR_NET_OK : COLOR_NET_FAIL;
  gfx->fillRect(x + 1, y + 1, fillW, 18, fillColor);
  
  // Percentage text
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_WHITE);
  gfx->setCursor(x + 50, y + 6);
  gfx->print(percent);
  gfx->print("%");
}
```

### 4.5 Update `renderCurrent()`

```cpp
void renderCurrent() {
  if (!dataFetched) {
    drawLoadingScreen();
    return;
  }
  
  switch (displayState) {
    case STATE_OVERVIEW:
      drawOverviewScreen();
      break;
    case STATE_MAC:
      drawMacPage();
      break;
    case STATE_SETTINGS:
      drawSettingsScreen();
      break;
  }
}
```

### 4.6 Update `loop()`

Add Mac data fetch:

```cpp
unsigned long lastMacFetch = 0;
const unsigned long MAC_FETCH_INTERVAL = 2000;  // 2 seconds

void loop() {
  unsigned long now = millis();
  
  handleTouch();
  
  // Fetch Mac data every 2s
  if (now - lastMacFetch >= MAC_FETCH_INTERVAL) {
    lastMacFetch = now;
    fetchMacData();
    if (displayState == STATE_MAC) {
      renderCurrent();
    }
  }
  
  // Existing quota fetch every 30s
  if (now - lastRefresh >= 30000) {
    lastRefresh = now;
    fetchTokensFromFirebase();
  }
  
  // Existing clock refresh
  if (now - lastClockRefresh >= CLOCK_REFRESH_MS) {
    lastClockRefresh = now;
    refreshClock();
    if (dataFetched && (clockText != prevClock || dateText != prevDate)) {
      renderCurrent();
    }
  }
}
```

---

## 5. Web Dashboard

### 5.1 New Tab

Add a "Mac" tab to the navigation bar in `index.html`:

```html
<nav class="tabs">
  <button class="tab active" data-tab="overview">Overview</button>
  <button class="tab" data-tab="mac">Mac</button>
  <button class="tab" data-tab="settings">Settings</button>
</nav>
```

### 5.2 Mac Tab Content

Add to `app.js`:

```javascript
function renderMacTab() {
  const container = document.getElementById('mac-tab-content');
  
  if (!state.macData || !state.macData.online) {
    container.innerHTML = '<div class="mac-offline">Mac Offline - Waiting for data...</div>';
    return;
  }
  
  const metrics = [
    { label: 'CPU', value: state.macData.current.cpu, unit: '%', history: state.macData.history.cpu },
    { label: 'Memory', value: state.macData.current.memory.percent, unit: '%', history: state.macData.history.memory },
    { label: 'Network ↓', value: state.macData.current.network.down, unit: 'KB/s', history: state.macData.history.network_down },
    { label: 'Network ↑', value: state.macData.current.network.up, unit: 'KB/s', history: state.macData.history.network_up },
    { label: 'Temperature', value: state.macData.current.temperature, unit: '°C', history: state.macData.history.temperature }
  ];
  
  let html = '<div class="mac-metrics">';
  metrics.forEach(m => {
    html += `
      <div class="mac-metric">
        <div class="mac-metric-label">${m.label}</div>
        <div class="mac-metric-value">${m.value}${m.unit}</div>
        <canvas class="mac-sparkline" data-history='${JSON.stringify(m.history)}'></canvas>
      </div>
    `;
  });
  html += '</div>';
  
  if (state.macData.current.battery) {
    html += `
      <div class="mac-battery">
        <span>Battery: ${state.macData.current.battery.percent}%</span>
        ${state.macData.current.battery.charging ? '⚡ Charging' : ''}
      </div>
    `;
  }
  
  container.innerHTML = html;
  
  // Render sparklines
  container.querySelectorAll('.mac-sparkline').forEach(canvas => {
    const history = JSON.parse(canvas.dataset.history);
    renderSparkline(canvas, history);
  });
}

function renderSparkline(canvas, history) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width = 300;
  const height = canvas.height = 60;
  
  if (history.length < 2) return;
  
  const values = history.map(h => h.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 2;
  ctx.beginPath();
  
  history.forEach((sample, i) => {
    const x = (i / (history.length - 1)) * width;
    const y = height - ((sample.v - min) / range) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.stroke();
}
```

### 5.3 SSE Integration

Update the SSE handler in `app.js` to process Mac data:

```javascript
function handleSSEMessage(data) {
  if (data.mac) {
    state.macData = data.mac;
    if (state.activeTab === 'mac') {
      renderMacTab();
    }
  }
  
  // Existing quota handling
  if (data.gemini || data.claude || data.minimax || data.glm) {
    updateQuotaCards(data);
  }
}
```

---

## 6. Testing

### 6.1 Mac Daemon

```bash
# Test metrics collection
node -e "require('./mac/mac-monitor.js').collectMetrics().then(console.log)"

# Test POST to server
curl -X POST http://127.0.0.1:3838/api/mac \
  -H "Content-Type: application/json" \
  -d '{"timestamp":1720980000000,"current":{"cpu":50,"memory":{"percent":75},"network":{"down":100,"up":50},"temperature":60,"battery":{"percent":80,"charging":true}},"history":{}}'
```

### 6.2 Server

```bash
# Verify endpoint
curl http://127.0.0.1:3838/api/mac -X POST -H "Content-Type: application/json" -d '{}'
# Expected: 400 Bad Request

# Check Firebase
curl https://token-count-973cd-default-rtdb.asia-southeast1.firebasedatabase.app/display/snapshot.json/mac
```

### 6.3 ESP32

- Flash firmware with new code
- Verify Mac page appears after swipe
- Check sparklines update every 2s
- Test "Mac offline" state (stop daemon)

### 6.4 Web Dashboard

- Open browser, click Mac tab
- Verify sparklines render
- Check real-time updates via SSE

---

## 7. Deployment Checklist

- [ ] Create `mac/mac-monitor.js`
- [ ] Add `POST /api/mac` endpoint to `server.js`
- [ ] Update `publishSnapshot()` to merge Mac data
- [ ] Create launchd plist at `~/Library/LaunchAgents/com.ai-token-monitor.mac.plist`
- [ ] Load plist: `launchctl load -w ~/Library/LaunchAgents/com.ai-token-monitor.mac.plist`
- [ ] Verify daemon running: `launchctl list | grep ai-token-monitor`
- [ ] Update ESP32 firmware with Mac page code
- [ ] Flash ESP32
- [ ] Test swipe navigation
- [ ] Add Mac tab to web dashboard
- [ ] Test real-time updates
- [ ] Monitor logs: `tail -f ~/Library/Logs/ai-token-monitor.mac.log`

---

## 8. Troubleshooting

**Daemon not starting:**
```bash
# Check plist syntax
plutil -lint ~/Library/LaunchAgents/com.ai-token-monitor.mac.plist

# Check logs
tail -f ~/Library/Logs/ai-token-monitor.mac.error.log

# Restart
launchctl unload -w ~/Library/LaunchAgents/com.ai-token-monitor.mac.plist
launchctl load -w ~/Library/LaunchAgents/com.ai-token-monitor.mac.plist
```

**ESP32 shows "Mac Offline":**
- Verify daemon is running
- Check server logs for POST errors
- Verify Firebase path: `/display/snapshot.json/mac`
- Check `last_seen` timestamp is recent

**Web dashboard not updating:**
- Check SSE connection
- Verify `state.macData` is populated
- Check browser console for errors

---

## 9. Future Enhancements

- Per-core CPU usage (10 bars instead of 1)
- Disk I/O metrics
- Process list (top 5 by CPU)
- Historical graphs (hourly/daily)
- Alert thresholds (CPU > 90%, memory > 95%)
- Remote Mac monitoring (multiple machines)

---

## 10. Related Issues

- [Wayfinder Map #4](https://github.com/lifetofree/ai-token-monitor/issues/4)
- [Ticket #5](https://github.com/lifetofree/ai-token-monitor/issues/5) - Library choice
- [Ticket #6](https://github.com/lifetofree/ai-token-monitor/issues/6) - Firebase schema
- [Ticket #7](https://github.com/lifetofree/ai-token-monitor/issues/7) - Server endpoint
- [Ticket #8](https://github.com/lifetofree/ai-token-monitor/issues/8) - ESP32 prototype
- [Ticket #9](https://github.com/lifetofree/ai-token-monitor/issues/9) - Swipe gesture
- [Ticket #10](https://github.com/lifetofree/ai-token-monitor/issues/10) - Render signature
- [Ticket #11](https://github.com/lifetofree/ai-token-monitor/issues/11) - launchd plist
- [Ticket #12](https://github.com/lifetofree/ai-token-monitor/issues/12) - Sampling cadence
