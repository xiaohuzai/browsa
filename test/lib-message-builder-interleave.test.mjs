// test/lib-message-builder-interleave.test.mjs — interleaveImageParts：[图N] 内联
// 锚点 → 真交错多模态 content 的统一约定（视频截图有位置、PDF 无位置退化为尾部）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interleaveImageParts } from '../lib/message-builder.js';

test('interleaveImageParts: anchors split text and place images at their positions', () => {
  const text = '前文\n[00:05] [图1] 图表一\n中段\n[03:00] [图2] 代码\n后文';
  const out = interleaveImageParts(text, [{ url: 'A' }, { url: 'B' }]);
  assert.deepEqual(out.map((p) => p.type), ['text', 'image_url', 'text', 'image_url', 'text']);
  assert.match(out[0].text, /前文\n\[00:05\] \[图1\] 图表一$/, '锚点行保留在其文本片段内');
  assert.equal(out[1].image_url.url, 'A');
  assert.match(out[2].text, /中段\n\[03:00\] \[图2\] 代码$/, '锚点行结束一个文本片段');
  assert.equal(out[3].image_url.url, 'B');
  assert.equal(out[4].text, '后文', '尾部文本是独立片段');
});

test('interleaveImageParts: no anchors degrades to [text, ...images] (PDF shape)', () => {
  const out = interleaveImageParts('纯文本，无锚点', [{ url: 'A' }, { url: 'B' }]);
  assert.deepEqual(out.map((p) => p.type), ['text', 'image_url', 'image_url']);
  assert.match(out[0].text, /纯文本/);
});

test('interleaveImageParts: out-of-range anchors stay as plain text', () => {
  const out = interleaveImageParts('有 [图5] 但只有一张图', [{ url: 'A' }]);
  assert.deepEqual(out.map((p) => p.type), ['text', 'image_url']);
  assert.match(out[0].text, /\[图5\]/, '越界锚点按普通文本保留');
});

test('interleaveImageParts: empty images returns the string unchanged', () => {
  assert.equal(interleaveImageParts('普通文本', []), '普通文本');
  assert.equal(interleaveImageParts('普通文本', null), '普通文本');
});
