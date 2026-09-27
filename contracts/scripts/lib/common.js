// Tiện ích dùng chung cho các script/task Hardhat.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..", ".."); // thư mục gốc repo
const DEPLOY_DIR = path.join(__dirname, "..", "..", "deployments");

// Mnemonic mặc định của `npx hardhat node` (công khai, CHỈ dùng cho mạng local)
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

function deploymentFile(networkName) {
  return path.join(DEPLOY_DIR, `${networkName}.json`);
}

function loadDeployment(networkName) {
  const file = deploymentFile(networkName);
  if (!fs.existsSync(file)) {
    throw new Error(`Chưa có ${path.relative(process.cwd(), file)} — hãy chạy deploy cho mạng "${networkName}" trước.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveDeployment(networkName, data) {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.writeFileSync(deploymentFile(networkName), JSON.stringify(data, null, 2));
}

async function getContracts(hre, signer) {
  const dep = loadDeployment(hre.network.name);
  const runner = signer || (await hre.ethers.getSigners())[0];
  const market = await hre.ethers.getContractAt("EnergyMarket", dep.market, runner);
  const token = await hre.ethers.getContractAt("EnergyToken", dep.token, runner);
  return { dep, market, token };
}

/** Ví local #index của hardhat node (có private key để import MetaMask / bridge tự giao dịch). */
function localWallet(ethers, index) {
  return ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
}

/** Giá SOLAR/kWh -> đơn vị nhỏ nhất / Wh (khớp với dashboard). */
function perWh(ethers, priceKwh, decimals = 18) {
  return ethers.parseUnits(String(priceKwh), decimals) / 1000n;
}

function fmtToken(ethers, amount, decimals = 18, digits = 4) {
  return Number(ethers.formatUnits(amount, decimals)).toFixed(digits);
}

function kwhPrice(ethers, pricePerWh, decimals = 18) {
  return Number(ethers.formatUnits(BigInt(pricePerWh) * 1000n, decimals)).toFixed(3);
}

/** Cập nhật (hoặc thêm) các dòng KEY=VALUE trong 1 file .env, giữ nguyên phần còn lại. */
function upsertEnv(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, line);
    else text += (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
  }
  fs.writeFileSync(file, text);
}

/** Tên lỗi revert dễ đọc, ví dụ "ExceedsForecast(100)". */
function revertReason(iface, e) {
  if (e?.revert) return `${e.revert.name}(${e.revert.args.join(", ")})`;
  const data = typeof e?.data === "string" ? e.data : e?.data?.data || e?.info?.error?.data;
  if (typeof data === "string") {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.join(", ")})`;
    } catch {
      /* ignore */
    }
  }
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

function now() {
  return new Date().toLocaleTimeString("vi-VN", { hour12: false });
}

function log(...args) {
  console.log(`[${now()}]`, ...args);
}

module.exports = {
  ROOT,
  HARDHAT_MNEMONIC,
  loadDeployment,
  saveDeployment,
  getContracts,
  localWallet,
  perWh,
  fmtToken,
  kwhPrice,
  upsertEnv,
  revertReason,
  log,
};
