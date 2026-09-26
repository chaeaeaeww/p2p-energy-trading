# dashboard/ — Web3 Dashboard

**Phụ trách:** An

## Cấu trúc (dự kiến React + Vite + ethers.js)
```
dashboard/
├── src/
│   ├── components/   # MeterCard, OrderBook, TradeHistory, ForecastChart
│   ├── lib/          # ethers.js: kết nối MetaMask, đọc ABI từ contracts/deployments/
│   └── App.jsx
├── package.json
└── vite.config.js
```

## Chạy
```bash
cd dashboard
npm install
npm run dev
```

## Cần có
- [ ] Kết nối MetaMask, hiển thị ví + số dư token
- [ ] Số đo realtime + biểu đồ dự báo AI
- [ ] Đặt lệnh mua/bán, order book, lịch sử khớp lệnh (từ event)
- [ ] Link tx sang Etherscan
