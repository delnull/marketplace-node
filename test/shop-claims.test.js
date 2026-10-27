/**
 * 店铺身份声明（shop claim）：`src/claims.js`（唯一判据）+ `POST/GET /api/shop/claims`
 * + `POST /api/shop/claims/:id/revoke`。
 *
 * 覆盖六组：
 *  ① **消息确定性**：同一组入参逐字节相同（LF 连接、无尾随换行、固定字段顺序），
 *     且 `message` 原样存储/下发——EOA 重算 `verifyMessage`、合约账户做 1271 核验，
 *     用的都是这两个字节；
 *  ② **声明值规则**：domain/github/x/telegram 各自的合法形态与可读中文错（含 `@` 前缀归一、
 *     ASCII 折小写、超长直接拒绝）；
 *  ③ **签名核验**：签名有效 / 签名者不是 operator / 签名格式不合法 / 消息绑定了别家 code
 *     各自的结果（失败一律不落库）；
 *  ④ **operator 取不到**：未配置 registry、Registry 读失败 ⇒ 如实报"暂无法核验店主身份"并拒绝，
 *     **绝不放行**（未核验的声明一旦进公开列表，第三方会以为"店主签过"）；
 *  ⑤ **幂等与撤销**：同 kind+value+address 只有一行，重复提交不改行；撤销后不出现在公开列表，
 *     重复撤销幂等，撤销后可重新声明恢复生效；
 *  ⑥ **公开面纪律**：只出有效声明、原样带 message/signature、**不含**任何"已认证/官方"字段，
 *     鉴权（未登录 401 / 店员 403）与审计留痕。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, verifyMessage } from 'ethers';
import { makeCtx, login, assertOk, shopRef, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner, buyer, db } = ctx;

const { CLAIM_KINDS, CLAIM_VALUE_MAX, buildClaimMessage, parseClaimMessage, checkClaimValue, verifyClaim } =
  await import('../src/claims.js');

const CODE = TEST_SHOP_CODE; // 与 fixture 落的那一行**同一个编号**（句柄 = 它，见 setup.mjs 的说明）
const OTHER_CODE = '0000OTHR1';
const OP = owner.address.toLowerCase();

let ownerToken;
let staffWallet;
let staffToken;

/*
  声明提交完全在链下（店铺编号是本节点铸造的 `shops.code`），所以这里不需要任何链上桩，
  只需要登录态与一名非店主店员（证明两个写入口都是 ownerOnly，而不是"登录即可"）。
*/
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);
  staffWallet = Wallet.createRandom();
  const add = await request(app)
    .put('/api/shop/staff')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ action: 'add', address: staffWallet.address })
    .expect(200);
  assertOk(add);
  staffToken = (await login(ctx, staffWallet)).token;
});

/** 店主应签的那条规范消息（与节点端同一实现：唯一实现就是 src/claims.js） */
const claimMessage = (over = {}) =>
  buildClaimMessage({
    code: CODE,
    operator: OP,
    kind: 'domain',
    value: 'shop.example.com',
    issued: '2026-10-13',
    ...over,
  });

/** 用店主钱包签一条声明并提交 */
async function claim(body, token = ownerToken) {
  const res = await request(app)
    .post('/api/shop/claims')
    .set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value)
    .send(body)
    .expect(200);
  return res;
}

/** 便捷：构造并签名一条声明（返回可直接提交的请求体） */
async function signedBody({ kind = 'domain', value = 'shop.example.com', issued = '2026-10-13', wallet = owner, sign = true } = {}) {
  const message = claimMessage({ kind, value, issued, operator: wallet === owner ? OP : wallet.address.toLowerCase() });
  const signature = sign ? await wallet.signMessage(message) : '0x' + 'ab'.repeat(65);
  return { kind, value, issued, signature, message };
}

const claimsList = async () => {
  const res = await request(app).get('/api/shop/claims').expect(200);
  assertOk(res);
  return res.body.data.claims;
};

const claimRows = async () => await db.all('SELECT * FROM shop_claims ORDER BY id');
const auditActions = async () =>
  await db.all("SELECT action, detail FROM audit_logs WHERE action LIKE 'shop.claim%' ORDER BY id");

// ── ① 消息确定性（字节契约）──

