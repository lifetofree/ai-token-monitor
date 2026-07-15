#include <WiFi.h>
#include <Wire.h>
#include <Arduino_GFX_Library.h> // ไลบรารี Arduino_GFX สำหรับ JC3248W535C (AXS15231B QSPI)
#include <SPI.h>
#include <FirebaseESP32.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <stdlib.h> // สำหรับใช้ฟังก์ชันแปลงข้อความเป็นเลข 64-bit (strtoll)
#include <math.h>   // sinf/fabsf/roundf — used by the issue #8 Mac page prototype

// =====================================================================
// Hardware pin config — Guition JC3248W535C_I_Y
// ESP32-S3-N16R8 + AXS15231B QSPI 320x480 + capacitive touch
// =====================================================================

// QSPI display bus
#define GFX_BL          1
// ไม่จำเป็นต้อง #define QSPI pins ที่นี่ เพราะระบุตรง bus object ด้านล่าง

// AXS15231B integrated capacitive touch (I2C)
#define TOUCH_ADDR     0x3B
#define TOUCH_SDA       4
#define TOUCH_SCL       8
#define TOUCH_I2C_CLOCK 400000
#define TOUCH_RST_PIN  12
#define TOUCH_INT_PIN   3
#define AXS_MAX_TOUCH_NUMBER 1

// ปรับทิศทาง touch ให้ตรงกับหน้าจอ (หากกดซ้าย/ขวา สลับกัน ให้เปลี่ยนค่าเหล่านี้)
#define TOUCH_SWAP_AXES 1   // 1 = สลับแกน X/Y (required for landscape)
#define TOUCH_FLIP_X    0   // 1 = กลับด้าน X
#define TOUCH_FLIP_Y    1   // 1 = กลับด้าน Y (adjust if touch is mirrored)

// Touch behavior
#define HEADER_TAP_H   50     // แตะในเขต header = สลับ overview/settings

#define SCREEN_WIDTH   480
#define SCREEN_HEIGHT  320

// =====================================================================
// Display objects (QSPI + AXS15231B + Canvas framebuffer)
// =====================================================================
// JC3248W535C QSPI pinout: CS=45, CLK=47, D0=21, D1=48, D2=40, D3=39
Arduino_DataBus *bus = new Arduino_ESP32QSPI(45, 47, 21, 48, 40, 39);
Arduino_GFX *g = new Arduino_AXS15231B(bus, GFX_NOT_DEFINED, 0, false, 320, 480);
// Canvas wrapper จำเป็นสำหรับ JC3248W535C (direct render ไม่เสถียร)
// NOTE: Canvas dims MUST match the panel's NATIVE orientation (320x480) so that
// flush() blits correctly. Landscape is achieved via gfx->setRotation(1) in setup(),
// which rotates only the DRAWING space to 480x320 (SCREEN_WIDTH x SCREEN_HEIGHT).
Arduino_Canvas *gfx = new Arduino_Canvas(320, 480, g, 0, 0, 0);

// =====================================================================
// WiFi + Firebase
// =====================================================================
#include "secrets.h"  // gitignored — copy template from secrets.txt
// secrets.h defines WIFI_SSID, WIFI_PASS, FIREBASE_HOST, FIREBASE_AUTH.
// Code below uses WIFI_PASSWORD; alias it to keep call-sites unchanged.
#ifndef WIFI_PASSWORD
  #define WIFI_PASSWORD WIFI_PASS
#endif

// =====================================================================
// Colors (RGB565) — match web dashboard dark mode (styles.css :root[data-theme=dark])
// =====================================================================
#define COLOR_DARK_BG    0x0841
#define COLOR_CARD_BG    0x18C3
#define COLOR_BORDER     0x3186
#define COLOR_WHITE      0xFFFF
#define COLOR_TXT_MUTED  0xAD55
#define COLOR_NET_OK     0x07E0
#define COLOR_NET_FAIL   0xF800

// Brand palette — web dark mode equivalents (RGB888 -> RGB565)
#define BRAND_GEMINI     0x633E  // #6366f1 Indigo  (--color-gemini dark)
#define BRAND_CLAUDE     0xFB82  // #f97316 Orange  (--color-claude dark)
#define BRAND_MINIMAX    0x269D  // #22d3ee Cyan    (--color-minimax dark)
#define BRAND_GLM        0x4EF0  // #4ade80 Green   (--color-glm dark)

// =====================================================================
// Data model
// =====================================================================
struct QuotaDetails {
  long long used;
  long long total;
  long long remaining;
  long long reset_at;
};

struct AIData {
  String name;
  uint16_t brand_color;
  QuotaDetails quota5h;
  QuotaDetails quotaWeekly;
};

AIData aiData[4];

int currentIndex = 0;
const int num_ai = 4;
String aiKeys[] = {"gemini", "claude", "minimax", "glm"};

bool useFirebase = false;
unsigned long lastRefresh = 0;

bool dataFetched = false;           // true after first successful Firebase fetch
bool wifiEverConnected = false;     // true once we've connected at least once

// ─── Display State (which screen is shown) ───────────────────────────
enum DisplayState { STATE_OVERVIEW, STATE_SETTINGS, STATE_MAC_PROTO };
int displayState = STATE_OVERVIEW;

// ─── PROTOTYPE (issue #8, throwaway): Mac page mock-up state ─────────
int macProtoVariant = 0;          // 0=A rows, 1=B cards, 2=C hero+strip
bool macProtoOfflineSim = false;  // fake "Mac offline" toggle for review

// ─── Settings (persisted in RAM only; re-applied on boot) ───────────
int brightnessLevel = 3;  // 0..3 -> 25 / 50 / 75 / 100 %
const int brightnessPct[4] = {25, 50, 75, 100};
#define LEDC_FREQ     5000
#define LEDC_RES      8
int ledcChannel = -1;

// ─── Touch State ───────────────────────────────────────────────────
bool touchActive = false;
uint16_t touchStartX = 0, touchStartY = 0;
unsigned long lastTapTime = 0;
const unsigned long TAP_DEBOUNCE_MS = 250;

// ─── Clock (refreshed from NTP time) ────────────────────────────────
unsigned long lastClockRefresh = 0;
const unsigned long CLOCK_REFRESH_MS = 1000;
String clockText = "--:--";
String dateText = "--- --";

// =====================================================================
// 🖐️ AXS15231B Capacitive Touch Driver (I2C, integrated in display chip)
// =====================================================================

void axs_touch_init() {
  Wire.begin(TOUCH_SDA, TOUCH_SCL);
  Wire.setClock(TOUCH_I2C_CLOCK);

  if (TOUCH_RST_PIN >= 0) {
    pinMode(TOUCH_RST_PIN, OUTPUT);
    digitalWrite(TOUCH_RST_PIN, LOW);
    delay(200);
    digitalWrite(TOUCH_RST_PIN, HIGH);
    delay(200);
  }

  if (TOUCH_INT_PIN >= 0) {
    pinMode(TOUCH_INT_PIN, INPUT_PULLUP);
  }

  Wire.beginTransmission(TOUCH_ADDR);
  if (Wire.endTransmission() != 0) {
    Serial.println("[TOUCH] AXS15231B touch not found on I2C bus");
  } else {
    Serial.println("[TOUCH] AXS15231B touch ready");
  }
}

bool axs_touch_read(uint16_t *x, uint16_t *y) {
  uint8_t data[AXS_MAX_TOUCH_NUMBER * 6 + 2] = {0};

  const uint8_t read_cmd[11] = {
    0xb5, 0xab, 0xa5, 0x5a, 0x00, 0x00,
    (uint8_t)((AXS_MAX_TOUCH_NUMBER * 6 + 2) >> 8),
    (uint8_t)((AXS_MAX_TOUCH_NUMBER * 6 + 2) & 0xff),
    0x00, 0x00, 0x00
  };

  Wire.beginTransmission(TOUCH_ADDR);
  Wire.write(read_cmd, 11);
  if (Wire.endTransmission() != 0) return false;

  if (Wire.requestFrom(TOUCH_ADDR, (uint8_t)sizeof(data)) != sizeof(data)) return false;
  for (size_t i = 0; i < sizeof(data); i++) {
    data[i] = Wire.read();
  }

  if (data[1] == 0 || data[1] > AXS_MAX_TOUCH_NUMBER) return false;

  uint16_t rawX = ((data[2] & 0x0F) << 8) | data[3];
  uint16_t rawY = ((data[4] & 0x0F) << 8) | data[5];

  uint16_t tx = rawX;
  uint16_t ty = rawY;

#if TOUCH_SWAP_AXES
  uint16_t tmp = tx; tx = ty; ty = tmp;
#endif
#if TOUCH_FLIP_X
  tx = SCREEN_WIDTH - 1 - tx;
#endif
#if TOUCH_FLIP_Y
  ty = SCREEN_HEIGHT - 1 - ty;
#endif

  if (tx >= SCREEN_WIDTH || ty >= SCREEN_HEIGHT) return false;

  if (x) *x = tx;
  if (y) *y = ty;
  return true;
}

