const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const SLOT = 300n; // 5 phút / slot
const PENALTY_BPS = 2000n; // phạt 20% giá trị phần giao thiếu
const REWARD_PER_WH = ethers.parseUnits("1", 18) / 1000n; // thưởng 1 SOLAR / kWh
const perWh = kwh => ethers.parseUnits(String(kwh), 18) / 1000n; // giá SOLAR/kWh -> đơn vị nhỏ nhất / Wh
const TOKENS = ethers.parseUnits("1000", 18);

async function deployFixture() {
  const [admin, oracle, alice, bob, carol, dave, outsider] = await ethers.getSigners();
  const token = await ethers.deployContract("EnergyToken", [admin.address]);
  const market = await ethers.deployContract("EnergyMarket", [
    await token.getAddress(), SLOT, PENALTY_BPS, REWARD_PER_WH, oracle.address,
  ]);
  const marketAddr = await market.getAddress();
  await token.grantRole(await token.MINTER_ROLE(), marketAddr);
  await token.grantRole(await token.MARKET_ROLE(), marketAddr);

  const houses = [[alice, "H01"], [bob, "H02"], [carol, "H03"], [dave, "H04"]];
  for (const [s, id] of houses) {
    await market.connect(s).register(id);
    await token.mint(s.address, TOKENS);
    await token.connect(s).approve(marketAddr, ethers.MaxUint256);
  }
  const slot = (await market.currentSlot()) + 1n;
  return { token, market, marketAddr, admin, oracle, alice, bob, carol, dave, outsider, slot };
}

/** Kịch bản chuẩn: 2 người bán, 2 người mua, có dự báo AI cho alice */
async function bookFixture() {
  const f = await deployFixture();
  const { market, oracle, alice, bob, carol, dave, slot } = f;
  await market.connect(oracle).submitForecast(slot, alice.address, 1000, 400); // dư 600 Wh
  await market.connect(alice).placeAsk(slot, 500, perWh(2.0));
  await market.connect(bob).placeAsk(slot, 300, perWh(2.4));
  await market.connect(carol).placeBid(slot, 400, perWh(3.0));
  await market.connect(dave).placeBid(slot, 300, perWh(2.2));
  return f;
}

async function toSlotEnd(slot) {
  await time.increaseTo((slot + 1n) * SLOT);
}

