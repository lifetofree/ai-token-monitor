// =====================================================================
// AI Token Monitor — ESP32-2432S028R firmware (ILI9341 320×240, SPI)
//
// Board pin map (ESP32-2432S028R — "yellow" 2.8" PCB):
//   TFT_MOSI  = 13    TFT_CLK = 14    TFT_CS = 15
//   TFT_DC    = 2     TFT_RST = -1    TFT_BL = 32 (active HIGH)
//
// Display: ILI9341 native 240×320, rotated to landscape 320×240.
// Data source: Firebase Realtime DB  /display/quotas.json
//              (same payload the web dashboard publishes every 30s)
//
// Auto-rotates through all 4 AI brands every 5s.
// Set USE_TOUCH 1 to enable XPT2046 tap-to-pin-brand.
// =====================================================================

#include <WiFi.h>
#include <SPI.h>
#include <Arduino_GFX_Library.h>
#include <FirebaseESP32.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <stdlib.h>

#define USE_TOUCH 0   // 1 = enable XPT2046 resistive touch

#include "secrets.h"  // WIFI_SSID, WIFI_PASS, FIREBASE_HOST, FIREBASE_AUTH
#ifndef WIFI_PASSWORD
  #define WIFI_PASSWORD WIFI_PASS
#endif

// ─── Pin config ────────────────────────────────────────────────────────────────
#define TFT_MOSI  13
#define TFT_CLK   14
#define TFT_CS    15
#define TFT_DC    2
#define TFT_RST   -1   // tied to ESP32 EN
#define TFT_BL    32   // active HIGH on yellow PCB

#if USE_TOUCH
#define T_IRQ   27
#define T_MOSI  32
#define T_MISO  39
#define T_CLK   25
#define T_CS    33
#endif

#define SCREEN_W 320
#define SCREEN_H 240

// ─── Display ───────────────────────────────────────────────────────────────────
Arduino_DataBus *bus = new Arduino_ESP32SPI(TFT_DC, TFT_CS, TFT_CLK, TFT_MOSI,
                                            GFX_NOT_DEFINED, VSPI);
Arduino_GFX   *gfx  = new Arduino_ILI9341(bus, TFT_RST, 0 /*rot*/, false,
                                           240, 320);

// ─── Colours (RGB565) ──────────────────────────────────────────────────────────
#define C_BG        0x0841   // #080810  dark background
#define C_CARD      0x18C3   // #181830  card surface
#define C_BORDER    0x3186   // #303060  card border
#define C_WHITE     0xFFFF
#define C_MUTED     0xAD55   // #aaaaaa  muted text
#define C_GREEN     0x07E0   // WiFi OK
#define C_RED       0xF800   // WiFi fail / danger bar
#define C_AMBER     0xFDA0   // warning bar

#define BRAND_GEMINI  0x633E  // #6366f1 indigo
#define BRAND_CLAUDE  0xFB82  // #f97316 orange
#define BRAND_MINIMAX 0x269D  // #22d3ee cyan
#define BRAND_GLM     0x4EF0  // #4ade80 green

// ─── Data model ────────────────────────────────────────────────────────────────
struct QuotaDetails {
  long long used, total, remaining, reset_at;
};
struct AIData {
  String     name;
  uint16_t   brand_color;
  QuotaDetails quota5h, quotaWeekly;
};

static const int NUM_AI = 4;
AIData      aiData[NUM_AI];
const char *aiKeys[NUM_AI] = {"gemini", "claude", "minimax", "glm"};

// ─── Layout constants (landscape 320×240) ──────────────────────────────────────
#define HDR_H   26
#define FTR_H   20
#define FTR_Y   (SCREEN_H - FTR_H)       // 220
#define CARD_X  6
#define CARD_Y  (HDR_H + 4)              // 30
#define CARD_W  (SCREEN_W - CARD_X * 2)  // 308
#define CARD_H  (FTR_Y - CARD_Y - 4)     // 186
#define CARD_R  8
#define BAR_H   10
#define CW1     6     // char pixel width at textSize(1)
#define CW2     12    // textSize(2)
#define CW3     18    // textSize(3)

