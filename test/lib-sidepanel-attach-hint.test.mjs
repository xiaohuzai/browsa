// test/lib-sidepanel-attach-hint.test.mjs — real execution test for the
// "video has no subtitles + ASR not enabled" hint in onAttachPage's normal
// attach path. Mirrors the jsdom harness pattern of
// test/lib-sidepanel-asr.test.mjs, but the ATTACH_PAGE mock returns a plain
// (non-asr-pending) ctx flagged noTranscriptHint — the sidepanel must render
// the hint as a .attach-hint element while still showing the normal
// "已附加" label and storing the plain bilibili text.

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

let sent = [];

globalThis.fetch = async () => { throw new Error('no network expected in this test'); };

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '无字幕视频' }],
    get: async (id) => ({ id, url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '无字幕视频' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => { throw new Error('no executeScript expected'); },
  },
  declarativeNetRequest: {
    updateSessionRules: async () => {},
  },
  runtime: {
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
              meta: { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: '无字幕视频' },
              mode: 'auto',
              autoMode: 'reader',
              noTranscript: true,
              noTranscriptHint: true,
              text: 'B站视频信息（无字幕）',
              truncated: { textLength: 12 },
            }
          }
        });
        return;
      }
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

test('plain bilibili attach with no subtitles + ASR disabled renders the ASR hint and keeps the normal label', async () => {
  const messagesEl = document.getElementById('messages');
  attachBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  const attachMsg = messagesEl.querySelector('.attach-msg');
  assert.ok(attachMsg, 'attach system message must appear');
  assert.match(attachMsg.querySelector('span').textContent, /📎 已附加：/);

  const hint = attachMsg.querySelector('.attach-hint');
  assert.ok(hint, 'must render a .attach-hint element when ctx.noTranscriptHint is set');
  assert.match(hint.textContent, /无字幕/);
  assert.match(hint.textContent, /ASR 字幕识别/);

  // Must NOT have gone down the asr-pending pipeline.
  assert.ok(!sent.includes('ATTACH_ASR_CONFIRM'), 'no ASR confirm when ASR is disabled');
});
