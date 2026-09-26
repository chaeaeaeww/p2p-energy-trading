// Toàn bộ cấu hình đọc từ file .env (xem .env.example). Không hard-code dữ liệu giả.
const env = import.meta.env;

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const CONFIG = {
  // ===== IoT / MQTT (broker phải bật listener WebSocket) =====
  mqttUrl: env.VITE_MQTT_WS_URL || "",
  mqttUsername: env.VITE_MQTT_USERNAME || undefined,
  mqttPassword: env.VITE_MQTT_PASSWORD || undefined,
  topicPrefix: env.VITE_MQTT_TOPIC_PREFIX || "p2p",
  staleAfterSec: toInt(env.VITE_STALE_AFTER_SEC, 15),
  maxPoints: toInt(env.VITE_MAX_POINTS, 60),

  // ===== Blockchain =====
  chainId: toInt(env.VITE_CHAIN_ID, 11155111),
  chainName: env.VITE_CHAIN_NAME || "Sepolia",
  rpcUrl: env.VITE_RPC_URL || "",
  etherscanBase: env.VITE_ETHERSCAN_BASE_URL ?? "https://sepolia.etherscan.io",
  tokenAddress: env.VITE_ENERGY_TOKEN_ADDRESS || "",
  marketAddress: env.VITE_ENERGY_MARKET_ADDRESS || "",
  deployBlock: toInt(env.VITE_DEPLOY_BLOCK, 0),
  logChunk: toInt(env.VITE_LOG_CHUNK, 5000),
  pollMs: toInt(env.VITE_POLL_MS, 4000),
};

export const TOPICS = {
  telemetry: `${CONFIG.topicPrefix}/+/telemetry`,
  forecast: `${CONFIG.topicPrefix}/+/forecast`,
};

export function explorerTx(hash) {
  return CONFIG.etherscanBase ? `${CONFIG.etherscanBase}/tx/${hash}` : "";
}

export function explorerAddress(address) {
  return CONFIG.etherscanBase ? `${CONFIG.etherscanBase}/address/${address}` : "";
}
