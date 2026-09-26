# backend/ — Bridge (Oracle off-chain): MQTT → AI → Smart Contract

**Phụ trách:** An

## Cấu trúc
```
backend/
├── src/
│   ├── bridge.py        # subscribe MQTT, gọi AI, gửi tx lên contract
│   ├── chain.py         # web3.py: load ABI/địa chỉ từ contracts/deployments/
│   └── config.py        # đọc ../.env
└── requirements.txt     # paho-mqtt, web3, requests, python-dotenv
```

## Chạy
```bash
cd backend
pip install -r requirements.txt
python src/bridge.py
```

## Cần có
- [ ] Subscribe `p2p/+/telemetry`, gom theo phiên
- [ ] Gọi `/forecast`, gửi `submitReading`, tự đặt lệnh theo dự báo
- [ ] Gọi `closeAuction()` khi hết phiên
- [ ] Log tx hash để đưa vào báo cáo
