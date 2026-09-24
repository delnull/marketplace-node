/**
 * 【仅本地开发】本地演示数据集生成器——**只造链下内容**。
 *
 * 分工（关键，别再把订单写进来）：
 *   · 链上事实（店铺登记 / 质押 / 冻结）→ `scripts/dev/dev-chain-seed.mjs`（真签名 + 真交易）
 *   · 链下内容（本脚本）→ 店铺资料 / 商品 / SKU / 兑换码池 / NFT 交付池 / 演示图
 *   · 订单与售后 → `scripts/dev/dev-orders.mjs`（真 `Escrow.createOrder` 交易 + 真 HTTP 接口，
 *     由节点 watcher 回写状态；**绝不直接写 orders 表**——那正是"看起来像真实数据的假数据"）
 *
 * 为什么链下内容可以直接写库：商品/SKU/码池本来就只存在**店主自己节点的 SQLite** 里，
 * 没有链上依赖（链上只有"这家店登记过"这一条事实）。直接写库 = 真实形态；
 * 而订单不一样：订单的资金与状态由链上事件驱动，绕过链就是伪造。
 *
 * 用法（每个店铺一次进程；`initDb` 是模块级单例，故一库一进程）：
 *   MK_DB_FILE=<该店 db 路径> node scripts/dev/dev-seed-demo.mjs --shop a
 *
 * 环境变量：
 *   MK_DB_FILE            必需，该店 SQLite 路径（父目录会被创建）
 *   MK_SEED_NFT_ERC721    NFT 商品用的真 ERC721 地址（链上真部署，见 dev-chain.mjs）
 *   MK_SEED_NFT_ERC1155   同上（ERC1155）
 *   两者缺省时 NFT 商品的合约地址留空——**不留占位地址**：宁可让页面显示"未记录合约地址"，
 *   也不塞一个随机地址骗过页面（旧演示数据就是这么干的，交付核验永远过不去）。
 */
import { makeProductPng } from './dev-gen-images.mjs';
import { newProductSlug } from '../src/ids.js';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 店铺资料（店名/公告属**经营内容**，与链上登记无关；店主地址由节点配置注入） */
const SHOPS = {
  a: {
    label: 'A · 星河数码旗舰店',
    port: 8080,
    name: '星河数码旗舰店',
    notice:
      '主营显卡 / 主机 / 外设 / 数码配件，工作日 24 小时内发货。全场商品货款由链上托管担保，确认收货后才放款；支持 7 天无理由退货（数字商品除外）。',
    products: { physical: 42, digital: 22, nft: 8 },
  },
  b: {
    label: 'B · 云栖生活馆',
    port: 8081,
    name: '云栖生活馆',
    notice: '家居 / 服饰 / 食品精选，小批量选品。多数商品为现货，偏远地区需补运费，详情页可咨询。',
    products: { physical: 30, digital: 14, nft: 4 },
  },
  c: {
    label: 'C · 链上书屋（店主＝演示买家钱包）',
    port: 8082,
    name: '链上书屋',
    notice: '新店开张：电子书 / 在线课程 / 兑换码，支付托管确认后自动发货。所有订单支持链上存证。',
    products: { physical: 12, digital: 16, nft: 4 },
  },
  /**
   * D · **自报托管地址与链上登记不一致**的店（「合法但受限」形态）。
   * 真合约不允许零托管登记（registerNode 会 EscrowNotCanonical），所以这种形态只能由
   * "节点把自己连到了另一个托管合约"来产生——那是真实会发生的配置事故，不是假数据。
   */
  d: {
    label: 'D · 街角杂货铺（自报托管地址不一致·无法下单）',
    port: 8083,
    name: '街角杂货铺',
    notice:
      '小店刚开张，主营日用杂货。注意：本店节点当前自报的托管合约地址与链上登记不符，页面会明确拦下下单 —— 店主修正配置后自动恢复。',
    products: { physical: 8, digital: 3, nft: 1 },
  },
  /** E · 离线店：数据齐全但节点不启动（"店铺离线是常态，不是错误"） */
  e: {
    label: 'E · 山间茶舍（离线节点）',
    port: 8084,
    name: '山间茶舍',
    notice: '自家茶园直供，明前龙井 / 白毫银针 / 老白茶。节点部署在山里，偶尔会因为断电短暂离线。',
    products: { physical: 10, digital: 2, nft: 1 },
  },
};

