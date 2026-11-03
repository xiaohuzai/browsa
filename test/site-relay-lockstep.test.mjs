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
import vm from 'node:vm';

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

// 2026-11-03 安全审计：relay 与页面共享 JS 世界，页面可伪造任意 postMessage。
// 后台 handle() 对 sender 无类型门控（CLEAR_HISTORY 等特权 case 直达），故 relay
// 必须只转发站点数据键。此用例在 VM 沙箱里真实执行 relay，断言特权 type 被丢弃。
test('relay forwards only whitelisted site-data types, never privileged router cases', () => {
  const sent = [];
  let handler = null;
  const win = {
    __browsaSiteRelayInstalled: false,
    location: { origin: 'https://example.com' },
    addEventListener: (type, fn) => { if (type === 'message') handler = fn; },
  };
  const sandbox = {
    window: win,
    chrome: { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } },
    Set,
    console: { warn() {}, error() {}, log() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(relaySrc, sandbox);
  assert.equal(typeof handler, 'function', 'relay registered a message listener');
  const fire = (msg) => handler({ source: win, data: { __browsaRelay: true, message: msg } });
  fire({ type: 'YOUTUBE_DATA', video: {} });
  fire({ type: 'XHS_XHR_NOTE', note: {} });
  fire({ type: 'CLEAR_HISTORY' });
  fire({ type: 'CLEAR_ALL_SESSIONS' });
  fire({ type: 'DELETE_SESSION', id: 'x' });
  fire({ type: 'APPROVAL_RESPOND' });
  fire({ type: 'SET_ACTIVE_PROVIDER', name: 'x' });
  assert.deepEqual(sent.map((m) => m.type), ['YOUTUBE_DATA', 'XHS_XHR_NOTE'],
    'only site-data types reach the background; privileged cases are dropped at the relay');
});

test('relay whitelist stays in lockstep with SITE_MESSAGE_MAP + XHS_XHR_NOTE', async () => {
  const store = await readFile(new URL('../lib/handlers/site-cache-store.js', import.meta.url), 'utf8');
  const mapKeys = [...store.matchAll(/^\s*([A-Z_]+):\s*\{\s*site:/gm)].map((m) => m[1]);
  assert.equal(mapKeys.length, 9, 'nine SITE_MESSAGE_MAP keys');
  for (const type of [...mapKeys, 'XHS_XHR_NOTE']) {
    assert.ok(relaySrc.includes(`'${type}'`), `relay whitelist missing ${type}`);
  }
  // 反向集合相等（2026-11-03 审计补钉）：上面的 includes 只钉「不缺」，钉不住
  // 「不多」——白名单被悄悄扩成特权 type（如 SAVE_SESSION）时转发面扩大而测试
  // 全绿。ISOLATED 零依赖不能 import 共享常量，本用例即三份清单的单一 owner。
  // 排序数组比较顺带抓重复项；字面量改形会因 match 失败而红，不会假绿。
  const literal = relaySrc.match(/const RELAY_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(literal, 'RELAY_TYPES literal not found — update this pin if the shape changed');
  const relayTypes = [...literal[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(relayTypes.sort(), [...mapKeys, 'XHS_XHR_NOTE'].sort(),
    'RELAY_TYPES must equal SITE_MESSAGE_MAP keys + XHS_XHR_NOTE exactly — no privileged extras');
});
