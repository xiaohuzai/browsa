// test/lib-selection-toolbar.test.mjs — real jsdom execution test of the
// content script lib/content-scripts/selection-toolbar.js (743 lines, previously
// with zero coverage anywhere in the suite).
//
// Why this matters: the script is a self-executing IIFE injected into every
// https page. A typo or a reference to a missing API would silently break the
// floating selection toolbar for ALL users, and nothing else in the suite would
// catch it. These tests load the real source into jsdom with a mocked chrome
// surface and assert its observable side effects.
//
// The toolbar UI lives in a CLOSED shadow root, so its internals are not
// inspectable — assertions target what the outside world can see: the injected
// host elements, the install guard, and the chrome.runtime messages the script
// sends. `window.getSelection()` rects are all-zero in jsdom, so the mouseup →
// show path cannot be exercised here; the selectionchange → cache path (which
// does not depend on layout) is covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../lib/content-scripts/selection-toolbar.js', import.meta.url), 'utf8');

function setup({ uiLang, dictionaries = {} } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><p id="p">Hello brave new world of toolbars</p></body></html>',
    { url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const sent = [];
  const listeners = [];
  const roots = [];
  const ports = [];
  const w = dom.window;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (opts) { const root = attach.call(this, opts); roots.push(root); return root; };
  w.chrome = {
    runtime: {
      getURL: (p) => 'chrome-extension://test/' + p,
      sendMessage: (m) => { sent.push(m); },
      connect: () => {
        const msgListeners = [];
        const discListeners = [];
        const port = {
          sent: [],
          disconnected: false,
          postMessage: (m) => { port.sent.push(m); },
          disconnect() { port.disconnected = true; for (const f of [...discListeners]) f(); },
          onMessage: { addListener: (f) => msgListeners.push(f) },
          onDisconnect: { addListener: (f) => discListeners.push(f) },
          emit(msg) { for (const f of [...msgListeners]) f(msg); },
        };
        ports.push(port);
        return port;
      },
      lastError: null,
    },
    storage: {
      local: { get: (k, cb) => { if (typeof cb === 'function') cb({ uiLang }); }, set() {} },
      onChanged: { addListener: (fn) => { listeners.push(fn); } },
    },
    i18n: { getMessage: () => '' },
  };
  // jsdom has no fetch; the script's async locale refresh calls it.
  w.fetch = async url => ({ json: async () => dictionaries[String(url).split('/').at(-2)] || {} });
  return { dom, w, sent, roots, ports, getOnChanged: () => (changes, area) => listeners.forEach(fn => fn(changes, area)) };
}

function selectAll(w, text) {
  const p = w.document.getElementById('p');
  const range = w.document.createRange();
  range.selectNodeContents(p);
  const sel = w.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  if (text != null) assert.equal(sel.toString(), text); // sanity: jsdom honored the range
}

test('selection toolbar: loads into an https page and injects its host elements exactly once', () => {
  const { dom, w } = setup();
  w.eval(SRC);
  assert.ok(w.document.getElementById('browsa-sel-host'), 'toolbar host must be injected into body');
  assert.ok(w.document.getElementById('browsa-sel-pop-host'), 'explain popover host must be injected');
  assert.equal(w.__browsaSelectionToolbarInstalled, true, 'install flag must be set');

  // Re-running the script (e.g. re-injection on SPA navigation) must be a no-op.
  w.eval(SRC);
  assert.equal(w.document.querySelectorAll('#browsa-sel-host').length, 1, 'must never inject a second toolbar host');
  assert.equal(w.document.querySelectorAll('#browsa-sel-pop-host').length, 1, 'must never inject a second popover host');
  dom.window.close();
});

test('selection toolbar: bails out when chrome.runtime is absent (non-extension context)', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.com/', runScripts: 'outside-only' });
  dom.window.eval(SRC); // no chrome global
  assert.equal(dom.window.document.getElementById('browsa-sel-host'), null, 'must not inject without chrome.runtime');
  dom.window.close();
});

// The production selectionchange handler is debounced 220ms (per-caret-move
// messages cold-started the service worker on every keystroke in Docs) — wait
// out the debounce before asserting.
const SELECTION_DEBOUNCE_MS = 260;

test('selection toolbar: selectionchange caches the selected text to the background', async () => {
  const { dom, w, sent } = setup();
  w.eval(SRC);
  sent.length = 0; // drop any load-time messages

  selectAll(w, 'Hello brave new world of toolbars');
  w.document.dispatchEvent(new w.Event('selectionchange'));
  await new Promise((r) => setTimeout(r, SELECTION_DEBOUNCE_MS));

  const cache = sent.find((m) => m.type === 'SELECTION_CACHE');
  assert.ok(cache, 'a SELECTION_CACHE message must be sent on selectionchange');
  assert.equal(cache.text, 'Hello brave new world of toolbars');
  dom.window.close();
});