test('规范消息：标题行 + 5 个字段行，LF 连接、无尾随换行；同输入同字节（逐字节钉死）', () => {
  const msg = claimMessage();
  assert.equal(
    msg,
    `BTY marketplace shop claim\ncode: ${CODE}\noperator: ${OP}\nkind: domain\nvalue: shop.example.com\nissued: 2026-10-13`
  );
  assert.equal(msg.split('\n').length, 6, '标题行 + 5 个字段行');
  assert.ok(!msg.endsWith('\n'), '不得有尾随换行（多一个字节所有签名都验不过）');
  assert.ok(!msg.startsWith('\uFEFF'), '不得有 BOM');
  // 确定性：同输入两次调用逐字节相同（不是 JSON.stringify 那种"键序/空格可能变"的形状）
  assert.equal(claimMessage(), msg);
  // 字段顺序变了就是另一条消息（哈希/签名都不同）——用解析器把顺序钉住
  assert.deepEqual(parseClaimMessage(msg), {
    code: CODE,
    operator: OP,
    kind: 'domain',
    value: 'shop.example.com',
    issued: '2026-10-13',
  });
  assert.equal(parseClaimMessage(msg + '\n'), null, '多一个尾随换行就不再是本店规范消息');
  assert.equal(parseClaimMessage(msg.replace('code: ', 'Code: ')), null, '字段名大小写不容错（字节即契约）');
  // 改任一字段 ⇒ 另一串字节
  assert.notEqual(claimMessage({ issued: '2026-10-14' }), msg);
  assert.notEqual(claimMessage({ operator: buyer.address.toLowerCase() }), msg);
  assert.notEqual(claimMessage({ code: OTHER_CODE }), msg);
});

test('铁律：构造器**逐字**使用入参——不做归一、不折大小写、不 trim、不补当天', () => {
  // 非规范形照样逐字进消息（形态策略在 checkClaimValue，构造器只负责"把给我的字节拼成消息"）：
  // 若它在这里替调用方折了小写，服务端就会用"归一后的值"去验一份"客户端按原文签的"签名 ⇒ 永远验不过
  assert.notEqual(claimMessage({ value: 'Shop.Example.com' }), claimMessage(), '大小写不同 ⇒ 不是一个字节串');
  assert.equal(
    claimMessage({ value: 'Shop.Example.com' }),
    `BTY marketplace shop claim\ncode: ${CODE}\noperator: ${OP}\nkind: domain\nvalue: Shop.Example.com\nissued: 2026-10-13`,
    'value 原样进消息'
  );
  assert.notEqual(claimMessage({ value: ' shop.example.com ' }), claimMessage(), '首尾空格也不许被 trim 掉');
  assert.notEqual(claimMessage({ issued: '2026-10-14' }), claimMessage({ issued: '2026-10-13' }), 'issued 逐字使用');
  // kind 必须已经是规范形（不做大小写归一）：'DOMAIN' 直接拼不出来
  assert.throws(() => claimMessage({ kind: 'DOMAIN' }), /kind 需逐字为 domain \/ github \/ x \/ telegram 之一/);
  assert.throws(() => claimMessage({ operator: OP.toUpperCase().replace('0X', '0x') }), /operator 需为\*\*小写\*\*的 0x/);
  assert.throws(() => claimMessage({ value: 'a\nb' }), /不能包含换行/);
});

test('CLAIM_KINDS 清单固定；缺 kind / 非法 kind / 缺 issued 都报可读中文错', () => {
  assert.deepEqual([...CLAIM_KINDS], ['domain', 'github', 'x', 'telegram']);
  assert.throws(() => claimMessage({ issued: undefined }), /issued 需为 YYYY-MM-DD/);
  assert.throws(() => claimMessage({ issued: '2026-02-30' }), /issued 需为 YYYY-MM-DD/, '形状合法但日期不存在也要拒');
  assert.throws(() => claimMessage({ issued: '2026/10/13' }), /issued 需为 YYYY-MM-DD/);
  assert.throws(() => claimMessage({ code: '' }), /店铺编号不合法/);
});

// ── ② 声明值校验器（**拒绝**而不是变换；规范形只用来告诉店主"该写成什么"）──

