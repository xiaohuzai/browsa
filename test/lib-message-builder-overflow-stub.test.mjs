// test/lib-message-builder-overflow-stub.test.mjs — stubOversizedAttachments 的
// 请求侧/存储侧分离（2026-11-03 审计，ADR-0013 回归）。溢出自救为让重试塞进模型
// 窗口，请求侧把大附件 stub 成纯字符串并丢图（合法）；但持久化侧曾把同一个无图
// 字符串写回 storage，永久销毁像素——违反「存储像素永不销毁」裁决。修复后：
//   - 返回的 history（重建请求用）：stub 条目是纯字符串，无 image_url；
//   - changed（持久化用）：只 stub 文本，保留原 image_url 部件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubOversizedAttachments, prepareHistoryForModel } from '../lib/message-builder.js';
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

// ─── 跨回合自救（2026-11-03 audit-1）─────────────────────────────────────────
// 存储侧写回「stub 文本 + 原图」后，下一轮溢出若仍只按 text.length<minChars
// 判定，已 stub 条目（≈300 字）永远被跳过：图片每轮原样重发、changed=0、
// chat-handler 的 rebuild 门不开 → 会话对该 provider 永久溢出。识别判据是
// stub 哨兵文案（生成与识别同源），不是长度/attachId。

test('a persisted rescue re-overflows: sentinel recognition re-stubs the request (changed>0, no images), storage pixels intact', () => {
  // turn 1：溢出 → 自救成功 → chat-handler 把 changed[0].content 写回存储条目。
  const first = stubOversizedAttachments([attachEntry()]);
  assert.equal(first.changed.length, 1);
  const stored = { role: 'user', attachId: 'att-1', content: first.changed[0].content };

  // turn 2：存储条目经 prepareHistoryForModel 逐字随行（只剥 legacy 字段），
  // 再次溢出 → 必须仍能自救。
  const sent = prepareHistoryForModel([stored]);
  const second = stubOversizedAttachments(sent);
  assert.ok(second.changed.length > 0, 'the rebuild gate (changed.length) must open on the SECOND overflow');
  assert.equal(typeof second.history[0].content, 'string', 'request side degrades to the plain stub string again');
  assert.ok(!JSON.stringify(second.history).includes('image_url'), 'no image parts ride the retried request');
  assert.equal(second.history[0].content, first.history[0].content, 'the request stub is byte-identical to turn 1’s (deterministic)');
  // 存储侧幂等：写回同值，像素永不销毁（ADR-0013）。
  assert.deepEqual(second.changed[0].content, stored.content, 'storage content is returned unchanged (idempotent write-back)');
  const imgs = second.changed[0].content.filter((p) => p.type === 'image_url');
  assert.equal(imgs.length, 2, 'both original pixels survive the second rescue');

  // turn 3：再次写回后再溢出，仍可自救（幂等闭环）。
  const third = stubOversizedAttachments([{ ...stored, content: second.changed[0].content }]);
  assert.ok(third.changed.length > 0);
  assert.equal(typeof third.history[0].content, 'string');
});

test('an already-stubbed entry with NO images is left untouched (nothing to strip)', () => {
  const first = stubOversizedAttachments([{ role: 'user', attachId: 'att-s', content: bigText }]);
  const stored = { role: 'user', attachId: 'att-s', content: first.changed[0].content }; // 纯字符串 stub
  const { history: out, changed } = stubOversizedAttachments([stored]);
  assert.equal(changed.length, 0, 'no images → no rewrite needed');
  assert.deepEqual(out, [stored]);
});

test('a persisted stub rides VERBATIM on a normal (non-overflow) turn — KV-cache ruling untouched', () => {
  // 自救只发生在溢出时；平时已 stub 条目的图片照旧逐字重发（2026-10-14 裁决
  // 的刻意行为，勿顺手“优化”）。prepareHistoryForModel 不得剥它。
  const first = stubOversizedAttachments([attachEntry()]);
  const stored = { role: 'user', attachId: 'att-1', content: first.changed[0].content };
  const sent = prepareHistoryForModel([stored]);
  assert.deepEqual(sent[0].content, stored.content, 'stub text + pixels ride verbatim when no overflow rescue runs');
});

test('small attaches and non-attach entries are left untouched', () => {
  const small = { role: 'user', attachId: 'att-3', content: `${PAGE_CONTEXT_PREFIX}\nshort reference` };
  const plain = { role: 'user', content: 'just a question' };
  const assistant = { role: 'assistant', content: bigText };
  const { history: out, changed } = stubOversizedAttachments([small, plain, assistant]);
  assert.equal(changed.length, 0, 'nothing below minChars / non-attach is stubbed');
  assert.deepEqual(out, [small, plain, assistant]);
});