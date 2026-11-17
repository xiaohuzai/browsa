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
for (const name of ['Node', 'NodeFilter', 'XMLSerializer', 'DOMParser', 'HTMLElement', 'MutationObserver']) globalThis[name] = dom.window[name];
globalThis.location = dom.window.location;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const config = { providers: {
  source: { type: 'agent', alias: 'Source', baseUrl: 'http://source.test' },
  other: { type: 'agent', alias: 'Other', baseUrl: 'http://other.test' },
}, activeProvider: 'source' };
const history = [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'earlier reply', providerKey: { name: 'other', model: '' } },
  { role: 'user', content: 'run a tool' },
  { role: 'assistant', content: '', steps: [{ k: 'tool', name: 'read', target: 'src/app.ts',
    recovery: { kind: 'browsa.interrupted-step-only', id: 'ui-id', interrupted: true,
      providerLabel: 'Source Agent', providerKey: { name: 'source', model: '' } } }] },
];
globalThis.chrome = makeSidepanelChromeMock({ sendMessage: wireSendMessage(msg => {
  if (msg.type === 'GET_CONFIG') return { ok: true, data: config };
  if (msg.type === 'STREAM_PEEK') return { ok: true, data: { inFlight: false } };
  return { ok: true, data: {} };
}) });
const baseLocalGet = chrome.storage.local.get.bind(chrome.storage.local);
chrome.storage.local.get = async key => key === 'history' ? { history } : baseLocalGet(key);
await import('../sidepanel.js');
await new Promise(r => setTimeout(r, 500));

test('recovered internal metadata drives source chip and the next provider-switch decision', async () => {
  const recovered = document.querySelector('.msg.assistant[data-hidx="3"]');
  assert.equal(recovered?.querySelector('.msg-provider')?.textContent, 'Source Agent');
  assert.match(recovered.textContent, /interrupt/i);
  assert.match(recovered.textContent, /read.*src\/app\.ts/);
  const select = document.getElementById('provider');
  select.value = 'source';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(document.querySelector('.provider-switch-card'), null, 'selecting the recovered source needs no handoff');
  select.value = 'other';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  assert.ok(document.querySelector('.provider-switch-card'), 'switching to a different agent offers the handoff');
});
