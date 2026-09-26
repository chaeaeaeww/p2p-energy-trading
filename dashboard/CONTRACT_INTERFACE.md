# Interface giữa Dashboard ↔ Smart Contract ↔ IoT/AI

Dashboard **không có dữ liệu giả**. Nó chỉ hiển thị những gì nhận được từ 3 nguồn dưới đây, nên các tầng khác phải publish/emit **đúng định dạng** này. Nếu nhóm đổi tên hàm hoặc field, sửa `src/lib/abi.js` (contract) hoặc `src/lib/format.js` (MQTT).

---

## 1. MQTT: tầng IoT (Bình)

**Topic:** `p2p/<houseId>/telemetry` · QoS 1 · chu kỳ 1–10 giây

```json
{"houseId":"H01","ts":1727350000,"V":18.2,"I":2.1,"P":38.2,"E_gen_Wh":12.4,"E_load_Wh":8.1}
```

| Field | Bắt buộc | Ý nghĩa |
|---|---|---|
| `V` / `voltage` | có | Điện áp (V) |
| `I` / `current` | có | Dòng (A) |
| `P` / `power` | không | Công suất (W). Nếu thiếu, dashboard tự tính V·I |
| `ts` / `timestamp` | nên có | Epoch **giây** hoặc mili-giây. Nếu thiếu, dùng giờ nhận |
| `E_gen_Wh`, `E_load_Wh` | nên có | Điện phát / tiêu thụ cộng dồn (Wh). Dashboard dùng để tính điện dư |
| `houseId` | không | Nếu thiếu, lấy từ đoạn giữa của topic |

Message không phải JSON hoặc thiếu V/I/P sẽ bị bỏ qua và được đếm trong mục "bỏ qua N message sai định dạng".

## 2. MQTT: tầng AI (Lợi, qua gateway)

**Topic:** `p2p/<houseId>/forecast` · QoS 1 · **retain = true**, để dashboard mở sau vẫn thấy dự báo gần nhất

```json
{"houseId":"H01","slot":42,"genPredWh":420,"loadPredWh":300,"model":"LSTM","ts":1727350000}
```

`slot` phải trùng số slot của contract. Nhờ vậy dashboard ghép được dự báo với số đo thực tế on-chain (`MeterReported`) và nút "Dùng dự báo → điền lệnh" điền đúng phiên.

---

## 3. Smart Contract (Bảo)

Đơn vị: **năng lượng = Wh (`uint256`)**. **Giá = đơn vị nhỏ nhất của token / Wh.** Ví dụ token 18 decimals, 2 ENT/kWh ⇒ `pricePerWh = 2e18 / 1000 = 2e15`. Dashboard nhập và hiển thị giá theo `token/kWh` và tự quy đổi.

### EnergyToken (ERC-20, OpenZeppelin)
`name()`, `symbol()`, `decimals()`, `balanceOf()`, `allowance()`, `approve()`

### EnergyMarket: hàm dashboard gọi

```solidity
struct Order { uint256 id; address trader; bool isBid; uint256 qtyWh; uint256 pricePerWh; uint256 filledWh; }

function token() external view returns (address);            // địa chỉ EnergyToken
function currentSlot() external view returns (uint256);      // slot ĐANG MỞ nhận lệnh
function houseOf(address) external view returns (string);    // "" nếu chưa đăng ký
function getOrders(uint256 slot) external view returns (Order[] memory);

function register(string calldata houseId) external;         // gắn ví ↔ hộ (ESP32)
function placeAsk(uint256 slot, uint256 qtyWh, uint256 pricePerWh) external returns (uint256 orderId);
function placeBid(uint256 slot, uint256 qtyWh, uint256 pricePerWh) external returns (uint256 orderId);
// placeBid: transferFrom(msg.sender, this, qtyWh * pricePerWh) để giữ escrow
//           → dashboard tự gọi approve() trước nếu allowance chưa đủ
```

### Events: dashboard dùng để truy vết on-chain (bắt buộc emit)

```solidity
event HouseRegistered(address indexed account, string houseId);
event MeterReported(uint256 indexed slot, address indexed account, uint256 producedWh, uint256 consumedWh);
event OrderPlaced(uint256 indexed slot, uint256 indexed orderId, address indexed trader, bool isBid, uint256 qtyWh, uint256 pricePerWh);
event AuctionClosed(uint256 indexed slot, uint256 clearingPricePerWh, uint256 matchedWh);
event OrderMatched(uint256 indexed slot, address indexed buyer, address indexed seller, uint256 qtyWh, uint256 pricePerWh);
event Settled(uint256 indexed slot, address indexed seller, address indexed buyer, uint256 deliveredWh, uint256 payment, uint256 penalty);
event RewardPaid(uint256 indexed slot, address indexed account, uint256 amount);
```

Các hàm do **gateway/oracle** gọi (dashboard không gọi, chỉ đọc event): `reportMeter(...)`, `closeAuction(...)`, `settle(...)`. Tên và tham số của các hàm này do Bảo tự quyết.

### Kiểm tra nhanh sau khi deploy
1. Điền `VITE_ENERGY_MARKET_ADDRESS` vào `.env` rồi chạy `npm run dev`.
2. Nếu đúng interface: thấy số slot, số dư token, sổ lệnh.
3. Nếu sai tên hàm: khung cảnh báo trên đầu trang hiện "Lỗi đọc contract: …". Khi đó sửa contract hoặc sửa `src/lib/abi.js` cho khớp.