// ════════════════════════════════════════════════════════════════════
// 确定性伪随机（同一店铺每次生成结果一致，便于复现与截图对比）
// ════════════════════════════════════════════════════════════════════
let seed = 0x2f6e2b1;
function rnd() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 100000) / 100000;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pickInt = (min, max) => min + Math.floor(rnd() * (max - min + 1));

// ════════════════════════════════════════════════════════════════════
// 商品目录
//
// 每条：[品类, [品牌/平台…], [型号/系列…], 规格定义|null, 起价(分), 最高价(分), 自动交付?]
//
// **规格必须按品类来，不能一律「颜色 × 尺寸」。** 这是演示数据最容易露馅的地方：
// 固态硬盘的规格是容量、机械键盘是轴体 × 配列、视频会员是时长、软件授权是席位 × 年限、
// 咖啡豆是烘焙度 × 重量——拿"颜色/尺寸"套所有品类，页面看着有内容，
// 但任何懂行的人一眼就知道这数据不是真的，走查时也就发现不了"规格名很长会不会撑破布局"
// 这类真问题（我们确实有一个中文长规格名的截断分支）。
//
// 少数品类**刻意不给规格**（显卡、相机机身这种按型号区分 SKU 的大件，
// 以及 NFT —— 每个 tokenId 是交付物而不是规格），用来保证「无规格商品」这条路也有样本。
// ════════════════════════════════════════════════════════════════════
const PHYSICAL_CATALOG = [
  ['显卡', ['ASUS TUF', 'MSI 魔龙', '七彩虹 iGame', '影驰 星曜', '蓝宝石 超白金'], ['RTX 5080 16G', 'RTX 5090 24G', 'RX 9070 XT 16G', 'RTX 5070 Ti 12G'], null, 329900, 1599900],
  ['显示器', ['AOC 宙斯盾', '戴尔 UltraSharp', 'HKC 猎鹰', 'KTC 战神'], ['27 寸 2K 180Hz', '32 寸 4K 144Hz', '34 寸带鱼屏 165Hz'], [{ name: '版本', options: ['标准版', '升降旋转支架版'] }], 89900, 459900],
  ['机械键盘', ['渴创 Keychron', 'IQUNIX', '黑爵', '杜伽'], ['87 键 Gasket 套件', '75 键三模热插拔', '68 键铝坨坨'], [{ name: '轴体', options: ['红轴', '茶轴', '青轴', '静音红轴'] }, { name: '配列', options: ['68 键', '75 键', '87 键'] }], 19900, 129900],
  ['固态硬盘', ['三星 990', '致态 TiPlus', '铠侠 EXCERIA', '英睿达 P3'], ['NVMe PCIe4.0', 'NVMe PCIe5.0', '移动固态'], [{ name: '容量', options: ['1TB', '2TB', '4TB'] }], 29900, 269900],
  ['路由器', ['华硕 ROG', '小米 AX', 'TP-LINK 飞流', '网件 Nighthawk'], ['WiFi7 双频 6500M', '三频 Mesh', '电竞 6000M'], [{ name: '版本', options: ['标准版', 'Pro 增强版'] }, { name: '套装', options: ['单只', '两只装'] }], 19900, 189900],
  ['人体工学椅', ['西昊', '永艺 撑腰椅', '保友 金豪'], ['网布透气款', '护腰旗舰款'], [{ name: '颜色', options: ['曜石黑', '云雾灰', '奶白'] }, { name: '配置', options: ['标准款', '带脚踏午休款'] }], 49900, 219900],
  ['降噪耳机', ['索尼 WH', 'Bose QC', '声阔 Space'], ['头戴式主动降噪', '入耳式降噪 3.0'], [{ name: '颜色', options: ['曜石黑', '铂金银', '午夜蓝'] }], 39900, 259900],
  ['保温杯', ['膳魔师', '虎牌', '象印'], ['316 不锈钢', '轻量款'], [{ name: '容量', options: ['350ml', '500ml', '750ml'] }, { name: '颜色', options: ['哑光黑', '云杉绿', '米白'] }], 9900, 36900],
  ['香薰蜡烛', ['观夏', '野兽派', 'diptyque 风'], ['大豆蜡手工浇注'], [{ name: '香型', options: ['雪松与琥珀', '白茶与鼠尾草', '无花果'] }, { name: '规格', options: ['100g', '200g'] }], 7900, 49900],
  ['卫衣', ['Champion 风', '国潮印花', '重磅纯棉'], ['连帽加绒 400g', '圆领落肩宽松'], [{ name: '颜色', options: ['黑', '燕麦', '雾霾蓝'] }, { name: '尺码', options: ['S', 'M', 'L', 'XL', 'XXL'] }], 8900, 39900],
  ['双肩背包', ['小米 极简', 'Osprey 日光', 'Herschel 风'], ['通勤防泼水', '户外背负系统'], [{ name: '容量', options: ['20L', '30L'] }, { name: '颜色', options: ['黑', '军绿'] }], 12900, 79900],
  ['单反相机', ['佳能 EOS', '尼康 Z', '索尼 Alpha'], ['全画幅微单'], null, 699900, 1899900],
  ['咖啡豆', ['明谦', '三顿半', 'Manner 风'], ['耶加雪菲 水洗', '意式拼配'], [{ name: '烘焙度', options: ['浅烘', '中烘', '深烘'] }, { name: '规格', options: ['250g', '500g', '1kg'] }], 5800, 16800],
  ['收纳箱', ['爱丽思', '天马', '宜家风'], ['可折叠', '透明抽屉式'], [{ name: '规格', options: ['单只', '三只装'] }], 4900, 19900],
  ['台灯', ['小米 米家', '明基 护眼', '松下'], ['国AA 护眼无频闪', '屏幕挂灯 Pro'], [{ name: '颜色', options: ['月光白', '深空黑'] }], 9900, 89900],
];