// ─── State ─────────────────────────────────────────────────────────────────────
int          currentIndex     = 0;
bool         dataFetched      = false;
bool         wifiEverConn     = false;

unsigned long lastRefresh     = 0;
unsigned long lastClockTick   = 0;
unsigned long lastRotateTick  = 0;
unsigned long lastWifiRetry   = 0;

const unsigned long REFRESH_MS    = 30000;  // Firebase poll interval
const unsigned long CLOCK_MS      = 1000;
const unsigned long ROTATE_MS     = 5000;
const unsigned long WIFI_RETRY_MS = 5000;

String clockText = "--:--";
String dateText  = "--- --";

// ─── Helpers ───────────────────────────────────────────────────────────────────
int clampPct(int v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

int calcRemainingPct(const QuotaDetails &q) {
  if (q.total <= 0) return 0;
  return clampPct((int)((q.remaining * 100) / q.total));
}

uint16_t barColor(int pct, uint16_t brand) {
  if (pct <= 20) return C_RED;
  if (pct <= 50) return C_AMBER;
  return brand;
}

String fmtReset(long long resetAt) {
  if (resetAt <= 0) return "--:--";
  time_t now = time(nullptr);
  if (now < 1000000000L || resetAt <= (long long)now) return "now";
  struct tm *t = localtime((time_t *)&resetAt);
  char buf[6]; strftime(buf, sizeof(buf), "%H:%M", t);
  return String(buf);
}

String fmtResetDay(long long resetAt) {
  if (resetAt <= 0) return "-- --:--";
  time_t now = time(nullptr);
  if (now < 1000000000L || resetAt <= (long long)now) return "now";
  struct tm *t = localtime((time_t *)&resetAt);
  char buf[12]; strftime(buf, sizeof(buf), "%a %H:%M", t);
  return String(buf);
}

String fmtCountdown(long long resetAt) {
  if (resetAt <= 0) return "--";
  long long s = resetAt - (long long)time(nullptr);
  if (s <= 0) return "now";
  if (s >= 86400) return String(s / 86400) + "d";
  if (s >= 3600)  return String(s / 3600)  + "h";
  return String(s / 60) + "m";
}

void drawBar(int x, int y, int w, int h, int pct, uint16_t brand) {
  pct = clampPct(pct);
  uint16_t bc = barColor(pct, brand);
  gfx->fillRoundRect(x, y, w, h, h/2, C_BG);
  gfx->drawRoundRect(x, y, w, h, h/2, C_BORDER);
  int fw = (pct * (w - 2)) / 100;
  if (fw > 0) gfx->fillRoundRect(x+1, y+1, fw, h-2, (h-2)/2, bc);
}

long long jsonInt64(FirebaseJson &json, const String &path) {
  FirebaseJsonData d;
  if (!json.get(d, path.c_str())) return 0LL;
  if (d.type == "string") return strtoll(d.stringValue.c_str(), nullptr, 10);
  if (d.type == "double" || d.type == "float") return (long long)d.doubleValue;
  return (long long)d.intValue;
}

// ─── WiFi signal bars ──────────────────────────────────────────────────────────
void drawWiFi(int x, int y) {
  if (WiFi.status() == WL_CONNECTED) {
    long rssi = WiFi.RSSI();
    int bars = 1;
    if (rssi > -55) bars = 4;
    else if (rssi > -67) bars = 3;
    else if (rssi > -78) bars = 2;
    gfx->fillRect(x,    y+10, 3, 3,  C_GREEN);
    gfx->fillRect(x+5,  y+6,  3, 7,  bars >= 2 ? C_GREEN : C_CARD);
    gfx->fillRect(x+10, y+2,  3, 11, bars >= 3 ? C_GREEN : C_CARD);
    gfx->fillRect(x+15, y,    3, 13, bars >= 4 ? C_GREEN : C_CARD);
  } else {
    gfx->setTextSize(1); gfx->setTextColor(C_RED);
    gfx->setCursor(x+4, y+4); gfx->print("x");
  }
}

// ─── Clock ─────────────────────────────────────────────────────────────────────
void refreshClock() {
  time_t now = time(nullptr);
  if (now < 1000000000L) { clockText = "--:--"; dateText = "--- --"; return; }
  struct tm *t = localtime(&now);
  char c[6], d[16];
  strftime(c, sizeof(c), "%H:%M", t);
  strftime(d, sizeof(d), "%a %d %b", t);
  clockText = String(c);
  dateText  = String(d);
}

// ─── Screens ───────────────────────────────────────────────────────────────────
void drawHeader() {
  gfx->fillRect(0, 0, SCREEN_W, HDR_H, C_CARD);
  gfx->drawFastHLine(0, HDR_H-1, SCREEN_W, C_BORDER);

  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(8, 8); gfx->print(dateText);

  gfx->setTextSize(2); gfx->setTextColor(C_WHITE);
  gfx->setCursor((SCREEN_W - (int)clockText.length() * CW2) / 2, 4);
  gfx->print(clockText);

  drawWiFi(SCREEN_W - 32, 6);
}

void drawFooter() {
  gfx->fillRect(0, FTR_Y, SCREEN_W, FTR_H, C_CARD);
  gfx->drawFastHLine(0, FTR_Y, SCREEN_W, C_BORDER);
  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(8, FTR_Y + 6);
  gfx->printf("%d/%d  %s", currentIndex+1, NUM_AI,
               dataFetched ? "auto-rotate 5s" : "waiting data...");
}

void drawBrandCard(const AIData &d, int idx) {
  int x = CARD_X, y = CARD_Y, w = CARD_W, h = CARD_H;
  int ix = x + 12, iw = w - 24;

  // Card background + border
  gfx->fillRoundRect(x, y, w, h, CARD_R, C_CARD);
  gfx->drawRoundRect(x, y, w, h, CARD_R, C_BORDER);

  // Top colour stripe
  gfx->fillRect(x, y, w, 4, d.brand_color);

  // ── Brand name (size 2)
  gfx->setTextSize(2); gfx->setTextColor(C_WHITE);
  gfx->setCursor(ix, y + 12); gfx->print(d.name);

  // Page indicator  (top-right)
  char pg[8]; sprintf(pg, "%d/%d", idx+1, NUM_AI);
  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(x + w - 12 - (int)strlen(pg) * CW1, y + 16);
  gfx->print(pg);

  int pct5h = calcRemainingPct(d.quota5h);
  int pctWk = calcRemainingPct(d.quotaWeekly);
  char pctBuf[8];

  // ── 5-Hour block ──────────────────────────────────────────────────────────
  int y5 = y + 44;

  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(ix, y5); gfx->print("5-HOUR");

  // Big percentage (right-aligned)
  sprintf(pctBuf, "%d%%", pct5h);
  gfx->setTextSize(3); gfx->setTextColor(barColor(pct5h, d.brand_color));
  gfx->setCursor(ix + iw - (int)strlen(pctBuf) * CW3, y5 - 8);
  gfx->print(pctBuf);

  // Progress bar
  drawBar(ix, y5 + 8, iw, BAR_H, pct5h, d.brand_color);

  // Reset row
  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(ix, y5 + 24);
  gfx->print("5h "); gfx->print(fmtReset(d.quota5h.reset_at));
  String in5h = "in " + fmtCountdown(d.quota5h.reset_at);
  gfx->setCursor(ix + iw - (int)in5h.length() * CW1, y5 + 24);
  gfx->print(in5h);

  // ── Weekly block ──────────────────────────────────────────────────────────
  int yWk = y + 110;

  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(ix, yWk); gfx->print("WEEKLY");

  sprintf(pctBuf, "%d%%", pctWk);
  gfx->setTextSize(3); gfx->setTextColor(barColor(pctWk, d.brand_color));
  gfx->setCursor(ix + iw - (int)strlen(pctBuf) * CW3, yWk - 8);
  gfx->print(pctBuf);

  drawBar(ix, yWk + 8, iw, BAR_H, pctWk, d.brand_color);

  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(ix, yWk + 24);
  gfx->print("wk "); gfx->print(fmtResetDay(d.quotaWeekly.reset_at));
  String inWk = "in " + fmtCountdown(d.quotaWeekly.reset_at);
  gfx->setCursor(ix + iw - (int)inWk.length() * CW1, yWk + 24);
  gfx->print(inWk);
}

void drawCurrent() {
  gfx->fillScreen(C_BG);
  drawHeader();
  drawBrandCard(aiData[currentIndex], currentIndex);
  drawFooter();
}

void drawLoading(const String &msg) {
  gfx->fillScreen(C_BG);
  gfx->setTextSize(2); gfx->setTextColor(C_WHITE);
  int tw = 16 * CW2;  // "AI Token Monitor"
  gfx->setCursor((SCREEN_W - tw) / 2, 80); gfx->print("AI Token Monitor");
  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor((SCREEN_W - (int)msg.length() * CW1) / 2, 120);
  gfx->print(msg);
  gfx->setCursor(60, 140); gfx->print("ESP32-2432S028R  ILI9341 320x240");
}

// ─── Firebase fetch ────────────────────────────────────────────────────────────
void fetchFromFirebase() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.println("[FB] Fetching /display/quotas.json ...");
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http;
  String url = String("https://") + FIREBASE_HOST
             + "/display/quotas.json?auth=" + FIREBASE_AUTH;
  http.begin(client, url);
  http.setTimeout(8000);
  int code = http.GET();
  if (code == 404) { Serial.println("[FB] 404 — not published yet"); http.end(); return; }
  if (code != 200) { Serial.printf("[FB] HTTP %d\n", code); http.end(); return; }

  String body = http.getString(); http.end();
  Serial.printf("[FB] %d bytes\n", body.length());

  FirebaseJson json;
  if (!json.setJsonData(body)) { Serial.println("[FB] JSON parse failed"); return; }

  FirebaseJsonData jd;
  for (int i = 0; i < NUM_AI; i++) {
    String pfx = String(aiKeys[i]) + "/";

    if (json.get(jd, (pfx + "name").c_str())) aiData[i].name = jd.stringValue;

    long long rem   = jsonInt64(json, pfx + "remaining");
    long long lim   = jsonInt64(json, pfx + "limit_value");
    long long wrem  = jsonInt64(json, pfx + "weekly_remaining");
    long long rat   = jsonInt64(json, pfx + "reset_at");
    long long ratW  = jsonInt64(json, pfx + "reset_at_weekly");
    long long sp5   = jsonInt64(json, pfx + "spend_pct5h");
    long long spW   = jsonInt64(json, pfx + "spend_pct_weekly");

    // Firebase stores ms timestamps; convert to seconds
    if (rat  > 100000000000LL) rat  /= 1000;
    if (ratW > 100000000000LL) ratW /= 1000;

    // Sanity-clamp timestamps (reject bogus far-future values)
    time_t ntp = time(nullptr);
    if (ntp > 1000000000L) {
      long long cap = (long long)ntp + 90LL * 86400;
      if (rat  > cap) rat  = 0;
      if (ratW > cap) ratW = 0;
    }

    String unit = "not_exposed";
    if (json.get(jd, (pfx + "unit").c_str())) unit = jd.stringValue;

    // ── 5-Hour quota
    if (unit == "percent" && rem >= 0 && rem <= 100) {
      aiData[i].quota5h = {100 - rem, 100, rem, rat};
    } else if (unit == "requests" && lim > 0 && rem >= 0) {
      long long used = lim - rem; if (used < 0) used = 0;
      aiData[i].quota5h = {used, lim, rem, rat};
    } else {
      long long r = clampPct((int)(100 - sp5));
      aiData[i].quota5h = {sp5, 100, r, rat};
    }

    // ── Weekly quota
    if (wrem >= 0 && wrem <= 100) {
      aiData[i].quotaWeekly = {100 - wrem, 100, wrem, ratW};
    } else {
      long long r = clampPct((int)(100 - spW));
      aiData[i].quotaWeekly = {spW, 100, r, ratW};
    }
  }

  dataFetched = true;
  Serial.printf("[FB] OK — %s 5h:%lld%% wk:%lld%%\n",
    aiData[0].name.c_str(),
    aiData[0].quota5h.remaining,
    aiData[0].quotaWeekly.remaining);
}

