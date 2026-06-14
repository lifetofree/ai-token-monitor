#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h> // ไลบรารีสำหรับควบคุมจอสี ST7789
#include <SPI.h>
#include <FirebaseESP32.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <stdlib.h> // สำหรับใช้ฟังก์ชันแปลงข้อความเป็นเลข 64-bit (strtoll)

// =====================================================================
// Hardware pin config
// =====================================================================
#define TFT_CS         14
#define TFT_DC         27
#define TFT_RST        33
#define BUTTON_PIN     25
#define DEBOUNCE_MS    50
#define TFT_BL         32  // backlight

// SPI hardware: MOSI=D23, SCLK=D18 (fixed for VSPI)

#define SCREEN_WIDTH   240
#define SCREEN_HEIGHT  280

// =====================================================================
// WiFi + Firebase
// =====================================================================
#include "secrets.h"  // gitignored — copy template from secrets.txt
// secrets.h defines WIFI_SSID, WIFI_PASS, FIREBASE_HOST, FIREBASE_AUTH.
// Code below uses WIFI_PASSWORD; alias it to keep call-sites unchanged.
#ifndef WIFI_PASSWORD
  #define WIFI_PASSWORD WIFI_PASS
#endif

#define DEMO_MODE false

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

// นิยามอ็อบเจกต์ของห้องสมุดสำหรับการคุมเครือข่ายและจอภาพ
// หมายเหตุ: FirebaseConfig/Auth/Data ถูกลบออกแล้ว — เราใช้ HTTPClient REST API
// แทนการเรียก Firebase streaming client เพื่อประหยัดแฟลช (FirebaseESP32 client หนักมาก)

Adafruit_ST7789 tft = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_RST);

unsigned long lastDebounce = 0;
bool lastButtonState = HIGH;
bool useFirebase = false;

// ตัวแปรจับเวลาอัปเดตข้อมูลบนคลาวด์แบบ Global เพื่อความถูกต้องของระบบ
unsigned long lastRefresh = 0;

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

// คืนค่าระดับสีของเกจวัดพลังงานตาม % โควต้าคงเหลือ (เขียว -> ส้มอมเหลือง -> แดงเตือนภัย)
uint16_t getProgressBarColor(int percent) {
  if (percent > 50)  return 0x07E0; // สัญญาณพลังงานสีเขียวปกติ
  if (percent > 20)  return 0xFDA0; // สัญญาณพลังงานสีส้มอมเหลืองเริ่มลดต่ำ
  return 0xF800;                    // สัญญาณพลังงานสีแดงขั้นวิกฤตใกล้หมดโควต้า
}

// ฟังก์ชันช่วยสกัดยอดตัวเลข 64-bit (long long) จากข้อมูลดิบ FirebaseJson เพื่อตัดปัญหาบั๊กถอดประเภทข้อมูลพลาด
long long getJsonInt64(FirebaseJson &json, const String &path) {
  FirebaseJsonData jsonData;
  if (json.get(jsonData, path.c_str())) {
    if (jsonData.type == "int") {
      return (long long)jsonData.intValue;
    } else if (jsonData.type == "double" || jsonData.type == "float") {
      return (long long)jsonData.doubleValue;
    } else if (jsonData.type == "string") {
      return strtoll(jsonData.stringValue.c_str(), NULL, 10);
    }
  }
  return 0LL;
}

// WiFi signal bars at top-right corner
void drawWiFiSignal(int x, int y) {
  if (DEMO_MODE) {
    tft.setTextSize(1);
    tft.setTextColor(COLOR_TXT_MUTED);
    tft.setCursor(x - 24, y);
    tft.print("DEMO");
    return;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    long rssi = WiFi.RSSI();
    int bars = 1;
    if (rssi > -55) bars = 4;       
    else if (rssi > -67) bars = 3;  
    else if (rssi > -78) bars = 2;  
    
    tft.fillRect(x,     y + 9,  3, 3, COLOR_NET_OK);
    tft.fillRect(x + 5, y + 6,  3, 6, (bars >= 2) ? COLOR_NET_OK : COLOR_CARD_BG);
    tft.fillRect(x + 10, y + 3, 3, 9, (bars >= 3) ? COLOR_NET_OK : COLOR_CARD_BG);
    tft.fillRect(x + 15, y,     3, 12, (bars >= 4) ? COLOR_NET_OK : COLOR_CARD_BG);
  } else {
    tft.setTextSize(1);
    tft.setTextColor(COLOR_NET_FAIL);
    tft.setCursor(x + 5, y + 2);
    tft.print("x");
  }
}

