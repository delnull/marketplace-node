/**
 * NFT 商品全链路单测：上架校验与快照契约（nft_contract/nft_standard 键存在性）、tokenId
 * 交付池（导入展开/去重/查询/删除）、售罄口径、发货参数边界、NFT 标准守卫（建池后不可改）、
 * 集合核验纯函数（matchNftTransfers：ERC721 多枚 / ERC1155 TransferSingle/TransferBatch，
 * 同 tokenId 多份 value>1 拒绝）。链上收据拉取（verifyNftTransfersTx）不依赖测试网络——纯函数已覆盖。
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { assertOk, login, makeCtx, rowLikeOf } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
// 同买家同商品可多次购买（v2：orderId 含 UUID 随机化）
const buyer2 = Wallet.createRandom();
const buyer3 = Wallet.createRandom();
// 模拟链上规范哈希（escrowed 必有支付凭证，发货防呆要求）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

const NFT_CONTRACT = '0x' + '9'.repeat(40);
const OTHER_CONTRACT = '0x' + '8'.repeat(40);

function nftPayload(overrides = {}) {
  const { priceCnyFen = 6600, capacity = null, specs, skus, ...rest } = overrides;
  return {
    title: '测试 NFT 藏品',
    description: '单测 NFT 商品：链上藏品交付。',
    images: ['https://example.com/nft.jpg'],
    kind: 'nft',
    nftContract: NFT_CONTRACT,
    // 价格与库存逐组合给出；无规格商品就是 key='' 的唯一组合
    specs: specs ?? [],
    skus: skus ?? [{ key: '', priceCnyFen, capacity }],
    ...rest,
  };
}

let ownerToken;
let nftSlug;
let nftHash;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);
});

// ── 上架校验与快照契约 ──

test('上架 NFT：无/非法合约地址被拒', async () => {
  const noAddr = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(nftPayload({ nftContract: '' }))
    .expect(200);
  assert.notEqual(noAddr.body.code, 0);

  const badAddr = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(nftPayload({ nftContract: '0x123' }))
    .expect(200);
  assert.notEqual(badAddr.body.code, 0);

  const zeroAddr = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(nftPayload({ nftContract: '0x0000000000000000000000000000000000000000' }))
    .expect(200);
  assert.notEqual(zeroAddr.body.code, 0);
});

test('上架 NFT 成功：快照含 nft_contract 键，哈希可复算；合约地址小写归一', async () => {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(nftPayload())
    .expect(200);
  assert.ok(res);
  const p = res.body.data;
  assert.equal(p.kind, 'nft');
  assert.equal(p.nftContract, NFT_CONTRACT);
  assert.equal(p.nftStandard, 'erc721', '缺省 NFT 标准为 erc721');
  const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
  // 复算须与上架写入同构：rowLikeOf 由公开字段还原出 DB 行形状（含 specs/skus）
  const obj = snapshotObject(rowLikeOf(p));
  assert.ok('nft_contract' in obj, 'NFT 快照必须含 nft_contract 键');
  assert.ok('nft_standard' in obj, 'NFT 快照必须含 nft_standard 键（缺省 erc721）');
  assert.equal(computeSnapshotHash(obj), p.snapshotHash, 'NFT 快照哈希应可复算');
  nftSlug = p.slug;
  nftHash = p.snapshotHash;
});

test('快照契约回归：数字商品快照不含 nft_contract 键，键序为当前契约版本', async () => {
  const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
  const rowLike = {
    slug: 'p-abc',
    title: '旧商品',
    description: 'd',
    images: '[]',
    kind: 'digital',
    description_blocks: '[]',
    specs: '[]',
    skus: [{ sku_key: '', price_cny_fen: 100 }],
    nft_contract: '', // 非 NFT 商品 DB 中该列恒为空串
  };
  const snap = snapshotObject(rowLike);
  assert.ok(!('nft_contract' in snap), '数字商品快照不得含 nft_contract 键（否则哈希全部失效）');
  assert.ok(!('nft_standard' in snap), '数字商品快照不得含 nft_standard 键');
  /*
    契约：无商品级价格（在 skus 里）；详情块 description_blocks 是权威内容，也入快照。
    2026-09 契约版本 +1：**运费（shipping_fee_cny_fen）与年龄限制（age_restricted）**插入
    kind 之后、specs 之前（实物运费要能被买家核验"没被事后加价"；年龄限制要被锁定，
    防上架后静默增删）。键序同时改在 node 端 snapshotObject/computeSnapshotHash 与
    前端 utils/snapshot.ts —— 两端不同位就会让每个买家看到假的「商品内容已被修改」。
    ⚠️ 因此本用例的期望值也必须同步升级：旧哈希只对"按旧契约上架且从未重存"的商品有效，
    全新项目不做存量迁移（改动量最大的那部分历史数据不存在）。
  */
  const canonical = JSON.stringify({
    slug: 'p-abc', title: '旧商品', description: 'd', description_blocks: [], images: [], kind: 'digital',
    shipping_fee_cny_fen: 0, age_restricted: 0,
    specs: [], skus: [['', 100]],
  });
  const { ethers } = await import('ethers');
  assert.equal(computeSnapshotHash(snap), ethers.keccak256(ethers.toUtf8Bytes(canonical)));
});

