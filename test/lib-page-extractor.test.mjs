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

test('attach flow wires the predicate with a body.innerText probe (source-shape pin)', async () => {
  const fs = await import('fs/promises');
  // 2026-10-28: the ATTACH_PAGE body moved to lib/handlers/attach-page.js —
  // the pin follows the code (same pattern as attach-asr-closure.test.mjs
  // after the attach-asr-pending extraction).
  const src = await fs.readFile(new URL('../lib/handlers/attach-page.js', import.meta.url), 'utf8');
  assert.match(src, /autoJinaFallbackWarranted\(\{\s*\n?\s*textLen: ctx\.text\?\.length \|\| 0,/,
    'the gate must route through the shared predicate');
  assert.match(src, /document\.body\?\.innerText \|\| ''\)\.length/,
    'the page-volume probe must use innerText (textContent counts script blobs → everything looks like a deficit)');
  assert.match(src, /mode === 'auto' && !ctx\.siteSynthesized/,
    'site-synthesized results must skip the probe entirely');
});

// --------------- extractActiveTab: the ordered site ladder -------------------

test('extractActiveTab runs its attempts in the pinned order', async () => {
  // The ladder IS the behaviour: a page can satisfy several gates, and whichever
  // attempt runs first wins. Nothing pinned that order, so a "harmless" reshuffle
  // silently changed which extractor produced a page's text (the arXiv/YouTube
  // ordering is the load-bearing example: abs->/html/ must win before YouTube-style
  // active fetch paths are even tried, and site-cache synthesis must precede the
  // URL fallbacks). Steps added or reordered must update this list deliberately.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../lib/page-extractor.js', import.meta.url), 'utf8');
  const start = src.indexOf('export async function extractActiveTab');
  const end = src.indexOf('return await runGenericExtraction', start);
  assert.ok(start > 0 && end > start, 'extractActiveTab body must be findable');
  const body = src.slice(start, end);
  const ORDERED = [
    'tryPdfExtraction',
    'tryOfficeExtraction',
    "mode === 'screenshot'",
    'synthesizeSiteCache',
    'isXiaoyuzhouEpisodeUrl',
    'arxivAbsIdFromUrl',
    'tryArxivHtmlFallback',
    'tryYoutubeActiveFallback',
    'tryBilibiliActiveFallback',
    'tryXActiveFallback',
    'tryRedditActiveFallback',
    'tryZhihuActiveFallback',
    'tryXhsExtraction',
    'tryFeishuExtraction',
    'tryGithubRepoExtraction',
    'tryGithubExtraction',
  ];
  let cursor = 0;
  for (const marker of ORDERED) {
    const at = body.indexOf(marker, cursor);
    assert.ok(at >= 0, `${marker} must appear after the previous step (ladder order changed?)`);
    cursor = at + marker.length;
  }
  // The generic cascade is the terminal step: nothing after it in the ladder, and the
  // slice above stops right before it.
  assert.equal((body.match(/runGenericExtraction\(/g) || []).length, 0,
    'no extraction attempt may run after the generic cascade');
  assert.ok(src.slice(end).startsWith('return await runGenericExtraction('),
    'the function must end with the generic cascade');
});

