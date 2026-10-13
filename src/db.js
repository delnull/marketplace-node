/**
 * SQLite 数据层（Node 内置 node:sqlite，零原生依赖）。
 *
 * 表设计：
 *  - products  商品（卖家=本节点 owner 维护；kind: digital 数字 / physical 实物 / nft 链上藏品；
 *              NFT 含 nft_contract 合约地址 + nft_standard（erc721/erc1155，ERC721A 兼容 721 签名）；
 *              specs 为规格定义，**价格与库存一律在 product_skus**）
 *  - product_skus 商品规格组合（价格、库存与占位的唯一权威来源；无规格商品为单条 sku_key='' 的组合）
 *  - orders    订单（草稿/物流/链上状态回写；买家地址标识归属）
 *  - product_codes 数字商品兑换码池（导入/分配/回收由发货流程驱动）
 *  - product_nft_tokens NFT 商品交付池（tokenId 库存，发货时核验链上转账后占用）
 *  - siwe      登录 nonce（无 Redis，落 SQLite 表）
 *  - kv        键值元数据（店铺信息、扫描游标等）
 *
 * 说明：better-sqlite3 需要 node-gyp 编译，为"人人可部署"目标改用
 * Node 内置 sqlite；所有 API 均同步执行（内置驱动 API 特性）。
 * 建表策略：**全新项目、无线上数据，不做任何兼容/迁移** —— 直接建最终结构；
 * 表结构变更后删库重建即可（演示用的假店/假商品夹具不属于节点包，由本地开发脚本单独生成，
 * 店主部署时不需要它们）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

let db = null;

export function initDb(file = config.db.file) {
  if (db) return db;

  // 确保目录存在（docker 挂载 /data 时目录已存在）
  const dir = path.dirname(path.resolve(file));
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // 忙等待上限（5s）：单进程单连接下无并发写者，此设置仅为防御性——若误把同一库文件
  // 挂给第二个写进程/备份工具，SQLite 会等待而非立即 SQLITE_BUSY（数据完整性不受影响）。
  // ⚠️ 部署纪律：一库一进程（事务深度计数为进程内状态），见 OPS_RUNBOOK。
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * 建表（幂等；新项目无存量迁移：直接建最终结构，删库即可重来）
 */
