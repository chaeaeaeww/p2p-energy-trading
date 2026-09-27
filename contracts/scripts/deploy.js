// Deploy EnergyToken + EnergyMarket, cấp quyền, lưu địa chỉ và tự cập nhật dashboard/.env
//   Local:   npx hardhat run scripts/deploy.js --network localhost
//   Sepolia: npx hardhat run scripts/deploy.js --network sepolia
const path = require("path");
const fs = require("fs");
const hre = require("hardhat");
const { ROOT, saveDeployment, upsertEnv, perWh } = require("./lib/common");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("Không có ví deploy. Với Sepolia hãy điền PRIVATE_KEY trong file .env ở thư mục gốc.");

  const isLocal = network.config.chainId === 31337;
  const slotDuration = BigInt(process.env.SLOT_DURATION || (isLocal ? 120 : 300));
  const penaltyBps = BigInt(process.env.PENALTY_BPS || 2000);
  const rewardPerWh = perWh(ethers, process.env.REWARD_PER_KWH || "1");
  const oracle = process.env.ORACLE_ADDRESS || deployer.address;

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Mạng: ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Ví deploy: ${deployer.address}  (${ethers.formatEther(bal)} ETH)`);

  const token = await ethers.deployContract("EnergyToken", [deployer.address]);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log(`EnergyToken  : ${tokenAddr}`);

  const market = await ethers.deployContract("EnergyMarket", [tokenAddr, slotDuration, penaltyBps, rewardPerWh, oracle]);
  const deployTx = market.deploymentTransaction();
  const receipt = await deployTx.wait();
  const marketAddr = await market.getAddress();
  console.log(`EnergyMarket : ${marketAddr}  (block ${receipt.blockNumber})`);

  // Market được mint thưởng và phạt người bán giao thiếu
  await (await token.grantRole(await token.MINTER_ROLE(), marketAddr)).wait();
  await (await token.grantRole(await token.MARKET_ROLE(), marketAddr)).wait();
  console.log(`Đã cấp MINTER_ROLE + MARKET_ROLE cho market; ORACLE_ROLE = ${oracle}`);

  const dep = {
    network: network.name,
    chainId: network.config.chainId,
    token: tokenAddr,
    market: marketAddr,
    deployBlock: receipt.blockNumber,
    deployer: deployer.address,
    oracle,
    slotDuration: Number(slotDuration),
    penaltyBps: Number(penaltyBps),
    rewardPerKwh: process.env.REWARD_PER_KWH || "1",
    deployedAt: new Date().toISOString(),
  };
  saveDeployment(network.name, dep);

  // Cập nhật file .env gốc + dashboard/.env để khỏi copy tay
  upsertEnv(path.join(ROOT, ".env"), { ENERGY_TOKEN_ADDRESS: tokenAddr, ENERGY_MARKET_ADDRESS: marketAddr });
  const dashEnv = path.join(ROOT, "dashboard", ".env");
  const dashValues = {
    VITE_CHAIN_ID: String(network.config.chainId),
    VITE_CHAIN_NAME: isLocal ? "Hardhat Local" : "Sepolia",
    VITE_ENERGY_MARKET_ADDRESS: marketAddr,
    VITE_ENERGY_TOKEN_ADDRESS: tokenAddr,
    VITE_DEPLOY_BLOCK: String(receipt.blockNumber),
    VITE_ETHERSCAN_BASE_URL: isLocal ? "" : "https://sepolia.etherscan.io",
  };
  if (isLocal) dashValues.VITE_RPC_URL = "http://127.0.0.1:8545";
  else if (!/sepolia/i.test(readEnvValue(dashEnv, "VITE_RPC_URL"))) {
    dashValues.VITE_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
  }
  upsertEnv(dashEnv, dashValues);
  console.log("Đã ghi địa chỉ vào contracts/deployments/, .env và dashboard/.env (khởi động lại `npm run dev` của dashboard).");

  if (!isLocal) {
    const args = `${marketAddr} ${tokenAddr} ${slotDuration} ${penaltyBps} ${rewardPerWh} ${oracle}`;
    if (process.env.ETHERSCAN_API_KEY) {
      console.log("Chờ 5 block rồi verify trên Etherscan...");
      await deployTx.wait(5);
      await verify(tokenAddr, [deployer.address]);
      await verify(marketAddr, [tokenAddr, slotDuration, penaltyBps, rewardPerWh, oracle]);
    } else {
      console.log("Chưa có ETHERSCAN_API_KEY. Verify thủ công:");
      console.log(`  npx hardhat verify --network ${network.name} ${tokenAddr} ${deployer.address}`);
      console.log(`  npx hardhat verify --network ${network.name} ${args}`);
    }
    console.log(`Etherscan: https://sepolia.etherscan.io/address/${marketAddr}`);
  }
}

function readEnvValue(file, key) {
  if (!fs.existsSync(file)) return "";
  const m = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

async function verify(address, constructorArguments) {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
  } catch (e) {
    console.log(`Verify ${address} lỗi: ${e.message.split("\n")[0]}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
