// test/lib-sidepanel-streaming.test.mjs — a real execution test of
// sidepanel.js itself (not one of its extracted lib/sidepanel/*.js modules).
//
// sidepanel.js has ZERO exports — it calls init() unconditionally at module
// load and only exposes behavior through DOM events (button clicks, keydown,
// chrome.runtime ports). That's also its only "API" for testing: load the
// real sidepanel.html markup into jsdom, mock the chrome.* surface it needs,
// import the real module, then drive it exactly like a browser would.
//
// This specifically targets what no other test covers: the await/.destroy()
// wiring added across Phase 6 (reveal-pacer) and Phase 9 (KaTeX worker
// offload) inside onSend()'s CHUNK/DONE port listener, since renderStream()
// (and therefore renderSafe()) became async. If a future edit drops an
// `await` there, addCodeCopyButtons()/renderMermaid() would run against a
// bubble whose innerHTML hasn't been updated to the final render yet — this
// test would catch that by including a code block in the final text and
// asserting the copy button (added by addCodeCopyButtons, which only finds
// something to act on once the real <pre> exists) is actually there.

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

// ─── chrome.* mock ───────────────────────────────────────────────────────────
let lastChatPort = null;
let sendMessageHandler = async (msg) => ({ ok: true });

globalThis.chrome = makeSidepanelChromeMock({
  sendMessage: wireSendMessage((msg) => sendMessageHandler(msg)),
  onConnect: (name, port) => { if (name === 'browsa-chat') lastChatPort = port; },
});

// GET_CONFIG / STREAM_PEEK / CHAT default responses — individual tests
// override sendMessageHandler for the behavior they need.
sendMessageHandler = async (msg) => {
  if (msg.type === 'GET_CONFIG') return { data: {} };
  if (msg.type === 'STREAM_PEEK') return { inFlight: false };
  if (msg.type === 'CHAT') return { ok: true };
  return { ok: true };
};

await import('../sidepanel.js');
// sidepanel.js's init() runs fire-and-forget (not awaited by the module
// itself) — give its promise chain (chrome.tabs.query -> GET_CONFIG ->
// renderHistory -> STREAM_PEEK -> ...) time to settle before driving any UI.
await new Promise((r) => setTimeout(r, 100));

const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const messagesEl = document.getElementById('messages');

test('sidepanel.js: init() completed without throwing (input is usable)', () => {
  assert.ok(inputEl, 'the composer textarea must exist');
  assert.equal(inputEl.disabled, false);
});

test('onSend(): CHUNK deltas render progressively, and DONE only runs addCodeCopyButtons/renderMermaid AFTER the final render has actually landed', async () => {
  inputEl.value = 'hello';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  // Let onSend() run up through its STREAM_HELLO/ACK handshake and attach
  // the real chunk listener.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort, 'onSend() must open a browsa-chat port');
  assert.ok(lastChatPort.sent.some((m) => m.type === 'STREAM_HELLO'));

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.ok(assistantEl, 'a placeholder assistant bubble must be appended immediately');

  lastChatPort.emit({ type: 'CHUNK', delta: 'partial' });
  // Deltas are paced (markstream-core) — no assertion on intermediate state
  // needed here, just enough time for it not to interfere with what follows.
  await new Promise((r) => setTimeout(r, 30));

  // Final text includes a fenced code block — addCodeCopyButtons() only
  // finds something to act on once the real <pre><code> exists in the DOM,
  // which only happens after the awaited renderSafe() call resolves. If a
  // future edit drops that `await`, this assertion is what would catch it:
  // addCodeCopyButtons() would run one tick too early, against whatever
  // (possibly still-placeholder) content was in the bubble at that moment.
  const finalText = 'Done.\n\n```js\nconst x = 1;\n```\n';
  lastChatPort.emit({ type: 'DONE', full: finalText });
  // The listener callback is async (awaits renderStream -> renderSafe) —
  // give it a tick to fully resolve before asserting on its result.
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(assistantEl.classList.contains('done'), 'bubble must be marked done once DONE is fully processed');
  assert.match(assistantEl.innerHTML, /<pre[ >]/, 'the final markdown must have been rendered into real HTML');
  assert.ok(assistantEl.querySelector('.code-copy-btn'),
    'addCodeCopyButtons() must have run AFTER the final render — proves the await was not skipped');
});

