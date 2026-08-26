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
const YT_URL = 'https://www.youtube.com/watch?v=abc123XYZ';

function makeChrome(localArea, { transcript = null, hasAudio = true, hasFreshStreams = true, ytTranscript = null, ytHasStreams = true, pageUrl = BILI_URL } = {}) {
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
      query: async () => [{ id: 1, url: pageUrl, title: 'Test Video' }],
      get: async (id) => ({ id, url: pageUrl, title: 'Test Video', favIconUrl: '' }),
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
        if (body.includes('activeYouTubeFetch')) {
          return [{ result: {
            videoId: 'abc123XYZ', title: 'YouTube Test Video', author: 'Test Channel',
            lengthSeconds: 300, shortDescription: 'desc',
            ...(ytTranscript ? { transcript: ytTranscript } : {}),
          } }];
        }
        // The asr-pending ctx builder re-reads audio streams via the exposed reader.
        // Mock both window functions: __browsaFetchFreshBilibiliStreams (fresh
        // playurl) and __browsaGetBilibiliStreams (__playinfo__ cache). The injected
        // func returns { streams, videoDurationSec } — videoDurationSec (video true
        // length) is the reference for rejecting truncated audio streams.
        if (body.includes('__browsaGetBilibiliStreams')) {
          if (hasFreshStreams) {
            return [{ result: {
              streams: [
                { type: 'audio', label: '320 kbps', url: 'https://bilivideo.com/audio/fresh-320.m4s', bandwidth: 320000, hasAudio: true, duration: 300, size: 12_000_000 },
              ],
              videoDurationSec: 300,
            } }];
          }
          return [{ result: hasAudio
            ? {
                streams: [
                  { type: 'audio', label: '192 kbps', url: 'https://bilivideo.com/audio/192.m4s', bandwidth: 192000, hasAudio: true, duration: 300, size: 7_200_000 },
                  { type: 'audio', label: '64 kbps', url: 'https://bilivideo.com/audio/64.m4s', bandwidth: 64000, hasAudio: true, duration: 300, size: 2_400_000 },
                ],
                videoDurationSec: 300,
              }
            : { streams: [], videoDurationSec: 0 } }];
        }
        // YouTube fresh audio-stream fetch for ASR (window.__browsaFetchFreshYouTubeStreams).
        if (body.includes('__browsaFetchFreshYouTubeStreams')) {
          if (!ytHasStreams) {
            return [{ result: { streams: [], videoDurationSec: 300, asrExpiredError: 'player 返回空音频流列表' } }];
          }
          return [{ result: {
            streams: [
              { type: 'audio', label: '128 kbps', url: 'https://rr2---sn.googlevideo.com/videoplayback?pot=abc&itag=140', bandwidth: 128000, hasAudio: true, duration: 0, size: 4_800_000, codecs: 'mp4a.40.2', id: 140 },
              { type: 'audio', label: '70 kbps', url: 'https://rr2---sn.googlevideo.com/videoplayback?pot=def&itag=139', bandwidth: 70000, hasAudio: true, duration: 0, size: 2_600_000, codecs: 'opus', id: 139 },
            ],
            videoDurationSec: 300,
          } }];
        }
        return [{ result: { text: 'mock content', rawTextLength: 12, wasCapped: false } }];
      },
    },
    cookies: {
      getAll: async ({ url }) => {
        if (String(url).includes('youtube.com')) {
          return [
            { name: 'SID', value: 'yt-sid-httpOnly' },
            { name: 'VISITOR_INFO1_LIVE', value: 'yt-visitor' },
            { name: 'CONSENT', value: 'yt-consent' },
          ];
        }
        return [
          { name: 'SESSDATA', value: 'test-sessdata-httpOnly' },
          { name: 'buvid3', value: 'test-buvid' },
          { name: 'buvid4', value: 'test-buvid4' },
        ];
      },
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

test('ATTACH_PAGE on a bilibili page WITH transcript + ASR subtitleSource=asr: asr-pending handoff (replace low-quality subtitles)', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a', subtitleSource: 'asr' },
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, { transcript: '[00:01] 有字幕（但质量不高）' }), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'asr-pending', 'subtitleSource=asr must override the has-transcript guard and hand off to ASR');
  assert.equal(res.ctx.noTranscript, false, 'noTranscript stays false (video does have subtitles)');
  assert.equal(res.ctx.asr.subtitleSource, 'asr', 'subtitleSource must flow through to the sidepanel');
  assert.ok((res.ctx.text || '').length > 0, 'fallback text (with original subtitles) must be preserved for fail-open');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 0, 'asr-pending must not be stored to history yet');
});

