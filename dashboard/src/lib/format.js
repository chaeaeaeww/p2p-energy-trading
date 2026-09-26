import { ethers } from "ethers";

export function shorten(value, head = 6, tail = 4) {
  if (!value) return "—";
  return value.length > head + tail + 3 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function num(...candidates) {
  for (const c of candidates) {
    if (c === undefined || c === null || c === "") continue;
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Timestamp chấp nhận giây (ESP32 thường gửi epoch giây) hoặc mili-giây.
function toMs(ts) {
  const n = num(ts);
  if (n === null) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Chuẩn hoá payload telemetry từ ESP32/simulator.
 * Topic: <prefix>/<houseId>/telemetry
 * Chấp nhận cả khoá ngắn (V, I, P, ts) lẫn khoá dài (voltage, current, power, timestamp).
 */
export function parseTelemetry(topic, raw) {
  const payload = JSON.parse(raw);
  const houseId = String(payload.houseId ?? payload.house_id ?? topic.split("/")[1] ?? "unknown");
  const voltage = num(payload.V, payload.voltage);
  const current = num(payload.I, payload.current);
  let power = num(payload.P, payload.power);
  if (power === null && voltage !== null && current !== null) power = voltage * current;
  const genWh = num(payload.E_gen_Wh, payload.energyGenWh, payload.gen_wh);
  const loadWh = num(payload.E_load_Wh, payload.energyLoadWh, payload.load_wh);
  if (voltage === null && current === null && power === null && genWh === null) {
    throw new Error("payload thiếu V/I/P");
  }
  return {
    houseId,
    ts: toMs(payload.ts ?? payload.timestamp),
    receivedAt: Date.now(),
    voltage,
    current,
    power,
    genWh,
    loadWh,
    surplusWh: genWh !== null && loadWh !== null ? genWh - loadWh : num(payload.surplusWh, payload.surplus_wh),
  };
}

/**
 * Chuẩn hoá payload dự báo do AI service / gateway publish.
 * Topic: <prefix>/<houseId>/forecast
 * Ví dụ: {"houseId":"H01","slot":123,"genPredWh":420,"loadPredWh":300,"ts":1727350000}
 */
export function parseForecast(topic, raw) {
  const payload = JSON.parse(raw);
  const houseId = String(payload.houseId ?? payload.house_id ?? topic.split("/")[1] ?? "unknown");
  const genPredWh = num(payload.genPredWh, payload.gen_pred_wh, payload.gen_pred);
  const loadPredWh = num(payload.loadPredWh, payload.load_pred_wh, payload.load_pred);
  if (genPredWh === null && loadPredWh === null) throw new Error("payload thiếu genPredWh/loadPredWh");
  return {
    houseId,
    slot: payload.slot !== undefined ? String(payload.slot) : null,
    ts: toMs(payload.ts ?? payload.timestamp),
    genPredWh,
    loadPredWh,
    surplusPredWh: num(payload.surplusPredWh) ?? (genPredWh ?? 0) - (loadPredWh ?? 0),
    model: payload.model ?? null,
  };
}

export function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("vi-VN", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ago(ms, now = Date.now()) {
  if (!ms) return "chưa có";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  return `${Math.floor(s / 3600)} giờ trước`;
}

// Giá lưu on-chain theo đơn vị nhỏ nhất của token / Wh; UI hiển thị token / kWh.
export function pricePerKwhToPerWh(priceKwh, decimals) {
  const perKwh = ethers.parseUnits(String(priceKwh), decimals);
  return perKwh / 1000n;
}

export function pricePerWhToKwh(pricePerWh, decimals) {
  return ethers.formatUnits(BigInt(pricePerWh) * 1000n, decimals);
}

export function formatToken(amount, decimals, digits = 4) {
  if (amount === null || amount === undefined) return "—";
  return fmt(Number(ethers.formatUnits(amount, decimals)), digits);
}

export function errorMessage(e) {
  return (
    e?.info?.error?.message ||
    e?.reason ||
    e?.shortMessage ||
    e?.error?.message ||
    e?.message ||
    "Lỗi không xác định"
  );
}
