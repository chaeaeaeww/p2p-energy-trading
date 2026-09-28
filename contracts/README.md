# Tầng Blockchain: EnergyToken + EnergyMarket

Smart contract Solidity 0.8.24, Hardhat 2 và OpenZeppelin 5. Bridge đẩy dữ liệu IoT/AI lên chain bằng ethers.js.

## Thành phần

| File | Vai trò |
|---|---|
| `contracts/EnergyToken.sol` | ERC-20 **SOLAR** dùng để thanh toán. `MINTER_ROLE` mint token thưởng, `MARKET_ROLE` chuyển tiền phạt |
| `contracts/EnergyMarket.sol` | Đăng ký hộ, nhận dự báo và chỉ số công tơ từ oracle, đặt lệnh, khớp lệnh bằng đấu giá đôi giá đồng nhất, thanh toán kèm phạt và thưởng |
| `test/EnergyMarket.test.js` | 19 test cho luồng chính và các trường hợp revert |
| `scripts/deploy.js` | Deploy, cấp quyền, ghi địa chỉ vào `deployments/`, `.env` và `dashboard/.env` |
| `scripts/seed.js` | Đăng ký các hộ H01–H04 và cấp 1000 SOLAR cho mỗi hộ |
| `scripts/bridge.js` | Oracle: MQTT (IoT + AI) → `submitForecast` / `reportMeter` / `closeAuction` / `settle` |
| `scripts/broker.js` | MQTT broker viết bằng Node (TCP 1883 + WebSocket 9001), không cần cài Mosquitto |
| `scripts/mock-iot-ai.js` | Giả lập tạm IoT + AI để tập dượt khi 2 tầng kia chưa xong |
| `scripts/demo-flow.js` | Chạy trọn 1 phiên bằng script, không cần MQTT (phương án dự phòng) |
| `tasks/market.js` | Lệnh `status`, `advance`, `close`, `report`, `settle` |

## Vòng đời 1 slot

Slot dài `SLOT_DURATION` giây (local mặc định 120 s, Sepolia 300 s), tính theo `slot = block.timestamp / SLOT_DURATION`.

1. **Dự báo:** AI publish `p2p/<houseId>/forecast`. Bridge gọi `submitForecast(slot, account, genPredWh, loadPredWh)` và phát event `ForecastSubmitted`. Sau đó lệnh bán của hộ không được vượt quá phần dư dự báo, nếu vượt sẽ revert `ExceedsForecast`.
2. **Đặt lệnh:** hộ dư điện gọi `placeAsk`. Hộ thiếu điện gọi `approve` rồi `placeBid`, token bị khoá vào escrow. Event: `OrderPlaced`.
3. **Khớp lệnh:** mỗi slot nhận lệnh đến hết slot. Hết slot, bridge gọi `closeAuction(slot)`.
   - Lệnh mua xếp giá giảm dần, lệnh bán xếp giá tăng dần; cùng giá thì lệnh đặt trước được ưu tiên.
   - Khớp lần lượt chừng nào giá mua còn ≥ giá bán.
   - **Giá clearing** bằng trung bình giá của cặp lệnh khớp cuối cùng. Mọi cặp khớp đều thanh toán theo giá này.
   - Escrow thừa được hoàn ngay cho người mua. Event: `OrderMatched`, `AuctionClosed`.
4. **Đo thực tế:** hết slot, bridge cộng dồn Wh từ telemetry rồi gọi `reportMeter`. Event: `MeterReported`. Mỗi chỉ số chỉ ghi được 1 lần, không sửa được.
5. **Thanh toán:** `settle(slot)`.
   - Người bán nhận `điện giao thực tế × giá clearing` cùng thưởng `REWARD_PER_KWH`.
   - Với phần giao thiếu: người mua được hoàn tiền, người bán bị phạt `PENALTY_BPS` (mặc định 20%) giá trị phần thiếu, tiền phạt chuyển cho người mua.
   - Event: `Settled`, `RewardPaid`.

### Phân quyền

