#!/usr/bin/env node
/**
 * 一次性迁移：把既有无规格商品补成系统默认规格「规格：默认」。
 *
 * 背景：商品契约已改为 `specs` 恒 ≥1 维。无规格商品不再以 `specs=[]` 落库，
 * 而是 `[{ name:'规格', options:['默认'] }]`；它的唯一组合 `sku_key` 仍是空串，
 * 所以历史订单、库存占位、购物车里的旧 key 不需要改写。
 *
 * 这个脚本只改：
 *   · products.specs（空数组 → 默认规格）
 *   · product_skus.specs_json（{} → {"规格":"默认"}，只改 key='' 的那一行）
 *   · products.snapshot_hash（按读回值重算，与上架/编辑同一实现）
 *
 * 用法：
 *   node --env-file=.env scripts/migrate-default-spec.mjs            # 只检查并打印
 *   node --env-file=.env scripts/migrate-default-spec.mjs --apply    # 写入
 *
 * 幂等：只选 `JSON_LENGTH(specs)=0` 的商品；跑完再跑不会重复改。
 * 预检不通过（不是恰好一个 key='' 的 SKU 行）时整批拒绝，不做半套迁移。
 */
import mysql from 'mysql2/promise';
import config from '../src/config.js';
import { DEFAULT_SPEC, computeSnapshotHash, snapshotObject } from '../src/routes/products.js';

const APPLY = process.argv.includes('--apply');
const DEFAULT_SPEC_JSON = DEFAULT_SPEC.map((s) => ({ name: s.name, options: [...s.options] }));
const DEFAULT_SKU_SPECS = { [DEFAULT_SPEC[0].name]: DEFAULT_SPEC[0].options[0] };

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function dbName() {
  const name = config.db.name;
  if (!name) throw new Error('缺少 MK_DB_NAME（先在节点 .env 配好本节点库名）');
  return name;
}

const conn = await mysql.createConnection({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: dbName(),
  multipleStatements: false,
});

try {
  const rows = await conn.query(
    'SELECT id, slug, specs FROM products WHERE specs IS NULL OR JSON_LENGTH(specs) = 0 ORDER BY id'
  );
  const products = rows[0];
  if (!products.length) {
    log('没有需要迁移的商品（所有商品都已有规格）。');
  } else {
    log(`发现 ${products.length} 个无规格商品，预检 SKU 行…`);
    const plans = [];
    for (const p of products) {
      const [skuRows] = await conn.query('SELECT sku_key FROM product_skus WHERE product_id = ? ORDER BY sku_key', [p.id]);
      if (skuRows.length !== 1 || String(skuRows[0].sku_key ?? '') !== '') {
        throw new Error(
          `商品 ${p.slug}（id=${p.id}）的 SKU 行不是恰好一个 key=''：` +
            JSON.stringify(skuRows.map((s) => s.sku_key))
        );
      }
      plans.push({ id: p.id, slug: p.slug });
    }

    if (!APPLY) {
      log(`预检通过；未写入（加 --apply 执行）。将迁移：${plans.map((p) => p.slug).join(', ')}`);
    } else {
      for (const plan of plans) {
        await conn.beginTransaction();
        try {
          await conn.query('UPDATE products SET specs = ? WHERE id = ?', [JSON.stringify(DEFAULT_SPEC_JSON), plan.id]);
          await conn.query(
            'UPDATE product_skus SET specs_json = ? WHERE product_id = ? AND sku_key = ?',
            [JSON.stringify(DEFAULT_SKU_SPECS), plan.id, '']
          );
          const [[product]] = await conn.query('SELECT * FROM products WHERE id = ?', [plan.id]);
          const [skus] = await conn.query('SELECT * FROM product_skus WHERE product_id = ? ORDER BY sku_key', [plan.id]);
          const hash = computeSnapshotHash(snapshotObject({ ...product, skus }));
          await conn.query('UPDATE products SET snapshot_hash = ? WHERE id = ?', [hash, plan.id]);
          await conn.commit();
          log(`已迁移 ${plan.slug} → snapshot=${hash}`);
        } catch (e) {
          await conn.rollback();
          throw e;
        }
      }
      log(`完成：${plans.length} 个商品已补默认规格。`);
    }
  }
} finally {
  await conn.end();
}
