// test/site-cache-registry.test.mjs — the site-cache registry's three tables and
// the cold-start restore path. They were untested together (2026-11-03): adding a
// site required touching SITE_CACHES + SITE_MESSAGE_MAP + SITE_HOSTS, and a miss on
// SITE_HOSTS silently re-armed the 2026-10-17 stale-shadow bug where a stale entry
// from the previous site in the tab shadowed the live one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const sessionStore = {};
const removed = [];
globalThis.chrome = {
  storage: {
    session: {
      get: async () => ({ ...sessionStore }),
      set: async (obj) => { Object.assign(sessionStore, obj); },
      remove: async (keys) => { for (const k of [].concat(keys)) { delete sessionStore[k]; removed.push(k); } },
    },
  },
  tabs: { query: async () => [] },
};

const {
  siteRegistrySummary, getSiteCache, recordSiteMessage, purgeTab, restoreSiteCachesFromSession,
} = await import('../lib/handlers/site-cache-store.js');

test('the three site tables name exactly the same sites', () => {
  const s = siteRegistrySummary();
  assert.deepEqual([...s.cacheKeys].sort(), [...s.hostKeys].sort(),
    'SITE_CACHES and SITE_HOSTS must agree — a cache with no host entry can never be selected by URL');
  assert.deepEqual([...s.messageSites].sort(), [...s.cacheKeys].sort(),
    'every push message must map onto a declared cache');
  assert.equal(s.messageKeys.length, s.messageSites.length, 'one message type per site (no duplicate handlers)');
  for (const [type, field] of Object.entries(s.messageFields)) {
    assert.ok(field && typeof field === 'string', `${type} must name the message field carrying its payload`);
  }
});

test('recordSiteMessage caches under the message table\'s field and persists to session', () => {
  recordSiteMessage({ type: 'YOUTUBE_DATA', video: { bvid: 'x' } }, 7);
  assert.deepEqual(getSiteCache(7, ''), { source: 'youtube', data: { bvid: 'x' } });
  assert.deepEqual(sessionStore.sc_7, { source: 'youtube', data: { bvid: 'x' } }, 'SW-sleep persistence mirrors the cache');
});

test('getSiteCache: a host-matched entry wins and a stale one from another host is dropped', () => {
  recordSiteMessage({ type: 'YOUTUBE_DATA', video: { title: 'stale' } }, 9);
  recordSiteMessage({ type: 'ZHIHU_CONTENT', content: { title: 'live' } }, 9);
  assert.deepEqual(getSiteCache(9, 'https://www.zhihu.com/question/1'), { source: 'zhihu', data: { title: 'live' } },
    'the entry matching the CURRENT host must win');
  // Asking for a host this tab has no entry for drops the mismatched ones instead
  // of falling back to "first registry hit wins" — that fallback IS the 2026-10-17
  // stale-shadow bug (the synthesizer would then reject the wrong source and the
  // attach silently degraded to an active fetch).
  assert.equal(getSiteCache(9, 'https://x.com/someone/status/1'), null,
    'a host with no cache for this tab must not fall back to another site\'s entry');
  assert.equal(getSiteCache(9, ''), null, 'the stale entries were removed, not parked for a later bare lookup');
});

test('purgeTab clears the tab from every cache and from session storage', () => {
  recordSiteMessage({ type: 'BILIBILI_VIDEO', video: { bvid: 'b' } }, 11);
  purgeTab(11);
  assert.equal(getSiteCache(11, ''), null, 'in-memory entry gone');
  assert.equal(sessionStore.sc_11, undefined, 'session copy gone');
});

test('restoreSiteCachesFromSession: dead tabs are dropped, live tabs are repopulated', async () => {
  globalThis.chrome.tabs.query = async () => [{ id: 21 }];
  sessionStore.sc_21 = { source: 'youtube', data: { restored: true } };
  sessionStore.sc_99 = { source: 'youtube', data: { dead: true } };
  sessionStore.sc_bad = { nope: true };
  await restoreSiteCachesFromSession();
  assert.deepEqual(getSiteCache(21, 'https://youtube.com/watch?v=1'), { source: 'youtube', data: { restored: true } },
    'a live tab\'s cache is restored');
  assert.equal(getSiteCache(99, ''), null, 'a closed tab\'s cache is not resurrected');
  assert.ok(removed.includes('sc_99'), 'the dead key is removed from session storage');
  assert.ok(removed.includes('sc_bad'), 'a malformed value is removed too');
});
