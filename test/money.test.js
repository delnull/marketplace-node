/**
 * 金额展示口径（`src/money.js`）单测。
 *
 * 这个模块存在的理由就是"只有一个实现"：微 USDT → USDT 的换算与
 * "商品金额 = 总额 − 运费"原先在 orders / arbitration / products 三个路由里各抄了几遍，
 * 任意一处改动都会让同一个数在不同接口里不一样。所以这里把规则本身钉死：
 * **微 USDT**（1 USDT = 1e6 微）是整数单位、展示串最多 6 位小数且**去掉全部尾零**
 * （2026-10 定稿：不再补足两位小数，`25.00 → 25`、`12.50 → 12.5`、`0.10 → 0.1`、`0.00 → 0`）、
 * 运费按单一次、负数带号、非有限值按 0。
 *
 * 去零的代价（实现注释里已记录）：`25` 少了"这是金额"的视觉暗示，所以**单位必须由调用方补**——
 * `usdtOf` 只回数字串（`25`），接口层拼成 `25 USDT`。凡是被展示的金额位都必须带单位，
 * 下面的断言里也刻意带上单位，避免"光有数字没有单位"被当成合格输出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goodsMicroOf, usdtOf } from '../src/money.js';

test('money: usdtOf 微 USDT → USDT（最多 6 位小数、去净尾零，整数拆位不经浮点除法）', () => {
  // 契约基准表（2026-10 去尾零定稿）——每一行都对应接口上真实出现的展示串
  assert.equal(usdtOf(25_000_000), '25', '25 USDT 不写 25.00');
  assert.equal(usdtOf(12_500_000), '12.5', '去尾零：12.50 → 12.5');
  assert.equal(usdtOf(100_000), '0.1', '去尾零：0.10 → 0.1（不再补成两位小数）');
  assert.equal(usdtOf(50_000), '0.05', '无尾零可去时原样保留');
  assert.equal(usdtOf(1), '0.000001', '最小标价单位 = 1 微 USDT，6 位小数正好用满');
  assert.equal(usdtOf(0), '0', '0 不带小数位（不是 0.00）');
  assert.equal(usdtOf(999_990_000), '999.99', '有小数但无尾零：999.99');
  assert.equal(usdtOf(12_345_678), '12.345678', '6 位有效小数一位不少');
  assert.equal(usdtOf(-12_500_000), '-12.5', '负数带号，且同样去净尾零');
  assert.equal(usdtOf(-1), '-0.000001', '负的最小单位：符号不能丢，也不补零');
  // 整 USDT 与不足两位小数的边界
  assert.equal(usdtOf(1_000_000), '1', '1 USDT 不写 1.00');
  assert.equal(usdtOf(10), '0.00001', '10 微 = 0.00001 USDT（保留有效位，不再补零）');
  // 大额不丢精度：整数拆位，浮点 (1e14/1e6).toFixed(6) 之类会先损失有效位
  assert.equal(usdtOf(123_456_789_012_345), '123456789.012345');
  assert.equal(usdtOf(1_234_567_890_123_456), '1234567890.123456');

  // 去尾零不变式：小数点后不得以 0 结尾；没有小数时不得带小数点（这是新口径的"形状"）
  for (const micro of [0, 1, 10, 50_000, 100_000, 1_000_000, 12_500_000, 25_000_000, 999_990_000, 123_456_789_012_345]) {
    const s = usdtOf(micro);
    assert.ok(!/\.\d*0$/.test(s), `展示串不得带尾零：${micro} → ${s}`);
    assert.ok(!s.endsWith('.'), `展示串不得以小数点结尾：${micro} → ${s}`);
  }

  // 单位不在 usdtOf 里：调用方自己拼（接口层一律 `25 USDT` 这种带单位写法）
  assert.equal(`${usdtOf(25_000_000)} USDT`, '25 USDT');
  assert.ok(!usdtOf(25_000_000).includes('USDT'), 'usdtOf 只回数字串，不带单位');
});

test("money: usdtOf 对读不到/坏值按 0（'0'，不再是 '0.00'），绝不输出 NaN", () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, 'abc', {}]) {
    assert.equal(usdtOf(bad), '0', `坏值应格式化 0：${String(bad)}`);
  }
  // 数字串按数字处理（DB 里 usdt_micro 可能是 TEXT 列）
  assert.equal(usdtOf('25000000'), '25');
  // 入参单位是**微 USDT**（整数）：小数微按截断处理（12.5 微 → 12 微 → '0.000012'），不四舍五入造钱
  assert.equal(usdtOf('12.5'), '0.000012');
});

test('money: goodsMicroOf = 总额 − 运费（夹到 ≥ 0），数字单运费为 0 时等于总额', () => {
  assert.equal(goodsMicroOf(25_000_000, 5_000_000), 20_000_000); // 商品 20 USDT + 运费 5 USDT = 25 USDT
  assert.equal(goodsMicroOf(25_000_000, 0), 25_000_000); // 包邮/数字商品：总额即商品金额
  assert.equal(goodsMicroOf(25_000_000), 25_000_000); // 缺运费字段同上
  assert.equal(goodsMicroOf(3_000_000, 5_000_000), 0); // 坏数据（运费比总额还大）夹到 0，不产生负数商品价
  assert.equal(goodsMicroOf(undefined, 5_000_000), 0);
  assert.equal(goodsMicroOf('25000000', '5000000'), 20_000_000);
  // 拆分必须能拼回总额——这是「商品 + 运费 = 应付」能被买家逐项核对的前提
  assert.equal(goodsMicroOf(25_000_000, 5_000_000) + 5_000_000, 25_000_000);
  // 拆分的展示串同样去净尾零，且各自带单位（订单详情里商品/运费/应付三行并列，单位不能省）
  assert.equal(`${usdtOf(goodsMicroOf(25_000_000, 5_000_000))} USDT`, '20 USDT');
  assert.equal(`${usdtOf(5_000_000)} USDT`, '5 USDT');
});