// The selection's HTML rides along (same selection's structure) for the
// selected-attach Markdown upgrade — background converts it in the page MAIN
// world at attach time (Turndown), plain text stays the source of truth.
test('selection toolbar: SELECTION_CACHE carries the selection HTML next to the text', async () => {
  const { dom, w, sent } = setup();
  w.eval(SRC);
  sent.length = 0;

  selectAll(w, 'Hello brave new world of toolbars');
  w.document.dispatchEvent(new w.Event('selectionchange'));
  await new Promise((r) => setTimeout(r, SELECTION_DEBOUNCE_MS));

  const cache = sent.find((m) => m.type === 'SELECTION_CACHE');
  assert.ok(typeof cache.html === 'string' && cache.html.length > 0, 'html must ride along when a selection exists');
  assert.ok(cache.html.includes('Hello brave'), 'html holds the selected content');
  assert.ok(cache.html.length <= 300_000, 'html is capped');
  dom.window.close();
});

// Empty selections are skipped AT THE SOURCE: background's SELECTION_CACHE
// case has always ignored empty text (`if (tabId && msg.text)` — the cache
// deliberately survives deselection so 📎 keeps working), so sending the
// empty message was a no-op that only cost a service-worker wake.
test('selection toolbar: selectionchange with an empty selection sends nothing', async () => {
  const { dom, w, sent } = setup();
  w.eval(SRC);
  w.getSelection().removeAllRanges();
  sent.length = 0;
  w.document.dispatchEvent(new w.Event('selectionchange'));
  await new Promise((r) => setTimeout(r, SELECTION_DEBOUNCE_MS));
  const cache = sent.find((m) => m.type === 'SELECTION_CACHE');
  assert.equal(cache, undefined, 'empty selection must not wake the service worker');
  dom.window.close();
});

test('selection toolbar: registers a storage.onChanged listener; toggling the setting off does not throw', () => {
  const { dom, w, getOnChanged } = setup();
  w.eval(SRC);
  const onChanged = getOnChanged();
  assert.equal(typeof onChanged, 'function', 'must subscribe to storage changes for the live setting toggle');
  assert.doesNotThrow(() => onChanged({ showSelectionToolbar: { newValue: false } }, 'local'));
  // A mouseup while disabled must be a clean no-op (toolbar stays hidden).
  assert.doesNotThrow(() => w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true })));
  // Re-enabling likewise must not throw.
  assert.doesNotThrow(() => onChanged({ showSelectionToolbar: { newValue: true } }, 'local'));
  dom.window.close();
});

test('selection toolbar: mouseup/keydown/scroll/resize handlers are wired without throwing', () => {
  const { dom, w } = setup();
  w.eval(SRC);
  assert.doesNotThrow(() => {
    w.document.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    w.document.dispatchEvent(new w.Event('contextmenu'));
    w.document.dispatchEvent(new w.Event('scroll'));
    w.dispatchEvent(new w.Event('resize'));
  });
  dom.window.close();
});


test('toolbar labels, confirmation and dynamic waiting text follow live UI language changes in all seven languages', async () => {
  const dirs = { en: 'en', zh: 'zh_CN', ja: 'ja', ko: 'ko', es: 'es', pt: 'pt_BR', ru: 'ru' };
  const dictionaries = {};
  for (const dir of Object.values(dirs)) dictionaries[dir] = JSON.parse(await readFile(new URL(`../_locales/${dir}/messages.json`, import.meta.url), 'utf8'));
  const { dom, w, roots, getOnChanged } = setup({ uiLang: 'zh', dictionaries });
  w.eval(SRC);
  const flush = () => new Promise(r => setTimeout(r, 0));
  try {
    await flush();
    const shadow = roots[0], pop = roots[1];
    for (const [lang, dir] of Object.entries(dirs)) {
      getOnChanged()({ uiLang: { newValue: lang } }, 'local');
      await flush();
      assert.equal(shadow.querySelector('[data-action="explain"]').title, dictionaries[dir].toolbarExplain.message);
      assert.equal(shadow.querySelector('#confirm-cancel').textContent, dictionaries[dir].toolbarCancel.message);
      selectAll(w);
      const range = w.getSelection().getRangeAt(0);
      range.getBoundingClientRect = () => ({ top: 100, bottom: 120, left: 100, right: 220, width: 120, height: 20 });
      w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
      await new Promise(r => setTimeout(r, 260));
      shadow.querySelector('[data-action="explain"]').click();
      assert.ok(pop.querySelector('#pop-body').textContent.includes(dictionaries[dir].inlineExplainWaiting.message));
      pop.querySelector('#pop-close').click();
    }
    getOnChanged()({ uiLang: { newValue: 'auto' } }, 'local');
    await flush();
    assert.equal(shadow.querySelector('[data-action="explain"]').title, 'Explain');
  } finally { dom.window.close(); }
});

