"""
Tầng AI — dịch vụ dự báo sản lượng & tiêu thụ (2 mô hình LSTM), chạy thường trực.

    cd ai_model
    python src/service_lstm.py            # MQTT + HTTP (cổng lấy từ AI_API_URL, mặc định 8000)

Dịch vụ luôn sẵn sàng cho phần cứng:
  - Khởi động trước hay sau broker đều được: tự kết nối lại khi broker tắt/bật (paho loop_start).
  - Nghe <prefix>/<houseId>/telemetry từ ESP32/simulator bất cứ lúc nào; mỗi 15 phút thực tế
    gom dữ liệu thành 1 bước lịch sử và chạy lại 2 LSTM (luồng hẹn giờ riêng, không phụ thuộc bridge).
  - Có bridge (chain/slot còn mới)  -> publish dự báo theo slot on-chain như cũ.
    Không có bridge                 -> vẫn publish dự báo định kỳ để dashboard/thiết bị đọc được.
  - Trạng thái online/offline của AI: <prefix>/ai/status (retained, có LWT).
  - HTTP: GET /health, GET /status, GET /forecast, POST /telemetry/{houseId}.
"""
import json
import os
import sys
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import joblib
import numpy as np
import paho.mqtt.client as mqtt
import requests
from dotenv import load_dotenv
from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
from tensorflow.keras.models import load_model  # noqa: E402

# Console Windows (cp1252) có thể lỗi khi in tiếng Việt lúc chuyển hướng ra file
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
WDIR = ROOT / "weights_lstm"
load_dotenv(ROOT.parent / ".env")