test('nftStandard 校验：非法值被拒；erc1155 上架成功且快照锁定该标准', async () => {
  const bad = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(nftPayload({ nftStandard: 'erc20' }))
    .expect(200);
  assert.notEqual(bad.body.code, 0);
  assert.match(bad.body.message, /nftStandard/);

  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(nftPayload({ title: 'ERC1155 批量藏品', nftStandard: 'erc1155' }))
    .expect(200);
  assertOk(res);
  const p = res.body.data;
  assert.equal(p.nftStandard, 'erc1155', '对外输出 nftStandard');
  const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
  const obj = snapshotObject(rowLikeOf(p));
  assert.equal(obj.nft_standard, 'erc1155', 'NFT 快照须锁定 nft_standard');
  assert.equal(computeSnapshotHash(obj), p.snapshotHash, 'erc1155 快照哈希可复算');
});

test('NFT 标准不可在已建交付池后变更（核验语义绑定池内库存）；清池后可改', async () => {
  const up = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(nftPayload({ title: '标准守卫商品' }))
    .expect(200);
  assertOk(up);
  const slug = up.body.data.slug;
  // 建池前可改标准（快照哈希随 nft_standard 键变化而重算）
  const patch1 = await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ nftStandard: 'erc1155' })
    .expect(200);
  assertOk(patch1);
  assert.equal(patch1.body.data.nftStandard, 'erc1155');
  // 建池后不可改（避免已导入库存与未来核验语义错配）
  const imp = await request(app)
    .post(`/api/products/${slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokens: ['1'] })
    .expect(200);
  assertOk(imp);
  const patch2 = await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ nftStandard: 'erc721' })
    .expect(200);
  assert.notEqual(patch2.body.code, 0);
  assert.match(patch2.body.message, /不可变更 NFT 标准/);
  // 删除池内全部 tokenId 后恢复可改
  const list = await request(app)
    .get(`/api/products/${slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(list);
  const del = await request(app)
    .delete(`/api/products/${slug}/tokens/${list.body.data.tokens[0].id}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(del);
  const patch3 = await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ nftStandard: 'erc721' })
    .expect(200);
  assertOk(patch3);
  assert.equal(patch3.body.data.nftStandard, 'erc721');
});

// ── parseTokenSpec 纯函数 ──

test('parseTokenSpec：十进制 / 0x hex / 范围展开 / 非法输入', async () => {
  const { parseTokenSpec } = await import('../src/routes/products.js');
  assert.deepEqual(parseTokenSpec('123').values.map(String), ['123']);
  assert.deepEqual(parseTokenSpec('0x1F').values.map(String), ['31']);
  assert.deepEqual(parseTokenSpec('1-3').values.map(String), ['1', '2', '3']);
  assert.deepEqual(parseTokenSpec(' 7 ').values.map(String), ['7']);
  assert.equal(parseTokenSpec('').ok, false);
  assert.equal(parseTokenSpec('abc').ok, false);
  assert.equal(parseTokenSpec('-1').ok, false);
  assert.equal(parseTokenSpec('3-1').ok, false);
  assert.equal(parseTokenSpec('1-2-3').ok, false);
  assert.equal(parseTokenSpec('1-999999').ok, false, '范围炸弹应被拒');
  assert.equal(parseTokenSpec('0x' + '1' + '0'.repeat(64)).ok, false, '2^256（uint256 上界）应被拒');
  assert.equal(parseTokenSpec('0x' + 'f'.repeat(64)).ok, true, '2^256-1 是合法 uint256 最大值');
  assert.equal(parseTokenSpec('0x' + '1' + '0'.repeat(63)).ok, true, '2^255 合法');
  // 大数精度：超过 Number.MAX_SAFE_INTEGER 的 tokenId 用 BigInt 无损
  const big = (1n << 128n).toString();
  assert.equal(parseTokenSpec(big).values[0].toString(), big);
});

// ── NFT 交付池 ──

test('交付池导入：非 NFT 商品被拒', async () => {
  const { productPayload } = await import('./setup.mjs');
  const digital = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ title: '非 NFT 对照商品' }))
    .expect(200);
  const slug = digital.body.data.slug;
  const res = await request(app)
    .post(`/api/products/${slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokens: ['1'] })
    .expect(200);
  assert.notEqual(res.body.code, 0, '数字商品不可导入 tokenId 池');
});