test('checkClaimValue：已是规范形 → ok 且 value 与入参**逐字相同**（不返回"替你改好的值"）', () => {
  for (const [kind, value] of [
    ['domain', 'shop.example.com'],
    ['github', 'octocat/hello-world'],
    ['github', 'octocat'],
    ['x', 'jack'],
    ['telegram', 'durov_1'],
  ]) {
    const r = checkClaimValue(kind, value);
    assert.equal(r.ok, true, `${kind} ${value} 应通过`);
    assert.equal(r.value, value, 'value 必须与入参逐字相同（原样进消息、原样落库）');
    assert.equal(r.canonical, value);
  }
});

test('checkClaimValue：非规范形 → **拒绝**并给出规范形（大小写 / @ / 空格都不许静默归一）', () => {
  const cases = [
    ['domain', 'Shop.Example.COM', 'shop.example.com'],
    ['domain', ' shop.example.com ', 'shop.example.com'],
    ['github', '@OctoCat/Hello-World', 'octocat/hello-world'],
    ['github', 'Octocat', 'octocat'],
    ['x', '@Jack', 'jack'],
    ['x', 'Jack', 'jack'],
    ['telegram', '@Durov', 'durov'],
  ];
  for (const [kind, input, canonical] of cases) {
    const r = checkClaimValue(kind, input);
    assert.equal(r.ok, false, `「${input}」不是规范形，必须拒绝`);
    assert.equal(r.canonical, canonical, '并在 canonical 里给出"该写成什么"');
    assert.match(r.reason, /逐字/, '原因必须说清是"逐字"问题');
    assert.match(r.reason, new RegExp(canonical.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), '原因里带上规范形');
  }
});

test('checkClaimValue：形态非法 / 空值 / 非字符串 / 超长 / 含换行都拒绝（原因可读）', () => {
  const bad = [
    ['domain', 'https://shop.example.com'],
    ['domain', 'shop.example.com/path'],
    ['domain', 'shop.example.com:8080'],
    ['domain', 'localhost'],
    ['domain', '1.2.3.4'],
    ['domain', 'exa_mple.com'],
    ['domain', '-a.com'],
    ['domain', 'a..com'],
    ['domain', 'example.co1'],
    ['domain', 'example.xn--fiqs8s'],
    ['github', 'a/b/c'],
    ['github', 'octocat/'],
    ['github', '/repo'],
    ['github', '-octo'],
    ['github', 'octo/re po'],
    ['github', 'o'.repeat(40)],
    ['x', 'a'.repeat(16)],
    ['x', 'jack.space'],
    ['telegram', 'abcd'],
    ['telegram', 'a'.repeat(33)],
  ];
  for (const [kind, v] of bad) {
    const r = checkClaimValue(kind, v);
    assert.equal(r.ok, false, `应拒绝 ${kind} ${v}`);
    assert.match(r.reason, new RegExp(`不是合法的 ${kind}`), `原因应说明是哪种 kind 的形态问题：${v}`);
  }
  for (const [kind, v] of [['domain', ''], ['domain', '   '], ['domain', 123], ['domain', null]]) {
    assert.equal(checkClaimValue(kind, v).ok, false, `空值/非字符串必须拒绝：${JSON.stringify(v)}`);
  }
  const long = `${'a'.repeat(CLAIM_VALUE_MAX)}.com`;
  const r = checkClaimValue('domain', long);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`超过 ${CLAIM_VALUE_MAX} 字符上限`), '超长直接拒绝（不截断）');
  assert.equal(r.canonical, null, '连规范形都得不出来时 canonical 为 null');
  const nl = checkClaimValue('domain', 'shop.example.com\ncode: 00000009');
  assert.equal(nl.ok, false);
  assert.match(nl.reason, /不能包含换行/);
});

test('checkClaimValue：kind 必须逐字（大写 kind 不折）', () => {
  const r = checkClaimValue('DOMAIN', 'shop.example.com');
  assert.equal(r.ok, false);
  assert.match(r.reason, /kind 需逐字为 domain \/ github \/ x \/ telegram 之一/);
  assert.equal(checkClaimValue(undefined, 'shop.example.com').ok, false);
});

// ── ③ 签名核验（有效 / 无效 / 非 operator / 绑定别家 code / 非规范输入必须拒绝）──

