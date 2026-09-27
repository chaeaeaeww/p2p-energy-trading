// Lệnh điều khiển nhanh khi demo (chạy được trên cả CMD/PowerShell):
//   npx hardhat status  --network localhost
//   npx hardhat advance --network localhost [--seconds 120]
//   npx hardhat close   --network localhost --slot 123
//   npx hardhat report  --network localhost --slot 123 --house H01 --produced 900 --consumed 450
//   npx hardhat settle  --network localhost --slot 123
const { task, types } = require("hardhat/config");

function lib() {
  return require("../scripts/lib/common");
}

task("status", "Xem slot hiện tại, các slot gần đây và số dư các hộ")
  .addOptionalParam("slots", "Số slot gần nhất cần xem", 4, types.int)
  .setAction(async ({ slots }, hre) => {
    const { getContracts, fmtToken, kwhPrice } = lib();
    const { ethers } = hre;
    const { dep, market, token } = await getContracts(hre);
    const cur = await market.currentSlot();
    const block = await ethers.provider.getBlock("latest");
    console.log(`Market ${dep.market} | slot ${dep.slotDuration}s | slot hiện tại #${cur} | block ${block.number}`);
    const secLeft = Number((cur + 1n) * BigInt(dep.slotDuration)) - block.timestamp;
    console.log(`Còn ~${secLeft}s tới slot #${cur + 1n}\n`);

    for (let s = cur - BigInt(slots - 2); s <= cur + 1n; s++) {
      if (s < 0n) continue;
      const info = await market.slotInfo(s);
      const orders = await market.getOrders(s);
      const state = info.settled ? "đã thanh toán" : info.closed ? "đã khớp, chờ thanh toán" : "đang mở";
      console.log(`Slot #${s}: ${orders.length} lệnh | ${state} | khớp ${info.matchedWh} Wh @ ${kwhPrice(ethers, info.clearingPricePerWh)} SOLAR/kWh`);
      for (const o of orders) {
        console.log(`   #${o.id} ${o.isBid ? "MUA" : "BÁN"} ${await market.houseOf(o.trader)} ${o.qtyWh} Wh @ ${kwhPrice(ethers, o.pricePerWh)} (khớp ${o.filledWh})`);
      }
    }

    const regs = await market.queryFilter(market.filters.HouseRegistered(), dep.deployBlock);
    console.log("\nSố dư:");
    for (const e of regs) {
      console.log(`   ${e.args.houseId.padEnd(5)} ${e.args.account}  ${fmtToken(ethers, await token.balanceOf(e.args.account))} SOLAR`);
    }
    console.log(`   escrow market ${fmtToken(ethers, await token.balanceOf(dep.market))} SOLAR`);
  });

task("advance", "[Chỉ local] Tua thời gian blockchain")
  .addOptionalParam("seconds", "Số giây (mặc định = 1 slot)", 0, types.int)
  .setAction(async ({ seconds }, hre) => {
    if (hre.network.config.chainId !== 31337) throw new Error("Chỉ tua được thời gian trên mạng local");
    const { getContracts } = lib();
    const { dep, market } = await getContracts(hre);
    const sec = seconds || dep.slotDuration;
    const before = await market.currentSlot();
    await hre.network.provider.send("evm_increaseTime", [sec]);
    await hre.network.provider.send("evm_mine", []);
    console.log(`Đã tua ${sec}s: slot #${before} -> #${await market.currentSlot()}`);
  });

task("close", "Đóng phiên và khớp lệnh của 1 slot")
  .addParam("slot", "Số slot", undefined, types.string)
  .setAction(async ({ slot }, hre) => {
    const { getContracts, kwhPrice } = lib();
    const { market } = await getContracts(hre);
    await (await market.closeAuction(BigInt(slot))).wait();
    const info = await market.slotInfo(BigInt(slot));
    console.log(`Slot #${slot}: khớp ${info.matchedWh} Wh, giá clearing ${kwhPrice(hre.ethers, info.clearingPricePerWh)} SOLAR/kWh`);
  });