const DIGITAL_CATALOG = [
  ['Steam 充值卡', ['国区', '全球区'], ['官方直充'], [{ name: '面额', options: ['100 元', '200 元', '500 元'] }], 9500, 48000, true],
  ['视频会员', ['腾讯视频', '爱奇艺', '优酷', 'B 站大会员'], ['官方兑换码'], [{ name: '时长', options: ['月卡', '季卡', '年卡'] }], 5800, 25800, true],
  ['在线课程', ['Solidity 智能合约实战', 'Rust 系统编程入门', '大模型应用开发', 'Figma 高阶 UI'], ['正版授权'], [{ name: '版本', options: ['标准版', '训练营版（含作业批改）'] }], 19900, 89900, true],
  ['设计素材包', ['2026 年度合集', '电商主图模板', '中文字体商用'], ['永久可用'], [{ name: '授权', options: ['个人授权', '企业授权'] }], 3900, 39900, true],
  ['软件授权', ['JetBrains 全家桶', 'Affinity 三件套', 'Sketch 授权'], ['官方序列号'], [{ name: '席位', options: ['1 席', '5 席', '20 席'] }, { name: '时长', options: ['1 年', '3 年'] }], 29900, 199900, true],
  ['电子书', ['《链上经济学》', '《分布式系统实践》', '《一人公司》'], ['作者签名版'], [{ name: '格式', options: ['电子版 PDF+EPUB', '纸质 + 电子套装'] }], 2900, 12900, false],
  ['云服务器代金券', ['通用型', '计算型'], ['新用户专享'], [{ name: '面额', options: ['100 元', '500 元', '2000 元'] }], 9000, 45000, true],
];

/** NFT：每个 tokenId 是**交付物**而不是规格，所以一律无规格（限量由库存表达） */
const NFT_CATALOG = [
  ['BitYuan 创世纪念', ['#0001', '#0007', '#0128'], '链上唯一编号，交付后在钱包内可直接查看，含创世区块时间戳元数据。'],
  ['城市夜景系列', ['上海', '东京', '冰岛'], '摄影作品上链，每枚含原始拍摄参数与版权声明。'],
  ['生成艺术', ['Flow Field', 'Recursive Grid', 'Ink Wash'], '算法生成，链上存证种子与渲染脚本哈希。'],
  ['会员通行证', ['银卡', '金卡'], '持证可在本店数字商品永久 9 折，权益随NFT转移。'],
];

