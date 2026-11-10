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
import { makeStorageArea } from './helpers/chrome-mock.mjs';

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
    // 行为级测试（stop→resend 竞态）要跑真 handleSubchat → storage.getAll/
    // takeTurnUsage，需要可用的 local/session 区（唯一 storage 桩实现）。
    local: makeStorageArea(),
    session: makeStorageArea(),
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
const { handleSubchat, handleSubchatAbort } = await import('../lib/handlers/subchat-handler.js');

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

test('SUBCHAT finally cleanup is identity-gated (a late old-turn finally must not delete a new turn)', async () => {
  // 2026-11-03 审计：停止后立刻重发，旧流的 abort rejection 异步落地（卡在无
  // signal 的 session 创建时可迟数秒），旧 finally 曾无条件 delete(subId)→删掉
  // 新回合的 controller/runId/pending（新回合 Stop 变 no-op）。须与主聊天
  // ownsController 同形，按本回合 controller 身份门控。
  const subchatSrc = await readSubchatHandlerSrc();
  const finallyIdx = subchatSrc.lastIndexOf('} finally {');
  assert.ok(finallyIdx > 0, 'subchat stream has a finally cleanup');
  const block = subchatSrc.slice(finallyIdx, finallyIdx + 600);
  assert.match(block, /if \(subChatControllers\.get\(subId\) === controller\)/,
    'finally must gate on this turn’s controller identity before deleting controller/runId/pending');
  const deleteIdx = block.indexOf('subChatControllers.delete(subId)');
  const gateIdx = block.indexOf('subChatControllers.get(subId) === controller');
  assert.ok(gateIdx !== -1 && gateIdx < deleteIdx, 'the identity gate must precede the delete');
});

// --------------- SUBCHAT: runs for Hermes (dedicated session), dispatcher for LLM styles