// =====================================================================
// 🚀 ฟังก์ชันช่วยเหลือทางระบบ (System Utility Functions)
// =====================================================================

// แปลงเวลาระบบ Unix Timestamp 64-bit เป็นข้อความนับถอยหลังที่อ่านง่าย
String getResetString(long long resetAt) {
  if (resetAt <= 0) return "--";
  long long secsLeft = resetAt - (long long)time(nullptr);
  if (secsLeft <= 0) {
    return "Now";
  } else if (secsLeft >= 86400) {
    long long days = secsLeft / 86400;
    long long hours = (secsLeft % 86400) / 3600;
    return String(days) + "d " + String(hours) + "h";
  } else if (secsLeft >= 3600) {
    long long hours = secsLeft / 3600;
    long long mins = (secsLeft % 3600) / 60;
    return String(hours) + "h " + String(mins) + "m";
  } else {
    return String(secsLeft / 60) + "m";
  }
}

uint16_t getProgressBarColor(int percent) {
  if (percent > 50)  return 0x07E0;
  if (percent > 20)  return 0xFDA0;
  return 0xF800;
}

long long getJsonInt64(FirebaseJson &json, const String &path) {
  FirebaseJsonData jsonData;
  if (json.get(jsonData, path.c_str())) {
    if (jsonData.type == "uint") {
      if (jsonData.stringValue.length() > 0) {
        return strtoll(jsonData.stringValue.c_str(), NULL, 10);
      }
      return (long long)(uint32_t)jsonData.intValue;
    }
    if (jsonData.type == "int") {
      if (jsonData.stringValue.length() > 0) {
        return strtoll(jsonData.stringValue.c_str(), NULL, 10);
      }
      return (long long)jsonData.intValue;
    }
    if (jsonData.type == "double" || jsonData.type == "float") {
      if (jsonData.stringValue.length() > 0) {
        return strtoll(jsonData.stringValue.c_str(), NULL, 10);
      }
      return (long long)jsonData.doubleValue;
    }
    if (jsonData.type == "string") {
      return strtoll(jsonData.stringValue.c_str(), NULL, 10);
    }
  }
  return 0LL;
}

// WiFi signal bars at top-right corner
void drawWiFiSignal(int x, int y) {
  if (WiFi.status() == WL_CONNECTED) {
    long rssi = WiFi.RSSI();
    int bars = 1;
    if (rssi > -55) bars = 4;
    else if (rssi > -67) bars = 3;
    else if (rssi > -78) bars = 2;

    gfx->fillRect(x,     y + 14, 4,  4, COLOR_NET_OK);
    gfx->fillRect(x + 6, y + 9,  4,  9, (bars >= 2) ? COLOR_NET_OK : COLOR_CARD_BG);
    gfx->fillRect(x + 12,y + 4,  4, 14, (bars >= 3) ? COLOR_NET_OK : COLOR_CARD_BG);
    gfx->fillRect(x + 18,y,      4, 18, (bars >= 4) ? COLOR_NET_OK : COLOR_CARD_BG);
  } else {
    gfx->setTextSize(1);
    gfx->setTextColor(COLOR_NET_FAIL);
    gfx->setCursor(x + 5, y + 4);
    gfx->print("x");
  }
}

// =====================================================================
// 🕐 Clock helpers (NTP-synced)
// =====================================================================
String getClockText() {
  time_t now = time(nullptr);
  if (now < 1000000000L) return "--:--";
  struct tm* t = localtime(&now);
  char buf[6];
  strftime(buf, sizeof(buf), "%H:%M", t);
  return String(buf);
}

String getDateText() {
  time_t now = time(nullptr);
  if (now < 1000000000L) return "--- --";
  struct tm* t = localtime(&now);
  char buf[16];
  strftime(buf, sizeof(buf), "%a %d %b", t);
  return String(buf);
}

void refreshClock() {
  String newClock = getClockText();
  String newDate  = getDateText();
  if (newClock != clockText || newDate != dateText) {
    clockText = newClock;
    dateText  = newDate;
  }
}

// =====================================================================
// 💡 Brightness control (LEDC PWM on GFX_BL pin)
// =====================================================================
void applyBrightnessLevel() {
  int pct = brightnessPct[brightnessLevel];
  if (pct < 0)   pct = 0;
  if (pct > 100) pct = 100;
  int duty = (pct * 255) / 100;
  if (ledcChannel >= 0) {
    ledcWrite(ledcChannel, duty);
  }
}

// =====================================================================
// 🎨 Brand Icons (vector-style, drawn at any size in `color`)
// =====================================================================
// brandIndex: 0=Antigravity, 1=Claude, 2=MiniMax, 3=GLM
void drawBrandIcon(int brandIndex, int x, int y, int size, uint16_t color) {
  int cx = x + size / 2;
  int cy = y + size / 2;
  int r  = size / 2 - 1;
  const float PI_F = 3.14159265f;

  switch (brandIndex) {
    case 0: { // Antigravity/Gemini — 4-pointed star
      gfx->drawLine(cx, cy - r, cx, cy + r, color);
      gfx->drawLine(cx - r, cy, cx + r, cy, color);
      int d = (r * 7) / 10;
      gfx->drawLine(cx - d, cy - d, cx + d, cy + d, color);
      gfx->drawLine(cx - d, cy + d, cx + d, cy - d, color);
      gfx->fillCircle(cx, cy, 2, color);
      break;
    }
    case 1: { // Claude — 6-pointed asterisk
      for (int i = 0; i < 6; i++) {
        float angle = (i * PI_F) / 3.0f;
        int x1 = cx + (int)(r * cosf(angle));
        int y1 = cy + (int)(r * sinf(angle));
        gfx->drawLine(cx, cy, x1, y1, color);
      }
      gfx->fillCircle(cx, cy, 2, color);
      break;
    }
    case 2: { // MiniMax — sine wave
      bool first = true;
      int prevY = cy;
      for (int dx = -r; dx <= r; dx++) {
        float t = (float)dx / (float)r * PI_F * 1.5f;
        int dy = (int)(sinf(t) * (r * 0.5f));
        int px = cx + dx;
        int py = cy + dy;
        if (!first) gfx->drawLine(px - 1, prevY, px, py, color);
        prevY = py;
        first = false;
      }
      break;
    }
    case 3: { // GLM — 4 dots
      int d = (r * 5) / 10;
      int dotR = (r * 25) / 100;
      if (dotR < 2) dotR = 2;
      gfx->fillCircle(cx - d, cy - d, dotR, color);
      gfx->fillCircle(cx + d, cy - d, dotR, color);
      gfx->fillCircle(cx - d, cy + d, dotR, color);
      gfx->fillCircle(cx + d, cy + d, dotR, color);
      break;
    }
  }
}

void drawAppLogo(int cx, int cy, int radius, uint16_t ringColor, uint16_t textColor) {
  gfx->drawCircle(cx, cy, radius, ringColor);
  gfx->drawCircle(cx, cy, radius - 1, ringColor);
  gfx->setTextSize(3);
  gfx->setTextColor(textColor);
  gfx->setCursor(cx - 18, cy - 12);
  gfx->print("AI");
}

// =====================================================================
// Card layout (480x320) — Landscape Overview
// =====================================================================