def log(msg):
    print(f"[ai {datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------- cấu hình model ----------------
CFG = json.loads((WDIR / "model_config.json").read_text(encoding="utf-8"))
FEATURE_COLS = CFG["feature_cols"]
WINDOW = CFG["window"]
BUCKET_SEC = CFG["slot_duration_sec"]
STEPS_PER_DAY = 24 * 3600 // BUCKET_SEC  # 96 bước 15'
HIST_LEN = WINDOW + STEPS_PER_DAY

CFG_LOAD = json.loads((WDIR / "model_config_consumption.json").read_text(encoding="utf-8"))
LOAD_FEATURE_COLS = CFG_LOAD["feature_cols"]
LOAD_WINDOW = CFG_LOAD["window"]
REF_LOAD_KW = CFG_LOAD["reference_load_kw"]
LOAD_HIST_LEN = LOAD_WINDOW + STEPS_PER_DAY


def _parse_houses(spec: str):
    """'H01:4000:1500,H02:3500:1800' (mã:công suất phát W:công suất dùng W) -> 2 dict."""
    pv, load = {}, {}
    for item in filter(None, (s.strip() for s in (spec or "").split(","))):
        parts = [p.strip() for p in item.split(":")]
        if len(parts) >= 2 and parts[1]:
            pv[parts[0]] = float(parts[1]) / 1000.0
        if len(parts) >= 3 and parts[2]:
            load[parts[0]] = float(parts[2])
    return pv, load


# Công suất từng hộ: mặc định theo file config lúc train, AI_HOUSES trong .env ghi đè/bổ sung
# (dùng khi hộ gắn phần cứng thật có tấm pin/tải nhỏ hơn nhiều so với hộ giả lập).
HOUSE_PV_KW = dict(CFG["house_pv_kw"])
HOUSE_BASE_LOAD_W = dict(CFG_LOAD["house_base_load_w"])
_ov_pv, _ov_load = _parse_houses(os.getenv("AI_HOUSES", ""))
HOUSE_PV_KW.update(_ov_pv)
HOUSE_BASE_LOAD_W.update(_ov_load)

# ---------------- cấu hình môi trường ----------------
PREFIX = os.getenv("MQTT_TOPIC_PREFIX", "p2p")
_mqtt_url = os.getenv("MQTT_URL", "")
if _mqtt_url:
    _u = urlparse(_mqtt_url)
    MQTT_HOST, MQTT_PORT, MQTT_TLS = _u.hostname or "localhost", _u.port or 1883, _u.scheme in ("mqtts", "ssl")
else:
    MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
    MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
    MQTT_TLS = False
MQTT_USERNAME = os.getenv("MQTT_USERNAME") or None
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD") or None

LAT = float(os.getenv("SITE_LAT", "10.7626"))
LON = float(os.getenv("SITE_LON", "106.6602"))
# Giờ địa phương của công trình: feature hour_sin/cos lúc train là giờ địa phương, KHÔNG phải UTC
SITE_TZ = timezone(timedelta(hours=float(os.getenv("SITE_UTC_OFFSET", "7"))))
NOCT_C = 45

DEFAULT_SLOT_SEC = int(os.getenv("SLOT_DURATION") or 120)
_api = urlparse(os.getenv("AI_API_URL", "http://127.0.0.1:8000"))
HTTP_HOST = os.getenv("AI_HTTP_HOST", "0.0.0.0")
HTTP_PORT = int(os.getenv("AI_HTTP_PORT") or _api.port or 8000)
HTTP_ENABLED = os.getenv("AI_HTTP", "true").lower() != "false"
DEVICE_STALE_SEC = int(os.getenv("AI_DEVICE_STALE_SEC", "30"))
MIN_COVERAGE = 0.2  # hộ phải có dữ liệu >= 20% thời lượng bucket mới được tính vào quan sát

STATUS_TOPIC = f"{PREFIX}/ai/status"
MODEL_TAG = "lstm-solar-v1+lstm-consumption-v1"


def local_now():
    return datetime.now(SITE_TZ).replace(tzinfo=None)


# ---------------- nạp model ----------------
log("nạp model...")
_model = load_model(WDIR / "lstm_solar_forecast.h5", compile=False)
_scaler = joblib.load(WDIR / "scaler_X.pkl")
_model_load = load_model(WDIR / "lstm_consumption_forecast.h5", compile=False)
_scaler_load_X = joblib.load(WDIR / "scaler_X_consumption.pkl")
_scaler_load_y = joblib.load(WDIR / "scaler_y_consumption.pkl")

# Một khoá chung cho mọi trạng thái: callback MQTT, luồng hẹn giờ và HTTP chạy trên các luồng khác nhau
_lock = threading.RLock()

# lịch sử site: mỗi phần tử = dict(ts, temperature, module_temp, irradiation, cf, src)
_history = deque(maxlen=HIST_LEN)
# lịch sử tiêu thụ site: mỗi phần tử = dict(ts, temperature, humidity, consumption_kw, src)
_history_load = deque(maxlen=LOAD_HIST_LEN)


# ---------------- cold-start ----------------
def _tod(ts: str) -> int:
    t = datetime.fromisoformat(ts)
    return (t.hour * 3600 + t.minute * 60) // BUCKET_SEC


def _align_to_now(points: list, n: int) -> list:
    """Xoay chuỗi mẫu (bội số của 1 ngày) để bước cuối trùng giờ hiện tại, rồi gán lại mốc thời gian
    gần đây. Nếu không, mẫu kết thúc lúc 23:45 -> dự báo đầu tiên ban ngày luôn ra 0 Wh."""
    pts = [dict(p) for p in points[-n:]]
    if not pts:
        return pts
    now = local_now()
    k_now = (now.hour * 3600 + now.minute * 60) // BUCKET_SEC
    seamless = len(pts) % STEPS_PER_DAY == 0 and (_tod(pts[0]["timestamp"]) - _tod(pts[-1]["timestamp"])) % STEPS_PER_DAY == 1
    if seamless:
        idx = [i for i, p in enumerate(pts) if _tod(p["timestamp"]) == k_now]
        if idx:
            e = idx[-1]
            pts = pts[e + 1:] + pts[: e + 1]
    end = now.replace(minute=(now.minute * 60 // BUCKET_SEC) * BUCKET_SEC // 60, second=0, microsecond=0)
    for i, p in enumerate(pts):
        p["timestamp"] = (end - timedelta(seconds=BUCKET_SEC * (len(pts) - 1 - i))).isoformat()
    return pts


def seed_from_sample():
    with _lock:
        if _history or _history_load:
            return
        sample_path = WDIR / "sample_generation_points.json"
        if not sample_path.exists():
            log(f"không có sample_generation_points.json — sẽ đợi telemetry thật để đủ {HIST_LEN} bước")
        else:
            points = _align_to_now(json.loads(sample_path.read_text(encoding="utf-8")), HIST_LEN)
            plant_peak_kw = CFG.get("plant_peak_kw")
            for p in points:
                # bản xuất mẫu có thể chỉ có power_kw (kW thô) -> tự quy về capacity_factor (0-1)
                if "capacity_factor" in p:
                    cf = p["capacity_factor"]
                elif "power_kw" in p and plant_peak_kw:
                    cf = max(0.0, min(1.0, p["power_kw"] / plant_peak_kw))
                else:
                    continue
                _history.append({
                    "ts": p["timestamp"], "temperature": p["temperature"],
                    "module_temp": p["MODULE_TEMPERATURE"], "irradiation": p["IRRADIATION"], "cf": cf, "src": "sample",
                })
            log(f"nạp {len(_history)} điểm lịch sử mẫu (gen), đã căn theo giờ hiện tại")

        # temperature (°F) và humidity (0-1) của mẫu HomeC đã đúng đơn vị lúc train -> nạp thẳng
        load_sample_path = WDIR / "sample_consumption_points.json"
        if not load_sample_path.exists():
            log(f"không có sample_consumption_points.json — sẽ đợi telemetry thật để đủ {LOAD_HIST_LEN} bước (load)")
        else:
            for p in _align_to_now(json.loads(load_sample_path.read_text(encoding="utf-8")), LOAD_HIST_LEN):
                _history_load.append({
                    "ts": p["timestamp"], "temperature": p["temperature"],
                    "humidity": p["humidity"], "consumption_kw": p["consumption_kw"], "src": "sample",
                })
            log(f"nạp {len(_history_load)} điểm lịch sử mẫu (load), đã căn theo giờ hiện tại")


# ---------------- thời tiết thật (thay cho cảm biến bức xạ/nhiệt độ tấm pin) ----------------
_weather_cache = {"ts": 0.0, "temp_c": 28.0, "ghi_kwm2": 0.0, "humidity": 0.65, "src": "none"}
WEATHER_CACHE_SEC = 600


def get_weather():
    now = time.time()
    if now - _weather_cache["ts"] < WEATHER_CACHE_SEC:
        return _weather_cache["temp_c"], _weather_cache["ghi_kwm2"], _weather_cache["humidity"]
    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": LAT, "longitude": LON,
                    "current": "temperature_2m,shortwave_radiation,relative_humidity_2m"},
            timeout=3,
        )
        cur = r.json()["current"]
        temp_c = float(cur["temperature_2m"])
        ghi_kwm2 = float(cur["shortwave_radiation"]) / 1000.0
        humidity = float(cur["relative_humidity_2m"]) / 100.0
        src = "open-meteo"
    except Exception as e:
        t = local_now()
        hour = t.hour + t.minute / 60
        log(f"không lấy được thời tiết thực ({e}), dùng ước lượng theo giờ")
        temp_c = 27 + 5 * np.sin((hour - 9) / 24 * 2 * np.pi)
        ghi_kwm2 = max(0.0, 0.9 * max(0.0, np.cos((hour - 12) / 6.5 * np.pi / 2))) if 5.5 < hour < 18.5 else 0.0
        humidity = 0.65
        src = "estimate"
    _weather_cache.update(ts=now, temp_c=temp_c, ghi_kwm2=ghi_kwm2, humidity=humidity, src=src)
    return temp_c, ghi_kwm2, humidity


def module_temp_estimate(temp_c: float, ghi_kwm2: float) -> float:
    """T_module ~ T_ambient + (NOCT-20)/0.8 * GHI(kW/m^2) — công thức NOCT chuẩn cho PV."""
    return temp_c + (NOCT_C - 20) / 0.8 * ghi_kwm2


def to_fahrenheit(temp_c: float) -> float:
    """Model load train trên dataset Mỹ (HomeC) -> nhiệt độ ở độ F, không phải độ C."""
    return temp_c * 9 / 5 + 32


def _hour_of(ts) -> float:
    t = datetime.fromisoformat(ts) if isinstance(ts, str) else datetime.fromtimestamp(ts, tz=SITE_TZ)
    return t.hour + t.minute / 60


# ---------------- build input & dự báo (sản lượng) ----------------
def build_sequence():
    """Trả về mảng (1, WINDOW, n_feat) đã scale, hoặc None nếu chưa đủ lịch sử."""
    if len(_history) < HIST_LEN:
        return None
    hist = list(_history)
    rows = []
    for i, h in enumerate(hist[-WINDOW:]):
        lag_idx = len(hist) - WINDOW + i - STEPS_PER_DAY  # cf cùng giờ hôm qua
        hour = _hour_of(h["ts"])
        row = {
            "temperature": h["temperature"], "MODULE_TEMPERATURE": h["module_temp"], "IRRADIATION": h["irradiation"],
            "hour_sin": np.sin(2 * np.pi * hour / 24), "hour_cos": np.cos(2 * np.pi * hour / 24),
            "cf_lag_24h": hist[lag_idx]["cf"] if lag_idx >= 0 else 0.0,
        }
        rows.append([row[c] for c in FEATURE_COLS])
    X = _scaler.transform(np.array(rows, dtype=float)) if not hasattr(_scaler, "feature_names_in_") else \
        _scaler.transform(_as_frame(rows, FEATURE_COLS))
    return X[np.newaxis, :, :]


def _as_frame(rows, cols):
    import pandas as pd
    return pd.DataFrame(rows, columns=cols)


def predict_capacity_factor():
    with _lock:
        X = build_sequence()
        if X is None:
            return None
        cf = float(_model.predict(X, verbose=0)[0][0])
    return max(0.0, min(1.0, cf))


def cf_to_house_forecasts(cf: float, slot_duration_sec: float) -> dict:
    hours = slot_duration_sec / 3600
    return {h: round(cf * pv_kw * 1000 * hours) for h, pv_kw in HOUSE_PV_KW.items()}


# ---------------- build input & dự báo (tiêu thụ) ----------------
def build_sequence_load():
    """Trả về mảng (1, LOAD_WINDOW, n_feat) đã scale, hoặc None nếu chưa đủ lịch sử."""
    if len(_history_load) < LOAD_HIST_LEN:
        return None
    hist = list(_history_load)
    rows = []
    for i, h in enumerate(hist[-LOAD_WINDOW:]):
        idx = len(hist) - LOAD_WINDOW + i
        lag_1 = hist[idx - 1]["consumption_kw"] if idx - 1 >= 0 else h["consumption_kw"]
        lag_24h = hist[idx - STEPS_PER_DAY]["consumption_kw"] if idx - STEPS_PER_DAY >= 0 else 0.0
        hour = _hour_of(h["ts"])
        row = {
            "temperature": h["temperature"], "humidity": h["humidity"],
            "hour_sin": np.sin(2 * np.pi * hour / 24), "hour_cos": np.cos(2 * np.pi * hour / 24),
            "consumption_kw": h["consumption_kw"], "consumption_lag_1": lag_1, "consumption_lag_24h": lag_24h,
        }
        rows.append([row[c] for c in LOAD_FEATURE_COLS])
    X = _scaler_load_X.transform(np.array(rows, dtype=float)) if not hasattr(_scaler_load_X, "feature_names_in_") else \
        _scaler_load_X.transform(_as_frame(rows, LOAD_FEATURE_COLS))
    return X[np.newaxis, :, :]


def predict_consumption_kw():
    with _lock:
        X = build_sequence_load()
        if X is None:
            return None
        y_scaled = _model_load.predict(X, verbose=0)
        kw = float(_scaler_load_y.inverse_transform(y_scaled)[0][0])
    return max(0.0, kw)


def load_kw_to_house_forecasts(ref_kw: float, slot_duration_sec: float) -> dict:
    """Quy tải tham chiếu (kW của hộ HomeC lúc train) ngược lại theo base_load_w riêng từng hộ."""
    hours = slot_duration_sec / 3600
    out = {}
    for h, base_w in HOUSE_BASE_LOAD_W.items():
        scale = (base_w / 1000.0) / REF_LOAD_KW if REF_LOAD_KW else 0.0
        out[h] = round(ref_kw * scale * 1000 * hours)
    return out


# ---------------- trạng thái thiết bị & bucket 15' ----------------
_devices = {}  # houseId -> {last_rx, gen, load, V, I, P, msgs, via}
_bucket = {}  # houseId -> {gen_wh, gen_h, load_wh, load_h}
_bucket_start = time.time()
_latest_cf = None
_latest_load_kw = None
_latest_at = 0.0
_unknown_warned = set()
_last_close_info = {}


def _num(*xs):
    for x in xs:
        if x is None or x == "":
            continue
        try:
            v = float(x)
        except (TypeError, ValueError):
            continue
        if np.isfinite(v):
            return v
    return None


def on_telemetry(house_id, payload, via="mqtt"):
    """Nhận 1 bản tin công tơ (ESP32/simulator). E_gen_Wh/E_load_Wh là bộ đếm cộng dồn."""
    gen = _num(payload.get("E_gen_Wh"), payload.get("energyGenWh"), payload.get("gen_wh"))
    load = _num(payload.get("E_load_Wh"), payload.get("energyLoadWh"), payload.get("load_wh"))
    now = time.time()
    with _lock:
        d = _devices.get(house_id)
        if d is None:
            d = _devices[house_id] = {"gen": None, "load": None, "last_rx": None, "msgs": 0, "first_rx": now}
            known = house_id in HOUSE_PV_KW or house_id in HOUSE_BASE_LOAD_W
            log(f"thiết bị mới: {house_id} ({via})" + ("" if known else
                " — CHƯA có công suất trong cấu hình, thêm vào AI_HOUSES trong .env để được dự báo"))
        prev_rx = d["last_rx"]
        dt_h = (now - prev_rx) / 3600 if prev_rx else 0.0
        # mất tín hiệu quá lâu -> chỉ lấy lại mốc, không dồn cả quãng vào bucket này
        usable = prev_rx is not None and 0 < dt_h <= 2 * BUCKET_SEC / 3600
        b = _bucket.setdefault(house_id, {"gen_wh": 0.0, "gen_h": 0.0, "load_wh": 0.0, "load_h": 0.0})
        if gen is not None:
            if usable and d["gen"] is not None:
                b["gen_wh"] += max(0.0, gen - d["gen"] if gen >= d["gen"] else gen)  # bộ đếm reset khi board khởi động lại
                b["gen_h"] += dt_h
            d["gen"] = gen
        if load is not None:
            if usable and d["load"] is not None:
                b["load_wh"] += max(0.0, load - d["load"] if load >= d["load"] else load)
                b["load_h"] += dt_h
            d["load"] = load
        d.update(last_rx=now, msgs=d["msgs"] + 1, via=via,
                 V=_num(payload.get("V"), payload.get("voltage")),
                 I=_num(payload.get("I"), payload.get("current")),
                 P=_num(payload.get("P"), payload.get("power")))


def _maybe_close_bucket(force=False):
    """Mỗi khi đủ 900s thực tế (luồng hẹn giờ gọi, không phụ thuộc slot on-chain): chốt capacity_factor
    và consumption_kw quan sát từ các thiết bị CÓ gửi dữ liệu, đẩy vào lịch sử, dự báo lại cả hai.
    Không thiết bị nào gửi dữ liệu -> dùng giá trị dự báo cho bước đó, để lịch sử không bị kéo về 0."""
    global _bucket_start, _latest_cf, _latest_load_kw, _latest_at
    now = time.time()
    if not force and now - _bucket_start < BUCKET_SEC:
        return
    temp_c, ghi, humidity = get_weather()
    min_h = MIN_COVERAGE * BUCKET_SEC / 3600
    with _lock:
        ts = local_now().isoformat()

        gen_kw = pv_kw = 0.0
        gen_houses = []
        for h, b in _bucket.items():
            if h in HOUSE_PV_KW and b["gen_h"] >= min_h:
                gen_kw += b["gen_wh"] / 1000 / b["gen_h"]
                pv_kw += HOUSE_PV_KW[h]
                gen_houses.append(h)
        if gen_houses and pv_kw > 0:
            cf_obs, gen_src = max(0.0, min(1.0, gen_kw / pv_kw)), "iot"
        else:
            lag = _history[-STEPS_PER_DAY]["cf"] if len(_history) >= STEPS_PER_DAY else 0.0
            cf_obs, gen_src = (_latest_cf if _latest_cf is not None else lag), "fill"
        _history.append({"ts": ts, "temperature": temp_c, "module_temp": module_temp_estimate(temp_c, ghi),
                         "irradiation": ghi, "cf": cf_obs, "src": gen_src})

        ref_kws, load_houses = [], []
        for h, b in _bucket.items():
            base_w = HOUSE_BASE_LOAD_W.get(h)
            if base_w and b["load_h"] >= min_h:
                ref_kws.append((b["load_wh"] / 1000 / b["load_h"]) * (REF_LOAD_KW / (base_w / 1000.0)))
                load_houses.append(h)
        if ref_kws:
            load_obs, load_src = float(np.mean(ref_kws)), "iot"
        else:
            lag = _history_load[-STEPS_PER_DAY]["consumption_kw"] if len(_history_load) >= STEPS_PER_DAY else REF_LOAD_KW
            load_obs, load_src = (_latest_load_kw if _latest_load_kw is not None else lag), "fill"
        _history_load.append({"ts": ts, "temperature": to_fahrenheit(temp_c), "humidity": humidity,
                              "consumption_kw": max(0.0, load_obs), "src": load_src})

        _bucket.clear()
        _bucket_start = now

        cf = predict_capacity_factor()
        load_kw = predict_consumption_kw()
        if cf is not None:
            _latest_cf = cf
        if load_kw is not None:
            _latest_load_kw = load_kw
        _latest_at = now
        _last_close_info.update(ts=ts, cf_obs=cf_obs, gen_src=gen_src, gen_houses=gen_houses,
                                load_obs=load_obs, load_src=load_src, load_houses=load_houses)
    log(f"bucket 15' -> cf quan sát={cf_obs:.3f} [{gen_src}{':' + ','.join(gen_houses) if gen_houses else ''}] "
        f"dự báo={cf if cf is None else round(cf, 3)} | load_ref quan sát={load_obs:.3f} kW "
        f"[{load_src}{':' + ','.join(load_houses) if load_houses else ''}] dự báo={load_kw if load_kw is None else round(load_kw, 3)}")


def ensure_forecast():
    """Có dự báo ngay từ lúc khởi động (nhờ lịch sử mẫu), không phải đợi hết bucket 15' đầu tiên."""
    global _latest_cf, _latest_load_kw, _latest_at
    with _lock:
        if _latest_cf is None:
            _latest_cf = predict_capacity_factor()
        if _latest_load_kw is None:
            _latest_load_kw = predict_consumption_kw()
        if _latest_at == 0.0 and (_latest_cf is not None or _latest_load_kw is not None):
            _latest_at = time.time()


def forecasts_for(slot_duration_sec: float):
    ensure_forecast()
    with _lock:
        cf, load_kw = _latest_cf, _latest_load_kw
    gen = cf_to_house_forecasts(cf, slot_duration_sec) if cf is not None else {}
    load = load_kw_to_house_forecasts(load_kw, slot_duration_sec) if load_kw is not None else {}
    return cf, load_kw, gen, load


# ---------------- MQTT ----------------
_client = None
_mqtt_connected = False
_chain = {"slot": None, "slotDuration": DEFAULT_SLOT_SEC, "ts": 0.0}  # slot on-chain gần nhất (từ bridge)
_published_slots = set()
_standalone_last = None


def chain_alive() -> bool:
    """Bridge còn chạy nếu bản tin chain/slot gần nhất còn mới (retained cũ của lần chạy trước không tính)."""
    return _chain["slot"] is not None and time.time() - _chain["ts"] <= 2 * _chain["slotDuration"] + 15


def publish_forecasts(target_slot: int, slot_duration: float, mode: str):
    if _client is None or not _mqtt_connected:
        return
    cf, load_kw, gen, load = forecasts_for(slot_duration)
    houses = sorted(set(gen) | set(load))
    if not houses:
        return
    ts = int(time.time())
    for h in houses:
        _client.publish(f"{PREFIX}/{h}/forecast", json.dumps({
            "houseId": h, "slot": target_slot, "genPredWh": gen.get(h, 0), "loadPredWh": load.get(h, 0),
            "model": MODEL_TAG, "mode": mode, "ts": ts,
        }), qos=1)
    cf_s = f"{cf:.3f}" if cf is not None else "n/a"
    ld_s = f"{load_kw:.3f}" if load_kw is not None else "n/a"
    log(f"[{mode}] slot #{target_slot} ({slot_duration}s): cf={cf_s} load_ref_kw={ld_s} -> "
        + ", ".join(f"{h}=gen{gen.get(h, 0)}/load{load.get(h, 0)}Wh" for h in houses))


def on_slot(payload):
    try:
        slot = int(payload["slot"])
    except (KeyError, TypeError, ValueError):
        return
    slot_duration = float(payload.get("slotDuration") or DEFAULT_SLOT_SEC)
    sent_ts = _num(payload.get("ts")) or time.time()
    _chain.update(slot=slot, slotDuration=slot_duration, ts=sent_ts)
    if not chain_alive():
        log(f"bỏ qua chain/slot #{slot} cũ (retained, bridge có thể chưa chạy) — dùng chế độ standalone")
        return
    if slot in _published_slots:
        return
    _published_slots.add(slot)
    publish_forecasts(slot + 1, slot_duration, "chain")


def _publish_status(online=True):
    if _client is None:
        return
    with _lock:
        devices = {h: round(time.time() - d["last_rx"], 1) for h, d in _devices.items() if d["last_rx"]}
    _client.publish(STATUS_TOPIC, json.dumps({
        "online": online, "model": MODEL_TAG, "ts": int(time.time()),
        "mode": "chain" if chain_alive() else "standalone",
        "http": f"http://<ip-máy-chạy-AI>:{HTTP_PORT}" if HTTP_ENABLED else None,
        "devicesLastSeenSec": devices,
    }), qos=1, retain=True)


def _on_connect(client, userdata, flags, rc):
    global _mqtt_connected
    if rc != 0:
        log(f"MQTT từ chối kết nối rc={rc}")
        return
    _mqtt_connected = True
    # subscribe lại mỗi lần (re)connect — clean session mất subscription khi broker khởi động lại
    client.subscribe([(f"{PREFIX}/chain/slot", 1), (f"{PREFIX}/+/telemetry", 0)])
    log(f"MQTT đã kết nối {MQTT_HOST}:{MQTT_PORT}, prefix '{PREFIX}'")
    _publish_status(True)


def _on_disconnect(client, userdata, rc):
    global _mqtt_connected
    _mqtt_connected = False
    if rc != 0:
        log(f"MQTT mất kết nối (rc={rc}) — tự kết nối lại...")


def _on_message(client, userdata, msg):
    parts = msg.topic.split("/")
    try:
        payload = json.loads(msg.payload.decode())
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    try:
        if len(parts) >= 3 and parts[1] == "chain" and parts[2] == "slot":
            on_slot(payload)
        elif len(parts) >= 3 and parts[2] == "telemetry" and parts[1] != "ai":
            on_telemetry(str(payload.get("houseId") or payload.get("house_id") or parts[1]), payload)
    except Exception as e:  # 1 bản tin lỗi không được làm chết luồng MQTT
        log(f"lỗi xử lý {msg.topic}: {e}")


def _make_client(cid):
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:  # paho-mqtt 2.x
            return mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id=cid)
        except AttributeError:  # paho-mqtt 1.x
            return mqtt.Client(client_id=cid)