// ════════════════════════════════════════════════════════════════════
// 生成商品
// ════════════════════════════════════════════════════════════════════
const now = Date.now();
const DAY = 86400_000;

function makeProducts(spec, shopKey) {
  const out = [];
  // ── 演示图：生成到本节点上传目录，走真实的 /api/uploads/ 链路 ──
  // 不用外链：联邦制商城演示应当验证「店主上传到自己的节点」这条路，
  // 而且断网时外链就是一片裂图，走查没法做。
  const IMG_POOL = makeLocalImages(18, 6, shopKey); // 18 张 × 每个商品 1~3 张
  const img = (slug) => {
    const h = [...slug].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const n = 1 + (h % 3); // 1~3 张
    return Array.from({ length: n }, (_, i) => IMG_POOL[(h + i * 5) % IMG_POOL.length]);
  };
  /**
   * 详情块：一段文字 + 图 + 一段文字（演示富说明）。
   * **每第 7 个商品**给一组「连续多图」（3 张挨着）：详情长图是真实经营的常态，
   * 而"连续图片之间必须无缝"这条排版纪律只有在这种商品上才走得到——
   * 否则永远看不到 `.blocks__img + .blocks__img` 那一段样式。
   */
  const blocks = (slug, title, kindLabel) => {
    const h = [...slug].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const head = { type: 'text', text: `${title}（${kindLabel}）。正品行货，支持七天无理由退换。` };
    const tail = {
      type: 'text',
      text: '下单后货款由链上托管合约锁定，卖家发货、买家确认收货后才释放给店主；\n如遇问题可在订单内申请退款，卖家不处理时可发起链上争议并由仲裁裁决。',
    };
    const idx = Number(/(\d+)$/.exec(slug)?.[1] ?? 0);
    if (idx % 7 === 0) {
      return [
        head,
        { type: 'image', url: IMG_POOL[(h + 1) % IMG_POOL.length] },
        { type: 'image', url: IMG_POOL[(h + 4) % IMG_POOL.length] },
        { type: 'image', url: IMG_POOL[(h + 9) % IMG_POOL.length] },
        tail,
      ];
    }
    return [head, { type: 'image', url: IMG_POOL[(h + 3) % IMG_POOL.length] }, tail];
  };

  const build = (kind, count, catalog, make) => {
    for (let i = 0; i < count; i += 1) {
      const c = catalog[i % catalog.length];
      /*
        商品标识用**与线上同一套生成器**（`P` + 10 位无连字符 base32）：
        演示数据必须和真实上架的商品长得一样，否则走查时"标识栏"看起来跟线上不是一回事。
      */
      const slug = newProductSlug();
      out.push(make(c, i, slug, kind));
    }
  };

  /**
   * 规格矩阵：把 [{name, options[]}] 展开成全部组合（笛卡尔积），顺序稳定。
   * 无规格 → 返回唯一一条 { key: '', specs: {} }（与多规格走同一条代码路径，
   * 后端也是这么设计的：无规格商品 = 只有一个 sku_key='' 的组合）。
   */
  const matrixOf = (specs) => {
    if (!specs || specs.length === 0) return [{ key: '', specs: {} }];
    let acc = [{ key: '', specs: {} }];
    for (const dim of specs) {
      const next = [];
      for (const item of acc) {
        for (const opt of dim.options) {
          next.push({
            key: item.key ? `${item.key}|${opt}` : opt,
            specs: { ...item.specs, [dim.name]: opt },
          });
        }
      }
      acc = next;
    }
    return acc;
  };

  /**
   * 生成商品的 SKU：逐组合独立定价与库存。
   *
   * 差价按**选项在维度里的位置**给（后一个选项更贵），再叠一点抖动：
   * 这样「大容量/高配/长时长更贵」这层常识在演示数据里成立——
   * 纯随机差价会造出「4TB 比 1TB 便宜」这种一眼假的数据。
   *
   * 库存三态必须各有样本，但**不能每格都摇一次骰子**：
   * 早先每个组合独立 14% 概率售罄，12 个组合的键盘于是常常出现"整行三个选项里两个无货"，
   * 页面上看就是"这商品根本买不了"，而规格联动的走查也会随机点到禁用项上。
   * 现在改成**每个商品最多一个售罄组合**（且永远不是第一个——第一个是各维度的默认选项，
   * 它没货会让"未选规格 → 选齐规格"这条主线直接走不通），停售组合同理。
   */
  const buildSkus = (specs, basePrice, { digital = false } = {}) => {
    const combos = matrixOf(specs);
    const n = combos.length;
    // 只在多组合商品上造「售罄 / 停售」，且都避开第 0 个
    const soldOutIdx = specs && n > 1 && rnd() < 0.3 ? pickInt(1, n - 1) : -1;
    const stopIdx = specs && n > 2 && rnd() < 0.22 ? pickInt(1, n - 1) : -1;
    return combos.map((c, idx) => {
      let mult = 1;
      for (const dim of specs || []) {
        const pos = dim.options.indexOf(c.specs[dim.name]);
        // 第一个选项为基准价，之后每个选项 +18%（四舍五入到元）
        mult *= 1 + 0.18 * pos;
      }
      const jitter = pickInt(-5, 6) / 100;
      const priceCnyFen = Math.max(100, Math.round((basePrice * mult * (1 + jitter)) / 100) * 100);
      // 常规库存充足；少量组合给低余量（触发「仅剩 N 件」），极少数售罄
      const cap =
        idx === soldOutIdx ? 0 : rnd() < 0.16 ? pickInt(1, 3) : digital ? pickInt(50, 900) : pickInt(8, 80);
      return {
        key: c.key,
        specs: c.specs,
        priceCnyFen,
        capacity: cap,
        // 停售的组合给足库存，好让「有货但不可买」这个状态在页面上看得出来
        ...(idx === stopIdx ? { capacity: pickInt(5, 20), active: false } : {}),
      };
    });
  };

  /** 规格摘要，写进商品描述（描述里不该出现"颜色与尺寸"这种通用词） */
  const specLine = (specs) =>
    specs && specs.length
      ? `可选 ${specs.map((d) => `${d.name}（${d.options.join(' / ')}）`).join('、')}，不同规格的价格与库存各不相同。`
      : '';

  build('physical', spec.physical, PHYSICAL_CATALOG, ([cat, brands, models, specs, lo, hi], i, slug, kind) => {
    const brand = brands[i % brands.length];
    const model = models[Math.floor(i / brands.length) % models.length];
    const price = pickInt(lo, hi);
    if (specs) {
      const skus = buildSkus(specs, price);
      return {
        slug,
        title: `${brand} ${cat} ${model}`,
        description: `${brand} ${model}，正品行货，七天无理由退换。\n${specLine(specs)}\n下单后由链上托管锁定货款，确认收货后释放给店主；如有问题可在订单内申请退款或发起争议。`,
        images: img(slug),
        descriptionBlocks: blocks(slug, `${brand} ${model}`, '实物商品'),
        kind,
        specs,
        skus,
        // 商品级起价 = 各组合最低价（与后端口径一致）
        price: Math.min(...skus.map((s) => s.priceCnyFen)),
        capacity: null, // 有 SKU 时商品级容量无意义（权威值逐组合）
        autoDeliver: -1,
        stockAlertAt: pickInt(3, 8),
        createdAt: now - pickInt(30, 320) * DAY,
      };
    }
    // 无规格品类（显卡 / 相机机身这类按型号区分 SKU 的大件）
    const r = rnd();
    const capacity = r < 0.25 ? null : r < 0.42 ? pickInt(2, 6) : pickInt(20, 400);
    return {
      slug,
      title: `${brand} ${cat} ${model}`,
      description: `${brand} ${model}，正品行货，七天无理由退换。\n下单后由链上托管锁定货款，确认收货后释放给店主；如有问题可在订单内申请退款或发起争议。`,
      images: img(slug),
      descriptionBlocks: blocks(slug, `${brand} ${model}`, '实物商品'),
      kind,
      specs: [],
      skus: [{ key: '', specs: {}, priceCnyFen: price, capacity }],
      price,
      capacity,
      autoDeliver: -1,
      stockAlertAt: capacity === null ? null : pickInt(3, 8),
      createdAt: now - pickInt(30, 320) * DAY,
    };
  });

  build('digital', spec.digital, DIGITAL_CATALOG, ([cat, variants, models, specs, lo, hi, auto], i, slug, kind) => {
    const variant = variants[i % variants.length];
    const model = models[Math.floor(i / variants.length) % models.length];
    const price = pickInt(lo, hi);
    const title = `${cat} ${variant} ${model}`;
    const skus = buildSkus(specs, price, { digital: true });
    return {
      slug,
      title,
      description: `${auto ? '自动发货：托管支付确认后系统立即发放，无需等待店主手动处理。\n' : '店主确认后发放兑换码。\n'}${title}，一经发出不支持退换，请确认商品说明后再下单。\n${specLine(specs)}`,
      images: img(slug),
      descriptionBlocks: blocks(slug, title, '数字商品'),
      kind,
      specs,
      skus,
      price: Math.min(...skus.map((s) => s.priceCnyFen)),
      capacity: null,
      autoDeliver: auto ? 1 : 0,
      stockAlertAt: pickInt(5, 20),
      createdAt: now - pickInt(20, 260) * DAY,
    };
  });

  build('nft', spec.nft, NFT_CATALOG, ([cat, variants, desc], i, slug, kind) => {
    const variant = variants[i % variants.length];
    const price = pickInt(9900, 88800);
    const capacity = pickInt(1, 20);
    /*
      NFT 合约地址必须是**真部署的合约**：节点交付时会按交易收据核验
      「from=店主 → to=买家的 Transfer 事件」，随机地址永远核验不过去（旧演示数据的坑）。
      没有配置真合约时留空，宁可让页面显示"快照未记录合约地址"。
      标准与地址成对出现：ERC721 与 ERC1155 各占一部分（两条核验分支都要有样本）。
    */
    const useErc1155 = i % 4 === 3 && NFT_ERC1155;
    const contract = useErc1155 ? NFT_ERC1155 : NFT_ERC721;
    return {
      slug,
      title: `${cat} ${variant}`,
      description: `${desc}\n本商品为链上 NFT，交付时由店主转入你的钱包地址；托管金额在确认收货后释放。`,
      images: img(slug),
      descriptionBlocks: blocks(slug, `${cat} ${variant}`, '链上藏品'),
      kind,
      // NFT 无规格：每个 tokenId 是**交付物**而不是可选的规格维度
      specs: [],
      skus: [{ key: '', specs: {}, priceCnyFen: price, capacity }],
      price,
      capacity,
      nftContract: contract || '',
      nftStandard: useErc1155 ? 'erc1155' : 'erc721',
      autoDeliver: 0,
      stockAlertAt: 2,
      createdAt: now - pickInt(10, 150) * DAY,
    };
  });

  // ── 边界样本：下架商品 · 无图商品 ────────────────────────────────
  // 这两种形态前端各有分支（卖家面板「已下架」分组 / 商品卡占位图 / 详情页无图集），
  // 演示数据里没有就永远走不到：
  //   · 下架：店主不再出售但历史订单仍引用它 —— 必须存在，否则「下架不影响老订单」无从验证。
  //   · 无图：`images: []` 时列表与详情都要落到占位图分支，而不是渲染成裂图。
  // 取尾部若干条，避免打乱前面「热销子集」的确定性分布。
  const markInactive = Math.max(2, Math.round(out.length * 0.06));
  for (let i = out.length - markInactive; i < out.length; i += 1) {
    if (i >= 0) out[i].active = false;
  }
  const markNoImage = Math.max(1, Math.round(out.length * 0.03));
  for (let i = 0; i < markNoImage && i < out.length; i += 1) {
    out[i].images = [];
    out[i].descriptionBlocks = (out[i].descriptionBlocks || []).filter((b) => b.type !== 'image');
  }

  return out;
}