#define HEADER_H       36
#define FOOTER_H       30
#define FOOTER_Y       (SCREEN_HEIGHT - FOOTER_H)  // 290
#define CARD_X_START   8
#define CARD_Y_START   42
#define CARD_W         228                          // (480 - 8*3) / 2
#define CARD_H         120
#define CARD_GAP       4
#define CARD_R         12
#define BAR_H          12
#define CHAR_W_SIZE1   6
#define CHAR_W_SIZE2   12
#define CHAR_W_SIZE3   18
#define CHAR_W_SIZE4   24
#define STAT_COL_W     60

// ─── helpers ────────────────────────────────────────────────────────
int calcRemainingPct(const QuotaDetails& q) {
  if (q.total <= 0) return 0;
  int pct = (int)((q.remaining * 100) / q.total);
  if (pct > 100) pct = 100;
  if (pct < 0) pct = 0;
  return pct;
}

String formatAbsoluteReset(long long resetAt) {
  if (resetAt <= 0) return "--:--";
  time_t now = time(nullptr);
  if (now < 1000000000L) return "--:--";
  long long secsLeft = resetAt - (long long)now;
  if (secsLeft <= 0) return "now";
  time_t t = (time_t)resetAt;
  struct tm* tmInfo = localtime(&t);
  char buf[6];
  strftime(buf, sizeof(buf), "%H:%M", tmInfo);
  return String(buf);
}

String formatAbsoluteResetWithDay(long long resetAt) {
  if (resetAt <= 0) return "-- --:--";
  time_t now = time(nullptr);
  if (now < 1000000000L) return "-- --:--";
  long long secsLeft = resetAt - (long long)now;
  if (secsLeft <= 0) return "now";
  time_t t = (time_t)resetAt;
  struct tm* tmInfo = localtime(&t);
  char buf[12];
  strftime(buf, sizeof(buf), "%a %H:%M", tmInfo);
  return String(buf);
}

uint16_t getBarColorForPct(int pct, uint16_t brandColor) {
  if (pct <= 20) return 0xF800;
  if (pct <= 50) return 0xFDA0;
  return brandColor;
}

String fmtTokenCount(long long val) {
  if (val <= 0) return "0";
  if (val >= 1000000000LL) {
    long long g = val / 1000000000LL;
    long long d = (val % 1000000000LL) / 100000000LL;
    return String(g) + "." + String(d) + "B";
  }
  if (val >= 1000000LL) {
    long long m = val / 1000000LL;
    long long d = (val % 1000000LL) / 100000LL;
    return String(m) + "." + String(d) + "M";
  }
  if (val >= 1000LL) {
    return String(val / 1000LL) + "k";
  }
  return String(val);
}

// วาด Progress Bar แนวนอนแบบบาง (rounded, ใช้ซ้ำในทุกหน้า)
void drawProgressBarH(int x, int y, int w, int h, int pct, uint16_t brandColor) {
  if (pct < 0)   pct = 0;
  if (pct > 100) pct = 100;
  uint16_t barColor = getBarColorForPct(pct, brandColor);
  gfx->fillRoundRect(x, y, w, h, h / 2, COLOR_DARK_BG);
  gfx->drawRoundRect(x, y, w, h, h / 2, COLOR_BORDER);
  int fillW = (pct * (w - 2)) / 100;
  if (fillW > 0) {
    gfx->fillRoundRect(x + 1, y + 1, fillW, h - 2, (h - 2) / 2, barColor);
  }
}

// =====================================================================
// 🧭 Header (clock + date + WiFi)
// =====================================================================
void drawHeader() {
  gfx->fillRect(0, 0, SCREEN_WIDTH, HEADER_H, COLOR_CARD_BG);
  gfx->drawFastHLine(0, HEADER_H - 1, SCREEN_WIDTH, COLOR_BORDER);

  // Date (left, size 2)
  gfx->setTextSize(2);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(12, 10);
  gfx->print(dateText);

  // Clock (center, size 3 = 24px)
  gfx->setTextSize(3);
  gfx->setTextColor(COLOR_WHITE);
  int clockW = clockText.length() * CHAR_W_SIZE3;
  gfx->setCursor((SCREEN_WIDTH - clockW) / 2, 4);
  gfx->print(clockText);

  // WiFi (right top, centered vertically)
  drawWiFiSignal(SCREEN_WIDTH - 40, 6);
}

// =====================================================================
// 📊 Footer (hint bar)
// =====================================================================
void drawFooter() {
  gfx->fillRect(0, FOOTER_Y, SCREEN_WIDTH, FOOTER_H, COLOR_CARD_BG);
  gfx->drawFastHLine(0, FOOTER_Y, SCREEN_WIDTH, COLOR_BORDER);

  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(12, FOOTER_Y + 12);
  gfx->print(displayState == STATE_OVERVIEW
             ? "tap top: settings"
             : "tap top: overview | tap row: change");
}

// =====================================================================
// 🪟 Compact brand card (1 cell of 2x2 grid)
// =====================================================================
void drawBrandRow(int x, int y, int brandIndex, const AIData& data) {
  int w = CARD_W;
  int h = CARD_H;

  // Card background + border
  gfx->fillRoundRect(x, y, w, h, CARD_R, COLOR_CARD_BG);
  gfx->drawRoundRect(x, y, w, h, CARD_R, COLOR_BORDER);

  // Left brand-color accent stripe
  gfx->fillRect(x, y + 10, 4, h - 20, data.brand_color);

  int ix = x + 18;   // more horizontal padding
  int iw = w - 34;   // 194

  int pct5h = calcRemainingPct(data.quota5h);
  int pctWk = calcRemainingPct(data.quotaWeekly);
  uint16_t pct5hColor = getBarColorForPct(pct5h, data.brand_color);
  uint16_t pctWkColor = getBarColorForPct(pctWk, data.brand_color);
  char pctStr[8];

  // ── Header: icon + brand name (size 1 — compact to fit dual reset rows) ─
  int iconSize = 20;
  drawBrandIcon(brandIndex, ix, y + 6, iconSize, data.brand_color);
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_WHITE);
  gfx->setCursor(ix + iconSize + 8, y + 10);
  gfx->print(data.name);

  // ── 5H quota block ───────────────────────────────────────────────
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(ix, y + 32);
  gfx->print("5-HOUR");

  gfx->setTextSize(2);
  gfx->setTextColor(pct5hColor);
  sprintf(pctStr, "%d%%", pct5h);
  int pctW = strlen(pctStr) * CHAR_W_SIZE2;
  gfx->setCursor(ix + iw - pctW, y + 28);
  gfx->print(pctStr);

  drawProgressBarH(ix, y + 44, iw, 12, pct5h, data.brand_color);

  // ── Weekly quota block ───────────────────────────────────────────
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(ix, y + 62);
  gfx->print("WEEKLY");

  gfx->setTextSize(2);
  gfx->setTextColor(pctWkColor);
  sprintf(pctStr, "%d%%", pctWk);
  pctW = strlen(pctStr) * CHAR_W_SIZE2;
  gfx->setCursor(ix + iw - pctW, y + 58);
  gfx->print(pctStr);

  drawProgressBarH(ix, y + 74, iw, 12, pctWk, data.brand_color);

  // ── Reset info — dual rows (5h + weekly) ─────────────────────────
  // Row 1: 5-hour window — absolute time (left), countdown (right)
  String abs5h = formatAbsoluteReset(data.quota5h.reset_at);
  String cnt5h = getResetString(data.quota5h.reset_at);
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(ix, y + 94);
  gfx->print("5h ");
  gfx->print(abs5h);

  String inStr5h = "in " + cnt5h;
  int inW5h = inStr5h.length() * CHAR_W_SIZE1;
  gfx->setCursor(ix + iw - inW5h, y + 94);
  gfx->print(inStr5h);

  // Row 2: weekly window — day+time (left), countdown (right)
  String absWk = formatAbsoluteResetWithDay(data.quotaWeekly.reset_at);
  String cntWk = getResetString(data.quotaWeekly.reset_at);
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(ix, y + 106);
  gfx->print("wk ");
  gfx->print(absWk);

  String inStrWk = "in " + cntWk;
  int inWk = inStrWk.length() * CHAR_W_SIZE1;
  gfx->setCursor(ix + iw - inWk, y + 106);
  gfx->print(inStrWk);
}

