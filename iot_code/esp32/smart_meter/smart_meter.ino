/*
 * Smart meter ESP32 — P2P Solar Energy Trading (Nhóm 08)
 * Đo V/I/P bằng INA219, cộng dồn năng lượng (Wh), publish MQTT mỗi 2 giây.
 *
 * Phần cứng:
 *   INA219 #1 (địa chỉ 0x40) — nối nối tiếp đầu ra tấm pin mặt trời  -> điện PHÁT
 *   INA219 #2 (địa chỉ 0x41, hàn jumper A0) — nối tiếp tải           -> điện DÙNG (tuỳ chọn)
 *   SDA -> GPIO21, SCL -> GPIO22, VCC -> 3V3, GND -> GND
 *
 * Thư viện (Arduino IDE > Library Manager):
 *   - PubSubClient (Nick O'Leary)
 *   - ArduinoJson (Benoit Blanchon) v7
 *   - Adafruit INA219
 *
 * Topic:   <TOPIC_PREFIX>/<HOUSE_ID>/telemetry
 * Payload: {"houseId":"H01","ts":1727350000,"V":18.2,"I":2.1,"P":38.2,"E_gen_Wh":12.4,"E_load_Wh":8.1}
 * (khớp với định dạng dữ liệu ở mục 2.3 báo cáo kỹ thuật)
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_INA219.h>
#include <time.h>

// ======= SỬA CHO ĐÚNG =======
const char* WIFI_SSID     = "TEN_WIFI";
const char* WIFI_PASSWORD = "MAT_KHAU_WIFI";
const char* MQTT_HOST     = "broker.hivemq.com";   // trùng broker với dashboard
const int   MQTT_PORT     = 1883;                  // ESP32 dùng TCP 1883, web dùng WSS 8884
const char* TOPIC_PREFIX  = "nhom08-p2p-7f3a";     // PHẢI trùng VITE_MQTT_TOPIC_PREFIX
const char* HOUSE_ID      = "H01";                 // mỗi board một ID khác nhau
const unsigned long PUBLISH_MS = 2000;
// ============================

Adafruit_INA219 inaGen(0x40);
Adafruit_INA219 inaLoad(0x41);
bool hasLoadSensor = false;

WiFiClient net;
PubSubClient mqtt(net);
char topic[96];

double eGenWh = 0, eLoadWh = 0;
unsigned long lastSample = 0, lastPublish = 0;

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf("\nIP: %s\n", WiFi.localIP().toString().c_str());
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");   // lấy giờ thật cho "ts"
}

void connectMqtt() {
  while (!mqtt.connected()) {
    String id = String("esp32-") + HOUSE_ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    Serial.printf("MQTT %s:%d ... ", MQTT_HOST, MQTT_PORT);
    if (mqtt.connect(id.c_str())) { Serial.println("OK"); }
    else { Serial.printf("lỗi rc=%d, thử lại sau 3s\n", mqtt.state()); delay(3000); }
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (!inaGen.begin()) { Serial.println("Không thấy INA219 0x40 — kiểm tra dây SDA/SCL"); while (true) delay(1000); }
  hasLoadSensor = inaLoad.begin();
  Serial.printf("INA219 tải (0x41): %s\n", hasLoadSensor ? "có" : "không");
  snprintf(topic, sizeof(topic), "%s/%s/telemetry", TOPIC_PREFIX, HOUSE_ID);
  connectWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  lastSample = millis();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  unsigned long now = millis();
  // Đo mỗi 200 ms để cộng dồn năng lượng chính xác hơn: E(Wh) += P(W) * dt(h)
  if (now - lastSample >= 200) {
    double dtH = (now - lastSample) / 3600000.0;
    lastSample = now;
    eGenWh += (inaGen.getPower_mW() / 1000.0) * dtH;
    if (hasLoadSensor) eLoadWh += (inaLoad.getPower_mW() / 1000.0) * dtH;
  }

  if (now - lastPublish >= PUBLISH_MS) {
    lastPublish = now;
    float v = inaGen.getBusVoltage_V() + inaGen.getShuntVoltage_mV() / 1000.0;
    float i = inaGen.getCurrent_mA() / 1000.0;
    float p = inaGen.getPower_mW() / 1000.0;

    JsonDocument doc;
    doc["houseId"] = HOUSE_ID;
    time_t t = time(nullptr);
    if (t > 1700000000) doc["ts"] = (uint32_t)t;   // chỉ gửi khi NTP đã đồng bộ
    doc["V"] = serialized(String(v, 2));
    doc["I"] = serialized(String(i, 3));
    doc["P"] = serialized(String(p, 2));
    doc["E_gen_Wh"] = serialized(String(eGenWh, 3));
    if (hasLoadSensor) doc["E_load_Wh"] = serialized(String(eLoadWh, 3));

    char buf[256];
    size_t n = serializeJson(doc, buf);
    bool ok = mqtt.publish(topic, (const uint8_t*)buf, n, false);
    Serial.printf("%s %s -> %s\n", ok ? "PUB" : "FAIL", topic, buf);
  }
}
