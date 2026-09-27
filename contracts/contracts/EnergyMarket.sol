// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IEnergyToken is IERC20 {
    function mint(address to, uint256 amount) external;
    function slash(address from, address to, uint256 amount) external returns (uint256);
}

/**
 * @title EnergyMarket
 * @notice Chợ điện mặt trời P2P theo phiên (slot thời gian cố định).
 *
 * Vòng đời 1 slot:
 *  1. Oracle (bridge IoT/AI) gửi dự báo:      submitForecast()  -> ForecastSubmitted
 *  2. Hộ dư điện đặt lệnh bán, hộ thiếu đặt mua: placeAsk()/placeBid() -> OrderPlaced
 *     (lệnh mua khoá token vào contract - escrow)
 *  3. Đóng phiên, khớp lệnh đấu giá đôi giá đồng nhất: closeAuction() -> OrderMatched, AuctionClosed
 *  4. Oracle gửi chỉ số công tơ thực tế:       reportMeter()     -> MeterReported
 *  5. Thanh toán theo điện giao thực tế:       settle()          -> Settled, RewardPaid
 */
contract EnergyMarket is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    uint256 public constant MAX_ORDERS_PER_SLOT = 40;
    uint256 public constant MAX_SLOTS_AHEAD = 96;
    uint256 public constant BPS = 10_000;

    struct Order {
        uint256 id;
        address trader;
        bool isBid;
        uint256 qtyWh;
        uint256 pricePerWh;
        uint256 filledWh;
    }

    struct Trade {
        address buyer;
        address seller;
        uint256 qtyWh;
    }

    struct SlotInfo {
        bool closed;
        bool settled;
        uint256 clearingPricePerWh;
        uint256 matchedWh;
    }

    struct Meter {
        bool reported;
        uint256 producedWh;
        uint256 consumedWh;
    }

    struct Forecast {
        bool exists;
        uint256 genPredWh;
        uint256 loadPredWh;
    }

    IEnergyToken public immutable token;
    uint256 public immutable slotDuration;

    /// Tỷ lệ phạt (basis point) trên giá trị phần điện giao thiếu. 2000 = 20%.
    uint256 public penaltyBps;
    /// Token thưởng cho mỗi Wh điện sạch giao thành công (đơn vị nhỏ nhất của token).
    uint256 public rewardPerWh;

    uint256 public nextOrderId = 1;

    mapping(address => string) private _houseOf;
    mapping(bytes32 => address) private _accountOfHouse;

    mapping(uint256 => Order[]) private _orders;
    mapping(uint256 => Trade[]) private _trades;
    mapping(uint256 => SlotInfo) public slotInfo;
    mapping(uint256 => mapping(address => Meter)) public meterOf;
    mapping(uint256 => mapping(address => Forecast)) public forecastOf;
    /// 0 = chưa đặt, 1 = đã đặt bán, 2 = đã đặt mua (1 hộ chỉ đứng 1 phía trong 1 slot)
    mapping(uint256 => mapping(address => uint8)) public sideOf;
    mapping(uint256 => mapping(address => uint256)) public askedWh;

    event HouseRegistered(address indexed account, string houseId);
    event ForecastSubmitted(uint256 indexed slot, address indexed account, uint256 genPredWh, uint256 loadPredWh);
    event MeterReported(uint256 indexed slot, address indexed account, uint256 producedWh, uint256 consumedWh);
    event OrderPlaced(uint256 indexed slot, uint256 indexed orderId, address indexed trader, bool isBid, uint256 qtyWh, uint256 pricePerWh);
    event AuctionClosed(uint256 indexed slot, uint256 clearingPricePerWh, uint256 matchedWh);
    event OrderMatched(uint256 indexed slot, address indexed buyer, address indexed seller, uint256 qtyWh, uint256 pricePerWh);
    event Settled(uint256 indexed slot, address indexed seller, address indexed buyer, uint256 deliveredWh, uint256 payment, uint256 penalty);
    event RewardPaid(uint256 indexed slot, address indexed account, uint256 amount);
    event ParamsUpdated(uint256 penaltyBps, uint256 rewardPerWh);

    error NotRegistered();
    error AlreadyRegistered();
    error HouseIdTaken();
    error EmptyHouseId();
    error InvalidAmount();
    error SlotNotOpen(uint256 slot);
    error SlotTooFar(uint256 slot);
    error SlotFull(uint256 slot);
    error OppositeSideExists();
    error ExceedsForecast(uint256 allowedWh);
    error TooEarly();
    error AlreadyClosed();
    error NotClosed();
    error AlreadySettled();
    error AlreadyReported();
    error FutureSlot();
    error MissingMeter(address seller);

    constructor(address tokenAddress, uint256 slotDurationSec, uint256 penaltyBps_, uint256 rewardPerWh_, address oracle) {
        require(tokenAddress != address(0), "token=0");
        require(slotDurationSec >= 30, "slot too short");
        require(penaltyBps_ <= BPS, "penalty > 100%");
        token = IEnergyToken(tokenAddress);
        slotDuration = slotDurationSec;
        penaltyBps = penaltyBps_;
        rewardPerWh = rewardPerWh_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, oracle);
    }

    // =========================================================== views

    function currentSlot() public view returns (uint256) {
        return block.timestamp / slotDuration;
    }

    function slotStart(uint256 slot) external view returns (uint256) {
        return slot * slotDuration;
    }

    function houseOf(address account) external view returns (string memory) {
        return _houseOf[account];
    }

    function accountOf(string calldata houseId) external view returns (address) {
        return _accountOfHouse[keccak256(bytes(houseId))];
    }

    function getOrders(uint256 slot) external view returns (Order[] memory) {
        return _orders[slot];
    }

    function getTrades(uint256 slot) external view returns (Trade[] memory) {
        return _trades[slot];
    }

    function isRegistered(address account) public view returns (bool) {
        return bytes(_houseOf[account]).length != 0;
    }

    // =========================================================== đăng ký

    function register(string calldata houseId) external {
        _register(msg.sender, houseId);
    }

    /// Admin đăng ký hộ thay cho ví của thành viên (dùng khi seed trên Sepolia).
    function registerFor(address account, string calldata houseId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _register(account, houseId);
    }

    function _register(address account, string calldata houseId) private {
        if (bytes(houseId).length == 0) revert EmptyHouseId();
        if (isRegistered(account)) revert AlreadyRegistered();
        bytes32 key = keccak256(bytes(houseId));
        if (_accountOfHouse[key] != address(0)) revert HouseIdTaken();
        _houseOf[account] = houseId;
        _accountOfHouse[key] = account;
        emit HouseRegistered(account, houseId);
    }

    // =========================================================== oracle (IoT + AI)

    /// Kết quả dự báo AI cho 1 hộ ở 1 slot. Nếu có dự báo, lệnh bán bị giới hạn bởi sản lượng dư dự báo.
    function submitForecast(uint256 slot, address account, uint256 genPredWh, uint256 loadPredWh)
        external
        onlyRole(ORACLE_ROLE)
    {
        if (!isRegistered(account)) revert NotRegistered();
        if (slotInfo[slot].closed) revert AlreadyClosed();
        forecastOf[slot][account] = Forecast(true, genPredWh, loadPredWh);
        emit ForecastSubmitted(slot, account, genPredWh, loadPredWh);
    }

    /// Chỉ số công tơ thực tế (Wh) của 1 hộ trong 1 slot đã kết thúc. Ghi 1 lần, không sửa được.
    function reportMeter(uint256 slot, address account, uint256 producedWh, uint256 consumedWh)
        external
        onlyRole(ORACLE_ROLE)
    {
        if (!isRegistered(account)) revert NotRegistered();
        if (slot >= currentSlot()) revert FutureSlot(); // chỉ báo khi slot đã kết thúc
        Meter storage m = meterOf[slot][account];
        if (m.reported) revert AlreadyReported();
        meterOf[slot][account] = Meter(true, producedWh, consumedWh);
        emit MeterReported(slot, account, producedWh, consumedWh);
    }

    // =========================================================== đặt lệnh

    function placeAsk(uint256 slot, uint256 qtyWh, uint256 pricePerWh) external returns (uint256) {
        _checkOrder(slot, qtyWh, pricePerWh, 1);
        Forecast storage f = forecastOf[slot][msg.sender];
        if (f.exists) {
            uint256 surplus = f.genPredWh > f.loadPredWh ? f.genPredWh - f.loadPredWh : 0;
            uint256 already = askedWh[slot][msg.sender];
            if (already + qtyWh > surplus) revert ExceedsForecast(surplus > already ? surplus - already : 0);
        }
        askedWh[slot][msg.sender] += qtyWh;
        return _pushOrder(slot, false, qtyWh, pricePerWh);
    }

    /// Người mua phải approve trước: contract giữ qtyWh * pricePerWh token (escrow).
    function placeBid(uint256 slot, uint256 qtyWh, uint256 pricePerWh) external nonReentrant returns (uint256) {
        _checkOrder(slot, qtyWh, pricePerWh, 2);
        uint256 id = _pushOrder(slot, true, qtyWh, pricePerWh);
        IERC20(address(token)).safeTransferFrom(msg.sender, address(this), qtyWh * pricePerWh);
        return id;
    }

    function _checkOrder(uint256 slot, uint256 qtyWh, uint256 pricePerWh, uint8 side) private {
        if (!isRegistered(msg.sender)) revert NotRegistered();
        if (qtyWh == 0 || pricePerWh == 0) revert InvalidAmount();
        uint256 cur = currentSlot();
        if (slot < cur || slotInfo[slot].closed) revert SlotNotOpen(slot);
        if (slot > cur + MAX_SLOTS_AHEAD) revert SlotTooFar(slot);
        if (_orders[slot].length >= MAX_ORDERS_PER_SLOT) revert SlotFull(slot);
        uint8 s = sideOf[slot][msg.sender];
        if (s != 0 && s != side) revert OppositeSideExists();
        sideOf[slot][msg.sender] = side;
    }

    function _pushOrder(uint256 slot, bool isBid, uint256 qtyWh, uint256 pricePerWh) private returns (uint256 id) {
        id = nextOrderId++;
        _orders[slot].push(Order(id, msg.sender, isBid, qtyWh, pricePerWh, 0));
        emit OrderPlaced(slot, id, msg.sender, isBid, qtyWh, pricePerWh);
    }

    // =========================================================== khớp lệnh

    /**
     * Đóng phiên và khớp lệnh theo đấu giá đôi giá đồng nhất (uniform-price double auction):
     *  - Lệnh mua xếp giá giảm dần, lệnh bán xếp giá tăng dần (cùng giá: lệnh đặt trước ưu tiên).
     *  - Khớp lần lượt khi giá mua >= giá bán.
     *  - Giá clearing = trung bình giá của cặp lệnh khớp cuối cùng; mọi cặp khớp đều thanh toán theo giá này.
     * Mỗi slot nhận lệnh đến hết slot. Oracle được đóng sớm (phục vụ demo); người khác chỉ đóng được khi slot đã kết thúc.
     */
    function closeAuction(uint256 slot) external nonReentrant {
        SlotInfo storage info = slotInfo[slot];
        if (info.closed) revert AlreadyClosed();
        if (slot >= currentSlot() && !hasRole(ORACLE_ROLE, msg.sender)) revert TooEarly();
        info.closed = true;

        Order[] storage orders = _orders[slot];
        (uint256[] memory fill, uint256 matched, uint256 price) = _matchBook(slot, orders);

        info.clearingPricePerWh = price;
        info.matchedWh = matched;

        Trade[] storage trades = _trades[slot];
        for (uint256 k = 0; k < trades.length; k++) {
            emit OrderMatched(slot, trades[k].buyer, trades[k].seller, trades[k].qtyWh, price);
        }

        // Bước 2: ghi filledWh, hoàn lại phần escrow thừa của lệnh mua
        for (uint256 k = 0; k < orders.length; k++) {
            Order storage o = orders[k];
            o.filledWh = fill[k];
            if (o.isBid) {
                uint256 refund = o.qtyWh * o.pricePerWh - fill[k] * price;
                if (refund > 0) IERC20(address(token)).safeTransfer(o.trader, refund);
            }
        }
        if (matched == 0) info.settled = true; // không có gì để thanh toán

        emit AuctionClosed(slot, price, matched);
    }

    /// Bước 1: xác định khối lượng khớp cho từng lệnh, ghi các cặp khớp vào _trades[slot].
    function _matchBook(uint256 slot, Order[] storage orders)
        private
        returns (uint256[] memory fill, uint256 matched, uint256 price)
    {
        (uint256[] memory bids, uint256[] memory asks) = _sortedBook(orders);
        fill = new uint256[](orders.length);
        uint256 i;
        uint256 j;
        uint256 lastBid;
        uint256 lastAsk;
        while (i < bids.length && j < asks.length) {
            Order storage b = orders[bids[i]];
            Order storage a = orders[asks[j]];
            if (b.pricePerWh < a.pricePerWh) break;
            uint256 q = _min(b.qtyWh - fill[bids[i]], a.qtyWh - fill[asks[j]]);
            fill[bids[i]] += q;
            fill[asks[j]] += q;
            matched += q;
            lastBid = b.pricePerWh;
            lastAsk = a.pricePerWh;
            _trades[slot].push(Trade(b.trader, a.trader, q));
            if (fill[bids[i]] == b.qtyWh) i++;
            if (fill[asks[j]] == a.qtyWh) j++;
        }
        price = matched > 0 ? (lastBid + lastAsk) / 2 : 0;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _sortedBook(Order[] storage orders) private view returns (uint256[] memory bids, uint256[] memory asks) {
        uint256 nb;
        for (uint256 k = 0; k < orders.length; k++) if (orders[k].isBid) nb++;
        bids = new uint256[](nb);
        asks = new uint256[](orders.length - nb);
        uint256 x;
        uint256 y;
        for (uint256 k = 0; k < orders.length; k++) {
            if (orders[k].isBid) bids[x++] = k;
            else asks[y++] = k;
        }
        // Insertion sort (ổn định => giữ ưu tiên thời gian). Tối đa 40 lệnh/slot nên chi phí gas chấp nhận được.
        for (uint256 p = 1; p < bids.length; p++) {
            uint256 cur = bids[p];
            uint256 q = p;
            while (q > 0 && orders[bids[q - 1]].pricePerWh < orders[cur].pricePerWh) {
                bids[q] = bids[q - 1];
                q--;
            }
            bids[q] = cur;
        }
        for (uint256 p = 1; p < asks.length; p++) {
            uint256 cur = asks[p];
            uint256 q = p;
            while (q > 0 && orders[asks[q - 1]].pricePerWh > orders[cur].pricePerWh) {
                asks[q] = asks[q - 1];
                q--;
            }
            asks[q] = cur;
        }
    }

    // =========================================================== thanh toán

    /**
     * Thanh toán theo điện giao thực tế (từ công tơ):
     *  - Điện giao được của người bán = max(sản xuất - tiêu thụ, 0), phân bổ lần lượt cho các cặp khớp.
     *  - Người bán nhận delivered * giá clearing + thưởng rewardPerWh * delivered.
     *  - Phần giao thiếu: hoàn tiền cho người mua + phạt người bán penaltyBps% giá trị phần thiếu (chuyển cho người mua).
     * Ai cũng gọi được khi slot đã đóng, đã kết thúc và mọi người bán đều đã có chỉ số công tơ.
     */
    function settle(uint256 slot) external nonReentrant {
        SlotInfo storage info = slotInfo[slot];
        if (!info.closed) revert NotClosed();
        if (info.settled) revert AlreadySettled();
        if (slot >= currentSlot()) revert TooEarly();
        info.settled = true;

        Trade[] storage trades = _trades[slot];
        uint256 price = info.clearingPricePerWh;
        // danh sách người bán + phần điện còn giao được + tổng điện đã giao (bộ nhớ tạm)
        address[] memory sellers = new address[](trades.length);
        uint256[] memory remaining = new uint256[](trades.length);
        uint256[] memory deliveredBy = new uint256[](trades.length);
        uint256 ns;

        for (uint256 k = 0; k < trades.length; k++) {
            Trade storage t = trades[k];
            uint256 idx;
            (idx, ns) = _sellerIndex(slot, t.seller, sellers, remaining, ns);
            uint256 delivered = _min(t.qtyWh, remaining[idx]);
            remaining[idx] -= delivered;
            deliveredBy[idx] += delivered;
            _payTrade(slot, t, delivered, price);
        }

        for (uint256 s = 0; s < ns; s++) {
            uint256 reward = deliveredBy[s] * rewardPerWh;
            if (reward > 0) {
                token.mint(sellers[s], reward);
                emit RewardPaid(slot, sellers[s], reward);
            }
        }
    }

    function _sellerIndex(
        uint256 slot,
        address seller,
        address[] memory sellers,
        uint256[] memory remaining,
        uint256 ns
    ) private view returns (uint256 idx, uint256 newNs) {
        for (uint256 s = 0; s < ns; s++) {
            if (sellers[s] == seller) return (s, ns);
        }
        Meter storage m = meterOf[slot][seller];
        if (!m.reported) revert MissingMeter(seller);
        sellers[ns] = seller;
        remaining[ns] = m.producedWh > m.consumedWh ? m.producedWh - m.consumedWh : 0;
        return (ns, ns + 1);
    }

    function _payTrade(uint256 slot, Trade storage t, uint256 delivered, uint256 price) private {
        uint256 payment = delivered * price;
        uint256 shortValue = (t.qtyWh - delivered) * price;
        uint256 penalty;
        if (payment > 0) IERC20(address(token)).safeTransfer(t.seller, payment);
        if (shortValue > 0) {
            IERC20(address(token)).safeTransfer(t.buyer, shortValue);
            penalty = token.slash(t.seller, t.buyer, (shortValue * penaltyBps) / BPS);
        }
        emit Settled(slot, t.seller, t.buyer, delivered, payment, penalty);
    }

    // =========================================================== admin

    function setParams(uint256 penaltyBps_, uint256 rewardPerWh_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(penaltyBps_ <= BPS, "penalty > 100%");
        penaltyBps = penaltyBps_;
        rewardPerWh = rewardPerWh_;
        emit ParamsUpdated(penaltyBps_, rewardPerWh_);
    }
}
