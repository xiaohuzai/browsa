// test/lib-sidepanel-asr.test.mjs — real execution test for the sidepanel
// ASR branch of onAttachPage. Mirrors the jsdom harness pattern of
// test/lib-sidepanel-attach-progress.test.mjs. The sidepanel imports the real
// downloadAndUploadAudio / pollFileStatus / transcribeAudio from
// lib/handlers/attach-asr.js; we mock the network by overriding globalThis.fetch
// (download+upload now run directly in the sidepanel extension context, not an
// executeScript func — see the 2026-08-15 CORS fix), and verify the pipeline
// sends ATTACH_ASR_CONFIRM with the formatted transcript. chrome.
// declarativeNetRequest is mocked to capture the Referer-injection rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/sidepanel.html', runScripts: undefined });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.location = dom.window.location;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// ---- Mock Web Audio API (transcodeAudioBlob prefers real AudioContext, falls
// back to OfflineAudioContext; jsdom has neither, so this OfflineAudioContext
// serves as the decode path). The instance does decodeAudioData (returns a
// 48kHz buffer) + close.
globalThis.OfflineAudioContext = class {
  constructor(channels, frames, sampleRate) {
    this.channels = channels; this.frames = frames; this.sampleRate = sampleRate;
  }
  async decodeAudioData(buf) {
    const srcRate = 48000;
    const seconds = 3;
    const length = srcRate * seconds;
    return {
      sampleRate: srcRate, length, numberOfChannels: 1,
      getChannelData: () => new Float32Array(length),
    };
  }
  async close() {}
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => {} };
  }
  destination = {};
  async startRendering() {
    return { getChannelData: () => new Float32Array(this.frames) };
  }
};

let sent = []; // messages sent via chrome.runtime.sendMessage
let confirmed = null; // last ATTACH_ASR_CONFIRM payload
let dnrAdded = null; // captured DNR rule
let dnrRemovedIds = []; // rule ids passed to removeRuleIds