test('onSend(): a RETRY message destroys the abandoned pacer before building a fresh renderer', async () => {
  inputEl.value = 'hello again';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort);

  lastChatPort.emit({ type: 'CHUNK', delta: 'first attempt text' });
  await new Promise((r) => setTimeout(r, 30));

  // RETRY must not throw (this is exactly where render.js's makeStreamRenderer's
  // .destroy() gets invoked on the previous attempt's renderer — Phase 6).
  assert.doesNotThrow(() => lastChatPort.emit({ type: 'RETRY', attempt: 2, maxAttempts: 3 }));
  await new Promise((r) => setTimeout(r, 30));

  lastChatPort.emit({ type: 'DONE', full: 'second attempt final text' });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.match(assistantEl.textContent, /second attempt final text/);
  assert.doesNotMatch(assistantEl.textContent, /first attempt text/, 'RETRY must have cleared the failed attempt\'s content');
});

test('clicking Stop mid-stream marks the abandoned bubble .done so its blinking cursor stops', async () => {
  // Regression test: cancelStream() used to disconnect the port without
  // ever touching the in-progress bubble. The background's ERROR/ABORTED
  // message (which normally finalizes a bubble via renderStream(..., true))
  // never arrives once the port is gone client-side, so nothing else was
  // ever going to add .done — the cancelled bubble's ::after blinking
  // cursor kept animating forever, even after a brand new message was sent.
  inputEl.value = 'first message, will be cancelled';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort, 'onSend() must open a browsa-chat port');

  lastChatPort.emit({ type: 'CHUNK', delta: 'partial before cancel' });
  await new Promise((r) => setTimeout(r, 30));

  const cancelledEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  assert.ok(!cancelledEl.classList.contains('done'), 'sanity check: not done yet while streaming');

  // sendBtn doubles as Stop while a stream is active (is-stopping state).
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(cancelledEl.classList.contains('done'),
    'the cancelled bubble must be marked .done so its blinking cursor (.msg.assistant::after) stops');

  // Send a second message — its own bubble must be the ONLY one still
  // blinking (i.e. the only .msg.assistant without .done).
  inputEl.value = 'second message';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  lastChatPort.emit({ type: 'DONE', full: 'second message reply' });
  await new Promise((r) => setTimeout(r, 50));

  const stillBlinking = [...messagesEl.querySelectorAll('.msg.assistant')].filter((el) => !el.classList.contains('done'));
  assert.equal(stillBlinking.length, 0, 'after the second message completes, no assistant bubble should still be missing .done');
});