// =====================================================================
// 📺 Overview Screen — 2x2 grid of brand cards
// =====================================================================
void drawOverviewScreen() {
  gfx->fillScreen(COLOR_DARK_BG);
  drawHeader();

  for (int row = 0; row < 2; row++) {
    int y = CARD_Y_START + row * (CARD_H + CARD_GAP);
    for (int col = 0; col < 2; col++) {
      int x = CARD_X_START + col * (CARD_W + CARD_GAP);
      int idx = row * 2 + col;
      drawBrandRow(x, y, idx, aiData[idx]);
    }
  }

  drawFooter();
  gfx->flush();
}

// =====================================================================
// ⚙️ Settings row (used inside drawSettingsScreen)
// x, y, w = position and width; label, value, sublabel rendered top to bottom
// =====================================================================
void drawSettingRow(int x, int y, int w, const char* label, const char* value, uint16_t valueColor, const char* sublabel = nullptr) {
  int h = CARD_H;

  gfx->fillRoundRect(x, y, w, h, CARD_R, COLOR_CARD_BG);
  gfx->drawRoundRect(x, y, w, h, CARD_R, COLOR_BORDER);

  int ix = x + 14;

  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(ix, y + 14);
  gfx->print(label);

  gfx->setTextSize(3);
  gfx->setTextColor(valueColor);
  gfx->setCursor(ix, y + 34);
  gfx->print(value);

  if (sublabel != nullptr) {
    gfx->setTextSize(1);
    gfx->setTextColor(COLOR_TXT_MUTED);
    gfx->setCursor(ix, y + 70);
    gfx->print(sublabel);
  }
}

// =====================================================================
// ⚙️ Settings Screen
// ┌───────────────────────────────────────┐
// │ [BRIGHTNESS]    │ [REFRESH]             │
// │ 75%             │  -> tap               │
// ├───────────────────────────────────────┤
// │ [WIFI]                                │
// │ 3PhonHome 2G  -55dBm                  │
// │ 192.168.1.42                          │
// └───────────────────────────────────────┘
// =====================================================================
void drawSettingsScreen() {
  gfx->fillScreen(COLOR_DARK_BG);
  drawHeader();

  int y = CARD_Y_START;
  int halfW = CARD_W;                               // 228
  int fullW = SCREEN_WIDTH - CARD_X_START * 2;       // 464
  int rightX = CARD_X_START + halfW + CARD_GAP;      // 242
  char buf[32];

  // 1. Brightness (left half)
  sprintf(buf, "%d%%", brightnessPct[brightnessLevel]);
  drawSettingRow(CARD_X_START, y, halfW,
                 "BRIGHTNESS",
                 buf,
                 COLOR_WHITE,
                 "tap to cycle");

  // 2. Refresh (right half)
  drawSettingRow(rightX, y, halfW,
                 "REFRESH",
                 "-> tap",
                 BRAND_GEMINI,
                 "re-fetch now");

  y += CARD_H + CARD_GAP;

  // 3. WiFi info (full width)
  if (WiFi.status() == WL_CONNECTED) {
    String ssid = WiFi.SSID();
    if ((int)ssid.length() > 26) ssid = ssid.substring(0, 26);
    sprintf(buf, "%s  %ddBm", ssid.c_str(), (int)WiFi.RSSI());
    drawSettingRow(CARD_X_START, y, fullW,
                   "WIFI",
                   buf,
                   COLOR_NET_OK,
                   WiFi.localIP().toString().c_str());
  } else {
    drawSettingRow(CARD_X_START, y, fullW,
                   "WIFI",
                   "Disconnected",
                   COLOR_NET_FAIL,
                   "tap to retry");
  }

  drawFooter();
  gfx->flush();
}

// =====================================================================
// 🔃 Loading Screen
// =====================================================================
void drawLoadingScreen() {
  gfx->fillScreen(COLOR_DARK_BG);
  drawHeader();
  drawAppLogo(SCREEN_WIDTH / 2, 150, 48, BRAND_GEMINI, COLOR_WHITE);

  gfx->setTextSize(3);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(160, 220);
  gfx->print("Loading...");

  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(150, 260);
  gfx->print("Fetching token data...");

  gfx->flush();
}

// =====================================================================
// 📶 WiFi Retry State (non-blocking retry with STOP / RETRY buttons)
// =====================================================================
#define WIFI_RETRY_INTERVAL_MS  5000    // ms between auto-retry attempts
#define WIFI_RETRY_MAX          9999    // unbounded; user can STOP

bool   wifiAutoRetry   = true;         // auto-retry on by default
int    wifiRetryCount  = 0;
unsigned long lastWifiRetryTick = 0;

void wifiStartConnect() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_STA);
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiRetryCount++;
  Serial.printf("[WIFI] Auto-retry attempt #%d (auto=%s)\n",
                wifiRetryCount, wifiAutoRetry ? "yes" : "no");
}

// Returns true the moment WiFi connects (after a non-blocking wait of ~3s)
bool wifiTickConnect() {
  if (WiFi.status() == WL_CONNECTED) return true;
  // Wait up to 3s for the connection to establish, checking every 250ms
  for (int i = 0; i < 12; i++) {
    if (WiFi.status() == WL_CONNECTED) return true;
    delay(250);
  }
  return false;
}

void drawWifiRetryScreen() {
  gfx->fillScreen(COLOR_DARK_BG);
  drawHeader();

  // Big status
  gfx->setTextSize(3);
  gfx->setTextColor(COLOR_NET_FAIL);
  gfx->setCursor(110, 70);
  gfx->print("WiFi Failed");

  // SSID info
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(20, 110);
  gfx->print("SSID: ");
  gfx->print(WIFI_SSID);

  // Retry counter (big, centered)
  gfx->setTextSize(2);
  gfx->setTextColor(COLOR_WHITE);
  char buf[32];
  sprintf(buf, "Retry attempt: #%d", wifiRetryCount);
  gfx->setCursor(20, 140);
  gfx->print(buf);

  // Auto-retry status
  gfx->setTextSize(1);
  gfx->setTextColor(wifiAutoRetry ? BRAND_GEMINI : COLOR_TXT_MUTED);
  gfx->setCursor(20, 170);
  sprintf(buf, "Auto-retry: %s (every %lus)",
          wifiAutoRetry ? "ON" : "OFF",
          WIFI_RETRY_INTERVAL_MS / 1000);
  gfx->print(buf);

  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(20, 186);
  gfx->print("Status: ");
  gfx->print(WiFi.status() == WL_CONNECTED ? "connected" : "disconnected");

  // Two buttons: STOP (left) and RETRY (right)
  int btnY = 230;
  int btnH = 50;
  int halfW = (SCREEN_WIDTH - CARD_X_START * 2 - CARD_GAP) / 2;  // 228
  int leftX  = CARD_X_START;
  int rightX = CARD_X_START + halfW + CARD_GAP;

  // STOP button (red, label changes based on state)
  gfx->fillRoundRect(leftX, btnY, halfW, btnH, 10,
                     wifiAutoRetry ? 0xC800 : 0x3186);  // red if active, dim if off
  gfx->drawRoundRect(leftX, btnY, halfW, btnH, 10, COLOR_BORDER);
  gfx->setTextSize(3);
  gfx->setTextColor(COLOR_WHITE);
  gfx->setCursor(leftX + 50, btnY + 12);
  gfx->print(wifiAutoRetry ? "STOP" : "RESUME");

  // RETRY button (green, always active)
  gfx->fillRoundRect(rightX, btnY, halfW, btnH, 10, 0x0400);  // dark green
  gfx->drawRoundRect(rightX, btnY, halfW, btnH, 10, COLOR_BORDER);
  gfx->setTextColor(COLOR_WHITE);
  gfx->setCursor(rightX + 30, btnY + 12);
  gfx->print("RETRY");

  gfx->flush();
}

// Tap handling on the WiFi retry screen (separate from main tap handler)
void handleWifiRetryTap(int x, int y) {
  int btnY = 230;
  int btnH = 50;
  int halfW = (SCREEN_WIDTH - CARD_X_START * 2 - CARD_GAP) / 2;
  int leftX  = CARD_X_START;
  int rightX = CARD_X_START + halfW + CARD_GAP;

  if (y < btnY || y > btnY + btnH) return;  // tap outside buttons

  if (x < rightX) {
    // STOP / RESUME button
    wifiAutoRetry = !wifiAutoRetry;
    Serial.printf("[WIFI] User toggled auto-retry: %s\n", wifiAutoRetry ? "ON" : "OFF");
    if (wifiAutoRetry) {
      lastWifiRetryTick = 0;  // trigger immediate retry
    }
    drawWifiRetryScreen();
  } else {
    // RETRY button — force a new attempt now and wait briefly
    bool ok = wifiTryOnce();
    Serial.printf("[WIFI] Manual retry: %s\n", ok ? "SUCCESS" : "still failing");
    if (ok) {
      useFirebase = true;
      wifiEverConnected = true;
    }
    drawWifiRetryScreen();
  }
}

