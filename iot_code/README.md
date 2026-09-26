# iot_code/ — Tầng IoT (đo đạc & phát dữ liệu)

**Phụ trách:** TV1

## Cấu trúc
```
iot_code/
├── simulator/    # simulate_meters.py — giả lập nhiều hộ (producer/consumer) publish MQTT
├── esp32/        # firmware ESP32 (Arduino/PlatformIO) + sơ đồ đấu nối cảm biến (INA219/ACS712...)
└── requirements.txt
```

## Chạy simulator
```bash
cd iot_code
pip install -r requirements.txt     # paho-mqtt, python-dotenv
python simulator/simulate_meters.py --meters 4 --interval 5
```

## Cần có
- [ ] Simulator có đường cong mặt trời theo giờ + nhiễu, nhiều hộ
- [ ] Payload đúng `docs/interfaces.md` mục 1
- [ ] (Tùy chọn) ESP32 thật + ảnh/sơ đồ mạch trong `esp32/`
