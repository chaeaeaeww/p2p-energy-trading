// Chạy trọn 1 phiên giao dịch trên mạng LOCAL, không cần MQTT (tập dượt / kiểm tra nhanh / phương án dự phòng)
//   npx hardhat run scripts/demo-flow.js --network localhost
// Cần chạy deploy.js và seed.js trước. Dashboard đang mở sẽ thấy toàn bộ event.
const hre = require("hardhat");
const { getContracts, localWallet, perWh, fmtToken, kwhPrice, revertReason } = require("./lib/common");

const pause = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { ethers, network } = hre;
  if (network.config.chainId !== 31337) throw new Error("demo-flow chỉ chạy trên mạng local (có tua thời gian)");
  const { dep, market, token } = await getContracts(hre);
  const w = i => localWallet(ethers, i).connect(ethers.provider);
  const H = { H01: w(1), H02: w(2), H03: w(3), H04: w(4) };
  for (const [id, wallet] of Object.entries(H)) {
    if ((await market.houseOf(wallet.address)) !== id) throw new Error(`Ví ${wallet.address} chưa đăng ký ${id} — chạy seed.js trước`);
  }
  const bal = async () => {
    const out = {};
    for (const [id, wallet] of Object.entries(H)) out[id] = await token.balanceOf(wallet.address);
    return out;
  };
  const b0 = await bal();
  const slot = (await market.currentSlot()) + 1n;
  const step = async (label, fn) => {
    const rc = await (await fn()).wait();
    console.log(`  ✔ ${label}  (block ${rc.blockNumber})`);
    await pause(700);
  };

  console.log(`\n[1] AI gửi dự báo cho slot #${slot} (oracle -> submitForecast)`);
  await step("H01 dự báo: sản xuất 1000 Wh, tiêu thụ 400 Wh (dư 600)", () => market.submitForecast(slot, H.H01.address, 1000, 400));
  await step("H02 dự báo: sản xuất 800 Wh, tiêu thụ 450 Wh (dư 350)", () => market.submitForecast(slot, H.H02.address, 800, 450));

  console.log("\n[2] Các hộ đặt lệnh (người mua approve + khoá token escrow)");
  await step("H01 BÁN 500 Wh @ 2.0 SOLAR/kWh", () => market.connect(H.H01).placeAsk(slot, 500, perWh(ethers, "2.0")));
  await step("H02 BÁN 300 Wh @ 2.4 SOLAR/kWh", () => market.connect(H.H02).placeAsk(slot, 300, perWh(ethers, "2.4")));
  for (const id of ["H03", "H04"]) {
    await step(`${id} approve`, () => token.connect(H[id]).approve(dep.market, ethers.MaxUint256));
  }
  await step("H03 MUA 400 Wh @ 3.0 SOLAR/kWh", () => market.connect(H.H03).placeBid(slot, 400, perWh(ethers, "3.0")));
  await step("H04 MUA 300 Wh @ 2.2 SOLAR/kWh", () => market.connect(H.H04).placeBid(slot, 300, perWh(ethers, "2.2")));
  console.log("  ✘ Thử lỗi: H01 bán thêm 200 Wh (vượt dự báo AI)...");
  try {
    await market.connect(H.H01).placeAsk.staticCall(slot, 200, perWh(ethers, "2.0"));
  } catch (e) {
    console.log(`     -> revert ${revertReason(market.interface, e)}`);
  }

  console.log(`\n[3] Đóng phiên slot #${slot} và khớp lệnh (đấu giá đôi giá đồng nhất)`);
  await step("closeAuction", () => market.closeAuction(slot));
  const info = await market.slotInfo(slot);
  console.log(`  -> khớp ${info.matchedWh} Wh, giá clearing ${kwhPrice(ethers, info.clearingPricePerWh)} SOLAR/kWh`);
  for (const t of await market.getTrades(slot)) {
    console.log(`     ${await market.houseOf(t.seller)} -> ${await market.houseOf(t.buyer)}: ${t.qtyWh} Wh`);
  }

  console.log("\n[4] Tua thời gian tới khi slot kết thúc, IoT báo chỉ số công tơ thực tế");
  const endTs = Number((slot + 1n) * BigInt(dep.slotDuration));
  const latest = await ethers.provider.getBlock("latest");
  if (latest.timestamp < endTs) {
    await ethers.provider.send("evm_increaseTime", [endTs - latest.timestamp]);
    await ethers.provider.send("evm_mine", []);
  }
  await step("H01 thực tế: sản xuất 900 Wh, tiêu thụ 450 Wh (chỉ giao được 450/500 Wh)", () => market.reportMeter(slot, H.H01.address, 900, 450));

  console.log(`\n[5] Thanh toán slot #${slot}`);
  const rc = await (await market.settle(slot)).wait();
  for (const l of rc.logs) {
    let e = null;
    try { e = market.interface.parseLog(l); } catch { e = null; }
    if (e?.name === "Settled") {
      console.log(`  Settled ${await market.houseOf(e.args.seller)} -> ${await market.houseOf(e.args.buyer)}: giao ${e.args.deliveredWh} Wh, trả ${fmtToken(ethers, e.args.payment)}, phạt ${fmtToken(ethers, e.args.penalty)}`);
    }
    if (e?.name === "RewardPaid") console.log(`  RewardPaid ${await market.houseOf(e.args.account)}: ${fmtToken(ethers, e.args.amount)} SOLAR`);
  }

  const b1 = await bal();
  console.log("\n[6] Số dư SOLAR trước -> sau");
  for (const id of Object.keys(H)) {
    const d = b1[id] - b0[id];
    console.log(`  ${id}: ${fmtToken(ethers, b0[id])} -> ${fmtToken(ethers, b1[id])}  (${d >= 0n ? "+" : ""}${fmtToken(ethers, d)})`);
  }
  console.log(`  escrow còn trong market: ${fmtToken(ethers, await token.balanceOf(dep.market))}`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
