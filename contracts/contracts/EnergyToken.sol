// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title EnergyToken (SOLAR)
 * @notice Token ERC-20 dùng để thanh toán điện P2P và thưởng cho hộ bán điện sạch.
 *  - MINTER_ROLE: admin (cấp token ban đầu cho các hộ) và EnergyMarket (mint thưởng).
 *  - MARKET_ROLE: chỉ EnergyMarket, dùng để phạt hộ bán giao thiếu điện (chuyển tiền phạt sang người mua).
 */
contract EnergyToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant MARKET_ROLE = keccak256("MARKET_ROLE");

    constructor(address admin) ERC20("Solar Energy Token", "SOLAR") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /**
     * @notice Chuyển tiền phạt từ `from` sang `to`, tối đa bằng số dư hiện có của `from`.
     * @return moved Số token thực sự đã chuyển.
     */
    function slash(address from, address to, uint256 amount) external onlyRole(MARKET_ROLE) returns (uint256 moved) {
        uint256 bal = balanceOf(from);
        moved = amount > bal ? bal : amount;
        if (moved > 0) _transfer(from, to, moved);
    }
}
