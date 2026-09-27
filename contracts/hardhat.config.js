const path = require("path");
// Dùng chung file .env ở thư mục gốc repo (xem .env.example)
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
require("@nomicfoundation/hardhat-toolbox");
require("./tasks/market");

const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim();
const hasKey = /^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY);
// `npx hardhat node`: ngoài mine ngay khi có tx, cứ 3s mine 1 block rỗng để block.timestamp (=> slot) luôn chạy theo giờ thực
const isTest = process.argv.includes("test") || process.argv.includes("coverage");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowBlocksWithSameTimestamp: true, // nhiều tx trong cùng 1 giây không đẩy đồng hồ chain chạy nhanh hơn giờ thực
      mining: { auto: true, interval: isTest ? 0 : 3000 },
    },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: hasKey ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Etherscan API V2: 1 key dùng cho mọi mạng
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  sourcify: { enabled: false },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};