// Mock the Ark API + B站 CDN download over the real fetch-based client code in
// attach-asr.js. The first fetch is the m4s download, the second the /files
// upload; poll/transcribe then hit the mocked Ark endpoints.
let fetchMode = 'ready'; // 'ready' | 'processing' | 'error'
let downloadCalls = 0;
let uploadCalls = 0;
let uploadedFileName = ''; // file name captured from the /files upload FormData
let uploadedBlobSize = 0;
globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && url.includes('bilivideo.com/audio/192.m4s')) {
    downloadCalls++;
    return { ok: true, blob: async () => new Blob([new Uint8Array(44 * 1024 * 1024)]) };
  }
  if (typeof url === 'string' && url.endsWith('/files')) {
    uploadCalls++;
    // Capture the uploaded file name/type so the test can assert the transcode
    // produced a WAV (not the raw m4s), proving the 08-16 transcode step ran.
    const f = init?.body?.get?.('file');
    uploadedFileName = (f && f.name) || '';
    uploadedBlobSize = (f && f.size) || 0;
    return { ok: true, json: async () => ({ id: 'file-abc', object: 'file', bytes: uploadedBlobSize }) };
  }
  if (typeof url === 'string' && url.endsWith('/files/file-abc')) {
    if (fetchMode === 'processing') return { ok: true, json: async () => ({ status: 'processing' }) };
    if (fetchMode === 'error') return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ status: 'completed' }) };
  }
  if (typeof url === 'string' && url.endsWith('/responses')) {
    return {
      ok: true,
      json: async () => ({
        id: 'resp_1',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '以下是转写：\n[00:00] 大家好\n[00:04] 欢迎收看\n以上是全部内容' }] }]
      })
    };
  }
  throw new Error('unexpected fetch: ' + url);
};

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' }],
    get: async (id) => ({ id, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => { throw new Error('ASR must NOT use executeScript anymore (CORS fix)'); },
  },
  declarativeNetRequest: {
    updateSessionRules: async (opts) => {
      if (opts.addRules?.length) {
        dnrAdded = opts.addRules[0];
        assert.equal(opts.addRules[0].action.requestHeaders[0].header, 'referer');
        assert.equal(opts.addRules[0].action.requestHeaders[0].operation, 'set');
        assert.equal(opts.addRules[0].action.requestHeaders[0].value, 'https://www.bilibili.com');
        // The B站 login cookie is injected via DNR (cat-catch alignment) —
        // cross-site extension fetch can't carry SameSite cookies any other way.
        const cookieHdr = opts.addRules[0].action.requestHeaders.find((h) => h.header === 'cookie');
        assert.ok(cookieHdr, 'must inject the B站 Cookie header via DNR');
        assert.equal(cookieHdr.operation, 'set');
        assert.match(cookieHdr.value, /buvid3=/);
      }
      if (opts.removeRuleIds?.length) dnrRemovedIds.push(...opts.removeRuleIds);
    },
  },
  runtime: {
    id: 'test-extension-id',
    connect: () => ({
      name: '', sent: [],
      onMessage: { addListener: () => {}, removeListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {},
      disconnect: () => {},
    }),
    sendMessage: (msg, cb) => {
      sent.push(msg.type);
      if (msg.type === 'GET_CONFIG') { cb({ data: {} }); return; }
      if (msg.type === 'STREAM_PEEK') { cb({ inFlight: false }); return; }
      if (msg.type === 'ATTACH_PAGE') {
        cb({
          ok: true, data: {
            ok: true,
            ctx: {
              meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' },
              mode: 'asr-pending',
              audioUrl: 'https://bilivideo.com/audio/192.m4s',
              // 同源读到的 B站 cookie（buildAsrPendingCtx 在 MAIN world 读 document.cookie）
              biliCookie: 'buvid3=test-buvid; buvid4=test-buvid4; b_nut=12345',
              noTranscript: true,
              text: 'bilibili plain text fallback',
              asr: { apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'm', language: 'zh', format: 'audio/x-m4a', timeoutMs: 150000 },
            }
          }
        });
        return;
      }
      if (msg.type === 'ATTACH_ASR_CONFIRM') { confirmed = msg; cb({ ok: true }); return; }
      cb({ ok: true });
    },
    lastError: undefined,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const attachBtn = document.getElementById('attach');

test('clicking attach on an asr-pending ctx runs download->transcode(WAV)->upload->poll->transcribe and confirms with the transcript', async () => {
  attachBtn.click();
  // Give the async pipeline time to run (fetch-based poll has a 2s interval but
  // the first poll returns 'completed' immediately).
  await new Promise((r) => setTimeout(r, 50));

  // The download+upload must run in the sidepanel extension context (NOT
  // executeScript MAIN-world — the Ark upload is CORS-blocked there).
  assert.equal(downloadCalls, 1, 'm4s must be downloaded via extension-context fetch');
  assert.equal(uploadCalls, 1, 'Ark /files upload must run via extension-context fetch');
  assert.equal(uploadedFileName, 'audio.wav', 'must upload the transcoded WAV, not the raw m4s');
  assert.ok(uploadedBlobSize > 0 && uploadedBlobSize < 44 * 1024 * 1024, 'transcoded WAV must be smaller than the raw 44MB m4s');
  assert.ok(dnrAdded, 'must register a DNR Referer-injection rule before the download');
  assert.equal(dnrAdded.condition.urlFilter, 'bilivideo', 'must cover both .com and .cn CDN hosts');
  assert.deepEqual(dnrAdded.condition.initiatorDomains, ['test-extension-id'], 'DNR rule must target the extension initiator only (sidepanel fetch), not page requests');
  assert.ok(dnrRemovedIds.length > 0, 'must remove the DNR rule after the pipeline');

  // ATTACH_ASR_CONFIRM should have been sent with the formatted transcript
  // (meta lines stripped).
  assert.ok(sent.includes('ATTACH_ASR_CONFIRM'), 'must send ATTACH_ASR_CONFIRM after the pipeline');
  assert.ok(confirmed, 'confirm payload must be captured');
  assert.match(confirmed.text, /\[00:00\] 大家好/);
  assert.match(confirmed.text, /\[00:04\] 欢迎收看/);
  assert.doesNotMatch(confirmed.text, /以下是|以上是/, 'meta lines must be stripped by formatAsrTranscript');
  // 需求：ASR 字幕作为增量追加，视频元信息必须保留（像有字幕的视频 attach 一样）。
  assert.match(confirmed.text, /bilibili plain text fallback/, 'original video meta text must be preserved, subtitle is additive');
  assert.match(confirmed.text, /## 字幕（ASR）/);
  assert.equal(confirmed.metaUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(confirmed.metaTitle, '测试视频');
});

test('ASR pipeline failure falls back to the plain bilibili text via ATTACH_ASR_CONFIRM', async () => {
  // Force poll HTTP error -> transcribe never runs -> fallback text stored.
  fetchMode = 'error';
  sent = [];
  confirmed = null;
  downloadCalls = 0;
  uploadCalls = 0;
  dnrRemovedIds = [];
  attachBtn.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sent.includes('ATTACH_ASR_CONFIRM'), 'fallback must still confirm');
  assert.ok(confirmed, 'confirm payload must be captured');
  assert.equal(confirmed.text, 'bilibili plain text fallback', 'must fall back to the plain bilibili text on failure');
  assert.equal(downloadCalls, 1, 'download still runs before the poll failure');
  assert.equal(uploadCalls, 1, 'upload still runs before the poll failure');
  assert.ok(dnrRemovedIds.length > 0, 'DNR rule must be removed even on failure (finally)');
  fetchMode = 'ready';
});

test('ASR retries with the next candidate when the lowest-bitrate stream decodes to a truncated WAV', async () => {
  // The decoded WAV duration must differ per candidate: small (64kbps) blob →
  // ~0.5s (truncated), large (192kbps) blob → 3s (full). Override the decode
  // mock to return duration by input size, so the retry path is exercised.
  const OrigOAC = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    constructor(ch, frames, rate) { this.channels = ch; this.frames = frames; this.sampleRate = rate; }
    async decodeAudioData(buf) {
      const srcRate = 48000;
      const seconds = buf.byteLength < 1024 * 1024 ? 0.5 : 3; // small blob → truncated
      const length = Math.max(1, Math.round(srcRate * seconds));
      return {
        sampleRate: srcRate, length, numberOfChannels: 1,
        getChannelData: () => new Float32Array(length),
      };
    }
    async close() {}
    destination = {};
    async startRendering() { return { getChannelData: () => new Float32Array(this.frames) }; }
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('bilivideo.com/audio/64.m4s')) {
      downloadCalls++;
      return { ok: true, blob: async () => new Blob([new Uint8Array(32 * 1024)]) }; // truncated-ish 32KB
    }
    if (typeof url === 'string' && url.includes('bilivideo.com/audio/192.m4s')) {
      downloadCalls++;
      return { ok: true, blob: async () => new Blob([new Uint8Array(44 * 1024 * 1024)]) }; // full 44MB
    }
    return origFetch(url, init);
  };

  sent = [];
  confirmed = null;
  downloadCalls = 0;
  uploadCalls = 0;
  dnrRemovedIds = [];

  // ctx: audioUrl = the truncated 64kbps stream, audioCandidates carry both,
  // videoDurationSec = 5s. First candidate (64) decodes to 0.5s (< 50% of 5s)
  // → must retry with 192, which decodes to 3s (>= 50%) → accepted.
  const origSendMessage = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'ATTACH_PAGE') {
      cb({ ok: true, data: { ok: true, ctx: {
        meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' },
        mode: 'asr-pending',
        audioUrl: 'https://bilivideo.com/audio/64.m4s',
        audioLabel: '64 kbps',
        audioCandidates: [
          { url: 'https://bilivideo.com/audio/64.m4s', label: '64 kbps', bandwidth: 64000, duration: 0, size: 0 },
          { url: 'https://bilivideo.com/audio/192.m4s', label: '192 kbps', bandwidth: 192000, duration: 5, size: 0 },
        ],
        videoDurationSec: 5,
        biliCookie: 'buvid3=test-buvid',
        noTranscript: true,
        text: 'bilibili plain text fallback',
        asr: { apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'm', language: 'zh', format: 'audio/x-m4a', timeoutMs: 150000 },
      } } });
      return;
    }
    // 其余（含 ATTACH_ASR_CONFIRM）走原 mock：它负责 sent.push；这里额外捕获
    // confirm 载荷用于断言。
    origSendMessage(msg, cb);
    if (msg.type === 'ATTACH_ASR_CONFIRM') confirmed = msg;
  };

  attachBtn.click();
  // Two downloads + two transcodes + upload + poll + transcribe — allow more
  // time than the single-candidate tests (which use 50ms).
  await new Promise((r) => setTimeout(r, 400));

  // The 64kbps candidate decoded to a truncated 0.5s WAV → retry → download 192.
  assert.equal(downloadCalls, 2, 'must re-download with the next candidate after truncation');
  assert.equal(uploadCalls, 1, 'must upload only the full-length stream, not the truncated one');
  assert.ok(sent.includes('ATTACH_ASR_CONFIRM'), 'must confirm after a successful retry');
  assert.ok(confirmed, 'confirm payload must be captured');
  assert.match(confirmed.text, /\[00:00\] 大家好/, 'transcript from the full-length stream must be attached');

  // Restore mocks.
  globalThis.chrome.runtime.sendMessage = origSendMessage;
  globalThis.fetch = origFetch;
  globalThis.OfflineAudioContext = OrigOAC;
  sent = [];
  confirmed = null;
  downloadCalls = 0;
  uploadCalls = 0;
});