// =====================================================================
// Card layout (240x280) — matches web dashboard brand-card
// =====================================================================

#define CARD_X         6
#define CARD_Y         6
#define CARD_W         228
#define CARD_H         268
#define CARD_RADIUS    10
#define ACCENT_H       34
#define CONTENT_X      14
#define BAR_X          14
#define BAR_W          212
#define BAR_H          16
#define CHAR_W_SIZE3   18
#define CHAR_W_SIZE2   12
#define CHAR_W_SIZE1   6
#define STAT_COL_W     70

// คำนวณเปอร์เซ็นต์คงเหลือ (clamp 0..100) จากโควต้า
int calcRemainingPct(const QuotaDetails& q) {
  if (q.total <= 0) return 0;
  int pct = (int)((q.remaining * 100) / q.total);
  if (pct > 100) pct = 100;
  if (pct < 0) pct = 0;
  return pct;
}

// คำนวณเวลา "รีเซ็ต ณ เวลา" ในรูปแบบ HH:MM (ต้องซิงค์ NTP ก่อน) หรือคืน "--:--"
String formatAbsoluteReset(long long resetAt) {
  if (resetAt <= 0) return "--:--";
  time_t now = time(nullptr);
  if (now < 1000000000L) return "--:--";  // ยังไม่ได้ซิงค์ NTP
  long long secsLeft = resetAt - (long long)now;
  if (secsLeft <= 0) return "now";
  time_t t = (time_t)resetAt;
  struct tm* tmInfo = localtime(&t);
  char buf[6];
  strftime(buf, sizeof(buf), "%H:%M", tmInfo);
  return String(buf);
}

// คำนวณเวลา "รีเซ็ต ณ เวลา" ในรูปแบบ "Sun 22:00" สำหรับโควต้ารายสัปดาห์
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

// วาดเส้นประแบ่งส่วน (Dashed Divider) ตามแนวนอน
void drawDashedHLine(int x, int y, int w, uint16_t color) {
  for (int dx = 0; dx < w; dx += 6) {
    tft.drawFastHLine(x + dx, y, 3, color);
  }
}

// ย่อตัวเลขโควต้าให้สั้นและอ่านง่าย (1_500_000 -> "1.5M", 48_000 -> "48k", 500 -> "500")
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

// เลือกสีของ Progress Bar ตามลำดับความสำคัญ: สีแบรนด์ > เหลืองเตือน > แดงวิกฤต
uint16_t getBarColorForPct(int pct, uint16_t brandColor) {
  if (pct <= 20) return 0xF800;           // แดง - โควต้าใกล้หมด
  if (pct <= 50) return 0xFDA0;           // ส้มอมเหลือง - เริ่มเหลือน้อย
  return brandColor;                       // ปกติ - ใช้สีแบรนด์ (เหมือนเว็บ)
}

