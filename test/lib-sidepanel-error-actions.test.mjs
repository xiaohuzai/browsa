// test/lib-sidepanel-error-actions.test.mjs — execution test for the
// classified error card's primary action (appendError() in sidepanel.js +
// .err-actions in sidepanel.css, 2026-10-23 borrowing web-clipper's
// SaveErrorDetail.primaryAction shape): an auth/model-classified failure gets
// a direct 「打开设置」 button so the fix is one click instead of prose
// archaeology; unclassified/compact errors stay button-free.
//
// Same black-box jsdom approach as test/lib-sidepanel-status-dot.test.mjs
// (sidepanel.js has zero exports) — its own file/JSDOM instance so this
// doesn't share module state with the other sidepanel.js execution tests.

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

const sentMessages = [];
let sendMessageHandler = async (msg) => {
  if (msg.type === 'GET_CONFIG') return { data: {} };
  if (msg.type === 'STREAM_PEEK') return { inFlight: false };
  sentMessages.push(msg);
  return { ok: true };
};

globalThis.chrome = makeSidepanelChromeMock({
  sendMessage: wireSendMessage((msg) => sendMessageHandler(msg)),
});
// openSettingsPage() reads chrome.runtime.getURL('options.html') before asking
// the worker to open the tab; the shared mock has no runtime.getURL.
globalThis.chrome.runtime.getURL = (p) => 'chrome-extension://test/' + p;

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const attachBtn = document.getElementById('attach');

async function failAttachWith(errorText) {
  sendMessageHandler = async (msg) => {
    if (msg.type === 'GET_CONFIG') return { data: {} };
    if (msg.type === 'STREAM_PEEK') return { inFlight: false };
    sentMessages.push(msg);
    if (msg.type === 'ATTACH_PAGE') return { ok: false, error: errorText };
    return { ok: true };
  };
  attachBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  return document.querySelector('#messages .msg.error:last-child');
}

test('an auth-classified error card carries a settings button that opens the options page', async () => {
  const card = await failAttachWith('401 unauthorized: invalid api key');
  assert.ok(card?.classList.contains('has-detail'), 'a classified error renders the full card');

  const btn = card.querySelector('.err-action-btn');
  assert.ok(btn, 'errAuth card must carry a settings action button');
  assert.ok(btn.textContent.length > 0, 'the button must carry localized copy');

  sentMessages.length = 0;
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sentMessages.some((m) => m.type === 'OPEN_OPTIONS_TAB'),
    'clicking the button must open the settings page');
});

test('model-classified errors get the button too; unclassified ones stay button-free', async () => {
  const card = await failAttachWith('model gpt-x does not exist');
  assert.ok(card?.querySelector('.err-action-btn'), 'errModel card must carry the settings button');

  const plain = await failAttachWith('boom: something odd happened and nothing classified');
  assert.equal(plain?.querySelector('.err-action-btn'), null,
    'unclassified errors must not grow a settings button');
});