function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT UNIQUE NOT NULL,            -- 对外商品标识（url 友好）
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',      -- 纯文本摘要（由 description_blocks 派生，供 SQL LIKE 搜索；无块时即店主填的原文）
      description_blocks TEXT NOT NULL DEFAULT '[]', -- 详情块 JSON：[{type:'text',text} | {type:'image',url}] —— 商品详情的权威内容，入快照
      media         TEXT NOT NULL DEFAULT '[]',      -- 主图区 JSON（**数组顺序即展示顺序**）：
                                                      --   [{type:'image',url} | {type:'video',url,poster}]，合计 ≤10 项、其中视频 ≤3
                                                      -- 图片 URL 可为 http(s) 外链或本站 /api/uploads/…；
                                                      -- 视频**只收本站上传**（外链视频会绕过"类型由字节判定"这条判据）。
                                                      -- 入快照：主图区是买家看到的商品本身，事后换图/换视频必须改哈希。
      kind          TEXT NOT NULL CHECK (kind IN ('digital','physical','nft')),
      shipping_fee_usdt_micro INTEGER NOT NULL DEFAULT 0, -- 运费（**微 USDT**，1 USDT = 1e6；**按单收取一次**；0=包邮）。仅实物商品可用，数字/NFT 恒 0；
                                                        -- 入快照：买家要能核验"锁定的运费没被事后改价"
      age_restricted INTEGER NOT NULL DEFAULT 0,       -- 未成年人禁止购买（机制：1=下单必须带买家显式确认 age_ack 才建单）；
                                                        -- 入快照：店主不能在上架后静默增删限制。
                                                        -- 注意：**具体什么商品算年龄限制商品由运营方（店主/属地）自行界定**，软件只提供机制
      nft_contract  TEXT NOT NULL DEFAULT '',          -- NFT 合约地址（kind='nft' 必填，小写）
      nft_standard  TEXT NOT NULL DEFAULT 'erc721' CHECK (nft_standard IN ('erc721','erc1155')), -- NFT 标准（交付核验按此选择事件签名；ERC721A 用 erc721）
      specs         TEXT NOT NULL DEFAULT '[]',       -- 规格定义 JSON：[{ name, options[] }]；空数组=无规格（此时 product_skus 只有一条 sku_key='' 的默认组合）
      tags          TEXT NOT NULL DEFAULT '[]',       -- 商品标签（类目）JSON 数组，元素是**展示形**（店主写入时的大小写原样，
                                                      -- 只做清洗：去控制/零宽字符、空白折叠、trim；见 src/tags.js）。
                                                      -- 空数组 = 无标签（**不是 NULL**：标签本来就是可选项，DTO 契约恒为数组）。
                                                      -- 为什么下发展示形而库里另存一份键：索引镜像 product_tags 用
                                                      -- tag_key 保证"RTX 与 rtx 是同一个标签"（唯一性），本列则保证
                                                      -- 买家看到的是店主写的那个写法（体验）。两处同批写入。
                                                      -- 为什么不入快照：标签是**检索维度**，不改变交付物/价格/限制，而快照契约是
                                                      -- node↔frontend 的跨语言键序对拍（见 routes/products.js 文件头），为一个检索
                                                      -- 字段动它就得前端同批改键位。代价（如实写）：店主可事后改标签而买家手上的
                                                      -- 快照哈希不变——这是刻意的，标签不影响"买到的是什么"。
      snapshot_hash TEXT NOT NULL,                    -- 商品快照 keccak256（前端可校验）
      auto_deliver  INTEGER NOT NULL DEFAULT -1 CHECK (auto_deliver IN (-1,0,1)), -- 数字商品自动交付：-1 跟随全局 MK_AUTO_DELIVER / 0 关 / 1 开（不入快照）
      stock_alert_at INTEGER,                         -- 低库存提醒阈值（余量 ≤ 阈值时卖家面板警示；NULL=不提醒）
      active        INTEGER NOT NULL DEFAULT 1,       -- 0=下架
      created_at    INTEGER NOT NULL,                 -- unix ms
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,                 -- 节点本地订单号（UUID）
      product_id    INTEGER,
      product_slug  TEXT NOT NULL,
      product_snapshot TEXT NOT NULL,                 -- 下单时商品字段快照 JSON
      snapshot_hash TEXT NOT NULL,
      sku_key       TEXT NOT NULL,                    -- 所选 SKU 的稳定标识（无规格商品为 ''）；占位/释放按它定位 product_skus
      sku_specs     TEXT NOT NULL DEFAULT '{}',       -- 所选规格快照 JSON（下单时冻结，防商品改规格后订单无法追溯）
      buyer         TEXT NOT NULL,                    -- 买家地址（小写）
      seller        TEXT NOT NULL,                    -- 卖家地址（= config.shop.owner）
      quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 99), -- 购买数量（≥1：金额/库存/交付均按量）
      hold_qty      INTEGER NOT NULL DEFAULT 0,       -- 应占位件数（下单时商品限量且占位成功 = quantity；不限量/未占位 = 0；随行存续供释放/恢复记账）
      released_at   INTEGER,                          -- 占位释放时刻（非空=已释放；恢复占位时清空；释放幂等标记，防重复回补）
      amount_wei    TEXT NOT NULL,                    -- 应付原生 BTY wei（字符串，防精度丢失；= 单价×数量 + 运费）
      usdt_micro       INTEGER NOT NULL,                 -- 成交时**微 USDT**（1 USDT = 1e6；= 商品金额 + 运费，即本单应付总额）
      shipping_fee_usdt_micro INTEGER NOT NULL DEFAULT 0, -- 本单实际锁定的运费（微 USDT，按单收取一次）。
                                                       -- 与 usdt_micro 的关系：usdt_micro = 商品金额 + 本列；数字/NFT 单恒 0。
                                                       -- 单列落库是为了让买家/流水/对账能看清"哪些是货款、哪些是运费"
      bty_usdt_rate TEXT NOT NULL DEFAULT '0',        -- 锁定汇率快照（记录用；标价单位已是 USDT，故只有 USDT→BTY 一条行情）
      status        TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','escrowed','shipped','confirmed','disputed','settled','refunded','expired','cancelled')),
      escrow_order_id TEXT,                           -- 链上 Escrow 订单 ID（keccak256 hex，含 UUID 唯一，一单一号）
      tracking_no   TEXT,                             -- 物流单号（physical 商品，单值）
      carrier       TEXT,                             -- **承运方名称**（physical 商品；店主在发货时填，可空）
                                                       -- 为什么单列一列：只有运单号时"拼查询链接"只能靠单号前缀猜，
                                                       -- 中通/圆通/申通/韵达这类**纯数字单号完全猜不出**（前端 utils/shipTrack
                                                       -- 的判据正是"名称优先、号段其次"）。NULL = 店主没填，**不是空串、也不是"其他"**
                                                       -- （三态纪律：没填就是没有这个事实）。归一/上限见 src/shipping.js（唯一实现）
      shipped_at    INTEGER,                          -- 发货标记时刻（任意交付形态首次落 shipped/交付行时写入；
                                                       -- 与 tracking_no/交付行共同构成「已交付事实」证据——自提/线下
                                                       -- 交付（空单号发货）也须据此判已交付，防退款/超时误回补占位）
      shipping_name    TEXT NOT NULL DEFAULT '',      -- 收货信息（选填，实物履约用；不入快照/不参与资金锁定）
      shipping_phone   TEXT NOT NULL DEFAULT '',
      shipping_address TEXT NOT NULL DEFAULT '',
      note             TEXT NOT NULL DEFAULT '',      -- 买家给卖家的订单备注（≤200 字；不入快照/不影响资金；仅当事人可见）
      age_ack       INTEGER NOT NULL DEFAULT 0,       -- 买家已确认「本商品未成年人禁止购买」（仅当商品 age_restricted=1 且下单请求显式断言时置 1）。
                                                      -- ⚠️ 客户端断言**不是**年龄证明：这里只留痕"买家点过确认"，不构成任何授权/资格核验
      invoice_needed INTEGER NOT NULL DEFAULT 0,      -- 买家要求开票（0/1）。线下开票用的记账标记，不参与资金锁定
      invoice_title TEXT NOT NULL DEFAULT '',         -- 发票抬头（**个人信息**：随 PII 擦除路径一并清空，见 piiErase.js）
      invoice_tax_no TEXT NOT NULL DEFAULT '',        -- 纳税人识别号（同上，≤40 字符）
      shipping_edit_count INTEGER NOT NULL DEFAULT 0, -- 收货信息修改次数（发货前最多改 1 次；防反复改址/骚扰）
      timeout_blocks INTEGER,
      refund_status TEXT NOT NULL DEFAULT 'none'
                    CHECK (refund_status IN ('none','requested','rejected')), -- 两级售后本地镜像（链上事件驱动）
      refund_requested_at INTEGER,                    -- 链上 RefundRequested 回写时刻
      refund_rejected_at INTEGER,                     -- 链上 RefundRejected 回写时刻
      fee_bps       INTEGER NOT NULL DEFAULT 0,       -- 订单级平台费率快照（paid/watcher/sync 从链上 getOrder 补录；收款净额口径用）
      fee_collector_at_create TEXT NOT NULL DEFAULT '', -- 链上**创建订单时**的平台费收取方快照（小写地址；零地址=创建时未配收取方⇒这单永不扣费）。
                                                       -- 权威口径：Escrow._settle 只读这个快照，全局 feeCollector() 事后可改，故不可用它替代本列。
                                                       -- 空串 = 未补录/未知（**刻意不用 '0' 默认**：那会把"不知道"说成"不扣费"）；见 src/fees.js 的 feeChargeableForOrder
      refunded_amount_wei TEXT NOT NULL DEFAULT '0',  -- 已退买家的金额（部分退款/拆分裁决）——退款与净额口径的依据（=amount 即全额退款）
      accepted_partial_refund_wei TEXT NOT NULL DEFAULT '0', -- 买家链上**已授权的部分退款额**（wei 字符串；'0' = 未授权）。
                                                       -- 对应链上 Escrow.acceptedPartialRefund(orderId)：watcher 的 PartialRefundAccepted
                                                       -- 事件回写，POST /:id/sync 读同名只读视图兜底补录（事件漏挂/漏扫时的第二入口）。
                                                       -- 为什么必须有这一列：合约 2026-09 起 approveRefund 只接受「全额」或「买家精确授权过的那个数」，
                                                       -- 卖家 UI 必须先知道"买家授权了多少"才能给出一个链上真的会接受的金额；否则店主只能拿
                                                       -- RefundAmountNotAccepted 那条晦涩的 revert 去试错（且他无从知道该填多少）
      /*
        确认收货后的**售后案件**（契约 2026-10 第二批：Escrow.openAfterSale/closeAfterSale）。

        为什么是**叠加在终局之上的第二层**，而不是又一个 orders.status：
        链上那笔托管在该单终局时就已经结清（钱判给卖家或已退买家），售后案件**不动任何托管资金**，
        补偿只能来自卖家保证金（Staking.penalize）或卖家线下转账，也因此**不阻塞卖家撤资**
        （撤资闸只看 Escrow.sellerOpenCases，售后案件不计入）。链上事实源是
        afterSaleOpenedAtBlock(orderId) —— Escrow.Order.status 全程停在 Settled。
        所以这里用独立列表达"这一个终局单上有没有在途案件"，orders.status 仍旧是 confirmed/settled/
        expired（谁把它改写成 disputed 就等于把一笔已结清的钱重新拉回在途：流水窗口、库存占位、
        发货闸、争议队列全都会跟着错）。语义与写入口的唯一实现在 src/afterSale.js。

        代价（如实写）：多一层状态就多一处必须同步的镜像——事件（watcher）、人工 /sync、
        后台对账三条路径都写这几列，判据同源（src/afterSale.js），见 docs/ARCHITECTURE.md 的事件表。
      */
      after_sale_status TEXT NOT NULL DEFAULT 'none'
                    CHECK (after_sale_status IN ('none','open','closed')), -- none=从未开案 / open=在途案件 / closed=已结案（可再开新案）
      after_sale_opened_at INTEGER,                   -- 开案时刻（事件落库时刻 unix ms；又=仲裁队列"最久等待"的起点）
      after_sale_opened_block INTEGER,                -- 开案区块（链上 afterSaleOpenedAtBlock 的镜像；重开案会覆盖）
      after_sale_closed_at INTEGER,                   -- 结案时刻（unix ms）
      after_sale_note   TEXT,                         -- 结案说明（链上 AfterSaleClosed 的用户文本，写入口截断到 500 字符；
                                                       -- 仅作 JSON 字段下发，前端必须按**纯文本**渲染——节点不做 HTML 转义）
      paid_tx_hash  TEXT,                             -- 买家托管支付交易哈希（paid 确认时写入）
      onchain_events TEXT,                            -- 链上事件史 JSON [{name,txHash,block,at}]（watcher 回写时 append）
      pii_erased_at INTEGER,                          -- **PII 擦除锚点**（2026-09 复审新增）：保留期扫描按
                                                       -- COALESCE(pii_erased_at, updated_at) 选候选与排序。
                                                       -- 为什么必须单独一列：扫描需要"擦过就不再重复入选"的锚点，
                                                       -- 而 updated_at 是**入账/争议起始时刻**的口径（流水页、GMV 窗口、
                                                       -- 趋势日桶、ledger.csv 全按它分窗）。旧实现靠刷新 updated_at 实现
                                                       -- 幂等，等于让一笔 180 天前的成交额重新落进"最近 30 天"的报表里、
                                                       -- 跨月各出现一次（见 piiErase.js 与 ARCHITECTURE §3.11）。
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      /*
        草稿 TTL 的**单调锚点**（2026-09 复审新增，见 src/monotonicClock.js）：
        created_boot = 下单那一刻的进程启动标识，created_mono = 那一刻的单调读数
        （与 Date.now() 同口径的毫秒数：进程启动时以 Date.now() 建基准，之后只加单调流逝）。
        为什么必须落库：清扫器的判据是"这单过了多久"，而 created_at 是**墙上时间**——
        宿主机时钟向前跳（NTP step / 快照恢复 / 手改时间）会让所有在途草稿瞬间"看起来早就过期"，
        于是买家正在付款的单子被取消、限量占位被提前回补 ⇒ 同一件货可以再卖一次（超卖）。
        有了这两列，**同一次运行内**创建的草稿可以用单调年龄精确判定（墙钟怎么跳都不影响）；
        created_boot 与当前进程不同的行（上一次运行留下的、或旧版本写的空值）**不再退回墙钟比较**
        （2026-10 生产化清理）：墙钟在两次运行之间同样可能跳变，按它判"过期"会误关正在付款的草稿。
        现在改用**可证明的年龄下界** = 本进程已运行的单调时长（够 TTL 才扫，不够就跳过并告警）——
        代价是同一批遗留行最多晚一个 TTL 收敛，已在清扫器文件头写明。
        （本段注释刻意不用反引号：它整块位于 db.exec 的模板字符串里，反引号会提前结束模板。）
      */
      created_boot  TEXT NOT NULL DEFAULT '',
      created_mono  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_escrow ON orders(escrow_order_id) WHERE escrow_order_id IS NOT NULL;
    -- 托管单号唯一：一单一号是 watcher 回写/对账的根基（按 escrow_order_id 定位必须唯一命中一行）。
    -- 加了唯一约束后，重复单号只可能来自代码缺陷——让它在写入时就报错，而不是让事件同时改两行。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_escrow_unique ON orders(escrow_order_id) WHERE escrow_order_id IS NOT NULL;
    -- 商品维度索引：自动交付补跑、池式商品在途需求核算、商品编辑时的在途清点都按 (product_id, status) 过滤
    CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id, status);
    -- 保留期扫描索引：候选/排序都走 COALESCE(pii_erased_at, updated_at)（见 piiErase.runPiiRetention）
    CREATE INDEX IF NOT EXISTS idx_orders_pii_anchor ON orders(pii_erased_at, updated_at);
    -- 售后案件（在途队列 + 对账复查）索引：仲裁台列表、退货单窗口、保留期保护、对账轮转都按它过滤。
    -- 部分索引（只收非 none 的行）：绝大多数订单从未开案，索引应当只为真正有案件的行付费。
    CREATE INDEX IF NOT EXISTS idx_orders_after_sale ON orders(after_sale_status, after_sale_opened_at) WHERE after_sale_status != 'none';
    -- 支付交易哈希唯一：同一笔链上支付只能确认一个订单（对应用层预检的最终兜底）。
    -- BTY EVM 交易存在 Chain33TxId/EvmTxId 双哈希（落库统一取收据/日志规范哈希），部分索引：未支付单不受约束。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_paid_tx ON orders(paid_tx_hash) WHERE paid_tx_hash IS NOT NULL AND paid_tx_hash != '';

    -- 交付物子表（v2 数量模型）：一个订单可交付多行（digital 多码 / NFT 多枚），替代单值交付列。
    -- kind='code'：兑换码/交付说明原文（池内码或卖家手填自由文本）；kind='nft'：NFT 交付凭证。
    -- NFT 支持批量：多行可共享同一 tx_hash（卖家一次转账多枚）；码对买家仅在已交付状态可见（防未付款探码）。
    CREATE TABLE IF NOT EXISTS order_delivery_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL CHECK (kind IN ('code','nft')),
      value         TEXT NOT NULL,                      -- code 原文 / NFT tokenId（十进制字符串）
      tx_hash       TEXT,                               -- NFT 转账凭证哈希（code 行为 NULL）
      created_at    INTEGER NOT NULL                    -- 交付行登记时刻（unix ms）
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_items_order ON order_delivery_items(order_id, created_at);

    -- NFT 交付凭证**全局一次性**（源码审计 2026-09 复审，P2）：同一笔链上转账（tx_hash）
    -- 里的同一个 tokenId，只能在系统里被认领**一次**。
    -- 旧实现只有"申报集合 ⊆ 收据里的转移集合"这一层核验，没有跨订单的去重记忆：
    -- 同一张收据可以给两张订单（同一买家、不同商品、各自池里都有这个 tokenId）各"交付"一次
    -- ⇒ 一枚 NFT 收两份钱。部分索引：code 行（tx_hash 为 NULL）不受约束。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_nft_tx_value
      ON order_delivery_items(tx_hash, value) WHERE tx_hash IS NOT NULL AND kind = 'nft';

    -- 售后证据（v2 两级流程 + 确认收货后的售后案件）：买家退款理由 / 卖家回复 / 仲裁阶段双方陈述 /
    -- 售后陈述（phase='after_sale'，仅在 after_sale_status='open' 期间受理），仲裁人裁决证据面
    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK (role IN ('buyer','seller')),
      phase         TEXT NOT NULL CHECK (phase IN ('refund_request','refund_reply','arbitration','after_sale')),
      content       TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_order ON dispute_evidence(order_id, created_at);

    -- 证据附件（P0-2）：挂 evidence 行；白名单 png/jpeg/webp/pdf（magic bytes 嗅探）；
    -- 单文件 ≤2MB、单条 ≤6、单订单累计 ≤20MB；磁盘名 uuid 隔离，sha256 存证
    CREATE TABLE IF NOT EXISTS evidence_files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id  INTEGER NOT NULL REFERENCES dispute_evidence(id) ON DELETE CASCADE,
      order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,               -- 原始文件名（清洗后 ≤120 字符，仅展示）
      stored_name  TEXT NOT NULL,               -- uuid.安全扩展名（磁盘文件名，与原始名隔离）
      mime         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      sha256       TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_files_ev ON evidence_files(evidence_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_files_order ON evidence_files(order_id);

    -- 管理审计（P1-④）：仅记录店主/操作员（staff）写操作与敏感导出；
    -- detail 为 JSON 变更摘要（**不含码原文/完整收货地址**）
    --
    -- 哈希链（2026-09 新增）：审计行原先可被任何拿到磁盘写权限的人静默 UPDATE/DELETE，
    -- "谁在什么时候改了店铺设置/导出了什么"因此失去证据力。现在每行带 prev_hash（上一行的
    -- entry_hash，链首为空串）与 entry_hash = sha256(规范序列化(本行))——算法、三态纪律
    -- 与"能查出什么/查不出什么"全写在 src/auditChain.js 的文件头（写入与校验共用那一份实现）。
    -- 为什么不给存量库做 ALTER：见 docs/DECISIONS.md「不留兼容垫片」——新列直接写进建表语句，
    -- 存量库按 OPS_RUNBOOK §1.2 删库重建（本仓是 greenfield，无迁移框架）。
    -- 代价（已实测，如实写在这里）：从旧备份恢复来的库若带**旧形状**的 audit_logs，这两列不存在 ⇒
    -- logAudit 的哈希落库那一步报 "no such column: entry_hash"、整行随事务回滚，调用方只看到一行
    -- console 告警（业务不受影响 = 审计静默停摆，这是"删库重建"纪律的已知代价）；
    -- check:integrity 报 "no such column: prev_hash" 并以退出码 1 失败（响亮，不假绿）。
    -- 若运维为保住历史行而手工 ADD COLUMN（DEFAULT ''），旧行两列皆空 ⇒ 校验器把它们报成
    -- unhashed（"早于哈希链、无法校验"），**绝不**报成篡改，且新链从第一条新审计行重新起头。
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      actor       TEXT NOT NULL,
      actor_role  TEXT NOT NULL CHECK (actor_role IN ('owner','operator')),
      action      TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '{}',
      ip          TEXT NOT NULL DEFAULT '',
      prev_hash   TEXT NOT NULL DEFAULT '',   -- 上一行 entry_hash（链首/未哈希历史行为空串）
      entry_hash  TEXT NOT NULL DEFAULT ''    -- sha256(prev_hash ‖ 规范序列化(本行))；空 = 未哈希（三态之一）
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at DESC);

    -- 退货单（P0-4）：已交付订单退款前的线下追回协调（纯本地数据面，链上资金流不变）。
    -- 释放语义见 stockHold.releaseRefundedEscrow：已交付单在 return.received_at 落定前不自动回补占位。
    CREATE TABLE IF NOT EXISTS order_returns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      TEXT UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','shipped','received')),
      waived        INTEGER NOT NULL DEFAULT 0,   -- 卖家放弃追索（1=未实际收到货但确认释放额度）
      address       TEXT NOT NULL DEFAULT '',     -- 退货收货地址（卖家填，买家可见）
      note          TEXT NOT NULL DEFAULT '',     -- 退货说明/规则（≤1000）
      tracking_no   TEXT,                         -- 买家回填退回物流单号（≤100）
      carrier       TEXT,                         -- 买家回填退回承运方名称（可空；NULL = 未填，口径与 orders.carrier 同源，
                                                  -- 归一在 src/shipping.js——同一条路不留半条）
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      received_at   INTEGER                       -- 卖家确认收到时刻（占位释放凭据）
    );

    -- 商品标签的**镜像行**（一行一标签）：与 products.tags 是同一份事实的两种形状——
    -- products.tags（JSON 数组，**展示形**）供 DTO 直接下发；本表供"按标签精确筛选"（键匹配 + 索引）
    -- 与"在库标签聚合"（GROUP BY 键），避免对 title/description 做全表 LIKE。两者**同批写入**
    -- （唯一写入点见 routes/products.js 的 saveTags，紧随 products 行之后）。
    --
    -- 为什么键与展示形**分两列**（而不是只存一种）：
    --   · tag_key（规范形，ASCII 折小写、去控制/零宽、空白折叠）是**身份**——"=" 匹配、唯一索引、
    --     GROUP BY 全认它，所以"大小写只差一点的两个标签"在库里**不可表达**（不会出现 RTX 与 rtx 两行）；
    --   · tag_display 是店主**写入时的原样**（只清洗、不折大小写）——对外展示用它，
    --     否则 RTX 5090 会显示成 rtx 5090（商城浏览里这是可见的体验缺陷）。
    -- 一个键下可以有多种展示形（不同商品各写各的），对外展示用哪一种由**查询期**规则决定：
    -- 出现次数最多的写法优先、并列取字典序最小者（见 routes/products.js 的 GET /api/products/tags）。
    CREATE TABLE IF NOT EXISTS product_tags (
      product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      tag_key     TEXT NOT NULL,   -- 规范形（匹配/去重/唯一/GROUP BY 只认它；唯一实现在 src/tags.js）
      tag_display TEXT NOT NULL,   -- 展示形（写入时原样，不折大小写）
      PRIMARY KEY (product_id, tag_key)
    );
    -- 按标签筛选走它（key → product_id）；聚合（GROUP BY tag_key）也能用同一索引的前缀。
    CREATE INDEX IF NOT EXISTS idx_product_tags_key ON product_tags(tag_key, product_id);

    CREATE TABLE IF NOT EXISTS product_skus (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku_key       TEXT NOT NULL,                      -- 按 specs 声明顺序用 '|' 拼接；无规格商品为 ''
      specs_json    TEXT NOT NULL,                      -- 该组合的规格值；无规格为 {}
      price_usdt_micro INTEGER NOT NULL CHECK (price_usdt_micro >= 0), -- 该组合单价（微 USDT，1 USDT = 1e6）——不同 SKU 可不同价
      capacity      INTEGER,                            -- 该组合库存（NULL=不限量）
      committed     INTEGER NOT NULL DEFAULT 0 CHECK (committed >= 0), -- 该组合已占位件数（占位/释放的权威值）
      active        INTEGER NOT NULL DEFAULT 1,         -- 0=该组合停售（不影响其它组合）
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skus_product_key ON product_skus(product_id, sku_key);
    CREATE INDEX IF NOT EXISTS idx_skus_product ON product_skus(product_id);

    CREATE TABLE IF NOT EXISTS product_codes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      code          TEXT NOT NULL,                      -- 兑换码/卡密原文（仅店主可见）
      status        TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','used')),
      order_id      TEXT,                               -- 分配到的订单（NULL=未分配）
      created_at    INTEGER NOT NULL,                   -- unix ms
      used_at       INTEGER                             -- 分配时刻（unix ms）
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_codes_product_code ON product_codes(product_id, code);
    CREATE INDEX IF NOT EXISTS idx_codes_status ON product_codes(product_id, status);

    CREATE TABLE IF NOT EXISTS product_nft_tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      token_id      TEXT NOT NULL,                      -- NFT tokenId（十进制字符串，防精度丢失）
      status        TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','used')),
      order_id      TEXT,                               -- 交付到的订单（NULL=未交付）
      created_at    INTEGER NOT NULL,                   -- 导入时刻（unix ms）
      used_at       INTEGER                             -- 交付时刻（unix ms）
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nft_tokens_product_token ON product_nft_tokens(product_id, token_id);
    CREATE INDEX IF NOT EXISTS idx_nft_tokens_status ON product_nft_tokens(product_id, status);

    CREATE TABLE IF NOT EXISTS siwe (
      address      TEXT PRIMARY KEY,                  -- 小写地址
      message      TEXT NOT NULL,
      expires_at   INTEGER NOT NULL
    );

    -- 买家评价（P0-1）：成交订单一单一评 + 店主单次回复；对外只出聚合与匿名短地址
    CREATE TABLE IF NOT EXISTS reviews (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      TEXT UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id    INTEGER NOT NULL,                 -- 冗余商品维度（商品下架/删除后评价仍可展示）
      buyer         TEXT NOT NULL,                    -- 小写地址（公开只展示短地址）
      rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      content       TEXT NOT NULL DEFAULT '',         -- ≤1000 字
      reply_content TEXT NOT NULL DEFAULT '',         -- 店主回复（单次）
      reply_at      INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, created_at DESC);

    /*
      店铺身份自主声明（shop claim）：店主用钱包**对一段规范消息签名**，把外部身份
      （domain / github / x / telegram）绑定到店铺地址上。

      为什么单独一张表而不是塞进 kv：一个店主可以同时声明多个身份（域名 + GitHub + X + Telegram），
      且每条声明都要能**单独撤销**、单独列出、单独离线核验——kv 只有"一个键一个值"，
      表达不了"多条、可撤销、每条带签名与时间"。

      code（店铺编号）解决"唯一"，不解决"哪个才是官方那家"：编号本身不带任何外部身份信息。
      本表存的是**可离线核验的声明**：第三方拿 message + signature 重算一次
      ethers.verifyMessage(message, signature)，与 address（以及 message 内的 operator 行）比对即可，
      **不需要信任节点**。节点只做存储与转发。

      ⚠️ 它证明"某个地址签过这句话"（且该地址是 message 里 code 对应店铺的 operator），
      **不证明**域名/GitHub 账号真的属于他——归属核验（DNS 记录/gist/OAuth）不在本机制内，
      故对外**不得**标成"已认证/官方"（口径写在 src/claims.js 文件头与 routes/shop.js）。

      建表策略同全库：新列/新表直接写进建表语句，存量库删库重建（本仓 greenfield，无迁移框架）。
    */
    CREATE TABLE IF NOT EXISTS shop_claims (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL CHECK (kind IN ('domain','github','x','telegram')),
      value      TEXT NOT NULL,             -- 声明值（**规范形**：归一与上限的唯一实现在 src/claims.js）
      address    TEXT NOT NULL,             -- 签名者地址（小写；= 本店 operator，见 Registry.codeOf）
      message    TEXT NOT NULL,             -- 规范消息**逐字节原样**（离线核验的唯一输入，勿再加工）
      signature  TEXT NOT NULL,             -- 65 字节 personal_sign 签名（0x hex，原样存储与下发）
      created_at INTEGER NOT NULL,          -- unix ms（重新声明/撤销后再次声明时会刷新为新的声明时刻）
      revoked_at INTEGER                    -- NULL = 有效；非空 = 已撤销（公开列表只出 NULL 的行）
    );
    -- 同 (kind, value, address) 只留一行：重复提交按**幂等**处理（不产生第二条记录，
    -- 公开列表也不会把同一个身份列两遍）。见 routes/shop.js POST /claims 的三分支。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_claims_identity ON shop_claims(kind, value, address);
    -- 公开列表只读"有效"行（revoked_at IS NULL），按 id 升序稳定输出
    CREATE INDEX IF NOT EXISTS idx_shop_claims_active ON shop_claims(revoked_at, id);

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getDb() {
  if (!db) throw new Error('db not initialized');
  return db;
}

// ── 显式事务分组（SAVEPOINT/深度计数）──
// SQLite 不支持嵌套 BEGIN；对「状态迁移 + 释放/事件史」这类多写路径做显式分组时，
// 内部函数（stockHold/autoDeliver 等）可能已在自启事务——统一用本组原语：深度 0 起
// 真事务，深度 >0 起 SAVEPOINT（可嵌套回滚不伤外层）；COMMIT/ROLLBACK 按深度逐层
// 收敛。注意：同步 SQLite + 单线程 JS，BEGIN..COMMIT 之间必须无 await（RPC/网络
// 调用一律移出事务区段），否则深度计数会被并发请求交错破坏。
let _txDepth = 0;

/** 开启一层事务（顶层 BEGIN；嵌套 SAVEPOINT） */
export function txBegin() {
  const d = getDb();
  if (_txDepth === 0) d.exec('BEGIN');
  else d.exec(`SAVEPOINT mk_sp_${_txDepth}`);
  _txDepth += 1;
}

/** 提交最内层事务（顶层 COMMIT；嵌套 RELEASE SAVEPOINT） */
export function txCommit() {
  const d = getDb();
  if (_txDepth <= 0) throw new Error('txCommit: 无活动事务（begin/commit 不配对）');
  _txDepth -= 1;
  if (_txDepth === 0) d.exec('COMMIT');
  else d.exec(`RELEASE SAVEPOINT mk_sp_${_txDepth}`);
}

/** 回滚最内层事务（顶层 ROLLBACK；嵌套 ROLLBACK TO SAVEPOINT + RELEASE，外层不受损） */
export function txRollback() {
  const d = getDb();
  if (_txDepth <= 0) throw new Error('txRollback: 无活动事务（begin/rollback 不配对）');
  _txDepth -= 1;
  if (_txDepth === 0) d.exec('ROLLBACK');
  else {
    d.exec(`ROLLBACK TO SAVEPOINT mk_sp_${_txDepth}`);
    d.exec(`RELEASE SAVEPOINT mk_sp_${_txDepth}`);
  }
}

// ── kv 便捷读写 ──
export function kvGet(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function kvSet(key, value) {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
