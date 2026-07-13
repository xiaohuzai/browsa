// test/subchat.test.mjs
// Tests for the SUBCHAT/SUBCHAT_ABORT "detail thread" side-conversation
// added to background.js: select text in an assistant reply -> scoped
// follow-up that never touches the main history, always uses chatStream
// (never runsApiStream), and streams over a dedicated browsa-subchat port
// keyed by a client-generated subId (not tabId).
//
// SUBCHAT itself calls storage.getAll() before validating its own
// arguments, so — following the same convention as the existing "CHAT
// handler routes to..." tests in test/approval-clarify.test.mjs — most of
// this file asserts against the static source rather than invoking
// handle() directly (invoking it would require a fuller chrome.storage.local
// mock than any other test file in this suite sets up). SUBCHAT_ABORT does
// not touch storage, so that one is exercised via a real handle() call.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Captured so tests can simulate a real port connecting, to exercise the
// actual browsa-subchat onConnect handler (not just its static source) —
// needed for the tab-switch routing regression test below.
let capturedOnConnect = null;

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: (fn) => { capturedOnConnect = fn; } },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => ({
      name: 'browsa-chat',
      postMessage: () => {},
      disconnect: () => {},
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} }
    }),
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Test' }],
    get: async () => ({ id: 1, url: 'https://example.com', title: 'Test' }),
  },
  sidePanel: {
    setOptions: () => {},
    setPanelBehavior: async () => {},
  },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => [{ result: { text: '# Mock page\n\nMock.', articleTitle: 'Mock', wasCapped: false, rawTextLength: 20 } }],
  },
  storage: {
    onChanged: { addListener: () => {} },
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} },
  },
  contextMenus: {
    create: () => {},
    onClicked: { addListener: () => {} },
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

const bg = await import('../background.js');
const { handle, subChatControllers, subChatPorts } = bg;

async function readBackgroundSrc() {
  const fs = await import('fs/promises');
  return fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
}

// SUBCHAT/SUBCHAT_ABORT bodies live in lib/handlers/subchat-handler.js
// (extracted from background.js's case bodies — see Phase 2 of the
// sidepanel/background modularization refactor).
async function readSubchatHandlerSrc() {
  const fs = await import('fs/promises');
  return fs.readFile(new URL('../lib/handlers/subchat-handler.js', import.meta.url), 'utf8');
}

// A minimal fake chrome.runtime.Port: captures its own onMessage listener so
// tests can simulate SUBCHAT_HELLO/SUBCHAT_FOLLOW messages arriving on it.
function makeFakePort(name) {
  const port = {
    name,
    _messageListener: null,
    _disconnectListener: null,
    onMessage: { addListener: (fn) => { port._messageListener = fn; } },
    onDisconnect: { addListener: (fn) => { port._disconnectListener = fn; } },
    postMessage: () => {},
    disconnect: () => { port._disconnectListener?.(); },
  };
  return port;
}

// --------------- SUBCHAT: never touches main history ------------------------

test('SUBCHAT never calls storage.appendToHistory', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.doesNotMatch(subchatSrc, /appendToHistory\(/, 'SUBCHAT must never write to the main history');
});

// --------------- SUBCHAT: always chatStream, never runsApiStream ------------

test('SUBCHAT always uses chatStream, never runsApiStream, regardless of isHermes', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /await chatStream\(/, 'SUBCHAT must call chatStream');
  assert.doesNotMatch(subchatSrc, /runsApiStream\(/, 'SUBCHAT must never call runsApiStream — no tool/approval flow for a side question');
  assert.doesNotMatch(subchatSrc, /\bisHermes\b/, 'SUBCHAT must not branch on isHermes — always the simple chatStream path');
});

// --------------- SUBCHAT: shares CAPABILITY_HINTS with CHAT -----------------

test('SUBCHAT prepends the same CAPABILITY_HINTS constant CHAT uses (single definition)', async () => {
  const src = await readBackgroundSrc();
  const defCount = (src.match(/const CAPABILITY_HINTS = \[/g) || []).length;
  assert.equal(defCount, 1, 'CAPABILITY_HINTS must be defined exactly once (shared by CHAT and SUBCHAT)');

  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /role: 'system', content: capabilityHints/, 'SUBCHAT must prepend the capabilityHints param (background.js\'s CAPABILITY_HINTS) as a system message');

  // CHAT still builds effectiveSystemPrompt from the same constant (passed
  // in as the capabilityHints param from background.js's CAPABILITY_HINTS).
  const chatHandlerSrc = await (async () => {
    const fs = await import('fs/promises');
    return fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');
  })();
  assert.match(chatHandlerSrc, /effectiveSystemPrompt = \[[^\]]*capabilityHints/, 'CHAT must still reference capabilityHints');
});

// --------------- SUBCHAT: must not leak CHOICE_REQUEST into plain text -----
//
// Regression test for a real bug found via live testing: CAPABILITY_HINTS
// used to include the instruction telling the model to end replies with
// CHOICE_REQUEST:{...} for clickable buttons. CHAT parses and strips that
// tail before rendering/persisting (background.js's fullReply.slice(...))
// and sidepanel.js renders it as buttons — SUBCHAT's small card does
// neither, so the raw "CHOICE_REQUEST:{...}" JSON was leaking into the
// detail-thread reply as literal, unrendered-looking text. Fix: the
// CHOICE_REQUEST instruction is its own constant, appended only to CHAT's
// effectiveSystemPrompt, never to SUBCHAT's messages.

test('CHOICE_REQUEST instruction is CHAT-only, never included in SUBCHAT', async () => {
  const src = await readBackgroundSrc();
  assert.match(src, /const CHOICE_REQUEST_HINT =/, 'CHOICE_REQUEST_HINT must be its own constant');
  assert.doesNotMatch(CAPABILITY_HINTS_SRC(src), /CHOICE_REQUEST/, 'CAPABILITY_HINTS itself must not mention CHOICE_REQUEST');

  const subchatSrc = await readSubchatHandlerSrc();
  assert.doesNotMatch(subchatSrc, /CHOICE_REQUEST/, 'SUBCHAT must never reference CHOICE_REQUEST_HINT or the literal string');

  const fs = await import('fs/promises');
  const chatHandlerSrc = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');
  assert.match(chatHandlerSrc, /effectiveSystemPrompt = \[[^\]]*choiceRequestHint/, 'CHAT must append choiceRequestHint (background.js\'s CHOICE_REQUEST_HINT) to effectiveSystemPrompt');
});

function CAPABILITY_HINTS_SRC(src) {
  const start = src.indexOf('const CAPABILITY_HINTS = [');
  const end = src.indexOf('].join(\' \');', start);
  return src.slice(start, end);
}

// --------------- browsa-subchat port: opened fresh per send, keyed by subId -
//
// Regression test for a real bug found via live testing: the original
// design used ONE port connected once at panel-init, kept alive for the
// whole panel lifetime and re-registered under a new tabId on tab switch
// (mirroring browsa-nav's FOLLOW). That has a real race — if the SW went
// idle while the user was reading before opening a detail thread, the
// persistent port dies and only reconnects on a delayed timer, while
// sendMessage({type:'SUBCHAT'}) wakes the SW almost immediately; deltas
// could start arriving and get silently dropped before the port finished
// reconnecting — exactly what the user saw ("Agent 没有反应"). The fix:
// open a fresh port per send and wait for its HELLO_ACK before sending,
// exactly like onSend() does for the main browsa-chat port. Routing is now
// keyed by subId (globally unique per send), not tabId, so there is no
// FOLLOW/re-tab concept left to get wrong.

test('browsa-subchat port registers under subId (not tabId) on HELLO, and cleans up on disconnect', async () => {
  subChatPorts.clear();
  assert.ok(typeof capturedOnConnect === 'function', 'background.js must register an onConnect listener');

  const port = makeFakePort('browsa-subchat');
  capturedOnConnect(port);
  assert.ok(typeof port._messageListener === 'function', 'browsa-subchat handler must attach an onMessage listener');

  port._messageListener({ type: 'SUBCHAT_HELLO', subId: 'sub-abc' });
  assert.equal(subChatPorts.get('sub-abc'), port, 'subId must be routed to this port after HELLO');

  port.disconnect();
  assert.equal(subChatPorts.has('sub-abc'), false, 'entry must be cleared on disconnect');
});

test('two concurrent detail threads (different subIds) get independent ports, no collision', async () => {
  subChatPorts.clear();
  const portA = makeFakePort('browsa-subchat');
  const portB = makeFakePort('browsa-subchat');
  capturedOnConnect(portA);
  capturedOnConnect(portB);

  portA._messageListener({ type: 'SUBCHAT_HELLO', subId: 'sub-A' });
  portB._messageListener({ type: 'SUBCHAT_HELLO', subId: 'sub-B' });

  assert.equal(subChatPorts.get('sub-A'), portA);
  assert.equal(subChatPorts.get('sub-B'), portB);

  portA.disconnect();
  assert.equal(subChatPorts.has('sub-A'), false, 'disconnecting A must not affect B');
  assert.equal(subChatPorts.get('sub-B'), portB, 'B must be unaffected by A disconnecting');
});

// --------------- SUBCHAT: validates its own required fields -----------------

test('SUBCHAT requires subId and a non-empty messages array (no tabId dependency)', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /if \(!subId\) throw/, 'must validate subId is present');
  assert.match(subchatSrc, /!userMessages\.length/, 'must validate messages is non-empty');
  // Routing no longer depends on tabId at all — confirms the fix didn't
  // leave a stale tabId-based lookup anywhere in this case.
  assert.doesNotMatch(subchatSrc, /\btabId\b/, 'SUBCHAT must not reference tabId anywhere — routing is by subId only');
});

