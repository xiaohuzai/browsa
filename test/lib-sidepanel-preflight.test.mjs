import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { makeSidepanelChromeMock, makeStorageArea, wireSendMessage } from './helpers/chrome-mock.mjs';

const html = await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/sidepanel.html', runScripts: undefined });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
for (const name of ['Node', 'NodeFilter', 'XMLSerializer', 'DOMParser', 'HTMLElement', 'MutationObserver']) globalThis[name] = dom.window[name];
globalThis.location = dom.window.location;
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

const local = makeStorageArea({ history: [{ role: 'user', content: 'old question' }], activeSessionId: 'A', historyGeneration: 'gen-A' }, { clone: true });
const sent = [];
let prepare = async () => ({ ok: true, data: {} });
let port;
let failChat = false;
globalThis.chrome = makeSidepanelChromeMock({
  onConnect: (name, p) => { if (name === 'browsa-chat') port = p; },
  sendMessage: wireSendMessage(async msg => {
    sent.push(msg);
    if (msg.type === 'GET_CONFIG') return { ok: true, data: { providers: {}, activeProvider: '' } };
    if (msg.type === 'STREAM_PEEK') return { ok: true, data: { inFlight: false } };
    if (msg.type === 'PREPARE_CHAT') return prepare(msg);
    if (msg.type === 'CHAT') {
      if (failChat) return { ok: false, code: 'HistoryChangedError', error: 'Conversation changed; please send again.' };
      const h = (await local.get('history')).history || [];
      await local.set({ history: [...h, { role: 'user', content: msg.userText }] });
    }
    return { ok: true, data: {} };
  }),
});

chrome.storage.local = local;
await import('../sidepanel.js');
await new Promise(r => setTimeout(r, 150));

test('send waits for recovery before assigning hidx, rejects reentry and respects a session switch', async t => {
  t.after(() => { port?.emit({ type: 'DONE', full: 'cleanup' }); });
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  let release, notify;
  let gate = new Promise(r => { release = r; });
  let entered = new Promise(r => { notify = r; });
  prepare = async () => { notify(); await gate; return { ok: true, data: { recoveryNotice: 'rec-1' } }; };
  input.value = 'new question';
  send.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(sent.some(m => m.type === 'PREPARE_CHAT'), 'the worker is consulted before creating a user bubble');
  await entered;
  send.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(document.querySelectorAll('.msg.user').length, 1, 'no user bubble or index is allocated during recovery');
  assert.equal(sent.filter(m => m.type === 'CHAT').length, 0);
  const recovered = { role: 'assistant', content: '', steps: [{ k: 'tool', name: 'read', target: 'old file',
    recovery: { kind: 'browsa.interrupted-step-only', id: 'rec-1', interrupted: true } }] };
  await local.set({ history: [{ role: 'user', content: 'old question' }, recovered] });
  release();
  for (let i = 0; i < 50 && !sent.some(m => m.type === 'CHAT'); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(sent.filter(m => m.type === 'CHAT').length, 1, 'repeated clicks cannot send twice');
  assert.equal([...document.querySelectorAll('.msg.user')].at(-1).dataset.hidx, '2');
  assert.ok(document.querySelector('.msg.assistant[data-hidx="1"]'), 'recovered entry renders before the new user');
  port.emit({ type: 'DONE', full: 'answer' });
  await new Promise(r => setTimeout(r, 80));

  gate = new Promise(r => { release = r; });
  entered = new Promise(r => { notify = r; });
  prepare = async () => { notify(); await gate; return { ok: true, data: {} }; };
  input.value = 'do not send to B';
  send.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await entered;
  await local.set({ history: [{ role: 'user', content: 'B conversation' }], activeSessionId: 'B', historyGeneration: 'gen-B' });
  release();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(sent.filter(m => m.type === 'CHAT').length, 1, 'a pending send must not cross a session switch');
  assert.equal(input.value, 'do not send to B', 'the unsent input remains available');
});

test('a changed history during the final send restores the draft and rerenders without a wrong index', async () => {
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  prepare = async () => ({ ok: true, data: {} });
  failChat = true;
  input.value = 'keep this draft';
  send.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  for (let i = 0; i < 50 && !sent.some(m => m.type === 'CHAT' && m.userText === 'keep this draft'); i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 80));
  assert.equal(input.value, 'keep this draft');
  assert.equal([...document.querySelectorAll('.msg.user')].some(el => el.textContent.includes('keep this draft')), false);
  assert.equal(document.querySelector('.msg.user')?.dataset.hidx, '0');
  failChat = false;
});
