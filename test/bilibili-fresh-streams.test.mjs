// test/bilibili-fresh-streams.test.mjs — fetchFreshBilibiliStreams（B站 playurl
// 过期自愈的真正实现）在 vm 里以真实源码驱动：成功响应解析出流、失败抛出带原因
// 的错误（调用方透传到用户 toast）。整文件注入 vm（与 executeScript({files}) 的
// 注入方式一致），fetch 用桩按 URL 路由。
//
// 真实 bug 链回归（2026-08-29）：旧代码把响应顶层 code 误判到 data.code（恒
// undefined ≠ 0），成功响应也永远返回 [] —— 自愈路径从未真正成功过，被「页面
// 刚打开时缓存流尚未过期」长期掩盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadFreshFn(fetchImpl) {
  const src = await readFile(join(ROOT, 'lib/content-scripts/bilibili-content-script.js'), 'utf8');
  const ctx = vm.createContext({
    window: {},
    chrome: {}, // 无 runtime → installBilibiliInterceptor 直接跳过
    location: { origin: 'https://www.bilibili.com' },
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    fetch: fetchImpl,
  });
  vm.runInContext(src, ctx, { filename: 'bilibili-content-script.js' });
  return vm.runInContext('fetchFreshBilibiliStreams', ctx);
}

const NAV_OK = {
  ok: true,
  json: async () => ({
    code: -101, // 未登录 nav 也返回 wbi_img
    data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/abc123.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/def456.gif' } },
  }),
};

function playurlOk() {
  return {
    ok: true,
    json: async () => ({
      code: 0,
      message: '0',
      data: {
        dash: {
          audio: [{ baseUrl: 'https://upos.example/aud.m4s?deadline=9999999999', bandwidth: 128000, duration: 300, size: 4_800_000, codecs: 'mp4a.40.2', id: 30216 }],
          video: [{ baseUrl: 'https://upos.example/vid.m4s?deadline=9999999999', bandwidth: 2_000_000, duration: 300, size: 75_000_000, width: 1920, height: 1080, id: 80 }],
        },
        durl: [],
      },
    }),
  };
}

test('fresh playurl: 成功响应解析出 audio+video 流（旧代码在这里恒返回 []）', async () => {
  const fn = await loadFreshFn(async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/nav')) return NAV_OK;
    if (u.includes('/x/player/wbi/playurl')) return playurlOk();
    throw new Error('unexpected fetch: ' + u);
  });
  const streams = await fn('BV1xx411c7mD', 999);
  assert.equal(streams.filter((s) => s.type === 'audio').length, 1);
  assert.equal(streams.filter((s) => s.type === 'video').length, 1);
  const aud = streams[0];
  assert.equal(aud.type, 'audio');
  assert.equal(aud.codecs, 'mp4a.40.2');
  assert.match(aud.url, /deadline=9999999999/);
});

test('fresh playurl: dash 空但有 durl（老格式）→ muxed 流', async () => {
  const fn = await loadFreshFn(async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/nav')) return NAV_OK;
    if (u.includes('/playurl')) {
      return {
        ok: true,
        json: async () => ({ code: 0, data: { dash: {}, durl: [{ url: 'https://upos.example/muxed.mp4?deadline=9999999999' }] } }),
      };
    }
    throw new Error('unexpected fetch: ' + u);
  });
  const streams = await fn('BV1xx411c7mD', 999);
  assert.deepEqual(Array.from(streams, (s) => s.type), ['muxed']);
});

test('fresh playurl: 业务失败（风控/权限）抛出带 code+message 的错误，不静默空列表', async () => {
  const fn = await loadFreshFn(async (url) => {
    const u = String(url);
    if (u.includes('/x/web-interface/nav')) return NAV_OK;
    if (u.includes('/playurl')) {
      return { ok: true, json: async () => ({ code: -403, message: '访问权限不足' }) };
    }
    throw new Error('unexpected fetch: ' + u);
  });
  await assert.rejects(fn('BV1xx411c7mD', 999), /playurl code=-403: 访问权限不足/);
});

test('fresh playurl: nav 缺 wbi_img keys / HTTP 失败都抛出带阶段的原因', async () => {
  const fnNoKeys = await loadFreshFn(async (url) => {
    if (String(url).includes('/x/web-interface/nav')) {
      return { ok: true, json: async () => ({ code: 0, data: {} }) };
    }
    throw new Error('unexpected fetch');
  });
  await assert.rejects(fnNoKeys('BV1', 1), /nav 无 wbi_img keys/);

  const fnNavFail = await loadFreshFn(async () => ({ ok: false, status: 502 }));
  await assert.rejects(fnNavFail('BV1', 1), /nav HTTP 502/);
});