// ─── WiFi ──────────────────────────────────────────────────────────────────────
void wifiConnect() {
  WiFi.disconnect(true); delay(100);
  WiFi.mode(WIFI_STA);   delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WiFi] Connecting to %s ...\n", WIFI_SSID);
}

// ─── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\n=== AI Token Monitor — ESP32-2432S028R ===");

  // Backlight off during init (avoid flash)
  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, LOW);

  // Init display at conservative 4 MHz (yellow-PCB clones can be flaky at 20 MHz)
  if (!gfx->begin(4000000)) {
    Serial.println("[ERROR] gfx->begin() failed — check wiring");
  }
  gfx->setRotation(1);  // landscape 320×240

  // Backlight ON
  digitalWrite(TFT_BL, HIGH);
  Serial.println("[BOOT] Backlight ON");

  // Brief red flash proves display + backlight are working
  gfx->fillScreen(C_RED);
  delay(400);
  gfx->fillScreen(C_BG);

  // Default brand labels (shown before first Firebase fetch)
  aiData[0] = {"Antigravity", BRAND_GEMINI,  {0,100,0,0}, {0,100,0,0}};
  aiData[1] = {"Claude",      BRAND_CLAUDE,  {0,100,0,0}, {0,100,0,0}};
  aiData[2] = {"MiniMax",     BRAND_MINIMAX, {0,100,0,0}, {0,100,0,0}};
  aiData[3] = {"GLM",         BRAND_GLM,     {0,100,0,0}, {0,100,0,0}};

  drawLoading("Connecting to WiFi...");
  wifiConnect();

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(300);

  if (WiFi.status() == WL_CONNECTED) {
    wifiEverConn = true;
    Serial.println("[WiFi] Connected!");
    Serial.println("[NTP] Syncing...");
    configTime(25200, 0, "pool.ntp.org", "time.nist.gov");  // UTC+7
    time_t nt = time(nullptr);
    for (int i = 0; nt < 1000000000L && i < 20; i++) { delay(500); nt = time(nullptr); }
    refreshClock();
    drawLoading("Fetching data...");
    fetchFromFirebase();
  } else {
    Serial.println("[WiFi] Failed — will retry in loop");
  }

  unsigned long now = millis();
  lastRefresh    = now;
  lastClockTick  = now;
  lastRotateTick = now;
  lastWifiRetry  = now;

  if (dataFetched) drawCurrent();
  Serial.println("[BOOT] Setup complete.");
}

