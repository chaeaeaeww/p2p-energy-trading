// Oracle bridge: MQTT (IoT + AI)  ->  Smart Contract (ethers.js)
//
//   npx hardhat run scripts/bridge.js --network localhost
//
// Việc bridge làm:
//  1. Publish slot hiện tại của chain lên   <prefix>/chain/slot   (retained) để AI biết đang dự báo cho slot nào.
//  2. Nghe  <prefix>/<houseId>/forecast  (AI)  -> submitForecast(slot, account, genPredWh, loadPredWh)
//     Nếu AUTO_TRADE=true và có private key của hộ -> tự đặt lệnh bán (dư) / mua (thiếu) theo dự báo.
//  3. Nghe  <prefix>/<houseId>/telemetry (IoT) -> cộng dồn Wh sản xuất/tiêu thụ theo slot của chain.
//     Hết slot -> reportMeter(slot, account, producedWh, consumedWh).
//  4. Hết slot -> closeAuction(slot) -> reportMeter -> settle(slot).
const hre = require("hardhat");
const mqtt = require("mqtt");
const { getContracts, localWallet, perWh, kwhPrice, revertReason, log } = require("./lib/common");

const env = process.env;
const PREFIX = env.MQTT_TOPIC_PREFIX || "p2p";
const MQTT_URL = env.MQTT_URL || `mqtt://${env.MQTT_HOST || "localhost"}:${env.MQTT_PORT || 1883}`;
const POLL_MS = Number(env.BRIDGE_POLL_MS || 4000);
const AUTO_CLOSE = env.AUTO_CLOSE !== "false";
const AUTO_SETTLE = env.AUTO_SETTLE !== "false";
const AUTO_TRADE = env.AUTO_TRADE === "true";
const ASK_PRICE_KWH = env.ASK_PRICE_KWH || "2.0";
const BID_PRICE_KWH = env.BID_PRICE_KWH || "2.6";