test('POST：店主签名有效 → 落库；第三方用 verifyMessage 可离线复算（不信任节点）', async () => {
  const body = await signedBody();
  const res = await claim({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature });
  assertOk(res);
  const d = res.body.data;
  assert.equal(d.kind, 'domain');
  assert.equal(d.value, 'shop.example.com', 'value 存的是**签名覆盖的那个原文**');
  assert.equal(d.address, OP, 'address = 签名者 = 本店 operator');
  assert.equal(d.message, body.message, '存储/下发的 message 与店主签的那条逐字节相同');
  assert.equal(d.signature, body.signature);
  // `createdAt` 是 DATETIME(3)（`Date`）经 JSON 出去的 **ISO-8601 字符串**：要比时刻先 parse
  assert.ok(Number.isFinite(Date.parse(d.createdAt)) && Date.parse(d.createdAt) > 0);

  const pub = await claimsList();
  assert.equal(pub.length, 1);
  // 第三方视角：只用响应里的 message + signature 重算（不调节点任何代码）
  assert.equal(verifyMessage(pub[0].message, pub[0].signature).toLowerCase(), pub[0].address);
  // 节点只回答"签名有效"这一事实：不得出现任何"已认证/官方"字段
  assert.deepEqual(Object.keys(pub[0]).sort(), ['address', 'createdAt', 'id', 'kind', 'message', 'shopCode', 'signature', 'value']);
  assert.equal(typeof pub[0].id, 'string', 'id 下发字符串（前端类型 ShopClaim.id 是 string，撤销 URL 段也用它）');
  /*
    多店改造后本组用例**不再断言 chain.asked**：声明提交路径不再向 Registry 实时读编号
    （那会让每次提交都要等一次 RPC，且多店之下"哪个 operator 的编号"本身就不成立——
    编号属于**店铺**，不再属于节点主地址）。编号改读本地 shops.code 镜像，
    由 termsReconciler / /verify-onchain 对账写入；对账那一路的链上读取有它自己的用例。
  */
});

test('**回归钉子**：非规范输入一律拒绝——哪怕签名对应的正是"归一后的值"（旧形状会放行）', async () => {
  const before = (await claimRows()).length;
  // 旧形状的失败形态：节点先归一 value 再拼消息验签 ⇒ 客户端若按原文签，永远验不过；
  // 反过来说，只要客户端"猜到了"节点的归一结果去签，旧形状就会**放行一条 value 与签名不一致**的记录。
  // 这里正是那种输入：提交 'Example.COM'，签的却是归一形 'example.com' 的消息 —— 必须拒绝。
  const normalizedMsg = claimMessage({ kind: 'domain', value: 'example.com', issued: '2026-10-13' });
  const res = await claim({
    kind: 'domain',
    value: 'Example.COM',
    issued: '2026-10-13',
    signature: await owner.signMessage(normalizedMsg),
  });
  assert.notEqual(res.body.code, 0, '非规范形必须拒绝（节点不得先归一再用归一值验签）');
  assert.match(res.body.message, /逐字/, '原因要说清是"逐字"问题');
  assert.match(res.body.message, /example\.com/, '并给出规范形');
  assert.match(res.body.message, /BTY marketplace shop claim/, '同时给出"改成规范形后应签的那条消息"');
  assert.match(res.body.message, /value: example\.com/, '建议消息里用的是规范形');
  assert.equal((await claimRows()).length, before, '拒绝的请求一律不落库');

  // 同样的输入、签**原文**的消息也不行：非规范形在校验环节就被挡下（根本不进入验签）
  const rawMsg = claimMessage({ kind: 'domain', value: 'Example.COM', issued: '2026-10-13' });
  const res2 = await claim({
    kind: 'domain',
    value: 'Example.COM',
    issued: '2026-10-13',
    signature: await owner.signMessage(rawMsg),
  });
  assert.notEqual(res2.body.code, 0);
  assert.match(res2.body.message, /逐字/);
  assert.equal((await claimRows()).length, before);

  // 几类典型非规范输入（大小写 / @ / 空格）都走同一条拒绝路径
  for (const [kind, value] of [
    ['domain', 'shop.example.com '],
    ['x', '@jack'],
    ['github', 'Octocat'],
  ]) {
    const r = await claim({ kind, value, issued: '2026-10-13', signature: await owner.signMessage(claimMessage({ kind, value, issued: '2026-10-13' })) });
    assert.notEqual(r.body.code, 0, `${kind}「${value}」不是规范形，必须拒绝`);
    assert.match(r.body.message, /逐字/);
  }
  // kind 大写同样拒绝（消息逐字，不折大小写）
  const upperKind = await claim({ kind: 'DOMAIN', value: 'shop.example.com', issued: '2026-10-13', signature: '0x' + 'ab'.repeat(65) });
  assert.notEqual(upperKind.body.code, 0);
  assert.match(upperKind.body.message, /kind 需逐字为/);
  assert.equal((await claimRows()).length, before, '以上全部不落库');
});

