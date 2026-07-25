// test/site-synthesizers.test.mjs — unit tests for lib/site-synthesizers.js
//
// Focused on synthesizeSiteCache's SPA-navigation staleness guard, which was
// added after a real bug: YouTube/Bilibili are SPAs; switching to a different
// video in the same tab doesn't trigger a page reload, so the XHR-interception
// cache (keyed by tabId) can hold a previous video's data when the user clicks
// 📎 before the new video's XHR fires. Without the guard, the wrong video's
// transcript/metadata would be attached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeSiteCache } from '../lib/site-synthesizers.js';

const fakeMeta = (url) => ({ url, title: 'Test', articleTitle: 'Test' });

// ── YouTube ────────────────────────────────────────────────────────────────

test('synthesizeSiteCache youtube: returns result when cached videoId matches current URL', () => {
  const cache = { source: 'youtube', data: { videoId: 'abc123', title: 'T', author: 'A', lengthSeconds: 0, shortDescription: '', transcript: null } };
  const result = synthesizeSiteCache(cache, fakeMeta('https://www.youtube.com/watch?v=abc123'));
  assert.ok(result, 'should return a result when IDs match');
  assert.equal(result.mode, 'youtube');
});

test('synthesizeSiteCache youtube: returns null (cache miss) when cached videoId differs from current URL — SPA navigation staleness', () => {
  const cache = { source: 'youtube', data: { videoId: 'OLD_VIDEO', title: 'Old', author: 'A', lengthSeconds: 0, shortDescription: '', transcript: null } };
  const result = synthesizeSiteCache(cache, fakeMeta('https://www.youtube.com/watch?v=NEW_VIDEO'));
  assert.equal(result, null, 'stale cache (previous video) must be rejected so the correct video is fetched');
});

test('synthesizeSiteCache youtube: accepts cache when videoId is absent (old cache format without videoId)', () => {
  const cache = { source: 'youtube', data: { title: 'T', author: 'A', lengthSeconds: 0, shortDescription: '', transcript: null } };
  const result = synthesizeSiteCache(cache, fakeMeta('https://www.youtube.com/watch?v=abc123'));
  assert.ok(result, 'no videoId in cache — should degrade gracefully rather than rejecting');
});

test('synthesizeSiteCache youtube: accepts cache when URL has no v= param (non-watch page)', () => {
  const cache = { source: 'youtube', data: { videoId: 'abc123', title: 'T', author: 'A', lengthSeconds: 0, shortDescription: '', transcript: null } };
  const result = synthesizeSiteCache(cache, fakeMeta('https://www.youtube.com/channel/UCxxx'));
  assert.ok(result, 'no v= param in URL — should not reject');
});

// ── Bilibili ───────────────────────────────────────────────────────────────

test('synthesizeSiteCache bilibili: returns result when cached bvid matches current URL', () => {
  const cache = { source: 'bilibili', data: { bvid: 'BV1xx411c7mD', title: 'T', author: 'UP', upMid: 1, cid: 1, duration: 0, desc: '', stat: {} } };
  const result = synthesizeSiteCache(cache, fakeMeta('https://www.bilibili.com/video/BV1xx411c7mD'));
  assert.ok(result, 'should return a result when bvid matches');
  assert.equal(result.mode, 'bilibili');
});

test('synthesizeSiteCache bilibili: returns null (cache miss) when cached bvid differs from current URL — SPA navigation staleness', () => {
  const cache = { source: 'bilibili', data: { bvid: 'BV1oldOldOld', title: 'Old', author: 'UP', upMid: 1, cid: 1, duration: 0, desc: '', stat: {} } };
  const result = synthesizeSiteCache(cache, fakeMeta('https://www.bilibili.com/video/BV1newNewNew'));
  assert.equal(result, null, 'stale cache (previous video) must be rejected so the correct video is fetched');
});

test('synthesizeSiteCache bilibili: accepts cache when bvid is absent (old cache format)', () => {
  const cache = { source: 'bilibili', data: { title: 'T', author: 'UP', upMid: 1, cid: 1, duration: 0, desc: '', stat: {} } };
  const result = synthesizeSiteCache(cache, fakeMeta('https://www.bilibili.com/video/BV1xx411c7mD'));
  assert.ok(result, 'no bvid in cache — should degrade gracefully');
});

// ── Non-video sites unaffected ─────────────────────────────────────────────

test('synthesizeSiteCache juejin: not affected by the SPA staleness guard (no ID field configured)', () => {
  const cache = { source: 'juejin', data: {
    articleId: '1', title: 'Article', markContent: '# hi',
    author: 'A', tags: [], viewCount: 0, diggCount: 0, commentCount: 0, collectCount: 0
  }};
  const result = synthesizeSiteCache(cache, fakeMeta('https://juejin.cn/post/1'));
  assert.ok(result, 'juejin cache must still work — staleness guard only applies to YouTube/Bilibili');
});
