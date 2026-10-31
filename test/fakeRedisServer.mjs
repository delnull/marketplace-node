/**
 * shutdown-process.test.js 用的最小 Redis 协议服务器（RESP2）。
 *
 * 测试起的是**真节点进程**，不能注入假客户端；这里在本地监听一个端口，实现节点启动/
 * 健康检查会用到的最小命令：PING / INCR / PEXPIRE / PTTL / GET / SET / DEL。
 * 生产代码仍连真 Redis，这个文件只在 test/ 里被引用。
 */
import net from 'node:net';

function parse(buf) {
  let i = 0;
  const line = () => {
    const j = buf.indexOf('\r\n', i);
    if (j < 0) return null;
    const v = buf.subarray(i, j).toString();
    i = j + 2;
    return v;
  };
  const value = () => {
    if (i >= buf.length) return null;
    const t = String.fromCharCode(buf[i]);
    if (t === '*' || t === '$' || t === '+' || t === ':' || t === '-') {
      i += 1;
      const l = line();
      if (l === null) return null;
      if (t === '*') {
        const n = Number(l);
        const arr = [];
        for (let k = 0; k < n; k += 1) {
          const v = value();
          if (v === null) return null;
          arr.push(v);
        }
        return arr;
      }
      if (t === '$') {
        const n = Number(l);
        if (n < 0) return null;
        if (i + n + 2 > buf.length) return null;
        const v = buf.subarray(i, i + n).toString();
        i += n + 2;
        return v;
      }
      return l;
    }
    // inline command（测试里不会出现，但别让连接卡死）
    const l = line();
    if (l === null) return null;
    return l.split(/\s+/).filter(Boolean);
  };
  const v = value();
  return v === null ? null : { v, used: i };
}

export async function startFakeRedis() {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const p = parse(buf);
        if (!p) break;
        buf = buf.subarray(p.used);
        const cmd = Array.isArray(p.v) ? p.v : [p.v];
        const name = String(cmd[0] || '').toUpperCase();
        if (name === 'PING') sock.write('+PONG\r\n');
        else if (name === 'INCR') sock.write(':1\r\n');
        else if (name === 'PEXPIRE') sock.write(':1\r\n');
        else if (name === 'PTTL') sock.write(':60000\r\n');
        else if (name === 'GET') sock.write('$-1\r\n');
        else if (name === 'SET') sock.write('+OK\r\n');
        else if (name === 'DEL') sock.write(':1\r\n');
        else if (name === 'CLIENT' || name === 'SELECT' || name === 'AUTH') sock.write('+OK\r\n');
        else sock.write(`-ERR unknown command '${name}'\r\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    url: `redis://127.0.0.1:${port}/0`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
