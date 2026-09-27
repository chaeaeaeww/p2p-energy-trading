// MQTT broker chạy bằng Node (không cần cài Mosquitto trên Windows)
//   node scripts/broker.js
//   - TCP  1883 : ESP32, simulator, AI service, bridge
//   - WS   9001 : dashboard trên trình duyệt (VITE_MQTT_WS_URL=ws://localhost:9001)
const net = require("net");
const http = require("http");
const { Aedes } = require("aedes");
const { WebSocketServer, createWebSocketStream } = require("ws");

const TCP_PORT = Number(process.env.MQTT_PORT || 1883);
const WS_PORT = Number(process.env.MQTT_WS_PORT || 9001);

(async () => {
  const broker = await Aedes.createBroker();

  net.createServer(broker.handle).listen(TCP_PORT, "0.0.0.0", () => {
    console.log(`[broker] MQTT TCP  : mqtt://0.0.0.0:${TCP_PORT}  (ESP32 dùng IP LAN của máy này)`);
  });

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws, req) => broker.handle(createWebSocketStream(ws), req));
  httpServer.listen(WS_PORT, () => console.log(`[broker] MQTT WS   : ws://localhost:${WS_PORT}`));

  broker.on("client", c => console.log(`[broker] + ${c.id}`));
  broker.on("clientDisconnect", c => console.log(`[broker] - ${c.id}`));
})();
