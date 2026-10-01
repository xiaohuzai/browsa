// test/site-relay-lockstep.test.mjs
// 批G（2026-10-01）修活九/十站被动推送通道的 lockstep 钉。jsdom 拉不起扩展，
// 这条通道的正确性只能靠三层静态钉：(1) manifest 必须有 ISOLATED 信使条目且
// 站点覆盖 ⊇ 全部 MAIN 站点条目；(2) 十个 MAIN 站点脚本一律经 relayToHost
// 发送、不得出现裸 chrome.runtime.sendMessage（MAIN world 必然 undefined，
// 裸调用=当年死通道的根因）；(3) 信使转发形 + 后台接收键仍在。
// 新增站点 = 同时改 MAIN 条目与信使条目的 matches（本测试会抓住只改一边）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const relaySrc = await readFile(new URL('../lib/content-scripts/site-relay.js', import.meta.url), 'utf8');

const MAIN_SITES = ['xhs', 'juejin', 'youtube', 'zhihu', 'dedao', 'geektime', 'bilibili', 'xueqiu', 'twitter', 'xiaoyuzhou'];

test('manifest: ISOLATED site-relay entry exists, document_start, covering every MAIN site pattern', () => {
  const relayEntries = manifest.content_scripts.filter((c) => (c.js || []).includes('lib/content-scripts/site-relay.js'));
  assert.equal(relayEntries.length, 1, 'exactly one relay entry');
  const relay = relayEntries[0];
  assert.equal(relay.world, 'ISOLATED');
  assert.equal(relay.run_at, 'document_start', 'must register before MAIN scripts can post');
  const relayMatches = new Set(relay.matches);
  const mainEntries = manifest.content_scripts.filter((c) => c.world === 'MAIN');
  assert.equal(mainEntries.length, MAIN_SITES.length, 'ten MAIN site entries');
  for (const entry of mainEntries) {
    for (const pat of entry.matches) {
      assert.ok(relayMatches.has(pat), `relay must cover MAIN pattern ${pat} (add new sites to BOTH entries)`);
    }
  }
});

test('main site scripts: sends go through relayToHost; no bare chrome.runtime.sendMessage anywhere', async () => {
  for (const site of MAIN_SITES) {
    const src = await readFile(new URL(`../lib/content-scripts/${site}-content-script.js`, import.meta.url), 'utf8');
    assert.match(src, /function relayToHost\(/, `${site}: relayToHost helper missing`);
    assert.doesNotMatch(src, /chrome\.runtime\.sendMessage\(/,
      `${site}: bare sendMessage found — MAIN world has no chrome.runtime; route through relayToHost`);
  }
});

test('relay script: strict envelope check + background forward, self-contained (no imports)', () => {
  assert.match(relaySrc, /__browsaRelay/);
  assert.match(relaySrc, /ev\.source !== window/);
  assert.match(relaySrc, /chrome\.runtime\.sendMessage\(msg\)\.catch/);
  assert.doesNotMatch(relaySrc, /^\s*import\s/m, 'ISOLATED world cannot import ES modules');
});

test('background receivers are alive: SITE_MESSAGE_MAP 9 keys + XHS_XHR_NOTE case', async () => {
  const store = await readFile(new URL('../lib/handlers/site-cache-store.js', import.meta.url), 'utf8');
  for (const type of ['YOUTUBE_DATA', 'JUEJIN_ARTICLE', 'ZHIHU_CONTENT', 'DEDAO_ARTICLE', 'GEEKTIME_ARTICLE',
    'BILIBILI_VIDEO', 'XUEQIU_DATA', 'TWITTER_TWEET', 'XIAOYUZHOU_EPISODE']) {
    assert.ok(store.includes(`${type}:`), `SITE_MESSAGE_MAP missing ${type}`);
  }
  const bg = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(bg, /case 'XHS_XHR_NOTE'/);
  assert.match(bg, /recordSiteMessage\(msg, sender\?\.tab\?\.id\)/, 'receiver must key the cache by the sending tab');
});