test('TOOL_PROGRESS renders before the bubble (grouped with thinking), not after', async () => {
  inputEl.value = 'use a tool please';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort);

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  lastChatPort.emit({ type: 'TOOL_PROGRESS', text: 'Reading file foo.js' });
  await new Promise((r) => setTimeout(r, 10));

  const tp = assistantEl.previousElementSibling;
  assert.ok(tp?.classList.contains('tool-progress'), 'tool-progress must be the bubble\'s PREVIOUS sibling, not its next one');
  assert.match(tp.textContent, /Reading file foo\.js/);

  // A second TOOL_PROGRESS event must update the same element in place,
  // not create a duplicate — same "overwrite" contract as before the move.
  lastChatPort.emit({ type: 'TOOL_PROGRESS', text: 'Running tests' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(assistantEl.previousElementSibling, tp, 'must reuse the same element, not insert a second one');
  assert.match(tp.textContent, /Running tests/);
  assert.doesNotMatch(tp.textContent, /Reading file/, 'old tool-progress text must be replaced, not appended');

  lastChatPort.emit({ type: 'DONE', full: 'done with tools' });
  await new Promise((r) => setTimeout(r, 50));
});

test('TS_STATUS (auto timestamp-rewrite) shows a transient status before the bubble and is cleared on DONE', async () => {
  inputEl.value = '总结一下这个视频';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(lastChatPort);

  const assistantEl = messagesEl.querySelector('.msg.assistant:last-of-type');
  // The background emits TS_STATUS after v1 finishes streaming, asking the
  // model to reformat with [mm:ss]. It must surface as a tool-progress-style
  // indicator above the bubble - but, unlike TOOL_PROGRESS, it must NOT be
  // recorded into toolEvents (or DONE would render it as a tool-history row).
  lastChatPort.emit({ type: 'TS_STATUS', text: '⏱ 正在补充时间戳…' });
  await new Promise((r) => setTimeout(r, 10));

  const tp = assistantEl.previousElementSibling;
  assert.ok(tp?.classList.contains('tool-progress'), 'TS_STATUS must render a tool-progress indicator before the bubble');
  assert.match(tp.textContent, /正在补充时间戳/);

  // DONE swaps the bubble to the rewritten text (v2) and must clear the
  // transient status indicator - it should not linger as a tool-history row.
  lastChatPort.emit({ type: 'DONE', full: '## 概述 [00:00]\n内容…' });
  await new Promise((r) => setTimeout(r, 50));

  const tpAfter = assistantEl.previousElementSibling;
  assert.ok(!tpAfter || !tpAfter.classList.contains('tool-progress'),
    'TS_STATUS indicator must be cleared on DONE');
  // And no tool-history block should have been rendered for it.
  assert.doesNotMatch(assistantEl.innerHTML, /正在补充时间戳/,
    'TS_STATUS must not leak into the bubble as rendered tool history');
});

// ─── 收尸记账（P0 wrong-delete fix, 2026-09-30 批A）─────────────────────────────
// Stop/中止时后台把已流出的部分文本以 interrupted 条目落库（chat-handler 的
// AbortError catch）。那个条目在 UI 上的化身就是被取消的气泡——气泡必须盖
// data-hidx，否则存储比镜像长 1（负漂移，reconcile 旧行为判 none 永不修复），
// 之后每个气泡的戳都低一位，删除/编辑重发全部打中隔壁条目。

test('Stop-with-salvage stamps the cancelled bubble so the hidx mirror stays in sync', async () => {
  inputEl.value = 'will be stopped mid-reply';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const userEl = [...messagesEl.querySelectorAll('.msg.user')].pop();
  const userH = parseInt(userEl.dataset.hidx, 10);
  assert.ok(Number.isInteger(userH), 'sanity: the user bubble is stamped');

  lastChatPort.emit({ type: 'CHUNK', delta: 'partial text worth salvaging' });
  await new Promise((r) => setTimeout(r, 30));
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true })); // Stop
  await new Promise((r) => setTimeout(r, 20));

  const cancelledEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.equal(cancelledEl.dataset.hidx, String(userH + 1),
    'the salvaged partial reply is a real storage entry — its visible twin must carry the matching hidx');

  // The NEXT send must continue from there — the actual regression: before
  // the fix this bubble stamped userH+1 (one too low) and deleting it hit
  // the invisible salvage entry instead of its own.
  inputEl.value = 'next message after the stop';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const nextUserEl = [...messagesEl.querySelectorAll('.msg.user')].pop();
  assert.equal(nextUserEl.dataset.hidx, String(userH + 2),
    'subsequent sends stamp sequentially — no off-by-one after a salvaged cancel');
  lastChatPort.emit({ type: 'DONE', full: 'reply after stop' });
  await new Promise((r) => setTimeout(r, 50));
});