// =====================================================================
// 📡 WiFi Auto-Reconnect
// =====================================================================
void handleWiFiAutoReconnect() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] สัญญาณขาดหาย! กำลังพยายามกู้คืนและเชื่อมต่อใหม่...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int reconnectAttempts = 0;
    while (WiFi.status() != WL_CONNECTED && reconnectAttempts < 8) {
      delay(500);
      Serial.print(".");
      reconnectAttempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\n[WIFI] Reconnected!");
    }
  }
}

// =====================================================================
// 🧪 PROTOTYPE (issue #8, throwaway — do NOT build the real Mac page on
// this struct/API; #10 defines the actual data model). Three structurally
// different mock layouts for the Mac System page, rendered from hardcoded
// fake data so the visual design can be judged on real hardware before the
// real data flow (#5/#6/#7) exists.
//
// Reachable from Overview: tap the footer to enter. While on this page:
//   tap header (top)  = back to Overview
//   tap footer (bottom) = cycle variant A -> B -> C
//   tap body (middle)  = toggle a fake "Mac offline" preview
// Once a variant is picked, delete this whole block + its two touch hooks
// in handleTap()/renderCurrent() and replace with the real page (#10).
// =====================================================================

#define MAC_PROTO_N       60
#define MAC_PROTO_METRICS 6
// index: 0=cpu 1=mem 2=net_down 3=net_up 4=temp 5=batt
float macProtoHist[MAC_PROTO_METRICS][MAC_PROTO_N];
bool  macProtoDataReady = false;

const char* macProtoLabel[MAC_PROTO_METRICS] = { "CPU", "MEM", "NET DN", "NET UP", "TEMP", "BATT" };
const char* macProtoUnit[MAC_PROTO_METRICS]  = { "%", "%", "KB/s", "KB/s", "C", "%" };

void macProtoGenerateFakeData() {
  // Hardcoded, deliberately varied waveforms per metric — not realistic,
  // just distinct enough that each variant has something to render, and
  // each crosses its own "bad" threshold near the end so the value/sparkline
  // color-coding is visible on the current sample too.
  for (int i = 0; i < MAC_PROTO_N; i++) {
    float t = (float)i;
    float cpu = 45 + 20 * sinf(t * 0.21f) + 8 * sinf(t * 0.9f);
    if (i > 50) cpu += (i - 50) * 5;                                       // late spike -> red
    if (cpu > 100) cpu = 100;
    macProtoHist[0][i] = cpu;
    macProtoHist[1][i] = 68 + 10 * sinf(t * 0.08f);                        // mem: slow drift
    macProtoHist[2][i] = 60 + 180 * fabsf(sinf(t * 0.5f)) * (((i / 5) % 3 == 0) ? 1.4f : 0.3f); // net down: bursty
    macProtoHist[3][i] = 20 + 60 * fabsf(sinf(t * 0.7f + 1.0f));           // net up: smaller bursts
    macProtoHist[4][i] = 68 + 14 * sinf(t * 0.15f + 2.0f);                 // temp: crosses threshold sometimes
    macProtoHist[5][i] = 30.0f - i * 0.28f;                                // batt: slow drain into red
  }
  macProtoDataReady = true;
}

uint16_t macProtoValueColor(int m, float v) {
  // Threshold coloring mirrors getBarColorForPct's spirit — red when a
  // metric is in a "bad" state. Battery is inverted (low is bad, not high).
  switch (m) {
    case 0: return v > 85 ? COLOR_NET_FAIL : COLOR_WHITE;   // cpu
    case 1: return v > 90 ? COLOR_NET_FAIL : COLOR_WHITE;   // mem
    case 4: return v > 75 ? COLOR_NET_FAIL : COLOR_WHITE;   // temp
    case 5: return v < 20 ? COLOR_NET_FAIL : COLOR_WHITE;   // batt
    default: return COLOR_WHITE;                             // network
  }
}

String macProtoValueStr(int m, float v) {
  char buf[16];
  sprintf(buf, "%d%s", (int)roundf(v), macProtoUnit[m]);
  return String(buf);
}

// ── Sparkline style 1: thin polyline (Variant A) ──────────────────────
void macProtoSparkLine(int x, int y, int w, int h, float* hist, int n, uint16_t color) {
  float mn = hist[0], mx = hist[0];
  for (int i = 1; i < n; i++) { if (hist[i] < mn) mn = hist[i]; if (hist[i] > mx) mx = hist[i]; }
  float range = (mx - mn) < 1 ? 1 : (mx - mn);
  int prevX = x, prevY = y + h - (int)((hist[0] - mn) / range * h);
  for (int i = 1; i < n; i++) {
    int cx = x + (i * w) / (n - 1);
    int cy = y + h - (int)((hist[i] - mn) / range * h);
    gfx->drawLine(prevX, prevY, cx, cy, color);
    prevX = cx; prevY = cy;
  }
}

// ── Sparkline style 2: downsampled bar chart (Variant B) ───────────────
void macProtoSparkBars(int x, int y, int w, int h, float* hist, int n, uint16_t color) {
  int bars = w / 5; if (bars < 4) bars = 4; if (bars > n) bars = n;
  int perBar = n / bars;
  float mn = hist[0], mx = hist[0];
  for (int i = 1; i < n; i++) { if (hist[i] < mn) mn = hist[i]; if (hist[i] > mx) mx = hist[i]; }
  float range = (mx - mn) < 1 ? 1 : (mx - mn);
  int barW = (w / bars) - 2; if (barW < 1) barW = 1;
  for (int b = 0; b < bars; b++) {
    float avg = 0; int cnt = 0;
    for (int i = b * perBar; i < (b + 1) * perBar && i < n; i++) { avg += hist[i]; cnt++; }
    avg = cnt ? avg / cnt : mn;
    int barH = (int)((avg - mn) / range * h);
    if (barH < 2) barH = 2;
    int bx = x + b * (w / bars);
    gfx->fillRect(bx, y + h - barH, barW, barH, color);
  }
}

// ── Sparkline style 3: filled area under a polyline (Variant C hero) ───
void macProtoSparkArea(int x, int y, int w, int h, float* hist, int n, uint16_t fillColor, uint16_t lineColor) {
  float mn = hist[0], mx = hist[0];
  for (int i = 1; i < n; i++) { if (hist[i] < mn) mn = hist[i]; if (hist[i] > mx) mx = hist[i]; }
  float range = (mx - mn) < 1 ? 1 : (mx - mn);
  for (int i = 0; i < n; i++) {
    int cx = x + (i * w) / (n - 1);
    int cy = y + h - (int)((hist[i] - mn) / range * h);
    gfx->drawLine(cx, cy, cx, y + h, fillColor);   // fill column down to baseline
  }
  for (int i = 1; i < n; i++) {
    int px = x + ((i - 1) * w) / (n - 1);
    int py = y + h - (int)((hist[i - 1] - mn) / range * h);
    int cx = x + (i * w) / (n - 1);
    int cy = y + h - (int)((hist[i] - mn) / range * h);
    gfx->drawLine(px, py, cx, cy, lineColor);
  }
}

void macProtoDrawChrome(const char* variantName) {
  drawHeader();
  gfx->fillRect(0, FOOTER_Y, SCREEN_WIDTH, FOOTER_H, COLOR_CARD_BG);
  gfx->drawFastHLine(0, FOOTER_Y, SCREEN_WIDTH, COLOR_BORDER);
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(12, FOOTER_Y + 12);
  gfx->print("tap top: back | tap bottom: ");
  gfx->print(variantName);
  gfx->print(" | tap middle: offline");
}

