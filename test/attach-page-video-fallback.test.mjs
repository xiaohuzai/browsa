// test/attach-page-video-fallback.test.mjs
//
// Regression: tryYoutubeActiveFallback / tryBilibiliActiveFallback used to
// rely on the content script having been injected at document_start (manifest
// registration). Tabs opened before the extension was installed/reloaded
// therefore silently fell back to a DOM-tree extraction even on video pages.
//
// Fix: inject the script on-demand via `files:` parameter (Chrome handles
// deduplication) before calling the extraction function, so the active fallback
// always works regardless of when the tab was opened.
//
// These tests assert that ATTACH_PAGE on a YouTube/Bilibili URL triggers an
// executeScript call that carries `files` (the on-demand injection) rather
// than the old `typeof activeYouTubeFetch !== 'function'` guard pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeStorageArea(initial = {}) {
  let store = { ...initial };
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      return { ...store };
    },
    async set(obj) { store = { ...store, ...obj }; },
    async remove(key) { delete store[key]; },
    _set(obj) { store = { ...store, ...obj }; },
  };
}

const localArea = makeStorageArea({
  activeProvider: 'compatible',
  providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
  autoSummarizeAttachments: false,
});
const sessionArea = makeStorageArea();

let executeScriptCalls = [];

const chromeMock = {
  runtime: {
    onMessage: { _listeners: [], addListener(fn) { this._listeners.push(fn); }, removeListener(fn) { this._listeners = this._listeners.filter(l => l !== fn); } },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => null,
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=abc123', title: 'Test Video' }],
    get: async (id) => ({ id, url: 'https://www.youtube.com/watch?v=abc123', title: 'Test Video', favIconUrl: '' }),
  },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (opts) => {
      executeScriptCalls.push(opts);
      // When the bridge file is injected, simulate sendMessage with the fake result.
      // files injection: return nothing (void)
      if (opts.files) return [{ result: undefined }];
      // probe calls
      const body = opts.func?.toString() || '';
      if (body.includes('contentType') || body.includes('Readability') || body.includes('Turndown')) {
        return [{ result: false }];
      }
      if (opts.func?.name === 'preExtractCleanup') return [{ result: {} }];
      // YouTube activeYouTubeFetch() call
      if (body.includes('activeYouTubeFetch')) {
        return [{ result: {
          videoId: 'abc123', title: 'Test Video', author: 'Channel',
          lengthSeconds: 300, shortDescription: 'desc', transcript: '[00:01] hello',
          chapters: null, rawAt: Date.now()
        } }];
      }
      // Bilibili active fetch func
      if (body.includes('activeFetchBilibiliVideo')) {
        return [{ result: {
          bvid: 'BV1xx411c7mD', title: 'Test', upMid: 1, cid: 999,
          duration: 300, desc: 'desc', transcript: '[00:01] 测试', stat: {}
        } }];
      }
      // generic extraction fallback
      return [{ result: { text: 'mock content', rawTextLength: 12, wasCapped: false } }];
    },
  },
  storage: {
    onChanged: { addListener: () => {} },
    local: localArea,
    session: sessionArea,
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
};

Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true, configurable: true });

const { handle } = await import('../background.js');

test('YouTube active fallback: injects content script (MAIN) then calls activeYouTubeFetch()', async () => {
  executeScriptCalls = [];
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 1, mode: 'auto' }, { tab: { id: 1 } });
  assert.equal(res.ok, true);
  const fileInjections = executeScriptCalls.filter((c) => Array.isArray(c.files));
  assert.ok(
    fileInjections.some((c) => c.files.some((f) => f.includes('youtube-content-script.js'))),
    'must inject youtube-content-script.js'
  );
});

// Bilibili variant — re-use same chrome mock with a bilibili URL
test('Bilibili active fallback: injects content script file on-demand before calling the function', async () => {
  // Override tabs mock to return a bilibili URL
  chromeMock.tabs.query = async () => [{ id: 2, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: 'Test' }];
  chromeMock.tabs.get = async (id) => ({ id, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: 'Test', favIconUrl: '' });
  chromeMock.scripting.executeScript = async (opts) => {
    executeScriptCalls.push(opts);
    if (opts.files) return [{ result: undefined }];
    const body = opts.func?.toString() || '';
    if (body.includes('contentType') || body.includes('Readability') || body.includes('Turndown')) return [{ result: false }];
    if (opts.func?.name === 'preExtractCleanup') return [{ result: {} }];
    if (body.includes('activeFetchBilibiliVideo')) {
      return [{ result: { bvid: 'BV1xx411c7mD', title: 'Test', upMid: 1, cid: 999, duration: 300, desc: 'desc', transcript: '[00:01] 测试', stat: {} } }];
    }
    return [{ result: { text: 'mock content', rawTextLength: 12, wasCapped: false } }];
  };

  executeScriptCalls = [];
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 2, mode: 'auto' }, { tab: { id: 2 } });
  assert.equal(res.ok, true);
  const fileInjections = executeScriptCalls.filter((c) => Array.isArray(c.files));
  assert.ok(
    fileInjections.some((c) => c.files.some((f) => f.includes('bilibili-content-script.js'))),
    'must inject bilibili-content-script.js'
  );
});