test('Stop before any chunk leaves the empty bubble UNSTAMPED (mirrors the background\'s `partial` salvage gate)', async () => {
  inputEl.value = 'stopped before anything streamed';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true })); // Stop, zero chunks
  await new Promise((r) => setTimeout(r, 20));
  const cancelledEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.equal(cancelledEl.dataset.hidx, undefined,
    'nothing streamed → background salvages nothing (its `partial` gate) → no storage twin → no stamp');
});

test('a background-initiated abort (ERROR ABORTED, salvaged:true) stamps the finalized bubble', async () => {
  inputEl.value = 'idle-timeout victim';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  const userEl = [...messagesEl.querySelectorAll('.msg.user')].pop();
  const userH = parseInt(userEl.dataset.hidx, 10);
  lastChatPort.emit({ type: 'CHUNK', delta: 'some text before the timeout' });
  await new Promise((r) => setTimeout(r, 30));
  // 后台发起的中止（空闲超时/网络断）：端口还连着，ERROR ABORTED 真的会送达。
  lastChatPort.emit({ type: 'ERROR', error: 'cancelled', code: 'ABORTED', salvaged: true });
  await new Promise((r) => setTimeout(r, 60));
  const el = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.match(el.textContent, /cancelled/, 'the bubble finalizes with the cancelled marker');
  assert.equal(el.dataset.hidx, String(userH + 1), 'the salvage entry has a visible twin — stamp it');
});

test('ERROR ABORTED without salvaged leaves the bubble unstamped (nothing was stored)', async () => {
  inputEl.value = 'aborted with nothing to salvage';
  sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  lastChatPort.emit({ type: 'ERROR', error: 'cancelled', code: 'ABORTED' });
  await new Promise((r) => setTimeout(r, 60));
  const el = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.equal(el.dataset.hidx, undefined, 'no salvage → no storage entry → no stamp');
});

// ─── 流的 tabId 归属（cancel/REASSIGN 打错键修复）──────────────────────────────

test('cancel aborts the stream\'s OWN tab: STREAM_ABORT carries the same tabId as CHAT', async () => {
  const sent = [];
  const prev = sendMessageHandler;
  sendMessageHandler = async (msg) => { sent.push(msg); return prev(msg); };
  try {
    inputEl.value = 'abort tab consistency';
    sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    lastChatPort.emit({ type: 'CHUNK', delta: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true })); // Stop
    await new Promise((r) => setTimeout(r, 20));
    const chat = sent.find((m) => m.type === 'CHAT');
    const abort = sent.find((m) => m.type === 'STREAM_ABORT');
    assert.ok(chat, 'sanity: CHAT was sent');
    assert.ok(abort, 'sanity: STREAM_ABORT was sent');
    assert.equal(abort.tabId, chat.tabId,
      'the abort must target the tab the stream is keyed by — aborting the LIVE currentTabId no-ops after a tab switch (server keeps burning tokens)');
    assert.equal(abort.salvage, true, 'default cancel salvages the partial');
  } finally {
    sendMessageHandler = prev;
  }
});

test('source pin: stream-addressing sites use the stream\'s tabId, never bare currentTabId', async () => {
  const src = await readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
  assert.match(src, /const streamTabId = activeController\.tabId \?\? currentTabId;/,
    'cancelStream resolves the stream tab off the controller');
  assert.match(src, /sendMessage\(\{ type: 'STREAM_ABORT', tabId: streamTabId, salvage \}\)/);
  assert.match(src, /function streamTabIdOf\(\) \{ return activeController\?\.tabId \?\? currentTabId; \}/,
    'REASSIGN callers share one resolver');
  assert.match(src, /type: 'REASSIGN_STREAM_SESSION', tabId: streamTabIdOf\(\)/);
  assert.doesNotMatch(src, /type: 'STREAM_ABORT', tabId: currentTabId/,
    'the bare-currentTabId abort shape must never come back');
});