void macProtoDrawOfflineBanner() {
  int bw = 220, bh = 50;
  int bx = (SCREEN_WIDTH - bw) / 2, by = (SCREEN_HEIGHT - bh) / 2;
  gfx->fillRoundRect(bx, by, bw, bh, CARD_R, COLOR_CARD_BG);
  gfx->drawRoundRect(bx, by, bw, bh, CARD_R, COLOR_NET_FAIL);
  gfx->setTextSize(2);
  gfx->setTextColor(COLOR_NET_FAIL);
  gfx->setCursor(bx + 20, by + 16);
  gfx->print("MAC OFFLINE");
}

// ── Variant A: uniform row list, thin polyline sparklines ──────────────
// NOTE: the issue's assumed "5 rows of 60px" does not fit the real usable
// content area (header ends at y=36, footer starts at y=290 -> only 248px
// tall). This variant uses 6 rows (battery gets its own row rather than a
// bottom overlay) at ~38px each to actually fit.
void macProtoDrawVariantA() {
  gfx->fillScreen(COLOR_DARK_BG);
  macProtoDrawChrome("A: rows");
  int y0 = CARD_Y_START;
  int rowH = 38, gap = 3;
  int labelW = 62, valueW = 70;
  int sparkX = CARD_X_START + labelW;
  int sparkW = SCREEN_WIDTH - CARD_X_START * 2 - labelW - valueW;
  for (int m = 0; m < MAC_PROTO_METRICS; m++) {
    int y = y0 + m * (rowH + gap);
    float cur = macProtoHist[m][MAC_PROTO_N - 1];
    uint16_t color = macProtoValueColor(m, cur);

    gfx->fillRoundRect(CARD_X_START, y, SCREEN_WIDTH - CARD_X_START * 2, rowH, 6, COLOR_CARD_BG);
    gfx->setTextSize(1);
    gfx->setTextColor(COLOR_TXT_MUTED);
    gfx->setCursor(CARD_X_START + 8, y + (rowH - 8) / 2);
    gfx->print(macProtoLabel[m]);

    macProtoSparkLine(sparkX, y + 6, sparkW, rowH - 12, macProtoHist[m], MAC_PROTO_N, COLOR_NET_OK);

    String vs = macProtoValueStr(m, cur);
    gfx->setTextSize(2);
    gfx->setTextColor(color);
    int vw = vs.length() * CHAR_W_SIZE2;
    gfx->setCursor(SCREEN_WIDTH - CARD_X_START - 8 - vw, y + (rowH - 16) / 2);
    gfx->print(vs);
  }
  if (macProtoOfflineSim) macProtoDrawOfflineBanner();
  gfx->flush();
}

// ── Variant B: 2x3 card grid, downsampled bar sparklines ────────────────
// Matches the existing brand-card visual language (fillRoundRect + border).
void macProtoDrawVariantB() {
  gfx->fillScreen(COLOR_DARK_BG);
  macProtoDrawChrome("B: cards");
  int y0 = CARD_Y_START;
  int cardW = 230, cardH = 80, gap = 4;
  for (int m = 0; m < MAC_PROTO_METRICS; m++) {
    int row = m / 2, col = m % 2;
    int x = CARD_X_START + col * (cardW + gap);
    int y = y0 + row * (cardH + gap);
    float cur = macProtoHist[m][MAC_PROTO_N - 1];
    uint16_t color = macProtoValueColor(m, cur);

    gfx->fillRoundRect(x, y, cardW, cardH, CARD_R, COLOR_CARD_BG);
    gfx->drawRoundRect(x, y, cardW, cardH, CARD_R, COLOR_BORDER);

    gfx->setTextSize(1);
    gfx->setTextColor(COLOR_TXT_MUTED);
    gfx->setCursor(x + 12, y + 8);
    gfx->print(macProtoLabel[m]);

    String vs = macProtoValueStr(m, cur);
    gfx->setTextSize(2);
    gfx->setTextColor(color);
    int vw = vs.length() * CHAR_W_SIZE2;
    gfx->setCursor(x + cardW - 12 - vw, y + 6);
    gfx->print(vs);

    macProtoSparkBars(x + 10, y + 32, cardW - 20, cardH - 42, macProtoHist[m], MAC_PROTO_N, COLOR_NET_OK);
  }
  if (macProtoOfflineSim) macProtoDrawOfflineBanner();
  gfx->flush();
}

// ── Variant C: hero metric (CPU) + compact strip for the rest ──────────
// Asymmetric information hierarchy, unlike A/B's uniform treatment.
void macProtoDrawVariantC() {
  gfx->fillScreen(COLOR_DARK_BG);
  macProtoDrawChrome("C: hero");
  int y0 = CARD_Y_START;
  int heroH = 112;
  int fullW = SCREEN_WIDTH - CARD_X_START * 2;

  gfx->fillRoundRect(CARD_X_START, y0, fullW, heroH, CARD_R, COLOR_CARD_BG);
  gfx->drawRoundRect(CARD_X_START, y0, fullW, heroH, CARD_R, COLOR_BORDER);
  macProtoSparkArea(CARD_X_START + 10, y0 + 10, fullW - 20, heroH - 20,
                    macProtoHist[0], MAC_PROTO_N, COLOR_BORDER, COLOR_NET_OK);
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TXT_MUTED);
  gfx->setCursor(CARD_X_START + 16, y0 + 10);
  gfx->print("CPU");
  String heroVs = macProtoValueStr(0, macProtoHist[0][MAC_PROTO_N - 1]);
  gfx->setTextSize(4);
  gfx->setTextColor(macProtoValueColor(0, macProtoHist[0][MAC_PROTO_N - 1]));
  gfx->setCursor(CARD_X_START + 16, y0 + 30);
  gfx->print(heroVs);

  int stripY = y0 + heroH + 6;
  int stripH = FOOTER_Y - stripY;
  int tileW = 89, tileGap = 4;
  int tx = CARD_X_START;
  for (int m = 1; m < MAC_PROTO_METRICS; m++) {
    float cur = macProtoHist[m][MAC_PROTO_N - 1];
    uint16_t color = macProtoValueColor(m, cur);
    gfx->fillRoundRect(tx, stripY, tileW, stripH, 6, COLOR_CARD_BG);
    gfx->setTextSize(1);
    gfx->setTextColor(COLOR_TXT_MUTED);
    gfx->setCursor(tx + 6, stripY + 6);
    gfx->print(macProtoLabel[m]);
    gfx->setTextColor(color);
    gfx->setCursor(tx + 6, stripY + 18);
    gfx->print(macProtoValueStr(m, cur));
    macProtoSparkLine(tx + 4, stripY + stripH - 22, tileW - 8, 18, macProtoHist[m], MAC_PROTO_N, COLOR_NET_OK);
    tx += tileW + tileGap;
  }
  if (macProtoOfflineSim) macProtoDrawOfflineBanner();
  gfx->flush();
}

void drawMacPagePrototype() {
  if (!macProtoDataReady) macProtoGenerateFakeData();
  switch (macProtoVariant) {
    case 0: macProtoDrawVariantA(); break;
    case 1: macProtoDrawVariantB(); break;
    default: macProtoDrawVariantC(); break;
  }
}

// =====================================================================
// 🖼️ Render the current screen (state-based router)
// =====================================================================
void renderCurrent() {
  // WiFi not yet connected AND we've never connected: show retry screen
  if (WiFi.status() != WL_CONNECTED && !wifiEverConnected) {
    drawWifiRetryScreen();
    return;
  }
  if (!dataFetched) {
    drawLoadingScreen();
    return;
  }
  if (displayState == STATE_OVERVIEW) {
    drawOverviewScreen();
  } else if (displayState == STATE_MAC_PROTO) {
    drawMacPagePrototype();  // PROTOTYPE (issue #8)
  } else {
    drawSettingsScreen();
  }
}

// Backwards-compat alias (older call-sites may still exist)
void displayQuota(int index) {
  (void)index;
  renderCurrent();
}

