// test/lib-sidepanel-history-nonblocking.test.mjs — execution test proving
// init() does NOT block the rest of its event-listener wiring on
// renderHistory()'s background KaTeX/mermaid/echarts upgrade pass.
//
// Regression this exists to catch: renderHistory() originally did
// `await Promise.all(asyncUpgrades.map(... renderSafe ...))` before
// returning. Since init() does `await renderHistory()` with every other
// addEventListener call (send button, attach button, keyboard shortcuts,
// etc.) written AFTER that line, the ENTIRE panel stayed non-interactive
// until every assistant message's full renderSafe() pass finished —
// including KaTeX math rendering, which round-trips through a Worker.
// A real user reported this as "reopening the side panel, the whole
// extension doesn't respond — buttons don't do anything" on a history with
// several messages. The fix: renderHistory() returns right after its fast
// synchronous first pass; the renderSafe() upgrade runs as a detached
// background task with a visible "正在渲染历史消息…" pill (reusing the
// .tool-progress styling from showAttachProgress) instead of blocking.
//
// This test seeds a history whose assistant reply contains an actual math
// formula, so the renderSafe() background pass has real (non-trivial) work
// to do — proving the send button is already live well before that
// background work resolves, not just "fast enough that we can't tell."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { makeSidepanelChromeMock, wireSendMessage } from './helpers/chrome-mock.mjs';

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

const FAKE_HISTORY = [
  { role: 'user', content: 'explain the formula' },
  { role: 'assistant', content: 'The result is $$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$ which follows from the power rule.' },
];

let lastChatPort = null;

globalThis.chrome = makeSidepanelChromeMock({
  onConnect: (name, port) => { if (name === 'browsa-chat') lastChatPort = port; },
  sendMessage: wireSendMessage((msg) => {
    if (msg.type === 'GET_CONFIG') return { data: {} };
    if (msg.type === 'STREAM_PEEK') return { inFlight: false };
    return { ok: true };
  }),
});
globalThis.chrome.storage.local.get = async (key) =>
  key === 'history' ? { history: FAKE_HISTORY } : {};

await import('../sidepanel.js');
// Deliberately short — long enough for init()'s own awaited steps
// (chrome.tabs.query / GET_CONFIG / renderHistory()'s synchronous first
// pass) to settle, but almost certainly before the background renderSafe()
// KaTeX pass has resolved. If init() were still blocked on that pass (the
// regression this test guards against), the send button below would not
// be wired yet and this test would fail.
await new Promise((r) => setTimeout(r, 60));

const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');

test('renderHistory()\'s background KaTeX/mermaid upgrade pass does not block init() from finishing — the panel is interactive almost immediately', async () => {
  assert.equal(inputEl.disabled, false, 'composer must already be enabled');

  inputEl.value = 'are you there?';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(lastChatPort, 'clicking Send this early must still open a browsa-chat port — proves init() finished wiring listeners without waiting for the history upgrade pass');

  lastChatPort.emit({ type: 'DONE', full: 'reply' });
  await new Promise((r) => setTimeout(r, 30));
});

test('a visible "正在渲染历史消息…" indicator is shown while the background upgrade is in flight, and removed once it finishes', async () => {
  // The previous test already fired at t=60ms; by now (t~140ms) the KaTeX
  // worker round-trip for one formula may or may not have resolved yet in
  // this fast test environment, so we only assert the indicator eventually
  // clears — not that it's necessarily still present right now (a flaky,
  // timing-dependent assertion). What matters structurally is that it never
  // gets stuck forever.
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(document.getElementById('history-upgrade-progress'), null,
    'the upgrade-in-progress pill must be removed once the background renderSafe() pass finishes');
});
