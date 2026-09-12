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

// --------------- SUBCHAT: runs for Hermes (dedicated session), dispatcher for LLM styles

test('SUBCHAT: LLM styles via the shared dispatcher; Hermes gets its own runs branch on a DEDICATED per-subId session', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /dispatchStyleStream\(/, 'LLM provider styles must use the shared LLM stream dispatcher');
  assert.match(subchatSrc, /chatMessages: messages/, 'SUBCHAT must route the chat/completions path its message array');
  const dispatchSrc = await (await import('node:fs/promises')).readFile(new URL('../lib/handlers/stream-dispatch.js', import.meta.url), 'utf8');
  assert.match(dispatchSrc, /chatStream\(\{/, 'the dispatcher must provide the chatStream path');
  // 2026-09-11 reversal of the old "never runsApiStream" rule: the compat
  // chat-completions layer does not surface Hermes's reasoning at all (verified
  // live), while runs streams reasoning.available. Runs is ONLY for the
  // isHermes branch, on a dedicated per-subId session — never the main chat's
  // storage-backed session id, or the side Q&A would pour into the main
  // conversation's server-side agent context.
  assert.match(subchatSrc, /provider\.isHermes/, 'Hermes must get its own runs branch');
  assert.match(subchatSrc, /runsApiStream\(/, 'the Hermes branch must stream via runsApiStream (reasoning.available → <thinking>)');
  assert.match(subchatSrc, /subchatHermesSessions\.get\(subId\)/, 'the runs session must come from the per-subId detail-thread map');
  assert.doesNotMatch(subchatSrc, /getOrCreateHermesSessionId/,
    'SUBCHAT must never reuse the MAIN chat Hermes session id — that would mix the side question into the main agent context');
  assert.match(subchatSrc, /subChatRunIds/, 'run ids must be tracked for server-side cancellation');
  assert.match(subchatSrc, /\/v1\/runs\/\$\{encodeURIComponent\(runInfo\.runId\)\}\/stop/,
    'abort must fire the server-side /stop (there is no /cancel route) so a stopped follow-up stops executing tools');
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
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_DONE', subId, providerLabel, providerKey, \.\.\.\(st\.finishReason === 'length' \? \{ truncated: true \} : \{\}\) \}\)/);
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_ERROR', subId, message:/);
  // Must not fall back to the main chat's per-turn port for this traffic.
  assert.doesNotMatch(subchatSrc, /\bpushChunk\(/, 'SUBCHAT must use pushSubChatChunk, never the main pushChunk');
});

// --------------- SUBCHAT: reply-source stamp on DONE -------------------------

test('SUBCHAT_DONE carries the same reply-source stamp as CHAT, via the shared resolver', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /providerEntryLabel\(all\.activeProvider, provider, replyModelOrEndpoint\)/,
    'the label must come from provider-display.js — the same naming the sidebar dropdown and main-chat chips use');
  // The "which model/endpoint suffix goes in the stamp for this provider kind"
  // mapping is defined ONCE in provider-resolver.js and shared with CHAT.
  const resolverSrc = await (await import('node:fs/promises')).readFile(new URL('../lib/handlers/provider-resolver.js', import.meta.url), 'utf8');
  assert.match(resolverSrc, /export function resolveReplyModelOrEndpoint\(/);
  const chatHandlerSrc = await (await import('node:fs/promises')).readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');
  assert.match(chatHandlerSrc, /resolveReplyModelOrEndpoint\(provider, all, bridgeEndpoint\)/,
    'CHAT must consume the same shared mapping — no per-handler copies to drift');
});

// --------------- SUBCHAT: agent process surfacing (approval/clarify/progress)

test('SUBCHAT pushes tool progress + approval/clarify chunks and relays replies subId-keyed, all three agent kinds covered', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_TOOL_PROGRESS', subId, text \}\)/);
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_APPROVAL', subId, data \}\)/);
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_CLARIFY', subId, data \}\)/);
  // Runs + opencode + bridge branches all wire onApproval: two `onApproval:`
  // option keys (opencode/bridge) plus the runs branch's local const passed
  // as shorthand (`onApproval,` at the runsApiStream call).
  assert.equal((subchatSrc.match(/onApproval:/g) || []).length, 2, 'opencode + bridge branches must surface approval requests');
  assert.match(subchatSrc, /const onApproval = \(data\) => \{/, 'the runs branch must define its own approval handler');
  assert.match(subchatSrc, /\n          onApproval,\n/, 'the runs branch must pass its approval handler to runsApiStream');
  assert.equal((subchatSrc.match(/onToolProgress:/g) || []).length, 3, 'all three agent branches must surface tool progress');
  // subId-keyed pending maps, cleaned on abort AND turn end.
  assert.match(subchatSrc, /const subchatPendingApprovals = new Map\(\)/);
  assert.match(subchatSrc, /const subchatPendingClarifications = new Map\(\)/);
  assert.match(subchatSrc, /export async function handleSubchatApprovalRespond\(/);
  assert.match(subchatSrc, /export async function handleSubchatClarifyRespond\(/);
  const bgSrc = await readBackgroundSrc();
  assert.match(bgSrc, /case 'SUBCHAT_APPROVAL_RESPOND':/, 'background must route the subchat approval relay');
  assert.match(bgSrc, /case 'SUBCHAT_CLARIFY_RESPOND':/, 'background must route the subchat clarification relay');
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
