/**
 * 节点编号（nodeCode）：`node/src/nodeCode.js` 的判据。
 *
 * 这是**离链 URL 的身份层**：合约只存 30 bit `nodeId`，8 位码必须能无损编码/解码它，
 * 而且抄错一位不能落到"另一个真实节点"上。所以这里不止钉固定向量：
 * 单字符错（8 个位置 × 31 种替换）与数据位换位（15 对）是**逐项穷举**的判据，
 * 它们必须是一条会红的测试，而不是注释里的一句话。
 *
 * 校验算法与店铺编号同源（`node/src/codec.js`）；本文件顺带断言"两位校验 = S>>5 / S&31"，
 * 把"不取模"钉在节点编号这一侧。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_CODE_ALPHABET,
  NODE_CODE_CHECK_LEN,
  NODE_CODE_DATA_LEN,
  NODE_CODE_LEN,
  encodeNodeCodeFromData,
  encodeNodeCodeFromId,
  isNodeCodeShape,
  nodeIdOfCode,
  verifyNodeCode,
} from '../src/nodeCode.js';
import { encodeShopCodeFromData } from '../src/shopCode.js';

/** 整串只含 Crockford 字母表（无 I/L/O/U）且恰好 8 位 */
const CROCKFORD_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const ID_MAX = (1n << 30n) - 1n;

/** 独立重算：S = Σ 值×位权(1..n)，两位校验 = ALPHABET[S>>5] + ALPHABET[S&31]（不取模） */
function expectedCheck(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    sum += NODE_CODE_ALPHABET.indexOf(data[i]) * (i + 1);
  }
  return { sum, check: NODE_CODE_ALPHABET[sum >> 5] + NODE_CODE_ALPHABET[sum & 31] };
}