// =====================================================================
// 🚀 Setup
// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== [BOOT] ESP32-S3 Power Rails Stabilized ===");

  if (psramFound()) {
    Serial.printf("[BOOT] PSRAM found: %d bytes\n", ESP.getPsramSize());
  } else {
    Serial.println("[BOOT] WARN: PSRAM not enabled. Enable 'OPI PSRAM' in Arduino Tools menu!");
  }

  // 1. Backlight LOW first (inrush protection)
  pinMode(GFX_BL, OUTPUT);
  digitalWrite(GFX_BL, LOW);
  Serial.println("[BOOT] Backlight set to LOW (Surge Protection Active)");

  // 2. Initialize Arduino_GFX (Canvas + AXS15231B QSPI)
  Serial.println("[BOOT] Initializing Arduino_GFX...");
  if (!gfx->begin()) {
    Serial.println("[BOOT] ERROR: gfx->begin() failed");
  }
  gfx->setRotation(1); // landscape 480x320
  gfx->fillScreen(COLOR_DARK_BG);

  // 3. LEDC PWM on backlight pin + apply default brightness
  ledcChannel = ledcAttach(GFX_BL, LEDC_FREQ, LEDC_RES);
  applyBrightnessLevel();

  // 4. Backlight ON
  digitalWrite(GFX_BL, HIGH);
  Serial.println("[BOOT] Backlight set to HIGH. Screen is Awake.");

  // 5. Initialize touch
  axs_touch_init();

  // Init aiData with brand info only; quota data zeroed until first Firebase fetch
  aiData[0] = {"Antigravity", BRAND_GEMINI, {0LL, 100LL, 0LL, 0LL}, {0LL, 100LL, 0LL, 0LL}};
  aiData[1] = {"Claude",     BRAND_CLAUDE,  {0LL, 100LL, 0LL, 0LL}, {0LL, 100LL, 0LL, 0LL}};
  aiData[2] = {"MiniMax",    BRAND_MINIMAX, {0LL, 100LL, 0LL, 0LL}, {0LL, 100LL, 0LL, 0LL}};
  aiData[3] = {"GLM",        BRAND_GLM,     {0LL, 100LL, 0LL, 0LL}, {0LL, 100LL, 0LL, 0LL}};

  // Show loading screen
  refreshClock();
  drawLoadingScreen();

  // Kick off first WiFi attempt (non-blocking). Loop will retry.
  initFirebase();
  useFirebase = false;  // not yet proven connected
  lastWifiRetryTick = millis();

  lastRefresh = millis();
  lastClockRefresh = millis();
  Serial.println("[BOOT] Setup successfully completed.");
}

// =====================================================================
// 📶 WiFi + NTP (non-blocking, with retry screen)
// =====================================================================

// Kick off the first connection attempt at boot. Returns immediately.
void initFirebase() {
  Serial.println("[WIFI] Initial connect attempt...");
  wifiStartConnect();
}

// Called from loop() while waiting for connection. Drives the auto-retry
// loop. Returns true once WiFi is up + NTP is synced.
bool wifiProcessConnect() {
  // Auto-retry tick
  if (wifiAutoRetry && WiFi.status() != WL_CONNECTED) {
    unsigned long now = millis();
    if (now - lastWifiRetryTick >= WIFI_RETRY_INTERVAL_MS) {
      lastWifiRetryTick = now;
      wifiStartConnect();
      return false;  // signal we just kicked off an attempt; let tickConnect run
    }
  }
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  // Connected — sync NTP (blocking, ~1s typical)
  Serial.println("[WIFI] Connected. Syncing NTP...");
  configTime(25200, 0, "pool.ntp.org", "time.nist.gov"); // GMT+7
  time_t nowt = time(nullptr);
  int ntpWait = 0;
  while (nowt < 1000000000L && ntpWait < 20) {
    delay(500);
    nowt = time(nullptr);
    ntpWait++;
  }
  refreshClock();
  wifiEverConnected = true;

  // Publish connected flag + read selected_index
  WiFiClientSecure client;
  client.setInsecure();
  {
    HTTPClient http;
    String url = String("https://") + FIREBASE_HOST + "/esp32/connected.json?auth=" + FIREBASE_AUTH;
    http.begin(client, url);
    http.addHeader("Content-Type", "application/json");
    http.PUT("true");
    http.end();
  }
  {
    HTTPClient http;
    String url = String("https://") + FIREBASE_HOST + "/esp32/selected_index.json?auth=" + FIREBASE_AUTH;
    http.begin(client, url);
    int code = http.GET();
    if (code == 200) {
      String body = http.getString();
      body.trim();
      if (body.length() > 0 && body != "null") {
        int idx = body.toInt();
        if (idx >= 0 && idx < num_ai) currentIndex = idx;
      }
    }
    http.end();
  }
  return true;
}

// One-shot connection driver used by the RETRY button — tries once, returns
// true on success, false on failure.
bool wifiTryOnce() {
  if (WiFi.status() == WL_CONNECTED) return true;
  wifiStartConnect();
  return wifiTickConnect();
}

void publishSelectedIndex(int idx) {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String("https://") + FIREBASE_HOST + "/esp32/selected_index.json?auth=" + FIREBASE_AUTH;
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  http.PUT(String(idx).c_str());
  http.end();
}

// =====================================================================
// 🖐️ Touch State
//   tap header (top 36px)  = toggle overview <-> settings
//   tap a row in settings  = interact with that setting
// =====================================================================
void handleTap(int x, int y) {
  unsigned long now = millis();
  if (now - lastTapTime < TAP_DEBOUNCE_MS) return;
  lastTapTime = now;

  // PROTOTYPE (issue #8): the Mac page mock owns its own tap zones while active.
  if (displayState == STATE_MAC_PROTO) {
    if (y < HEADER_TAP_H) {
      displayState = STATE_OVERVIEW;
    } else if (y > SCREEN_HEIGHT - FOOTER_H) {
      macProtoVariant = (macProtoVariant + 1) % 3;
    } else {
      macProtoOfflineSim = !macProtoOfflineSim;
    }
    renderCurrent();
    return;
  }

  if (y < HEADER_TAP_H) {
    // Header tap: swap screen
    displayState = (displayState == STATE_OVERVIEW) ? STATE_SETTINGS : STATE_OVERVIEW;
    renderCurrent();
    return;
  }
  if (y > SCREEN_HEIGHT - FOOTER_H) {
    // PROTOTYPE (issue #8): footer tap from Overview enters the Mac page mock
    if (displayState == STATE_OVERVIEW) {
      displayState = STATE_MAC_PROTO;
      renderCurrent();
    }
    return; // footer is hint-only otherwise
  }

  if (displayState == STATE_SETTINGS) {
    int row = (y - CARD_Y_START) / (CARD_H + CARD_GAP);

      if (row == 0) {
        // Row 0: two half-cards (Brightness left, Refresh right)
        if (x < CARD_X_START + CARD_W + CARD_GAP / 2) {
          // Brightness (left half)
          brightnessLevel = (brightnessLevel + 1) % 4;
          applyBrightnessLevel();
          renderCurrent();
        } else {
          // Refresh (right half)
          if (useFirebase && WiFi.status() == WL_CONNECTED) {
            fetchTokensFromFirebase();
            lastRefresh = millis();
          } else if (WiFi.status() != WL_CONNECTED) {
            if (wifiTryOnce()) {
              useFirebase = true;
              wifiEverConnected = true;
              fetchTokensFromFirebase();
            }
            lastRefresh = millis();
            renderCurrent();
          }
        }
      } else if (row == 1) {
      // Row 1: WiFi full width — tap to retry
      if (WiFi.status() != WL_CONNECTED) {
        if (wifiTryOnce()) {
          useFirebase = true;
          wifiEverConnected = true;
          fetchTokensFromFirebase();
        }
        lastRefresh = millis();
        renderCurrent();
      }
    }
  }
  // In overview, card taps are no-op
}

void handleTouch() {
  uint16_t tx, ty;
  bool touching = axs_touch_read(&tx, &ty);

  if (touching) {
    if (!touchActive) {
      touchActive = true;
      touchStartX = tx;
      touchStartY = ty;
    }
  } else if (touchActive) {
    touchActive = false;

    // WiFi retry screen: route taps to its button handler
    if (WiFi.status() != WL_CONNECTED && !wifiEverConnected) {
      handleWifiRetryTap(touchStartX, touchStartY);
      return;
    }
    if (dataFetched) {
      handleTap(touchStartX, touchStartY);
    }
  }
}