test('交付池导入：展开 + 去重 + 重复跳过；超限被拒', async () => {
  const res = await request(app)
    .post(`/api/products/${nftSlug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokens: ['0x01', '2', '3', '4-6', '4-6', '0x5'] })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.imported, 6, '展开去重后 1..6 共 6 个全部入库');
  assert.equal(res.body.data.skipped, 0, '请求内重复已在解析阶段折叠，skipped 仅统计库内重复');
  assert.equal(res.body.data.stats.unused, 6);
  // 非法行 → 整批拒绝（不产生部分导入）
  const bad = await request(app)
    .post(`/api/products/${nftSlug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokens: ['7', 'oops'] })
    .expect(200);
  assert.notEqual(bad.body.code, 0);
  const stats = db.prepare('SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = (SELECT id FROM products WHERE slug = ?)').get(nftSlug);
  assert.equal(stats.c, 6, '非法批不应产生部分导入');
  // 展开超限
  const tooMany = await request(app)
    .post(`/api/products/${nftSlug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokens: ['100-1000'] })
    .expect(200);
  assert.notEqual(tooMany.body.code, 0);
  // 库内已存在的 tokenId 再导入 → 整条跳过（INSERT OR IGNORE 生效，池不重复）
  const dup = await request(app)
    .post(`/api/products/${nftSlug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokens: ['1'] })
    .expect(200);
  assertOk(dup);
  assert.equal(dup.body.data.imported, 0);
  assert.equal(dup.body.data.skipped, 1);
  assert.equal(dup.body.data.stats.unused, 6, '重复导入不改变池内条数');
});

test('交付池查询与删除：状态过滤、仅未用可删', async () => {
  const list = await request(app)
    .get(`/api/products/${nftSlug}/tokens?status=unused`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(list);
  assert.equal(list.body.data.total, 6);
  assert.equal(list.body.data.tokens[0].tokenId, '6');
  const del = await request(app)
    .delete(`/api/products/${nftSlug}/tokens/${list.body.data.tokens[0].id}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(del);
  assert.equal(del.body.data.stats.unused, 5);
  // 再次删除同一 id：服务端返回 HTTP 404 + body.code 404
  const again = await request(app)
    .delete(`/api/products/${nftSlug}/tokens/${list.body.data.tokens[0].id}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(404);
  assert.equal(again.body.code, 404);
});

/** 店主代买家下单（owner 可代任意买家） */
async function createDraft(slug, who = buyer.address) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: slug, buyer: who })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

// ── 下单与售罄 ──

test('NFT 商品下单：池内有未用 tokenId 时成功，订单快照含 nft_contract', async () => {
  const o = await createDraft(nftSlug);
  assert.equal(o.status, 'draft');
  assert.equal(o.snapshotHash, nftHash);
  assert.equal(o.productSnapshot.kind, 'nft');
  assert.equal(o.productSnapshot.nft_contract, NFT_CONTRACT, '订单快照须锁定 NFT 合约地址');
  assert.deepEqual(o.deliveries, [], '未交付时无交付行');
  // 详情接口同样携带交付凭证字段
  const detail = await request(app).get(`/api/orders/${o.id}`).expect(200);
  assert.ok('deliveries' in detail.body.data);
});

test('NFT 商品售罄拦截：池内全部交付后新订单被拒', async () => {
  // 手工模拟全部 tokenId 已交付（used）——池还有 5 个，先全置 used
  db.prepare(
    'UPDATE product_nft_tokens SET status = ?, order_id = ?, used_at = ? WHERE product_id = (SELECT id FROM products WHERE slug = ?)'
  ).run('used', '00000000-0000-0000-0000-000000000000', Date.now(), nftSlug);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: nftSlug, buyer: buyer.address })
    .expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /库存不足/);
  // 复原一个未用供后续发货测试
  db.prepare(
    "UPDATE product_nft_tokens SET status = 'unused', order_id = NULL, used_at = NULL WHERE product_id = (SELECT id FROM products WHERE slug = ?) AND status = 'used'"
  ).run(nftSlug);
});