/**
 * 把 count 张演示图写进本节点的上传目录，返回可直接写进商品的 URL 列表。
 * 目录与 uploads 路由的 uploadsDir() 同口径（库文件所在目录下的 uploads/），
 * 这样演示图与店主真上传的图共用同一套静态服务，走查到的就是真实链路。
 */
function makeLocalImages(count, size, shopKey) {
  const dbFile = process.env.MK_DB_FILE;
  const dir = path.join(path.dirname(path.resolve(dbFile)), 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const urls = [];
  for (let i = 0; i < count; i += 1) {
    // 文件名也用 uuid 形状：与真实上传产出的 URL 完全一致（含路由的命名白名单校验）
    const name = `${randomUUID()}.png`;
    fs.writeFileSync(path.join(dir, name), makeProductPng(1000 + i * 37 + shopKey.charCodeAt(0), size * 100));
    urls.push(`/api/uploads/${name}`);
  }
  return urls;
}

// ════════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════════
const shopArgIdx = process.argv.indexOf('--shop');
const shopKey = shopArgIdx >= 0 ? process.argv[shopArgIdx + 1] : null;
const shop = SHOPS[shopKey];
if (!shop) {
  console.error(`用法：node scripts/dev-seed-demo.mjs --shop <${Object.keys(SHOPS).join('|')}>`);
  console.error('需要环境变量：MK_DB_FILE（该店 db 路径）');
  process.exit(1);
}

const dbFile = process.env.MK_DB_FILE;
if (!dbFile) {
  console.error('缺少 MK_DB_FILE（该店铺的 SQLite 路径）');
  process.exit(1);
}
/** 链上真部署的 NFT 合约（由 dev-demo.mjs 从 .demo/chain.json 注入；缺省则 NFT 商品无合约地址） */
const NFT_ERC721 = (process.env.MK_SEED_NFT_ERC721 || '').toLowerCase();
const NFT_ERC1155 = (process.env.MK_SEED_NFT_ERC1155 || '').toLowerCase();

// 删库重建（演示内容，幂等重跑）
for (const suffix of ['', '-wal', '-shm']) {
  const f = path.resolve(dbFile) + suffix;
  if (fs.existsSync(f)) fs.rmSync(f);
}
fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });

