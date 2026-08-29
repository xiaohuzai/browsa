// test/lib-ark-file-cache.test.mjs — Ark Files 复用缓存（file_id 30 天免重传）：
// 资产标识解析、缓存 key 指纹、存取合并语义、过期/时长不符/文件死亡（404）的
// fail-open 行为。全部注入 fake storageArea / aliveFn，不碰 chrome 全局。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  arkExpireAtSec,
  videoAssetId,
  arkFileCacheKey,
  arkFileAlive,
  lookupCachedArkFiles,
  saveArkFileCacheEntry,
} from '../lib/handlers/attach-asr.js';

const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const KEY = 'ark-key';
const URL_BILI = 'https://www.bilibili.com/video/BV1xx411c7mD?p=2';

function fakeStorage() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? { [k]: store.get(k) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
    async remove(k) { store.delete(k); },
  };
}

const aliveTrue = async () => true;
const aliveFalse = async () => false;

test('videoAssetId: B站 BV 号 + 分P、YouTube v 参数、解析不出返回空串', () => {
  assert.equal(videoAssetId('bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD/'), 'bili-BV1xx411c7mD-p1');
  assert.equal(videoAssetId('bilibili', URL_BILI), 'bili-BV1xx411c7mD-p2');
  assert.equal(videoAssetId('youtube', 'https://www.youtube.com/watch?v=abc123XYZ&t=9'), 'yt-abc123XYZ');
  assert.equal(videoAssetId('youtube', 'https://www.youtube.com/watch?t=9'), '');
  assert.equal(videoAssetId('bilibili', 'https://www.bilibili.com/blackboard/xxx'), '');
  assert.equal(videoAssetId('bilibili', 'not a url'), '');
});

test('arkExpireAtSec: now + 30 天（Ark 上限），秒级整数', () => {
  const now = Date.now();
  const exp = arkExpireAtSec(now);
  assert.equal(exp, Math.floor(now / 1000) + 30 * 86400);
});

test('arkFileCacheKey: apiKey 指纹参与（不同账号的 file_id 不通用）', () => {
  const a = arkFileCacheKey(BASE, KEY, 'bili-BV1-p1');
  assert.equal(a, `${BASE}|7:-key|bili-BV1-p1`);
  assert.notEqual(a, arkFileCacheKey(BASE, 'another-key', 'bili-BV1-p1'));
  assert.notEqual(a, arkFileCacheKey('https://other.example.com/api/v3', KEY, 'bili-BV1-p1'));
});

test('save + lookup roundtrip；need 只决定必查字段，另一字段命中照常返回', async () => {
  const area = fakeStorage();
  await saveArkFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    videoFileId: 'file-v', audioFileId: 'file-a', durationSec: 600, storageArea: area,
  });
  const hit = await lookupCachedArkFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'video', durationSec: 600, storageArea: area, aliveFn: aliveTrue,
  });
  assert.deepEqual(hit, { videoFileId: 'file-v', audioFileId: 'file-a' });
  const hitAudio = await lookupCachedArkFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'audio', durationSec: 600, storageArea: area, aliveFn: aliveTrue,
  });
  assert.deepEqual(hitAudio, { videoFileId: 'file-v', audioFileId: 'file-a' });
});

test('合并语义：两次不同模式各自积累，旧字段与旧 expireAt 保留', async () => {
  const area = fakeStorage();
  await saveArkFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    audioFileId: 'file-a', durationSec: 600, storageArea: area,
  });
  const audioExp1 = Object.values(area.store.get('browsaArkFileCache'))[0].audioExpireAt;
  await saveArkFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    videoFileId: 'file-v', durationSec: 600, storageArea: area,
  });
  const entry = area.store.get('browsaArkFileCache')[arkFileCacheKey(BASE, KEY, 'bili-BV1xx411c7mD-p2')];
  assert.equal(entry.videoFileId, 'file-v');
  assert.equal(entry.audioFileId, 'file-a', '音频字段保留');
  assert.equal(entry.audioExpireAt, audioExp1, '复用侧的 expireAt 不被刷新');
  assert.equal(entry.videoExpireAt, audioExp1, '同秒上传的 expireAt 一致（30 天上限）');
});

test('过期 / 时长不符 / 文件死亡（aliveFn false）都 fail-open 返回 null', async () => {
  const area = fakeStorage();
  await saveArkFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    videoFileId: 'file-v', durationSec: 600, storageArea: area,
  });
  const cacheKey = arkFileCacheKey(BASE, KEY, 'bili-BV1xx411c7mD-p2');
  const lookup = (over = {}) => lookupCachedArkFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'video', durationSec: 600, storageArea: area, aliveFn: aliveTrue, ...over,
  });
  // 文件死亡
  assert.equal(await lookup({ aliveFn: aliveFalse }), null);
  // 时长不符（换源/串号，>10% 且 >5s）
  assert.equal(await lookup({ durationSec: 900 }), null);
  // expireAt 手动拨到过去（alive 通过也不行）
  const store = area.store.get('browsaArkFileCache');
  store[cacheKey].videoExpireAt = Math.floor(Date.now() / 1000) - 10;
  assert.equal(await lookup(), null, 'expireAt 过去时 → miss');
});

test('部分复用：视频死亡但音频存活时，音频模式仍可复用音频', async () => {
  const area = fakeStorage();
  await saveArkFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    videoFileId: 'file-v', audioFileId: 'file-a', durationSec: 600, storageArea: area,
  });
  const perFileAlive = async ({ fileId }) => fileId === 'file-a';
  const hit = await lookupCachedArkFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'audio', durationSec: 600, storageArea: area, aliveFn: perFileAlive,
  });
  assert.deepEqual(hit, { videoFileId: '', audioFileId: 'file-a' });
});

test('arkFileAlive: 2xx 存活，404/网络异常按死亡处理', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true });
    assert.equal(await arkFileAlive({ baseUrl: BASE, apiKey: KEY, fileId: 'file-1' }), true);
    globalThis.fetch = async () => ({ ok: false });
    assert.equal(await arkFileAlive({ baseUrl: BASE, apiKey: KEY, fileId: 'file-1' }), false);
    globalThis.fetch = async () => { throw new Error('net down'); };
    assert.equal(await arkFileAlive({ baseUrl: BASE, apiKey: KEY, fileId: 'file-1' }), false);
    assert.equal(await arkFileAlive({ baseUrl: BASE, apiKey: KEY, fileId: '' }), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('资产标识解析不出 / storage 不可用 → 直接 miss（回退完整上传）', async () => {
  assert.equal(await lookupCachedArkFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: 'https://www.bilibili.com/blackboard/x',
    need: 'video', storageArea: fakeStorage(), aliveFn: aliveTrue,
  }), null);
  assert.equal(await lookupCachedArkFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'video', storageArea: null, aliveFn: aliveTrue,
  }), null, '无 storage（非扩展环境）→ miss');
});
