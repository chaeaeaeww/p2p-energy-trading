import time
import json
import random
import math
from datetime import datetime
import paho.mqtt.client as mqtt

# ==========================================
# CẤU HÌNH HỆ THỐNG
# ==========================================
# Trỏ IP về máy tính đang chạy MQTT Broker (script broker.js)
BROKER = "192.168.137.1" 
PORT = 1883
PREFIX = "p2p"
HOUSE_ID = "H01" # H01 là hộ có gắn phần cứng thật (máy Pi)
TOPIC_TELEMETRY = f"{PREFIX}/{HOUSE_ID}/telemetry"

# Công suất định mức của H01 (Khớp với cấu hình AI của Lợi)
MAX_PV_W = 4000.0   # 4.0 kW (từ house_pv_kw trong model_config.json)
BASE_LOAD_W = 1500.0 # 1.5 kW (từ house_base_load_w)

# Cờ giả lập
USE_SIMULATED_DATA = True

# ==========================================
# BIẾN TOÀN CỤC: BỘ ĐẾM NĂNG LƯỢNG (WATT-HOUR)
# (Phải là bộ đếm cộng dồn liên tục giống công tơ điện thật)
# ==========================================
total_e_gen_wh = 0.0
total_e_load_wh = 0.0

# ==========================================
# KHỞI TẠO MQTT CLIENT
# ==========================================
client = mqtt.Client(client_id=f"Pi4_Edge_{HOUSE_ID}")

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print(f" Đã kết nối MQTT Broker tại {BROKER}:{PORT}")
    else:
        print(f" Lỗi kết nối MQTT (Mã trạng thái: {rc})")

client.on_connect = on_connect

# ==========================================
# HÀM GIẢ LẬP VẬT LÝ
# ==========================================
def simulate_physics(hour_of_day, delta_time_sec):
    global total_e_gen_wh, total_e_load_wh

    # 1. Giả lập Năng lượng sinh ra từ Pin Mặt trời (Gen)
    sunrise, sunset = 6.0, 17.5 
    if sunrise < hour_of_day < sunset:
        # Đường cong bức xạ hình chuông
        solar_irradiance = math.sin((hour_of_day - sunrise) / (sunset - sunrise) * math.pi)
        # Giả lập mây che ngẫu nhiên
        cloud_factor = random.uniform(0.7, 1.0)
        current_gen_w = MAX_PV_W * solar_irradiance * cloud_factor
    else:
        current_gen_w = 0.0 # Ban đêm không có nắng

    # 2. Giả lập Tải tiêu thụ của hộ gia đình (Load)
    # Tải nền cơ bản dao động nhẹ
    current_load_w = BASE_LOAD_W * random.uniform(0.8, 1.1)
    
    # Cao điểm trưa (bật điều hòa) và tối (nấu ăn, bật đèn)
    if 11.0 <= hour_of_day <= 14.0:
        current_load_w += random.uniform(500, 1000)
    elif 18.0 <= hour_of_day <= 22.0:
        current_load_w += random.uniform(800, 1500)

    # 3. Tính toán năng lượng (Wh) tích lũy trong chu kỳ delta_time_sec
    added_gen_wh = current_gen_w * (delta_time_sec / 3600.0)
    added_load_wh = current_load_w * (delta_time_sec / 3600.0)

    total_e_gen_wh += added_gen_wh
    total_e_load_wh += added_load_wh

    # 4. Giả lập thông số dòng/áp thô
    voltage = round(random.uniform(218.0, 222.0), 1)
    # Công suất tải net (Dư thì phát lên lưới, Thiếu thì lấy từ lưới)
    net_power = current_gen_w - current_load_w
    current = round(abs(net_power) / voltage, 2)

    return voltage, current, round(net_power, 0)

# ==========================================
# VÒNG LẶP CHÍNH
# ==========================================
def main():
    print(f"--- KHỞI ĐỘNG TRẠM IOT (HỘ {HOUSE_ID}) ---")
    
    try:
        client.connect(BROKER, PORT, 60)
        client.loop_start()
    except Exception as e:
        print(f"Không thể kết nối đến Broker {BROKER}. Lỗi: {e}")
        return

    # Chu kỳ gửi dữ liệu (giây) - Đừng để quá nhanh làm nghẽn mạng
    SEND_INTERVAL_SEC = 10 
    
    try:
        while True:
            # Lấy thời gian thực
            now = datetime.now()
            real_time_hour = now.hour + (now.minute / 60.0)
            
            # --- MẸO DEMO: Nếu muốn test lúc nắng to nhất, hãy bỏ comment dòng dưới ---
            # real_time_hour = 12.5 

            # Cập nhật số liệu vật lý
            voltage, current, net_power = simulate_physics(real_time_hour, SEND_INTERVAL_SEC)

            timestamp = int(time.time())

            # Cấu trúc JSON bắt buộc phải khớp với định dạng yêu cầu của bridge.js
            payload = {
                "houseId": HOUSE_ID,
                "V": voltage,
                "I": current,
                "P": net_power,
                "E_gen_Wh": round(total_e_gen_wh, 2),
                "E_load_Wh": round(total_e_load_wh, 2),
                "ts": timestamp
            }

            # Bắn lên MQTT
            client.publish(TOPIC_TELEMETRY, json.dumps(payload), qos=1)
            
            status = "DƯ ĐIỆN" if net_power > 0 else "THIẾU ĐIỆN"
            print(f"[{time.strftime('%H:%M:%S')}] Telemetry gửi: {status} (Công tơ: Gen {payload['E_gen_Wh']}Wh | Load {payload['E_load_Wh']}Wh)")

            time.sleep(SEND_INTERVAL_SEC)
            
    except KeyboardInterrupt:
        print("\nĐang ngắt kết nối an toàn...")
        client.loop_stop()
        client.disconnect()
        print("Đã tắt Trạm IoT.")

if __name__ == "__main__":
    main()