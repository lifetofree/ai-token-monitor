/*
 * AI Token Monitor — ESP32 OLED Companion Display
 * Hardware : ESP32 + SSD1306 0.96" OLED (128×64) + tactile button
 * Button   : GPIO 12  (short press = next page, long press = toggle auto-rotate)
 * Display  : I2C, address 0x3C
 *
 * Layout (Design A - reset times replace tokens+cost):
 *
 *   y= 0   CLAUDE           [1/4]
 *   y= 9   5h Rolling            15%
 *   y=18   2h 14m           18:42
 *   y=27   [bar 7px]
 *   y=36   Weekly                20%
 *   y=45   4d 3h           Sun 22:00
 *   y=54   [bar 7px]
 *
 * Tokens + cost no longer rendered on OLED (still on web dashboard).
 * Absolute clock needs syncNtp() success; until then column shows --:--.
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "secrets.h"

// ----------------------------- PINS & DISPLAY --------------------------------
#define BTN_PIN    12
#define OLED_RST   -1
#define SCREEN_W  128
#define SCREEN_H   64
#define OLED_ADDR 0x3C
Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, OLED_RST);

// ----------------------------- BRAND MODEL -----------------------------------
struct BrandInfo { const char* key; const char* name; const char* windowTag; };
const BrandInfo BRANDS[] = {
  { "gemini",  "Antigravity",  "5h" },
  { "claude",  "Claude",  "pm" },   // "pm" → label as "5h Rolling"
  { "minimax", "Minimax", "5h" },
  { "glm",     "GLM",     "5h" }
};
const uint8_t BRAND_COUNT = 4;

struct Quota {
  int         remaining       = -1;
  int         limitValue      = -1;
  int         weeklyRemaining = -1;
  long long   resetAt         = 0;
  long long   resetAtWeekly   = 0;
  const char* unit            = "not_exposed";
  const char* error           = nullptr;
  long long   seededAt        = 0;
  // Spend fallback (cost-% vs configured limit, computed server-side)
  int         spendPct5h      = 0;
  int         spendPctWeekly  = 0;
  int         spendReqs5h     = 0;
  int         spendReqsWk     = 0;
  // RTK token + cost data (Claude primary, others when available)
  long        tokens5h        = 0;
  float       cost5h          = 0.0f;
  long        tokensWk        = 0;
  float       costWk          = 0.0f;
};
Quota quotas[BRAND_COUNT];

// ----------------------------- STATE -----------------------------------------
uint8_t  currentPage      = 0;
bool     autoRotate       = false;
uint32_t lastRefreshMs    = 0;
uint32_t lastRotateMs     = 0;
uint32_t lastBtnChangeMs  = 0;
bool     btnPrevState     = HIGH;
uint32_t btnDownMs        = 0;
bool     timeSynced       = false;

const uint32_t REFRESH_MS    = 30UL * 1000UL;
const uint32_t ROTATE_MS     = 6UL  * 1000UL;
const uint32_t BTN_DEBOUNCE  = 50UL;
const uint32_t BTN_LONG_MS   = 1000UL;
const uint32_t RETRY_MS      = 5UL  * 1000UL;

// ----------------------------- NTP -------------------------------------------
// GMT offset in seconds (UTC+7 = 7*3600). Adjust for your timezone.
#define TZ_OFFSET_SEC  (7 * 3600)
#define DST_OFFSET_SEC 0

void syncNtp() {
  configTime(TZ_OFFSET_SEC, DST_OFFSET_SEC, "pool.ntp.org", "time.nist.gov");
  for (uint8_t i = 0; i < 20; i++) {
    time_t t; time(&t);
    if (t > 1700000000) { timeSynced = true; return; }
    delay(500);
  }
}

long long nowRealMs() {
  time_t t; time(&t);
  return (long long)t * 1000LL;
}

// ----------------------------- FIREBASE --------------------------------------
bool fetchQuotas() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String("https://") + FIREBASE_HOST + FIREBASE_PATH + "?auth=" + FIREBASE_AUTH;
  http.begin(client, url);
  http.setTimeout(8000);
  int code = http.GET();
  if (code != 200) { http.end(); return false; }

  String body = http.getString();
  http.end();

  static DynamicJsonDocument doc(6144);
  doc.clear();
  if (deserializeJson(doc, body) != DeserializationError::Ok) return false;

  JsonObject root = doc["quotas"].as<JsonObject>();
  if (root.isNull()) return false;

  for (uint8_t i = 0; i < BRAND_COUNT; i++) {
    quotas[i] = Quota();
    JsonObject q = root[BRANDS[i].key].as<JsonObject>();
    if (q.isNull()) continue;

    quotas[i].remaining       = q["remaining"]        | -1;
    quotas[i].limitValue      = q["limit_value"]      | -1;
    quotas[i].weeklyRemaining = q["weekly_remaining"] | -1;
    quotas[i].resetAt         = q["reset_at"].as<long long>()        | 0LL;
    quotas[i].resetAtWeekly   = q["reset_at_weekly"].as<long long>() | 0LL;
    quotas[i].unit            = q["unit"]             | "not_exposed";
    const char* e             = q["error"]            | "";
    quotas[i].error           = (e && strlen(e) > 0) ? e : nullptr;
    quotas[i].seededAt        = q["seeded_at"].as<long long>()       | 0LL;
    quotas[i].spendPct5h      = q["spend_pct5h"]      | 0;
    quotas[i].spendPctWeekly  = q["spend_pct_weekly"] | 0;
    quotas[i].spendReqs5h     = q["spend_reqs5h"]     | 0;
    quotas[i].spendReqsWk     = q["spend_reqs_wk"]    | 0;
    quotas[i].tokens5h        = q["tokens5h"].as<long>()   | 0L;
    quotas[i].cost5h          = q["cost5h"]           | 0.0f;
    quotas[i].tokensWk        = q["tokens_wk"].as<long>()  | 0L;
    quotas[i].costWk          = q["cost_wk"]          | 0.0f;
  }
  return true;
}

// ----------------------------- BAR & PCT HELPERS -----------------------------
// Returns 0-100 used%, or 255 = no data.
uint8_t usedPct(const Quota& q, bool weekly) {
  int rem = weekly ? q.weeklyRemaining : q.remaining;
  int lim = q.limitValue;
  int spendPct = weekly ? q.spendPctWeekly : q.spendPct5h;

  if (strcmp(q.unit, "percent") == 0 && rem >= 0)
    return (uint8_t)constrain(100 - rem, 0, 100);
  if (lim > 0 && rem >= 0)
    return (uint8_t)constrain(((lim - rem) * 100) / lim, 0, 100);
  if (spendPct > 0 || q.error == nullptr)
    return (uint8_t)constrain(spendPct, 0, 100);
  return 255;
}

void drawBar(int16_t x, int16_t y, int16_t w, int16_t h, uint8_t pct) {
  display.drawRect(x, y, w, h, SSD1306_WHITE);
  if (pct == 255) return;
  int16_t fill = (w - 2) * pct / 100;
  if (fill > 0) display.fillRect(x + 1, y + 1, fill, h - 2, SSD1306_WHITE);
}

// Compact token formatter: 1234567 → "1.2M", 48392 → "48k", 500 → "500"
void fmtTokens(long val, char* buf, size_t len) {
  if (val >= 1000000L) snprintf(buf, len, "%.1fM", val / 1000000.0f);
  else if (val >= 1000L) snprintf(buf, len, "%ldk", val / 1000L);
  else snprintf(buf, len, "%ld", val);
}

// Countdown to reset: "2h 14m", "4d 3h", "45m", "now", or "--".
String fmtCountdown(long long resetMs) {
  if (resetMs == 0) return "--";
  long long diff = resetMs - nowRealMs();
  if (diff <= 0) return "now";
  long long s = diff / 1000, m = s / 60, h = m / 60, d = h / 24;
  if (d >= 1) return String((int)d) + "d " + String((int)(h % 24)) + "h";
  if (h >= 1) return String((int)h) + "h " + String((int)(m % 60)) + "m";
  return String((int)m) + "m";
}

// Absolute reset time, 24h HH:MM in local TZ. Requires syncNtp() success.
String fmtResetClock(long long resetMs) {
  if (resetMs == 0 || !timeSynced) return "--:--";
  time_t t = (time_t)(resetMs / 1000);
  struct tm* tm = localtime(&t);
  char buf[6]; strftime(buf, sizeof(buf), "%H:%M", tm);
  return String(buf);
}

// Absolute reset time with day-of-week, for weekly windows: "Sun 22:00".
String fmtResetClockDay(long long resetMs) {
  if (resetMs == 0 || !timeSynced) return "-- --:--";
  time_t t = (time_t)(resetMs / 1000);
  struct tm* tm = localtime(&t);
  char buf[10]; strftime(buf, sizeof(buf), "%a %H:%M", tm);
  return String(buf);
}

// Age string for footer.
String fmtAge(long long seededAt) {
  if (seededAt == 0) return "--";
  long long age = nowRealMs() - seededAt;
  if (age < 0) age = 0;
  if (age < 60000LL)  return String((int)(age / 1000)) + "s";
  if (age < 3600000LL) return String((int)(age / 60000)) + "m";
  return String((int)(age / 3600000)) + "h";
}

// ----------------------------- RENDER ----------------------------------------
/*
 * Layout (Design A — label+pct on top, reset below, bar last):
 *
 *  y= 0   {Name}              [{i}/{N}]
 *  y= 9   5h Rolling               15%
 *  y=18   2h 14m              18:42        ← countdown (left), absolute (right)
 *  y=27   [full-width bar 7px]
 *  y=36   Weekly                   20%
 *  y=45   4d 3h              Sun 22:00
 *  y=54   [full-width bar 7px]
 *
 *  pct=255 sentinel means no data → shows "--%" instead of "0%".
 *  Tokens + cost no longer rendered (still on web dashboard).
 *  Reset clock needs syncNtp() success; until then absolute column shows "--:--".
 */

