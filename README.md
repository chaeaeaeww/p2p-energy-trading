# ☀️ P2P Solar Energy Trading — CPS tích hợp IoT · AI · Blockchain

> Đồ án cuối kỳ học phần **Cơ sở Blockchain và Ứng dụng**
> **Đề tài 1:** Hệ thống quản lý và giao dịch năng lượng mặt trời P2P
> GVHD: Huỳnh Thế Thiện · Nhóm: **08**

Các hộ gia đình/nhà máy có pin mặt trời đo sản lượng điện dư (IoT), dùng AI dự báo sản lượng và nhu cầu tiêu thụ, sau đó Smart Contract tự động mở phiên đấu giá, khớp lệnh và thanh toán bằng token.

## Thành viên & phân công

| Thành viên | MSSV | Phụ trách | Thư mục |
|---|---|---|---|
| Đoàn Minh Duy Bình | 23139005 | Tầng IoT | `iot_code/` |
| Thái Hữu Lợi | 23139027 | Tầng AI | `ai_model/` |
| Vũ Quốc Bảo | 23139004 | Smart Contract | `contracts/` |
| Lê Nhật Nam | 23139029 | Web3 Dashboard | `dashboard/` |

## Kiến trúc tổng quan

```
 [ESP32 / Simulator] --MQTT--> [AI forecast (Regression/LSTM)]
                                          |
                                ethers.js / web3.py
                                          v
                 [Smart Contract: EnergyToken + EnergyMarket]
                    (Hardhat local / Sepolia testnet)
                                          ^
                    [Web3 Dashboard + MetaMask + Etherscan]
```

| Tầng | Vai trò |
|---|---|
| IoT | Đo dòng/áp, sản lượng điện dư → publish MQTT/HTTP |
| AI | Dự báo sản lượng & nhu cầu tiêu thụ theo chuỗi thời gian |
| Blockchain | Nhận dữ liệu, mở phiên đấu giá, khớp lệnh, thanh toán token |
| Dashboard | Kết nối ví, hiển thị realtime, đặt lệnh, truy vết giao dịch |

## Cấu trúc repo

```
.
├── README.md             # Hướng dẫn cài đặt & chạy demo
├── Report_Nhom08.pdf     # Báo cáo kỹ thuật (thêm khi hoàn thành)
├── .env.example          # Mẫu biến môi trường — copy thành .env
├── docs/
│   ├── report/           # Bản thảo báo cáo
│   └── images/           # Sơ đồ, ảnh chụp demo
├── contracts/            # Smart Contracts (Solidity) + deploy script + test
├── ai_model/
│   ├── data/raw/         # Dữ liệu gốc
│   ├── data/processed/   # Dữ liệu đã xử lý
│   ├── notebooks/        # EDA, huấn luyện, đánh giá
│   ├── src/              # Code train / predict / API
│   └── weights/          # File trọng số mô hình
├── iot_code/
│   ├── simulator/        # Giả lập smart meter (Python, MQTT)
│   └── esp32/            # Firmware ESP32
└── dashboard/
    └── src/              # Web3 dashboard (ethers.js, MetaMask)
```

## Yêu cầu môi trường

- Node.js ≥ 18, npm
- Python ≥ 3.10
- MQTT broker: Mosquitto (local) hoặc `broker.hivemq.com`
- MetaMask + ví testnet Sepolia (có SepoliaETH từ faucet)
- (Tùy chọn) Arduino IDE / PlatformIO cho ESP32

## Cài đặt

```bash
git clone https://github.com/<username>/<repo>.git
cd <repo>
cp .env.example .env      # điền RPC URL, private key, địa chỉ contract...
```

## Chạy demo End-to-End (IoT → AI → Smart Contract)

| Bước | Lệnh | Thư mục |
|---|---|---|
| 1. Chạy blockchain local | `npx hardhat node` | `contracts/` |
| 2. Deploy contract | `npx hardhat run scripts/deploy.js --network localhost` | `contracts/` |
| 3. Chạy mô hình AI | `python src/serve.py` | `ai_model/` |
| 4. Chạy simulator IoT | `python simulator/simulate_meters.py` | `iot_code/` |
| 5. Mở dashboard | `npm install && npm run dev` | `dashboard/` |

> Lệnh cụ thể sẽ được cập nhật khi từng tầng hoàn thiện.
