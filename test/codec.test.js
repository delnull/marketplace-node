/**
 * 共享编解码内核（`node/src/codec.js`）：**加权和校验算法唯一实现**的判据。
 *
 * 店铺编号（7 位数据）与节点编号（6 位数据）都只是这个内核上的两个格式常量，所以
 * "两位 base32 = 加权和 S 的原样写法（不取模）"必须在这里直接钉住；格式级契约分别见
 * `test/shopCode.test.js`、`test/nodeCode.test.js`。
 *
 * 另一条判据是**错误分界**：读入口（`verifyCode` / `isCodeShape`）对输入形状失败只返回
 * null / false，不抛错；`dataLen` 是格式模块的常量，传错是编程错误，当场抛 TypeError。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHABET,
  CHECK_LEN,
  checkChars,
  codeCharValue,
  encodeFromData,
  isCodeShape,
  normalize,
  verifyCode,
} from '../src/codec.js';

/** S → 一个加权和恰好等于它的 `len` 位数据（权重 len..1 贪心，构造必然成功） */
function dataForSum(sum, len) {
  const digits = Array(len).fill(0);
  let rest = sum;
  for (let i = len - 1; i >= 0; i -= 1) {
    const weight = i + 1;
    const d = Math.min(31, Math.floor(rest / weight));
    digits[i] = d;
    rest -= d * weight;
  }
  assert.equal(rest, 0, `S=${sum} 构造不出 ${len} 位数据`);
  return digits.map((n) => ALPHABET[n]).join('');
}

