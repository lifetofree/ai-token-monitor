// =====================================================================
// AI Token Monitor — ESP32 Cheap Yellow Display 3.5" firmware
//
// Board: Sunton ESP32-3248S035R (ESP32-WROOM-32 + ST7796 480x320 over SPI
// + XPT2046 resistive touch sharing the same SPI bus via a separate CS).
// Pin mapping verified against rzeldent/platformio-espressif32-sunton
// (esp32-3248S035R.json) — NOT 8-bit parallel, despite this board also
// being sold under the generic "CYD 3.5\"" name alongside parallel variants.
//
// SPI pin map:
//   SCLK=14  MOSI=13  MISO=12
//   TFT_CS=15  TFT_DC=2  TFT_RST=not connected  TFT_BL=27 (active HIGH)
//   XPT2046 touch (shares SCLK/MOSI/MISO): T_CS=33  T_IRQ=36
// =====================================================================

#include <WiFi.h>
#include <SPI.h>
#include <Arduino_GFX_Library.h>
#include <FirebaseESP32.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <stdlib.h>

#define USE_TOUCH 0   // 1 = enable XPT2046 resistive touch — kept OFF: touch shares
                      // SCLK/MOSI/MISO with the display, and xpt2046_init() calling
                      // SPIClass(HSPI).begin() on those pins re-routes the ESP32 GPIO
                      // matrix away from VSPI, which Arduino_ESP32SPI only attaches
                      // once in begin() and never re-asserts — permanently breaking
                      // all display writes after touch init (confirmed against the
                      // GFX_Library_for_Arduino source: see Arduino_ESP32SPI.cpp).
                      // Re-enabling needs a software bit-bang touch driver that
                      // doesn't reclaim the pins via SPIClass/pinMode(OUTPUT), and
                      // that hasn't been written or tested on hardware yet.

#include "secrets.h"  // WIFI_SSID, WIFI_PASS, FIREBASE_HOST, FIREBASE_AUTH
#ifndef WIFI_PASSWORD
  #define WIFI_PASSWORD WIFI_PASS
#endif

// ─── Pin config (SPI — ST7796 controller) ───────────────────────────────────────
#define TFT_SCLK 14
#define TFT_MOSI 13
#define TFT_MISO 12
#define TFT_CS   15
#define TFT_DC    2
#define TFT_RST  -1   // not connected on this board
#define TFT_BL   27   // active HIGH

#if USE_TOUCH
#define T_CS    33    // XPT2046 chip select (dedicated)
#define T_IRQ   36    // Touch interrupt
#define T_MOSI  13    // shares display SPI bus
#define T_MISO  12    // shares display SPI bus
#define T_CLK   14    // shares display SPI bus
#endif

#define SCREEN_W 480
#define SCREEN_H 320

// ─── Display (SPI ST7796) ────────────────────────────────────────────────────────
Arduino_DataBus *bus = new Arduino_ESP32SPI(TFT_DC, TFT_CS, TFT_SCLK, TFT_MOSI, TFT_MISO);
// ST7796 native is 320x480 portrait; setRotation(1) in setup() gives us 480x320
Arduino_GFX   *gfx  = new Arduino_ST7796(bus, TFT_RST, 0 /*rot*/, false);

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

// ─── Layout constants (landscape 480x320) ──────────────────────────────────────
#define HDR_H   36
#define FTR_H   28
#define FTR_Y   (SCREEN_H - FTR_H)       // 292
#define CARD_GAP 6
#define CARD_X_START 8
#define CARD_Y_START (HDR_H + 4)         // 40
#define CARD_W      ((SCREEN_W - CARD_X_START * 2 - CARD_GAP) / 2)  // 232
#define CARD_H      ((FTR_Y - CARD_Y_START - CARD_GAP) / 2)            // 121
#define CARD_R      10
#define BAR_H       12
#define CW1         6     // char pixel width at textSize(1)
#define CW2         12    // textSize(2)
#define CW3         18    // textSize(3)

// ─── State ─────────────────────────────────────────────────────────────────────
bool         dataFetched      = false;
bool         wifiEverConn     = false;

unsigned long lastRefresh     = 0;
unsigned long lastClockTick   = 0;
unsigned long lastWifiRetry   = 0;

const unsigned long REFRESH_MS    = 30000;  // Firebase poll interval
const unsigned long CLOCK_MS      = 1000;
const unsigned long WIFI_RETRY_MS = 5000;

String clockText = "--:--";
String dateText  = "--- --";

#if USE_TOUCH
// ─── XPT2046 Touch Driver (resistive, SPI) ─────────────────────────────────────
SPIClass touchSPI(HSPI);

bool xpt2046_init() {
  pinMode(T_CS, OUTPUT);
  digitalWrite(T_CS, HIGH);
  if (T_IRQ >= 0) pinMode(T_IRQ, INPUT_PULLUP);
  touchSPI.begin(T_CLK, T_MISO, T_MOSI, T_CS);
  return true;
}

