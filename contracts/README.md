# contracts/ — Smart Contracts (Solidity + Hardhat)

**Phụ trách:** TV3

## Cấu trúc
```
contracts/
├── src/            # *.sol — EnergyToken.sol, EnergyMarket.sol
├── scripts/        # deploy.js (ghi địa chỉ + ABI vào deployments/)
├── test/           # test Hardhat (Mocha/Chai)
├── deployments/    # <network>.json + abi/ — dùng chung cho backend & dashboard
├── hardhat.config.js   # đặt paths.sources = "./src"
└── package.json
```

## Cài & chạy
```bash
cd contracts
npm install
npx hardhat compile
npx hardhat test
npx hardhat node                                        # terminal riêng
npx hardhat run scripts/deploy.js --network localhost
npx hardhat run scripts/deploy.js --network sepolia     # cần RPC_URL, PRIVATE_KEY trong ../.env
```

## Cần có
- [ ] `EnergyToken` (ERC-20, OpenZeppelin)
- [ ] `EnergyMarket`: đăng ký meter, nhận số đo từ oracle, đặt lệnh mua/bán, khớp lệnh, thanh toán
- [ ] Phân quyền (`onlyOracle`, `onlyOwner`), `ReentrancyGuard`
- [ ] Test các case chính + case lỗi
- [ ] Địa chỉ Sepolia + link Etherscan (verify)

Hàm & event phải khớp `docs/interfaces.md` mục 3.
