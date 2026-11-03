/**
 * 适配器装载 —— 每个文件导出 `create<Name>(creds)`，这里给它们同一张脸。
 *
 * 为什么用动态 import 而不是顶部静态 import 三家：**用户只会用其中一家**。
 * 顶部全量导入意味着跑阿里云的人也要把 AWS 的签名实现加载进来（无害但没必要），
 * 更重要的是：某一家的文件语法错掉时，不该让另外两家的 `check` 也跑不起来。
 */
import { CloudError, KIND } from '../lib/errors.mjs';
import { credsSummary } from '../lib/creds.mjs';
import { PROVIDER_IDS } from '../lib/provider.mjs';

/** 名字 → 文件（唯一映射处；加一家只改这里一行 + 一个新文件） */
const FILES = {
  aliyun: { file: 'aliyun.mjs', factory: 'createAliyun' },
  tencent: { file: 'tencent.mjs', factory: 'createTencent' },
  aws: { file: 'aws.mjs', factory: 'createAws' },
};

export async function loadProvider(id, creds) {
  const spec = FILES[id];
  if (!spec) throw new CloudError('invalid', `未知的 provider：${id}（可用：${PROVIDER_IDS.join(', ')}）`);
  const mod = await import(`./${spec.file}`);
  const factory = mod[spec.factory];
  if (typeof factory !== 'function') {
    throw new CloudError(KIND.UNKNOWN, `适配器 ${spec.file} 里没有导出 ${spec.factory}() —— 文件被改坏了`);
  }
  return factory(creds);
}

/** 不联网的能力清单：describe() 只描述"这家能做什么、要什么凭据、有哪些坑" */
export async function describeAll() {
  const out = [];
  for (const id of PROVIDER_IDS) {
    const spec = FILES[id];
    try {
      const mod = await import(`./${spec.file}`);
      out.push({ ...mod[spec.factory](dummyCreds()).describe(), credentials: credsSummary(id) });
    } catch (e) {
      out.push({ id, error: `${e?.message ?? e}` });
    }
  }
  return out;
}

/** describe() 不碰网络，随便给值即可；这里刻意用一眼看得出是假的串，避免被当成真凭据打印出去 */
function dummyCreds() {
  const v = '(describe-only)';
  return { accessKeyId: v, accessKeySecret: v, secretId: v, secretKey: v };
}
