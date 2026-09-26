// ABI dạng human-readable (ethers v6). Phải khớp với contract của nhóm.
// Chi tiết ý nghĩa từng hàm / event: xem dashboard/CONTRACT_INTERFACE.md
// Nếu Bảo đổi tên hàm/tham số, chỉ cần sửa file này (hoặc thay bằng ABI JSON từ artifacts của Hardhat).

export const ENERGY_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export const ENERGY_MARKET_ABI = [
  // ----- đọc -----
  "function token() view returns (address)",
  "function currentSlot() view returns (uint256)",
  "function houseOf(address account) view returns (string)",
  "function getOrders(uint256 slot) view returns (tuple(uint256 id, address trader, bool isBid, uint256 qtyWh, uint256 pricePerWh, uint256 filledWh)[])",

  // ----- ghi (người dùng ký bằng MetaMask) -----
  "function register(string houseId)",
  "function placeAsk(uint256 slot, uint256 qtyWh, uint256 pricePerWh) returns (uint256)",
  "function placeBid(uint256 slot, uint256 qtyWh, uint256 pricePerWh) returns (uint256)",

  // ----- events (dashboard dùng để truy vết on-chain) -----
  "event HouseRegistered(address indexed account, string houseId)",
  "event MeterReported(uint256 indexed slot, address indexed account, uint256 producedWh, uint256 consumedWh)",
  "event OrderPlaced(uint256 indexed slot, uint256 indexed orderId, address indexed trader, bool isBid, uint256 qtyWh, uint256 pricePerWh)",
  "event AuctionClosed(uint256 indexed slot, uint256 clearingPricePerWh, uint256 matchedWh)",
  "event OrderMatched(uint256 indexed slot, address indexed buyer, address indexed seller, uint256 qtyWh, uint256 pricePerWh)",
  "event Settled(uint256 indexed slot, address indexed seller, address indexed buyer, uint256 deliveredWh, uint256 payment, uint256 penalty)",
  "event RewardPaid(uint256 indexed slot, address indexed account, uint256 amount)",
];
