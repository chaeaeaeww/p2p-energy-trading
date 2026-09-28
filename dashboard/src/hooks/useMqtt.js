import { useEffect, useRef, useState } from "react";
import mqtt from "mqtt";
import { CONFIG, TOPICS } from "../config";
import { parseForecast, parseTelemetry } from "../lib/format";

/**
 * Kết nối broker MQTT qua WebSocket (trình duyệt không mở được TCP 1883).
 * - Raspberry Pi 4/simulator publish: <prefix>/<houseId>/telemetry
 * - AI/gateway publish:      <prefix>/<houseId>/forecast
 * Trả về dữ liệu gom theo houseId, không sinh dữ liệu giả.
 */
export function useMqtt() {
  const [status, setStatus] = useState(CONFIG.mqttUrl ? "connecting" : "not-configured");
  const [error, setError] = useState("");
  const [houses, setHouses] = useState({}); // { [houseId]: { readings: [], forecasts: [] } }
  const [lastMessageAt, setLastMessageAt] = useState(0);
  const [badMessages, setBadMessages] = useState(0);
  const clientRef = useRef(null);

  useEffect(() => {
    if (!CONFIG.mqttUrl) return undefined;

    const client = mqtt.connect(CONFIG.mqttUrl, {
      clientId: `dashboard_${Math.random().toString(16).slice(2, 10)}`,
      username: CONFIG.mqttUsername,
      password: CONFIG.mqttPassword,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      clean: true,
    });
    clientRef.current = client;
    const warned = new Set();

    client.on("connect", () => {
      setStatus("connected");
      setError("");
      client.subscribe([TOPICS.telemetry, TOPICS.forecast], { qos: 1 }, err => {
        if (err) setError(`Subscribe lỗi: ${err.message}`);
      });
    });
    client.on("reconnect", () => setStatus("connecting"));
    client.on("offline", () => setStatus("offline"));
    client.on("close", () => setStatus(s => (s === "connected" ? "offline" : s)));
    client.on("error", err => setError(err?.message || String(err)));

    client.on("message", (topic, message) => {
      const kind = topic.split("/").pop();
      try {
        if (kind === "telemetry") {
          const r = parseTelemetry(topic, message.toString());
          setHouses(prev => {
            const h = prev[r.houseId] || { readings: [], forecasts: [] };
            return { ...prev, [r.houseId]: { ...h, readings: [...h.readings, r].slice(-CONFIG.maxPoints) } };
          });
        } else if (kind === "forecast") {
          const f = parseForecast(topic, message.toString());
          setHouses(prev => {
            const h = prev[f.houseId] || { readings: [], forecasts: [] };
            const rest = f.slot ? h.forecasts.filter(x => x.slot !== f.slot) : h.forecasts;
            return { ...prev, [f.houseId]: { ...h, forecasts: [...rest, f].slice(-48) } };
          });
        } else {
          return;
        }
        setLastMessageAt(Date.now());
      } catch (e) {
        setBadMessages(n => n + 1);
        if (!warned.has(topic)) {
          warned.add(topic);
          console.warn("[MQTT] bỏ qua message sai định dạng", topic, e.message);
        }
      }
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, []);

  return { status, error, houses, lastMessageAt, badMessages };
}
