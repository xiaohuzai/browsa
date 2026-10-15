// test/approval-clarify.test.mjs
// Tests for the Hermes /v1/runs approval/clarification relay added to
// background.js: STREAM_ABORT now also stops the server-side run,
// APPROVAL_RESPOND and CLARIFY_RESPOND relay the user's choice back to
// Hermes, and the new activeRunIds/pendingApprovals/pendingClarifications
// maps must not leak across turns.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
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
const { handle, chatControllers, activeRunIds, pendingApprovals, pendingClarifications, streamState } = bg;

// --------------- STREAM_ABORT also stops the server-side run --------------

test('STREAM_ABORT calls POST /v1/runs/{id}/stop when a run is active for the tab', async () => {
  chatControllers.clear();
  activeRunIds.clear();

  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };

  activeRunIds.set(11, { runId: 'run_abc', baseUrl: 'http://hermes.test', apiKey: 'sk-1' });

  await handle({ type: 'STREAM_ABORT', tabId: 11 });

  assert.equal(calls.length, 1, 'exactly one stop request must be sent');
  // The Hermes API server only registers POST /v1/runs/{run_id}/stop — there
  // is no /cancel route (verified against gateway/platforms/api_server.py's
  // route table). Calling /cancel 404s silently and leaves the run going.
  assert.equal(calls[0].url, 'http://hermes.test/v1/runs/run_abc/stop');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-1');
  assert.equal(activeRunIds.has(11), false, 'activeRunIds entry must be cleared after stop');
});

test('STREAM_ABORT does not call fetch when no run is active for the tab', async () => {
  chatControllers.clear();
  activeRunIds.clear();

  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true }; };

  await handle({ type: 'STREAM_ABORT', tabId: 12 });

  assert.equal(fetchCalled, false, 'no /v1/runs/{id}/stop request should be made without an active run');
});

// --------------- APPROVAL_RESPOND ---------------------------------------------
// 2026-10-15 并发审批堆叠：pending 条目按 reqKey（agent-stream-session.js
// agentPendingKey）键控，应答消息带 reqKey 精确路由——不再按 tabId 单槽。

test('APPROVAL_RESPOND returns {ok:false} when there is no pending approval for the reqKey', async () => {
  pendingApprovals.clear();
  const r = await handle({ type: 'APPROVAL_RESPOND', tabId: 21, reqKey: '21::404', choice: 'once' });
  assert.equal(r.ok, false);
});

test('APPROVAL_RESPOND posts the choice to /v1/runs/{id}/approval with the stored approval_id', async () => {
  pendingApprovals.clear();
  pendingApprovals.set('22::1', { runId: 'run_x', approvalId: 'appr_9', baseUrl: 'http://hermes.test', apiKey: 'sk-2' });

  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };

  const r = await handle({ type: 'APPROVAL_RESPOND', tabId: 22, reqKey: '22::1', choice: 'always' });

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://hermes.test/v1/runs/run_x/approval');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { approval_id: 'appr_9', choice: 'always' });
});

test('APPROVAL_RESPOND returns {ok:false} with an error message when the request throws', async () => {
  pendingApprovals.clear();
  pendingApprovals.set('23::1', { runId: 'run_y', approvalId: 'appr_1', baseUrl: 'http://hermes.test', apiKey: '' });
  globalThis.fetch = async () => { throw new Error('network down'); };

  const r = await handle({ type: 'APPROVAL_RESPOND', tabId: 23, reqKey: '23::1', choice: 'deny' });
  assert.equal(r.ok, false);
  assert.match(r.error, /network down/);
  assert.equal(pendingApprovals.has('23::1'), true, 'a failed relay must KEEP the entry retryable');
});

test('concurrent approvals stack: each reqKey relays its OWN entry; success deletes only the answered one', async () => {
  pendingApprovals.clear();
  pendingApprovals.set('41::1', { runId: 'run_a', approvalId: 'appr_a', baseUrl: 'http://hermes.test', apiKey: 'sk-a' });
  pendingApprovals.set('41::2', { runId: 'run_b', approvalId: 'appr_b', baseUrl: 'http://hermes.test', apiKey: 'sk-a' });

  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };

  // Answer the SECOND request first — the whole point of reqKey routing.
  const r1 = await handle({ type: 'APPROVAL_RESPOND', tabId: 41, reqKey: '41::2', choice: 'once' });
  assert.equal(r1.ok, true);
  assert.equal(calls[0].url, 'http://hermes.test/v1/runs/run_b/approval');
  assert.deepEqual(calls[0].body, { approval_id: 'appr_b', choice: 'once' });
  assert.equal(pendingApprovals.has('41::2'), false, 'answered entry is deleted');
  assert.equal(pendingApprovals.has('41::1'), true, 'the other stacked entry must survive');

  const r2 = await handle({ type: 'APPROVAL_RESPOND', tabId: 41, reqKey: '41::1', choice: 'deny' });
  assert.equal(r2.ok, true);
  assert.equal(calls[1].url, 'http://hermes.test/v1/runs/run_a/approval');
  assert.deepEqual(calls[1].body, { approval_id: 'appr_a', choice: 'deny' });
  assert.equal(pendingApprovals.size, 0);
});

