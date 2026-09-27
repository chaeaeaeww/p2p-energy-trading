// GIẢ LẬP TẠM tầng IoT + AI để tập dượt phần blockchain khi 2 tầng kia chưa xong.
// Khi có simulator/ESP32 thật (iot_code/) và AI service thật (ai_model/) thì KHÔNG chạy file này.
//
//   node scripts/mock-iot-ai.js
//
// - Telemetry: <prefix>/<houseId>/telemetry mỗi 2s, E_gen_Wh/E_load_Wh cộng dồn (cùng định dạng ESP32)
// - Forecast : nghe <prefix>/chain/slot (bridge publish), mỗi khi sang slot mới thì dự báo cho slot kế tiếp
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env"), quiet: true });
const mqtt = require("mqtt");

const env = process.env;
const PREFIX = env.MQTT_TOPIC_PREFIX || "p2p";
const MQTT_URL = env.MQTT_URL || `mqtt://${env.MQTT_HOST || "localhost"}:${env.MQTT_PORT || 1883}`;
const PERIOD_MS = 2000;

// Công suất trung bình (W): hộ bán có pin mặt trời lớn, hộ mua tiêu thụ nhiều
const HOUSES = (env.MOCK_HOUSES || "H01:4000:1500,H02:3500:1800,H03:400:3200,H04:300:2600")
  .split(",")
  .map(s => {
    const [id, genW, loadW] = s.split(":");
    return { id, genW: Number(genW), loadW: Number(loadW), eGen: 0, eLoad: 0 };
  });

let slotInfo = null;
let lastForecastSlot = null;

const client = mqtt.connect(MQTT_URL, { clientId: `mock_${Math.random().toString(16).slice(2, 8)}` });
client.on("connect", () => {
  console.log(`[mock] kết nối ${MQTT_URL}, hộ: ${HOUSES.map(h => h.id).join(", ")}`);
  client.subscribe(`${PREFIX}/chain/slot`);
});
client.on("error", e => console.log(`[mock] MQTT lỗi: ${e.message}`));

const jitter = pct => 1 + (Math.random() * 2 - 1) * pct;

client.on("message", (topic, msg) => {
  if (topic !== `${PREFIX}/chain/slot`) return;
  slotInfo = JSON.parse(msg.toString());
  if (slotInfo.slot === lastForecastSlot) return;
  lastForecastSlot = slotInfo.slot;
  const target = slotInfo.slot + 1;
  const hours = slotInfo.slotDuration / 3600;
  for (const h of HOUSES) {
    const payload = {
      houseId: h.id,
      slot: target,
      genPredWh: Math.round(h.genW * hours * jitter(0.1)),
      loadPredWh: Math.round(h.loadW * hours * jitter(0.1)),
      model: "mock-ai",
      ts: Math.floor(Date.now() / 1000),
    };
    client.publish(`${PREFIX}/${h.id}/forecast`, JSON.stringify(payload), { qos: 1 });
    console.log(`[mock] forecast ${h.id} slot #${target}: gen ${payload.genPredWh} Wh, load ${payload.loadPredWh} Wh`);
  }
});

setInterval(() => {
  if (!client.connected) return;
  const hours = PERIOD_MS / 3_600_000;
  for (const h of HOUSES) {
    const p = h.genW * jitter(0.25);
    const load = h.loadW * jitter(0.2);
    h.eGen += p * hours;
    h.eLoad += load * hours;
    const v = 220 * jitter(0.02);
    const payload = {
      houseId: h.id,
      ts: Math.floor(Date.now() / 1000),
      V: +v.toFixed(2),
      I: +(p / v).toFixed(3),
      P: +p.toFixed(2),
      E_gen_Wh: +h.eGen.toFixed(3),
      E_load_Wh: +h.eLoad.toFixed(3),
    };
    client.publish(`${PREFIX}/${h.id}/telemetry`, JSON.stringify(payload));
  }
}, PERIOD_MS);