// 建表直接复用节点自身的迁移（保证与应用口径一致，不手抄 schema）。
// 注意 initDb 是模块级单例，故本脚本一次进程只负责一个店铺。
const { initDb } = await import('../src/db.js');
const appDb = initDb(dbFile);

// ── 店铺资料（kv）──
// 店名/公告是**经营内容**（店主在卖家面板里填的东西），因此直写 kv 就是它的真实形态。
// 店员白名单不在这里写：那是店主的权限动作，由 dev-orders.mjs 走真实接口
// PUT /api/shop/staff 添加（顺带留下真实审计日志 staff.add）。
for (const [k, v] of [
  ['mk:shop_name', shop.name],
  ['mk:shop_notice', shop.notice],
]) {
  appDb
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(k, v);
}

// ── 商品 ──
const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
const products = makeProducts(shop.products, shopKey);

const insProduct = appDb.prepare(`
  INSERT INTO products (slug, title, description, description_blocks, images, kind, nft_contract, nft_standard,
                        specs, snapshot_hash, auto_deliver,
                        stock_alert_at, active, created_at, updated_at)
  VALUES (@slug, @title, @description, @description_blocks, @images, @kind, @nft_contract, @nft_standard,
          @specs, @snapshot_hash, @auto_deliver,
          @stock_alert_at, @active, @created_at, @updated_at)
`);
const insSku = appDb.prepare(`
  INSERT INTO product_skus (product_id, sku_key, specs_json, price_cny_fen, capacity, committed,
                            active, created_at, updated_at)
  VALUES (@product_id, @sku_key, @specs_json, @price_cny_fen, @capacity, 0, @active, @now, @now)
`);