def start_mqtt():
    global _client
    if _client is not None:
        return
    c = _make_client(f"ai_lstm_{os.getpid()}")
    if MQTT_USERNAME:
        c.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    if MQTT_TLS:
        c.tls_set()
    c.on_connect, c.on_disconnect, c.on_message = _on_connect, _on_disconnect, _on_message
    c.will_set(STATUS_TOPIC, json.dumps({"online": False, "model": MODEL_TAG}), qos=1, retain=True)
    c.reconnect_delay_set(min_delay=1, max_delay=15)
    c.connect_async(MQTT_HOST, MQTT_PORT, keepalive=30)
    c.loop_start()  # luồng nền, tự thử lại cả lần kết nối đầu tiên nếu broker chưa bật
    _client = c
    log(f"đang kết nối MQTT {MQTT_HOST}:{MQTT_PORT} (bucket model={BUCKET_SEC}s, slot mặc định={DEFAULT_SLOT_SEC}s)")


def _scheduler():
    """Luồng hẹn giờ: chốt bucket 15', publish dự báo khi không có bridge, gửi heartbeat."""
    global _standalone_last
    last_status = 0.0
    while True:
        try:
            _maybe_close_bucket()
            if _mqtt_connected and not chain_alive():
                slot_sec = DEFAULT_SLOT_SEC
                target = int(time.time() // slot_sec) + 1
                if target != _standalone_last:
                    _standalone_last = target
                    publish_forecasts(target, slot_sec, "standalone")
            if _mqtt_connected and time.time() - last_status >= 30:
                last_status = time.time()
                _publish_status(True)
        except Exception as e:
            log(f"lỗi luồng hẹn giờ: {e}")
        time.sleep(2)


_started = False


def start_workers():
    global _started
    if _started:
        return
    _started = True
    seed_from_sample()
    ensure_forecast()
    start_mqtt()
    threading.Thread(target=_scheduler, name="ai-scheduler", daemon=True).start()


# ---------------- HTTP ----------------
@asynccontextmanager
async def _lifespan(app):
    start_workers()  # chạy cả khi dùng `uvicorn src.service_lstm:app`
    yield


app = FastAPI(title="P2P Energy — AI Forecast Service (LSTM)", lifespan=_lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health():
    return {"ok": True, "mqtt": _mqtt_connected, "mode": "chain" if chain_alive() else "standalone",
            "history_gen": len(_history), "history_load": len(_history_load), "need": HIST_LEN}


@app.get("/status")
def status():
    """Dữ liệu phần cứng AI đang đọc + kết quả phân tích gần nhất."""
    now = time.time()
    with _lock:
        devices = {}
        for h, d in _devices.items():
            b = _bucket.get(h, {})
            devices[h] = {
                "online": d["last_rx"] is not None and now - d["last_rx"] <= DEVICE_STALE_SEC,
                "lastSeenSec": round(now - d["last_rx"], 1) if d["last_rx"] else None,
                "via": d.get("via"), "messages": d["msgs"],
                "V": d.get("V"), "I": d.get("I"), "P": d.get("P"),
                "E_gen_Wh": d["gen"], "E_load_Wh": d["load"],
                "bucketGenWh": round(b.get("gen_wh", 0.0), 3), "bucketLoadWh": round(b.get("load_wh", 0.0), 3),
                "configured": {"pv_kw": HOUSE_PV_KW.get(h), "base_load_w": HOUSE_BASE_LOAD_W.get(h)},
            }
        recent_src = [p.get("src") for p in list(_history)[-8:]]
        return {
            "mqtt": {"connected": _mqtt_connected, "host": MQTT_HOST, "port": MQTT_PORT, "prefix": PREFIX},
            "mode": "chain" if chain_alive() else "standalone", "chain": dict(_chain),
            "bucket": {"elapsedSec": round(now - _bucket_start), "lengthSec": BUCKET_SEC},
            "lastBucket": dict(_last_close_info), "recentHistorySources": recent_src,
            "latest": {"capacity_factor": _latest_cf, "consumption_kw_ref": _latest_load_kw,
                       "updatedSecAgo": round(now - _latest_at) if _latest_at else None},
            "devices": devices,
            "houses": {"pv_kw": HOUSE_PV_KW, "base_load_w": HOUSE_BASE_LOAD_W},
        }


@app.get("/forecast")
def forecast_api(slot_duration_sec: float = BUCKET_SEC):
    """Cho web3.py / dashboard / thiết bị gọi trực tiếp không cần MQTT."""
    cf, load_kw, gen, load = forecasts_for(slot_duration_sec)
    if cf is None and load_kw is None:
        return {"error": f"chưa đủ {HIST_LEN} bước lịch sử để dự báo"}
    return {
        "capacity_factor": cf,
        "consumption_kw_ref": load_kw,
        "slot_duration_sec": slot_duration_sec,
        "genPredWh_by_house": gen,
        "loadPredWh_by_house": load,
        "model": MODEL_TAG,
        "ts": int(time.time()),
    }


@app.post("/telemetry/{house_id}")
def telemetry_api(house_id: str, payload: dict = Body(...)):
    """Thiết bị không dùng MQTT có thể POST cùng định dạng payload như ESP32."""
    on_telemetry(house_id, payload, via="http")
    return {"ok": True}


def _block_forever():
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    start_workers()
    if HTTP_ENABLED:
        import uvicorn
        log(f"HTTP: http://{HTTP_HOST}:{HTTP_PORT}  (/health, /status, /forecast, POST /telemetry/<houseId>)")
        try:
            uvicorn.run(app, host=HTTP_HOST, port=HTTP_PORT, log_level="warning")
        except SystemExit:
            # ví dụ cổng 8000 đang bận: HTTP không lên được nhưng MQTT vẫn phải chạy tiếp
            log(f"không mở được HTTP cổng {HTTP_PORT} — tiếp tục chạy chế độ chỉ MQTT")
            _block_forever()
    else:
        _block_forever()
    if _client is not None:
        _publish_status(False)
        _client.loop_stop()