test('ATTACH_PAGE on a bilibili page WITH transcript + ASR subtitleSource=original: no ASR handoff', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a', subtitleSource: 'original' },
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, { transcript: '[00:01] 有字幕' }), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.notEqual(res.ctx.mode, 'asr-pending', 'with transcript + original preference, no ASR handoff');
  assert.equal(res.ctx.mode, 'bilibili');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 1, 'normal store path');
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

test('ASR stream selection rejects a TRUNCATED lowest-bitrate stream in favor of a full-length one', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  // Custom mock: the video is 6000s (100 min). The 64kbps stream's metadata
  // claims only 1200s (20 min — the truncation bug); the 192kbps stream claims
  // the full 6000s. Selection must reject the short stream and pick 192kbps.
  const chromeMock = makeChrome(localArea, { transcript: null, hasFreshStreams: false });
  const origExecute = chromeMock.scripting.executeScript;
  chromeMock.scripting.executeScript = async (opts) => {
    if ((opts.func?.toString() || '').includes('__browsaGetBilibiliStreams')) {
      return [{ result: {
        streams: [
          { type: 'audio', label: '192 kbps', url: 'https://bilivideo.com/audio/192.m4s', bandwidth: 192000, hasAudio: true, duration: 6000, size: 144_000_000 },
          { type: 'audio', label: '64 kbps', url: 'https://bilivideo.com/audio/64.m4s', bandwidth: 64000, hasAudio: true, duration: 1200, size: 9_600_000 },
        ],
        videoDurationSec: 6000,
      } }];
    }
    return origExecute(opts);
  };
  Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'asr-pending');
  // The 64kbps stream is lowest bitrate but TRUNCATED (1200s < 90% of 6000s) —
  // it must NOT be chosen. The full-length 192kbps stream wins.
  assert.equal(res.ctx.audioUrl, 'https://bilivideo.com/audio/192.m4s', 'must skip the truncated lowest-bitrate stream and pick a full-length one');
  assert.equal(res.ctx.videoDurationSec, 6000, 'videoDurationSec must be passed to the sidepanel for the post-transcode sanity check');
  // 截断流（64, 1200s）在选流时已被排除，重试列表只含可用的完整长度流。
  assert.ok(Array.isArray(res.ctx.audioCandidates) && res.ctx.audioCandidates.length === 1, 'audioCandidates must only carry full-length (usable) streams for sidepanel retry');
  assert.equal(res.ctx.audioCandidates[0].url, 'https://bilivideo.com/audio/192.m4s', 'the truncated stream must be excluded from retry candidates');
});

test('ASR stream selection: when duration metadata is missing, lowest bitrate wins (backward-compatible)', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  // No duration on any stream + no videoDurationSec -> cannot judge -> fall back
  // to plain lowest-bitrate selection (pre-change behavior).
  const chromeMock = makeChrome(localArea, { transcript: null, hasFreshStreams: false });
  const origExecute = chromeMock.scripting.executeScript;
  chromeMock.scripting.executeScript = async (opts) => {
    if ((opts.func?.toString() || '').includes('__browsaGetBilibiliStreams')) {
      return [{ result: {
        streams: [
          { type: 'audio', label: '192 kbps', url: 'https://bilivideo.com/audio/192.m4s', bandwidth: 192000, hasAudio: true },
          { type: 'audio', label: '64 kbps', url: 'https://bilivideo.com/audio/64.m4s', bandwidth: 64000, hasAudio: true },
        ],
        videoDurationSec: 0,
      } }];
    }
    return origExecute(opts);
  };
  Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'asr-pending');
  assert.equal(res.ctx.audioUrl, 'https://bilivideo.com/audio/64.m4s', 'no duration metadata -> lowest bitrate, same as before');
});

