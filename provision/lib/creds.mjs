/**
 * 凭据装载 —— **唯一读云凭据的地方**。
 *
 * 三条纪律（都是踩过才知道疼的）：
 *   1. **只从环境变量读**：命令行参数会进 shell 历史与 `ps` 输出，文件会留在磁盘上，
 *      而这个脚本要"给用户一把 key 就能跑"——所以 key 只经环境变量进来。
 *   2. **绝不打印**：连前几位都不打（`AKIA…ABCD` 这种"只露头尾"的做法对 16 位 key 来说
 *      已经露了四分之一）。要给用户确认"读到了没"，只报"读了哪两个变量名"。
 *   3. **缺什么就点名说缺什么**：三家要的变量名各不相同，"密钥无效"与"变量没设"是两件事，
 *      混成一句话会让人去控制台白折腾一圈。
 */
import { CloudError } from './errors.mjs';
import { credentialError } from './credentialHelp.mjs';

const NEEDED = {
  aliyun: [
    ['ALIYUN_ACCESS_KEY_ID', 'accessKeyId'],
    ['ALIYUN_ACCESS_KEY_SECRET', 'accessKeySecret'],
  ],
  tencent: [
    ['TENCENTCLOUD_SECRET_ID', 'secretId'],
    ['TENCENTCLOUD_SECRET_KEY', 'secretKey'],
  ],
  aws: [
    ['AWS_ACCESS_KEY_ID', 'accessKeyId'],
    ['AWS_SECRET_ACCESS_KEY', 'accessKeySecret'],
  ],
};

/**
 * @param {string} provider
 * @returns {Promise<object>} 给各适配器工厂用的凭据对象
 */
export async function ensureCreds(provider) {
  const needed = NEEDED[provider];
  if (!needed) throw new CloudError('invalid', `未知的 provider：${provider}`);

  const creds = {};
  const missing = [];
  for (const [env, key] of needed) {
    const v = process.env[env];
    if (v && v.trim()) creds[key] = v.trim();
    else missing.push(env);
  }
  /*
    缺凭据时抛的那条错误**就是说明书**（见 credentialHelp.mjs）：
    用户在终端上就能看到"去哪个控制台、开哪些权限、填哪两个变量"，
    不必离开终端去翻文档 —— 这是"拿不到 key 就一切白搭"的正面解法。
    （AWS 也没有"读 ~/.aws/credentials"这条路：本适配器用裸 HTTP 签名，读不了 profile，
    所以这里就明确要环境变量，而不是假装支持 profile。）
  */
  if (missing.length) throw credentialError(provider, missing);
  creds.token = process.env.TENCENTCLOUD_TOKEN || process.env.AWS_SESSION_TOKEN || undefined;
  return creds;
}

/** 给 --help / providers 用：不变量的凭据要求（不含任何值） */
export function credsSummary(provider) {
  return NEEDED[provider]?.map(([env]) => env).join(' + ') ?? '(未知)';
}
