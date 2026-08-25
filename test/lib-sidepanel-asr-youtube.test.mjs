// test/lib-sidepanel-asr-youtube.test.mjs — real execution test for the
// sidepanel ASR branch on the YOUTUBE platform. Mirrors
// lib-sidepanel-asr.test.mjs but asserts the youtube-specific behaviors:
//   (1) NO DNR Referer/Cookie injection rule is registered (googlevideo auth
//       rides in the URL's PO token, not cookies);
//   (2) the audio download is a PLAIN fetch — no bilibili Referer, no Range;
//   (3) ATTACH_ASR_CONFIRM carries platform=youtube so background stamps the
//       right videoSrc.platform.
// The pipeline (transcode->upload->poll->transcribe) is identical to bilibili,
// so the shared assertions are reused here against the real sidepanel.js.

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

// Web Audio API mock — same as the bilibili test.
globalThis.OfflineAudioContext = class {
  constructor(channels, frames, sampleRate) {
    this.channels = channels; this.frames = frames; this.sampleRate = sampleRate;
  }
  async decodeAudioData() {
    const srcRate = 48000;
    const length = srcRate * 3;
    return {
      sampleRate: srcRate, length, numberOfChannels: 1,
      getChannelData: () => new Float32Array(length),
    };
  }
  async close() {}
  createBufferSource() { return { buffer: null, connect: () => {}, start: () => {} }; }
  destination = {};
  async startRendering() { return { getChannelData: () => new Float32Array(this.frames) }; }
};

let sent = [];
let confirmed = null;
let dnrRule = null;   // captured DNR rule (youtube: must inject Referer/Origin/Cookie)
let dnrCalls = 0;
let downloadHeaders = null; // captured fetch headers of the audio download
let uploadCalls = 0;
let uploadedFileName = '';

globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
    downloadHeaders = init?.headers || null;
    return { ok: true, blob: async () => new Blob([new Uint8Array(1100 * 1024)]) };
  }
  if (typeof url === 'string' && url.endsWith('/files')) {
    uploadCalls++;
    const f = init?.body?.get?.('file');
    uploadedFileName = (f && f.name) || '';
    return { ok: true, json: async () => ({ id: 'file-yt', object: 'file', bytes: (f && f.size) || 0 }) };
  }
  if (typeof url === 'string' && url.endsWith('/files/file-yt')) {
    return { ok: true, json: async () => ({ status: 'completed' }) };
  }
  if (typeof url === 'string' && url.endsWith('/responses')) {
    return {
      ok: true,
      json: async () => ({
        id: 'resp_yt',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[00:00] Hello\n[00:02] Welcome to this video' }] }]
      })
    };
  }
  throw new Error('unexpected fetch: ' + url);
};

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=abc123XYZ', title: 'YT Test' }],
    get: async (id) => ({ id, url: 'https://www.youtube.com/watch?v=abc123XYZ', title: 'YT Test' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => { throw new Error('ASR must NOT use executeScript (CORS fix)'); },
  },
  declarativeNetRequest: {
    // YouTube MUST register a DNR rule injecting youtube.com Referer/Origin +
    // cookie — 2026-08-25 real test: plain fetch of googlevideo from the
    // extension context 403s (chrome-extension origin rejected). Mirror bilibili.
    updateSessionRules: async (opts) => {
      dnrCalls++;
      if (opts.addRules?.length) dnrRule = opts.addRules[0];
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
              meta: { url: 'https://www.youtube.com/watch?v=abc123XYZ', title: 'YT Test' },
              mode: 'asr-pending',
              // The youtube branch of buildAsrPendingCtx stamps asrPlatform.
              asrPlatform: 'youtube',
              audioUrl: 'https://rr2---sn.googlevideo.com/videoplayback?pot=abc&itag=140',
              audioLabel: '128 kbps',
              biliCookie: 'SID=yt-sid; VISITOR_INFO1_LIVE=yt-visitor', // youtube: DNR-injected cookie
              noTranscript: true,
              text: 'youtube plain text fallback',
              asr: { apiKey: 'ark-key', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', language: 'zh', format: 'audio/x-m4a', timeoutMs: 150000 },
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

test('youtube ASR: DNR injects youtube Referer+Origin+Cookie, download sends Range only, platform=youtube on confirm', async () => {
  attachBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  // The download fetch itself must NOT carry the bilibili Referer (would be
  // wrong for googlevideo); Range is fine (helps CDN accept the request).
  assert.ok(downloadHeaders, 'download must carry a headers object');
  assert.equal(downloadHeaders.Referer, undefined, 'youtube download must NOT send the bilibili Referer at fetch level');
  assert.equal(downloadHeaders.Range, 'bytes=0-', 'youtube download must still send Range');

  // A DNR rule IS registered, injecting youtube.com Referer + Origin + cookie
  // at the network layer (googlevideo rejects chrome-extension origin — the
  // 2026-08-25 real bug).
  assert.ok(dnrRule, 'youtube MUST register a DNR rule (googlevideo 403s without Referer/Origin/Cookie injection)');
  const hdrs = Object.fromEntries((dnrRule.action.requestHeaders || []).map((h) => [h.header, h.value]));
  assert.equal(hdrs.referer, 'https://www.youtube.com');
  assert.equal(hdrs.origin, 'https://www.youtube.com', 'must rewrite the chrome-extension Origin to youtube.com (googlevideo rejects it)');
  assert.match(hdrs.cookie || '', /SID=yt-sid/, 'must inject the YouTube cookie via DNR');
  assert.equal(dnrRule.condition.urlFilter, 'googlevideo');
  assert.deepEqual(dnrRule.condition.initiatorDomains, ['test-extension-id'], 'must target the extension initiator only');

  assert.equal(uploadCalls, 1, 'Ark /files upload must run via extension-context fetch');
  assert.equal(uploadedFileName, 'audio.wav', 'must upload the transcoded WAV');

  assert.ok(sent.includes('ATTACH_ASR_CONFIRM'), 'must send ATTACH_ASR_CONFIRM after the pipeline');
  assert.ok(confirmed, 'confirm payload must be captured');
  assert.match(confirmed.text, /\[00:00\] Hello/);
  assert.match(confirmed.text, /youtube plain text fallback/, 'original video meta text must be preserved (additive subtitle)');
  assert.match(confirmed.text, /## 字幕（ASR）/);
  assert.equal(confirmed.platform, 'youtube', 'must pass platform=youtube so background stamps videoSrc.platform=youtube');
  assert.equal(confirmed.metaUrl, 'https://www.youtube.com/watch?v=abc123XYZ');
  assert.equal(confirmed.metaTitle, 'YT Test');
});