test('issued 逐字使用：缺 / 非法日期被拒；显式给出的"别的某一天"照样通过（跨天、跨时区不受影响）', async () => {
  const before = (await claimRows()).length;
  const dummySig = '0x' + 'ab'.repeat(65);
  // 缺 issued：不替店主补当天（校验在验签之前，所以签名对不对无关紧要）
  const missing = await claim({ kind: 'x', value: 'no_issued', signature: dummySig });
  assert.notEqual(missing.body.code, 0);
  assert.match(missing.body.message, /issued 需为 YYYY-MM-DD/);
  assert.match(missing.body.message, /不会替你补当天/);
  // 非法日期（形状不对 / 日历上不存在）
  for (const issued of ['2026-02-30', '2026/01/01', '26-01-01', '今天']) {
    const r = await claim({ kind: 'x', value: 'bad_issued', issued, signature: dummySig });
    assert.notEqual(r.body.code, 0, `issued=${issued} 应被拒`);
    assert.match(r.body.message, /issued 需为 YYYY-MM-DD/);
  }
  assert.equal((await claimRows()).length, before, '缺/非法 issued 不落库');

  // 显式给出的一天（与"今天"无关）必须被逐字采用：签它 → 验过 → message 里就是那一天
  for (const issued of ['2019-03-04', '2035-12-31']) {
    const body = await signedBody({ kind: 'telegram', value: `issued_${issued.replace(/-/g, '')}`, issued });
    const r = await claim({ kind: body.kind, value: body.value, issued, signature: body.signature });
    assertOk(r);
    assert.equal(r.body.data.message, body.message);
    assert.match(r.body.data.message, new RegExp(`issued: ${issued}$`), 'message 末尾就是请求体给的那一天');
    assert.equal(verifyMessage(r.body.data.message, r.body.data.signature).toLowerCase(), OP, '第三方重算仍得到同一个地址');
  }
});

test('POST：签名者是别人（非 operator）→ 拒绝且不落库', async () => {
  const before = (await claimRows()).length;
  const msg = claimMessage({ kind: 'x', value: 'someone', issued: '2026-10-13' });
  const res = await claim({ kind: 'x', value: 'someone', issued: '2026-10-13', signature: await buyer.signMessage(msg) });
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /签名核验不通过/);
  assert.match(res.body.message, /不是本店 operator/);
  assert.match(res.body.message, /BTY marketplace shop claim/, '把规范消息回给店主（他重签一次即可，不必猜）');
  assert.equal((await claimRows()).length, before, '未通过核验的声明一律不落库');
});

test('POST：签名覆盖 code 行 —— 拿别家编号签的消息在本店无效', async () => {
  const before = (await claimRows()).length;
  const foreign = claimMessage({ code: OTHER_CODE, kind: 'x', value: 'somehandle', issued: '2026-10-13' });
  const res = await claim({ kind: 'x', value: 'somehandle', issued: '2026-10-13', signature: await owner.signMessage(foreign) });
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /签名核验不通过/);
  assert.match(res.body.message, new RegExp(`code: ${CODE}`), '回给店主的是本店编号的消息');
  assert.equal((await claimRows()).length, before);
});

test('POST：签名格式不合法 / 缺失 → 可读中文错，不落库', async () => {
  const before = (await claimRows()).length;
  const bad = await claim({ kind: 'x', value: 'handle', issued: '2026-10-13', signature: '0xdeadbeef' });
  assert.notEqual(bad.body.code, 0);
  assert.match(bad.body.message, /签名格式不合法/);
  const none = await claim({ kind: 'x', value: 'handle', issued: '2026-10-13' });
  assert.notEqual(none.body.code, 0);
  assert.match(none.body.message, /签名格式不合法/);
  assert.equal((await claimRows()).length, before);
});

