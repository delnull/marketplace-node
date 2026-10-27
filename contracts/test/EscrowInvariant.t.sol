// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NodeFixture} from "./NodeFixture.sol";
import {Escrow} from "../src/Escrow.sol";

/**
 * @notice 原生托管的最小资金守恒不变量：合约余额 == 所有仍在 Created 状态的订单金额之和。
 *
 * 这不是“把旧 invariant 抄回来”：零费模型没有平台费/抽成腿；挂账（`accruedPayouts`）
 * 仍存在，但它的产生需要收款方拒收/gas 不足，本文件随机只走 createOrder / releaseExpired
 * 两条真实入口，所以等式右边只含仍在 Created 的订单。任何“钱凭空多/少”的路径
 * （额外 receive、错误转账、释放金额算错）都会破坏等式。
 * 结算/退款/仲裁的守恒由 Protocol.t.sol 的逐路径用例覆盖；本文件负责随机组合下的资金面。
 */
contract EscrowHandler is Test {
    Escrow public immutable escrow;
    address public immutable buyer;
    address public immutable seller;

    bytes32[] private _active;
    mapping(bytes32 => uint256) public amountOf;
    uint256 private _nonce;

    constructor(Escrow escrow_, address buyer_, address seller_) {
        escrow = escrow_;
        buyer = buyer_;
        seller = seller_;
    }

    function activeLength() external view returns (uint256) {
        return _active.length;
    }

    function create(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 1 ether);
        bytes32 id = keccak256(abi.encode("invariant-order", _nonce++, amount));
        vm.prank(buyer);
        escrow.createOrder{value: amount}(id, seller, amount, 17_280);
        _active.push(id);
        amountOf[id] = amount;
    }

    function release(uint256 indexSeed) external {
        if (_active.length == 0) return;
        uint256 i = bound(indexSeed, 0, _active.length - 1);
        bytes32 id = _active[i];
        Escrow.Order memory o = escrow.getOrder(id);
        if (o.status != Escrow.OrderStatus.Created) {
            _remove(i);
            return;
        }
        vm.roll(uint256(o.createdAtBlock) + uint256(o.timeoutBlocks) + 1);
        escrow.releaseExpired(id);
        _remove(i);
    }

    function sumActive() external view returns (uint256 sum) {
        for (uint256 i = 0; i < _active.length; ++i) sum += amountOf[_active[i]];
    }

    function _remove(uint256 i) private {
        _active[i] = _active[_active.length - 1];
        _active.pop();
    }
}

contract EscrowInvariantTest is NodeFixture {
    EscrowHandler private handler;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(escrow, buyer, seller);
        targetContract(address(handler));
    }

    /// @dev 随机创建/超时释放之后，合约余额必须仍等于未释放的原生托管额。
    function invariant_nativeBalanceEqualsActiveOrders() public view {
        assertEq(address(escrow).balance, handler.sumActive(), "escrow native balance != active order sum");
    }
}