test('ASR retries with the next candidate when transcode fails (decodeAudioData rejects the first stream)', async () => {
  // First candidate's decodeAudioData throws (e.g. HE-AAC the Web Audio decoder
  // can't handle) — the retry loop must move to the next candidate instead of
  // failing the whole ASR. This is the fix for the real user bug "transcode
  // failed: Unable to decode audio data".
  const OrigOAC2 = globalThis.OfflineAudioContext;
  let decodeCalls = 0;
  globalThis.OfflineAudioContext = class {
    constructor(ch, frames, rate) { this.channels = ch; this.frames = frames; this.sampleRate = rate; }
    async decodeAudioData(buf) {
      decodeCalls++;
      // First decode (64kbps HE-AAC) throws; later decodes (192kbps AAC-LC) succeed.
      if (decodeCalls === 1) throw new DOMException('Unable to decode audio data');
      const srcRate = 48000;
      const length = srcRate * 3;
      return { sampleRate: srcRate, length, numberOfChannels: 1, getChannelData: () => new Float32Array(length) };
    }
    async close() {}
    destination = {};
    async startRendering() { return { getChannelData: () => new Float32Array(this.frames) }; }
  };

  const origFetch2 = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && (url.includes('bilivideo.com/audio/64.m4s') || url.includes('bilivideo.com/audio/192.m4s'))) {
      downloadCalls++;
      return { ok: true, blob: async () => new Blob([new Uint8Array(44 * 1024 * 1024)]) };
    }
    return origFetch2(url, init);
  };

  sent = [];
  confirmed = null;
  downloadCalls = 0;
  uploadCalls = 0;
  dnrRemovedIds = [];

  const origSendMessage2 = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'ATTACH_PAGE') {
      cb({ ok: true, data: { ok: true, ctx: {
        meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '测试视频' },
        mode: 'asr-pending',
        audioUrl: 'https://bilivideo.com/audio/64.m4s',
        audioLabel: '64 kbps',
        audioCandidates: [
          { url: 'https://bilivideo.com/audio/64.m4s', label: '64 kbps', bandwidth: 64000, duration: 5, size: 0, codecs: 'mp4a.40.5' },
          { url: 'https://bilivideo.com/audio/192.m4s', label: '192 kbps', bandwidth: 192000, duration: 5, size: 0, codecs: 'mp4a.40.2' },
        ],
        videoDurationSec: 5,
        biliCookie: 'buvid3=test-buvid',
        noTranscript: true,
        text: 'bilibili plain text fallback',
        asr: { apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'm', language: 'zh', format: 'audio/x-m4a', timeoutMs: 150000 },
      } } });
      return;
    }
    origSendMessage2(msg, cb);
    if (msg.type === 'ATTACH_ASR_CONFIRM') confirmed = msg;
  };

  attachBtn.click();
  // First candidate transcode fails (throws) → retry downloads the second →
  // transcode succeeds → upload → transcribe → confirm.
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(decodeCalls, 2, 'first decode must fail, second must succeed (retry across candidates)');
  assert.equal(downloadCalls, 2, 'must re-download with the next candidate after a transcode failure');
  assert.equal(uploadCalls, 1, 'must upload only the successfully-transcoded stream');
  assert.ok(sent.includes('ATTACH_ASR_CONFIRM'), 'must confirm after the retry succeeds');
  assert.ok(confirmed, 'confirm payload must be captured');
  assert.match(confirmed.text, /\[00:00\] 大家好/, 'transcript must be attached');

  // Restore mocks.
  globalThis.chrome.runtime.sendMessage = origSendMessage2;
  globalThis.fetch = origFetch2;
  globalThis.OfflineAudioContext = OrigOAC2;
  sent = [];
  confirmed = null;
  downloadCalls = 0;
  uploadCalls = 0;
});
