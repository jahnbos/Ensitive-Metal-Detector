/*
  ESP32 Magnetic Detector — FINAL (Backend-ready)
  - WS (รับคำสั่งจากเว็บ):      ws://HOST:PORT/ws/device
  - HTTP (ส่ง telemetry ไปเว็บ):  POST http://HOST:PORT/api/ingest
  - Sensor: Digital ACTIVE-LOW @ GPIO26
  - Buzzer: Active-LOW @ GPIO25
  - Servo:  GPIO13, ปัด 45° ตอน detect แล้ว detach
  - OLED:   SSD1306 I2C, SDA=21 SCL=22, addr 0x3C

  Require libs:
    - WebSockets by Markus Sattler (WebSocketsClient.h)
    - ArduinoJson v6
    - ESP32Servo
    - Adafruit SSD1306 + Adafruit GFX
*/

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>

#include <WiFi.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---------- OLED ----------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// ---------- PIN CONFIG ----------
const int SENSOR_PIN = 26;  // Digital sensor ACTIVE-LOW (LOW = detected)
const int BUZZER_PIN = 25;  // Active-LOW buzzer (LOW = beep)
const int SERVO_PIN = 13;   // Servo PWM

// ---------- SERVO BEHAVIOR ----------
const int REST_ANGLE = 0;    // มุมพัก
const int SWING_DELTA = 60;  // ปัด 45° เมื่อพบวัตถุ

Servo tap_servo;
bool servoAttached = false;
bool prevDetected = false;

// ---------- Wi-Fi / Backend ----------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char* HOST = "YOUR_BACKEND_IP";  // IP เครื่องที่รัน backend.js
const uint16_t PORT = 3100;        // พอร์ต backend.js (ปกติ 3100)

// ---------- WS (รับคำสั่ง) ----------
WebSocketsClient ws;
const char* WS_PATH = "/ws/device";

// ---------- Telemetry ----------
uint32_t lastSendMs = 0;
const uint32_t TELEMETRY_PERIOD_MS = 500;  // ส่งทุก 500 ms

// ---------- State (ซิงก์กับเว็บ) ----------
float threshold = 0.50f;  // 0..1 (เก็บไว้ให้เว็บปรับ, สำหรับ digital ไม่ได้ใช้เทียบจริง)
bool buzzer_on = false;
int servo_angle = 0;

// ---------- Helpers ----------
void showText(const char* l1, const char* l2 = nullptr) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(l1);
  if (l2) {
    display.setCursor(0, 12);
    display.println(l2);
  }
  display.display();
}

void attachServoIfNeeded() {
  if (!servoAttached) {
    tap_servo.attach(SERVO_PIN, 500, 2500);
    tap_servo.write(REST_ANGLE);
    servoAttached = true;
  }
}

void detachServoIfNeeded() {
  if (servoAttached) {
    tap_servo.detach();
    servoAttached = false;
  }
}

void setBuzzer(bool on) {
  buzzer_on = on;
  digitalWrite(BUZZER_PIN, on ? LOW : HIGH);  // Active-LOW
}

void setServoAngle(int deg) {
  servo_angle = constrain(deg, 0, 180);
  attachServoIfNeeded();
  tap_servo.write(servo_angle);
}

void beep(unsigned long ms = 150) {
  setBuzzer(true);
  delay(ms);
  setBuzzer(false);
}

bool readDetected() {
  return (digitalRead(SENSOR_PIN) == LOW);  // ACTIVE-LOW
}

void drawOLED(bool det) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("WiFi: ");
  if (WiFi.status() == WL_CONNECTED) display.print(WiFi.localIP());
  else display.print("DOWN");

  display.setCursor(0, 12);
  display.print("WS: ");
  display.print(ws.isConnected() ? "OK" : "DOWN");

  display.setCursor(0, 24);
  display.print("DET: ");
  display.print(det ? "YES" : "NO ");

  display.setCursor(0, 36);
  display.print("BZ: ");
  display.print(buzzer_on ? "ON " : "OFF");

  display.setCursor(0, 48);
  display.print("SV: ");
  display.print(servo_angle);
  display.display();
}