const productRows = [];
/** product_id → 该商品的规格组合（dev-orders.mjs 会读它下单；这里只做完整性输出） */
const skusByProduct = new Map();
let skuTotal = 0;
for (const p of products) {
  // 快照与 DB 行同形：价格与库存只在 skus 上（见 products.js snapshotObject）
  const skuRows = (p.skus || []).map((s) => ({ sku_key: s.key, price_cny_fen: s.priceCnyFen }));
  const row = {
    slug: p.slug,
    title: p.title,
    description: p.description,
    images: JSON.stringify(p.images),
    kind: p.kind,
    nft_contract: p.kind === 'nft' ? p.nftContract || '' : '',
    // 列上的 CHECK 只允许 'erc721'/'erc1155'（默认 'erc721'）：非 NFT 商品没有"标准"可言，
    // 但这个列 NOT NULL 且有约束，所以沿用默认值，不要塞空串
    nft_standard: p.kind === 'nft' ? p.nftStandard : 'erc721',
    specs: JSON.stringify(p.specs || []),
    description_blocks: JSON.stringify(p.descriptionBlocks || []),
    auto_deliver: p.autoDeliver,
    stock_alert_at: p.stockAlertAt,
    active: p.active === false ? 0 : 1,
    created_at: p.createdAt,
    updated_at: p.createdAt,
  };
  row.snapshot_hash = computeSnapshotHash(
    snapshotObject({ ...row, images: row.images, skus: skuRows, description_blocks: row.description_blocks })
  );
  insProduct.run(row);
  const saved = appDb.prepare('SELECT * FROM products WHERE slug = ?').get(p.slug);
  const list = [];
  for (const s of p.skus || []) {
    insSku.run({
      product_id: saved.id,
      sku_key: s.key,
      specs_json: JSON.stringify(s.specs || {}),
      price_cny_fen: s.priceCnyFen,
      capacity: s.capacity,
      active: s.active === false ? 0 : 1,
      now: p.createdAt,
    });
    skuTotal += 1;
    list.push({
      sku_key: s.key,
      specs_json: JSON.stringify(s.specs || {}),
      price_cny_fen: s.priceCnyFen,
      capacity: s.capacity,
      active: s.active !== false,
    });
  }
  skusByProduct.set(saved.id, list);
  productRows.push(saved);
}
console.log(`[${shopKey}] 商品 ${productRows.length} 件（规格组合 ${skuTotal} 个）`);

