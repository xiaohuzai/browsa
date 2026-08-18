// test/attach-asr.test.mjs — end-to-end wiring test for the Bilibili ASR flow
// (火山方舟 Ark). Covers background.js's ATTACH_PAGE asr-pending detection +
// ATTACH_ASR_CONFIRM storage, mirroring attach-pdf-confirm.test.mjs's structure.
//
// The actual audio download/upload (MAIN-world) and Ark poll/transcribe are
// covered by test/lib-attach-asr.test.mjs. This file only covers the message
// wiring: bilibili-no-subtitle + ASR enabled -> asr-pending (deferred storage);
// ASR disabled -> normal store path; ATTACH_ASR_CONFIRM -> transcript stored
// with videoSrc stamped.

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
    _dump() { return store; },
  };
}

const BILI_URL = 'https://www.bilibili.com/video/BV1xx411c7mD';

function makeChrome(localArea, { transcript = null, hasAudio = true, hasFreshStreams = true } = {}) {
  const sessionArea = makeStorageArea();
  return {
    runtime: {
      onMessage: { addListener: () => {} },
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
      query: async () => [{ id: 1, url: BILI_URL, title: 'Test Video' }],
      get: async (id) => ({ id, url: BILI_URL, title: 'Test Video', favIconUrl: '' }),
    },
    sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
    webNavigation: {
      onHistoryStateUpdated: { addListener: () => {} },
      onCommitted: { addListener: () => {} },
      onBeforeNavigate: { addListener: () => {} },
    },
    scripting: {
      executeScript: async (opts) => {
        // On-demand content-script injection: no result.
        if (opts.files) return [{ result: undefined }];
        const body = opts.func?.toString() || '';
        // isPdfDocument probe: bilibili is not a PDF -> false (a truthy result
        // would make extractActiveTab treat the video page as a PDF and return
        // pdf-url instead of reaching the bilibili fallback).
        if (body.includes('document.contentType')) return [{ result: false }];
        if (body.includes('activeFetchBilibiliVideo')) {
          return [{ result: {
            bvid: 'BV1xx411c7mD', title: 'Test Video', upMid: 1, cid: 999,
            duration: 300, desc: 'some description', stat: {},
            ...(transcript ? { transcript } : {}),
          } }];
        }
        // The asr-pending ctx builder re-reads audio streams via the exposed reader.
        // Mock both window functions: __browsaFetchFreshBilibiliStreams (fresh
        // playurl, preferred) and __browsaGetBilibiliStreams (__playinfo__ fallback).
        // The injected func returns a bare streams array (fresh when available,
        // else the __playinfo__ cache).
        if (body.includes('__browsaGetBilibiliStreams')) {
          if (hasFreshStreams) {
            return [{ result: [
              { type: 'audio', label: '320 kbps', url: 'https://bilivideo.com/audio/fresh-320.m4s', bandwidth: 320000, hasAudio: true },
            ] }];
          }
          return [{ result: hasAudio
            ? [
                { type: 'audio', label: '192 kbps', url: 'https://bilivideo.com/audio/192.m4s', bandwidth: 192000, hasAudio: true },
                { type: 'audio', label: '64 kbps', url: 'https://bilivideo.com/audio/64.m4s', bandwidth: 64000, hasAudio: true },
              ]
            : [] }];
        }
        return [{ result: { text: 'mock content', rawTextLength: 12, wasCapped: false } }];
      },
    },
    cookies: {
      getAll: async () => [
        { name: 'SESSDATA', value: 'test-sessdata-httpOnly' },
        { name: 'buvid3', value: 'test-buvid' },
        { name: 'buvid4', value: 'test-buvid4' },
      ],
    },
    storage: { onChanged: { addListener: () => {} }, local: localArea, session: sessionArea },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
  };
}

let nextTabId = 500;

