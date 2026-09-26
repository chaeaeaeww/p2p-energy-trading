# Quy ước làm việc nhóm

## Nhánh
- `main`: luôn chạy được demo — không push thẳng.
- Mỗi người làm trên nhánh riêng: `iot/...`, `ai/...`, `contract/...`, `dashboard/...`, `docs/...`
- Xong việc → mở Pull Request vào `main`, ít nhất 1 người review.

```bash
git checkout -b contract/energy-market
git add contracts/
git commit -m "contract: add EnergyMarket auction"
git push -u origin contract/energy-market
```

## Commit message
`<tầng>: <mô tả ngắn>` — ví dụ `iot: add MQTT simulator`, `ai: train LSTM v1`, `dashboard: connect MetaMask`.

## Quy tắc
- Chỉ sửa trong thư mục mình phụ trách; thay đổi định dạng dữ liệu phải cập nhật `docs/interfaces.md` và báo cả nhóm.
- Không commit `.env`, private key, `node_modules/`, dataset lớn (> 50 MB).
- Mỗi thư mục phải có `README.md` ghi cách cài và chạy.
