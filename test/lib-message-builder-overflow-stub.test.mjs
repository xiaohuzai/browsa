// test/lib-message-builder-overflow-stub.test.mjs — stubOversizedAttachments 的
// 请求侧/存储侧分离（2026-11-03 审计，ADR-0013 回归）。溢出自救为让重试塞进模型
// 窗口，请求侧把大附件 stub 成纯字符串并丢图（合法）；但持久化侧曾把同一个无图
// 字符串写回 storage，永久销毁像素——违反「存储像素永不销毁」裁决。修复后：
//   - 返回的 history（重建请求用）：stub 条目是纯字符串，无 image_url；
//   - changed（持久化用）：只 stub 文本，保留原 image_url 部件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubOversizedAttachments } from '../lib/message-builder.js';
import { PAGE_CONTEXT_PREFIX } from '../lib/constants.js';

const bigText = `${PAGE_CONTEXT_PREFIX}\nURL: https://example.com/a\nTitle: A\n${'x'.repeat(9000)}`;
const img = (url) => ({ type: 'image_url', image_url: { url } });
const attachEntry = () => ({
  role: 'user', attachId: 'att-1',
  content: [{ type: 'text', text: bigText }, img('data:image/png;base64,AAA'), img('data:image/png;base64,BBB')],
});

test('request-side stub drops images (string); storage-side changed preserves the pixels (ADR-0013)', () => {
  const history = [attachEntry()];
  const { history: out, changed } = stubOversizedAttachments(history);
  // 请求侧：纯字符串、无图
  assert.equal(typeof out[0].content, 'string', 'request stub is a plain string');
  assert.ok(out[0].content.startsWith(PAGE_CONTEXT_PREFIX));
  assert.ok(out[0].content.includes('too large'));
  // 存储侧：保留两张原图
  assert.equal(changed.length, 1);
  assert.equal(changed[0].attachId, 'att-1');
  assert.ok(Array.isArray(changed[0].content), 'storage content keeps the part array');
  const imgs = changed[0].content.filter((p) => p.type === 'image_url');
  assert.equal(imgs.length, 2, 'both original pixels survive in storage');
  assert.deepEqual(imgs.map((p) => p.image_url.url), ['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
  const textPart = changed[0].content.find((p) => p.type === 'text');
  assert.ok(textPart.text.includes('too large'), 'storage text is the stub');
  // 输入数组不被 mutate
  assert.ok(Array.isArray(history[0].content), 'input history is not mutated');
  assert.equal(history[0].content.length, 3);
});

test('string-content attach (no images): storage stub is a plain string', () => {
  const history = [{ role: 'user', attachId: 'att-2', content: bigText }];
  const { changed } = stubOversizedAttachments(history);
  assert.equal(changed.length, 1);
  assert.equal(typeof changed[0].content, 'string');
  assert.ok(changed[0].content.includes('too large'));
});

test('small attaches and non-attach entries are left untouched', () => {
  const small = { role: 'user', attachId: 'att-3', content: `${PAGE_CONTEXT_PREFIX}\nshort reference` };
  const plain = { role: 'user', content: 'just a question' };
  const assistant = { role: 'assistant', content: bigText };
  const { history: out, changed } = stubOversizedAttachments([small, plain, assistant]);
  assert.equal(changed.length, 0, 'nothing below minChars / non-attach is stubbed');
  assert.deepEqual(out, [small, plain, assistant]);
});