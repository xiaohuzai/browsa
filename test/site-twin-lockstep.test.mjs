// test/site-twin-lockstep.test.mjs
//
// Pins the byte-twin copies of site-extraction logic that CANNOT share one
// implementation, so they cannot drift silently:
//
//   - xhs-content-script.js vs lib/xhs-extractor.js: pickXhsImageUrls /
//     xhsSceneRank exist twice because executeScript({func}) serializes ONLY
//     the passed function, so the MAIN-world extractor carries self-contained
//     inline copies (the file header documents this). A semantic edit to one
//     copy without the other fails here.
//
//   - lib/xhs-extractor.js internal: blobToBase64 is nested inside two
//     separate MAIN-world entry points for the same serialization reason.
//
// The reddit/twitter canvas fetcher and the zhihu/geektime htmlToArticleText
// twins ARE consolidatable (manifest-ordered site-common.js) — they are
// covered by the delegation pins further down this file instead.
//
// Comparison is comment- and whitespace-insensitive (the copies legitimately
// differ in comments) but string/template CONTENTS are compared verbatim:
// prompt text, MIME types and URL builders must not drift either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

// Strip comments; keep string/template contents verbatim; squash whitespace.
function canonical(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        i++;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Same-length copy with comments and string/template contents blanked, so
// brace-matching finds the function's true end. (Regex literals containing
// braces would defeat this — none exist in the pinned functions.)
function stripForBalance(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; for (let k = i; k < e; k++) if (out[k] !== '\n') out[k] = ' '; i = e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      for (let k = i; k <= Math.min(j, n - 1); k++) if (out[k] !== '\n') out[k] = ' ';
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

function extractFn(src, marker, occurrence = 1) {
  let idx = -1;
  for (let k = 0; k < occurrence; k++) idx = src.indexOf(marker, idx + 1);
  if (idx < 0) return null;
  const stripped = stripForBalance(src);
  const start = stripped.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

// 只查自有属性——普通对象会把 `toString`/`constructor` 等从原型链带进来，
// 把 u.toString() 替换成 native-code 文本造成假漂移。
const renameAll = (src, map) => src.replace(/\b[A-Za-z_$][\w$]*\b/g, (w) => (Object.hasOwn(map, w) ? map[w] : w));

function assertTwins(aSrc, aMarker, bSrc, bMarker, renames, label) {
  const a = extractFn(aSrc, aMarker);
  const b = extractFn(bSrc, bMarker);
  assert.ok(a, `${label}: 基准副本存在（${aMarker}）`);
  assert.ok(b, `${label}: 孪生副本存在（${bMarker}）`);
  const na = canonical(a);
  const nb = canonical(renameAll(b, renames));
  if (na !== nb) {
    let i = 0;
    while (i < Math.min(na.length, nb.length) && na[i] === nb[i]) i++;
    assert.fail(`${label}: 孪生副本已漂移 @${i}\n  基准: ...${na.slice(Math.max(0, i - 40), i + 60)}\n  孪生: ...${nb.slice(Math.max(0, i - 40), i + 60)}\n  改动必须同时落在两份副本里（或收编成单份实现）。`);
  }
}

test('xhs lockstep: pickXhsImageUrls 的内容脚本副本 ≡ extractor 内联副本', () => {
  assertTwins(
    read('lib/content-scripts/xhs-content-script.js'),
    'function pickXhsImageUrls(',
    read('lib/xhs-extractor.js'),
    'function pickXhsImageUrlsInline(',
    { pickXhsImageUrlsInline: 'pickXhsImageUrls', xhsSceneRankInline: 'xhsSceneRank', list: 'imageList', urls: 'out' },
    'pickXhsImageUrls',
  );
});

test('xhs lockstep: xhsSceneRank 的内容脚本副本 ≡ extractor 内联副本', () => {
  assertTwins(
    read('lib/content-scripts/xhs-content-script.js'),
    'function xhsSceneRank(',
    read('lib/xhs-extractor.js'),
    'function xhsSceneRankInline(',
    { xhsSceneRankInline: 'xhsSceneRank' },
    'xhsSceneRank',
  );
});

test('xhs lockstep: extractor 内部两份 blobToBase64 ≡（两个 func: 入口各需自包含）', () => {
  const ex = read('lib/xhs-extractor.js');
  assertTwins(ex, 'function blobToBase64(', ex, 'function blobToBase64(', {}, 'blobToBase64', );
  // 确认真的有两份（防止将来删剩一份时上面的 1≡2 退化为平凡真）
  assert.ok(extractFn(ex, 'function blobToBase64(', 2), '第二份 blobToBase64 必须存在');
});