// วาดส่วนโควต้า (5-Hour / Weekly) สไตล์ Web Dashboard — แต่ละ section สูง 96px
// Layout (relative to yStart):
//   +0  : section title (size 1, muted)
//   +12 : big % number (size 3, colored) + "remaining" label (size 1, muted)
//   +40 : progress bar (16px)
//   +64 : stats row labels: Used | Left | Total (size 1, muted)
//   +74 : stats row values (size 1, colored)
//   +88 : reset time left-aligned, countdown right-aligned (size 1, muted)
void drawQuotaSection(int yStart, const char* title, const QuotaDetails& q, bool isWeekly, uint16_t brandColor) {
  int pct = calcRemainingPct(q);
  uint16_t barColor = getBarColorForPct(pct, brandColor);
  String countdown = getResetString(q.reset_at);
  String absoluteTime = isWeekly
    ? formatAbsoluteResetWithDay(q.reset_at)
    : formatAbsoluteReset(q.reset_at);

  // แถว 1: ชื่อหมวด (size 1, muted)
  tft.setTextSize(1);
  tft.setTextColor(COLOR_TXT_MUTED);
  tft.setCursor(CONTENT_X, yStart);
  tft.print(title);

  // แถว 2: เปอร์เซ็นต์ขนาดใหญ่ (size 3 = 24px) + "remaining" ชิดขวาตัวเลข
  char pctStr[8];
  sprintf(pctStr, "%d%%", pct);
  tft.setTextSize(3);
  tft.setTextColor(barColor);
  tft.setCursor(CONTENT_X, yStart + 12);
  tft.print(pctStr);

  // "remaining" label — baseline-aligned กับตัวเลขใหญ่
  int bigPctW = strlen(pctStr) * CHAR_W_SIZE3;
  tft.setTextSize(1);
  tft.setTextColor(COLOR_TXT_MUTED);
  tft.setCursor(CONTENT_X + bigPctW + 4, yStart + 28);
  tft.print("remaining");

  // แถว 3: Progress Bar (BAR_H=16, rounded)
  int barY = yStart + 40;
  tft.drawRoundRect(BAR_X, barY, BAR_W, BAR_H, 4, COLOR_BORDER);
  int fillW = (pct * (BAR_W - 4)) / 100;
  if (fillW > 0) {
    tft.fillRoundRect(BAR_X + 2, barY + 2, fillW, BAR_H - 4, 3, barColor);
  }

  // แถว 4: สถิติ 3 คอลัมน์ — Used | Left | Total
  // เมื่อ total==100 หมายถึง % mode: เติม "%" ต่อท้ายทุกค่าเพื่อความชัดเจน
  int statsY = barY + BAR_H + 8;  // yStart + 64
  String sfx = (q.total == 100) ? "%" : "";

  tft.setTextSize(1);
  tft.setTextColor(COLOR_TXT_MUTED);
  tft.setCursor(CONTENT_X,                 statsY); tft.print("Used");
  tft.setCursor(CONTENT_X + STAT_COL_W,   statsY); tft.print("Left");
  tft.setCursor(CONTENT_X + STAT_COL_W*2, statsY); tft.print("Total");

  tft.setCursor(CONTENT_X,                 statsY + 10);
  tft.setTextColor(COLOR_WHITE);
  tft.print(fmtTokenCount(q.used) + sfx);

  tft.setCursor(CONTENT_X + STAT_COL_W,   statsY + 10);
  tft.setTextColor(barColor);
  tft.print(fmtTokenCount(q.remaining) + sfx);

  tft.setCursor(CONTENT_X + STAT_COL_W*2, statsY + 10);
  tft.setTextColor(COLOR_WHITE);
  tft.print(fmtTokenCount(q.total) + sfx);

  // แถว 5: เวลารีเซ็ต — เวลาจริงซ้าย, นับถอยหลังขวา
  int resetY = statsY + 24;  // yStart + 88
  tft.setTextSize(1);
  tft.setTextColor(COLOR_TXT_MUTED);
  tft.setCursor(CONTENT_X, resetY);
  tft.print("Reset ");
  tft.print(absoluteTime);

  String inStr = "in " + countdown;
  int inW = inStr.length() * CHAR_W_SIZE1;
  tft.setCursor(CARD_X + CARD_W - CONTENT_X - inW, resetY);
  tft.print(inStr);
}

