// test/attach-llms-txt.test.mjs
//
// Covers the llms.txt lifecycle change: llms.txt used to be fetched from the
// currently-active tab and injected into the per-turn system prompt on every
// CHAT (a "dynamic system prompt" — breaks KV/prompt prefix caching whenever
// the tab's origin changes, and can inject site instructions for a page the
// user never attached). It is now fetched ONCE at attach time and baked into
// the stored page-context text, keyed to the ATTACHED page's own URL.
//
// - withSiteInstructions (exported from background.js) unit tests: gating,
//   no-op cases, and the prepend formatting.
// - Integration: a generic `dom` ATTACH_PAGE on an origin that publishes
//   /llms.txt stores the instructions inside the page-context text.
// - llmsTxtEnabled=false disables the whole feature.
// - Static-analysis: the CHAT system prompt must no longer reference llms.txt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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

const localArea = makeStorageArea({
  activeProvider: 'compatible',
  providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' } },
  autoSummarizeAttachments: false,
});
const sessionArea = makeStorageArea();

let executeScriptCalls = [];

const chromeMock = {
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
    query: async () => [{ id: 1, url: 'https://docs.example.com/guide', title: 'Guide' }],
    get: async () => ({ id: 1, url: 'https://docs.example.com/guide', title: 'Guide', favIconUrl: '' }),
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
      if (opts.func?.name === 'func' || opts.func?.name === '') return [{ result: false }];
      if (opts.func?.name === 'preExtractCleanup') return [{ result: {} }];
      return [{ result: { text: 'the article body text that is long enough to count', rawTextLength: 50, wasCapped: false } }];
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

const bg = await import('../background.js');
const { handle, withSiteInstructions, withVideoNote } = bg;
const { llmsTxtCache, fetchLlmsTxt } = await import('../lib/handlers/chat-handler.js');

function setFetchImpl(fn) { globalThis.fetch = fn; }
function clearLlmsCache() { llmsTxtCache.clear(); }

// --------------- withSiteInstructions unit tests -----------------------------

test('withSiteInstructions: disabled (llmsTxtEnabled === false) -> ctx unchanged, no fetch', async () => {
  let fetchCalled = false;
  setFetchImpl(async () => { fetchCalled = true; return { ok: true, text: async () => 'x' }; });
  const ctx = { meta: { url: 'https://docs.example.com/guide' }, mode: 'dom', text: 'body' };
  const out = await withSiteInstructions(ctx, { llmsTxtEnabled: false });
  assert.equal(out, ctx, 'must return the same object unchanged when disabled');
  assert.equal(out.text, 'body');
  assert.equal(fetchCalled, false, 'must not fetch when disabled');
});

test('withSiteInstructions: no URL / non-http(s) URL -> ctx unchanged, no fetch', async () => {
  let fetchCalled = false;
  setFetchImpl(async () => { fetchCalled = true; return { ok: true, text: async () => 'x' }; });
  const noUrl = await withSiteInstructions({ meta: {}, mode: 'dom', text: 'body' }, { llmsTxtEnabled: true });
  assert.equal(noUrl.text, 'body');
  const chromeUrl = await withSiteInstructions({ meta: { url: 'chrome://newtab/' }, mode: 'dom', text: 'body' }, { llmsTxtEnabled: true });
  assert.equal(chromeUrl.text, 'body');
  assert.equal(fetchCalled, false, 'must not fetch for missing/non-http URL');
});

test('withSiteInstructions: origin without llms.txt (404) -> ctx unchanged', async () => {
  setFetchImpl(async () => ({ ok: false, status: 404, text: async () => '' }));
  const ctx = { meta: { url: 'https://plain.example.com/page' }, mode: 'dom', text: 'body' };
  const out = await withSiteInstructions(ctx, { llmsTxtEnabled: true });
  assert.equal(out, ctx, 'no llms.txt -> same object, no text change');
  assert.equal(out.text, 'body');
});

test('fetchLlmsTxt: rejects an HTML response even on HTTP 200 (x.com/llms.txt case)', async () => {
  // x.com serves its SPA index.html with HTTP 200 + Content-Type text/html for
  // /llms.txt. This must NOT be treated as site instructions.
  clearLlmsCache();
  setFetchImpl(async () => ({
    ok: true, status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => '<!DOCTYPE html><html><head><title>x</title></head><body>nav nav</body></html>',
  }));
  const got = await fetchLlmsTxt('https://x.com/someuser/status/123');
  assert.equal(got, null, 'HTML body must be rejected even with a 200 status');
});

test('fetchLlmsTxt: rejects an HTML-looking body when Content-Type header is absent', async () => {
  clearLlmsCache();
  setFetchImpl(async () => ({
    ok: true, status: 200,
    headers: { get: () => null }, // no Content-Type at all
    text: async () => '<!DOCTYPE html><html><body>hello</body></html>',
  }));
  assert.equal(await fetchLlmsTxt('https://nohdr.example.com/'), null);
});

test('fetchLlmsTxt: accepts a real text/plain llms.txt', async () => {
  clearLlmsCache();
  setFetchImpl(async () => ({
    ok: true, status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : null) },
    text: async () => '# example\n\n- https://example.com/readme',
  }));
  assert.equal(await fetchLlmsTxt('https://example.com/'), '# example\n\n- https://example.com/readme');
});

