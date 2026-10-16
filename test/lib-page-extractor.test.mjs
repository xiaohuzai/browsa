// test/lib-page-extractor.test.mjs — auto 模式 jina 回退判据（提取失败的语义）。
//
// 2026-10-16 用户问「怎样算提取失败」后正解化：旧判据单看 <200 字符，短页面
// 被误判（假失败）、抓了一堆导航垃圾的半失败过检（假成功）。新判据两层：
// 绝对下限 + 相对亏空（页面 body.innerText 量做参照）——autoJinaFallback-
// Warranted 纯函数钉真值表，background 调用点（探针 + 接线）用源码形状钉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoJinaFallbackWarranted } from '../lib/page-extractor.js';

test('site-synthesized results never warrant the jina fallback, regardless of length', () => {
  assert.equal(autoJinaFallbackWarranted({ textLen: 0, siteSynthesized: true }), false);
  assert.equal(autoJinaFallbackWarranted({ textLen: 150, siteSynthesized: true, bodyTextLen: 99999 }), false,
    'even a tiny site result with a huge page must not fall back (短推文回归)');
});

test('absolute floor: extraction under 200 chars is a failure (all prior rescues preserved)', () => {
  assert.equal(autoJinaFallbackWarranted({ textLen: 150, bodyTextLen: null }), true);
  assert.equal(autoJinaFallbackWarranted({ textLen: 150, bodyTextLen: 0 }), true);
});

test('relative deficit: a big page with a fraction extracted is a failure — rescues the old 400-char miss', () => {
  // 旧判据下 400 字符 ≥ 200 不触发救援；相对层把它判为失败。
  assert.equal(autoJinaFallbackWarranted({ textLen: 400, bodyTextLen: 8000 }), true);
  assert.equal(autoJinaFallbackWarranted({ textLen: 1000, bodyTextLen: 30000 }), true);
});

test('a genuinely extracted page does not warrant fallback; probe unavailable degrades to the absolute layer', () => {
  assert.equal(autoJinaFallbackWarranted({ textLen: 5000, bodyTextLen: 6500 }), false,
    'extraction got most of the page — success');
  assert.equal(autoJinaFallbackWarranted({ textLen: 250, bodyTextLen: null }), false,
    'probe unavailable (tab closed / executeScript threw) → relative layer inert, old behavior stands');
  assert.equal(autoJinaFallbackWarranted({ textLen: 400, bodyTextLen: 1500 }), false,
    'page below the 2000-char floor is nav-shell scale — no deficit talk');
  assert.equal(autoJinaFallbackWarranted({ textLen: 200 }), false, 'exactly at the floor is not a failure');
});

test('background wires the predicate with a body.innerText probe (source-shape pin)', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(src, /autoJinaFallbackWarranted\(\{\s*\n?\s*textLen: ctx\.text\?\.length \|\| 0,/,
    'the gate must route through the shared predicate');
  assert.match(src, /document\.body\?\.innerText \|\| ''\)\.length/,
    'the page-volume probe must use innerText (textContent counts script blobs → everything looks like a deficit)');
  assert.match(src, /mode === 'auto' && !ctx\.siteSynthesized/,
    'site-synthesized results must skip the probe entirely');
});