// วาดการ์ดแบรนด์สไตล์ Web Dashboard บนจอ 240×280
// Vertical layout (absolute y):
//   y=6..40   : Header accent stripe (ACCENT_H=34) — brand name / page / WiFi
//   y=42      : separator line
//   y=50..146 : 5-HOUR QUOTA section (96px)
//   y=152     : dashed divider
//   y=160..256: WEEKLY QUOTA section (96px)
//   y=262     : footer hint
void drawUnifiedCard(int index) {
  tft.fillScreen(COLOR_DARK_BG);
  AIData data = aiData[index];

  // ย่อชื่อแบรนด์หากยาวเกิน 8 ตัวอักษรและมีช่องว่าง
  String shortName = data.name;
  if (shortName.length() > 8 && shortName.indexOf(" ") != -1) {
    shortName = shortName.substring(0, shortName.indexOf(" "));
  }

  // 1. พื้นหลังการ์ด (rounded rect เต็ม)
  tft.fillRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, CARD_RADIUS, COLOR_CARD_BG);

  // 2. แถบสีแบรนด์ด้านบน (ACCENT_H=34) — round top, straight bottom
  tft.fillRoundRect(CARD_X, CARD_Y, CARD_W, ACCENT_H, CARD_RADIUS, data.brand_color);
  tft.fillRect(CARD_X, CARD_Y + ACCENT_H / 2, CARD_W, ACCENT_H / 2, data.brand_color);

  // 3. ชื่อแบรนด์ (size 2 = 16px tall, vertically centered in header)
  int nameY = CARD_Y + (ACCENT_H - 16) / 2;  // = 6 + 9 = 15
  tft.setTextColor(COLOR_WHITE);
  tft.setTextSize(2);
  tft.setCursor(CONTENT_X, nameY);
  tft.print(shortName);

  // 4. Page indicator (right-aligned, before WiFi icon)
  char pageStr[8];
  sprintf(pageStr, "%d/%d", index + 1, num_ai);
  int pageW = strlen(pageStr) * CHAR_W_SIZE2;
  tft.setCursor(CARD_X + CARD_W - CONTENT_X - pageW - 22, nameY);
  tft.print(pageStr);

  // 5. WiFi icon (vertically centered, WiFi bars span 12px height)
  drawWiFiSignal(CARD_X + CARD_W - 20, CARD_Y + (ACCENT_H - 12) / 2);

  // 6. เส้นแบ่งระหว่างหัวและเนื้อหา
  tft.drawFastHLine(CARD_X + 2, CARD_Y + ACCENT_H + 2, CARD_W - 4, COLOR_BORDER);

  // 7. ส่วน 5-HOUR QUOTA (yStart=50, height=96 → ends at 146)
  int y5h = CARD_Y + ACCENT_H + 10;  // = 6 + 34 + 10 = 50
  drawQuotaSection(y5h, "5-HOUR QUOTA", data.quota5h, false, data.brand_color);

  // 8. เส้นประแบ่งกลาง (y=152)
  int divY = y5h + 96 + 6;  // = 50 + 96 + 6 = 152
  drawDashedHLine(CONTENT_X, divY, CARD_W - CONTENT_X * 2, COLOR_BORDER);

  // 9. ส่วน WEEKLY QUOTA (yStart=160, height=96 → ends at 256)
  int yWk = divY + 8;  // = 160
  drawQuotaSection(yWk, "WEEKLY QUOTA", data.quotaWeekly, true, data.brand_color);

  // 10. Footer hint (y=262)
  tft.setTextSize(1);
  tft.setTextColor(COLOR_TXT_MUTED);
  const char* hint = "[press button to swap]";
  int hintW = strlen(hint) * CHAR_W_SIZE1;
  tft.setCursor((SCREEN_WIDTH - hintW) / 2, CARD_Y + CARD_H - 12);
  tft.print(hint);
}

// เก็บ drawStackedDualUI ไว้เป็น alias เพื่อไม่ให้กระทบส่วนอื่น
void drawStackedDualUI(int index) {
  drawUnifiedCard(index);
}

