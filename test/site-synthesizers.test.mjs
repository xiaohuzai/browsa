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
import { synthesizeSiteCache, synthesizeTwitterResult, synthesizeRedditResult, synthesizeYouTubeResult, synthesizeXiaoyuzhouResult, isXiaoyuzhouEpisodeUrl } from '../lib/site-synthesizers.js';

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

// 小宇宙：节目页从不自带字幕文本——noTranscript 是 background ASR 移交条件的
// 结构化信号（播客恒可转写），与 youtube/bilibili 合成器同一契约。
test('xiaoyuzhou: synthesizes podcast meta and always sets noTranscript', () => {
  const meta = { url: 'https://www.xiaoyuzhoufm.com/episode/abc123', title: 'Ep 42' };
  const r = synthesizeXiaoyuzhouResult({
    podcast: '实验电台', title: '聊聊浏览器扩展', description: '本期聊了……', duration: 3725,
  }, meta);
  assert.equal(r.mode, 'xiaoyuzhou');
  assert.equal(r.articleTitle, '聊聊浏览器扩展');
  assert.ok(r.text.includes('**播客**: 实验电台'));
  assert.ok(r.text.includes('**时长**: 62:05'));
  assert.equal(r.noTranscript, true);
});

// ── 小宇宙 URL 兜底判定（拦截器缺席时 page-extractor 仍能认出节目页）──────────

test('isXiaoyuzhouEpisodeUrl: 节目 URL 判定矩阵（www/裸域、eid 长度、非节目路径、坏 URL）', () => {
  assert.equal(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/episode/6a97f287f03e74ee6b03ea5b'), true);
  assert.equal(isXiaoyuzhouEpisodeUrl('https://xiaoyuzhoufm.com/episode/6a97f287f03e74ee6b03ea5b'), true, '裸域也认');
  assert.equal(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/episode/abc123'), false, 'eid 过短');
  assert.equal(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/episode/6a97f287f03e74ee6b03ea5b/'), false, '带尾斜杠不是节目路径的精确形态');
  assert.equal(isXiaoyuzhouEpisodeUrl('https://www.xiaoyuzhoufm.com/podcast/abc123456789012345678'), false, '播客主页不是单集');
  assert.equal(isXiaoyuzhouEpisodeUrl('https://evil.com/episode/6a97f287f03e74ee6b03ea5b'), false, '白名单外域名拒绝');
  assert.equal(isXiaoyuzhouEpisodeUrl(''), false);
  assert.equal(isXiaoyuzhouEpisodeUrl(null), false);
});

test('synthesizeXiaoyuzhouResult: 拦截器缺席时的最小数据（仅 eid）也产出 noTranscript 交接形态', () => {
  const r = synthesizeXiaoyuzhouResult({ eid: '6a97f287f03e74ee6b03ea5b' }, { url: 'https://www.xiaoyuzhoufm.com/episode/6a97f287f03e74ee6b03ea5b', title: '某期节目' });
  assert.equal(r.mode, 'xiaoyuzhou');
  assert.equal(r.noTranscript, true, '播客恒无字幕 → ASR 移交条件恒成立');
  assert.equal(r.articleTitle, '');
  assert.equal(r.meta?.url, 'https://www.xiaoyuzhoufm.com/episode/6a97f287f03e74ee6b03ea5b', 'meta.url 透传——og:audio 兜底与 xy-<eid> 缓存键靠它');
});
