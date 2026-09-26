import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import {
  Activity, AlertTriangle, BatteryCharging, Blocks, BrainCircuit, CircleDollarSign,
  Coins, Cpu, Gauge, Home, Link2, Network, Radio, Sun, Wallet, Zap,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { CONFIG, TOPICS } from "./config";
import { useMqtt } from "./hooks/useMqtt";
import { useWallet } from "./hooks/useWallet";
import { useMarket } from "./hooks/useMarket";
import { MarketPanel } from "./components/MarketPanel";
import { AddressLink, Badge, Empty, InfoRow, Metric, Panel, TxLink } from "./components/ui";
import { ago, errorMessage, fmt, formatToken, pricePerWhToKwh, shorten, timeLabel } from "./lib/format";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const MQTT_LABEL = {
  connected: ["ok", "MQTT đã kết nối"],
  connecting: ["warn", "MQTT đang kết nối…"],
  offline: ["bad", "MQTT mất kết nối"],
  "not-configured": ["bad", "Chưa cấu hình MQTT"],
};

export default function App() {
  const now = useNow();
  const mqtt = useMqtt();
  const wallet = useWallet();
  const market = useMarket(wallet);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState(null);
  const [houseInput, setHouseInput] = useState("");

  // Danh sách hộ = hộ gửi dữ liệu MQTT ∪ hộ đã đăng ký on-chain
  const houseIds = useMemo(() => {
    const set = new Set([...Object.keys(mqtt.houses), ...Object.values(market.houseByAddress)]);
    return [...set].sort();
  }, [mqtt.houses, market.houseByAddress]);

  useEffect(() => {
    if (!selected && houseIds.length) setSelected(market.myHouseId && houseIds.includes(market.myHouseId) ? market.myHouseId : houseIds[0]);
  }, [houseIds, selected, market.myHouseId]);

  const house = mqtt.houses[selected] || { readings: [], forecasts: [] };
  const latest = house.readings[house.readings.length - 1];
  const isLive = mqtt.status === "connected" && latest && now - latest.receivedAt < CONFIG.staleAfterSec * 1000;
  const [mqttTone, mqttText] = MQTT_LABEL[mqtt.status];

  const chartData = house.readings.map(r => ({
    time: timeLabel(r.ts), power: r.power, voltage: r.voltage, current: r.current,
  }));
  const avgPower = house.readings.length
    ? house.readings.reduce((s, r) => s + (r.power ?? 0), 0) / house.readings.length
    : null;

  // Dữ liệu đo đã được oracle ghi on-chain (MeterReported) cho hộ đang chọn
  const ownerAddr = market.addressByHouse[selected];
  const onchainMeter = useMemo(() => {
    const map = {};
    market.events
      .filter(e => e.name === "MeterReported" && ownerAddr && e.args.account.toLowerCase() === ownerAddr)
      .forEach(e => { map[e.args.slot.toString()] = e.args; });
    return map;
  }, [market.events, ownerAddr]);

  const forecastData = house.forecasts.map(f => {
    const actual = f.slot ? onchainMeter[f.slot] : null;
    return {
      label: f.slot ? `#${f.slot}` : timeLabel(f.ts),
      "Dự báo phát": f.genPredWh,
      "Dự báo tiêu thụ": f.loadPredWh,
      "Thực tế phát (on-chain)": actual ? Number(actual.producedWh) : null,
    };
  });
  const lastForecast = house.forecasts[house.forecasts.length - 1];

  const applyForecast = useCallback(() => {
    if (!lastForecast) return;
    const surplus = Math.round(lastForecast.surplusPredWh);
    setDraft({ side: surplus >= 0 ? "ask" : "bid", qtyWh: Math.abs(surplus), slot: lastForecast.slot });
  }, [lastForecast]);
  const clearDraft = useCallback(() => setDraft(null), []);

  async function doRegister(e) {
    e.preventDefault();
    try {
      await market.register(houseInput || selected);
    } catch (err) {
      console.warn(errorMessage(err));
    }
  }

  const dec = market.tokenInfo.decimals;
  const sym = market.tokenInfo.symbol;
  const activity = [...market.events].reverse().slice(0, 40);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon"><Sun size={21} /></div>
          <div>
            <div className="brand-title">P2P Solar Energy</div>
            <div className="brand-sub">IoT · AI · Blockchain — Nhóm 08</div>
          </div>
        </div>
        <div className="top-actions">
          <span className={`live-dot ${isLive ? "on" : "off"}`}><span /> {isLive ? "LIVE" : "NO SIGNAL"}</span>
          {wallet.account && (
            <Badge tone={wallet.wrongNetwork ? "bad" : "ok"}>{wallet.wrongNetwork ? `Sai mạng (${wallet.chainId})` : CONFIG.chainName}</Badge>
          )}
          <button className="wallet-btn" onClick={wallet.connect} disabled={wallet.connecting}>
            <Wallet size={17} /> {wallet.connecting ? "Đang kết nối…" : wallet.account ? shorten(wallet.account) : "Kết nối MetaMask"}
          </button>
        </div>
      </header>

      <main className="container">
        {/* ===== Cảnh báo cấu hình / kết nối ===== */}
        <div className="alerts">
          {!CONFIG.mqttUrl && <Alert>Chưa khai báo <code>VITE_MQTT_WS_URL</code> trong <code>.env</code> — không nhận được dữ liệu phần cứng.</Alert>}
          {mqtt.error && <Alert>MQTT: {mqtt.error}</Alert>}
          {!market.configured && <Alert>Chưa khai báo <code>VITE_ENERGY_MARKET_ADDRESS</code> — phần Smart Contract đang tắt.</Alert>}
          {market.configured && !market.readable && <Alert>Không có RPC để đọc blockchain: khai báo <code>VITE_RPC_URL</code> hoặc kết nối MetaMask đúng mạng.</Alert>}
          {market.error && <Alert>{market.error}</Alert>}
          {!wallet.hasMetaMask && <Alert>Trình duyệt chưa có MetaMask.</Alert>}
          {wallet.error && <Alert>Ví: {wallet.error}</Alert>}
          {wallet.wrongNetwork && (
            <Alert>
              MetaMask đang ở chain {wallet.chainId}, hệ thống chạy trên {CONFIG.chainName} ({CONFIG.chainId}).
              <button className="link-btn" onClick={wallet.switchNetwork}>Chuyển mạng</button>
            </Alert>
          )}
        </div>

        <section className="hero">
          <div>
            <p className="eyebrow">CYBER-PHYSICAL ENERGY MARKET</p>
            <h1>Energy Dashboard</h1>
            <p className="hero-copy">
              Dữ liệu đo thật từ ESP32 qua MQTT, dự báo AI, và phiên đấu giá P2P trên Smart Contract — ký giao dịch bằng MetaMask, truy vết trên Etherscan.
            </p>
          </div>
          <div className="status-stack">
            <span className={`status-pill tone-${mqttTone}`}><Radio size={14} /> {mqttText}</span>
            <span className="status-pill"><Activity size={14} /> Tin nhắn cuối: {ago(mqtt.lastMessageAt, now)}</span>
            <span className="status-pill"><Blocks size={14} /> Block: {market.latestBlock ?? "—"}</span>
          </div>
        </section>

        {/* ===== Chọn hộ ===== */}
        <div className="house-tabs">
          <Home size={16} />
          {houseIds.length ? houseIds.map(h => (
            <button key={h} className={h === selected ? "active" : ""} onClick={() => setSelected(h)}>
              {h}{h === market.myHouseId ? " (tôi)" : ""}
              {mqtt.houses[h]?.readings.length ? <span className={`dot ${now - mqtt.houses[h].readings.at(-1).receivedAt < CONFIG.staleAfterSec * 1000 ? "on" : "off"}`} /> : null}
            </button>
          )) : <span className="muted">Đang chờ thiết bị publish lên <code>{TOPICS.telemetry}</code>…</span>}
        </div>

        <section className="metric-grid">
          <Metric title="Điện áp" value={fmt(latest?.voltage)} unit="V" icon={<Gauge />} hint={latest ? ago(latest.ts, now) : "chưa có dữ liệu"} />
          <Metric title="Dòng điện" value={fmt(latest?.current, 3)} unit="A" icon={<BatteryCharging />} />
          <Metric title="Công suất" value={fmt(latest?.power)} unit="W" icon={<Zap />} hint={avgPower !== null ? `TB ${fmt(avgPower)} W` : undefined} />
          <Metric
            title={latest?.surplusWh !== null && latest?.surplusWh !== undefined ? "Điện dư (phát − dùng)" : "Sản lượng phát"}
            value={fmt(latest?.surplusWh ?? latest?.genWh)}
            unit="Wh"
            icon={<Sun />}
            hint={latest?.genWh !== null && latest?.genWh !== undefined ? `Phát ${fmt(latest.genWh)} · Dùng ${fmt(latest.loadWh)}` : undefined}
          />
        </section>

        <section className="content-grid">
          <Panel title="Công suất thời gian thực" subtitle={selected ? `Hộ ${selected} · topic ${CONFIG.topicPrefix}/${selected}/telemetry` : "Chưa chọn hộ"}>
            <div className="chart">
              {chartData.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={24} />
                    <YAxis yAxisId="p" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="v" orientation="right" tick={{ fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: "#0c1724", border: "1px solid #203347" }} />
                    <Legend />
                    <Line yAxisId="p" type="monotone" dataKey="power" name="Công suất (W)" stroke="#69ccff" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                    <Line yAxisId="v" type="monotone" dataKey="voltage" name="Điện áp (V)" stroke="#f5b84a" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <Empty>Chưa nhận được dữ liệu từ thiết bị IoT.</Empty>}
            </div>
          </Panel>

          <Panel title="Ví Web3" subtitle="MetaMask / EVM" right={<CircleDollarSign size={20} />}>
            <div className="wallet-info">
              <InfoRow icon={<Link2 />} label="Địa chỉ" value={wallet.account ? <AddressLink address={wallet.account} /> : "—"} />
              <InfoRow icon={<CircleDollarSign />} label="Số dư ETH (gas)" value={wallet.ethBalance !== null ? `${fmt(Number(ethers.formatEther(wallet.ethBalance)), 4)} ETH` : "—"} />
              <InfoRow icon={<Coins />} label={`Số dư ${sym}`} value={market.tokenBalance !== null ? `${formatToken(market.tokenBalance, dec)} ${sym}` : "—"} />
              <InfoRow icon={<Home />} label="Hộ đã đăng ký" value={market.myHouseId || (wallet.account ? "Chưa đăng ký" : "—")} />
              <InfoRow icon={<Network />} label="Mạng" value={wallet.chainId !== null ? `${wallet.chainId}${wallet.wrongNetwork ? " (sai)" : ""}` : "—"} />
            </div>
            {!wallet.account && (
              <button className="primary-btn" onClick={wallet.connect}><Wallet size={16} /> Kết nối MetaMask</button>
            )}
            {wallet.account && market.configured && !market.myHouseId && !wallet.wrongNetwork && (
              <form className="register-form" onSubmit={doRegister}>
                <input value={houseInput} onChange={e => setHouseInput(e.target.value.trim())} placeholder={selected || "houseId, vd. H01"} />
                <button className="primary-btn" type="submit" disabled={market.busy || !(houseInput || selected)}>Gắn ví với hộ</button>
              </form>
            )}
            <div className="contracts">
              <small>Contracts</small>
              <div>Market: {market.configured ? <AddressLink address={CONFIG.marketAddress} /> : "—"}</div>
              <div>Token: {market.tokenAddress ? <AddressLink address={market.tokenAddress} /> : "—"}</div>
            </div>
            {market.txs.length > 0 && (
              <div className="tx-list">
                <small>Giao dịch vừa gửi</small>
                {market.txs.map(t => (
                  <div key={t.id} className="tx-row">
                    <Badge tone={t.status === "success" ? "ok" : t.status === "failed" ? "bad" : "warn"}>{t.status}</Badge>
                    <span className="tx-label" title={t.error || t.label}>{t.label}</span>
                    <TxLink hash={t.hash} />
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>

        <section className="content-grid">
          <Panel
            title="Dự báo AI"
            subtitle={`Nhận từ ${CONFIG.topicPrefix}/${selected || "+"}/forecast`}
            right={<BrainCircuit size={20} />}
          >
            {lastForecast ? (
              <>
                <div className="forecast-stats">
                  <div><small>Dự báo phát</small><strong>{fmt(lastForecast.genPredWh)} Wh</strong></div>
                  <div><small>Dự báo tiêu thụ</small><strong>{fmt(lastForecast.loadPredWh)} Wh</strong></div>
                  <div>
                    <small>Dư / thiếu</small>
                    <strong className={lastForecast.surplusPredWh >= 0 ? "pos" : "neg"}>{fmt(lastForecast.surplusPredWh)} Wh</strong>
                  </div>
                  <div><small>Slot · model</small><strong>{lastForecast.slot ? `#${lastForecast.slot}` : "—"} · {lastForecast.model || "—"}</strong></div>
                </div>
                <button className="secondary-btn" onClick={applyForecast} disabled={!Math.round(lastForecast.surplusPredWh)}>
                  <Cpu size={16} /> Dùng dự báo → điền lệnh {lastForecast.surplusPredWh >= 0 ? "BÁN" : "MUA"} {fmt(Math.abs(Math.round(lastForecast.surplusPredWh)), 0)} Wh
                </button>
                <div className="chart small">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={forecastData}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip contentStyle={{ background: "#0c1724", border: "1px solid #203347" }} />
                      <Legend />
                      <Bar dataKey="Dự báo phát" fill="#69ccff" isAnimationActive={false} />
                      <Bar dataKey="Dự báo tiêu thụ" fill="#f5b84a" isAnimationActive={false} />
                      <Bar dataKey="Thực tế phát (on-chain)" fill="#53d47b" isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            ) : <Empty>Chưa nhận được dự báo từ AI service cho hộ này.</Empty>}
          </Panel>

          <MarketPanel market={market} wallet={wallet} draft={draft} onDraftUsed={clearDraft} />
        </section>

        <Panel title="Truy vết on-chain" subtitle="Event của EnergyMarket — bấm hash để mở Etherscan" className="table-panel">
          {activity.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Block</th><th>Sự kiện</th><th>Slot</th><th>Chi tiết</th><th>Tx</th></tr></thead>
                <tbody>
                  {activity.map(e => (
                    <tr key={e.key}>
                      <td>{e.blockNumber}</td>
                      <td><Badge tone={EVENT_TONE[e.name] || "neutral"}>{e.name}</Badge></td>
                      <td>{e.args.slot !== undefined ? `#${e.args.slot.toString()}` : "—"}</td>
                      <td className="detail">{describeEvent(e, market, dec, sym)}</td>
                      <td><TxLink hash={e.txHash} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>{market.configured ? "Chưa có event nào từ contract." : "Chưa cấu hình contract."}</Empty>}
        </Panel>

        <Panel
          title="Bản ghi IoT gần nhất"
          subtitle={`Hộ ${selected || "—"}${ownerAddr ? ` · ví ${shorten(ownerAddr)}` : ""}${mqtt.badMessages ? ` · bỏ qua ${mqtt.badMessages} message sai định dạng` : ""}`}
          right={<span className="source-tag">MQTT · {CONFIG.mqttUrl ? CONFIG.mqttUrl.replace(/^wss?:\/\//, "") : "chưa cấu hình"}</span>}
          className="table-panel"
        >
          {house.readings.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Thời gian</th><th>Điện áp</th><th>Dòng</th><th>Công suất</th><th>Phát / Dùng</th><th>Trạng thái</th></tr></thead>
                <tbody>
                  {[...house.readings].slice(-8).reverse().map(r => {
                    const fresh = now - r.receivedAt < CONFIG.staleAfterSec * 1000;
                    return (
                      <tr key={`${r.ts}-${r.receivedAt}`}>
                        <td>{timeLabel(r.ts)}</td>
                        <td>{fmt(r.voltage)} V</td>
                        <td>{fmt(r.current, 3)} A</td>
                        <td>{fmt(r.power)} W</td>
                        <td>{r.genWh !== null ? `${fmt(r.genWh)} / ${fmt(r.loadWh)} Wh` : "—"}</td>
                        <td><Badge tone={fresh ? "ok" : "warn"}>{fresh ? "MỚI" : "CŨ"}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <Empty>Chưa có bản ghi.</Empty>}
        </Panel>

        <footer>P2P Solar Energy Trading · React + Vite + ethers.js v6 + MQTT.js · chain {CONFIG.chainName} ({CONFIG.chainId})</footer>
      </main>
    </div>
  );
}

function Alert({ children }) {
  return <div className="alert"><AlertTriangle size={15} /> <span>{children}</span></div>;
}

const EVENT_TONE = {
  OrderMatched: "ok", Settled: "ok", RewardPaid: "ok", AuctionClosed: "info",
  OrderPlaced: "neutral", MeterReported: "info", HouseRegistered: "neutral",
};

function who(market, addr) {
  return market.houseByAddress[addr.toLowerCase()] || shorten(addr);
}

function describeEvent(e, market, dec, sym) {
  const a = e.args;
  const price = v => `${fmt(Number(pricePerWhToKwh(v, dec)), 4)} ${sym}/kWh`;
  switch (e.name) {
    case "HouseRegistered": return `${shorten(a.account)} ↔ hộ ${a.houseId}`;
    case "MeterReported": return `${who(market, a.account)}: phát ${a.producedWh} Wh · dùng ${a.consumedWh} Wh`;
    case "OrderPlaced": return `${who(market, a.trader)} ${a.isBid ? "MUA" : "BÁN"} ${a.qtyWh} Wh @ ${price(a.pricePerWh)} (lệnh #${a.orderId})`;
    case "AuctionClosed": return `Giá khớp ${price(a.clearingPricePerWh)} · tổng ${a.matchedWh} Wh`;
    case "OrderMatched": return `${who(market, a.seller)} → ${who(market, a.buyer)}: ${a.qtyWh} Wh @ ${price(a.pricePerWh)}`;
    case "Settled": return `${who(market, a.seller)} giao ${a.deliveredWh} Wh cho ${who(market, a.buyer)} · trả ${formatToken(a.payment, dec)} ${sym}${a.penalty > 0n ? ` · phạt ${formatToken(a.penalty, dec)}` : ""}`;
    case "RewardPaid": return `Thưởng ${formatToken(a.amount, dec)} ${sym} cho ${who(market, a.account)}`;
    default: return "";
  }
}