// =====================================================================
// 🔄 Main Loop
// =====================================================================
void loop() {
  unsigned long now = millis();

  // ─── Touch input ──────────────────────────────────────────────────
  handleTouch();

  // ─── WiFi connection driver (non-blocking, drives auto-retry) ──────
  if (WiFi.status() != WL_CONNECTED || !wifiEverConnected) {
    if (wifiProcessConnect()) {
      // Just connected: fetch data and switch to main UI
      useFirebase = true;
      if (WiFi.status() == WL_CONNECTED) {
        fetchTokensFromFirebase();
      }
      renderCurrent();
      return;
    }
    // Not connected yet: periodically re-render the retry screen
    // (so the retry counter updates and buttons refresh)
    static unsigned long lastRetryRender = 0;
    if (now - lastRetryRender >= 1000) {
      lastRetryRender = now;
      drawWifiRetryScreen();
    }
    return;
  }

  // ─── Clock refresh (cheap text compare, re-render only on change) ─
  if (now - lastClockRefresh >= CLOCK_REFRESH_MS) {
    lastClockRefresh = now;
    String prevClock = clockText;
    String prevDate  = dateText;
    refreshClock();
    if (dataFetched && (clockText != prevClock || dateText != prevDate)) {
      renderCurrent();
    }
  }

  // ─── Cloud Refresh (every 30s) ─────────────────────────────────────
  if (now - lastRefresh >= 30000) {
    lastRefresh = now;
    if (useFirebase) {
      if (WiFi.status() == WL_CONNECTED) {
        fetchTokensFromFirebase();
      } else {
        Serial.println("[LOOP] WiFi dropped, marking offline");
        useFirebase = false;
        wifiEverConnected = false;  // re-show the retry screen
        renderCurrent();
      }
    }
  }
}

// =====================================================================
// 🔥 ซิงก์ดึงข้อมูล Flat Quota ล่าสุดจาก /display/quotas
// =====================================================================
void fetchTokensFromFirebase() {
  if (!useFirebase) return;

  Serial.println("[FIREBASE] GET /display/quotas via REST...");

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String url = String("https://") + FIREBASE_HOST + "/display/quotas.json?auth=" + FIREBASE_AUTH;
  http.begin(client, url);
  http.setTimeout(8000);

  int httpCode = http.GET();
  if (httpCode == 404) {
    Serial.println("[FIREBASE] 404 — web app hasn't published yet");
    http.end();
    return;
  }
  if (httpCode != 200) {
    String errBody = http.getString();
    Serial.printf("[FIREBASE] HTTP %d: %s | body: %s\n", httpCode,
                  http.errorToString(httpCode).c_str(), errBody.c_str());
    http.end();
    return;
  }

  String body = http.getString();
  http.end();
  Serial.printf("[FIREBASE] Got %d bytes\n", body.length());

  FirebaseJson json;
  if (!json.setJsonData(body)) {
    Serial.println("[FIREBASE] Failed to parse JSON");
    return;
  }

  FirebaseJsonData jsonData;

  for (int i = 0; i < num_ai; i++) {
    String prefix = aiKeys[i] + "/";

    if (json.get(jsonData, (prefix + "name").c_str())) {
      aiData[i].name = jsonData.stringValue;
    }

    long long remaining       = getJsonInt64(json, prefix + "remaining");
    long long limitValue      = getJsonInt64(json, prefix + "limit_value");
    long long weeklyRemaining = getJsonInt64(json, prefix + "weekly_remaining");
    {
      FirebaseJsonData dbg;
      if (json.get(dbg, (prefix + "reset_at").c_str())) {
        Serial.printf("[JSON] %sreset_at type='%s' int=%d dbl=%.0f str='%s'\n",
                      prefix.c_str(), dbg.type.c_str(), dbg.intValue,
                      dbg.doubleValue, dbg.stringValue.c_str());
      } else {
        Serial.printf("[JSON] %sreset_at NOT FOUND in JSON\n", prefix.c_str());
      }
      FirebaseJsonData dbg2;
      if (json.get(dbg2, (prefix + "reset_at_weekly").c_str())) {
        Serial.printf("[JSON] %sreset_at_weekly type='%s' int=%d dbl=%.0f str='%s'\n",
                      prefix.c_str(), dbg2.type.c_str(), dbg2.intValue,
                      dbg2.doubleValue, dbg2.stringValue.c_str());
      }
    }
    long long resetAt       = getJsonInt64(json, prefix + "reset_at");
    long long resetAtWeekly = getJsonInt64(json, prefix + "reset_at_weekly");

    {
      if (resetAt       < 0) resetAt       = 0;
      if (resetAtWeekly < 0) resetAtWeekly = 0;
      if (resetAt       > 100000000000LL) resetAt       /= 1000;
      if (resetAtWeekly > 100000000000LL) resetAtWeekly /= 1000;
      time_t ntp = time(nullptr);
      if (ntp > 1000000000L) {
        long long now_ll    = (long long)ntp;
        long long maxFuture = now_ll + 90LL * 86400;
        if (resetAt       > maxFuture) resetAt       = 0;
        if (resetAtWeekly > maxFuture) resetAtWeekly = 0;
      }
    }
    Serial.printf("[FETCH] %s: reset_at=%lld reset_at_weekly=%lld\n",
                  aiKeys[i].c_str(), resetAt, resetAtWeekly);
    long long spendPct5h      = getJsonInt64(json, prefix + "spend_pct5h");
    long long spendPctWk      = getJsonInt64(json, prefix + "spend_pct_weekly");
    long long tokens5h        = getJsonInt64(json, prefix + "tokens5h");
    long long tokensWk        = getJsonInt64(json, prefix + "tokens_wk");

    String unit = "not_exposed";
    if (json.get(jsonData, (prefix + "unit").c_str())) {
      unit = jsonData.stringValue;
    }

    if (unit == "percent" && remaining >= 0 && remaining <= 100) {
      aiData[i].quota5h.total = 100;
      aiData[i].quota5h.remaining = remaining;
      aiData[i].quota5h.used = 100 - remaining;
    } else if (unit == "requests" && limitValue > 0 && remaining >= 0) {
      aiData[i].quota5h.total = limitValue;
      aiData[i].quota5h.remaining = remaining;
      aiData[i].quota5h.used = limitValue - remaining;
      if (aiData[i].quota5h.used < 0) aiData[i].quota5h.used = 0;
    } else {
      aiData[i].quota5h.total = 100;
      aiData[i].quota5h.remaining = 100 - spendPct5h;
      if (aiData[i].quota5h.remaining < 0) aiData[i].quota5h.remaining = 0;
      if (aiData[i].quota5h.remaining > 100) aiData[i].quota5h.remaining = 100;
      aiData[i].quota5h.used = spendPct5h;
    }
    aiData[i].quota5h.reset_at = resetAt;

    if (weeklyRemaining > 0 && weeklyRemaining <= 100) {
      aiData[i].quotaWeekly.total = 100;
      aiData[i].quotaWeekly.remaining = weeklyRemaining;
      aiData[i].quotaWeekly.used = 100 - weeklyRemaining;
    } else {
      aiData[i].quotaWeekly.total = 100;
      aiData[i].quotaWeekly.remaining = 100 - spendPctWk;
      if (aiData[i].quotaWeekly.remaining < 0) aiData[i].quotaWeekly.remaining = 0;
      if (aiData[i].quotaWeekly.remaining > 100) aiData[i].quotaWeekly.remaining = 100;
      aiData[i].quotaWeekly.used = spendPctWk;
    }
    aiData[i].quotaWeekly.reset_at = resetAtWeekly;

    int pct5h = calcRemainingPct(aiData[i].quota5h);
    int pctWk = calcRemainingPct(aiData[i].quotaWeekly);
    Serial.printf("[CALC] %-10s unit=%-12s | 5h:  rem=%lld tot=%lld pct=%d%% | wk: rem=%lld tot=%lld pct=%d%%\n",
                  aiKeys[i].c_str(), unit.c_str(),
                  aiData[i].quota5h.remaining,   aiData[i].quota5h.total,   pct5h,
                  aiData[i].quotaWeekly.remaining, aiData[i].quotaWeekly.total, pctWk);
  }

  Serial.print("[DEBUG] Sync OK! Antigravity 5H: ");
  Serial.print((long)aiData[0].quota5h.remaining);
  Serial.print("% | Weekly: ");
  Serial.println((long)aiData[0].quotaWeekly.remaining);

  dataFetched = true;
  renderCurrent();
}
