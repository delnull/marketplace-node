/**
 * 极小的 XML 解析器 —— **只为 EC2 的 Query 协议响应存在**。
 *
 * 为什么不能像平时那样用正则取字段：EC2 的响应是**同名嵌套**的
 * （`<item><instanceState><name>running</name></instanceState></item>`），
 * `<name>` 在 `<imageState>`/`<instanceState>`/`<groupSet>` 里都出现，
 * 正则只能取"第一个匹配" —— 而第一个匹配的往往不是你要的那一个。
 * 那种错不会报错，只会**静默取到别的字段的值**（本仓最忌讳的形状）。
 *
 * 所以这里写一个 30 行的标签栈解析器：只支持元素、属性、文本，不支持 DTD/命名空间/实体表
 * （EC2 的响应里没有这些）。够用，且没有依赖。
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name] ?? m;
  });
}

/**
 * 解析成 `{ name, attrs, children, text }` 的树（返回根元素）。
 * 自闭合标签（`<a/>`）按"无子节点、无文本"处理。
 */
export function parseXml(input) {
  const xml = String(input ?? '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(xml))) {
    const text = xml.slice(last, m.index);
    if (text.trim()) stack[stack.length - 1].text += decode(text);
    last = tagRe.lastIndex;
    if (m[5] !== undefined) {
      // CDATA：原样进文本
      stack[stack.length - 1].text += m[5];
      continue;
    }
    if (!m[2]) continue; // 注释 / 声明：跳过
    const closing = m[1] === '/';
    const name = m[2];
    if (closing) {
      // 出栈到匹配的那个（容错：不匹配就忽略这个闭合标签）
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node = { name, attrs: {}, children: [], text: '' };
    for (const a of (m[3] ?? '').matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) node.attrs[a[1]] = decode(a[2]);
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node); // 非自闭合才入栈
  }
  return root.children[0] ?? root;
}

/** 深度优先找**第一个**该名字的元素 */
export function find(node, name) {
  if (!node) return null;
  if (node.name === name) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return null;
}

/** 找**所有**该名字的元素（用于 `item`/`Name` 这类重复元素） */
export function findAll(node, name, out = []) {
  if (!node) return out;
  if (node.name === name) out.push(node);
  for (const c of node.children ?? []) findAll(c, name, out);
  return out;
}

/**
 * 取"这个名字的**直接子元素**的文本"。
 * 与 `find()` 的区别是只往下一层：EC2 里 `<item><instanceState><name>` 的
 * "直接子元素 name" 才是状态，而 `find()` 可能先撞上别的分支里的 name。
 */
export function child(node, name) {
  return (node?.children ?? []).find((c) => c.name === name) ?? null;
}
export function childText(node, name) {
  return child(node, name)?.text?.trim() ?? null;
}

/**
 * 按**路径**逐层取（`path(node, ['Errors','Error','Code'])`）。
 * 为什么需要它：EC2 的错误响应是 `<Response><Errors><Error><Code>` 三层，
 * 而 `find()` 是深度优先"撞到谁算谁"——在多层同名结构里它会取到别的分支。
 * 判据要能表达"我要的正是这一层"，所以给一个显式路径的取法。
 */
export function pathText(node, names) {
  let cur = node;
  for (const n of names) {
    cur = child(cur, n);
    if (!cur) return null;
  }
  return cur.text?.trim() ?? null;
}