test('SUBCHAT: LLM styles via the shared dispatcher; Hermes gets its own runs branch on a DEDICATED per-subId session', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /dispatchStyleStream\(/, 'LLM provider styles must use the shared LLM stream dispatcher');
  assert.match(subchatSrc, /chatMessages: buildMessages\(/, 'SUBCHAT must route the chat/completions path through the shared message builder (image turns included)');
  // 图片轮（2026-09-25）：追问卡随 SUBCHAT 带图，转发前必须过共享轮预算。
  assert.match(subchatSrc, /pickTurnImages\(Array\.isArray\(msg\.images\)/, 'forwarded images must go through the shared per-turn budget (lib/image-budget.js)');
  assert.match(subchatSrc, /images: turnImages/, 'opencode/bridge streams must receive the turn images');
  const dispatchSrc = await (await import('node:fs/promises')).readFile(new URL('../lib/handlers/stream-dispatch.js', import.meta.url), 'utf8');
  assert.match(dispatchSrc, /chatStream\(\{/, 'the dispatcher must provide the chatStream path');
  // 2026-09-11 reversal of the old "never runsApiStream" rule: the compat
  // chat-completions layer does not surface Hermes's reasoning at all (verified
  // live), while runs streams reasoning.available. Runs is ONLY for the
  // isHermes branch, on a dedicated per-subId session — never the main chat's
  // storage-backed session id, or the side Q&A would pour into the main
  // conversation's server-side agent context.
  assert.match(subchatSrc, /provider\.isHermes/, 'Hermes must get its own runs branch');
  assert.match(subchatSrc, /buildHermesTurn\(/, 'the runs input must be built by the shared builder (image turns become text/image_url parts)');
  assert.match(subchatSrc, /runsApiStream\(/, 'the Hermes branch must stream via runsApiStream (reasoning.available → <thinking>)');
  assert.match(subchatSrc, /subchatHermesSessions\.get\(subId\)/, 'the runs session must come from the per-subId detail-thread map');
  assert.doesNotMatch(subchatSrc, /getOrCreateHermesSessionId/,
    'SUBCHAT must never reuse the MAIN chat Hermes session id — that would mix the side question into the main agent context');
  assert.match(subchatSrc, /subChatRunIds/, 'run ids must be tracked for server-side cancellation');
  // C4 后 /stop 的 fetch 唯一住在 agent-stream-session.js；subchat-handler 只调用。
  assert.match(subchatSrc, /stopHermesRun\(runInfo\)/, 'abort must fire the shared server-side /stop helper');
  const agentSrc = await (async () => {
    const fs = await import('fs/promises');
    return fs.readFile(new URL('../lib/handlers/agent-stream-session.js', import.meta.url), 'utf8');
  })();
  assert.match(agentSrc, /\/v1\/runs\/\$\{encodeURIComponent\(runInfo\.runId\)\}\/stop/,
    'abort must fire the server-side /stop (there is no /cancel route) so a stopped follow-up stops executing tools');
});

// --------------- SUBCHAT: shares CAPABILITY_HINTS with CHAT -----------------

test('SUBCHAT prepends the same CAPABILITY_HINTS constant CHAT uses (single definition)', async () => {
  // C5 后常量住 lib/prompt-assembly.js（单一定义）——pin 跟着搬家，「全局唯一」意图不变。
  // 2026-09-28 起 CAPABILITY_HINTS 由 CAPABILITY_HINTS_ENTRIES（唯一文本源，
  // 与 AGENT_RENDER_HINT 共享）join 而来，单一定义 pin 跟到 entries 数组。
  const promptSrc = await readPromptAssemblySrc();
  const defCount = (promptSrc.match(/const CAPABILITY_HINTS_ENTRIES = \[/g) || []).length;
  assert.equal(defCount, 1, 'CAPABILITY_HINTS_ENTRIES must be defined exactly once (shared by CHAT, SUBCHAT and AGENT_RENDER_HINT)');
  const src = await readBackgroundSrc();
  assert.match(src, /import \{ CAPABILITY_HINTS, CHOICE_REQUEST_HINT \} from '\.\/lib\/prompt-assembly\.js'/, 'background.js must import the shared constants (no local copy)');

  const subchatSrc = await readSubchatHandlerSrc();
  // 2026-10-20 回滚：两段式/按家族门控已撤，SUBCHAT 与 CHAT 一样每轮全量下发。
  assert.match(subchatSrc, /const sysPrompt = capabilityHints \|\| CAPABILITY_HINTS;/,
    'SUBCHAT must send the full contract every turn');

  // CHAT still builds effectiveSystemPrompt from the same constant (passed
  // in as the capabilityHints param from background.js's CAPABILITY_HINTS).
  const chatHandlerSrc = await (async () => {
    const fs = await import('fs/promises');
    return fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');
  })();
  assert.match(chatHandlerSrc, /buildEffectiveSystemPrompt\(all, \{[^}]*capabilityHints/, 'CHAT must still reference capabilityHints (via the shared assembly)');
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
  const promptSrc = await readPromptAssemblySrc();
  assert.match(promptSrc, /const CHOICE_REQUEST_HINT =/, 'CHOICE_REQUEST_HINT must be its own constant');
  assert.doesNotMatch(CAPABILITY_HINTS_SRC(promptSrc), /CHOICE_REQUEST/, 'CAPABILITY_HINTS itself must not mention CHOICE_REQUEST');

  const subchatSrc = await readSubchatHandlerSrc();
  assert.doesNotMatch(subchatSrc, /CHOICE_REQUEST/, 'SUBCHAT must never reference CHOICE_REQUEST_HINT or the literal string');

  const fs = await import('fs/promises');
  const chatHandlerSrc = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');
  assert.match(chatHandlerSrc, /buildEffectiveSystemPrompt\(all, \{[^}]*choiceRequestHint/, 'CHAT must append choiceRequestHint (never to SUBCHAT)');
});

async function readPromptAssemblySrc() {
  const fs = await import('fs/promises');
  return fs.readFile(new URL('../lib/prompt-assembly.js', import.meta.url), 'utf8');
}

function CAPABILITY_HINTS_SRC(src) {
  const start = src.indexOf('const CAPABILITY_HINTS_ENTRIES = [');
  const end = src.indexOf('];', start);
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
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_DONE', subId, providerLabel, providerKey, \.\.\.\(st\.finishReason === 'length' \? \{ truncated: true \} : \{\}\), \.\.\.\(st\.usage \? \{ usage: st\.usage, usageScope: 'turn' \} : \{\}\), \.\.\.\(typeof st\.full === 'string' && st\.full \? \{ full: st\.full \} : \{\}\) \}\)/);
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
  assert.match(chatHandlerSrc, /resolveReplyModelOrEndpoint\(provider, all, turn\.bridgeEndpoint\)/,
    'CHAT must consume the same shared mapping — no per-handler copies to drift (bridgeEndpoint lives on the turn request since the 2026-09-20 turn-request pass)');
});

// --------------- SUBCHAT: agent process surfacing (approval/clarify/progress)

test('SUBCHAT pushes tool progress + approval/clarify chunks and relays replies subId-keyed, all three agent kinds covered', async () => {
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_TOOL_PROGRESS', subId, text \}\)/);
  // 2026-10-15 并发审批堆叠：chunk 带 reqKey，应答按 reqKey 精确路由。
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_APPROVAL', subId, data, reqKey \}\)/);
  assert.match(subchatSrc, /pushSubChatChunk\(subId, \{ type: 'SUBCHAT_CLARIFY', subId, data, reqKey \}\)/);
  assert.equal((subchatSrc.match(/const reqKey = agentPendingKey\(subId\);/g) || []).length, 5,
    'all five creation sites (opencode appr+clar, bridge appr, hermes appr+clar) key by agentPendingKey');
  // 2026-11-03: the four "answer a pending card" paths collapsed into
  // respondPending(map, relay, reqKey, payload, missing) in approval-relay.js, so
  // the pin moved to the call sites: each twin must still route by reqKey
  // against its OWN subId-scoped map (not the old subId single slot) and pass the
  // matching relay + payload field.
  assert.match(
    subchatSrc,
    /respondPending\(\{\s*map: subchatPendingApprovals,\s*relay: relayApproval,\s*reqKey: msg\.reqKey,\s*payload: msg\.choice,/,
    'approval relay must route by reqKey, not the old subId single slot',
  );
  assert.match(
    subchatSrc,
    /respondPending\(\{\s*map: subchatPendingClarifications,\s*relay: relayClarify,\s*reqKey: msg\.reqKey,\s*payload: msg\.response,/,
    'clarification relay must route by reqKey',
  );
  // Runs + opencode + bridge branches all wire onApproval: two `onApproval:`
  // option keys (opencode/bridge) plus the runs branch's local const passed
  // as shorthand (`onApproval,` at the runsApiStream call).
  assert.equal((subchatSrc.match(/onApproval:/g) || []).length, 2, 'opencode + bridge branches must surface approval requests');
  assert.match(subchatSrc, /const onApproval = \(data\) => \{/, 'the runs branch must define its own approval handler');
  assert.match(subchatSrc, /\n          onApproval,\n/, 'the runs branch must pass its approval handler to runsApiStream');
  assert.equal((subchatSrc.match(/onToolProgress:/g) || []).length, 3, 'all three agent branches must surface tool progress');
  // subId-scoped pending maps (reqKey-keyed since the stacking fix), swept on
  // abort AND turn end.
  assert.match(subchatSrc, /const subchatPendingApprovals = new Map\(\)/);
  assert.match(subchatSrc, /const subchatPendingClarifications = new Map\(\)/);
  assert.match(subchatSrc, /sweepAgentPending\(subchatPendingApprovals, subId\)/,
    'turn-end finally must sweep the scope');
  assert.match(subchatSrc, /sweepAgentPending\(subchatPendingApprovals, msg\.subId\)/,
    'abort must sweep the scope');
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

// --------------- 回合身份门：stop→resend 竞态（2026-11-03 审计 sw-1） ---------
//
// 面板侧同一线程重发复用 subId（detail-thread.js），新端口挂同一个 subId。
// 旧流结束后的 takeTurnUsage 是真实存储读（宽窗口）：停止后立刻重发，旧流从
// usage await 恢复时若无条件 pushSubChatChunk(DONE, full=旧全文)，会把旧回复
// 定稿进新回合的气泡。身份判定必须按本回合 controller（subChatPorts.has 不是
// 身份——端口存在但属于新回合）。

const tick = (n = 5) => new Promise((r) => setTimeout(r, n));
async function waitFor(cond, what, ms = 3000) {
  for (let i = 0; i < ms / 5 && !cond(); i++) await tick();
  assert.ok(cond(), `timed out waiting for: ${what}`);
}

function seedHermesProvider() {
  chromeMock.storage.local._set({
    providers: { hermes: { type: 'agent', isHermes: true, baseUrl: 'http://hermes.test', apiKey: 'k', alias: 'Hermes' } },
    activeProvider: 'hermes',
    history: [],
  });
}

//  scripted /v1/runs：POST 创建 run，GET events 回一轮 message.delta +
//  run.completed。第一轮带 session-cumulative usage（cache keys 在场），
//  逼出 subchat 的 takeTurnUsage 存储读；第二轮不带 usage。
function stubRunsFetch({ parkEvents = false } = {}) {
  const enc = new TextEncoder();
  let runSeq = 0;
  const state = { eventsRequested: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/v1/runs')) {
      runSeq += 1;
      return { ok: true, status: 200, json: async () => ({ run_id: `run-${runSeq}` }) };
    }
    const n = /\/runs\/run-(\d+)\/events/.exec(u)?.[1];
    state.eventsRequested += 1;
    if (parkEvents) {
      // 永不完成的 SSE：回合停在 read loop 里，测试控制何时被 abort。
      return { ok: true, status: 200, body: new ReadableStream({ start() {}, cancel() {} }), text: async () => '' };
    }
    const first = n === '1';
    const text = first ? 'old reply' : 'new reply';
    const completed = { output: text, ...(first ? { usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 } } : {}) };
    const sse =
      `event: message.delta\ndata: ${JSON.stringify({ delta: text })}\n\n` +
      `event: run.completed\ndata: ${JSON.stringify(completed)}\n\n`;
    return {
      ok: true, status: 200,
      body: new ReadableStream({ start(c) { c.enqueue(enc.encode(sse)); c.close(); } }),
      text: async () => '',
    };
  };
  return state;
}

test('stop→resend: an old turn parked in takeTurnUsage must not push its DONE into the new turn\'s port', async () => {
  seedHermesProvider();
  const realFetch = globalThis.fetch;
  const areaGet = chromeMock.storage.local.get;
  let usageAskedResolve, usageRelease;
  const usageAsked = new Promise((r) => { usageAskedResolve = r; });
  const usageGate = new Promise((r) => { usageRelease = r; });
  // takeTurnUsage → storage.get('usageSnapshots')（字符串键）：卡住它，模拟
  // 旧流停在 usage await 的宽窗口；getAll 的键表读取不受影响。
  chromeMock.storage.local.get = async (keys) => {
    if (keys === 'usageSnapshots') { usageAskedResolve(); await usageGate; }
    return areaGet(keys);
  };
  const subId = 'sub-race';
  const got1 = [], got2 = [];
  try {
    stubRunsFetch();
    subChatPorts.set(subId, { postMessage: (m) => got1.push(m) });
    await handleSubchat({ subId, messages: [{ role: 'user', content: 'q1' }] }, '');
    await waitFor(() => got1.some((m) => m.type === 'SUBCHAT_CHUNK'), 'old turn deltas on port 1');
    // 旧流已读完 SSE，停在 takeTurnUsage 的存储读上。
    await Promise.race([usageAsked, tick(3000).then(() => { throw new Error('old turn never reached takeTurnUsage'); })]);

    // 用户 Stop（面板语义）→ 立刻同 subId 重发：新 controller、新端口。
    handleSubchatAbort({ subId });
    subChatPorts.set(subId, { postMessage: (m) => got2.push(m) });
    await handleSubchat({ subId, messages: [{ role: 'user', content: 'q2' }] }, '');
    await waitFor(() => got2.some((m) => m.type === 'SUBCHAT_DONE'), 'new turn DONE on port 2');

    // 放行旧流的 usage 读：旧代码此刻会把旧全文 DONE 打进新端口。
    usageRelease();
    await tick(30);

    const dones = got2.filter((m) => m.type === 'SUBCHAT_DONE');
    assert.equal(dones.length, 1, 'the new port must receive exactly one DONE (its own)');
    assert.equal(dones[0].full, 'new reply', 'the new bubble must be finalized with the NEW reply, never the old full text');
    assert.equal(got2.filter((m) => m.type === 'SUBCHAT_ERROR').length, 0, 'the superseded turn must not push ERROR into the new port');
    assert.equal(got1.filter((m) => m.type === 'SUBCHAT_DONE').length, 0, 'the old turn was superseded before its DONE — it must not finalize anywhere');
  } finally {
    usageRelease();
    chromeMock.storage.local.get = areaGet;
    globalThis.fetch = realFetch;
    subChatPorts.delete(subId);
    subChatControllers.delete(subId);
    chromeMock.storage.local._reset();
  }
});

test('a direct resend on the same subId aborts the previous controller (non-panel sender fallback)', async () => {
  seedHermesProvider();
  const realFetch = globalThis.fetch;
  const subId = 'sub-resend';
  try {
    const fstate = stubRunsFetch({ parkEvents: true });
    subChatPorts.set(subId, { postMessage: () => {} });
    await handleSubchat({ subId, messages: [{ role: 'user', content: 'q1' }] }, '');
    await waitFor(() => fstate.eventsRequested >= 1 && subChatControllers.has(subId), 'turn 1 parked in its SSE loop');
    const ctrl1 = subChatControllers.get(subId);

    // 无 SUBCHAT_ABORT 的直发重发（面板纪律之外的兜底）：旧流必须被 abort，
    // 否则旧 fetch/reader 继续烧 token 且往同一 subId 推 delta。
    await handleSubchat({ subId, messages: [{ role: 'user', content: 'q2' }] }, '');
    assert.equal(ctrl1.signal.aborted, true, 'the superseded controller must be aborted on resend');
    assert.notEqual(subChatControllers.get(subId), ctrl1, 'the new turn owns the controller slot');
  } finally {
    handleSubchatAbort({ subId });
    await tick(20);
    globalThis.fetch = realFetch;
    subChatPorts.delete(subId);
    subChatControllers.delete(subId);
    chromeMock.storage.local._reset();
  }
});

test('bare-string rejection after an abort classifies as cancel — no SUBCHAT_ERROR (adapter-gap floor)', async () => {
  // sw-2 地板：正确性不得依赖每个 adapter 各自把字符串 reason 规整成
  // AbortError。opencode 的 session 创建不带 signal（apiFetch 无法归一），
  // mock fetch 在 controller.abort('user-cancel') 后以裸字符串 reject——
  // 模拟任一 adapter 的规整缺口。handler 必须凭 signal.aborted 判为取消。
  chromeMock.storage.local._set({
    providers: { oc: { type: 'agent', isOpencode: true, baseUrl: 'http://oc.test', apiKey: '' } },
    activeProvider: 'oc',
    history: [],
  });
  const realFetch = globalThis.fetch;
  const subId = 'sub-bare-abort';
  let rejectFetch, fetchCalled;
  const gate = new Promise((_, rej) => { rejectFetch = rej; });
  const called = new Promise((r) => { fetchCalled = r; });
  globalThis.fetch = () => { fetchCalled(); return gate; };
  const got = [];
  try {
    subChatPorts.set(subId, { postMessage: (m) => got.push(m) });
    await handleSubchat({ subId, messages: [{ role: 'user', content: 'q' }] }, '');
    await Promise.race([called, tick(3000).then(() => { throw new Error('session create never started'); })]);
    // 内部 abort（controller 留在 map 里，owned 门放行）：分类是唯一决定者。
    subChatControllers.get(subId).abort('user-cancel');
    rejectFetch('user-cancel');
    await tick(30);
    assert.equal(got.filter((m) => m.type === 'SUBCHAT_ERROR').length, 0,
      'a bare string reason on an aborted signal must be a clean cancel, never an error card');
    assert.equal(subChatControllers.has(subId), false, 'the turn still cleans up its controller');
  } finally {
    globalThis.fetch = realFetch;
    subChatPorts.delete(subId);
    subChatControllers.delete(subId);
    chromeMock.storage.local._reset();
  }
});

test('all SUBCHAT pushes and pending-map writes are gated by this turn\'s controller identity (shape pin)', async () => {
  // 行为面由上面两例兜住；此 pin 保证收口不被拆散：所有 pushSubChatChunk 调用
  // 实际落到 owned() 门控的本地包装（raw 导入只在包装内使用一次），五个
  // pending-map 创建点（opencode appr+clar、bridge appr、hermes appr+clar）
  // 先过同一 owned 门——被取代的旧流迟到审批事件不得重新塞入 pending。
  const subchatSrc = await readSubchatHandlerSrc();
  assert.match(subchatSrc, /pushSubChatChunk as rawPushSubChatChunk/, 'the raw pusher must be imported under a private name');
  assert.match(subchatSrc, /const owned = \(\) => subChatControllers\.get\(subId\) === controller;/, 'ownership is controller identity, never subChatPorts.has');
  assert.match(subchatSrc, /const pushSubChatChunk = \(id, payload\) => \{ if \(owned\(\)\) rawPushSubChatChunk\(id, payload\); \};/,
    'every push goes through the owned-gated local wrapper');
  assert.equal((subchatSrc.match(/rawPushSubChatChunk\(/g) || []).length, 1, 'the raw pusher is called exactly once — inside the wrapper');
  assert.equal((subchatSrc.match(/if \(!owned\(\)\) return;/g) || []).length, 5,
    'all five approval/clarify creation sites must gate the pending-map write on owned()');
});

test('stop→resend: a late session-create resolution must not clobber the new turn\'s session map', async () => {
  // The old turn parks in createOpencodeSession (no signal on that POST).
  // After abort+resend, its late resolution used to setBounded over the
  // NEW turn's session id — the next follow-up would continue the aborted
  // server thread (context cross-wiring).
  chromeMock.storage.local._set({
    providers: { oc: { type: 'agent', isOpencode: true, baseUrl: 'http://oc.test', apiKey: '', alias: 'OC' } },
    activeProvider: 'oc',
    history: [],
  });
  const realFetch = globalThis.fetch;
  const subId = 'sub-sess-race';
  let sessionCalls = 0;
  let releaseOldSession;
  const oldSessionGate = new Promise((r) => { releaseOldSession = r; });
  const enc = new TextEncoder();
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/api/session') && opts.method === 'POST') {
      sessionCalls += 1;
      if (sessionCalls === 1) {
        await oldSessionGate; // old turn parks HERE, before setBounded
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'sess-old' } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'sess-new' } }) };
    }
    if (u.endsWith('/prompt')) {
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (u.endsWith('/api/event')) {
      // Immediate idle → done lifecycle for the new turn's session.
      const sid = 'sess-new';
      const sse = `data: ${JSON.stringify({ type: 'session.idle', data: { sessionID: sid, timestamp: Date.now() } })}\n\n`;
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(enc.encode(sse)); c.close(); } }), text: async () => '' };
    }
    if (u.includes('/api/session/active')) {
      return { ok: true, status: 200, text: async () => '[]' };
    }
    if (u.endsWith('/interrupt')) {
      return { ok: true, status: 200, text: async () => '{}' };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };
  try {
    subChatPorts.set(subId, { postMessage: () => {} });
    await handleSubchat({ subId, messages: [{ role: 'user', content: 'q1' }] }, '');
    await waitFor(() => sessionCalls === 1, 'old turn parked in session create');

    handleSubchatAbort({ subId });
    await handleSubchat({ subId, messages: [{ role: 'user', content: 'q2' }] }, '');
    await waitFor(() => sessionCalls === 2, 'new turn created its session');
    await tick(30);

    // Old turn's create finally resolves — must NOT overwrite sess-new.
    releaseOldSession();
    await tick(30);

    // Third send: which session does it reuse? Must be the NEW one.
    let promptSession = null;
    const midFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const m = /\/api\/session\/([^/]+)\/prompt/.exec(String(url));
      if (m) promptSession = decodeURIComponent(m[1]);
      return midFetch(url, opts);
    };
    handleSubchatAbort({ subId });
    await handleSubchat({ subId, messages: [{ role: 'user', content: 'q3' }] }, '');
    await waitFor(() => promptSession !== null, 'third turn issued its prompt');
    assert.equal(promptSession, 'sess-new',
      'the late old-turn session id must not clobber the new turn\'s map entry');
  } finally {
    releaseOldSession();
    globalThis.fetch = realFetch;
    handleSubchatAbort({ subId });
    await tick(20);
    subChatPorts.delete(subId);
    subChatControllers.delete(subId);
    chromeMock.storage.local._reset();
  }
});

// --------------- SUBCHAT: reasoning-field pre-suppression --------------------

// Unit B: the main chat records a provider+model that answered 400/422 to the
// reasoning/thinking fields. The detail thread shares streamCommon, so it must
// read the same memory and pass stripReasoning — otherwise the main chat and
// the follow-up card diverge for the same selection. SUBCHAT has never had a
// transient retry ladder (structural, ADR-0007); adding one here would be a
// second, unreviewed 400 path — pin its absence.
//
// Driven through the REAL handleSubchat with a fetch stub: a source-pin regex
// would still pass if the memory key or the provider gate were wired wrong.
const SUPPRESSED_BODY_FIELDS = ['reasoning', 'reasoning_effort', 'enable_thinking', 'thinking'];

function seedLlmProvider(extra = {}) {
  chromeMock.storage.local._set({
    providers: {
      llm1: {
        type: 'llm', alias: 'L', baseUrl: 'http://llm.test', apiKey: 'k',
        model: 'm1', apiStyle: 'chat', stream: true, temperature: null, maxTokens: 0,
        reasoningDefault: 'high',
        reasoningRaw: '{"reasoning_effort":"high","enable_thinking":true}',
        ...extra,
      },
    },
    activeProvider: 'llm1',
    activeModel: '',
    history: [],
  });
}

function stubChatFetch(bodies) {
  const sse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n';
  globalThis.fetch = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true, status: 200,
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
      text: async () => '',
    };
  };
}

async function runSubchatTurn(subId) {
  subChatPorts.set(subId, { postMessage: () => {} });
  await handleSubchat({ subId, messages: [{ role: 'user', content: 'q' }] }, '');
}

test('SUBCHAT strips reasoning from the real request body when the session remembers a rejection', async () => {
  const realFetch = globalThis.fetch;
  const subId = 'sub-reasoning-suppress';
  const bodies = [];
  try {
    seedLlmProvider();
    chromeMock.storage.session._set({ 'browsa.reasoningRejected': { 'llm1\u0000m1': 1 } });
    stubChatFetch(bodies);
    await runSubchatTurn(subId);
    await waitFor(() => bodies.length >= 1, 'subchat issued a request');
    for (const k of SUPPRESSED_BODY_FIELDS) {
      assert.equal(k in bodies[0], false, `remembered rejection must drop ${k} from the first attempt`);
    }
  } finally {
    globalThis.fetch = realFetch;
    subChatPorts.delete(subId);
    subChatControllers.delete(subId);
    chromeMock.storage.local._reset();
    chromeMock.storage.session._reset();
  }
});

test('SUBCHAT sends reasoning when nothing was rejected (the gate is doing the work)', async () => {
  const realFetch = globalThis.fetch;
  const subId = 'sub-reasoning-normal';
  const bodies = [];
  try {
    seedLlmProvider();
    stubChatFetch(bodies);
    await runSubchatTurn(subId);
    await waitFor(() => bodies.length >= 1, 'subchat issued a request');
    assert.equal(bodies[0].reasoning_effort, 'high', 'reasoningRaw rides the body when no rejection is remembered');
    assert.equal(bodies[0].enable_thinking, true);
  } finally {
    globalThis.fetch = realFetch;
    subChatPorts.delete(subId);
    subChatControllers.delete(subId);
    chromeMock.storage.local._reset();
    chromeMock.storage.session._reset();
  }
});

test('SUBCHAT keeps no retry loop of its own (ADR-0007)', async () => {
  assert.doesNotMatch(await readSubchatHandlerSrc(), /MAX_RETRIES/,
    'SUBCHAT must not grow a retry loop');
});
