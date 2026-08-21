// lib/site-synthesizers.js — turns cached XHR data from browsa's 9
// SITE_CACHES-backed sites (YouTube/掘金/知乎/得到/极客时间/Bilibili/雪球/
// Twitter/小宇宙) into the same {meta, mode, text, articleTitle,
// articleByline?, truncated} shape Readability/DOM extraction returns, so
// downstream code in page-extractor.js/background.js is agnostic to which
// path produced a result. Extracted out of page-extractor.js (previously
// its single largest, most mixed-responsibility file) since none of these
// are MAIN-world-injected functions — unlike the extraction functions that
// stay in page-extractor.js, these run in the normal extension context and
// have no "must be self-contained for chrome.scripting.executeScript"
// constraint, so factoring them into their own module (and testing them
// independently of the MAIN-world extraction logic) is safe.
//
// XHS is deliberately NOT here — it uses a separate xhsXhrCache Map with its
// own synthesis logic (synthesizeXhsResultFromXhr, now in
// lib/xhs-extractor.js), not the SITE_CACHES/synthesizeSiteCache dispatch this
// file covers.

// All 9 site synthesize*Result functions below build the same result shape
// (meta/mode/text/articleTitle/[articleByline]/truncated) from very
// different per-site field lists -- only this trailing shape is shared, so
// it's factored out here rather than duplicated 9 times. `truncated` is
// always `wasCapped: false` because these synthesized texts are built from
// already-small structured API responses, never subject to the same
// character-cap truncation the generic Readability/DOM-tree paths apply.
function makeSynthResult(mode, meta, text, extra = {}) {
  return {
    meta, mode, text, ...extra,
    truncated: { rawTextLength: text.length, textLength: text.length, wasCapped: false }
  };
}

// 6 of the 9 synthesize functions share the same title/byline field names —
// factored out so the extraction stays in one place instead of being repeated
// as an inline object literal 6 times.
function byAuthor(data) {
  return { articleTitle: data.title || '', articleByline: data.author || '' };
}

