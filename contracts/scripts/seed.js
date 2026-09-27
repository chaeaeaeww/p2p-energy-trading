// Đăng ký các hộ + cấp token ban đầu.
//   Local:   dùng ví #1..#4 của hardhat node làm H01..H04 và in private key để import MetaMask.
//   Sepolia: đọc SEED_HOUSES trong .env, ví dụ  SEED_HOUSES=H01:0xabc...,H02:0xdef...
const hre = require("hardhat");
const { getContracts, localWallet, fmtToken } = require("./lib/common");

async function main() {
  const { ethers, network } = hre;
  const { market, token } = await getContracts(hre);
  const isLocal = network.config.chainId === 31337;
  const amount = ethers.parseUnits(process.env.SEED_TOKENS || "1000", 18);

  let houses;
  if (process.env.SEED_HOUSES) {
    houses = process.env.SEED_HOUSES.split(",").map(s => s.trim()).filter(Boolean).map(pair => {
      const [houseId, address] = pair.split(":").map(x => x.trim());
      if (!ethers.isAddress(address)) throw new Error(`Địa chỉ không hợp lệ trong SEED_HOUSES: ${pair}`);
      return { houseId, address, privateKey: null };
    });
  } else if (isLocal) {
    houses = [1, 2, 3, 4].map(i => {
      const w = localWallet(ethers, i);
      return { houseId: `H0${i}`, address: w.address, privateKey: w.privateKey };
    });
  } else {
    throw new Error("Trên Sepolia cần khai báo SEED_HOUSES=H01:0x...,H02:0x... trong file .env");
  }

  for (const h of houses) {
    const current = await market.houseOf(h.address);
    if (current) {
      console.log(`${h.houseId}: ví ${h.address} đã đăng ký là "${current}" — bỏ qua`);
    } else {
      await (await market.registerFor(h.address, h.houseId)).wait();
      console.log(`${h.houseId}: đã đăng ký ví ${h.address}`);
    }
    const bal = await token.balanceOf(h.address);
    if (bal < amount) {
      await (await token.mint(h.address, amount - bal)).wait();
    }
    console.log(`     số dư: ${fmtToken(ethers, await token.balanceOf(h.address))} SOLAR`);
  }

  if (isLocal) {
    console.log("\n=== Import vào MetaMask (mạng Hardhat Local, chainId 31337, RPC http://127.0.0.1:8545) ===");
    for (const h of houses) if (h.privateKey) console.log(`${h.houseId}  ${h.address}  ${h.privateKey}`);
    console.log("Đây là ví test công khai của Hardhat — KHÔNG dùng trên mạng thật.");
  } else {
    console.log("\nMỗi ví cần một ít SepoliaETH (faucet) để trả gas khi đặt lệnh.");
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