test('withSiteInstructions: origin with llms.txt -> instructions prepended to ctx.text', async () => {
  setFetchImpl(async () => ({ ok: true, status: 200, text: async () => 'Follow the docs. Cite the source.' }));
  const ctx = { meta: { url: 'https://docs.example.com/guide' }, mode: 'dom', text: 'the body' };
  const out = await withSiteInstructions(ctx, { llmsTxtEnabled: true });
  assert.notEqual(out, ctx, 'a new ctx object is returned (text changed)');
  assert.match(out.text, /^\[Site instructions from https:\/\/docs\.example\.com\/llms\.txt\]\nFollow the docs\. Cite the source\.\n\nthe body$/);
});

test('withSiteInstructions: returns ctx unchanged when llms.txt is empty/whitespace', async () => {
  setFetchImpl(async () => ({ ok: true, status: 200, text: async () => '   ' }));
  const ctx = { meta: { url: 'https://empty.example.com/' }, mode: 'dom', text: 'body' };
  const out = await withSiteInstructions(ctx, { llmsTxtEnabled: true });
  assert.equal(out.text, 'body');
});

// --------------- integration: ATTACH_PAGE bakes llms.txt into history -------

test('ATTACH_PAGE (dom): origin with llms.txt -> stored history entry contains the instructions', async () => {
  clearLlmsCache();
  executeScriptCalls = [];
  setFetchImpl(async () => ({ ok: true, status: 200, text: async () => 'This is the site instruction text.' }));
  localArea._set({ llmsTxtEnabled: true });

  const res = await handle({ type: 'ATTACH_PAGE', tabId: 1, mode: 'dom' }, { tab: { id: 1 } });
  assert.equal(res.ok, true);

  const { history } = await localArea.get('history');
  const entry = history[history.length - 1];
  assert.match(entry.content, /\[Site instructions from https:\/\/docs\.example\.com\/llms\.txt\]\nThis is the site instruction text\./, 'llms.txt must be baked into the stored page-context text');
  assert.match(entry.content, /the article body text/, 'the page body must still be present after the instructions');
  // The system prompt is NOT involved — llms.txt rides in the trajectory.
  assert.doesNotMatch(entry.content, /You are a helpful assistant/);
});

test('ATTACH_PAGE (dom): llmsTxtEnabled=false -> no instructions baked in', async () => {
  clearLlmsCache();
  executeScriptCalls = [];
  setFetchImpl(async () => { throw new Error('must not be called'); });
  localArea._set({ llmsTxtEnabled: false });

  const res = await handle({ type: 'ATTACH_PAGE', tabId: 1, mode: 'dom' }, { tab: { id: 1 } });
  assert.equal(res.ok, true);

  const { history } = await localArea.get('history');
  const entry = history[history.length - 1];
  assert.doesNotMatch(entry.content, /Site instructions from/, 'disabled feature must not inject instructions');
  assert.match(entry.content, /the article body text/);
});

// --------------- video-note formatting hint (same KV-cache treatment) ------

const VIDEO_NOTE_MARKER = /Note: The attached context includes a video transcript with \[mm:ss\] timestamps\./;

test('withVideoNote: appends the video-note instruction to ctx.text, keeping the transcript', () => {
  const ctx = { meta: { url: 'https://www.youtube.com/watch?v=x' }, mode: 'youtube', text: '[00:01] hello' };
  const out = withVideoNote(ctx);
  assert.notEqual(out, ctx, 'a new ctx object is returned (text changed)');
  assert.match(out.text, /^\[00:01\] hello\n\n/);
  assert.match(out.text, VIDEO_NOTE_MARKER);
  assert.match(out.text, /formatted as \[mm:ss\]/);
});

test('withVideoNote: works on empty text too', () => {
  const out = withVideoNote({ meta: {}, mode: 'bilibili', text: '' });
  assert.match(out.text, VIDEO_NOTE_MARKER);
});

test('ATTACH_ASR_CONFIRM: bilibili transcript gets the video-note instruction baked in alongside videoSrc', async () => {
  clearLlmsCache();
  setFetchImpl(async () => ({ ok: false, status: 404, text: async () => '' }));
  const res = await handle({
    type: 'ATTACH_ASR_CONFIRM',
    text: '[00:00] 大家好\n[00:05] 今天讲 KV Cache',
    metaUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    metaTitle: 'KV Cache 讲解',
    tabId: 999,
  }, {});
  assert.equal(res.ok, true);
  const { history } = await localArea.get('history');
  const entry = history[history.length - 1];
  assert.match(entry.content, /\[00:00\] 大家好/);
  assert.match(entry.content, VIDEO_NOTE_MARKER, 'ASR transcript must carry the video-note instruction');
  assert.equal(entry.videoSrc?.platform, 'bilibili', 'videoSrc must still be stamped');
});

// --------------- static analysis: CHAT system prompt stays byte-stable ------

test('CHAT system prompt no longer references llms.txt / video-note (KV-cache stable prefix)', async () => {
  const src = await readFile(fileURLToPath(new URL('../lib/handlers/chat-handler.js', import.meta.url)), 'utf8');
  const effLine = src.split('\n').find((l) => l.includes('effectiveSystemPrompt = ['));
  assert.ok(effLine, 'effectiveSystemPrompt assembly must exist');
  assert.doesNotMatch(effLine, /llmsTxt|llms\.txt|Site instructions|videoNoteHint|video transcript with/, 'system prompt must not include llms.txt or the video-note hint — both move to the attach-time page context');
  // fetchLlmsTxt must still exist (consumed by withSiteInstructions at attach time).
  assert.match(src, /export async function fetchLlmsTxt/, 'fetchLlmsTxt must remain exported for the attach flow');
  // videoSrc detection must survive (drives DONE stamping + timestamp rewrite).
  assert.match(src, /history\[i\]\.videoSrc/, 'videoSrc detection must remain in handleChat');
});