// Right-aligns a short string at column x=SCREEN_W.
void printRight(int16_t y, const char* str) {
  int16_t x = SCREEN_W - (int16_t)(strlen(str) * 6);
  if (x < 0) x = 0;
  display.setCursor(x, y);
  display.print(str);
}

void renderPage(uint8_t idx) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  const Quota& q = quotas[idx];
  bool isRolling = (strcmp(BRANDS[idx].windowTag, "pm") == 0);

  // --- Header: brand left, [i/N] right ---
  display.setCursor(0, 0);
  display.print(BRANDS[idx].name);
  char pageStr[8];
  snprintf(pageStr, sizeof(pageStr), "[%d/%d]", idx + 1, BRAND_COUNT);
  printRight(0, pageStr);

  // --- 5h section ---
  // Row 1: window label (left) + pct (right)
  uint8_t p5 = usedPct(q, false);
  display.setCursor(0, 9);
  display.print(isRolling ? "5h Rolling" : "5-Hour");
  char pct5Str[6];
  snprintf(pct5Str, sizeof(pct5Str), p5 < 255 ? "%d%%" : "--%", p5);
  printRight(9, pct5Str);

  // Row 2: countdown (left) + absolute reset time (right)
  display.setCursor(0, 18);
  display.print(fmtCountdown(q.resetAt));
  printRight(18, fmtResetClock(q.resetAt).c_str());

  // Row 3: full-width bar
  drawBar(0, 27, SCREEN_W, 7, p5);

  // --- Weekly section ---
  // Row 4: "Weekly" (left) + pct (right)
  uint8_t pw = usedPct(q, true);
  display.setCursor(0, 36);
  display.print("Weekly");
  char pctWStr[6];
  snprintf(pctWStr, sizeof(pctWStr), pw < 255 ? "%d%%" : "--%", pw);
  printRight(36, pctWStr);

  // Row 5: countdown (left) + day + absolute reset time (right)
  display.setCursor(0, 45);
  display.print(fmtCountdown(q.resetAtWeekly));
  printRight(45, fmtResetClockDay(q.resetAtWeekly).c_str());

  // Row 6: full-width bar
  drawBar(0, 54, SCREEN_W, 7, pw);

  display.display();
}