// X/Twitter variant: the passive interceptor never runs in MAIN world (chrome.runtime
// is undefined there — same lesson as YouTube), so SITE_CACHES.twitter is never
// populated and tweet pages would otherwise fall through to the generic DOM dump.
// The active fallback must inject twitter-content-script.js on-demand and call
// activeXFetch(), then synthesize the tweet conversation.
test('X/Twitter active fallback: injects content script then calls activeXFetch and synthesizes the tweet', async () => {
  chromeMock.tabs.query = async () => [{ id: 3, url: 'https://x.com/jayair/status/2090596382306361380', title: 'Tweet' }];
  chromeMock.tabs.get = async (id) => ({ id, url: 'https://x.com/jayair/status/2090596382306361380', title: 'Tweet', favIconUrl: '' });
  chromeMock.scripting.executeScript = async (opts) => {
    executeScriptCalls.push(opts);
    if (opts.files) return [{ result: undefined }];
    const body = opts.func?.toString() || '';
    if (body.includes('contentType') || body.includes('Readability') || body.includes('Turndown')) return [{ result: false }];
    if (opts.func?.name === 'preExtractCleanup') return [{ result: {} }];
    if (body.includes('activeXFetch')) {
      return [{ result: {
        tweetId: '2090596382306361380', text: 'Okay let me tell you about what is happening',
        author: 'Jay', screenName: 'jayair', likes: 1115, retweets: 79, repliesCount: 65, quotes: 171,
        replies: [{ text: 'a reply', author: 'Bob', screenName: 'bob' }],
      } }];
    }
    return [{ result: { text: 'mock content', rawTextLength: 12, wasCapped: false } }];
  };

  executeScriptCalls = [];
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 3, mode: 'reader' }, { tab: { id: 3 } });
  assert.equal(res.ok, true);
  const fileInjections = executeScriptCalls.filter((c) => Array.isArray(c.files));
  assert.ok(
    fileInjections.some((c) => c.files.some((f) => f.includes('twitter-content-script.js'))),
    'must inject twitter-content-script.js'
  );
  // The stored history entry must carry the tweet text (not a DOM dump) and the reply.
  const history = await chromeMock.storage.local.get('history');
  const joined = JSON.stringify(history);
  assert.match(joined, /Okay let me tell you about what is happening/, 'main tweet text must be in the attached content');
  assert.match(joined, /@jayair/, 'author handle must be in the attached content');
  assert.match(joined, /a reply/, 'the visible reply must be in the attached content');
});

// Reddit variant: no passive interceptor exists (componentized SPA), so pages
// fell through to the generic DOM dump with all the chrome (skip links, vote
// buttons, ads, footer, SML.load noise). The active fallback must inject
// reddit-content-script.js and call activeRedditFetch(), then synthesize a
// clean post + comments.
test('Reddit active fallback: injects content script then calls activeRedditFetch and synthesizes the post', async () => {
  chromeMock.tabs.query = async () => [{ id: 4, url: 'https://www.reddit.com/user/Meshyai/', title: 'Meshyai' }];
  chromeMock.tabs.get = async (id) => ({ id, url: 'https://www.reddit.com/user/Meshyai/', title: 'Meshyai', favIconUrl: '' });
  chromeMock.scripting.executeScript = async (opts) => {
    executeScriptCalls.push(opts);
    if (opts.files) return [{ result: undefined }];
    const body = opts.func?.toString() || '';
    if (body.includes('contentType') || body.includes('Readability') || body.includes('Turndown')) return [{ result: false }];
    if (opts.func?.name === 'preExtractCleanup') return [{ result: {} }];
    if (body.includes('activeRedditFetch')) {
      return [{ result: {
        post: { postId: 'abc123', title: 'Big issue with new post training', subreddit: 'opencodeCLI', author: 'Meshyai', selftext: 'Hi, so I am working on my own set of custom tools.', score: 120, numComments: 14 },
        comments: [{ author: 'EndlessZone123', score: 5, depth: 0, text: 'cant fail toolcalling if it never uses new tools' }],
      } }];
    }
    return [{ result: { text: 'mock content', rawTextLength: 12, wasCapped: false } }];
  };

  executeScriptCalls = [];
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 4, mode: 'reader' }, { tab: { id: 4 } });
  assert.equal(res.ok, true);
  const fileInjections = executeScriptCalls.filter((c) => Array.isArray(c.files));
  assert.ok(
    fileInjections.some((c) => c.files.some((f) => f.includes('reddit-content-script.js'))),
    'must inject reddit-content-script.js'
  );
  const history = await chromeMock.storage.local.get('history');
  const joined = JSON.stringify(history);
  assert.match(joined, /Big issue with new post training/, 'post title must be in the attached content');
  assert.match(joined, /u\/Meshyai/, 'author must be in the attached content');
  assert.match(joined, /## 评论/, 'a comments section must be emitted');
  assert.match(joined, /cant fail toolcalling/, 'the comment text must be in the attached content');
});
