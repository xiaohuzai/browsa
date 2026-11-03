// test/lib-sidepanel-resume-streaming.test.mjs — execution test for
// sidepanel.js's OTHER streaming listener: the one wired inside
// resumeInFlightStream() (called once from init(), when STREAM_PEEK reports
// an in-flight stream on tab activation/panel reopen), as opposed to
// onSend()'s listener (covered in test/lib-sidepanel-streaming.test.mjs).
//
// These are two independently-maintained, near-duplicate code blocks in
// sidepanel.js — the Phase 6 (reveal-pacer/.destroy()) and Phase 9 (async
// renderSafe/await) changes touched both. A regression fixed in one but
// missed in the other is a real, plausible failure mode for future edits,
// so this gets its own dedicated test rather than relying on the onSend()
// coverage to stand in for it.
//
// Needs its own JSDOM instance + a cache-busted re-import of sidepanel.js
// (Node's module cache would otherwise skip re-running its module-level
// `init()` call against a second document).

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

let lastChatPort = null;

globalThis.chrome = makeSidepanelChromeMock({
  tabId: 7,
  // trackDisconnect: false matches this file's original no-op onDisconnect —
  // deliberately NOT the same as the other 3 sidepanel-* test files' mocks.
  portOptions: { trackDisconnect: false },
  onConnect: (name, port) => { if (name === 'browsa-chat') lastChatPort = port; },
  sendMessage: wireSendMessage((msg) => {
    if (msg.type === 'GET_CONFIG') return { data: {} };
    // The key difference from the onSend() test: STREAM_PEEK reports an
    // in-flight stream with some accumulated text already, so init()'s
    // resumeInFlightStream() takes the "resume" branch instead of
    // returning early.
    // Real bridge wraps every reply as { ok, data }: payload fields live
    // under .data (a bare { inFlight } here silently killed the resume path
    // — same divergence class as the 0.32.x preview-shim bug).
    if (msg.type === 'STREAM_PEEK') return { ok: true, data: { inFlight: true, acc: 'resumed so far. ', startedAt: Date.now() - 5000 } };
    return { ok: true };
  }),
});

await import('../sidepanel.js?resume-test=' + Math.random());
await new Promise((r) => setTimeout(r, 100));

const messagesEl = document.getElementById('messages');

test('resumeInFlightStream(): pre-renders the STREAM_PEEK accumulated text and opens a browsa-chat port', () => {
  assert.ok(lastChatPort, 'resumeInFlightStream() must open its own browsa-chat port');
  assert.ok(lastChatPort.sent.some((m) => m.type === 'STREAM_HELLO'));
  // resume:true 是墓碑重放的门（PEEK→HELLO 竞态修复，2026-09-30 批A）：
  // 只有 resume 握手的 HELLO 才允许后台重放终态墓碑——全新发送的 HELLO
  // 发生在自己的 CHAT 之前，绝不能捡到上一轮的陈旧 DONE。
  assert.ok(lastChatPort.sent.some((m) => m.type === 'STREAM_HELLO' && m.resume === true),
    'the resume handshake must carry resume:true');
  const assistantEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.ok(assistantEl, 'an assistant bubble must exist to hold the resumed content');
});

test('resumeInFlightStream()\'s CHUNK/DONE listener only runs addCodeCopyButtons/renderMermaid AFTER the async final render lands', async () => {
  const finalText = 'Resumed reply.\n\n```js\nconst y = 2;\n```\n';
  lastChatPort.emit({ type: 'DONE', full: finalText });
  // The listener is `async (m) => {...}` and awaits r(m.full||acc, true)
  // (renderStream -> renderSafe) before addCodeCopyButtons()/renderMermaid()
  // — give it a tick to fully resolve.
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.match(assistantEl.innerHTML, /<pre[ >]/, 'the final markdown must have been rendered into real HTML');
  assert.ok(assistantEl.querySelector('.code-copy-btn'),
    'addCodeCopyButtons() must have run AFTER the final render — proves the await was not skipped in this listener too');
});