test('ATTACH_PAGE on a subtitle-less bilibili page + ASR enabled: returns asr-pending with audioUrl, NOT stored', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-0-lite-260428', language: 'zh', format: 'audio/x-m4a' },
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, { transcript: null }), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'asr-pending');
  assert.equal(res.ctx.audioUrl, 'https://bilivideo.com/audio/fresh-320.m4s', 'must prefer a FRESH playurl URL (cat-catch-aligned: __playinfo__ URLs expire within hours -> 403); must be re-signed at attach time');
  assert.equal(res.ctx.biliCookie, 'SESSDATA=test-sessdata-httpOnly; buvid3=test-buvid; buvid4=test-buvid4', 'must read the FULL B站 cookie set incl. HttpOnly SESSDATA via chrome.cookies (cat-catch uses webRequest to capture HttpOnly cookies; document.cookie can\'t)');
  assert.equal(res.ctx.asr.apiKey, 'ark-key');
  assert.equal(res.ctx.asr.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.ok(res.ctx.asr.timeoutMs > 0, 'timeoutMs must be passed to the sidepanel for polling');
  assert.equal(res.ctx.noTranscript, true, 'the structured noTranscript flag must survive to the asr-pending ctx');
  assert.ok((res.ctx.text || '').length > 0, 'fallback text must be preserved for fail-open');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 0, 'asr-pending must not be stored to history yet');
});

test('ATTACH_PAGE on a bilibili page WITH transcript: normal store path (no ASR)', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, { transcript: '[00:01] 有字幕' }), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.notEqual(res.ctx.mode, 'asr-pending', 'with transcript there must be no ASR handoff');
  assert.equal(res.ctx.mode, 'bilibili');
  assert.equal(res.ctx.noTranscript, false, 'noTranscript flag must be false when a transcript exists');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 1, 'normal store path stores the bilibili attach');
  assert.match(history.history[0].content, /Mode: bilibili/);
});

test('ATTACH_PAGE on a subtitle-less bilibili page + ASR DISABLED: normal store path', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: false, apiKey: '', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, { transcript: null }), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.notEqual(res.ctx.mode, 'asr-pending', 'ASR disabled -> no handoff');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 1, 'normal store path stores the bilibili text');
});

test('ATTACH_PAGE on a subtitle-less bilibili page + ASR DISABLED: flags noTranscriptHint so the sidepanel can prompt', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: false, apiKey: '', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, { transcript: null }), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.notEqual(res.ctx.mode, 'asr-pending', 'ASR disabled -> no handoff');
  assert.equal(res.ctx.noTranscript, true, 'noTranscript must survive');
  assert.equal(res.ctx.noTranscriptHint, true, 'ASR disabled + no subtitles -> hint flag set for the sidepanel');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 1, 'normal store path stores the bilibili text');
});

test('ATTACH_PAGE on a subtitle-less bilibili page + ASR enabled but NO audio stream: falls through to normal store', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, { transcript: null, hasAudio: false, hasFreshStreams: false }), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.notEqual(res.ctx.mode, 'asr-pending', 'no audio stream -> no ASR handoff');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 1, 'falls through to normal store');
});

test('ATTACH_ASR_CONFIRM: stores the transcript with videoSrc stamped for clickable [mm:ss]', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, {}), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const res = await handle({
    type: 'ATTACH_ASR_CONFIRM',
    text: '[00:00] 大家好\n[00:05] 欢迎收看本视频',
    metaUrl: BILI_URL,
    metaTitle: 'Test Video',
    tabId: 1,
  }, {});
  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.match(entry.content, /\[00:00\] 大家好/);
  assert.match(entry.content, /Mode: bilibili/);
  assert.ok(entry.videoSrc, 'videoSrc must be stamped so [mm:ss] is clickable');
  assert.equal(entry.videoSrc.platform, 'bilibili');
  assert.equal(entry.videoSrc.url, BILI_URL);
});

test('ATTACH_ASR_CONFIRM: no text -> {ok:false}', async () => {
  const localArea = makeStorageArea({});
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, {}), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const res = await handle({ type: 'ATTACH_ASR_CONFIRM', text: '', metaUrl: BILI_URL }, {});
  assert.equal(res.ok, false);
});
