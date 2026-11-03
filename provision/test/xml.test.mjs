/**
 * XML 解析器单测 —— 它存在的唯一理由就是**不能靠正则取字段**。
 *
 * 用一个真实的 EC2 `DescribeInstances` 形状做回归：同名嵌套（`item` 套 `item`、
 * `name` 出现在多个分支里）必须取到对的那一个。取错了不会报错，只会静默拿到别的值 ——
 * 那正是本仓最忌讳的形状，所以这里把它钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { child, childText, findAll, find, parseXml, pathText } from '../lib/xml.mjs';

const DESCRIBE_INSTANCES = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <reservationSet>
    <item>
      <reservationId>r-1</reservationId>
      <instancesSet>
        <item>
          <instanceId>i-0abc</instanceId>
          <imageId>ami-123</imageId>
          <instanceState><code>16</code><name>running</name></instanceState>
          <privateIpAddress>172.31.1.5</privateIpAddress>
          <ipAddress>13.1.2.3</ipAddress>
          <instanceType>t3.micro</instanceType>
          <tagSet>
            <item><key>Name</key><value>marketplace-node</value></item>
          </tagSet>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>`;

test('同名嵌套：reservation 的 item 与 instance 的 item 必须分层取', () => {
  const tree = parseXml(DESCRIBE_INSTANCES);
  const reservation = findAll(tree, 'item')[0];
  const instances = child(reservation, 'instancesSet');
  const inst = findAll(instances, 'item')[0];
  assert.equal(childText(inst, 'instanceId'), 'i-0abc');
  assert.equal(childText(inst, 'ipAddress'), '13.1.2.3');
});

test('instanceState 里的 name 要取"直接子元素"的那个（不能撞上别处的 name）', () => {
  const tree = parseXml(DESCRIBE_INSTANCES);
  const inst = findAll(tree, 'item').find((i) => child(i, 'instanceId'));
  const state = child(inst, 'instanceState');
  assert.equal(childText(state, 'name'), 'running');
  assert.equal(childText(state, 'code'), '16');
});

test('TagSet 里的 key/value 能取到（实例名的判据）', () => {
  const tree = parseXml(DESCRIBE_INSTANCES);
  const tags = findAll(tree, 'item').filter((i) => child(i, 'key'));
  assert.equal(childText(tags[0], 'value'), 'marketplace-node');
});

test('自闭合标签不产生子节点（AWS 的空集合形态）', () => {
  const tree = parseXml('<R><groupSet/><nextToken>x</nextToken></R>');
  assert.equal(find(tree, 'groupSet').children.length, 0);
  assert.equal(childText(tree, 'nextToken'), 'x');
});

test('实体与 CDATA 还原：&amp; 与 <![CDATA[…]]> 都按字面取', () => {
  const tree = parseXml('<R><a>a&amp;b</a><b><![CDATA[<not-a-tag>]]></b></R>');
  assert.equal(childText(tree, 'a'), 'a&b');
  assert.equal(childText(tree, 'b'), '<not-a-tag>');
});

test('错误响应：<Code>/<Message> 按路径取到（这是错误归类的输入）', () => {
  const tree = parseXml(`<Response><Errors><Error><Code>InvalidGroup.NotFound</Code><Message>no such group</Message></Error></Errors><RequestID>r</RequestID></Response>`);
  // 必须按路径取：Errors 下面还有一层 Error，深度优先的 find 在多层同名结构里会撞错分支
  assert.equal(pathText(tree, ['Errors', 'Error', 'Code']), 'InvalidGroup.NotFound');
  assert.equal(pathText(tree, ['Errors', 'Error', 'Message']), 'no such group');
  assert.equal(childText(tree, 'RequestID'), 'r');
});