test('verifyClaim：三条判据缺一不可（消息形状 / operator 行 / 恢复地址）', async () => {
  const msg = claimMessage({ kind: 'x', value: 'jack', issued: '2026-10-13' });
  const sig = await owner.signMessage(msg);
  assert.deepEqual(await verifyClaim({ message: msg, signature: sig, expectedOperator: OP }), { ok: true, signer: OP, reason: null });
  assert.equal((await verifyClaim({ message: '随便一段文本', signature: sig, expectedOperator: OP })).ok, false, '不是规范消息 ⇒ 不算');
  assert.equal(
    (await verifyClaim({ message: msg, signature: sig, expectedOperator: buyer.address.toLowerCase() })).ok,
    false,
    '消息里的 operator 不是本店 ⇒ 不算（防拿别店消息在本店登记）'
  );
  assert.match(
    (await verifyClaim({ message: msg, signature: '0x00', expectedOperator: OP })).reason,
    /签名格式不合法/
  );
});

test('verifyClaim：合约账户走标准 1271 / Safe legacy，不再要求 EOA 签名', async () => {
  const contract = Wallet.createRandom().address.toLowerCase();
  const msg = claimMessage({ operator: contract, kind: 'domain', value: 'contract.example.com', issued: '2026-10-13' });
  const sig = '0x5afe';
  const erc1271 = new Interface([
    'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
    'function isValidSignature(bytes data, bytes signature) view returns (bytes4)',
  ]);

  const standard = {
    getCode: async () => '0x60006000',
    call: async ({ data }) => {
      assert.ok(String(data).startsWith('0x1626ba7e'));
      return erc1271.encodeFunctionResult('isValidSignature(bytes32,bytes)', ['0x1626ba7e']);
    },
  };
  assert.deepEqual(await verifyClaim({ message: msg, signature: sig, expectedOperator: contract, provider: standard }), {
    ok: true,
    signer: contract,
    reason: null,
  });

  let standardCalls = 0;
  const safe = {
    getCode: async () => '0x60006000',
    call: async ({ data }) => {
      const selector = String(data).slice(0, 10).toLowerCase();
      if (selector === '0x1626ba7e') {
        standardCalls += 1;
        return erc1271.encodeFunctionResult('isValidSignature(bytes32,bytes)', ['0xffffffff']);
      }
      assert.equal(selector, '0x20c13b0b');
      return erc1271.encodeFunctionResult('isValidSignature(bytes,bytes)', ['0x20c13b0b']);
    },
  };
  assert.equal((await verifyClaim({ message: msg, signature: sig, expectedOperator: contract, provider: safe })).ok, true);
  assert.equal(standardCalls, 1);

  const bad = {
    getCode: async () => '0x60006000',
    call: async () => erc1271.encodeFunctionResult('isValidSignature(bytes32,bytes)', ['0xffffffff']),
  };
  assert.equal((await verifyClaim({ message: msg, signature: sig, expectedOperator: contract, provider: bad })).ok, false);
});

// ── ④ 声明提交不依赖链：店铺编号是本节点铸造的本地事实 ──
/*
  "本店编号"的来源是本地 `shops.code`（本节点审批开店时铸造）。提交声明**不读链**：
  所以这里只验正常路径（核验用的 operator 也来自本地店铺行的 seller）。
*/
test('编号是本地事实 ⇒ 核验通过（提交声明不依赖链上读取）', async () => {
  const before = (await claimRows()).length;
  const body = await signedBody({ kind: 'x', value: 'mirroredcode' });
  const res = await claim({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature });
  assertOk(res);
  assert.equal((await claimRows()).length, before + 1);
});

// ── ⑤ 幂等与撤销 ──

