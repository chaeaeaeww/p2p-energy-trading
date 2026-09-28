import random
import math
from datetime import datetime

USE_SIMULATED_DATA = True 

# --- THÔNG SỐ VẬT LÝ HỆ THỐNG LƯU TRỮ ---
BATTERY_CAPACITY_WH = 5000.0  # Dung lượng tối đa 5 kWh
current_battery_wh = 2500.0   # Khởi động hệ thống với Pin ở mức 50%

# Hệ số nhân tốc độ để test: Giúp pin sạc/xả nhanh hơn trong lúc Demo (Ví dụ x100)
DEMO_SPEED_MULTIPLIER = 100.0 

def calculate_energy_profile(hour_of_day):
    global current_battery_wh
    
    # 1. NGUỒN PHÁT (Tối đa 3000W lúc giữa trưa)
    sunrise, sunset = 6.0, 17.5 
    solar_irradiance = math.sin((hour_of_day - sunrise) / (sunset - sunrise) * math.pi) if sunrise < hour_of_day < sunset else 0
    generated_power = 3000.0 * solar_irradiance * random.uniform(0.85, 1.0)

    # 2. TẢI TIÊU THỤ
    base_load = random.uniform(200, 300)
    if 18.0 <= hour_of_day <= 22.0:
        load_power = base_load + random.uniform(1000, 1500)
    elif 11.0 <= hour_of_day <= 13.0:
        load_power = base_load + random.uniform(600, 900)
    else:
        load_power = base_load + random.uniform(100, 300)

    # 3. NẠP/XẢ VÀO PIN LƯU TRỮ
    net_power = generated_power - load_power
    
    # Giả sử vòng lặp chạy 10 giây/lần. Quy đổi W sang Wh và nhân tốc độ Demo
    energy_change_wh = (net_power * 10.0 / 3600.0) * DEMO_SPEED_MULTIPLIER
    current_battery_wh += energy_change_wh

    # Khóa giới hạn vật lý của cục Pin (Không thể sạc lố 100% hoặc xả quá 0%)
    if current_battery_wh > BATTERY_CAPACITY_WH:
        current_battery_wh = BATTERY_CAPACITY_WH
    elif current_battery_wh < 0:
        current_battery_wh = 0

    voltage = round(random.uniform(218.0, 222.0), 2)
    current = round(abs(net_power) / voltage, 2)
    
    return voltage, current, round(abs(net_power), 2), round(current_battery_wh, 2)

def get_power_data():
    now = datetime.now()
    real_time_hour = now.hour + (now.minute / 60.0)
    real_time_hour = 12.0 
    return calculate_energy_profile(real_time_hour)