// ─── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // ── WiFi reconnect (non-blocking) ──────────────────────────────────────────
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiRetry >= WIFI_RETRY_MS) {
      lastWifiRetry = now;
      wifiConnect();
    }
    if (!wifiEverConn) return;  // no data yet, nothing to draw
  } else if (!wifiEverConn) {
    // Just connected for the first time in loop
    wifiEverConn = true;
    configTime(25200, 0, "pool.ntp.org", "time.nist.gov");
    time_t nt = time(nullptr);
    for (int i = 0; nt < 1000000000L && i < 20; i++) { delay(500); nt = time(nullptr); }
    refreshClock();
    fetchFromFirebase();
    if (dataFetched) drawCurrent();
    lastRefresh = now;
  }

  // ── Firebase refresh every 30s ─────────────────────────────────────────────
  if (now - lastRefresh >= REFRESH_MS) {
    lastRefresh = now;
    fetchFromFirebase();
    if (dataFetched) drawCurrent();
    return;  // skip rotate this tick
  }

  // ── Clock refresh every 1s ─────────────────────────────────────────────────
  if (now - lastClockTick >= CLOCK_MS) {
    lastClockTick = now;
    String prevClock = clockText, prevDate = dateText;
    refreshClock();
    if (dataFetched && (clockText != prevClock || dateText != prevDate)) {
      drawHeader();  // only re-draw header strip (avoids full flicker)
    }
  }

  // ── Auto-rotate every 5s ──────────────────────────────────────────────────
  if (dataFetched && now - lastRotateTick >= ROTATE_MS) {
    lastRotateTick = now;
    currentIndex = (currentIndex + 1) % NUM_AI;
    drawCurrent();
  }
}
