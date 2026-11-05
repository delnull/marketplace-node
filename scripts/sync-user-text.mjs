#!/usr/bin/env node
/**
 * 把前端唯一词表（`frontend/src/utils/userText.zh.json`）同步成节点运行时副本。
 *
 * 为什么不是运行时直接 import：节点镜像是 `docker build (context = node/)`，镜像里没有
 * `../frontend`。所以数据必须落在 `node/src/` 内；但**唯一来源仍是前端那份**——
 * 这里只做复制，`test/user-text.test.js` 会对拍，副本过期就红。
 *
 * 用法（改完前端词表后）：cd node && npm run sync:user-text
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../frontend/src/utils/userText.zh.json');
const OUT = path.resolve(HERE, '../src/userText.zh.json');

const raw = readFileSync(SRC, 'utf8');
JSON.parse(raw); // 源文件必须是合法 JSON：坏数据不许进镜像
writeFileSync(OUT, raw, 'utf8');
console.log(`已同步 ${path.relative(process.cwd(), OUT)}（来源 ${path.relative(process.cwd(), SRC)}）`);
