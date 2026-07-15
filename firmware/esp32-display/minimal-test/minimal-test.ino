#include <Arduino.h>

// Test backlight pin - try both HIGH and LOW
void setup() {
  Serial.begin(115200);
  delay(3000);
  Serial.println("=== Backlight Test ===");
  
  pinMode(1, OUTPUT);
  
  // Test 1: Backlight HIGH (3 seconds)
  Serial.println("Test 1: Backlight HIGH");
  digitalWrite(1, HIGH);
  delay(3000);
  
  // Test 2: Backlight LOW (3 seconds)
  Serial.println("Test 2: Backlight LOW");
  digitalWrite(1, LOW);
  delay(3000);
  
  // Test 3: Blink backlight (HIGH/LOW alternating)
  Serial.println("Test 3: Blinking backlight");
  for (int i = 0; i < 10; i++) {
    digitalWrite(1, HIGH);
    delay(200);
    digitalWrite(1, LOW);
    delay(200);
  }
  
  // Test 4: Try different backlight pins (common alternatives)
  Serial.println("Test 4: Testing alternative pins");
  int altPins[] = {2, 3, 4, 5, 38, 45};
  for (int pin : altPins) {
    Serial.print("Testing pin ");
    Serial.print(pin);
    Serial.println(" HIGH");
    pinMode(pin, OUTPUT);
    digitalWrite(pin, HIGH);
    delay(1000);
    digitalWrite(pin, LOW);
  }
  
  Serial.println("Test complete. Check Serial Monitor for results.");
}

void loop() {
  // Blink to show we're running
  delay(1000);
  Serial.println("Still running...");
}