// Formats a total-seconds count as mm:ss (used by YouTube, Bilibili,
// Xiaoyuzhou — all three had identical inline ternary/padStart expressions).
function formatMmSs(totalSeconds) {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

export function synthesizeYouTubeResult(data, meta) {
  const duration = data.lengthSeconds > 0 ? formatMmSs(data.lengthSeconds) : '';
  const parts = [];
  if (data.author) parts.push(`**Channel**: ${data.author}${data.subsText ? ` (${data.subsText})` : ''}`);
  if (data.title) parts.push(`# ${data.title}`);

  const stats = [];
  if (data.viewsText)   stats.push(data.viewsText);
  if (data.likesText)   stats.push(`👍 ${data.likesText}`);
  if (duration)         stats.push(`时长 ${duration}`);
  if (data.publishDate) stats.push(data.publishDate);
  if (data.category)    stats.push(data.category);
  if (stats.length) parts.push(stats.join(' | '));

  if (data.shortDescription) parts.push(`**Description**: ${data.shortDescription}`);
  if (Array.isArray(data.keywords) && data.keywords.length > 0) {
    parts.push(`**Tags**: ${data.keywords.join(', ')}`);
  }
  if (Array.isArray(data.chapters) && data.chapters.length > 1) {
    parts.push(`## Chapters\n\n${data.chapters.join('\n')}`);
  }
  if (data.transcript) {
    parts.push(`## Transcript\n\n${data.transcript}`);
  } else {
    parts.push('*(No captions available for this video)*');
  }
  const text = parts.join('\n\n');
  return makeSynthResult('youtube', meta, text, byAuthor(data));
}

export function synthesizeJuejinResult(data, meta) {
  const parts = [];
  if (data.author)         parts.push(`**作者**: ${data.author}`);
  if (data.title)          parts.push(`# ${data.title}`);
  if (data.markContent)    parts.push(data.markContent);
  if (data.tags?.length)   parts.push('Tags: ' + data.tags.map(t => '#' + t).join(' '));
  const stats = [];
  if (data.viewCount)    stats.push(`👁 ${data.viewCount}`);
  if (data.diggCount)    stats.push(`👍 ${data.diggCount}`);
  if (data.commentCount) stats.push(`💬 ${data.commentCount}`);
  if (stats.length) parts.push(stats.join('  ·  '));
  const text = parts.join('\n\n');
  return makeSynthResult('juejin', meta, text, byAuthor(data));
}

export function synthesizeZhihuResult(data, meta) {
  const parts = [];
  if (data.author) parts.push(`**作者**: ${data.author}`);
  if (data.title)  parts.push(`# ${data.title}`);
  if (data.text)   parts.push(data.text);
  const stats = [];
  if (data.voteupCount)  stats.push(`👍 ${data.voteupCount}`);
  if (data.commentCount) stats.push(`💬 ${data.commentCount}`);
  if (stats.length) parts.push(stats.join('  ·  '));
  // Q&A: append top answers
  if (data.type === 'question' && data.answers?.length) {
    parts.push('\n## 高赞回答');
    for (const ans of data.answers.slice(0, 3)) {
      parts.push(`### ${ans.author}（👍 ${ans.voteupCount}）\n\n${ans.text}`);
    }
  }
  const text = parts.join('\n\n');
  return makeSynthResult('zhihu', meta, text, byAuthor(data));
}

export function synthesizeDedaoResult(data, meta) {
  const parts = [];
  if (data.author)  parts.push(`**作者**: ${data.author}`);
  if (data.title)   parts.push(`# ${data.title}`);
  if (data.content) parts.push(data.content);
  const text = parts.join('\n\n');
  return makeSynthResult('dedao', meta, text, byAuthor(data));
}

export function synthesizeGeektimeResult(data, meta) {
  const parts = [];
  if (data.author)  parts.push(`**作者**: ${data.author}`);
  if (data.title)   parts.push(`# ${data.title}`);
  if (data.summary) parts.push(`> ${data.summary}`);
  if (data.text)    parts.push(data.text);
  const text = parts.join('\n\n');
  return makeSynthResult('geektime', meta, text, byAuthor(data));
}

export function synthesizeBilibiliResult(data, meta) {
  const parts = [];
  if (data.author) parts.push(`**UP主**: ${data.author}`);
  if (data.title)  parts.push(`# ${data.title}`);
  if (data.tname)  parts.push(`**分区**: ${data.tname}`);
  if (data.desc)   parts.push(data.desc);
  const duration = data.duration > 0 ? formatMmSs(data.duration) : '';
  const stats = [];
  if (data.stat?.view)     stats.push(`${data.stat.view.toLocaleString()} 播放`);
  if (data.stat?.like)     stats.push(`${data.stat.like.toLocaleString()} 点赞`);
  if (data.stat?.coin)     stats.push(`${data.stat.coin.toLocaleString()} 投币`);
  if (data.stat?.favorite) stats.push(`${data.stat.favorite.toLocaleString()} 收藏`);
  if (duration)            stats.push(`时长 ${duration}`);
  if (stats.length) parts.push(stats.join(' | '));
  if (data.summary) parts.push(`## B站AI总结\n\n${data.summary}`);
  if (data.transcript) {
    parts.push(`## 字幕\n\n${data.transcript}`);
  }
  const text = parts.join('\n\n');
  // noTranscript flag: ASR detection keys off this structured field rather than
  // the `## 字幕` text marker — auto mode's silent Jina fallback can rewrite
  // ctx.text (a subtitle-less bilibili synthesis is <200 chars, so Jina fires),
  // silently dropping the marker. Object.assign in background.js's Jina branch
  // preserves this flag across the rewrite.
  return makeSynthResult('bilibili', meta, text, { ...byAuthor(data), noTranscript: !data.transcript });
}

export function synthesizeXueqiuResult(data, meta) {
  const parts = [];
  if (data.type === 'stock') {
    parts.push(`# ${data.name} (${data.symbol})`);
    if (data.exchange) parts.push(`**交易所**: ${data.exchange}`);
    const priceStats = [];
    if (data.current !== undefined) priceStats.push(`现价: ${data.current}`);
    if (data.percent !== undefined) priceStats.push(`涨跌幅: ${(+data.percent).toFixed(2)}%`);
    if (data.open !== undefined)    priceStats.push(`开盘: ${data.open}`);
    if (data.high !== undefined)    priceStats.push(`最高: ${data.high}`);
    if (data.low !== undefined)     priceStats.push(`最低: ${data.low}`);
    if (data.pe !== undefined && data.pe !== null) priceStats.push(`PE(TTM): ${(+data.pe).toFixed(2)}`);
    if (priceStats.length) parts.push(priceStats.join(' | '));
    if (data.marketCapital) parts.push(`**总市值**: ${(data.marketCapital / 1e8).toFixed(2)} 亿`);
    if (data.orgName) parts.push(data.orgName);
  } else if (data.type === 'post') {
    if (data.author) parts.push(`**作者**: ${data.author}`);
    if (data.title)  parts.push(`# ${data.title}`);
    if (data.text)   parts.push(data.text);
    const stats = [];
    if (data.likes)    stats.push(`${data.likes} 点赞`);
    if (data.comments) stats.push(`${data.comments} 评论`);
    if (stats.length) parts.push(stats.join(' | '));
  }
  const text = parts.join('\n\n');
  return makeSynthResult('xueqiu', meta, text, { articleTitle: data.name || data.title || '' });
}

export function synthesizeTwitterResult(data, meta) {
  const parts = [];
  const author = [data.author, data.screenName ? `@${data.screenName}` : ''].filter(Boolean).join(' ');
  if (author) parts.push(`**作者**: ${author}`);
  if (data.text) parts.push(data.text);
  const stats = [];
  if (data.likes)    stats.push(`${data.likes} 喜欢`);
  if (data.retweets) stats.push(`${data.retweets} 转推`);
  if (data.repliesCount || data.replies) stats.push(`${data.repliesCount || data.replies} 回复`);
  if (data.quotes)   stats.push(`${data.quotes} 引用`);
  if (stats.length) parts.push(stats.join(' | '));
  // Conversation: the replies visible on the tweet detail page, in order.
  // The passive XHR interceptor used to deliver only the single main tweet;
  // the active fallback (activeXFetch) also returns the visible thread so the
  // model sees the replies, not just the parent tweet.
  const replies = Array.isArray(data.replies) ? data.replies : [];
  if (replies.length) {
    const replyLines = replies.map((r, i) => {
      const who = [r.author, r.screenName ? `@${r.screenName}` : ''].filter(Boolean).join(' ');
      return `${i + 1}. ${who ? `**${who}**: ` : ''}${r.text || ''}`;
    });
    parts.push(`## 回复\n${replyLines.join('\n')}`);
  }
  const text = parts.join('\n\n');
  return makeSynthResult('twitter', meta, text, { articleTitle: data.text?.slice(0, 80) || '', articleByline: data.author || '' });
}

export function synthesizeRedditResult(data, meta) {
  const parts = [];
  const post = data?.post || {};
  const title = post.title || '';
  if (title) parts.push(`# ${title}`);
  const metaBits = [];
  if (post.subreddit) metaBits.push(post.subreddit.startsWith('r/') ? post.subreddit : `r/${post.subreddit}`);
  if (post.author)    metaBits.push(`u/${post.author}`);
  if (post.score)     metaBits.push(`${post.score} 分`);
  if (post.numComments) metaBits.push(`${post.numComments} 条评论`);
  if (metaBits.length) parts.push(metaBits.join(' · '));
  if (post.selftext) parts.push(post.selftext);
  // Comments in tree order, indented by depth (Reddit nests replies).
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  if (comments.length) {
    const lines = comments.map((c) => {
      const who = c.author ? `**${c.author}**${c.score ? ` (${c.score})` : ''}: ` : '';
      const indent = '  '.repeat(Math.min(c.depth || 0, 6));
      return `${indent}${who}${c.text || ''}`;
    });
    parts.push(`## 评论\n${lines.join('\n')}`);
  }
  const text = parts.join('\n\n');
  return makeSynthResult('reddit', meta, text, { articleTitle: title.slice(0, 80) || '', articleByline: post.author || '' });
}

export function synthesizeXiaoyuzhouResult(data, meta) {
  const parts = [];
  if (data.podcast) parts.push(`**播客**: ${data.podcast}`);
  if (data.title)   parts.push(`# ${data.title}`);
  if (data.description) parts.push(data.description);
  if (data.duration > 0) {
    parts.push(`**时长**: ${formatMmSs(data.duration)}`);
  }
  const text = parts.join('\n\n');
  return makeSynthResult('xiaoyuzhou', meta, text, { articleTitle: data.title || '' });
}

/** Dispatch siteCache to the right synthesis function based on source tag. */
// Extract the URL query param that identifies the specific content for a given
// site — used by synthesizeSiteCache to detect SPA navigation cache staleness.
// Returns the ID string, or null if not applicable / not extractable.
function currentPageId(source, url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (source === 'youtube')  return u.searchParams.get('v');
    if (source === 'bilibili') return (u.pathname.match(/\/(BV[A-Za-z0-9]+)/) || [])[1] || null;
  } catch (_) {}
  return null;
}