// --------------- SUBCHAT: streams over the dedicated subchat port -----------

test('SUBCHAT pushes chunks via pushSubChatChunk keyed by subId, not the main pushChunk', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_CHUNK', subId, delta \}\)/);
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_DONE', subId \}\)/);
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_ERROR', subId, message:/);
  // Must not fall back to the main chat's per-turn port for this traffic.
  assert.doesNotMatch(subchatSrc, /\bpushChunk\(/, 'SUBCHAT must use pushSubChatChunk, never the main pushChunk');
});

// --------------- SUBCHAT_ABORT: real handle() invocation --------------------

test('SUBCHAT_ABORT aborts and clears the controller when one is pending', async () => {
  subChatControllers.clear();
  const controller = new AbortController();
  let aborted = false;
  controller.abort = () => { aborted = true; };
  subChatControllers.set('sub-1', controller);

  const res = await handle({ type: 'SUBCHAT_ABORT', subId: 'sub-1' });

  assert.equal(res.aborted, true);
  assert.equal(aborted, true, 'controller.abort() must be called');
  assert.equal(subChatControllers.has('sub-1'), false, 'controller must be removed from the map');
});

test('SUBCHAT_ABORT is a safe no-op when no matching subId is pending', async () => {
  subChatControllers.clear();
  const res = await handle({ type: 'SUBCHAT_ABORT', subId: 'does-not-exist' });
  assert.equal(res.aborted, false);
});

// --------------- subChatControllers is independent of chatControllers ------

test('subChatControllers is keyed by subId, not tabId, and is exported for testability', async () => {
  assert.ok(subChatControllers instanceof Map, 'subChatControllers must be exported as a Map');
  // Defined in lib/state.js now (background.js re-exports the same binding —
  // see the import/export block at the top of background.js).
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/state.js', import.meta.url), 'utf8');
  assert.match(src, /export const subChatControllers = new Map\(\);/);
});
