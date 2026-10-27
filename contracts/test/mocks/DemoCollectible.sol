// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/**
 * 【仅本地测试/演示】两个**真** NFT 合约（标准 OpenZeppelin 实现，非 mock 逻辑）。
 *
 * 存在的理由：节点对 NFT 交付的核验是"按交易收据验证 from=店主 → to=买家的
 * Transfer/TransferSingle/TransferBatch 事件"（node/src/nftDelivery.js）——
 * 这条链路**无法用假数据构造**：要么有真的 NFT 合约与真的转账收据，要么这条
 * 分支永远走不到。本地演示需要店主侧的 NFT 合约，就用这两个真实现。
 *
 * 生产**不使用**本文件：真实店铺用的是店主自己的 NFT 合约（地址写在商品快照里）。
 * 刻意不加权限控制——本地演示里店主钱包直接 mint（等价于店主在自有合约上 mint）。
 */
contract DemoERC721 is ERC721 {
    uint256 public nextId = 1;

    constructor() ERC721("Demo Collectible", "DMOC") {}

    /// @notice 指定 tokenId 铸造（演示里由店主钱包调用）
    function mintTo(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    /// @notice 顺延铸造（返回新 tokenId）
    function mintNext(address to) external returns (uint256 id) {
        id = nextId++;
        _mint(to, id);
    }
}

contract DemoERC1155 is ERC1155 {
    constructor() ERC1155("https://demo.local/{id}.json") {}

    /// @notice 铸造固定份数（演示里由店主钱包调用）
    function mintTo(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}
