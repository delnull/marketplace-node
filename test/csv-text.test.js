/**
 * CSV 输出的两条硬约束：
 *   ① 表头与每行**同宽**——CSV 靠位置对齐，错一列不会报错，只会让"订单状态"显示成"数量"；
 *   ② UTF-8 BOM + CRLF（Excel 中文兼容，见 src/csv.js 的文件头）。
 * 这里不碰数据库：只测生成/发送这一段，路由里的列清单由各路由自己的测试覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, sendCsv } from '../src/csv.js';

test('toCsv: UTF-8 BOM + CRLF，逗号/引号/换行按 CSV 规则转义', () => {
  const out = toCsv(['订单号', '状态'], [['A-1', '已结算'], ['A-2', '含,逗号'], ['A-3', '含"引号"']]);
  assert.ok(out.startsWith('\uFEFF'), '必须有 BOM（Excel 打开中文才不乱码）');
  assert.ok(out.includes('\r\n'), '行尾必须是 CRLF');
  assert.ok(out.includes('"含,逗号"'), '含逗号的字段必须加引号');
  assert.ok(out.includes('"含""引号"""'), '字段内的引号必须双写');
});

test('sendCsv: 表头与行宽不一致时拒绝发送（不许产出错位的账表）', () => {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { throw new Error('不应写出'); } };
  assert.throws(() => sendCsv(res, 'x.csv', ['订单号', '状态'], [['A-1']]), /列数不一致/);
});

test('sendCsv: 正常路径写出 CSV，Content-Disposition 带 UTF-8 文件名', () => {
  let body = '';
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { body = b; } };
  sendCsv(res, 'orders.csv', ['订单号', '状态'], [['A-1', '已结算']]);
  assert.match(res.headers['Content-Type'], /text\/csv/);
  assert.match(res.headers['Content-Disposition'], /filename="orders\.csv"/);
  assert.ok(body.startsWith('\uFEFF订单号,状态'));
  assert.ok(body.includes('A-1,已结算'));
});
