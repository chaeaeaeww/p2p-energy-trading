import React, { useEffect, useState } from "react";
import { Gavel, Send } from "lucide-react";
import { Badge, Empty, Panel, AddressLink } from "./ui";
import { errorMessage, fmt, pricePerWhToKwh } from "../lib/format";

/** Form đặt lệnh + sổ lệnh của slot đang xem. */
export function MarketPanel({ market, wallet, draft, onDraftUsed }) {
  const [side, setSide] = useState("ask");
  const [qtyWh, setQtyWh] = useState("");
  const [priceKwh, setPriceKwh] = useState("");
  const [slot, setSlot] = useState("");
  const [msg, setMsg] = useState("");
  const [slotTouched, setSlotTouched] = useState(false);

  const current = market.currentSlot !== null ? market.currentSlot.toString() : "";

  // Tự nhảy sang phiên mới khi contract mở slot kế tiếp (trừ khi người dùng tự nhập slot)
  useEffect(() => {
    if (current && !slotTouched) setSlot(current);
  }, [current, slotTouched]);

  // Nhận đề xuất từ panel AI
  useEffect(() => {
    if (!draft) return;
    setSide(draft.side);
    setQtyWh(String(draft.qtyWh));
    if (draft.slot && draft.slot !== current) setMsg(`Lưu ý: dự báo dành cho slot #${draft.slot}, phiên đang mở là #${current || "?"}`);
    onDraftUsed?.();
  }, [draft, onDraftUsed, current]);

  const disabledReason = !market.configured
    ? "Chưa cấu hình địa chỉ contract"
    : !wallet.account
      ? "Kết nối MetaMask để đặt lệnh"
      : wallet.wrongNetwork
        ? "MetaMask đang ở sai mạng"
        : !market.myHouseId
          ? "Ví chưa đăng ký hộ (houseId)"
          : "";

  async function submit(e) {
    e.preventDefault();
    setMsg("");
    try {
      if (!/^\d+$/.test(qtyWh)) throw new Error("Số lượng (Wh) phải là số nguyên dương");
      if (!(Number(priceKwh) > 0)) throw new Error("Giá phải > 0");
      if (!/^\d+$/.test(slot)) throw new Error("Slot không hợp lệ");
      await market.placeOrder({ side, slot, qtyWh, priceKwh });
      setMsg("Lệnh đã được ghi on-chain ✔");
      setQtyWh("");
    } catch (err) {
      setMsg(errorMessage(err));
    }
  }

  const bids = market.orders.filter(o => o.isBid).sort((a, b) => (b.pricePerWh > a.pricePerWh ? 1 : -1));
  const asks = market.orders.filter(o => !o.isBid).sort((a, b) => (a.pricePerWh > b.pricePerWh ? 1 : -1));
  const dec = market.tokenInfo.decimals;
  const sym = market.tokenInfo.symbol;
  const viewing = market.viewSlot !== null ? market.viewSlot.toString() : current;

  return (
    <Panel
      title="Thị trường P2P (Smart Contract)"
      subtitle={current ? `Phiên đang mở: slot #${current}` : "Chưa đọc được phiên đấu giá"}
      right={<Gavel size={20} />}
      className="market-panel"
    >
      <form className="order-form" onSubmit={submit}>
        <div className="seg">
          <button type="button" className={side === "ask" ? "active sell" : ""} onClick={() => setSide("ask")}>Bán điện (Ask)</button>
          <button type="button" className={side === "bid" ? "active buy" : ""} onClick={() => setSide("bid")}>Mua điện (Bid)</button>
        </div>
        <div className="form-grid">
          <label>Slot<input inputMode="numeric" value={slot} onChange={e => { setSlot(e.target.value.trim()); setSlotTouched(e.target.value.trim() !== ""); }} placeholder={current || "slot"} /></label>
          <label>Số lượng (Wh)<input inputMode="numeric" value={qtyWh} onChange={e => setQtyWh(e.target.value.trim())} placeholder="vd. 500" /></label>
          <label>Giá ({sym}/kWh)<input inputMode="decimal" value={priceKwh} onChange={e => setPriceKwh(e.target.value.trim())} placeholder="vd. 2.5" /></label>
        </div>
        {side === "bid" && qtyWh && Number(priceKwh) > 0 && (
          <p className="form-note">Escrow tạm khoá ≈ {fmt((Number(qtyWh) / 1000) * Number(priceKwh), 4)} {sym} (contract sẽ yêu cầu approve nếu thiếu).</p>
        )}
        <button className="primary-btn" type="submit" disabled={!!disabledReason || market.busy}>
          <Send size={16} /> {market.busy ? "Đang chờ MetaMask / block…" : disabledReason || (side === "ask" ? "Gửi lệnh BÁN" : "Gửi lệnh MUA")}
        </button>
        {msg && <p className="form-msg">{msg}</p>}
      </form>

      <div className="book-head">
        <h3>Sổ lệnh slot #{viewing || "—"}</h3>
        <div className="slot-nav">
          <button type="button" className="icon-btn" disabled={!viewing} onClick={() => market.setViewSlot(BigInt(viewing) - 1n)}>‹</button>
          <button type="button" className="icon-btn" disabled={!current} onClick={() => market.setViewSlot(null)}>Hiện tại</button>
          <button type="button" className="icon-btn" disabled={!viewing} onClick={() => market.setViewSlot(BigInt(viewing) + 1n)}>›</button>
        </div>
      </div>
      {!market.orders.length ? (
        <Empty>Chưa có lệnh nào trong slot này.</Empty>
      ) : (
        <div className="book">
          {[["Mua (Bid)", bids, "buy"], ["Bán (Ask)", asks, "sell"]].map(([label, list, tone]) => (
            <div key={label}>
              <div className={`book-title ${tone}`}>{label}</div>
              <table className="compact">
                <thead><tr><th>#</th><th>Hộ / ví</th><th>Wh</th><th>Giá/kWh</th><th>Đã khớp</th></tr></thead>
                <tbody>
                  {list.map(o => (
                    <tr key={o.id.toString()} className={o.trader.toLowerCase() === wallet.account.toLowerCase() ? "mine" : ""}>
                      <td>{o.id.toString()}</td>
                      <td>{market.houseByAddress[o.trader.toLowerCase()] || <AddressLink address={o.trader} />}</td>
                      <td>{o.qtyWh.toString()}</td>
                      <td>{fmt(Number(pricePerWhToKwh(o.pricePerWh, dec)), 4)}</td>
                      <td>{o.filledWh > 0n ? <Badge tone="ok">{o.filledWh.toString()}</Badge> : "0"}</td>
                    </tr>
                  ))}
                  {!list.length && <tr><td colSpan={5} className="muted">—</td></tr>}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