// =====================================================================
// 📡 ฟังก์ชันสำหรับตรวจสอบและกู้คืน WiFi อัตโนมัติ (Auto-Reconnect)
// =====================================================================
void handleWiFiAutoReconnect() {
  if (DEMO_MODE) return;
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
// 🚀 ฟังก์ชันเริ่มต้นระบบฮาร์ดแวร์และลงทะเบียนโปรแกรม (Setup)
// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(1000); // 1. ยืดเวลาหน่วง 1 วินาทีเต็ม เพื่อรอให้แรงดันไฟเลี้ยง (Power Rails) บอร์ดนิ่งสมบูรณ์แบบก่อนทำงาน
  Serial.println("\n=== [BOOT] ESP32 Power Rails Stabilized ===");
  
  // 2. ควบคุมขา Backlight ให้อยู่สถานะ LOW ทันทีก่อนบูตส่วนอื่น เพื่อลด Inrush Current ป้องกัน Watchdog Loop
  pinMode(TFT_BL, OUTPUT);
  digitalWrite(TFT_BL, LOW); 
  Serial.println("[BOOT] Backlight set to LOW (Surge Protection Active)");
  
  // 3. ทำการ Hardware Reset หน้าจอก่อนเพื่อล้างสถานะชิปค้างของ ST7789
  Serial.println("[BOOT] Resetting ST7789 Hardware...");
  pinMode(TFT_RST, OUTPUT);
  digitalWrite(TFT_RST, HIGH);
  delay(50);
  digitalWrite(TFT_RST, LOW);
  delay(120); // ดึงค่า LOW อย่างน้อย 120ms ตามคู่มือ Datasheet ของ ST7789
  digitalWrite(TFT_RST, HIGH);
  delay(120); // รอสัญญาณสลัดสปีดกลับขึ้นมาทำงาน
  
  // 4. เริ่มต้นระบบ SPI ระดับฮาร์ดแวร์โดยกำหนดขา VSPI ของ ESP32 แบบชัดเจน
  // พารามิเตอร์: SCLK=18, MISO=19 (ไม่ได้ใช้แต่ต้องระบุเพื่อให้ไลบรารีเสถียร), MOSI=23, SS/CS=14
  Serial.println("[BOOT] Configuring SPI Bus...");
  SPI.begin(18, 19, 23, 14); 

  // 5. เริ่มต้นสตาร์ทจอสี ST7789 โดยใช้โหมด SPI_MODE0 ดั้งเดิม (เสถียรที่สุดสำหรับคอนโทรลเลอร์รุ่น 1.69 นิ้ว)
  Serial.println("[BOOT] Initializing Adafruit ST7789...");
  tft.init(SCREEN_WIDTH, SCREEN_HEIGHT); 
  tft.setRotation(0); // ล็อกทิศทางแนวตั้งขอบตรง
  tft.fillScreen(COLOR_DARK_BG);
  
  // 6. เมื่อบอร์ดและจอภาพเริ่มระบบเรียบร้อย ค่อยสั่นกระแสไฟสว่าง (Backlight) ขึ้นมาทำงาน ลดไฟกระชากที่จุดสตาร์ท
  digitalWrite(TFT_BL, HIGH);
  Serial.println("[BOOT] Backlight set to HIGH. Screen is Awake.");
  
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Serial.println("[BOOT] Switched inputs configured.");
  
  // สตาร์ทค่าตัวแปรจำลองเริ่มต้น — ใช้ percent mode (total=100) ให้ตรงกับ payload
  // ที่ web app (lib/firebase.js) เผยแพร่ เพื่อให้ค่าบนจอตรงกับเว็บแดชบอร์ดเสมอ
  // แม้ตอนที่ยังไม่ได้ข้อมูลจริงจาก Firebase (เช่น WiFi หลุด)
  aiData[0] = {"Antigravity", BRAND_GEMINI, {12LL, 100LL, 88LL, 0LL}, {8LL,  100LL, 92LL, 0LL}};
  aiData[1] = {"Claude",     BRAND_CLAUDE,  {38LL, 100LL, 62LL, 0LL}, {30LL, 100LL, 70LL, 0LL}};
  aiData[2] = {"MiniMax",    BRAND_MINIMAX, {4LL,  100LL, 96LL, 0LL}, {3LL,  100LL, 97LL, 0LL}};
  aiData[3] = {"GLM",        BRAND_GLM,     {7LL,  100LL, 93LL, 0LL}, {6LL,  100LL, 94LL, 0LL}};

  // ตั้ง reset_at ให้ทุกแบรนด์เสมอ (ทั้ง DEMO_MODE และโหมด Firebase ที่ยังเชื่อมต่อไม่สำเร็จ)
  // เพื่อให้ส่วน "Reset in 2h 14m" แสดงผลได้แม้อยู่ในโหมดสาธิต/ออฟไลน์
  time_t baseTime = time(nullptr);
  if (baseTime < 1000000000L) baseTime = 1716940000L;  // fallback เมื่อ NTP ยังไม่ sync
  for (int i = 0; i < 4; i++) {
    aiData[i].quota5h.reset_at     = baseTime + 5 * 3600;        // +5h
    aiData[i].quotaWeekly.reset_at = baseTime + 6 * 86400 + 12 * 3600;  // +6d 12h
  }

  if (DEMO_MODE) {
    useFirebase = false;
  } else {
    useFirebase = initFirebase();
  }
  
  displayQuota(currentIndex);
  
  // บันทึกเวลาเมื่อบูตเสร็จสิ้น เพื่อไม่ให้ลูปดึงข้อมูลทำงานจนกว่าจะครบ 30 วินาทีถัดไป
  lastRefresh = millis();
  Serial.println("[BOOT] Setup successfully completed.");
}

