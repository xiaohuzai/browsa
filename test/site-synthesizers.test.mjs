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
import { synthesizeSiteCache, synthesizeTwitterResult, synthesizeRedditResult, synthesizeYouTubeResult } from '../lib/site-synthesizers.js';

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

test('synthesizeTwitterResult: single tweet keeps the compact shape (no replies section)', () => {
  const result = synthesizeTwitterResult({ author: 'Alice', screenName: 'alice', text: 'hello world', likes: 5, retweets: 2, replies: 1, quotes: 0 }, fakeMeta('https://x.com/alice/status/1'));
  assert.equal(result.mode, 'twitter');
  assert.match(result.text, /\*\*作者\*\*: Alice @alice/);
  assert.match(result.text, /hello world/);
  assert.match(result.text, /5 喜欢/);
  assert.doesNotMatch(result.text, /## 回复/);
});

test('synthesizeTwitterResult: includes the visible replies as a numbered conversation', () => {
  const result = synthesizeTwitterResult({
    author: 'Alice', screenName: 'alice', text: 'main tweet', likes: 10, retweets: 3, repliesCount: 2, quotes: 1,
    replies: [
      { text: 'reply one', author: 'Bob', screenName: 'bob', likes: 1, retweets: 0 },
      { text: 'reply two', author: 'Carol', screenName: 'carol', likes: 0, retweets: 0 },
    ]
  }, fakeMeta('https://x.com/alice/status/1'));
  assert.match(result.text, /main tweet/);
  assert.match(result.text, /## 回复/);
  assert.match(result.text, /1\. \*\*Bob @bob\*\*: reply one/);
  assert.match(result.text, /2\. \*\*Carol @carol\*\*: reply two/);
});

test('synthesizeTwitterResult: handles old XHR shape without a replies array (stats use data.replies)', () => {
  const result = synthesizeTwitterResult({ author: 'A', screenName: 'a', text: 'old shape', likes: 0, retweets: 0, replies: 7, quotes: 0 }, fakeMeta('https://x.com/a/status/1'));
  assert.match(result.text, /7 回复/);
  assert.doesNotMatch(result.text, /## 回复/);
});

test('synthesizeRedditResult: emits title, meta line, body, and a ## 评论 comment tree with depth', () => {
  const result = synthesizeRedditResult({
    post: { title: 'Big issue', subreddit: 'opencodeCLI', author: 'Meshyai', selftext: 'the body text', score: 120, numComments: 14 },
    comments: [
      { author: 'Alice', score: 5, depth: 0, text: 'top comment' },
      { author: 'Bob', score: 2, depth: 1, text: 'nested reply' },
    ],
  }, fakeMeta('https://www.reddit.com/user/Meshyai/'));
  assert.equal(result.mode, 'reddit');
  assert.match(result.text, /# Big issue/);
  assert.match(result.text, /r\/opencodeCLI · u\/Meshyai · 120 分 · 14 条评论/);
  assert.match(result.text, /the body text/);
  assert.match(result.text, /## 评论/);
  assert.match(result.text, /\*\*Alice\*\* \(5\): top comment/);
  assert.match(result.text, /  \*\*Bob\*\* \(2\): nested reply/, 'depth-1 comment indented');
});

test('synthesizeRedditResult: degrades gracefully when post/comments are missing', () => {
  const result = synthesizeRedditResult({}, fakeMeta('https://www.reddit.com/'));
  assert.equal(result.text, '', 'empty input -> empty text, no throw');
});

test('synthesizeYouTubeResult: sets the structured noTranscript flag when there is no transcript (ASR detection)', () => {
  const noSubs = synthesizeYouTubeResult({ videoId: 'abc', title: 'T', author: 'A', lengthSeconds: 0, shortDescription: '', transcript: null }, fakeMeta('https://www.youtube.com/watch?v=abc'));
  assert.equal(noSubs.noTranscript, true, 'no transcript -> noTranscript=true so ASR detection keys off the structured flag (Jina fallback can rewrite the text marker)');
  const withSubs = synthesizeYouTubeResult({ videoId: 'abc', title: 'T', author: 'A', lengthSeconds: 0, shortDescription: '', transcript: '[00:00] hi' }, fakeMeta('https://www.youtube.com/watch?v=abc'));
  assert.equal(withSubs.noTranscript, false, 'with transcript -> noTranscript=false');
});

test('synthesizeSiteCache: rejects a cache whose source site does not match the current page (cross-tab-navigation staleness)', async () => {
  const { synthesizeSiteCache } = await import('../lib/site-synthesizers.js');
  // Same tab visited Zhihu earlier, then a Bilibili video: the tabId-keyed
  // cache still holds Zhihu data and must NOT be synthesized for the
  // Bilibili page.
  const res = synthesizeSiteCache({ source: 'zhihu', data: { foo: 'bar' } }, { url: 'https://www.bilibili.com/video/BV1x' });
  assert.equal(res, null, 'zhihu cache must not serve a bilibili page');
  const res2 = synthesizeSiteCache({ source: 'bilibili', data: { foo: 'bar' } }, { url: 'https://zhihu.com/question/1' });
  assert.equal(res2, null, 'bilibili cache must not serve a zhihu page');
});
