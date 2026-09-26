# Interface giữa các tầng (hợp đồng dữ liệu)

> Mọi thay đổi ở đây phải báo cả nhóm. Đây là "hợp đồng" để 4 phần ghép được với nhau.

## 1. IoT → Bridge (MQTT)
- Topic: `p2p/<meter_id>/telemetry` · QoS 1 · chu kỳ: 5 s (simulator có thể tăng tốc)
```json
{
  "meter_id": "HH01",
  "role": "producer",
  "ts": 1727340000,
  "voltage_v": 229.8,
  "current_a": 4.35,
  "power_w": 1000.2,
  "energy_wh": 1520,
  "consumption_wh": 380
}
```
`role`: `producer` | `consumer` | `prosumer`. `energy_wh` = sản lượng tích lũy trong phiên.

## 2. Bridge → AI (HTTP)
`POST {AI_API_URL}/forecast`
```json
{ "meter_id": "HH01", "history": [ { "ts": 1727340000, "power_w": 1000.2, "consumption_wh": 380 } ], "horizon_min": 15 }
```
Response:
```json
{ "meter_id": "HH01", "horizon_min": 15, "pred_generation_wh": 250, "pred_consumption_wh": 90, "pred_surplus_wh": 160, "model": "lstm-v1" }
```

## 3. Bridge / Dashboard → Smart Contract
| Hàm | Ai gọi | Mô tả |
|---|---|---|
| `registerMeter(bytes32 meterId, address owner)` | admin | gán meter cho ví |
| `submitReading(bytes32 meterId, uint256 energyWh, uint64 ts)` | oracle (bridge) | ghi số đo đã xác thực |
| `placeOffer(uint256 amountWh, uint256 pricePerKWh)` | người bán | lệnh bán |
| `placeBid(uint256 amountWh, uint256 pricePerKWh)` | người mua | lệnh mua (lock token) |
| `closeAuction()` | oracle/admin | khớp lệnh, thanh toán |

Events: `ReadingSubmitted`, `OfferPlaced`, `BidPlaced`, `TradeMatched(auctionId, seller, buyer, amountWh, price)`, `AuctionClosed`

Đơn vị: năng lượng = **Wh (uint256)**, giá = **token-wei / kWh**, thời gian = **unix seconds**.

## 4. Contract → mọi người
Sau khi deploy, script ghi ra `contracts/deployments/<network>.json`:
```json
{ "network": "sepolia", "chainId": 11155111, "EnergyToken": "0x...", "EnergyMarket": "0x..." }
```
ABI: `contracts/deployments/abi/*.json` — backend và dashboard đọc từ đây, không copy tay.