// ── 发货参数边界（链上核验前的可测部分）──

test('NFT 交付登记：tokenId/txHash 缺失或非法、tokenId 不在池内 → 链上核验前即被拒', async () => {
  const created = await createDraft(nftSlug, buyer2.address);
  const id = created.id;
  // 直接置 escrowed（模拟托管成功并落支付凭证——链上校验非本文件范围）
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), id);
  const txHash = '0x' + 'a'.repeat(64);

  const noToken = await request(app)
    .post(`/api/orders/${id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokenId: '', txHash })
    .expect(200);
  assert.notEqual(noToken.body.code, 0);

  const badHash = await request(app)
    .post(`/api/orders/${id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokenId: '1', txHash: 'abc' })
    .expect(200);
  assert.notEqual(badHash.body.code, 0);

  const notInPool = await request(app)
    .post(`/api/orders/${id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokenId: '99999', txHash })
    .expect(200);
  assert.notEqual(notInPool.body.code, 0);
  assert.match(notInPool.body.message, /不在商品交付池/);
  // 池外 tokenId 应保持 escrowed 不动
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'escrowed');
});

test('NFT 交付登记：池内 tokenId 但收据无法核验 → 明确失败且状态不动', async () => {
  const created = await createDraft(nftSlug, buyer3.address);
  const id = created.id;
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), id);
  // 该单的买家 != 链上 from 校验会失败，但 txHash 本身无法在单测查询（provider 指向假 RPC）
  // —— verifyNftTransferTx 会因网络不可用返回「链上查询失败」，同样视为核验不通过
  const res = await request(app)
    .post(`/api/orders/${id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokenId: '1', txHash: '0x' + 'b'.repeat(64) })
    .expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /核验未通过/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'escrowed');
});

// ── matchNftTransfers 纯函数（集合核验）──

let nftLib;
async function lib() {
  if (!nftLib) nftLib = await import('../src/nftDelivery.js');
  return nftLib;
}

/** ERC721 Transfer 日志 */
async function make721Log(contract, from, to, tokenId, extra = {}) {
  const { erc721Iface } = await lib();
  const frag = erc721Iface.getEvent('Transfer');
  const encoded = erc721Iface.encodeEventLog(frag, [from, to, BigInt(tokenId)]);
  return { address: contract, blockNumber: 1, transactionHash: '0x' + 'c'.repeat(64), ...encoded, ...extra };
}

/** ERC1155 TransferSingle 日志 */
async function make1155Single(contract, operator, from, to, id, value = 1n) {
  const { erc1155Iface } = await lib();
  const frag = erc1155Iface.getEvent('TransferSingle');
  const encoded = erc1155Iface.encodeEventLog(frag, [operator, from, to, BigInt(id), BigInt(value)]);
  return { address: contract, blockNumber: 1, transactionHash: '0x' + 'c'.repeat(64), ...encoded };
}

/** ERC1155 TransferBatch 日志 */
async function make1155Batch(contract, operator, from, to, ids, values) {
  const { erc1155Iface } = await lib();
  const frag = erc1155Iface.getEvent('TransferBatch');
  const encoded = erc1155Iface.encodeEventLog(frag, [operator, from, to, ids.map((i) => BigInt(i)), values.map((v) => BigInt(v))]);
  return { address: contract, blockNumber: 1, transactionHash: '0x' + 'c'.repeat(64), ...encoded };
}

test('matchNftTransfers：erc721 单枚/同收据多笔批量通过（地址大小写不敏感）', async () => {
  const { matchNftTransfers } = await lib();
  // 单枚：一个哈希一枚
  const one = await make721Log(NFT_CONTRACT, owner.address, buyer.address, '42');
  const r1 = matchNftTransfers([one], NFT_CONTRACT.toUpperCase(), {
    standard: 'erc721',
    from: owner.address,
    to: buyer.address,
    tokenIds: ['42'],
  });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  // 批量：同收据两笔 Transfer（一个哈希多枚）
  const batch = [
    await make721Log(NFT_CONTRACT, owner.address, buyer.address, '42'),
    await make721Log(NFT_CONTRACT, owner.address, buyer.address, '43'),
  ];
  const r2 = matchNftTransfers(batch, NFT_CONTRACT, {
    standard: 'erc721',
    from: owner.address,
    to: buyer.address,
    tokenIds: ['43', '42'],
  });
  assert.equal(r2.ok, true, JSON.stringify(r2));
});