test('resumeInFlightStream()\'s ensureAssistantEl() re-resolves and destroys the old renderer when the DOM node identity changes mid-stream', async () => {
  // Simulate a second resumed stream (fresh port) to exercise the
  // DOM-identity-change branch independent of the previous test's state.
  const finalText2 = 'second resumed reply';
  // Re-trigger via a fresh CHUNK on the existing port first so there is an
  // active renderStream/pacer to abandon.
  lastChatPort.emit({ type: 'CHUNK', delta: 'streaming in...' });
  await new Promise((r) => setTimeout(r, 20));

  // Mimic onActivated's innerHTML restore replacing the whole subtree —
  // the old assistantEl node identity is gone, ensureAssistantEl() must
  // notice on the next chunk and swap renderers (calling .destroy() on the
  // abandoned one) rather than throwing or writing into a detached node.
  messagesEl.innerHTML = '<div class="msg assistant">▍</div>';

  assert.doesNotThrow(() => lastChatPort.emit({ type: 'CHUNK', delta: ' more' }));
  await new Promise((r) => setTimeout(r, 20));

  lastChatPort.emit({ type: 'DONE', full: finalText2 });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.match(assistantEl.textContent, /second resumed reply/);
  assert.ok(assistantEl.classList.contains('done'));
});

test('resumeInFlightStream()\'s DONE handler stamps dataset.videoSrc, same as onSend()\'s (regression: this path used to skip it entirely, silently breaking [mm:ss] seek clicks on a resumed video-note reply)', async () => {
  const finalText = 'Video note reply with a timestamp [01:09] in it.';
  const videoSrc = { platform: 'youtube', url: 'https://youtube.com/watch?v=abc', tabId: 7 };
  lastChatPort.emit({ type: 'DONE', full: finalText, videoSrc });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.equal(assistantEl.dataset.videoSrc, JSON.stringify(videoSrc),
    'the resumed DONE handler must stamp dataset.videoSrc exactly like the main onSend() DONE handler does');
  assert.ok(assistantEl.querySelector('.browsa-ts'), 'the [mm:ss] marker must still be linkified into a clickable span');
});

test('resumeInFlightStream()\'s DONE handler renders CHOICE_REQUEST interactive buttons, same as onSend()\'s (regression: this path used to skip renderChoiceRequest entirely)', async () => {
  const finalText = 'Which option do you want?';
  const choiceRequest = { question: 'Pick one', choices: ['Option A', 'Option B'] };
  lastChatPort.emit({ type: 'DONE', full: finalText, choiceRequest });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  const choiceWrap = assistantEl.nextElementSibling;
  assert.ok(choiceWrap?.classList.contains('choice-request'), 'a .choice-request block must be inserted after the resumed bubble');
  const buttons = choiceWrap.querySelectorAll('.choice-btn');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].textContent, 'Option A');
});

test('resumeInFlightStream()\'s DONE handler shows the one-click "→ 继续" button on a max-turns reply, same as onSend()\'s', async () => {
  const finalText = '已达上限，请问是否继续？';
  lastChatPort.emit({ type: 'DONE', full: finalText });
  await new Promise((r) => setTimeout(r, 50));

  const assistantEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  const actionRow = assistantEl.nextElementSibling;
  assert.ok(actionRow, 'an action row must be inserted after the bubble');
  assert.match(actionRow.textContent, /继续/, 'the one-click continue button must be present on a resumed max-turns reply');
});

test('resumeInFlightStream()\'s ERROR/ABORTED handler renders through the markdown pipeline and marks the bubble .done (regression: this path used to do a raw el.textContent= assignment, leaving literal markdown syntax and a permanently-blinking cursor)', async () => {
  lastChatPort.emit({ type: 'CHUNK', delta: '**partial** reply' });
  await new Promise((r) => setTimeout(r, 20));
  lastChatPort.emit({ type: 'ERROR', code: 'ABORTED' });
  await new Promise((r) => setTimeout(r, 30));

  const assistantEl = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  assert.ok(assistantEl.classList.contains('done'), 'the .done class must be added so the blinking ::after cursor stops');
  assert.ok(assistantEl.querySelector('strong'), 'markdown (**partial**) must be rendered as real HTML, not shown as literal syntax');
  assert.match(assistantEl.textContent, /cancelled/);
});