static uint16_t xpt2046_read(uint8_t cmd) {
  digitalWrite(T_CS, LOW);
  touchSPI.transfer(cmd);
  uint16_t v = ((uint16_t)touchSPI.transfer(0) << 8) | touchSPI.transfer(0);
  digitalWrite(T_CS, HIGH);
  return v >> 3;  // 12-bit value
}

bool xpt2046_read_xy(int *outX, int *outY) {
  if (T_IRQ >= 0 && digitalRead(T_IRQ) == HIGH) return false;

  int x = 0, y = 0, valid = 0;
  for (int i = 0; i < 4; i++) {
    uint16_t xr = xpt2046_read(0xD0);  // X channel
    uint16_t yr = xpt2046_read(0x90);  // Y channel
    if (xr > 50 && xr < 4000 && yr > 50 && yr < 4000) {
      x += xr; y += yr; valid++;
    }
  }
  if (valid == 0) return false;
  x /= valid; y /= valid;

  // CYD 3.5" XPT2046: raw X/Y are rotated 90 deg relative to landscape
  int sx = 4095 - y;
  int sy = x;
  if (sx < 0) sx = 0; if (sx >= SCREEN_W) sx = SCREEN_W - 1;
  if (sy < 0) sy = 0; if (sy >= SCREEN_H) sy = SCREEN_H - 1;

  *outX = sx;
  *outY = sy;
  return true;
}
#endif

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
  gfx->drawFastHLine(0, HDR_H - 1, SCREEN_W, C_BORDER);

  gfx->setTextSize(2); gfx->setTextColor(C_MUTED);
  gfx->setCursor(12, 10); gfx->print(dateText);

  gfx->setTextSize(3); gfx->setTextColor(C_WHITE);
  int clockW = (int)clockText.length() * CW3;
  gfx->setCursor((SCREEN_W - clockW) / 2, 2); gfx->print(clockText);

  drawWiFi(SCREEN_W - 32, 10);
}

void drawFooter() {
  gfx->fillRect(0, FTR_Y, SCREEN_W, FTR_H, C_CARD);
  gfx->drawFastHLine(0, FTR_Y, SCREEN_W, C_BORDER);
  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(12, FTR_Y + 10);
  gfx->printf("AI Token Monitor  •  %d brands  •  %s",
              NUM_AI,
              dataFetched ? "live" : "waiting data...");
  gfx->setCursor(SCREEN_W - 12 - 6 * CW1, FTR_Y + 10);
  gfx->print(WiFi.status() == WL_CONNECTED ? "WiFi OK" : "WiFi x");
}

void drawBrandCard(int x, int y, int w, int h, const AIData &d) {
  int ix = x + 12, iw = w - 24;

  gfx->fillRoundRect(x, y, w, h, CARD_R, C_CARD);
  gfx->drawRoundRect(x, y, w, h, CARD_R, C_BORDER);
  gfx->fillRect(x, y + 6, 4, h - 12, d.brand_color);

  int pct5h = calcRemainingPct(d.quota5h);
  int pctWk = calcRemainingPct(d.quotaWeekly);
  char pctBuf[8];

  gfx->setTextSize(2); gfx->setTextColor(C_WHITE);
  gfx->setCursor(ix, y + 6); gfx->print(d.name);

  sprintf(pctBuf, "%d%%", pct5h);
  gfx->setTextColor(barColor(pct5h, d.brand_color));
  int pctW = (int)strlen(pctBuf) * CW2;
  gfx->setCursor(ix + iw - pctW, y + 6); gfx->print(pctBuf);

  drawBar(ix, y + 28, iw, BAR_H, pct5h, d.brand_color);

  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(ix, y + 46); gfx->print("WEEKLY");

  gfx->setTextSize(2);
  sprintf(pctBuf, "%d%%", pctWk);
  gfx->setTextColor(barColor(pctWk, d.brand_color));
  pctW = (int)strlen(pctBuf) * CW2;
  gfx->setCursor(ix + iw - pctW, y + 46); gfx->print(pctBuf);

  drawBar(ix, y + 68, iw, BAR_H, pctWk, d.brand_color);

  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor(ix, y + 88);
  gfx->print("5h reset "); gfx->print(fmtReset(d.quota5h.reset_at));
  String in5h = "in " + fmtCountdown(d.quota5h.reset_at);
  int inW = (int)in5h.length() * CW1;
  gfx->setCursor(ix + iw - inW, y + 88); gfx->print(in5h);

  gfx->setCursor(ix, y + 102);
  gfx->print("wk "); gfx->print(fmtResetDay(d.quotaWeekly.reset_at));
  String inWk = "in " + fmtCountdown(d.quotaWeekly.reset_at);
  inW = (int)inWk.length() * CW1;
  gfx->setCursor(ix + iw - inW, y + 102); gfx->print(inWk);
}

