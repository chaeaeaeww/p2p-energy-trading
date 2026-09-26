# ☀️ P2P Solar Energy Trading — CPS tích hợp IoT · AI · Blockchain

> Đồ án cuối kỳ học phần **Cơ sở Blockchain và Ứng dụng** — **Đề tài 1: Hệ thống quản lý và giao dịch năng lượng mặt trời P2P**
> GVHD: Huỳnh Thế Thiện · Nhóm: **XX**

Các hộ gia đình/nhà máy có pin mặt trời đo sản lượng điện dư (IoT), dùng AI dự báo sản lượng và nhu cầu, sau đó Smart Contract tự động mở phiên đấu giá, khớp lệnh và thanh toán bằng token.

## Thành viên & phân công

| Thành viên | MSSV | Phụ trách | Thư mục |
|---|---|---|---|
| TV1 | | Tầng IoT (ESP32 / simulator, MQTT) | `iot_code/` |
| TV2 | | Tầng AI (Regression / LSTM) | `ai_model/` |
| TV3 | | Smart Contract (Solidity, Hardhat) | `contracts/` |
| An | | Backend bridge + Web3 Dashboard | `backend/`, `dashboard/` |

## Kiến trúc tổng quan

```
[Smart meter / ESP32 / Simulator] --MQTT--> [Backend bridge] --HTTP--> [AI forecast]
                                                  |                          |
                                                  +------ ethers.js / web3.py
                                                                 v
                                        [EnergyToken + EnergyMarket (Sepolia/Hardhat)]
                                                                 ^
                                               [Dashboard + MetaMask + Etherscan]
```
Chi tiết: [`docs/architecture.md`](docs/architecture.md) · Định dạng dữ liệu giữa các tầng: [`docs/interfaces.md`](docs/interfaces.md)

## Cấu trúc repo

```
.
├── README.md               # Hướng dẫn cài đặt & chạy demo (file này)
├── Report_NhomXX.pdf       # Báo cáo kỹ thuật chính thức (thêm khi hoàn thành)
├── .env.example            # Mẫu biến môi trường — copy thành .env
├── docs/                   # Kiến trúc, interface giữa các tầng, bản thảo báo cáo
├── contracts/              # Smart Contracts (Solidity) + deploy script + test
├── ai_model/               # Dữ liệu, notebook huấn luyện, trọng số mô hình, API dự báo
├── iot_code/               # Simulator (Python) + firmware ESP32
├── backend/                # Bridge: MQTT → AI → Smart Contract
└── dashboard/              # Web3 dashboard (MetaMask, realtime, Etherscan)
```

## Yêu cầu môi trường

- Node.js ≥ 18, npm
- Python ≥ 3.10
- MQTT broker: Mosquitto (local) hoặc `broker.hivemq.com` (public)
- MetaMask + ví testnet Sepolia (có SepoliaETH từ faucet)
- (Tùy chọn) Arduino IDE / PlatformIO cho ESP32

## Cài đặt

```bash
git clone https://github.com/<org-or-user>/p2p-energy-trading.git
cd p2p-energy-trading
cp .env.example .env        # điền RPC URL, private key, địa chỉ contract...
```
Từng tầng có hướng dẫn cài riêng trong `README.md` của thư mục đó.

## Chạy demo End-to-End (IoT → AI → Smart Contract)

| Bước | Lệnh | Thư mục |
|---|---|---|
| 1. Chạy blockchain local | `npx hardhat node` | `contracts/` |
| 2. Deploy contract | `npx hardhat run scripts/deploy.js --network localhost` | `contracts/` |
| 3. Chạy API dự báo AI | `python src/serve.py` | `ai_model/` |
| 4. Chạy bridge | `python src/bridge.py` | `backend/` |
| 5. Chạy simulator IoT | `python simulator/simulate_meters.py` | `iot_code/` |
| 6. Mở dashboard | `npm run dev` | `dashboard/` |

> Lệnh cụ thể sẽ được cập nhật khi từng tầng hoàn thiện.

## Tính năng nâng cao (Innovation)

- [ ] Web3 Dashboard realtime + MetaMask + truy vết giao dịch trên Etherscan
- [ ] (Tùy chọn) Chainlink Oracle / Edge AI trên ESP32 (TFLite) / ZK-proof

## Checklist nộp bài

- [ ] Luồng End-to-End chạy thông suốt IoT → AI → Smart Contract
- [ ] Contract deploy thành công trên Sepolia/Amoy hoặc Hardhat local
- [ ] Backend/Frontend dùng ethers.js hoặc web3.py
- [ ] `Report_NhomXX.pdf` (10–15 trang)
- [ ] Repo để chế độ **Public**, trưởng nhóm nộp link lên LMS