// ─── 终态清理 finally 化（2026-11-03 审计 panel-3）─────────────────────────────
// wireChatStreamPort 的 DONE/ERROR 清理此前排在 await 终渲之后且不在 finally
// 里：finishBubble 装饰链一抛错，activeController 泄漏（后续 Send 被误路由）、
// 端口不断、STREAM_RELEASE 不发、followups 永不 drain、嵌套追问卡丢进稀薄
// 空气。detail-thread 的 finalize/stopTurn 早已 try/finally（B6），主聊天同形。
// 抛错注入：finishBubble 第一步 decorateLinks 的 el.querySelectorAll('a[href]')
// ——恰好落在 innerHTML 已替换、装饰未完成的位置。

const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const clickSend = () => sendBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

async function startTurnWithNestedCard(text) {
  const { openDetailThread } = await import('../lib/sidepanel/detail-thread.js');
  inputEl.value = text;
  clickSend();
  await new Promise((r) => setTimeout(r, 50));
  const port = lastChatPort;
  port.emit({ type: 'CHUNK', delta: 'quoted passage lives here.' });
  const el = [...messagesEl.querySelectorAll('.msg.assistant')].pop();
  for (let i = 0; i < 100 && !el.textContent.includes('quoted passage lives here'); i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.match(el.textContent, /quoted passage lives here/, 'sanity: streamed text painted');
  const anchor = el.querySelector('p') || el;
  openDetailThread(el, 'quoted passage', anchor);
  const card = el.querySelector('.detail-thread-card');
  assert.ok(card && el.contains(card), 'sanity: card is NESTED in the bubble');
  return { port, el, card };
}

function armFinalizeThrow(el) {
  const orig = el.querySelectorAll.bind(el);
  el.querySelectorAll = (sel) => {
    if (sel === 'a[href]') { el.querySelectorAll = orig; throw new Error('finalize decoration boom'); }
    return orig(sel);
  };
}

function trackPortDisconnect(port) {
  const state = { count: 0 };
  const orig = port.disconnect;
  port.disconnect = () => { state.count++; return orig(); };
  state.restore = () => { port.disconnect = orig; };
  return state;
}

async function teardownTurn({ card }) {
  const { clearFollowups } = await import('../lib/sidepanel/followups.js');
  // 先清队列再终态：DONE 会 drain，清晚了可以在拆完后再开一个野回合。
  // 本文件 mock 是 trackDisconnect:false——onSend 路径 DONE 后 is-stopping
  // 不复位（真浏览器由后台断端口触发 onDisconnect 复位），不能拿它判活。
  clearFollowups();
  inputEl.value = '';
  lastChatPort.emit({ type: 'DONE', full: 'teardown reply' });
  await new Promise((r) => setTimeout(r, 100));
  if (card?.isConnected) {
    card.querySelector('.detail-thread-close')?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  }
}

test('DONE: a throw in the finalize decoration still runs ALL terminal cleanup and keeps the nested card alive', async () => {
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  const sent = [];
  const origSend = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = (msg, cb) => { sent.push(msg); return origSend(msg, cb); };
  const ctx = await startTurnWithNestedCard('turn whose finalize throws');
  const disc = trackPortDisconnect(ctx.port);
  try {
    // 流中排队一条 followup：DONE 的 finally 必须 drain 它（activeController
    // 复位 + maybeDrainFollowups 都跑到的行为证据）。流中 send 键是 ■ 停止，
    // 排队走输入框 Enter（onSend 的 mid-stream 分支），不能点按钮。
    inputEl.value = 'queued followup after crash';
    inputEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));

    armFinalizeThrow(ctx.el);
    ctx.port.emit({ type: 'DONE', full: 'quoted passage lives here. Final.' });
    // drain 是 DONE 后 50ms 的异步链（终渲 → finally → drain → onSend → CHAT）。
    for (let i = 0; i < 60 && !sent.some((m) => m.type === 'CHAT' && m.userText === 'queued followup after crash'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(ctx.el.contains(ctx.card), '嵌套追问卡必须在终渲抛错后仍活在气泡里（swapContent 事务保活）');
    assert.ok(disc.count >= 1, 'port.disconnect 必须无条件执行');
    assert.ok(sent.some((m) => m.type === 'STREAM_RELEASE' && m.tabId === 7), 'STREAM_RELEASE 必须无条件发出');
    assert.ok(sent.some((m) => m.type === 'CHAT' && m.userText === 'queued followup after crash'),
      'activeController 复位 + followups drain：排队的追问必须自动发出');
    assert.deepEqual(rejections, [], '终渲抛错必须被 catch 记录，不得成为 unhandled rejection');

    // epoch 前置接线（第五批 sw-3 的 SW 门）：DONE 带 epoch 就随 RELEASE 附上，
    // 不带则不附字段（上面第一次 DONE 无 epoch 的 RELEASE 已发出）。
    ctx.port.emit({ type: 'DONE', full: 'quoted passage lives here. Final.', epoch: 42 });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(sent.some((m) => m.type === 'STREAM_RELEASE' && m.tabId === 7 && m.epoch === 42),
      'DONE 携带的 epoch 必须随 STREAM_RELEASE 附上');
    assert.ok(sent.some((m) => m.type === 'STREAM_RELEASE' && !('epoch' in m)),
      '无 epoch 的 DONE 不得给 RELEASE 附字段');
  } finally {
    disc.restore();
    chrome.runtime.sendMessage = origSend;
    process.removeListener('unhandledRejection', onRej);
    await teardownTurn(ctx);
  }
});

test('ERROR ABORTED: a throw in the finalize render still resets the controller, disconnects and keeps the nested card', async () => {
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  const ctx = await startTurnWithNestedCard('aborted turn whose finalize throws');
  const disc = trackPortDisconnect(ctx.port);
  try {
    armFinalizeThrow(ctx.el);
    ctx.port.emit({ type: 'ERROR', code: 'ABORTED' });
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(ctx.el.contains(ctx.card), 'ABORTED 终渲抛错后嵌套卡必须仍在气泡里');
    assert.ok(disc.count >= 1, 'ERROR 清理的 disconnect 必须无条件执行');
    assert.ok(!sendBtn.classList.contains('is-stopping'), 'setStreamingUI(false) 必须无条件执行');
    // activeController 复位的行为证据：新 Send 开新端口，而不是被误入队列。
    const portBefore = lastChatPort;
    inputEl.value = 'send after aborted crash';
    clickSend();
    await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(lastChatPort, portBefore, '终态后的 Send 必须开新回合，不得被泄漏的 activeController 误路由进队列');
    assert.deepEqual(rejections, [], '终渲抛错必须被 catch，不得成为 unhandled rejection');
  } finally {
    disc.restore();
    process.removeListener('unhandledRejection', onRej);
    await teardownTurn(ctx);
  }
});

test('ERROR tombstone (SW-death replay): a throw in the finalize render still runs the full cleanup and keeps the nested card', async () => {
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  const ctx = await startTurnWithNestedCard('tombstoned turn whose finalize throws');
  const disc = trackPortDisconnect(ctx.port);
  try {
    armFinalizeThrow(ctx.el);
    ctx.port.emit({ type: 'ERROR', error: 'sw died mid-turn' });
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(ctx.el.contains(ctx.card), '墓碑重放终渲抛错后嵌套卡必须仍在气泡里');
    assert.ok(disc.count >= 1, '墓碑路径的 disconnect 必须无条件执行');
    assert.ok(!sendBtn.classList.contains('is-stopping'), '墓碑路径的 setStreamingUI(false) 必须无条件执行');
    const portBefore = lastChatPort;
    inputEl.value = 'send after tombstone crash';
    clickSend();
    await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(lastChatPort, portBefore, '墓碑终态后的 Send 必须开新回合');
    assert.deepEqual(rejections, [], '终渲抛错必须被 catch，不得成为 unhandled rejection');
  } finally {
    disc.restore();
    process.removeListener('unhandledRejection', onRej);
    await teardownTurn(ctx);
  }
});