// Extract the content ID that was cached — the field name differs by site.
function cachedPageId(source, data) {
  if (source === 'youtube')  return data.videoId || null;
  if (source === 'bilibili') return data.bvid || null;
  return null;
}

export function synthesizeSiteCache(siteCache, meta) {
  if (!siteCache?.data) return null;
  // Guard against SPA navigation: both YouTube and Bilibili are SPAs where the
  // user can switch to a different video without a full page load. The cache is
  // keyed by tabId, so if the intercepted XHR hasn't fired yet for the new
  // video, the cache still holds the previous one's data. Reject the cache hit
  // when the cached content ID doesn't match the current page URL.
  const cachedId  = cachedPageId(siteCache.source, siteCache.data);
  const currentId = currentPageId(siteCache.source, meta?.url);
  if (cachedId && currentId && cachedId !== currentId) return null;

  switch (siteCache.source) {
    case 'youtube':    return synthesizeYouTubeResult(siteCache.data, meta);
    case 'juejin':     return synthesizeJuejinResult(siteCache.data, meta);
    case 'zhihu':      return synthesizeZhihuResult(siteCache.data, meta);
    case 'dedao':      return synthesizeDedaoResult(siteCache.data, meta);
    case 'geektime':   return synthesizeGeektimeResult(siteCache.data, meta);
    case 'bilibili':   return synthesizeBilibiliResult(siteCache.data, meta);
    case 'xueqiu':     return synthesizeXueqiuResult(siteCache.data, meta);
    case 'twitter':    return synthesizeTwitterResult(siteCache.data, meta);
    case 'xiaoyuzhou': return synthesizeXiaoyuzhouResult(siteCache.data, meta);
    default: return null;
  }
}