test('重复声明（同 kind+value+address）幂等：不新增行、不改 createdAt，审计里能区分 duplicate', async () => {
  const body = await signedBody({ kind: 'telegram', value: 'idempotent_shop' });
  const first = await claim({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature });
  assertOk(first);
  const rowsAfterFirst = (await claimRows()).length;

  const second = await claim({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature });
  assertOk(second);
  assert.equal(second.body.data.id, first.body.data.id, '同一条记录');
  assert.equal((await claimRows()).length, rowsAfterFirst, '不产生第二条记录');
  assert.equal(second.body.data.createdAt, first.body.data.createdAt, '幂等重发不改 createdAt');
  assert.match(second.body.message, /幂等/);

  const audits = (await auditActions()).filter((a) => a.action === 'shop.claim');
  // `audit_logs.detail` 是 JSON 列：驱动读回来**已是对象**（旧形状是 TEXT，得自己 JSON.parse）
  assert.equal(audits.at(-1).detail.duplicate, true, '审计里必须能看出"这是重复提交"');
  assert.equal(audits.at(-2).detail.duplicate, false);
});

test('撤销：公开列表立刻不再返回；重复撤销幂等；未知道 id 404', async () => {
  const body = await signedBody({ kind: 'github', value: 'octocat/hello-world' });
  const created = await claim({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature });
  assertOk(created);
  const id = created.body.data.id;
  assert.ok((await claimsList()).some((c) => c.id === id), '撤销前在公开列表里');

  const revoked = await request(app)
    .post(`/api/shop/claims/${id}/revoke`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(revoked);
  assert.ok(!(await claimsList()).some((c) => c.id === id), '撤销后不出现在公开列表');
  assert.notEqual((await claimRows()).find((r) => String(r.id) === id).revoked_at, null, '库里是置 revoked_at，不是删行');

  const again = await request(app)
    .post(`/api/shop/claims/${id}/revoke`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(again);
  assert.match(again.body.message, /此前已撤销/);
  assert.equal((await auditActions()).filter((a) => a.action === 'shop.claim.revoke').length, 1, '没有变化就不重复写审计');

  const missing = await request(app)
    .post('/api/shop/claims/999999/revoke')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(404);
  assert.equal(missing.body.code, 404);
  const badId = await request(app).post('/api/shop/claims/abc/revoke').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.notEqual(badId.body.code, 0);
});

test('撤销后重新声明：同一行恢复生效（revoked_at 清空、createdAt 刷新为新的声明时刻）', async () => {
  const body = await signedBody({ kind: 'x', value: 'revive_me' });
  const created = await claim({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature });
  assertOk(created);
  const id = created.body.data.id;
  await request(app).post(`/api/shop/claims/${id}/revoke`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  const rowsBefore = (await claimRows()).length;

  const revived = await claim({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature });
  assertOk(revived);
  assert.match(revived.body.message, /恢复生效/);
  assert.equal(revived.body.data.id, id, '还是同一行（唯一索引不允许第二条）');
  assert.equal((await claimRows()).length, rowsBefore);
  assert.equal((await claimRows()).find((r) => String(r.id) === id).revoked_at, null);
  assert.ok((await claimsList()).some((c) => c.id === id));
  assert.equal((await auditActions()).at(-1).detail.revived, true);
});

// ── ⑥ 公开面与鉴权 ──

test('GET 公开只读：无需登录；形状是 { claims: [...] }（不是裸数组）', async () => {
  const res = await request(app).get('/api/shop/claims').expect(200);
  assertOk(res);
  assert.ok(Array.isArray(res.body.data.claims));
  assert.equal(typeof res.body.data, 'object');
  assert.match(res.body.message, /离线 verifyMessage|1271/, '响应里带上核验方法（第三方不需要读我们的文档）');
});

test('两个写入口都是 ownerOnly：未登录 401、店员 403（不能只挡匿名）', async () => {
  const body = await signedBody({ kind: 'domain', value: 'auth.example.com' });
  const anon = await request(app).post('/api/shop/claims').send({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature }).expect(401);
  assert.equal(anon.body.code, 401, '未登录（HTTP 401 与业务码同值，见 http.js 的 makeAuthMiddleware）');
  const staff = await request(app)
    .post('/api/shop/claims')
    .set('Authorization', `Bearer ${staffToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ kind: body.kind, value: body.value, issued: body.issued, signature: body.signature })
    .expect(403);
  assert.equal(staff.body.code, 403, '店员不是店主：经营面可以，身份声明不行');
  const staffRevoke = await request(app)
    .post('/api/shop/claims/1/revoke')
    .set('Authorization', `Bearer ${staffToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(403);
  assert.equal(staffRevoke.status, 403);
});
