# ai_model/ — Dự báo sản lượng & nhu cầu điện

**Phụ trách:** TV2

## Cấu trúc
```
ai_model/
├── data/raw/         # dữ liệu gốc (chỉ commit file mẫu nhỏ: sample*.csv) + ghi nguồn dữ liệu
├── data/processed/   # dữ liệu đã làm sạch
├── notebooks/        # EDA, huấn luyện, đánh giá (.ipynb)
├── src/              # train.py, predict.py, serve.py (FastAPI /forecast)
├── weights/          # file trọng số: model.h5 / model.pkl / model.tflite
└── requirements.txt
```

## Cài & chạy
```bash
cd ai_model
python -m venv .venv && .venv\Scripts\activate    # Windows
pip install -r requirements.txt
python src/train.py
python src/serve.py                                # http://127.0.0.1:8000/forecast
```

## Cần có
- [ ] Nguồn dữ liệu (ghi rõ link) + mô tả feature
- [ ] Baseline Regression + LSTM, so sánh MAE / RMSE
- [ ] File trọng số trong `weights/`
- [ ] API `/forecast` đúng định dạng `docs/interfaces.md` mục 2
- [ ] (Tùy chọn) INT8 / TFLite cho Edge AI
