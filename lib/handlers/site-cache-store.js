// lib/handlers/site-cache-store.js — 站点结构化数据缓存 registry（C7 外迁）。
//
// 搬家前：这块 registry（缓存表 + 消息表 + session 持久化 + 清理）内联在
// background.js，正是当年判定「ATTACH_PAGE 内联（SITE_CACHES 纠缠）」的纠缠
// 本体；表驱动后 handle() 的 case 体只剩路由。xhsXhrCache 留在 background：
// 它的推送要摸 navPorts（特殊推送逻辑）。

const SITE_CACHES = {
  youtube:    new Map(), // YouTube video data
  juejin:     new Map(), // 掘金 article
  zhihu:      new Map(), // 知乎 article or Q&A
  dedao:      new Map(), // 得到 article
  geektime:   new Map(), // 极客时间 article
  bilibili:   new Map(), // Bilibili video data
  xueqiu:     new Map(), // 雪球 stock/post data
  twitter:    new Map(), // Twitter/X tweet data
  xiaoyuzhou: new Map(), // 小宇宙 podcast episode
};

// Maps each site content script's push-message type to which SITE_CACHES
// entry it writes and which field of the message carries the payload.
// Every entry here follows the exact same shape (SITE_CACHES[site].set(tabId,
// msg[field]); persistSiteCache(tabId, site, msg[field])) — the single
// generic case below in handle() replaces what used to be 9 near-identical
// copy-pasted case blocks. Adding a new site's push message only needs a
// new SITE_CACHES entry (above) plus one line here.
const SITE_MESSAGE_MAP = {
  YOUTUBE_DATA:       { site: 'youtube',    field: 'video' },
  JUEJIN_ARTICLE:     { site: 'juejin',     field: 'article' },
  ZHIHU_CONTENT:      { site: 'zhihu',      field: 'content' },
  DEDAO_ARTICLE:      { site: 'dedao',      field: 'article' },
  GEEKTIME_ARTICLE:   { site: 'geektime',   field: 'article' },
  BILIBILI_VIDEO:     { site: 'bilibili',   field: 'video' },
  XUEQIU_DATA:        { site: 'xueqiu',     field: 'data' },
  TWITTER_TWEET:      { site: 'twitter',    field: 'tweet' },
  XIAOYUZHOU_EPISODE: { site: 'xiaoyuzhou', field: 'episode' },
};


// Site caches above are module-level Maps that are wiped on every SW restart
// (~30s idle). Persist them to chrome.storage.session so they survive SW
// sleep/wake cycles within a browser session.
const SC_PREFIX = 'sc_';

export function persistSiteCache(tabId, source, data) {
  chrome.storage.session.set({ [`${SC_PREFIX}${tabId}`]: { source, data } }).catch(() => {});
}

export function clearSessionSiteCache(tabId) {
  chrome.storage.session.remove(`${SC_PREFIX}${tabId}`).catch(() => {});
}

export async function restoreSiteCachesFromSession() {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [key, val] of Object.entries(all)) {
      if (!key.startsWith(SC_PREFIX)) continue;
      const tabId = parseInt(key.slice(SC_PREFIX.length), 10);
      if (isNaN(tabId) || !val?.source || !val?.data) continue;
      SITE_CACHES[val.source]?.set(tabId, val.data);
    }
  } catch (_) {}
}

/** Return cached site data for a tab, regardless of which site it came from. */
export function getSiteCache(tabId) {
  for (const [source, cache] of Object.entries(SITE_CACHES)) {
    if (cache.has(tabId)) return { source, data: cache.get(tabId) };
  }
  return null;
}

/** 站点推送消息落缓存（9 个 SITE_MESSAGE_MAP case 的唯一实现）。 */
export function recordSiteMessage(msg, tabId) {
  if (tabId == null) return;
  const entry = SITE_MESSAGE_MAP[msg.type];
  if (!entry) return;
  const data = msg[entry.field];
  SITE_CACHES[entry.site].set(tabId, data);
  persistSiteCache(tabId, entry.site, data);
}

/** tab 关闭时清掉该 tab 的全部站点缓存（内存表 + session 持久化）。 */
export function purgeTab(tabId) {
  for (const cache of Object.values(SITE_CACHES)) cache.delete(tabId);
  clearSessionSiteCache(tabId);
}