describe("EnergyToken", function () {
  it("chỉ MINTER_ROLE được mint, chỉ MARKET_ROLE được slash", async function () {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await expect(token.connect(alice).mint(alice.address, 1)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    await expect(token.connect(alice).slash(bob.address, alice.address, 1)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });
});

describe("EnergyMarket - đăng ký", function () {
  it("đăng ký hộ, phát event và tra cứu 2 chiều", async function () {
    const { market, outsider } = await loadFixture(deployFixture);
    await expect(market.connect(outsider).register("H99"))
      .to.emit(market, "HouseRegistered").withArgs(outsider.address, "H99");
    expect(await market.houseOf(outsider.address)).to.equal("H99");
    expect(await market.accountOf("H99")).to.equal(outsider.address);
  });

  it("không cho đăng ký trùng ví, trùng mã hộ hoặc mã rỗng", async function () {
    const { market, alice, outsider } = await loadFixture(deployFixture);
    await expect(market.connect(alice).register("HX")).to.be.revertedWithCustomError(market, "AlreadyRegistered");
    await expect(market.connect(outsider).register("H01")).to.be.revertedWithCustomError(market, "HouseIdTaken");
    await expect(market.connect(outsider).register("")).to.be.revertedWithCustomError(market, "EmptyHouseId");
  });

  it("chỉ admin được registerFor", async function () {
    const { market, alice, outsider } = await loadFixture(deployFixture);
    await expect(market.connect(alice).registerFor(outsider.address, "H77"))
      .to.be.revertedWithCustomError(market, "AccessControlUnauthorizedAccount");
    await expect(market.registerFor(outsider.address, "H77")).to.emit(market, "HouseRegistered");
  });
});

describe("EnergyMarket - oracle", function () {
  it("chỉ ORACLE_ROLE được gửi dự báo và chỉ số công tơ", async function () {
    const { market, alice, slot } = await loadFixture(deployFixture);
    await expect(market.connect(alice).submitForecast(slot, alice.address, 1, 0))
      .to.be.revertedWithCustomError(market, "AccessControlUnauthorizedAccount");
    await expect(market.connect(alice).reportMeter(slot - 1n, alice.address, 1, 0))
      .to.be.revertedWithCustomError(market, "AccessControlUnauthorizedAccount");
  });

  it("chỉ số công tơ chỉ gửi cho slot đã kết thúc và chỉ gửi 1 lần", async function () {
    const { market, oracle, alice, slot } = await loadFixture(deployFixture);
    await expect(market.connect(oracle).reportMeter(slot, alice.address, 1, 0))
      .to.be.revertedWithCustomError(market, "FutureSlot");
    const past = slot - 2n;
    await expect(market.connect(oracle).reportMeter(past, alice.address, 800, 300))
      .to.emit(market, "MeterReported").withArgs(past, alice.address, 800, 300);
    await expect(market.connect(oracle).reportMeter(past, alice.address, 900, 300))
      .to.be.revertedWithCustomError(market, "AlreadyReported");
  });
});

describe("EnergyMarket - đặt lệnh", function () {
  it("ví chưa đăng ký không được đặt lệnh", async function () {
    const { market, outsider, slot } = await loadFixture(deployFixture);
    await expect(market.connect(outsider).placeAsk(slot, 100, perWh(2)))
      .to.be.revertedWithCustomError(market, "NotRegistered");
  });

  it("lệnh bán không vượt quá sản lượng dư AI dự báo", async function () {
    const { market, oracle, alice, slot } = await loadFixture(deployFixture);
    await market.connect(oracle).submitForecast(slot, alice.address, 1000, 400); // dư 600
    await market.connect(alice).placeAsk(slot, 450, perWh(2));
    await expect(market.connect(alice).placeAsk(slot, 200, perWh(2)))
      .to.be.revertedWithCustomError(market, "ExceedsForecast").withArgs(150);
  });

  it("lệnh mua khoá token vào escrow; thiếu approve thì revert", async function () {
    const { token, market, marketAddr, carol, outsider, slot } = await loadFixture(deployFixture);
    const before = await token.balanceOf(carol.address);
    await market.connect(carol).placeBid(slot, 400, perWh(3));
    expect(await token.balanceOf(marketAddr)).to.equal(400n * perWh(3));
    expect(await token.balanceOf(carol.address)).to.equal(before - 400n * perWh(3));

    await market.registerFor(outsider.address, "H05");
    await token.mint(outsider.address, TOKENS);
    await expect(market.connect(outsider).placeBid(slot, 10, perWh(3)))
      .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
  });

  it("1 hộ không đứng cả 2 phía trong cùng slot; không đặt vào slot đã qua hoặc đã đóng", async function () {
    const { market, oracle, alice, slot } = await loadFixture(deployFixture);
    await market.connect(alice).placeAsk(slot, 100, perWh(2));
    await expect(market.connect(alice).placeBid(slot, 100, perWh(2)))
      .to.be.revertedWithCustomError(market, "OppositeSideExists");
    await expect(market.connect(alice).placeAsk(slot - 2n, 100, perWh(2)))
      .to.be.revertedWithCustomError(market, "SlotNotOpen");
    await market.connect(oracle).closeAuction(slot);
    await expect(market.connect(alice).placeAsk(slot, 100, perWh(2)))
      .to.be.revertedWithCustomError(market, "SlotNotOpen");
  });

  it("số lượng và giá phải > 0", async function () {
    const { market, alice, slot } = await loadFixture(deployFixture);
    await expect(market.connect(alice).placeAsk(slot, 0, perWh(2))).to.be.revertedWithCustomError(market, "InvalidAmount");
    await expect(market.connect(alice).placeAsk(slot, 10, 0)).to.be.revertedWithCustomError(market, "InvalidAmount");
  });
});

describe("EnergyMarket - khớp lệnh", function () {
  it("người thường không đóng phiên trước giờ; oracle được đóng sớm", async function () {
    const { market, oracle, alice, slot } = await loadFixture(bookFixture);
    await expect(market.connect(alice).closeAuction(slot)).to.be.revertedWithCustomError(market, "TooEarly");
    await expect(market.connect(oracle).closeAuction(slot)).to.emit(market, "AuctionClosed");
    await expect(market.connect(oracle).closeAuction(slot)).to.be.revertedWithCustomError(market, "AlreadyClosed");
  });

  it("slot nhận lệnh đến hết slot; ai cũng đóng được phiên khi slot đã kết thúc", async function () {
    const { market, alice, bob, slot } = await loadFixture(bookFixture);
    await time.increaseTo(slot * SLOT + 30n); // đang ở giữa slot
    await expect(market.connect(bob).placeAsk(slot, 10, perWh(2.5))).to.emit(market, "OrderPlaced");
    await expect(market.connect(alice).closeAuction(slot)).to.be.revertedWithCustomError(market, "TooEarly");
    await toSlotEnd(slot);
    await expect(market.connect(alice).closeAuction(slot)).to.emit(market, "AuctionClosed");
  });

  it("đấu giá đôi giá đồng nhất: đúng cặp khớp, giá clearing và hoàn escrow thừa", async function () {
    const { token, market, marketAddr, oracle, alice, bob, carol, dave, slot } = await loadFixture(bookFixture);
    const carol0 = await token.balanceOf(carol.address);
    const dave0 = await token.balanceOf(dave.address);
    const price = perWh(2.1); // (2.2 + 2.0) / 2

    await expect(market.connect(oracle).closeAuction(slot))
      .to.emit(market, "OrderMatched").withArgs(slot, carol.address, alice.address, 400, price)
      .and.to.emit(market, "OrderMatched").withArgs(slot, dave.address, alice.address, 100, price)
      .and.to.emit(market, "AuctionClosed").withArgs(slot, price, 500);

    const info = await market.slotInfo(slot);
    expect(info.closed).to.equal(true);
    expect(info.clearingPricePerWh).to.equal(price);
    expect(info.matchedWh).to.equal(500);

    const orders = await market.getOrders(slot);
    expect(orders.map(o => Number(o.filledWh))).to.deep.equal([500, 0, 400, 100]);
    expect(await market.getTrades(slot)).to.have.length(2);

    // carol trả 400 * 2.1 thay vì 400 * 3.0; dave chỉ khớp 100 Wh
    expect(await token.balanceOf(carol.address)).to.equal(carol0 + 400n * perWh(3) - 400n * price);
    expect(await token.balanceOf(dave.address)).to.equal(dave0 + 300n * perWh(2.2) - 100n * price);
    expect(await token.balanceOf(marketAddr)).to.equal(500n * price);
    expect(await token.balanceOf(bob.address)).to.equal(TOKENS); // bob không khớp
  });

  it("sổ lệnh đầy (40 lệnh) vẫn đóng phiên trong giới hạn gas", async function () {
    const { token, market, marketAddr, oracle, slot } = await loadFixture(deployFixture);
    const signers = (await ethers.getSigners()).slice(7, 17); // 10 ví mới: 5 bán, 5 mua
    for (let k = 0; k < signers.length; k++) {
      const s = signers[k];
      await market.registerFor(s.address, `B${k}`);
      await token.mint(s.address, TOKENS);
      await token.connect(s).approve(marketAddr, ethers.MaxUint256);
    }
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 5; k++) {
        await market.connect(signers[k]).placeAsk(slot, 50 + r * 10 + k, perWh(1.8 + 0.1 * ((k + r) % 5)));
        await market.connect(signers[k + 5]).placeBid(slot, 60 + r * 5 + k, perWh(2.4 - 0.1 * ((k * 2 + r) % 5)));
      }
    }
    await expect(market.connect(signers[0]).placeAsk(slot, 1, perWh(2))).to.be.revertedWithCustomError(market, "SlotFull");
    const rc = await (await market.connect(oracle).closeAuction(slot)).wait();
    console.log(`      gas closeAuction 40 lệnh: ${rc.gasUsed}`);
    expect(rc.gasUsed).to.be.lessThan(15_000_000n);
  });

  it("không có giá giao nhau thì không khớp và hoàn toàn bộ escrow", async function () {
    const { token, market, marketAddr, oracle, alice, carol, slot } = await loadFixture(deployFixture);
    await market.connect(alice).placeAsk(slot, 100, perWh(3));
    await market.connect(carol).placeBid(slot, 100, perWh(2));
    await expect(market.connect(oracle).closeAuction(slot)).to.emit(market, "AuctionClosed").withArgs(slot, 0, 0);
    expect(await token.balanceOf(marketAddr)).to.equal(0);
    expect(await token.balanceOf(carol.address)).to.equal(TOKENS);
    expect((await market.slotInfo(slot)).settled).to.equal(true);
  });
});