// ---------- HTTP: POST /api/ingest ----------
void sendTelemetryHTTP(bool detected) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  client.setTimeout(1200);
  HTTPClient http;

  String url = String("http://") + HOST + ":" + String(PORT) + "/api/ingest";
  if (!http.begin(client, url)) return;

  http.setTimeout(1500);
  http.addHeader("Content-Type", "application/json");

  // value: 0/100 สำหรับ digital sensor
  StaticJsonDocument<256> doc;
  doc["value"] = detected ? 100.0f : 0.0f;
  doc["threshold"] = threshold;
  doc["detected"] = detected;
  doc["buzzer_on"] = buzzer_on;
  doc["servo_angle"] = servo_angle;

  String body;
  serializeJson(doc, body);
  http.POST(body);
  http.end();
}

// ---------- WS callbacks (รับคำสั่งจากเว็บ) ----------
void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected ws://%s:%u%s\n", HOST, PORT, WS_PATH);
      break;

    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected");
      break;

    case WStype_TEXT:
      {
        StaticJsonDocument<256> doc;
        DeserializationError err = deserializeJson(doc, payload, length);
        if (err) {
          Serial.printf("[WS] JSON error: %s\n", err.c_str());
          return;
        }

        // คาดว่า backend ส่ง {"type":"control", ...}
        if (doc.containsKey("buzzer_on")) {
          setBuzzer((bool)doc["buzzer_on"]);
          Serial.printf("[CTRL] buzzer_on=%d\n", buzzer_on);
        }
        if (doc.containsKey("servo_angle")) {
          setServoAngle((int)doc["servo_angle"]);
          Serial.printf("[CTRL] servo_angle=%d\n", servo_angle);
        }
        if (doc.containsKey("threshold")) {
          threshold = (float)doc["threshold"];
          threshold = constrain(threshold, 0.0f, 1.0f);
          Serial.printf("[CTRL] threshold=%.2f\n", threshold);
        }
        if (doc.containsKey("beep_ms")) {
          unsigned long ms = (unsigned long)doc["beep_ms"];
          beep(min(ms, (unsigned long)2000));
        }
        break;
      }

    default: break;
  }
}

// ---------- Setup / Loop ----------
void setup() {
  Serial.begin(115200);

  // OLED
  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 init failed");
    for (;;)
      ;
  }
  display.setTextColor(SSD1306_WHITE);
  showText("BOOT", "Backend-ready");

  // IO
  pinMode(SENSOR_PIN, INPUT_PULLUP);  // ACTIVE-LOW
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);  // silent

  // Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print('.');
    delay(350);
  }
  Serial.printf("\n[WiFi] IP: %s\n", WiFi.localIP().toString().c_str());
  showText("WiFi OK", WiFi.localIP().toString().c_str());

  // WS (รับคำสั่ง)
  ws.begin(HOST, PORT, WS_PATH);  // ws://HOST:PORT/ws/device
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(5000);
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  // WS keepalive
  ws.loop();

  // อ่านเซ็นเซอร์
  bool detected = readDetected();

  // ทริกเกอร์เมื่อมีการเปลี่ยนสถานะ (สั้น ๆ เหมือนเดิม)
  if (detected && !prevDetected) {
    Serial.println("[SENSOR] DETECTED");
    showText("DETECTED");

    attachServoIfNeeded();
    tap_servo.write(REST_ANGLE + SWING_DELTA);  // ปัดไป 45°
    beep(200);

    // ค้างไว้ 10 วินาทีเต็ม
    unsigned long holdStart = millis();
    while (millis() - holdStart < 10000) {  // 10 วินาที = 5000 ms
      ws.loop();                            // ให้ยังเชื่อมต่อ WS อยู่
      drawOLED(true);                       // อัปเดตหน้าจอ OLED ระหว่างรอ
      delay(100);
    }

    // กลับมาที่มุมพัก
    tap_servo.write(REST_ANGLE);
    delay(500);
    detachServoIfNeeded();
  } else if (!detected && prevDetected) {
    Serial.println("[SENSOR] IDLE");
    showText("IDLE", "Waiting...");
    setBuzzer(false);
  }
  prevDetected = detected;

  // ส่ง telemetry เป็นคาบ
  uint32_t now = millis();
  if (now - lastSendMs >= TELEMETRY_PERIOD_MS) {
    lastSendMs = now;
    sendTelemetryHTTP(detected);  // ← ส่งค่าไปเว็บที่ /api/ingest
    drawOLED(detected);
    Serial.printf("[TX] value=%d det=%d buz=%d ang=%d th=%.2f\n",
                  detected ? 100 : 0, detected, buzzer_on, servo_angle, threshold);
  }

  delay(10);
}