test('matchNftTransfers：申报集合缺枚 / from/to 不符 / 合约不符 / 空收据均拒绝', async () => {
  const { matchNftTransfers } = await lib();
  const stranger = '0x' + '7'.repeat(40);
  const logs = [await make721Log(NFT_CONTRACT, owner.address, buyer.address, '42')];
  const base = { standard: 'erc721', from: owner.address, to: buyer.address };
  // 缺一枚：reason 明确指出缺失 tokenId
  const miss = matchNftTransfers(logs, NFT_CONTRACT, { ...base, tokenIds: ['42', '44'] });
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /44/);
  // 转出方不是店主 / 接收方不是买家 / 合约不符 / 空收据
  assert.equal(matchNftTransfers(logs, NFT_CONTRACT, { ...base, from: stranger, tokenIds: ['42'] }).ok, false);
  assert.equal(matchNftTransfers(logs, NFT_CONTRACT, { ...base, to: stranger, tokenIds: ['42'] }).ok, false);
  assert.equal(matchNftTransfers(logs, OTHER_CONTRACT, { ...base, tokenIds: ['42'] }).ok, false);
  assert.equal(matchNftTransfers([], NFT_CONTRACT, { ...base, tokenIds: ['42'] }).ok, false);
});

test('matchNftTransfers：收据混入 mint/他人转账等无关日志被跳过，不误报不误判', async () => {
  const { matchNftTransfers } = await lib();
  const zero = '0x' + '0'.repeat(40);
  const logs = [
    await make721Log(NFT_CONTRACT, zero, owner.address, '1'), // mint（from=0x0）→ 店主
    await make721Log(NFT_CONTRACT, buyer.address, '0x' + '7'.repeat(40), '99'), // 买家转给他人
    await make721Log(NFT_CONTRACT, owner.address, buyer.address, '42'), // 本单交付
  ];
  const r = matchNftTransfers(logs, NFT_CONTRACT, {
    standard: 'erc721',
    from: owner.address,
    to: buyer.address,
    tokenIds: ['42'],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('matchNftTransfers：erc1155 TransferSingle value=1 通过；value>1（同 id 多份）拒绝', async () => {
  const { matchNftTransfers } = await lib();
  const base = { standard: 'erc1155', from: owner.address, to: buyer.address };
  const single = await make1155Single(NFT_CONTRACT, owner.address, owner.address, buyer.address, '7');
  const ok1 = matchNftTransfers([single], NFT_CONTRACT, { ...base, tokenIds: ['7'] });
  assert.equal(ok1.ok, true, JSON.stringify(ok1));
  // value=2：一个 tokenId 转 2 份——本地池模型无同 id 多份库存
  const dup = await make1155Single(NFT_CONTRACT, owner.address, owner.address, buyer.address, '7', 2n);
  const bad = matchNftTransfers([dup], NFT_CONTRACT, { ...base, tokenIds: ['7'] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /多份/);
});

/**
 * **P0 回归：ERC1155 `value=0` 的空转账不得被当作交付凭证**（源码审计 2026-09 复审）。
 *
 * `value=0` 是**合法的空转账**：OpenZeppelin 的 `_update` 对 value=0 不做余额检查、
 * 照样 `emit TransferSingle`，所以店主可以在任意 ERC1155 合约上（连这枚 NFT 都不持有）
 * 调 `safeTransferFrom(店主, 买家, id, 0, '0x')`，拿收据来"交付"。
 * 旧实现只拦 `v > 1n`：`collected.set(id, 0n)` 既不过 over（0 > 1 为假）、
 * 又让 `collected.has(id)` 为真而不过 missing —— 两道检查同时放行，买家什么都没收到
 * 却被标记"已发货"，超时后托管款判给店主。
 */
test('matchNftTransfers：erc1155 value=0 的空转账必须被拒（不得当作交付）', async () => {
  const { matchNftTransfers } = await lib();
  const base = { standard: 'erc1155', from: owner.address, to: buyer.address };
  const zero = await make1155Single(NFT_CONTRACT, owner.address, owner.address, buyer.address, '9', 0n);
  const r = matchNftTransfers([zero], NFT_CONTRACT, { ...base, tokenIds: ['9'] });
  assert.equal(r.ok, false, `value=0 不得通过核验：${JSON.stringify(r)}`);
  assert.match(r.reason, /数量为 0|空转账/);
});

/** TransferBatch 里 value=0 同样必须被拒（批量路径不能漏） */
test('matchNftTransfers：erc1155 TransferBatch 里 value=0 的条目必须被拒', async () => {
  const { matchNftTransfers } = await lib();
  const base = { standard: 'erc1155', from: owner.address, to: buyer.address };
  const mix = await make1155Batch(NFT_CONTRACT, owner.address, owner.address, buyer.address, ['11', '12'], ['1', '0']);
  const r = matchNftTransfers([mix], NFT_CONTRACT, { ...base, tokenIds: ['11', '12'] });
  assert.equal(r.ok, false, `批量里含 value=0 的条目不得通过：${JSON.stringify(r)}`);
  assert.match(r.reason, /数量为 0|空转账/);
  /*
    与既有的「任何 tokenId 累计 >1 即拒绝」同一条纪律：批量的每一条都要求**恰一份**，
    不因为"这一枚没被申报"就放过——否则店主可以在一张收据里夹一条 value=0 的空转账，
    让"申报集合 ⊆ 收集集合"的判据被稀释（收集集合被无关条目污染）。
    严格口径的代价是"同一收据里夹带空转账会导致整批拒收"，这是可接受的：
    空转账本来就不是正常交付形态。
  */
  const okOnly = matchNftTransfers([mix], NFT_CONTRACT, { ...base, tokenIds: ['11'] });
  assert.equal(okOnly.ok, false, '整张收据按严格口径判定，不按申报子集放宽');
});

test('matchNftTransfers：erc1155 TransferBatch 批量多枚通过；重复 id / value>1 拒绝', async () => {
  const { matchNftTransfers } = await lib();
  const base = { standard: 'erc1155', from: owner.address, to: buyer.address };
  // ids [1,2] values [1,1]：一个哈希批量转两枚，恰对应 quantity=2 一单
  const batch = await make1155Batch(NFT_CONTRACT, owner.address, owner.address, buyer.address, ['1', '2'], ['1', '1']);
  const ok1 = matchNftTransfers([batch], NFT_CONTRACT, { ...base, tokenIds: ['1', '2'] });
  assert.equal(ok1.ok, true, JSON.stringify(ok1));
  // 批量重复 id（累计 2 份）→ 拒
  const dupId = await make1155Batch(NFT_CONTRACT, owner.address, owner.address, buyer.address, ['1', '1'], ['1', '1']);
  const bad1 = matchNftTransfers([dupId], NFT_CONTRACT, { ...base, tokenIds: ['1'] });
  assert.equal(bad1.ok, false);
  assert.match(bad1.reason, /多份/);
  // value=2 → 拒
  const over = await make1155Batch(NFT_CONTRACT, owner.address, owner.address, buyer.address, ['5'], ['2']);
  const bad2 = matchNftTransfers([over], NFT_CONTRACT, { ...base, tokenIds: ['5'] });
  assert.equal(bad2.ok, false);
  assert.match(bad2.reason, /多份/);
});

test('matchNftTransfers：标准错配（erc721 合约日志按 erc1155 申报）明确拒绝并提示核对标准', async () => {
  const { matchNftTransfers } = await lib();
  const logs = [await make721Log(NFT_CONTRACT, owner.address, buyer.address, '1')];
  const r = matchNftTransfers(logs, NFT_CONTRACT, {
    standard: 'erc1155',
    from: owner.address,
    to: buyer.address,
    tokenIds: ['1'],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /未找到/);
  assert.match(r.reason, /erc1155/, '错误信息应指引核对 NFT 标准');
});

test('matchNftTransfers：无关事件（Foo 等）与申报集合为空被拒', async () => {
  const { matchNftTransfers } = await lib();
  const iface = new (await import('ethers')).Interface(['event Foo()']);
  const foo = iface.encodeEventLog(iface.getEvent('Foo'), []);
  const logs = [{ address: NFT_CONTRACT, ...foo, blockNumber: 1 }];
  const r = matchNftTransfers(logs, NFT_CONTRACT, {
    standard: 'erc721',
    from: owner.address,
    to: buyer.address,
    tokenIds: ['1'],
  });
  assert.equal(r.ok, false, '无匹配转移日志应拒绝');
  assert.match(r.reason, /未找到/);
  const empty = matchNftTransfers([], NFT_CONTRACT, {
    standard: 'erc721',
    from: owner.address,
    to: buyer.address,
    tokenIds: [],
  });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /为空/);
});