| Hành động | Ai được làm |
|---|---|
| `submitForecast`, `reportMeter` | Chỉ ví có `ORACLE_ROLE` (bridge) |
| `registerFor`, `setParams`, mint token | Chỉ admin |
| `closeAuction` | Oracle được đóng sớm; người khác chỉ đóng được khi slot đã kết thúc |
| `settle` | Ai cũng gọi được khi đủ điều kiện |

### Giới hạn chống spam và tràn gas

- Tối đa 40 lệnh mỗi slot; đóng một sổ lệnh đầy tốn khoảng 3,1 triệu gas.
- Chỉ đặt lệnh trước tối đa 96 slot.
- Mỗi hộ chỉ được đứng 1 phía (mua hoặc bán) trong 1 slot.

## Cài đặt (1 lần)

```bash
cd contracts
npm install
npx hardhat compile
npx hardhat test
```

## Chạy demo trên máy local

Mở 5 terminal, terminal nào cũng `cd contracts` trước, trừ terminal dashboard:

| # | Lệnh | Để làm gì |
|---|---|---|
| 1 | `npm run node` | Blockchain local chainId 31337, cứ 3 s mine 1 block |
| 2 | `npm run broker` | MQTT broker (TCP 1883, WS 9001) |
| 3 | `npm run deploy:local` rồi `npm run seed:local` | Deploy và đăng ký H01–H04, in private key để import MetaMask |
| 4 | `npm run bridge:local` | Oracle bridge |
| 5 | `npm run mock` (hoặc Raspberry Pi 4 và AI thật) | Nguồn dữ liệu IoT + AI |
| 6 | `cd dashboard` → `npm run dev` | Web3 dashboard |

- Muốn các hộ tự đặt lệnh theo dự báo AI: đặt `AUTO_TRADE=true` trong `.env` trước khi chạy bridge.
- Muốn tự bấm lệnh trên dashboard: để `AUTO_TRADE=false`.

Lệnh điều khiển khi demo:

```bash
npx hardhat status --network localhost                 # slot hiện tại, sổ lệnh, số dư
npx hardhat advance --network localhost                # tua thời gian 1 slot (chỉ local)
npx hardhat close  --network localhost --slot <N>      # đóng phiên thủ công
npx hardhat report --network localhost --slot <N> --house H01 --produced 900 --consumed 450
npx hardhat settle --network localhost --slot <N>
npm run demo:local                                     # chạy trọn 1 phiên bằng script
```

## Deploy lên Sepolia

1. Điền vào `.env` ở thư mục gốc:
   - `PRIVATE_KEY`: ví riêng dùng cho testnet, có SepoliaETH.
   - `SEPOLIA_RPC_URL`: Alchemy hoặc Infura; để trống thì dùng RPC public.
   - `ETHERSCAN_API_KEY`: để verify contract.
2. Chạy `npm run deploy:sepolia`. Script tự verify contract trên Etherscan nếu có API key.
3. Điền `SEED_HOUSES=H01:0x...,H02:0x...` (địa chỉ MetaMask của các thành viên) rồi chạy `npm run seed:sepolia`.
4. Chạy `npm run bridge:sepolia`. Dashboard lúc này có link Etherscan cho từng giao dịch.

## Định dạng MQTT mà bridge đọc

```text
p2p/<houseId>/telemetry   {"houseId":"H01","V":220.1,"I":12.3,"P":2707,"E_gen_Wh":152.3,"E_load_Wh":80.1,"ts":1790000000}
p2p/<houseId>/forecast    {"houseId":"H01","slot":59681792,"genPredWh":420,"loadPredWh":300,"model":"lstm"}
p2p/chain/slot            (bridge publish, retained) {"slot":59681791,"slotDuration":120,"slotStart":...}
```

- `E_gen_Wh` và `E_load_Wh` là **bộ đếm cộng dồn**, giống công tơ điện (edge node Raspberry Pi 4 gửi đúng dạng này).
- AI nên đọc `p2p/chain/slot` rồi dự báo cho `slot + 1`. Nếu message không có `slot`, bridge tự hiểu là slot kế tiếp.
