# Tầng AI — Dự báo sản lượng & tiêu thụ điện (LSTM)

## Cấu trúc
```
ai_model/
├── requirements.txt
├── notebook/                 # model-gen.ipynb (sản lượng), model-load.ipynb (tiêu thụ) — train trên Kaggle
├── src/service_lstm.py       # <- CHẠY FILE NÀY
└── weights_lstm/             # model, scaler, config và dữ liệu mẫu đã train sẵn
```
Service đọc `.env` ở thư mục gốc repo (copy từ `.env.example`).

## Model dùng
- **Gen**: `lstm_solar_forecast.h5` (Solar Power Generation Data, Kaggle) — dự báo
  `capacity_factor` (0-1) chung cho cả hệ thống, phóng ra từng hộ theo `pv_kw`
  (`house_pv_kw` trong `model_config.json`). Các giá trị này phải được đồng bộ
  thủ công với `genW` trong cấu hình Smart Contract; service không tự đọc `genW`.
- **Load**: `lstm_consumption_forecast.h5` (Smart Home Dataset with Weather - HomeC,
  Kaggle) — dự báo `consumption_kw` ở thang đo của hộ HomeC, phóng ra từng hộ theo
  `house_base_load_w` trong `model_config_consumption.json`. Các giá trị này phải
  được đồng bộ thủ công với `loadW` trong cấu hình Smart Contract; service không
  tự đọc `loadW`.
  **Giới hạn đã biết**: dùng chung 1 pattern hộ gia đình Mỹ cho cả 4 hộ trong đồ án,
  LSTM chỉ nhỉnh hơn naive baseline ~2.5% MAE (nêu trong báo cáo, không phải lỗi code).

## Chạy
```bash
cd ai_model
pip install -r requirements.txt
python src/service_lstm.py        # chạy thường trực: MQTT + HTTP (cổng 8000)
```
Nếu chạy `npm run mock` để giả lập telemetry các hộ khác, đặt `MOCK_FORECAST=false` (service này thay thế phần forecast của mock).
Thứ tự khởi động **không quan trọng**: bật AI trước broker, tắt/bật lại broker, Raspberry Pi
bật lên giữa chừng… service đều tự kết nối lại và nhận dữ liệu tiếp.

## Luôn sẵn sàng cho phần cứng
| Tình huống | Hành vi |
|---|---|
| Broker chưa bật / bị tắt giữa chừng | tự kết nối lại (1–15 s), subscribe lại topic |
| Raspberry Pi mới bật, mất sóng, khởi động lại | nhận thiết bị mới tự động; bộ đếm Wh reset vẫn tính đúng |
| Chỉ vài hộ có phần cứng | cf quan sát chỉ tính trên các hộ **có gửi dữ liệu** |
| 15' không có thiết bị nào gửi dữ liệu | lấp bước lịch sử bằng giá trị dự báo (không kéo lịch sử về 0) |
| Có bridge (`chain/slot` còn mới) | publish dự báo cho slot on-chain kế tiếp (như cũ) |
| Không có bridge | vẫn publish dự báo mỗi `SLOT_DURATION` giây (`"mode":"standalone"`) để dashboard/thiết bị đọc |
| Khởi động lúc ban ngày | lịch sử mẫu được xoay theo giờ hiện tại nên dự báo đầu tiên đã hợp lý (trước đây luôn ≈ 0 Wh vì mẫu kết thúc lúc 23:45) |

Trạng thái AI: topic `<prefix>/ai/status` (retained, `online:true/false`, có Last Will).

## Endpoint HTTP
| Endpoint | Nội dung |
|---|---|
| `GET /health` | MQTT đã kết nối chưa, chế độ chain/standalone, số bước lịch sử |
| `GET /status` | dữ liệu từng thiết bị AI đang đọc (V, I, P, Wh, online, lastSeen) + kết quả bucket gần nhất |
| `GET /forecast?slot_duration_sec=120` | dự báo Wh từng hộ cho 1 slot |
| `POST /telemetry/{houseId}` | thiết bị không dùng MQTT gửi cùng payload như edge node Raspberry Pi 4 |

Chạy bằng `uvicorn src.service_lstm:app --port 8000` cũng được (MQTT + nạp mẫu tự khởi động theo).

## Biến môi trường (`.env` ở thư mục gốc repo)
| Biến | Mặc định | Ý nghĩa |
|---|---:|---|
| `MQTT_HOST` / `MQTT_PORT` | `localhost` / `1883` | broker (hoặc `MQTT_URL=mqtt://host:port`) |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | trống | nếu broker cần đăng nhập |
| `MQTT_TOPIC_PREFIX` | `p2p` | phải trùng edge node Raspberry Pi 4 và dashboard |
| `SLOT_DURATION` | `120` | nhịp publish ở chế độ standalone (giây) |
| `AI_HOUSES` | theo `model_config*.json` | ghi đè/bổ sung công suất hộ: `H01:20:5,H05:3000:1200` (mã:W phát:W dùng) — dùng cho hộ gắn phần cứng thật |
| `AI_HTTP_PORT` / `AI_HTTP_HOST` | cổng của `AI_API_URL` (8000) / `0.0.0.0` | HTTP server |
| `SITE_LAT` / `SITE_LON` | `10.7626` / `106.6602` | toạ độ gọi Open-Meteo |
| `SITE_UTC_OFFSET` | `7` | múi giờ địa phương cho feature giờ trong ngày |

## Cách hoạt động
1. Nghe `<prefix>/<houseId>/telemetry` (`E_gen_Wh`/`E_load_Wh` cộng dồn) và `<prefix>/chain/slot` (bridge).
2. Luồng hẹn giờ riêng, mỗi 15 phút thực tế: tính công suất trung bình từng hộ = ΔWh / Δt thực,
   quy ra `capacity_factor` và `consumption_kw` tham chiếu, đẩy vào lịch sử, chạy lại 2 LSTM.
3. Mỗi slot (on-chain hoặc standalone): quy đổi dự báo ra Wh theo `slotDuration`, publish
   `<prefix>/<houseId>/forecast` với `{houseId, slot, genPredWh, loadPredWh, model, mode, ts}`.

## Ghi chú về notebook
`scaler_X.pkl` trong `weights_lstm/` có feature `cf_lag_24h` với miền [0, 1], tức trọng số đã được
train theo `capacity_factor` — khớp với service. Riêng `notebook/model-gen.ipynb` trong repo vẫn là
bản cũ (target `power_kw`, feature `power_lag_24h`), cần cập nhật lại cho khớp trọng số để báo cáo
tái lập được.