// ── 码池 / NFT 交付池 ──
// 交付池是**店主自己的库存账**（链上没有码），直写库就是它的真实形态；
// 真正"交付"还是得由卖家接口从池里分配并写交付行。
const insCode = appDb.prepare(
  'INSERT INTO product_codes (product_id, code, status, created_at) VALUES (?, ?, ?, ?)'
);
const insToken = appDb.prepare(
  'INSERT INTO product_nft_tokens (product_id, token_id, status, created_at) VALUES (?, ?, ?, ?)'
);
let codeCount = 0;
let tokenCount = 0;
for (const p of productRows) {
  if (p.kind === 'digital' && p.auto_deliver === 1) {
    const n = pickInt(12, 40);
    for (let i = 0; i < n; i += 1) {
      insCode.run(p.id, `${p.slug.toUpperCase()}-${randomBytes(6).toString('hex').toUpperCase()}`, 'unused', p.created_at);
      codeCount += 1;
    }
  }
  if (p.kind === 'nft') {
    // 建池规模看「可售总量」：现在总量在各组合上，取其和（不限量组合按 4 计）
    const total = (skusByProduct.get(p.id) || []).reduce((n, s) => n + (s.capacity ?? 4), 0);
    const n = Math.max(2, total || 4);
    // tokenId 基数在每个商品内固定一次、随后按 i 递增——逐次随机取值会撞唯一索引
    const base = pickInt(1, 9000) * 10;
    for (let i = 0; i < n; i += 1) {
      insToken.run(p.id, String(base + i), 'unused', p.created_at);
      tokenCount += 1;
    }
  }
}
console.log(`[${shopKey}] 码池 ${codeCount} 条 · NFT 交付池 ${tokenCount} 条`);

// ── 结果汇总（只报告本脚本写下的内容；订单由 dev-orders.mjs 真实产生）──
const byKind = (k) => productRows.filter((p) => p.kind === k).length;
console.log(
  `[${shopKey}] 实物 ${byKind('physical')} · 数字 ${byKind('digital')} · NFT ${byKind('nft')}` +
    `（已下架 ${productRows.filter((p) => p.active === 0).length}）`
);
console.log(`[${shopKey}] ✅ 链下内容完成 → ${path.resolve(dbFile)}`);
console.log(`[${shopKey}] 订单/售后不在此生成：请运行 node scripts/dev/dev-orders.mjs（真链交易 + 真接口）`);