describe("EnergyMarket - thanh toán", function () {
  async function closedFixture() {
    const f = await bookFixture();
    await f.market.connect(f.oracle).closeAuction(f.slot);
    return f;
  }

  it("chưa hết slot hoặc thiếu chỉ số công tơ thì không thanh toán được", async function () {
    const { market, alice, slot } = await loadFixture(closedFixture);
    await expect(market.settle(slot)).to.be.revertedWithCustomError(market, "TooEarly");
    await time.increaseTo((slot + 1n) * SLOT);
    await expect(market.settle(slot)).to.be.revertedWithCustomError(market, "MissingMeter").withArgs(alice.address);
    await expect(market.settle(slot + 5n)).to.be.revertedWithCustomError(market, "NotClosed");
  });

  it("trả tiền theo điện giao thực tế, hoàn tiền + phạt khi giao thiếu, thưởng token", async function () {
    const { token, market, marketAddr, oracle, alice, carol, dave, slot } = await loadFixture(closedFixture);
    await time.increaseTo((slot + 1n) * SLOT);
    // alice cam kết 500 Wh nhưng thực tế chỉ dư 450 Wh
    await market.connect(oracle).reportMeter(slot, alice.address, 900, 450);

    const price = perWh(2.1);
    const a0 = await token.balanceOf(alice.address);
    const c0 = await token.balanceOf(carol.address);
    const d0 = await token.balanceOf(dave.address);
    const shortValue = 50n * price;
    const penalty = (shortValue * PENALTY_BPS) / 10000n;
    const reward = 450n * REWARD_PER_WH;

    await expect(market.settle(slot))
      .to.emit(market, "Settled").withArgs(slot, alice.address, carol.address, 400, 400n * price, 0)
      .and.to.emit(market, "Settled").withArgs(slot, alice.address, dave.address, 50, 50n * price, penalty)
      .and.to.emit(market, "RewardPaid").withArgs(slot, alice.address, reward);

    expect(await token.balanceOf(alice.address)).to.equal(a0 + 450n * price - penalty + reward);
    expect(await token.balanceOf(carol.address)).to.equal(c0);
    expect(await token.balanceOf(dave.address)).to.equal(d0 + shortValue + penalty);
    expect(await token.balanceOf(marketAddr)).to.equal(0); // escrow được giải phóng hết
    expect((await market.slotInfo(slot)).settled).to.equal(true);
    await expect(market.settle(slot)).to.be.revertedWithCustomError(market, "AlreadySettled");
  });

  it("giao đủ thì không phạt", async function () {
    const { market, oracle, alice, slot } = await loadFixture(closedFixture);
    await time.increaseTo((slot + 1n) * SLOT);
    await market.connect(oracle).reportMeter(slot, alice.address, 1200, 400);
    const rc = await (await market.settle(slot)).wait();
    const settled = rc.logs.map(l => market.interface.parseLog(l)).filter(e => e && e.name === "Settled");
    expect(settled.map(e => e.args.penalty)).to.deep.equal([0n, 0n]);
  });
});