// ฟังก์ชันเชื่อมต่อ WiFi และตั้งเวลา NTP Server
// ใช้ HTTPClient REST API แทน Firebase streaming client เพื่อประหยัดแฟลช
bool initFirebase() {
  Serial.println("[WIFI] Connecting to WiFi...");
  
  // 1. เคลียร์ค่าแคชการเชื่อมต่อ Wi-Fi ที่ค้างคาในชิป
  WiFi.disconnect(true);
  delay(200);
  WiFi.mode(WIFI_STA);
  delay(200);
  
  Serial.print("[WIFI] Connecting to SSID: ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    tft.fillScreen(COLOR_DARK_BG);
    tft.setTextColor(COLOR_WHITE);
    tft.setTextSize(2);
    tft.setCursor(20, 110);
    tft.print("Connecting WiFi");
    for(int p = 0; p < (attempts % 4); p++) tft.print(".");
    Serial.printf("[WIFI] Attempt %d/40... Status: %d\n", attempts + 1, WiFi.status());
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("[WIFI] Connected. Syncing NTP...");
    configTime(25200, 0, "pool.ntp.org", "time.nist.gov"); // GMT+7
    time_t now = time(nullptr);
    int ntpWait = 0;
    while (now < 1000000000L && ntpWait < 20) {
      delay(500);
      now = time(nullptr);
      ntpWait++;
    }
    
    tft.fillScreen(COLOR_DARK_BG);
    tft.setCursor(20, 90);
    tft.println("WiFi Connected!");
    tft.setCursor(20, 130);
    tft.println(WiFi.localIP().toString());
    delay(2000);
    
    // เผยแพร่สถานะเชื่อมต่อ + อ่านค่า selected_index ผ่าน REST API
    WiFiClientSecure client;
    client.setInsecure();
    
    // PUT /esp32/connected.json = true
    {
      HTTPClient http;
      String url = String("https://") + FIREBASE_HOST + "/esp32/connected.json?auth=" + FIREBASE_AUTH;
      http.begin(client, url);
      http.addHeader("Content-Type", "application/json");
      http.PUT("true");
      http.end();
    }
    
    // GET /esp32/selected_index.json  → คืนค่า 0..3 หรือ null
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
  } else {
    Serial.printf("[WIFI] Failed. Status: %d\n", WiFi.status());
    tft.fillScreen(COLOR_DARK_BG);
    tft.setCursor(20, 110);
    tft.println("WiFi Failed!");
    tft.setCursor(20, 150);
    tft.println("Using Demo Mode");
    delay(2000);
    return false;
  }
}

// บันทึกค่า selected_index ผ่าน REST API (เรียกตอนกดปุ่มสลับแบรนด์)
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
// 🔄 ลูปวนควบคุมแอปพลิเคชัน (Main Loop)
// =====================================================================
void loop() {
  bool buttonState = digitalRead(BUTTON_PIN);
  unsigned long now = millis();
  
  // ระบบป้องกันแรงกระเพื่อมสัญญาณปุ่มกดสับหน้าจอ (Debounce)
  if (buttonState != lastButtonState && now - lastDebounce > DEBOUNCE_MS) {
    if (buttonState == LOW) {
      currentIndex = (currentIndex + 1) % num_ai; 
      if (useFirebase) {
        publishSelectedIndex(currentIndex);
      }
      displayQuota(currentIndex);
    }
    lastDebounce = now;
  }
  lastButtonState = buttonState;
  
  // สแกนตรวจสอบอัปเดตสถิติคลาวด์เบื้องหลังแบบไม่รบกวนการรีเฟรชหลักของแอป
  if (now - lastRefresh >= 30000) {
    lastRefresh = now;
    if (useFirebase) {
      // เชื่อมต่ออยู่: ตรวจ WiFi + ดึงข้อมูลใหม่
      if (WiFi.status() == WL_CONNECTED) {
        fetchTokensFromFirebase();
      } else {
        Serial.println("[LOOP] WiFi dropped, marking offline");
        useFirebase = false;
        displayQuota(currentIndex);
      }
    } else if (!DEMO_MODE) {
      // ยังไม่เคยเชื่อมต่อสำเร็จ: ลองเชื่อมใหม่ทุก 30s เพื่อให้ฟื้นตัวอัตโนมัติ
      Serial.println("[LOOP] Attempting WiFi/Firebase reconnect...");
      useFirebase = initFirebase();  // จะโชว์ "WiFi Connected!" / "WiFi Failed!" บนจอชั่วคราว
      displayQuota(currentIndex);
    } else {
      // DEMO_MODE: แค่วาดใหม่เพื่อให้เวลารีเซ็ตเดิน
      displayQuota(currentIndex);
    }
  }
}