function num(...xs) {
  for (const x of xs) {
    if (x === undefined || x === null || x === "") continue;
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function main() {
  const { ethers, network } = hre;
  const [oracle] = await ethers.getSigners();
  const { dep, market, token } = await getContracts(hre, oracle);
  const isLocal = network.config.chainId === 31337;
  const ORACLE_ROLE = await market.ORACLE_ROLE();
  if (!(await market.hasRole(ORACLE_ROLE, oracle.address))) {
    throw new Error(`Ví ${oracle.address} không có ORACLE_ROLE trên market ${dep.market}`);
  }

  // ---------- ví của các hộ (chỉ dùng khi AUTO_TRADE) ----------
  const houseKeys = {};
  if (AUTO_TRADE) {
    if (env.HOUSE_KEYS) {
      env.HOUSE_KEYS.split(",").filter(Boolean).forEach(pair => {
        const [h, k] = pair.split(":").map(s => s.trim());
        houseKeys[h] = new ethers.Wallet(k, ethers.provider);
      });
    } else if (isLocal) {
      [1, 2, 3, 4].forEach(i => { houseKeys[`H0${i}`] = localWallet(ethers, i).connect(ethers.provider); });
    }
  }

  log(`Bridge chạy trên ${network.name} | market ${dep.market} | oracle ${oracle.address}`);
  log(`MQTT ${MQTT_URL} prefix "${PREFIX}" | autoClose=${AUTO_CLOSE} autoSettle=${AUTO_SETTLE} autoTrade=${AUTO_TRADE}`);

  // ---------- hàng đợi tx: gửi tuần tự để không đụng nonce ----------
  let queue = Promise.resolve();
  function send(label, fn) {
    const job = queue.then(async () => {
      try {
        const tx = await fn();
        const rc = await tx.wait();
        log(`✔ ${label}  tx ${tx.hash.slice(0, 12)}… block ${rc.blockNumber}`);
        return rc;
      } catch (e) {
        log(`✘ ${label}: ${revertReason(market.interface, e)}`);
        return null;
      }
    });
    queue = job;
    return job;
  }

  // ---------- trạng thái ----------
  const accountCache = {};
  async function accountOf(houseId) {
    if (accountCache[houseId]) return accountCache[houseId];
    const a = await market.accountOf(houseId);
    if (a === ethers.ZeroAddress) return null;
    accountCache[houseId] = a;
    return a;
  }

  let chainSlot = await market.currentSlot();
  const lastCounter = {}; // houseId -> { gen, load }
  const buckets = {}; // slot -> houseId -> { gen, load }
  const activeSlots = new Set();
  const sentForecast = {}; // `${slot}:${houseId}` -> "gen/load"
  const traded = new Set();
  let scannedTo = dep.deployBlock - 1;

  // ---------- MQTT ----------
  const client = mqtt.connect(MQTT_URL, {
    clientId: `bridge_${Math.random().toString(16).slice(2, 8)}`,
    username: env.MQTT_USERNAME || undefined,
    password: env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 3000,
  });
  client.on("connect", () => {
    log("MQTT đã kết nối");
    client.subscribe([`${PREFIX}/+/telemetry`, `${PREFIX}/+/forecast`], { qos: 1 });
    publishSlot();
  });
  client.on("error", e => log(`MQTT lỗi: ${e.message}`));

  function publishSlot() {
    const slot = Number(chainSlot);
    client.publish(
      `${PREFIX}/chain/slot`,
      JSON.stringify({ slot, slotDuration: dep.slotDuration, slotStart: slot * dep.slotDuration, ts: Math.floor(Date.now() / 1000) }),
      { retain: true, qos: 1 }
    );
  }

  client.on("message", (topic, message) => {
    const parts = topic.split("/");
    const kind = parts.pop();
    if (parts[1] === "chain") return;
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      return;
    }
    const houseId = String(payload.houseId ?? payload.house_id ?? parts[1]);
    if (kind === "telemetry") onTelemetry(houseId, payload);
    else if (kind === "forecast") onForecast(houseId, payload).catch(e => log(`forecast ${houseId}: ${e.message}`));
  });

  // Telemetry: E_gen_Wh / E_load_Wh là bộ đếm cộng dồn (giống công tơ điện) -> lấy phần tăng thêm, cộng vào slot hiện tại
  function onTelemetry(houseId, p) {
    const gen = num(p.E_gen_Wh, p.energyGenWh, p.gen_wh);
    const load = num(p.E_load_Wh, p.energyLoadWh, p.load_wh);
    if (gen === null) return;
    const prev = lastCounter[houseId];
    lastCounter[houseId] = { gen, load };
    if (!prev) return; // bản tin đầu tiên chỉ làm mốc
    const dGen = gen >= prev.gen ? gen - prev.gen : gen; // bộ đếm reset (thiết bị khởi động lại)
    const dLoad = load === null || prev.load === null ? 0 : load >= prev.load ? load - prev.load : load;
    const slot = chainSlot.toString();
    buckets[slot] ??= {};
    buckets[slot][houseId] ??= { gen: 0, load: 0 };
    buckets[slot][houseId].gen += dGen;
    buckets[slot][houseId].load += dLoad;
    activeSlots.add(slot);
  }

  async function onForecast(houseId, p) {
    const gen = Math.max(0, Math.round(num(p.genPredWh, p.gen_pred_wh, p.gen_pred) ?? 0));
    const load = Math.max(0, Math.round(num(p.loadPredWh, p.load_pred_wh, p.load_pred) ?? 0));
    const slot = p.slot !== undefined && p.slot !== null ? BigInt(p.slot) : chainSlot + 1n;
    if (slot < chainSlot) return log(`Bỏ qua dự báo ${houseId} cho slot #${slot} (đã qua)`);
    const account = await accountOf(houseId);
    if (!account) return log(`Bỏ qua dự báo: hộ ${houseId} chưa đăng ký on-chain`);
    const key = `${slot}:${houseId}`;
    if (sentForecast[key] === `${gen}/${load}`) return;
    if ((await market.slotInfo(slot)).closed) return;
    sentForecast[key] = `${gen}/${load}`;
    activeSlots.add(slot.toString());
    const rc = await send(`submitForecast ${houseId} slot #${slot}: gen ${gen} Wh, load ${load} Wh (${p.model || "AI"})`,
      () => market.submitForecast(slot, account, gen, load));
    if (rc && AUTO_TRADE) await autoTrade(houseId, account, slot, gen - load);
  }

  // Agent tự giao dịch thay hộ theo dự báo AI (chỉ khi có private key của hộ)
  async function autoTrade(houseId, account, slot, surplus) {
    const wallet = houseKeys[houseId];
    const key = `${slot}:${houseId}`;
    if (!wallet || traded.has(key) || surplus === 0) return;
    if ((await market.sideOf(slot, account)) !== 0n) return; // hộ đã tự đặt lệnh trên dashboard
    traded.add(key);
    const m = market.connect(wallet);
    if (surplus > 0) {
      const price = perWh(ethers, ASK_PRICE_KWH);
      await send(`AUTO ${houseId} BÁN ${surplus} Wh @ ${ASK_PRICE_KWH}/kWh slot #${slot}`, () => m.placeAsk(slot, surplus, price));
    } else {
      const qty = BigInt(-surplus);
      const price = perWh(ethers, BID_PRICE_KWH);
      const t = token.connect(wallet);
      if ((await t.allowance(account, dep.market)) < qty * price) {
        await send(`AUTO ${houseId} approve`, () => t.approve(dep.market, ethers.MaxUint256));
      }
      await send(`AUTO ${houseId} MUA ${qty} Wh @ ${BID_PRICE_KWH}/kWh slot #${slot}`, () => m.placeBid(slot, qty, price));
    }
  }

  // ---------- vòng lặp chính ----------
  async function tick() {
    const cur = await market.currentSlot();
    if (cur !== chainSlot) {
      chainSlot = cur;
      log(`— Slot hiện tại của chain: #${cur}`);
      publishSlot();
    }

    // quét các slot có lệnh mới
    const head = await ethers.provider.getBlockNumber();
    if (head > scannedTo) {
      for (let from = scannedTo + 1; from <= head; from += 5000) {
        const to = Math.min(head, from + 4999);
        const evs = await market.queryFilter(market.filters.OrderPlaced(), from, to);
        evs.forEach(e => activeSlots.add(e.args.slot.toString()));
      }
      scannedTo = head;
    }

    for (const s of [...activeSlots].sort((a, b) => Number(a) - Number(b))) {
      const slot = BigInt(s);
      const info = await market.slotInfo(slot);

      // slot nhận lệnh đến hết slot; hết slot thì đóng phiên, sau đó ghi công tơ và thanh toán
      if (AUTO_CLOSE && !info.closed && slot < cur && (await market.getOrders(slot)).length > 0) {
        const rc = await send(`closeAuction slot #${slot}`, () => market.closeAuction(slot));
        if (rc) {
          const closed = await market.slotInfo(slot);
          log(`   khớp ${closed.matchedWh} Wh, giá clearing ${kwhPrice(ethers, closed.clearingPricePerWh)} SOLAR/kWh`);
        }
        continue;
      }

      if (slot >= cur) continue; // slot chưa kết thúc

      // báo chỉ số công tơ cho mọi hộ có dữ liệu IoT trong slot
      const data = buckets[s] || {};
      for (const [houseId, v] of Object.entries(data)) {
        const account = await accountOf(houseId);
        if (!account || v.reported) continue;
        v.reported = true;
        if ((await market.meterOf(slot, account)).reported) continue;
        await send(`reportMeter ${houseId} slot #${slot}: sản xuất ${Math.round(v.gen)} Wh, tiêu thụ ${Math.round(v.load)} Wh`,
          () => market.reportMeter(slot, account, Math.round(v.gen), Math.round(v.load)));
      }

      const fresh = await market.slotInfo(slot);
      if (fresh.closed && !fresh.settled) {
        // người bán không gửi dữ liệu IoT -> coi như giao 0 Wh (sẽ bị phạt)
        const trades = await market.getTrades(slot);
        for (const seller of new Set(trades.map(t => t.seller))) {
          if (!(await market.meterOf(slot, seller)).reported) {
            await send(`reportMeter ${await market.houseOf(seller)} slot #${slot}: KHÔNG có dữ liệu IoT -> 0 Wh`,
              () => market.reportMeter(slot, seller, 0, 0));
          }
        }
        if (AUTO_SETTLE) await send(`settle slot #${slot}`, () => market.settle(slot));
      }

      const done = await market.slotInfo(slot);
      if ((done.settled || !done.closed) && Object.values(data).every(v => v.reported)) {
        if (done.settled || (await market.getOrders(slot)).length === 0) activeSlots.delete(s);
      }
    }
    await queue;
  }

  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      log(`Lỗi vòng lặp: ${e.shortMessage || e.message}`);
    }
    setTimeout(loop, POLL_MS);
  };
  loop();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