// --------------- CLARIFY_RESPOND ----------------------------------------------

test('CLARIFY_RESPOND returns {ok:false} when there is no pending clarification for the reqKey', async () => {
  pendingClarifications.clear();
  const r = await handle({ type: 'CLARIFY_RESPOND', tabId: 31, reqKey: '31::404', response: 'foo' });
  assert.equal(r.ok, false);
});

test('CLARIFY_RESPOND posts the response to /v1/runs/{id}/clarifications/{id}/respond', async () => {
  pendingClarifications.clear();
  pendingClarifications.set('32::1', { runId: 'run_z', clarifyId: 'clar_5', baseUrl: 'http://hermes.test', apiKey: 'sk-3' });

  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };

  const r = await handle({ type: 'CLARIFY_RESPOND', tabId: 32, reqKey: '32::1', response: 'the README file' });

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://hermes.test/v1/runs/run_z/clarifications/clar_5/respond');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { response: 'the README file' });
  assert.equal(pendingClarifications.has('32::1'), false, 'answered clarification is deleted');
});

// --------------- no leaks: cleanup happens in the CHAT handler's finally ------

test('activeRunIds/pendingApprovals/pendingClarifications are cleared in the CHAT finally block', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');

  const finallyIdx = src.lastIndexOf('finally {', src.lastIndexOf('chatControllers.delete(tabId)'));
  assert.ok(finallyIdx > 0, 'must find the finally block that cleans up chatControllers');
  const finallyBlockEnd = src.indexOf('\n  }', finallyIdx);
  const finallyBlock = src.slice(finallyIdx, finallyBlockEnd);

  assert.match(finallyBlock, /activeRunIds\.delete\(tabId\)/, 'activeRunIds must be cleared in finally');
  assert.match(finallyBlock, /sweepAgentPending\(pendingApprovals, tabId\)/,
    'pendingApprovals must be swept by scope in finally (reqKey-keyed since the stacking fix)');
  assert.match(finallyBlock, /sweepAgentPending\(pendingClarifications, tabId\)/,
    'pendingClarifications must be swept by scope in finally');
});

// --------------- STREAM_PEEK carries still-pending agent cards ----------------
// 并发审批堆叠的补挂半边：面板重开时 PEEK 必须把该 tab 名下仍未决的审批/
// 澄清卡带回（resume 路径据此补挂卡片）——否则流停在等审批时用户无从应答。

test('STREAM_PEEK returns the tab\'s still-pending agent cards; answered ones stop riding', async () => {
  streamState.set(51, { acc: 'partial reply', startedAt: 1 });
  pendingApprovals.set('51::1', { runId: 'r', approvalId: 'a', baseUrl: 'u', apiKey: 'k', data: { tool: 'exec' } });
  pendingApprovals.set('52::9', { runId: 'r', approvalId: 'a', baseUrl: 'u', apiKey: 'k', data: { tool: 'other-tab' } });
  pendingClarifications.set('51::2', { runId: 'r', clarifyId: 'c', baseUrl: 'u', apiKey: 'k', data: { question: 'which?' } });

  try {
    const peek = await handle({ type: 'STREAM_PEEK', tabId: 51 });
    assert.equal(peek.inFlight, true);
    assert.deepEqual(peek.pendingAgentCards.approvals,
      [{ reqKey: '51::1', data: { tool: 'exec' } }],
      'only THIS tab\'s approvals ride the peek');
    assert.deepEqual(peek.pendingAgentCards.clarifies,
      [{ reqKey: '51::2', data: { question: 'which?' } }]);

    globalThis.fetch = async () => ({ ok: true });
    await handle({ type: 'APPROVAL_RESPOND', tabId: 51, reqKey: '51::1', choice: 'once' });
    const peek2 = await handle({ type: 'STREAM_PEEK', tabId: 51 });
    assert.deepEqual(peek2.pendingAgentCards.approvals, [],
      'an answered approval must not be re-offered on the next peek');
    assert.deepEqual(peek2.pendingAgentCards.clarifies,
      [{ reqKey: '51::2', data: { question: 'which?' } }],
      'the unanswered clarification keeps riding');
  } finally {
    streamState.delete(51);
    pendingApprovals.clear();
    pendingClarifications.clear();
  }
});