task("report", "Oracle gửi tay chỉ số công tơ (dự phòng khi IoT lỗi)")
  .addParam("slot", "Số slot", undefined, types.string)
  .addParam("house", "Mã hộ, ví dụ H01")
  .addParam("produced", "Wh sản xuất", undefined, types.int)
  .addParam("consumed", "Wh tiêu thụ", 0, types.int)
  .setAction(async ({ slot, house, produced, consumed }, hre) => {
    const { getContracts } = lib();
    const { market } = await getContracts(hre);
    const account = await market.accountOf(house);
    if (account === hre.ethers.ZeroAddress) throw new Error(`Hộ ${house} chưa đăng ký`);
    await (await market.reportMeter(BigInt(slot), account, produced, consumed)).wait();
    console.log(`Đã ghi công tơ ${house} slot #${slot}: sản xuất ${produced} Wh, tiêu thụ ${consumed} Wh`);
  });

task("settle", "Thanh toán 1 slot đã khớp")
  .addParam("slot", "Số slot", undefined, types.string)
  .setAction(async ({ slot }, hre) => {
    const { getContracts, fmtToken } = lib();
    const { market } = await getContracts(hre);
    const rc = await (await market.settle(BigInt(slot))).wait();
    for (const l of rc.logs) {
      const e = (() => { try { return market.interface.parseLog(l); } catch { return null; } })();
      if (e?.name === "Settled") {
        console.log(`Settled: ${await market.houseOf(e.args.seller)} -> ${await market.houseOf(e.args.buyer)} giao ${e.args.deliveredWh} Wh, trả ${fmtToken(hre.ethers, e.args.payment)}, phạt ${fmtToken(hre.ethers, e.args.penalty)}`);
      }
      if (e?.name === "RewardPaid") console.log(`Thưởng ${await market.houseOf(e.args.account)}: ${fmtToken(hre.ethers, e.args.amount)} SOLAR`);
    }
  });

task("addhouse", "[Chỉ local] Gắn 1 ví MetaMask bất kỳ thành hộ mới: nạp ETH trả gas, đăng ký, cấp SOLAR")
  .addParam("house", "Mã hộ mới, ví dụ H05")
  .addParam("address", "Địa chỉ ví đầy đủ (copy từ MetaMask)")
  .addOptionalParam("eth", "Số ETH nạp để trả gas", "10")
  .addOptionalParam("solar", "Số SOLAR cấp", "1000")
  .setAction(async ({ house, address, eth, solar }, hre) => {
    if (hre.network.config.chainId !== 31337) throw new Error("Lệnh này chỉ dùng cho mạng local. Trên Sepolia dùng SEED_HOUSES + seed.js");
    const { ethers } = hre;
    if (!ethers.isAddress(address)) throw new Error(`Địa chỉ không hợp lệ: ${address}`);
    const { getContracts, fmtToken } = lib();
    const { market, token } = await getContracts(hre);
    const [admin] = await ethers.getSigners();

    await (await admin.sendTransaction({ to: address, value: ethers.parseEther(eth) })).wait();
    console.log(`Đã nạp ${eth} ETH (để trả gas) cho ${address}`);

    const current = await market.houseOf(address);
    if (current) {
      console.log(`Ví này đã đăng ký là "${current}" — bỏ qua bước đăng ký`);
    } else {
      const owner = await market.accountOf(house);
      if (owner !== ethers.ZeroAddress) throw new Error(`Mã ${house} đã thuộc về ví ${owner}. Chọn mã khác, ví dụ H06`);
      await (await market.registerFor(address, house)).wait();
      console.log(`Đã đăng ký ${address} là hộ ${house}`);
    }

    await (await token.mint(address, ethers.parseUnits(solar, 18))).wait();
    console.log(`Đã cấp ${solar} SOLAR. Số dư: ${fmtToken(ethers, await token.balanceOf(address))} SOLAR`);
  });