void drawGrid() {
  gfx->fillScreen(C_BG);
  drawHeader();

  for (int row = 0; row < 2; row++) {
    int y = CARD_Y_START + row * (CARD_H + CARD_GAP);
    for (int col = 0; col < 2; col++) {
      int x = CARD_X_START + col * (CARD_W + CARD_GAP);
      int idx = row * 2 + col;
      drawBrandCard(x, y, CARD_W, CARD_H, aiData[idx]);
    }
  }

  drawFooter();
}

void drawLoading(const String &msg) {
  gfx->fillScreen(C_BG);
  gfx->setTextSize(3); gfx->setTextColor(C_WHITE);
  int tw = 14 * CW3;
  gfx->setCursor((SCREEN_W - tw) / 2, 110); gfx->print("AI Token Monitor");
  gfx->setTextSize(2); gfx->setTextColor(C_MUTED);
  gfx->setCursor((SCREEN_W - (int)msg.length() * CW2) / 2, 160); gfx->print(msg);
  gfx->setTextSize(1); gfx->setTextColor(C_MUTED);
  gfx->setCursor((SCREEN_W - 32 * CW1) / 2, 200); gfx->print("ESP32 CYD 3.5\"  ST7796 480x320");
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

    if (rat  > 100000000000LL) rat  /= 1000;
    if (ratW > 100000000000LL) ratW /= 1000;

    time_t ntp = time(nullptr);
    if (ntp > 1000000000L) {
      long long cap = (long long)ntp + 90LL * 86400;
      if (rat  > cap) rat  = 0;
      if (ratW > cap) ratW = 0;
    }

    String unit = "not_exposed";
    if (json.get(jd, (pfx + "unit").c_str())) unit = jd.stringValue;

    if (unit == "percent" && rem >= 0 && rem <= 100) {
      aiData[i].quota5h = {100 - rem, 100, rem, rat};
    } else if (unit == "requests" && lim > 0 && rem >= 0) {
      long long used = lim - rem; if (used < 0) used = 0;
      aiData[i].quota5h = {used, lim, rem, rat};
    } else {
      long long r = clampPct((int)(100 - sp5));
      aiData[i].quota5h = {sp5, 100, r, rat};
    }

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
  Serial.println("\n=== AI Token Monitor — ESP32 CYD 3.5\" ===");

  // Backlight OFF during initialization (avoid flash) - active HIGH
  pinMode(TFT_BL, OUTPUT);      digitalWrite(TFT_BL, LOW);

  // Init display (SPI, ST7796) at 24 MHz (matches the board's documented max SPI clock)
  Serial.println("[DISP] init SPI...");
  if (!gfx->begin(24000000)) {
    Serial.println("[ERROR] gfx->begin() failed — check wiring");
  } else {
    Serial.println("[DISP] gfx->begin() OK");
  }
  gfx->setRotation(1);  // 480x320 landscape (panel native is 320x480 portrait)

  // Backlight ON
  digitalWrite(TFT_BL, HIGH);
  Serial.println("[BOOT] Backlight ON");

  // Brief red flash proves display + backlight are working
  gfx->fillScreen(C_RED);
  delay(400);
  gfx->fillScreen(C_BG);

#if USE_TOUCH
  if (xpt2046_init()) {
    Serial.println("[TOUCH] XPT2046 ready");
  }
#endif

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
  lastRefresh   = now;
  lastClockTick = now;
  lastWifiRetry = now;

  if (dataFetched) drawGrid();
  Serial.println("[BOOT] Setup complete.");
}

// ─── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiRetry >= WIFI_RETRY_MS) {
      lastWifiRetry = now;
      wifiConnect();
    }
    if (!wifiEverConn) return;
  } else if (!wifiEverConn) {
    wifiEverConn = true;
    configTime(25200, 0, "pool.ntp.org", "time.nist.gov");
    time_t nt = time(nullptr);
    for (int i = 0; nt < 1000000000L && i < 20; i++) { delay(500); nt = time(nullptr); }
    refreshClock();
    fetchFromFirebase();
    if (dataFetched) drawGrid();
    lastRefresh = now;
  }

  if (now - lastRefresh >= REFRESH_MS) {
    lastRefresh = now;
    fetchFromFirebase();
    if (dataFetched) drawGrid();
    return;
  }

  if (now - lastClockTick >= CLOCK_MS) {
    lastClockTick = now;
    String prevClock = clockText, prevDate = dateText;
    refreshClock();
    if (dataFetched && (clockText != prevClock || dateText != prevDate)) {
      drawGrid();
    }
  }

#if USE_TOUCH
  int tx, ty;
  static bool wasTouching = false;
  if (xpt2046_read_xy(&tx, &ty)) {
    if (!wasTouching) {
      wasTouching = true;
      Serial.printf("[TOUCH] down x=%d y=%d\n", tx, ty);
    }
  } else {
    wasTouching = false;
  }
#endif
}