void displayQuota(int index) {
  if (index < 0 || index >= num_ai) return; 
  drawStackedDualUI(index);
}

// ซิงก์ดึงข้อมูล Flat Quota ล่าสุดจาก /display/quotas
// (ตรงกับ payload ที่ lib/firebase.js เผยแพร่: PUT ไปยัง /display.json
//  ซึ่งใน REST API ".json" ท้าย URL เป็น directive ของ Firebase — path จริงคือ /display
//  โครงสร้างข้อมูล: { lastUpdated, quotas: { gemini: {...}, claude: {...}, ... } })
//
// ใช้ HTTPClient REST โดยตรงเพราะ FirebaseESP32 library ไม่อนุญาตให้ path มี "."
// URL pattern: https://<host>/<path>.json?auth=<token>
void fetchTokensFromFirebase() {
  if (DEMO_MODE || !useFirebase) return;
  
  Serial.println("[FIREBASE] GET /display/quotas via REST...");
  
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  
  // path จริง: /display/quotas  (web app เขียน PUT /display.json → ข้อมูลอยู่ที่ /display)
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
    // log body เพื่อ debug ปัญหา 4xx/5xx
    String errBody = http.getString();
    Serial.printf("[FIREBASE] HTTP %d: %s | body: %s\n", httpCode,
                  http.errorToString(httpCode).c_str(), errBody.c_str());
    http.end();
    return;
  }
  
  String body = http.getString();
  http.end();
  Serial.printf("[FIREBASE] Got %d bytes\n", body.length());
  
  // Parse JSON ด้วย FirebaseJson (parse body string)
  FirebaseJson json;
  if (!json.setJsonData(body)) {
    Serial.println("[FIREBASE] Failed to parse JSON");
    return;
  }
  
  FirebaseJsonData jsonData;
  
  for (int i = 0; i < num_ai; i++) {
    String prefix = aiKeys[i] + "/";
    
    // 1. ชื่อแบรนด์ (web app เผยแพร่ NAMES[brand] = "Antigravity", "Claude", ...)
    if (json.get(jsonData, (prefix + "name").c_str())) {
      aiData[i].name = jsonData.stringValue;
    }
    
    // 2. อ่าน flat fields ที่ web app เผยแพร่
    long long remaining       = getJsonInt64(json, prefix + "remaining");
    long long limitValue      = getJsonInt64(json, prefix + "limit_value");
    long long weeklyRemaining = getJsonInt64(json, prefix + "weekly_remaining");
    long long resetAt         = getJsonInt64(json, prefix + "reset_at");
    long long resetAtWeekly   = getJsonInt64(json, prefix + "reset_at_weekly");
    long long spendPct5h      = getJsonInt64(json, prefix + "spend_pct5h");
    long long spendPctWk      = getJsonInt64(json, prefix + "spend_pct_weekly");
    long long tokens5h        = getJsonInt64(json, prefix + "tokens5h");
    long long tokensWk        = getJsonInt64(json, prefix + "tokens_wk");
    
    // 3. อ่าน unit (string) — "percent" / "requests" / "not_exposed" / "per_minute"
    String unit = "not_exposed";
    if (json.get(jsonData, (prefix + "unit").c_str())) {
      unit = jsonData.stringValue;
    }
    
    // 4. คำนวณ 5h quota ตาม unit (ตรงกับ web dashboard logic ใน computeApiUsedPct)
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
      // not_exposed หรือ per_minute: fallback เป็น RTK spend percentage
      aiData[i].quota5h.total = 100;
      aiData[i].quota5h.remaining = 100 - spendPct5h;
      if (aiData[i].quota5h.remaining < 0) aiData[i].quota5h.remaining = 0;
      if (aiData[i].quota5h.remaining > 100) aiData[i].quota5h.remaining = 100;
      aiData[i].quota5h.used = spendPct5h;
    }
    aiData[i].quota5h.reset_at = resetAt;
    
    // 5. คำนวณ weekly quota (web เผยแพร่ weekly_remaining เป็น percent)
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
  }
  
  Serial.print("[DEBUG] Sync OK! Antigravity 5H: ");
  Serial.print((long)aiData[0].quota5h.remaining);
  Serial.print("% | Weekly: ");
  Serial.println((long)aiData[0].quotaWeekly.remaining);
  
  displayQuota(currentIndex);
}