test('字母表：32 个 Crockford 符号，无 I/L/O/U', () => {
  assert.equal(ALPHABET, '0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  assert.equal(ALPHABET.length, 32);
  for (const ch of 'ILOU') assert.equal(ALPHABET.includes(ch), false, `字母表不该有 ${ch}`);
  assert.equal(CHECK_LEN, 2);
});

test('codeCharValue：单字符查表；空串/多字符/字母表外/非字符串一律 -1', () => {
  assert.equal(codeCharValue('0'), 0);
  assert.equal(codeCharValue('9'), 9);
  assert.equal(codeCharValue('A'), 10);
  assert.equal(codeCharValue('Z'), 31);
  assert.equal(codeCharValue('I'), -1);
  assert.equal(codeCharValue('L'), -1);
  assert.equal(codeCharValue('O'), -1);
  assert.equal(codeCharValue('U'), -1);
  assert.equal(codeCharValue('a'), -1, '查表只认大写（归一化在 normalize）');
  assert.equal(codeCharValue(''), -1);
  assert.equal(codeCharValue('AB'), -1);
  assert.equal(codeCharValue(0), -1);
  assert.equal(codeCharValue(null), -1);
});

test('normalize：只认字符串（trim + 大写）；非字符串返回空串', () => {
  assert.equal(normalize(' 0000tes '), '0000TES');
  assert.equal(normalize(''), '');
  assert.equal(normalize('   '), '');
  for (const bad of [null, undefined, 0, 1n, true, [], {}, ['0000TES'], Symbol('0')]) {
    assert.equal(normalize(bad), '', `${String(bad)} 不是字符串`);
  }
});

test('checkChars：S = Σ 值×位权(1..n) 原样写成两位 base32（不取模）', () => {
  assert.equal(checkChars('0000001'), '07'); // 1×7 = 7
  assert.equal(checkChars('0000TES'), 'C5'); // 26×5 + 14×6 + 25×7 = 389
  assert.equal(checkChars('ZZZZZZ'), 'MB'); // 31×21 = 651（取模就会只剩低位 "B"）
  assert.equal(checkChars('ZZZZZZZ'), 'V4'); // 31×28 = 868

  // 6 位数据与 7 位数据的每个可达 S 都必须原样映射到两位 base32（0..868 穷举）
  for (let sum = 0; sum <= 651; sum += 1) {
    assert.equal(checkChars(dataForSum(sum, 6)), ALPHABET[sum >> 5] + ALPHABET[sum & 31], `S=${sum}（6 位）`);
  }
  const seen = new Set();
  for (let sum = 0; sum <= 868; sum += 1) {
    const chars = checkChars(dataForSum(sum, 7));
    assert.equal(chars, ALPHABET[sum >> 5] + ALPHABET[sum & 31], `S=${sum}（7 位）`);
    seen.add(chars);
  }
  assert.equal(seen.size, 869, '869 个可达校验值必须对应 869 个不同的校验对');
});

test('checkChars / encodeFromData：S ≥ 1024 抛错，不静默取模', () => {
  // 8 位全 Z：31×(1+…+8) = 31×36 = 1116 ⇒ 两位（1024）装不下
  assert.equal(ALPHABET.indexOf('Z'), 31);
  assert.throws(() => checkChars('ZZZZZZZZ'), /1024/);
  assert.throws(() => encodeFromData('ZZZZZZZZ'), /1024/);

  // 非法数据字符（含小写/标点/I/L/O/U）：checkChars 只接受已归一化数据位
  for (const bad of ['00000-', '00000O', '00000I', '00000L', '00000U', '0000tes']) {
    assert.throws(() => checkChars(bad), /非法数据字符/, `应拒：${bad}`);
  }
  assert.throws(() => checkChars(123), TypeError);
  assert.throws(() => checkChars(null), TypeError);
});

test('encodeFromData：长度由 data.length 决定（格式模块钉死 6 / 7 位）；先归一化', () => {
  assert.equal(encodeFromData('0000001'), '000000107'); // 7 位数据（店铺格式）
  assert.equal(encodeFromData('000001'), '00000106'); // 6 位数据（节点格式）
  assert.equal(encodeFromData(' 0000tes '), '0000TESC5', 'trim + 大写后再编码');
  assert.throws(() => encodeFromData(''), /不能为空/);
  assert.throws(() => encodeFromData(null), /不能为空/);
});

test('isCodeShape / verifyCode：形状只判长度+字符集，verify 再判校验位', () => {
  // 合法：7 位数据（店铺）与 6 位数据（节点）
  assert.equal(isCodeShape('000000107', 7), true);
  assert.equal(verifyCode('000000107', 7), '000000107');
  assert.equal(verifyCode('00000106', 6), '00000106');
  assert.equal(verifyCode('0000tesc5', 7), '0000TESC5', '大小写不敏感，返回规范大写');
  assert.equal(verifyCode(' 0000TESC5 ', 7), '0000TESC5', '首尾空白归一化');

  // 形状合法、校验位错
  assert.equal(isCodeShape('000000110', 7), true);
  assert.equal(verifyCode('000000110', 7), null);
  assert.equal(isCodeShape('00000109', 6), true);
  assert.equal(verifyCode('00000109', 6), null);

  // 形状失败：长度 / 字母表外字符 → null / false，不抛错
  for (const bad of ['00000010', '0000001071', '00000010-', '0000001O7', '', '   ']) {
    assert.equal(isCodeShape(bad, 7), false, `形状应拒：${bad}`);
    assert.equal(verifyCode(bad, 7), null, `应拒：${bad}`);
  }
  assert.equal(isCodeShape('0000010', 6), false);
  assert.equal(verifyCode('0000010', 6), null);

  // 非字符串：形状失败，不抛错
  for (const bad of [null, undefined, 0, 1n, true, [], {}, ['000000107']]) {
    assert.equal(isCodeShape(bad, 7), false);
    assert.equal(verifyCode(bad, 7), null);
  }

  // dataLen 是格式常量：传错是编程错误，当场抛 TypeError（与输入形状无关）
  for (const dataLen of [0, -1, 8, 1.5, '7', null]) {
    assert.throws(() => verifyCode('000000107', dataLen), TypeError, `dataLen=${String(dataLen)}`);
    assert.throws(() => isCodeShape('000000107', dataLen), TypeError, `dataLen=${String(dataLen)}`);
  }
});
