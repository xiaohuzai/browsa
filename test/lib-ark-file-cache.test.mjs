// test/lib-ark-file-cache.test.mjs — ASR 文件复用缓存（方舟 file_id 30 天 / 千问
// oss:// 临时 URL 48h 免重传）：资产标识解析、缓存 key 指纹、存取合并语义、
// 过期/时长不符/文件死亡（404）/千问模型绑定不符的 fail-open 行为。
// 全部注入 fake storageArea / aliveFn，不碰 chrome 全局。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  arkExpireAtSec,
  videoAssetId,
  arkFileCacheKey,
  asrFileCacheKey,
  arkFileAlive,
  lookupCachedAsrFiles,
  saveAsrFileCacheEntry,
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
  await saveAsrFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    videoFileId: 'file-v', audioFileId: 'file-a', durationSec: 600, storageArea: area,
  });
  const hit = await lookupCachedAsrFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'video', durationSec: 600, storageArea: area, aliveFn: aliveTrue,
  });
  assert.deepEqual(hit, { videoFileId: 'file-v', audioFileId: 'file-a' });
  const hitAudio = await lookupCachedAsrFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'audio', durationSec: 600, storageArea: area, aliveFn: aliveTrue,
  });
  assert.deepEqual(hitAudio, { videoFileId: 'file-v', audioFileId: 'file-a' });
});

test('合并语义：两次不同模式各自积累，旧字段与旧 expireAt 保留', async () => {
  const area = fakeStorage();
  await saveAsrFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    audioFileId: 'file-a', durationSec: 600, storageArea: area,
  });
  const audioExp1 = Object.values(area.store.get('browsaArkFileCache'))[0].audioExpireAt;
  await saveAsrFileCacheEntry({
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
  await saveAsrFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    videoFileId: 'file-v', durationSec: 600, storageArea: area,
  });
  const cacheKey = arkFileCacheKey(BASE, KEY, 'bili-BV1xx411c7mD-p2');
  const lookup = (over = {}) => lookupCachedAsrFiles({
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
  await saveAsrFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    videoFileId: 'file-v', audioFileId: 'file-a', durationSec: 600, storageArea: area,
  });
  const perFileAlive = async ({ fileId }) => fileId === 'file-a';
  const hit = await lookupCachedAsrFiles({
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
  assert.equal(await lookupCachedAsrFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: 'https://www.bilibili.com/blackboard/x',
    need: 'video', storageArea: fakeStorage(), aliveFn: aliveTrue,
  }), null);
  assert.equal(await lookupCachedAsrFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'video', storageArea: null, aliveFn: aliveTrue,
  }), null, '无 storage（非扩展环境）→ miss');
});

// ─── 千问（qwen）临时文件缓存：48h TTL、模型绑定、无探活 ─────────────────────────

const QWEN_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

test('asrFileCacheKey: 方舟保持旧格式（升级不清掉已存缓存），千问独立命名空间', () => {
  assert.equal(
    asrFileCacheKey('ark', BASE, KEY, 'bili-BV1-p1'),
    arkFileCacheKey(BASE, KEY, 'bili-BV1-p1'),
    '方舟 key 与旧版逐字节一致',
  );
  assert.equal(
    asrFileCacheKey('qwen', QWEN_BASE, 'sk-q', 'bili-BV1-p1'),
    `qwen|${QWEN_BASE}|4:sk-q|bili-BV1-p1`,
  );
  assert.notEqual(
    asrFileCacheKey('qwen', QWEN_BASE, 'sk-q', 'bili-BV1-p1'),
    asrFileCacheKey('ark', BASE, KEY, 'bili-BV1-p1'),
    '两家同资产互不串号',
  );
});

