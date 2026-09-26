# ☀️ P2P Solar Energy Trading — CPS tích hợp IoT · AI · Blockchain

> Project cuối kỳ học phần **Blockchain và Ứng dụng**<br>
> **Đề tài 1:** Hệ thống quản lý và giao dịch năng lượng mặt trời P2P<br>
> GVHD: Huỳnh Thế Thiện · Nhóm: **08**

Các hộ gia đình/nhà máy có pin mặt trời đo sản lượng điện dư (IoT), dùng AI dự báo sản lượng và nhu cầu tiêu thụ, sau đó Smart Contract tự động mở phiên đấu giá, khớp lệnh và thanh toán bằng token.

## Thành viên & phân công

| Thành viên | MSSV | Phụ trách |
|---|---|---|
| Đoàn Minh Duy Bình | 23139005 | Tầng IoT |
| Thái Hữu Lợi | 23139027 | Tầng AI |
| Vũ Quốc Bảo | 23139004 | Smart Contract |
| Lê Nhật Nam | 23139029 | Web3 Dashboard |

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