// ─── 浮层不显示思考内容 ──────────────────────────────────────────────────────
// agent 协议把推理以 <thinking>…</thinking> 内联在 delta 里推给消费方（主聊天
// 折叠成思考块），部分模型还把裸 <think> 写进正文——浮层一小张卡，只呈现答案
// 正文。走真实点击链路（mouseup → place → explain click → browsa-explain 端口）。

async function openExplainPopover(w, shadow) {
  selectAll(w);
  const range = w.getSelection().getRangeAt(0);
  range.getBoundingClientRect = () => ({ top: 100, bottom: 120, left: 100, right: 220, width: 120, height: 20 });
  w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
  await new Promise(r => setTimeout(r, SELECTION_DEBOUNCE_MS));
  shadow.querySelector('[data-action="explain"]').click();
}

test('explain popover: inline thinking runs are never rendered — visible answer only, waiting state while inside think', async () => {
  const { dom, w, roots, ports } = setup();
  w.eval(SRC);
  try {
    const popShadow = roots[1];
    await openExplainPopover(w, roots[0]);
    const port = ports.at(-1);
    assert.equal(port.sent[0].type, 'EXPLAIN_REQUEST', 'the click must open a browsa-explain port session');

    // 思考段开始：整段推理不可见，浮层保持等待态（不闪空白卡）
    port.emit({ type: 'EXPLAIN_CHUNK', delta: '<thinking>\n' });
    port.emit({ type: 'EXPLAIN_CHUNK', delta: '模型正在推理推理推理\n' });
    let body = popShadow.querySelector('#pop-body');
    assert.ok(body.querySelector('.pop-wait'), 'while inside an open think run the popover stays in the waiting state');
    assert.equal(body.textContent.includes('推理推理'), false, 'thinking content must not be shown');

    // 思考段闭合后答案上屏，思考内容不再出现
    port.emit({ type: 'EXPLAIN_CHUNK', delta: '</thinking>\n核心释义：**serendipity** 指不期而遇的惊喜。' });
    body = popShadow.querySelector('#pop-body');
    assert.equal(body.querySelector('.pop-wait'), null, 'waiting state must clear once the answer streams');
    assert.ok(body.textContent.includes('核心释义'), 'the visible answer must render');
    assert.ok(body.querySelector('b'), 'minimal markdown (bold) still renders');
    assert.equal(body.textContent.includes('推理推理'), false, 'thinking content stays hidden after the run closes');

    port.emit({ type: 'EXPLAIN_DONE' });
    assert.equal(popShadow.querySelector('#pop-body .pop-err'), null, 'a real answer must not turn into an error card');
  } finally { dom.window.close(); }
});

test('explain popover: bare <think> tags embedded in model content are stripped too', async () => {
  const { dom, w, roots, ports } = setup();
  w.eval(SRC);
  try {
    const popShadow = roots[1];
    await openExplainPopover(w, roots[0]);
    const port = ports.at(-1);
    port.emit({ type: 'EXPLAIN_CHUNK', delta: '<think>reasoning about it</think>译文：**hello**' });
    const body = popShadow.querySelector('#pop-body');
    assert.ok(body.textContent.includes('译文'), 'content after a bare <think> run renders');
    assert.equal(body.textContent.includes('reasoning about it'), false);
    assert.equal(body.textContent.includes('<think'), false, 'no tag fragment may leak');
  } finally { dom.window.close(); }
});

test('explain popover: a reply that is ALL thinking lands as the empty-reply error', async () => {
  const { dom, w, roots, ports } = setup();
  w.eval(SRC);
  try {
    const popShadow = roots[1];
    await openExplainPopover(w, roots[0]);
    let port = ports.at(-1);
    port.emit({ type: 'EXPLAIN_CHUNK', delta: '<thinking>只有思考没有答案</thinking>' });
    port.emit({ type: 'EXPLAIN_DONE' });
    const err = popShadow.querySelector('#pop-body .pop-err');
    assert.ok(err, 'an all-think reply is an empty reply');
    assert.ok(err.textContent.includes('(empty reply)'));
  } finally { dom.window.close(); }
});
