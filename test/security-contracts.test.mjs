// test/security-contracts.test.mjs — two small contracts the audit asked for
// and nothing pinned:
//   1. A provider API key must never reach a user-visible string. Toasts and
//      rendered error cards are the realistic leak paths (a raw 401 body can
//      echo the key back), so the error-copy helpers must not pass it through.
//   2. Platform cookies are read ONLY for the two platforms browsa actually
//      needs (YouTube / Bilibili media headers) — the cookies permission plus
//      <all_urls> means a stray call site could read any site's session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function firstPartySources() {
  const out = [];
  async function walk(dirUrl) {
    for (const entry of await readdir(dirUrl, { withFileTypes: true })) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith('.js')) out.push([child, await readFile(child, 'utf8')]);
    }
  }
  await walk(new URL('lib/', root));
  for (const f of ['background.js', 'sidepanel.js', 'options.js']) {
    out.push([new URL(f, root), await readFile(new URL(f, root), 'utf8')]);
  }
  return out;
}

test('no source file logs or toasts a provider apiKey', async () => {
  const offenders = [];
  for (const [url, src] of await firstPartySources()) {
    for (const [i, line] of src.split('\n').entries()) {
      const l = line.trim();
      if (l.startsWith('//') || l.startsWith('*')) continue;
      // A leak is apiKey flowing into console/showToast/appendError copy.
      if (/(console\.(log|warn|error)|showToast|appendError)\s*\(/.test(l) &&
          /\bapiKey\b|\bapi_key\b|Authorization/.test(l)) {
        offenders.push(`${url.pathname.split('/').pop()}:${i + 1} ${l.slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'API keys must never be logged or shown to the user');
});

test('chrome.cookies.getAll is only called for the two media platforms', async () => {
  const src = await readFile(new URL('lib/sidepanel/media-headers.js', root), 'utf8');
  for (const [url, s] of await firstPartySources()) {
    const hits = s.split('\n').filter((l) => l.includes('cookies.getAll') && !l.trim().startsWith('//'));
    if (!hits.length) continue;
    assert.ok(url.pathname.endsWith('media-headers.js'),
      `only media-headers.js may read cookies, found a call in ${url.pathname}`);
  }
  // The one call site must stay keyed to an allowlist of platform origins.
  assert.match(src, /platform === 'youtube' \? 'https:\/\/www\.youtube\.com' : 'https:\/\/www\.bilibili\.com'/,
    'cookie reads must resolve through the youtube/bilibili allowlist');
});

// ── storage.local TRUSTED_CONTEXTS（2026-10-23，借鉴 usememos/web-clipper）────
// storage.local 里躺着各家 provider API key 和全部历史；MV3 里 content script
// 默认可以读它。背景已调用 setAccessLevel 把读取面锁到扩展页面，因此 content
// script 一律走消息（selection-toolbar 的两个设置项经 CONTENT_SETTINGS_GET）。
test('content scripts never touch chrome.storage; background locks storage.local to trusted contexts', async () => {
  const offenders = [];
  for (const entry of await readdir(new URL('lib/content-scripts/', root), { withFileTypes: true })) {
    if (!entry.name.endsWith('.js')) continue;
    const src = await readFile(new URL('lib/content-scripts/' + entry.name, root), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      if (line.includes('chrome.storage') && !line.trim().startsWith('//')) {
        offenders.push(`lib/content-scripts/${entry.name}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'content scripts must fetch settings via messages (CONTENT_SETTINGS_GET), never read chrome.storage');
  const bg = await readFile(new URL('background.js', root), 'utf8');
  assert.match(bg, /setAccessLevel\?\.\(\{ accessLevel: 'TRUSTED_CONTEXTS' \}\)/,
    'background must lock storage.local to TRUSTED_CONTEXTS at startup');
});