test('ASR stream selection prefers AAC-LC (decodable) over the lowest-bitrate HE-AAC stream', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  // Both streams are full-length (6000s). The lowest-bitrate one (64k) is
  // HE-AAC (mp4a.40.5) — decodeAudioData may reject it (real user bug:
  // transcode "Unable to decode audio data"); the 132k one is AAC-LC
  // (mp4a.40.2) — reliably decodable. Selection must pick the AAC-LC 132k,
  // not the lowest-bitrate 64k.
  const chromeMock = makeChrome(localArea, { transcript: null, hasFreshStreams: false });
  const origExecute = chromeMock.scripting.executeScript;
  chromeMock.scripting.executeScript = async (opts) => {
    if ((opts.func?.toString() || '').includes('__browsaGetBilibiliStreams')) {
      return [{ result: {
        streams: [
          { type: 'audio', label: '132 kbps', url: 'https://bilivideo.com/audio/132.m4s', bandwidth: 132000, hasAudio: true, duration: 6000, size: 99_000_000, codecs: 'mp4a.40.2' },
          { type: 'audio', label: '64 kbps', url: 'https://bilivideo.com/audio/64.m4s', bandwidth: 64000, hasAudio: true, duration: 6000, size: 48_000_000, codecs: 'mp4a.40.5' },
        ],
        videoDurationSec: 6000,
      } }];
    }
    return origExecute(opts);
  };
  Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'asr-pending');
  assert.equal(res.ctx.audioUrl, 'https://bilivideo.com/audio/132.m4s', 'must prefer AAC-LC (mp4a.40.2) over a lower-bitrate HE-AAC (mp4a.40.5) stream for reliable decoding');
  assert.equal(res.ctx.audioCandidates[0].url, 'https://bilivideo.com/audio/132.m4s', 'the AAC-LC stream must be the first retry candidate');
  assert.equal(res.ctx.audioCandidates[1].url, 'https://bilivideo.com/audio/64.m4s', 'HE-AAC stream remains a later fallback candidate (sidepanel transcode retry)');
});

test('ASR stream selection: AAC-LC preferred, bitrate ties broken by lower bandwidth', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  // Two AAC-LC streams, both full-length — the LOWER bitrate one wins.
  const chromeMock = makeChrome(localArea, { transcript: null, hasFreshStreams: false });
  const origExecute = chromeMock.scripting.executeScript;
  chromeMock.scripting.executeScript = async (opts) => {
    if ((opts.func?.toString() || '').includes('__browsaGetBilibiliStreams')) {
      return [{ result: {
        streams: [
          { type: 'audio', label: '192 kbps', url: 'https://bilivideo.com/audio/192.m4s', bandwidth: 192000, hasAudio: true, duration: 6000, size: 144_000_000, codecs: 'mp4a.40.2' },
          { type: 'audio', label: '132 kbps', url: 'https://bilivideo.com/audio/132.m4s', bandwidth: 132000, hasAudio: true, duration: 6000, size: 99_000_000, codecs: 'mp4a.40.2' },
        ],
        videoDurationSec: 6000,
      } }];
    }
    return origExecute(opts);
  };
  Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.audioUrl, 'https://bilivideo.com/audio/132.m4s', 'among AAC-LC streams of equal decodability, the lowest bitrate wins (fastest download)');
});

test('ATTACH_PAGE on a subtitle-less YouTube page + ASR enabled: returns asr-pending with a FRESH googlevideo audio URL', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-0-lite-260428', language: 'zh', format: 'audio/x-m4a' },
  });
  Object.defineProperty(globalThis, 'chrome', {
    value: makeChrome(localArea, { pageUrl: YT_URL, ytTranscript: null }),
    writable: true, configurable: true,
  });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.mode, 'asr-pending');
  assert.equal(res.ctx.asrPlatform, 'youtube', 'the original platform must survive the asr-pending rewrite (sidepanel needs it for DNR/headers/labels)');
  // YouTube has NO passive __playinfo__ cache — the audio URL MUST come from a
  // fresh /player response (window.__browsaFetchFreshYouTubeStreams), so the PO
  // token in the URL is valid at download time.
  assert.match(res.ctx.audioUrl, /googlevideo\.com\/videoplayback\?pot=/, 'must come from the fresh /player fetch with a PO token in the URL');
  assert.equal(res.ctx.asr.apiKey, 'ark-key');
  assert.equal(res.ctx.asr.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(res.ctx.noTranscript, true, 'YouTube synthesis must set the structured noTranscript flag');
  assert.equal(res.ctx.biliCookie, 'SID=yt-sid-httpOnly; VISITOR_INFO1_LIVE=yt-visitor; CONSENT=yt-consent', 'must read the YouTube cookie set (googlevideo download needs SID/VISITOR_INFO1_LIVE etc. injected via DNR — 2026-08-25: plain fetch of googlevideo 403s without them)');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 0, 'asr-pending must not be stored to history yet');
});

