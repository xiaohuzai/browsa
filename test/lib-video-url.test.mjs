// test/lib-video-url.test.mjs — 视频页 URL 判同 + 候选 tab 解析（纯函数，无 DOM）。
// 覆盖 seekVideo / transcript drawer 播放跟随共用的身份判定。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoUrlMatches, resolveMatchingTabId } from '../lib/video-url.js';

test('youtube: same video, extra tracking/playback params ignored', () => {
  assert.equal(videoUrlMatches(
    'https://www.youtube.com/watch?v=abc123&t=95s&list=PL1&si=xyz',
    'https://www.youtube.com/watch?v=abc123'
  ), true);
});

test('youtube: different v param is a different video', () => {
  assert.equal(videoUrlMatches(
    'https://www.youtube.com/watch?v=other',
    'https://www.youtube.com/watch?v=abc123'
  ), false);
});

test('v on only one side does not match (same /watch pathname)', () => {
  assert.equal(videoUrlMatches(
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=abc123'
  ), false);
});

test('bilibili: identity is the BV path, tracking params ignored', () => {
  assert.equal(videoUrlMatches(
    'https://www.bilibili.com/video/BV1aX4y1E7b9/?spm_id_from=333.788&vd_source=abc',
    'https://www.bilibili.com/video/BV1aX4y1E7b9/'
  ), true);
});

test('bilibili: different BV (pathname) does not match', () => {
  assert.equal(videoUrlMatches(
    'https://www.bilibili.com/video/BVother/',
    'https://www.bilibili.com/video/BV1aX4y1E7b9/'
  ), false);
});

test('different origin (m. vs www.) does not match', () => {
  assert.equal(videoUrlMatches(
    'https://m.bilibili.com/video/BV1aX4y1E7b9/',
    'https://www.bilibili.com/video/BV1aX4y1E7b9/'
  ), false);
});

test('youtu.be short link vs watch page do not match (documented granularity)', () => {
  assert.equal(videoUrlMatches(
    'https://youtu.be/abc123',
    'https://www.youtube.com/watch?v=abc123'
  ), false);
});

test('missing / invalid URLs return false, never throw', () => {
  assert.equal(videoUrlMatches(null, 'https://x.com/watch?v=a'), false);
  assert.equal(videoUrlMatches('https://x.com/watch?v=a', ''), false);
  assert.equal(videoUrlMatches('not a url', 'https://x.com/watch?v=a'), false);
});

// ─── resolveMatchingTabId: 候选顺序 + 失败跳过 ────────────────────────────────

test('returns the first candidate whose tab URL matches, in priority order', async () => {
  const urls = { 1: 'https://www.bilibili.com/video/BV1x', 2: 'https://www.bilibili.com/video/BV1x' };
  const got = await resolveMatchingTabId([1, 2], async (id) => urls[id], 'https://www.bilibili.com/video/BV1x');
  assert.equal(got, 1);
});

test('falls through to a later candidate when an earlier tab no longer shows the video', async () => {
  const urls = { 1: 'https://example.com/other', 2: 'https://www.bilibili.com/video/BV1x' };
  const got = await resolveMatchingTabId([1, 2], async (id) => urls[id], 'https://www.bilibili.com/video/BV1x');
  assert.equal(got, 2);
});

test('swallows lookup throws (tab gone) and keeps scanning', async () => {
  const got = await resolveMatchingTabId(
    [1, 2],
    async (id) => { if (id === 1) throw new Error('No tab with id: 1'); return 'https://www.bilibili.com/video/BV1x'; },
    'https://www.bilibili.com/video/BV1x'
  );
  assert.equal(got, 2);
});

test('skips null and duplicate candidate ids', async () => {
  const lookups = [];
  const got = await resolveMatchingTabId(
    [null, 7, 7],
    async (id) => { lookups.push(id); return 'https://www.bilibili.com/video/BV1x'; },
    'https://www.bilibili.com/video/BV1x'
  );
  assert.equal(got, 7);
  assert.deepEqual(lookups, [7]);
});

test('returns null when no candidate matches', async () => {
  const got = await resolveMatchingTabId([1, 2], async () => 'https://example.com/x', 'https://www.bilibili.com/video/BV1x');
  assert.equal(got, null);
});

test('returns null when sourceUrl is missing (nothing to match against)', async () => {
  let called = false;
  const got = await resolveMatchingTabId([1], async () => { called = true; return 'https://x/'; }, '');
  assert.equal(got, null);
  assert.equal(called, false);
});
