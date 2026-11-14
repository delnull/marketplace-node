/**
 * 店铺编号：**生产生成器**（node/src/ids.js 的 newShopCode）与**同一目录的校验实现**
 * （node/src/shopCode.js）必须对得上。
 *
 * 这里不只钉几个固定向量：`单字符错与任意换位必然被检出` 是**逐项验证**的判据
 * （单错覆盖 9 个位置 × 31 种替换；换位覆盖全部 21 对数据位 × 32×31 种取值），
 * 它必须是一条会红的测试，而不是注释里的一句话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newShopCode } from '../src/ids.js';

const {
  SHOP_CODE_ALPHABET,
  SHOP_CODE_CHECK_LEN,
  SHOP_CODE_DATA_LEN,
  SHOP_CODE_LEN,
  codeCharValue,
  encodeShopCodeFromData,
  isShopCodeShape,
  verifyShopCode,
} = await import('../src/shopCode.js');

test('形状常量：9 位 = 7 数据 + 2 校验', () => {
  assert.equal(SHOP_CODE_DATA_LEN, 7);
  assert.equal(SHOP_CODE_CHECK_LEN, 2);
  assert.equal(SHOP_CODE_LEN, 9);
  assert.equal(SHOP_CODE_ALPHABET.length, 32);
});

test('固定数据位 → 固定编号（加权和写成两位 base32，不取模）', () => {
  assert.equal(encodeShopCodeFromData('0000001'), '000000107'); // 1×7 = 7 → "07"
  assert.equal(encodeShopCodeFromData('0000TES'), '0000TESC5'); // 389 → "C5"（测试夹具的口径）
  assert.equal(encodeShopCodeFromData('ZZZZZZZ'), 'ZZZZZZZV4'); // 31×28 = 868 → "V4"
  for (const ok of ['000000107', '0000TESC5', 'ZZZZZZZV4']) {
    assert.equal(verifyShopCode(ok), ok);
    assert.equal(verifyShopCode(ok.toLowerCase()), ok, '大小写不敏感，归一化为大写');
  }
});

test('形状：9 位、只有 Crockford 字母表', () => {
  assert.equal(isShopCodeShape('000000107'), true);
  assert.equal(isShopCodeShape('00000010'), false, '少一位');
  assert.equal(isShopCodeShape('0000001071'), false, '多一位');
  assert.equal(isShopCodeShape('00000010-'), false, '带标点的串不是编号');
  assert.equal(verifyShopCode('00000010-'), null, '带标点的串不是编号，返回 null 而不是抛错');
  assert.equal(isShopCodeShape('0000001O7'), false, 'I/L/O/U 不在字母表里');
  assert.equal(encodeShopCodeFromData('0000001'), '000000107', '合法数据位总能编码');
  assert.throws(() => encodeShopCodeFromData('00000010'), /7 位/);
  assert.throws(() => encodeShopCodeFromData('000000-'), /非法数据字符/);
});

test('非法输入（含非字符串）一律返回 null，不抛错，也不从对象/数组里"读出"编号', () => {
  for (const bad of [null, undefined, 0, 123456789, true, [], {}, ['0', '0', '0']]) {
    assert.equal(verifyShopCode(bad), null);
    assert.equal(isShopCodeShape(bad), false);
  }
  assert.equal(codeCharValue(''), -1, '空串不能查表成 0');
  assert.equal(codeCharValue('AB'), -1);
  assert.equal(codeCharValue('A'), 10);
});

test('格式穷举：S = 0..868 的每个可达校验值都写成 base32 高/低两位', () => {
  const seen = new Set();
  for (let sum = 0; sum <= 868; sum += 1) {
    const data = dataForSum(sum);
    const code = encodeShopCodeFromData(data);
    const expect = data + SHOP_CODE_ALPHABET[sum >> 5] + SHOP_CODE_ALPHABET[sum & 31];
    assert.equal(code, expect, `S=${sum} 的校验位不对`);
    assert.equal(verifyShopCode(code), code, `S=${sum} 的编号过不了自己的校验`);
    seen.add(code.slice(-2));
  }
  assert.equal(seen.size, 869, '869 个可达校验值必须对应 869 个不同的校验对');
});

/** S（0..868）→ 一个加权和恰好等于它的 7 位数据（权重 7..1 贪心，构造必然成功） */
function dataForSum(sum) {
  const digits = Array(SHOP_CODE_DATA_LEN).fill(0);
  let rest = sum;
  for (let i = SHOP_CODE_DATA_LEN - 1; i >= 0; i -= 1) {
    const weight = i + 1;
    const d = Math.min(31, Math.floor(rest / weight));
    digits[i] = d;
    rest -= d * weight;
  }
  assert.equal(rest, 0, `S=${sum} 构造不出数据位`);
  return digits.map((n) => SHOP_CODE_ALPHABET[n]).join('');
}

test('单字符错：9 个位置 × 31 种替换，全部被拒', () => {
  const bases = ['0000001', '0000TES', '0123456'].map((d) => encodeShopCodeFromData(d));
  for (const base of bases) {
    for (let pos = 0; pos < SHOP_CODE_LEN; pos += 1) {
      for (const ch of SHOP_CODE_ALPHABET) {
        if (ch === base[pos]) continue;
        const broken = base.slice(0, pos) + ch + base.slice(pos + 1);
        assert.equal(verifyShopCode(broken), null, `第 ${pos + 1} 位改成 ${ch} 应被拒：${broken}`);
      }
    }
  }
});

test('数据位换位：21 对位置 × 32×31 种取值，全部被拒', () => {
  for (let i = 0; i < SHOP_CODE_DATA_LEN; i += 1) {
    for (let j = i + 1; j < SHOP_CODE_DATA_LEN; j += 1) {
      for (const a of SHOP_CODE_ALPHABET) {
        for (const b of SHOP_CODE_ALPHABET) {
          if (a === b) continue;
          const data = Array(SHOP_CODE_DATA_LEN).fill('0');
          data[i] = a;
          data[j] = b;
          const code = encodeShopCodeFromData(data.join(''));
          [data[i], data[j]] = [data[j], data[i]];
          const broken = data.join('') + code.slice(SHOP_CODE_DATA_LEN);
          assert.equal(verifyShopCode(broken), null, `第 ${i + 1}/${j + 1} 位互换应被拒：${broken}`);
        }
      }
    }
  }
});

test('两位校验位互换也被拒（除非两位本来就相同）', () => {
  assert.equal(verifyShopCode('000000170'), null, '校验位 07 → 70');
  const same = encodeShopCodeFromData('0000000'); // 校验值 0 → "00"
  assert.equal(same, '000000000');
  assert.equal(verifyShopCode(same), same);
});

test('newShopCode：形状稳定、不重复（格式正确性由上面的穷举与固定向量钉住，这里不重复论证）', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const code = newShopCode();
    assert.equal(code.length, SHOP_CODE_LEN);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{9}$/);
    assert.equal(verifyShopCode(code), code, `生产编号 ${code} 过不了共享校验`);
    assert.equal(seen.has(code), false, `重复编号 ${code}`);
    seen.add(code);
  }
});
