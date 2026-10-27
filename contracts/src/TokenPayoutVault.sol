// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @notice ERC20 出金失败时的挂账与领取。
 *
 * Escrow 的 `_payoutOrCredit` 先把 token 转给本合约、再按 (token, 收款人) 记账：
 * 如果接收方是拒收 token 的合约，直接 `transfer` 会回滚；转给本合约不会，于是资金不会
 * 卡在“已 settle 但 seller/buyer 永远收不到”的状态。收款人随后自行 `claim(token)`。
 *
 * 授权边界：`credit` 只认部署时绑定的 Escrow（`setEscrow` 一次性，由 vault owner 调）；
 * 未绑定前不可记账，避免任何人凭空给某个地址记余额后把池子里的 token 领走。
 * `claim` 的 token 转账若仍然失败（黑名单、暂停），整笔回滚、余额保留，可重试。
 */
contract TokenPayoutVault is Ownable2Step, ReentrancyGuard {
    mapping(address => mapping(address => uint256)) public credits;
    /// @dev 已记入 credits 的 token 总量；余额减它就是本次真正到账的增量。
    mapping(address => uint256) public totalCredits;

    address public escrow;

    event EscrowSet(address indexed escrow);
    event Credited(address indexed token, address indexed to, uint256 amount);
    event Claimed(address indexed token, address indexed to, uint256 amount);

    error OnlyEscrow();
    error NothingToClaim();
    error TransferFailed();
    error NothingReceived();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setEscrow(address escrow_) external onlyOwner {
        if (escrow != address(0)) revert OnlyEscrow();
        if (escrow_ == address(0) || escrow_.code.length == 0) revert OnlyEscrow();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    /**
     * @notice Escrow 已把 token 转给本合约后调用。
     *
     * 不再相信 `amount`：fee-on-transfer / 通缩 token 实际到账更少，按余额增量记账，
     * 否则 claim 时会把别人的挂账一起付出，最终变成“先到先得”的池子。
     * 余额 - totalCredits 是本次及任何未记账捐赠的可用增量；只记 min(amount, free)。
     */
    function credit(address token, address to, uint256 amount) external {
        if (msg.sender != escrow) revert OnlyEscrow();
        uint256 free = IERC20(token).balanceOf(address(this)) - totalCredits[token];
        uint256 actual = amount < free ? amount : free;
        if (actual == 0) revert NothingReceived();
        totalCredits[token] += actual;
        credits[token][to] += actual;
        emit Credited(token, to, actual);
    }

    function claim(address token) external nonReentrant {
        uint256 amount = credits[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        credits[token][msg.sender] = 0;
        totalCredits[token] -= amount;
        // 非标准 ERC20 可能不返回 bool：低层调用 + 空返回视为成功。
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20.transfer.selector, msg.sender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        emit Claimed(token, msg.sender, amount);
    }
}