// --------------- agentPendingKey: stacking key contract -----------------------

test('agentPendingKey is unique per call and scoped; sweepAgentPending removes only that scope', async () => {
  const { agentPendingKey, sweepAgentPending } = await import('../lib/handlers/agent-stream-session.js');
  const k1 = agentPendingKey(7);
  const k2 = agentPendingKey(7);
  const k3 = agentPendingKey(8);
  assert.notEqual(k1, k2, 'keys within one scope must never collide');
  assert.notEqual(k1, k3);
  assert.match(k1, /^7::/, 'main-chat keys are scoped by tabId');

  const map = new Map([[k1, 'a'], [k2, 'b'], [k3, 'c'], ['9::1', 'd']]);
  sweepAgentPending(map, 7);
  assert.deepEqual([...map.keys()], [k3, '9::1'], 'sweep removes only the named scope\'s entries');
});

// --------------- creation half: chunks must carry reqKey ----------------------

test('every chat-handler approval/clarify site keys by agentPendingKey and rides reqKey on its chunk', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');
  assert.equal((src.match(/agentPendingKey\(tabId\)/g) || []).length, 5,
    'hermes approval+clarify, opencode approval+clarify, bridge approval — five scoped keys');
  assert.equal((src.match(/type: 'APPROVAL', data, reqKey \}\)/g) || []).length, 3,
    'all three approval chunk pushes carry reqKey (a chunk without it gets a dead card)');
  assert.equal((src.match(/type: 'CLARIFY', data, reqKey \}\)/g) || []).length, 2,
    'both clarify chunk pushes carry reqKey');
});

// --------------- isHermes routing -----------------------------------------------

test('CHAT handler routes to runsApiStream when isHermes, chatStream otherwise', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');

  // isHermes is auto-detected via ping (options.js probes run_submission /
  // run_events_sse). Whenever it's true we always prefer Hermes's richer
  // /v1/runs API over plain /v1/chat/completions — no separate per-provider
  // toggle exists (a provider that doesn't support /v1/runs is simply not
  // flagged isHermes).
  // 2026-09-20 deepening pass: the kind derivation moved into
  // lib/handlers/turn-request.js (kind = provider.isHermes ? 'hermes' : …),
  // still read DIRECTLY from the provider config every call.
  const trSrc = await fs.readFile(new URL('../lib/handlers/turn-request.js', import.meta.url), 'utf8');
  assert.match(trSrc, /provider\.isHermes \? 'hermes'/,
    'isHermes must be read directly from the provider config');
  assert.doesNotMatch(src, /useRunsApi/, 'the retired useRunsApi toggle must not reappear');

  // The doStream() closure must branch on the turn kind to pick the API client.
  // (doStream takes an opts arg so the auto timestamp-rewrite can run it
  // silently - opts.silent swallows deltas instead of pushing CHUNKs.)
  const doStreamIdx = src.indexOf('const doStream = async (opts = {}) => {');
  assert.ok(doStreamIdx > 0, 'doStream must be defined');
  const doStreamEnd = src.indexOf('\n  };', doStreamIdx);
  const doStreamSrc = src.slice(doStreamIdx, doStreamEnd);

  assert.match(doStreamSrc, /kind === 'hermes'/, 'doStream must branch on the hermes kind');
  assert.match(doStreamSrc, /await runsApiStream\(/, 'the isHermes branch must call runsApiStream');
  // The non-Hermes fallback (chat/responses/anthropic) now goes through the
  // shared dispatcher, which owns the actual chatStream call.
  assert.match(doStreamSrc, /await dispatchStyleStream\(/, 'the fallback branch must call the shared stream dispatcher');
  assert.match(doStreamSrc, /chatMessages: turn\.messages/, 'the fallback must route the chat/completions path its message array (payloads live on the turn request)');

  // runsApiStream's call must come before the dispatcher's.
  const runsIdx = doStreamSrc.indexOf('await runsApiStream(');
  const chatIdx = doStreamSrc.indexOf('await dispatchStyleStream(');
  assert.ok(runsIdx > 0 && chatIdx > 0 && runsIdx < chatIdx,
    'runsApiStream must be reachable from the isHermes branch, the dispatcher from the else branch');
});