test('qwen save+lookup：绑定模型逐文件记录，模型匹配才命中', async () => {
  const area = fakeStorage();
  await saveAsrFileCacheEntry({
    provider: 'qwen', baseUrl: QWEN_BASE, apiKey: 'sk-q', platform: 'bilibili', pageUrl: URL_BILI,
    videoFileId: 'oss://dir/video.mp4', videoModel: 'qwen3.8-flash',
    audioFileId: 'oss://dir/audio.wav', audioModel: 'qwen3.5-omni-flash',
    durationSec: 600, storageArea: area,
  });
  const entry = area.store.get('browsaArkFileCache')[asrFileCacheKey('qwen', QWEN_BASE, 'sk-q', 'bili-BV1xx411c7mD-p2')];
  const nowPlus48h = Math.floor(Date.now() / 1000) + 48 * 3600;
  assert.ok(Math.abs(entry.videoExpireAt - nowPlus48h) <= 5, '千问 TTL = 上传时刻 + 48h');
  assert.equal(entry.videoModel, 'qwen3.8-flash');
  assert.equal(entry.audioModel, 'qwen3.5-omni-flash');

  const hit = await lookupCachedAsrFiles({
    provider: 'qwen', baseUrl: QWEN_BASE, apiKey: 'sk-q', platform: 'bilibili', pageUrl: URL_BILI,
    videoModel: 'qwen3.8-flash', audioModel: 'qwen3.5-omni-flash',
    need: 'video', durationSec: 600, storageArea: area,
  });
  assert.deepEqual(hit, { videoFileId: 'oss://dir/video.mp4', audioFileId: 'oss://dir/audio.wav' });
  // 换视频模型（或换转写模型）→ 对应文件不可用
  const missVideo = await lookupCachedAsrFiles({
    provider: 'qwen', baseUrl: QWEN_BASE, apiKey: 'sk-q', platform: 'bilibili', pageUrl: URL_BILI,
    videoModel: 'qwen3.7-plus', audioModel: 'qwen3.5-omni-flash',
    need: 'video', durationSec: 600, storageArea: area,
  });
  assert.equal(missVideo, null, '视频文件绑定模型不符 → miss');
  const partialAudio = await lookupCachedAsrFiles({
    provider: 'qwen', baseUrl: QWEN_BASE, apiKey: 'sk-q', platform: 'bilibili', pageUrl: URL_BILI,
    videoModel: 'qwen3.8-flash', audioModel: 'qwen3-omni-flash',
    need: 'video', durationSec: 600, storageArea: area,
  });
  assert.deepEqual(partialAudio, { videoFileId: 'oss://dir/video.mp4', audioFileId: '' },
    '音频绑定模型不符 → 音频不可用，但视频仍命中（管线只补传音频）');
});

test('qwen lookup 默认不发任何请求（平台没有查询接口，无法探活；仅 TTL 判活）', async () => {
  const area = fakeStorage();
  await saveAsrFileCacheEntry({
    provider: 'qwen', baseUrl: QWEN_BASE, apiKey: 'sk-q', platform: 'bilibili', pageUrl: URL_BILI,
    audioFileId: 'oss://dir/audio.wav', audioModel: 'qwen3.5-omni-flash',
    durationSec: 600, storageArea: area,
  });
  const realFetch = globalThis.fetch;
  let fetches = 0;
  try {
    globalThis.fetch = async () => { fetches++; return { ok: true }; };
    const hit = await lookupCachedAsrFiles({
      provider: 'qwen', baseUrl: QWEN_BASE, apiKey: 'sk-q', platform: 'bilibili', pageUrl: URL_BILI,
      audioModel: 'qwen3.5-omni-flash', need: 'audio', durationSec: 600, storageArea: area,
    });
    assert.deepEqual(hit, { videoFileId: '', audioFileId: 'oss://dir/audio.wav' });
    assert.equal(fetches, 0, '零网络请求');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('qwen 过期（48h）→ fail-open miss；方舟与千问条目同资产互不干扰', async () => {
  const area = fakeStorage();
  await saveAsrFileCacheEntry({
    provider: 'qwen', baseUrl: QWEN_BASE, apiKey: 'sk-q', platform: 'bilibili', pageUrl: URL_BILI,
    audioFileId: 'oss://dir/audio.wav', audioModel: 'qwen3.5-omni-flash',
    durationSec: 600, storageArea: area,
  });
  await saveAsrFileCacheEntry({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    audioFileId: 'file-a', durationSec: 600, storageArea: area,
  });
  const qKey = asrFileCacheKey('qwen', QWEN_BASE, 'sk-q', 'bili-BV1xx411c7mD-p2');
  area.store.get('browsaArkFileCache')[qKey].audioExpireAt = Math.floor(Date.now() / 1000) - 10;
  const miss = await lookupCachedAsrFiles({
    provider: 'qwen', baseUrl: QWEN_BASE, apiKey: 'sk-q', platform: 'bilibili', pageUrl: URL_BILI,
    audioModel: 'qwen3.5-omni-flash', need: 'audio', durationSec: 600, storageArea: area,
  });
  assert.equal(miss, null, '千问过期 → miss');
  const arkHit = await lookupCachedAsrFiles({
    baseUrl: BASE, apiKey: KEY, platform: 'bilibili', pageUrl: URL_BILI,
    need: 'audio', durationSec: 600, storageArea: area, aliveFn: aliveTrue,
  });
  assert.deepEqual(arkHit, { videoFileId: '', audioFileId: 'file-a' }, '方舟条目不受影响');
});