void renderOffline(uint32_t now) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);  display.print("Offline");
  display.setCursor(0, 12); display.print("Firebase");
  display.setCursor(0, 24); display.print("Page ");
  display.print(currentPage + 1); display.print("/"); display.print(BRAND_COUNT);
  display.setCursor(0, 44); display.print("retry ");
  display.print((REFRESH_MS - (now - lastRefreshMs)) / 1000); display.print("s");
  display.display();
}

// ----------------------------- BUTTON ----------------------------------------
void handleButton() {
  bool down = (digitalRead(BTN_PIN) == LOW);
  uint32_t now = millis();

  if (down != (btnPrevState == LOW)) {
    if (now - lastBtnChangeMs < BTN_DEBOUNCE) return;
    lastBtnChangeMs = now;

    if (down) {
      btnDownMs = now;
    } else {
      uint32_t held = now - btnDownMs;
      if (held >= BTN_LONG_MS) {
        autoRotate = !autoRotate;         // long press: toggle auto-rotate
        lastRotateMs = now;
      } else {
        currentPage = (currentPage + 1) % BRAND_COUNT;  // short press: next page
        renderPage(currentPage);
      }
    }
    btnPrevState = down ? LOW : HIGH;
  }
}

// ----------------------------- SETUP & LOOP ----------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(BTN_PIN, INPUT_PULLUP);

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("SSD1306 init failed");
    for (;;) delay(100);
  }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0); display.print("Connecting...");
  display.display();

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint8_t tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries++ < 30) delay(500);

  if (WiFi.status() == WL_CONNECTED) {
    syncNtp();
    display.clearDisplay();
    display.setCursor(0, 0); display.print("WiFi OK");
    display.setCursor(0, 10); display.print(WiFi.localIP().toString());
    display.display();
    delay(1000);

    if (fetchQuotas()) {
      renderPage(currentPage);
    } else {
      renderOffline(millis());
    }
  } else {
    renderOffline(0);
  }
  lastRefreshMs = millis();
}

void loop() {
  handleButton();

  uint32_t now = millis();

  // Auto-rotate pages
  if (autoRotate && now - lastRotateMs >= ROTATE_MS) {
    lastRotateMs = now;
    currentPage = (currentPage + 1) % BRAND_COUNT;
    renderPage(currentPage);
  }

  // Periodic refresh from Firebase
  if (now - lastRefreshMs >= REFRESH_MS) {
    lastRefreshMs = now;
    bool ok = fetchQuotas();
    if (ok) renderPage(currentPage);
    else     renderOffline(now);
  }
}