test('ATTACH_PAGE on a YouTube page WITH transcript: normal store path (no ASR)', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  Object.defineProperty(globalThis, 'chrome', {
    value: makeChrome(localArea, { pageUrl: YT_URL, ytTranscript: '[00:01] hello world' }),
    writable: true, configurable: true,
  });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.notEqual(res.ctx.mode, 'asr-pending', 'with transcript there must be no ASR handoff');
  assert.equal(res.ctx.mode, 'youtube');
  assert.equal(res.ctx.noTranscript, false, 'noTranscript flag must be false when a transcript exists');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 1, 'normal store path stores the youtube attach');
  assert.match(history.history[0].content, /Mode: youtube/);
});

test('ATTACH_PAGE on a subtitle-less YouTube page + ASR enabled but NO audio stream: falls through to normal store', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
    asr: { enabled: true, apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a' },
  });
  Object.defineProperty(globalThis, 'chrome', {
    value: makeChrome(localArea, { pageUrl: YT_URL, ytHasStreams: false }),
    writable: true, configurable: true,
  });
  const { handle } = await import('../background.js');
  const tabId = nextTabId++;
  const res = await handle({ type: 'ATTACH_PAGE', tabId, mode: 'auto' }, { tab: { id: tabId } });
  assert.equal(res.ok, true);
  assert.notEqual(res.ctx.mode, 'asr-pending', 'no audio stream -> no ASR handoff');
  const history = await localArea.get('history');
  assert.equal((history.history || []).length, 1, 'falls through to normal store');
});

test('ATTACH_ASR_CONFIRM: stores the transcript with platform=youtube stamped on videoSrc', async () => {
  const localArea = makeStorageArea({
    activeProvider: 'compatible',
    providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
    autoSummarizeAttachments: false,
  });
  Object.defineProperty(globalThis, 'chrome', { value: makeChrome(localArea, {}), writable: true, configurable: true });
  const { handle } = await import('../background.js');
  const res = await handle({
    type: 'ATTACH_ASR_CONFIRM',
    text: '[00:00] Hello\n[00:05] Welcome to this video',
    metaUrl: YT_URL,
    metaTitle: 'YouTube Test Video',
    platform: 'youtube',
    tabId: 1,
  }, {});
  assert.equal(res.ok, true);
  const history = await localArea.get('history');
  const entry = history.history[history.history.length - 1];
  assert.match(entry.content, /\[00:00\] Hello/);
  assert.match(entry.content, /Mode: youtube/);
  assert.ok(entry.videoSrc, 'videoSrc must be stamped so [mm:ss] is clickable');
  assert.equal(entry.videoSrc.platform, 'youtube', 'videoSrc.platform must reflect the actual platform (SEEK_VIDEO platform dispatch)');
  assert.equal(entry.videoSrc.url, YT_URL);
});

test('ASR_FRESH_URLS returns a FLAT {ok, streams} so the onMessage data: wrap leaves r.data.streams readable', async () => {
  const localArea = makeStorageArea({});
  const chromeMock = makeChrome(localArea, {});
  // The default mock returns {streams} (the __browsaFetchFreshYouTubeStreams
  // shape), but ASR_FRESH_URLS' handler func returns {ok:true, streams} and the
  // background checks res.result.ok. Override to return the handler's shape.
  const origExecute = chromeMock.scripting.executeScript;
  chromeMock.scripting.executeScript = async (opts) => {
    if (opts.files) return [{ result: undefined }];
    if ((opts.func?.toString() || '').includes('__browsaFetchFreshYouTubeStreams')) {
      return [{ result: { ok: true, streams: [{ type: 'audio', url: 'https://rr.googlevideo.com/videoplayback?pot=fresh', bandwidth: 64000 }] } }];
    }
    return origExecute(opts);
  };
  Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true, configurable: true });
  const { handle } = await import('../background.js');
  // Simulate what the sidepanel sees: handle() result wrapped by the onMessage
  // listener as { ok: true, data: result }. The handler must return flat
  // { ok: true, streams } (NOT { ok: true, data: { ok: true, streams } }) so
  // after the wrap r.data.streams is the array — a real bug where the nested
  // data made the 403 self-heal never fire for bilibili OR youtube (2026-08-25).
  const result = await handle({ type: 'ASR_FRESH_URLS', tabId: 1, platform: 'youtube', videoUrl: YT_URL }, {});
  const wrapped = { ok: true, data: result };
  assert.equal(wrapped.data.ok, true, 'handler must succeed');
  assert.ok(Array.isArray(wrapped.data.streams), 'sidepanel reads r.data.streams — must be the array (flat return)');
  assert.ok(wrapped.data.streams.length > 0, 'must return the fresh audio streams');
  assert.equal(wrapped.data.streams[0].type, 'audio');
});