test('形状常量：8 位 = 6 数据 + 2 校验，字母表是 Crockford', () => {
  assert.equal(NODE_CODE_DATA_LEN, 6);
  assert.equal(NODE_CODE_CHECK_LEN, 2);
  assert.equal(NODE_CODE_LEN, 8);
  assert.equal(NODE_CODE_ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  assert.equal(NODE_CODE_ALPHABET.length, 32);
});

test('生成结果：恰好 8 位、纯 Crockford，不含 -._~, 与 I/L/O/U', () => {
  const ids = [];
  for (let i = 0; i <= 512; i += 1) ids.push(BigInt(i));
  for (let i = 0; i < 64; i += 1) ids.push((BigInt(i) * 2654435761n + 1234567n) & ID_MAX);
  ids.push(ID_MAX, ID_MAX - 1n, ID_MAX - 32n);
  for (const id of ids) {
    const code = encodeNodeCodeFromId(id);
    assert.equal(code.length, NODE_CODE_LEN, `${id} → ${code} 长度不对`);
    assert.match(code, CROCKFORD_CODE, `${id} → ${code} 含字母表外字符`);
    for (const ch of '-._~,ILOU') {
      assert.equal(code.includes(ch), false, `${id} → ${code} 含特殊符号或易混字符 ${ch}`);
    }
    assert.equal(verifyNodeCode(code), code, `生成结果 ${code} 过不了自己的校验`);
  }
});

test('固定向量：已知 id → 已知码，两位校验 = S>>5 / S&31（不取模）', () => {
  const cases = [
    [0n, '00000000'], // S=0 → "00"
    [1n, '00000106'], // S=1×6=6 → "06"
    [31n, '00000Z5T'], // S=31×6=186 → 5<<5|26
    [32n, '00001005'], // 2^5 落在倒数第二个数据字符 → S=1×5=5 → "05"
    [2n ** 29n, 'G000000G'], // 30 bit 大端：最高位落在第一个数据字符
    [ID_MAX, 'ZZZZZZMB'], // S=31×21=651 → 20<<5|11
  ];
  for (const [id, code] of cases) {
    assert.equal(encodeNodeCodeFromId(id), code, `id=${id} 的固定码变了`);
    const data = code.slice(0, NODE_CODE_DATA_LEN);
    const { sum, check } = expectedCheck(data);
    assert.ok(sum < 1024, `S=${sum} 应当装得进两位 base32`);
    assert.equal(code.slice(-NODE_CODE_CHECK_LEN), check, `id=${id} 的校验位不是 S>>5 / S&31`);
    assert.equal(code, data + NODE_CODE_ALPHABET[sum >> 5] + NODE_CODE_ALPHABET[sum & 31]);
    assert.equal(nodeIdOfCode(code), String(id));
  }

  // 6 位数据的上界：S=651 > 32 ⇒ 若取模/只写一位就会退化成 "B"，两位原样写才是 "MB"
  assert.equal(expectedCheck('ZZZZZZ').sum, 651);
  assert.equal(expectedCheck('ZZZZZZ').check, 'MB');
  assert.equal(encodeNodeCodeFromData('ZZZZZZ'), 'ZZZZZZMB');

  // 30 bit 大端：id=1 只影响最后一位；2^29 只影响第一位
  assert.equal(encodeNodeCodeFromId(1n).slice(0, NODE_CODE_DATA_LEN), '000001');
  assert.equal(encodeNodeCodeFromId(2n ** 29n).slice(0, NODE_CODE_DATA_LEN), 'G00000');
});

test('往返：id = 0, 1, 31, 32, 2^30-1（bigint / number / 十进制字符串入参同解）', () => {
  for (const id of [0n, 1n, 31n, 32n, ID_MAX]) {
    const fromBigint = encodeNodeCodeFromId(id);
    assert.equal(encodeNodeCodeFromId(Number(id)), fromBigint, `number 入参与 bigint 不一致：${id}`);
    assert.equal(encodeNodeCodeFromId(String(id)), fromBigint, `十进制字符串入参与 bigint 不一致：${id}`);
    assert.equal(nodeIdOfCode(fromBigint), String(id), `往返改变了身份：${id}`);
    assert.doesNotMatch(nodeIdOfCode(fromBigint), /^0\d/, '解码结果必须是十进制规范形，不带前导零');
  }
  // 更宽的往返：0..2048 每个 id 都能无损还原
  for (let id = 0n; id <= 2048n; id += 1n) {
    assert.equal(nodeIdOfCode(encodeNodeCodeFromId(id)), id.toString(), `id=${id} 往返失败`);
  }
});

test('encodeNodeCodeFromData：6 位数据 + 校验；长度/字符不对抛错', () => {
  assert.equal(encodeNodeCodeFromData('000001'), '00000106');
  assert.equal(encodeNodeCodeFromData('zzzzzz'), 'ZZZZZZMB', '数据位先归一化（trim + 大写）');
  assert.throws(() => encodeNodeCodeFromData('00000'), /6 位/);
  assert.throws(() => encodeNodeCodeFromData('0000010'), /6 位/);
  assert.throws(() => encodeNodeCodeFromData('00000-'), /非法数据字符/);
});

test('非法输入：长度、字母表外字符、错校验 → null（不抛错）', () => {
  const badShape = [
    '0000010', // 少一位
    '000001060', // 多一位
    '',
    '   ',
    '0000010O',
    '0000010I',
    '0000010L',
    '0000010U', // 不在字母表
    '0000010-',
    '00000106.',
    '00000106_',
    '00000106~',
    '00000106,', // 特殊符号
    '0000010 6', // 中间空白
  ];
  for (const v of badShape) {
    assert.equal(verifyNodeCode(v), null, `应拒：${JSON.stringify(v)}`);
    assert.equal(isNodeCodeShape(v), false, `形状应拒：${JSON.stringify(v)}`);
    assert.equal(nodeIdOfCode(v), null);
  }

  const badCheck = ['00000100', '00000107', 'ZZZZZZ00', 'ZZZZZZ0B'];
  for (const v of badCheck) {
    assert.equal(verifyNodeCode(v), null, `校验位错应拒：${v}`);
    assert.equal(isNodeCodeShape(v), true, `形状合法（只有校验位错）：${v}`);
    assert.equal(nodeIdOfCode(v), null);
  }

  // 小写/首尾空白是"抄写差异"，归一化后仍是同一个码
  assert.equal(verifyNodeCode(' 00000z5t '), '00000Z5T');
  assert.equal(verifyNodeCode('zzzzzzmb'), 'ZZZZZZMB');
  assert.equal(nodeIdOfCode('  zzzzzzmb  '), String(ID_MAX));
  assert.equal(nodeIdOfCode('00000z5t'), '31');

  // 非字符串：形状失败一律 null，不抛错（也不从对象/数组里"读出"编号）
  for (const bad of [null, undefined, 0, 1, 12345678, 1n, true, false, [], {}, ['00000106'], ['0', '0'], Symbol('00000106')]) {
    assert.equal(verifyNodeCode(bad), null);
    assert.equal(isNodeCodeShape(bad), false);
    assert.equal(nodeIdOfCode(bad), null);
  }
});

test('单字符错：8 个位置 × 31 种替换，全部被拒', () => {
  const bases = [0n, 1n, 31n, 32n, 1117317n, ID_MAX].map((id) => encodeNodeCodeFromId(id));
  for (const base of bases) {
    for (let pos = 0; pos < NODE_CODE_LEN; pos += 1) {
      for (const ch of NODE_CODE_ALPHABET) {
        if (ch === base[pos]) continue;
        const broken = base.slice(0, pos) + ch + base.slice(pos + 1);
        assert.equal(verifyNodeCode(broken), null, `第 ${pos + 1} 位改成 ${ch} 应被拒：${broken}`);
      }
    }
  }
});

test('数据位换位：任意两对（含相邻）换位全部被拒；校验位互换也被拒', () => {
  const base = encodeNodeCodeFromId(1117317n); // 数据位 "012345"（互不相同）
  assert.equal(base.slice(0, NODE_CODE_DATA_LEN), '012345');
  for (let i = 0; i < NODE_CODE_DATA_LEN; i += 1) {
    for (let j = i + 1; j < NODE_CODE_DATA_LEN; j += 1) {
      const data = [...base.slice(0, NODE_CODE_DATA_LEN)];
      [data[i], data[j]] = [data[j], data[i]];
      const broken = data.join('') + base.slice(NODE_CODE_DATA_LEN);
      assert.equal(verifyNodeCode(broken), null, `数据位第 ${i + 1}/${j + 1} 位互换应被拒：${broken}`);
    }
  }

  // 校验位互换：'00000106' → '00000160'
  assert.equal(verifyNodeCode('00000160'), null);
  // 两位校验位本来就相同时（S=0 → "00"），互换不改变编号
  const same = encodeNodeCodeFromId(0n);
  assert.equal(same, '00000000');
  assert.equal(verifyNodeCode(same), same);
});

test('边界：id 越界抛 RangeError；verify 对越界/非法串只返回 null，不抛错', () => {
  for (const bad of [-1, 2 ** 30, 2 ** 30 + 1]) {
    assert.throws(() => encodeNodeCodeFromId(bad), RangeError, `number ${bad} 应抛 RangeError`);
    assert.throws(() => encodeNodeCodeFromId(BigInt(bad)), RangeError, `bigint ${bad} 应抛 RangeError`);
    assert.throws(() => encodeNodeCodeFromId(String(bad)), RangeError, `字符串 ${bad} 应抛 RangeError`);
  }
  assert.throws(() => encodeNodeCodeFromId(ID_MAX + 1n), RangeError);
  assert.throws(() => encodeNodeCodeFromId(ID_MAX + 2n), RangeError);

  // 非数值/非十进制写法：TypeError（不猜一个 id 出来）；非整数 number 由 BigInt 转换抛 RangeError
  for (const bad of ['0x10', 'abc', '', '  ', '1.5', '1e3', null, undefined, true, {}, []]) {
    assert.throws(() => encodeNodeCodeFromId(bad), TypeError, `"${String(bad)}" 不是十进制整数`);
  }
  for (const bad of [1.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => encodeNodeCodeFromId(bad), RangeError, `${bad} 不是整数`);
  }

  // 读入口：越界数字、超长串、非字符串 → null，不抛错
  for (const bad of [null, undefined, 2 ** 30, -1, '1073741824', '999999999999999999999', 'ZZZZZZZZ', '000000000', 2n ** 30n]) {
    assert.equal(verifyNodeCode(bad), null);
    assert.equal(nodeIdOfCode(bad), null);
  }
  assert.equal(nodeIdOfCode('ZZZZZZMB'), String(ID_MAX));
});

test('校验位与店铺编号同源：同一加权和 → 同一校验对', () => {
  // 店铺编号是 7 位数据：末尾补 0（位权 7 × 0）不改变 S，所以校验对必须与 6 位数据完全一致
  for (const data of ['000001', '00000Z', 'ZZZZZZ', '012345']) {
    const nodeCheck = encodeNodeCodeFromData(data).slice(-NODE_CODE_CHECK_LEN);
    const shopCheck = encodeShopCodeFromData(`${data}0`).slice(-2);
    assert.equal(nodeCheck, shopCheck, `数据位 ${data} 的校验对在两种格式下必须同源`);
  }
});
