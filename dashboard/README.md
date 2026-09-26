# Web3 Energy Dashboard — P2P Solar Energy Trading

Dashboard thời gian thực cho đồ án: **ESP32 (MQTT) → AI dự báo → Smart Contract đấu giá P2P**, ký giao dịch bằng **MetaMask**, truy vết trên **Etherscan**.
Stack: React 18 + Vite · ethers.js v6 · MQTT.js (WebSocket) · Recharts.

> Dashboard **không sinh dữ liệu giả**. Nếu chưa có thiết bị, AI hoặc contract, giao diện hiện trạng thái trống kèm cảnh báo cấu hình.

## Chức năng

| Nhóm | Chức năng | Nguồn dữ liệu |
|---|---|---|
| IoT | V, I, P, điện dư theo từng hộ; biểu đồ realtime; bảng bản ghi; trạng thái LIVE / NO SIGNAL | MQTT `p2p/+/telemetry` |
| AI | Dự báo phát / tiêu thụ / dư thiếu theo slot; so với số đo thực tế on-chain; nút **Dùng dự báo → điền lệnh** | MQTT `p2p/+/forecast` + event `MeterReported` |
| Ví | Kết nối MetaMask, tự nhận lại ví, bắt sự kiện đổi tài khoản/mạng, cảnh báo sai mạng + nút chuyển/thêm mạng, số dư ETH và token | MetaMask |
| Contract | Gắn ví ↔ hộ (`register`), đặt lệnh BÁN/MUA (`placeAsk`/`placeBid`, tự `approve` escrow), sổ lệnh theo slot | `EnergyMarket`, `EnergyToken` |
| Truy vết | Bảng event on-chain (đăng ký, đặt lệnh, khớp lệnh, quyết toán, thưởng) + link Etherscan; danh sách giao dịch vừa ký | Log của contract |

Interface bắt buộc giữa các tầng: **[CONTRACT_INTERFACE.md](./CONTRACT_INTERFACE.md)**.

## Cài đặt & chạy

```bash
cd dashboard
npm install
cp .env.example .env      # điền broker, RPC, địa chỉ contract
npm run dev               # http://localhost:5173
```

Mỗi lần sửa `.env` phải dừng rồi chạy lại `npm run dev`.

## Cấu hình broker MQTT cho trình duyệt

Trình duyệt chỉ nói chuyện với MQTT qua **WebSocket**. Với Mosquitto, thêm vào `mosquitto.conf`:

```
listener 1883
listener 9001
protocol websockets
allow_anonymous true
```

- ESP32 / simulator publish vào cổng **1883** (TCP).
- Dashboard nối vào cổng **9001**, đặt `VITE_MQTT_WS_URL=ws://localhost:9001`.
- Nếu dùng HiveMQ public, đặt `wss://broker.hivemq.com:8884/mqtt`. Khi đó nên đổi `VITE_MQTT_TOPIC_PREFIX` thành chuỗi riêng của nhóm để không lẫn dữ liệu với người khác.

## Kết nối blockchain

| Mạng | `VITE_CHAIN_ID` | `VITE_RPC_URL` | `VITE_ETHERSCAN_BASE_URL` |
|---|---|---|---|
| Hardhat local | `31337` | `http://127.0.0.1:8545` | *(để trống)* |
| Sepolia | `11155111` | Infura/Alchemy URL | `https://sepolia.etherscan.io` |

- Dashboard **đọc** dữ liệu qua `VITE_RPC_URL`, nên xem được mà không cần ví, và **ghi** (ký giao dịch) qua MetaMask.
- Hardhat local: import private key của một account Hardhat vào MetaMask. Nút "Chuyển mạng" tự thêm mạng 31337 nếu MetaMask chưa có.
- Sau khi deploy lại contract trên Hardhat, vào MetaMask → *Settings → Advanced → Clear activity tab data* để reset nonce.

## Kịch bản demo

1. Chạy broker, Hardhat node, deploy contract, rồi chạy gateway (AI + oracle).
2. Bật ESP32 hoặc simulator. Tab hộ xuất hiện, trạng thái chuyển sang **LIVE**.
3. Kết nối MetaMask, bấm **Gắn ví với hộ**. Event `HouseRegistered` xuất hiện.
4. Khi AI publish forecast, bấm **Dùng dự báo → điền lệnh**, nhập giá rồi gửi. Event `OrderPlaced` xuất hiện.
5. Gateway đóng phiên. Các event `OrderMatched`, `Settled` xuất hiện và số dư token thay đổi. Bấm hash để mở Etherscan.

## Cấu trúc mã

```
src/
├── App.jsx                 # bố cục trang, ghép các nguồn dữ liệu
├── config.js               # đọc biến môi trường
├── hooks/useMqtt.js        # MQTT over WebSocket, gom dữ liệu theo houseId
├── hooks/useWallet.js      # MetaMask: tài khoản, mạng, số dư
├── hooks/useMarket.js      # đọc/ghi contract, quét event on-chain
├── components/MarketPanel.jsx
├── components/ui.jsx
└── lib/abi.js, lib/format.js
```

## Bảo mật

Không đưa private key hoặc seed phrase vào frontend hay `.env` của dashboard. Mọi giao dịch đều do người dùng ký trong MetaMask.
