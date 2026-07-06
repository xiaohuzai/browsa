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
const { handle, chatControllers, activeRunIds, pendingApprovals, pendingClarifications } = bg;

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

test('APPROVAL_RESPOND returns {ok:false} when there is no pending approval for the tab', async () => {
  pendingApprovals.clear();
  const r = await handle({ type: 'APPROVAL_RESPOND', tabId: 21, choice: 'once' });
  assert.equal(r.ok, false);
});

test('APPROVAL_RESPOND posts the choice to /v1/runs/{id}/approval with the stored approval_id', async () => {
  pendingApprovals.clear();
  pendingApprovals.set(22, { runId: 'run_x', approvalId: 'appr_9', baseUrl: 'http://hermes.test', apiKey: 'sk-2' });

  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };

  const r = await handle({ type: 'APPROVAL_RESPOND', tabId: 22, choice: 'always' });

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://hermes.test/v1/runs/run_x/approval');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { approval_id: 'appr_9', choice: 'always' });
});

test('APPROVAL_RESPOND returns {ok:false} with an error message when the request throws', async () => {
  pendingApprovals.clear();
  pendingApprovals.set(23, { runId: 'run_y', approvalId: 'appr_1', baseUrl: 'http://hermes.test', apiKey: '' });
  globalThis.fetch = async () => { throw new Error('network down'); };

  const r = await handle({ type: 'APPROVAL_RESPOND', tabId: 23, choice: 'deny' });
  assert.equal(r.ok, false);
  assert.match(r.error, /network down/);
});

// --------------- CLARIFY_RESPOND ----------------------------------------------

test('CLARIFY_RESPOND returns {ok:false} when there is no pending clarification for the tab', async () => {
  pendingClarifications.clear();
  const r = await handle({ type: 'CLARIFY_RESPOND', tabId: 31, response: 'foo' });
  assert.equal(r.ok, false);
});

test('CLARIFY_RESPOND posts the response to /v1/runs/{id}/clarifications/{id}/respond', async () => {
  pendingClarifications.clear();
  pendingClarifications.set(32, { runId: 'run_z', clarifyId: 'clar_5', baseUrl: 'http://hermes.test', apiKey: 'sk-3' });

  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };

  const r = await handle({ type: 'CLARIFY_RESPOND', tabId: 32, response: 'the README file' });

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://hermes.test/v1/runs/run_z/clarifications/clar_5/respond');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { response: 'the README file' });
});

// --------------- no leaks: cleanup happens in the CHAT handler's finally ------

test('activeRunIds/pendingApprovals/pendingClarifications are cleared in the CHAT finally block', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');

  const finallyIdx = src.lastIndexOf('finally {', src.indexOf('chatControllers.delete(tabId)'));
  assert.ok(finallyIdx > 0, 'must find the finally block that cleans up chatControllers');
  const finallyBlockEnd = src.indexOf('\n      }', finallyIdx);
  const finallyBlock = src.slice(finallyIdx, finallyBlockEnd);

  assert.match(finallyBlock, /activeRunIds\.delete\(tabId\)/, 'activeRunIds must be cleared in finally');
  assert.match(finallyBlock, /pendingApprovals\.delete\(tabId\)/, 'pendingApprovals must be cleared in finally');
  assert.match(finallyBlock, /pendingClarifications\.delete\(tabId\)/, 'pendingClarifications must be cleared in finally');
});

// --------------- isHermes routing -----------------------------------------------

test('CHAT handler routes to runsApiStream when isHermes, chatStream otherwise', async () => {
  const fs = await import('fs/promises');
  const src = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');

  // isHermes is auto-detected via ping (options.js probes run_submission /
  // run_events_sse). Whenever it's true we always prefer Hermes's richer
  // /v1/runs API over plain /v1/chat/completions — no separate per-provider
  // toggle exists (a provider that doesn't support /v1/runs is simply not
  // flagged isHermes).
  assert.match(src, /const isHermes = !!\(provider\.isHermes\)/,
    'isHermes must be read directly from the provider config');
  assert.doesNotMatch(src, /useRunsApi/, 'the retired useRunsApi toggle must not reappear');

  // The doStream() closure must branch on isHermes to pick the API client.
  const doStreamIdx = src.indexOf('const doStream = async () => {');
  assert.ok(doStreamIdx > 0, 'doStream must be defined');
  const doStreamEnd = src.indexOf('\n      };', doStreamIdx);
  const doStreamSrc = src.slice(doStreamIdx, doStreamEnd);

  assert.match(doStreamSrc, /if \(isHermes\)/, 'doStream must branch on isHermes');
  assert.match(doStreamSrc, /await runsApiStream\(/, 'the isHermes branch must call runsApiStream');
  assert.match(doStreamSrc, /await chatStream\(/, 'the fallback branch must call chatStream');

  // runsApiStream's call must come before chatStream's in the isHermes-true branch.
  const runsIdx = doStreamSrc.indexOf('await runsApiStream(');
  const chatIdx = doStreamSrc.indexOf('await chatStream(');
  assert.ok(runsIdx > 0 && chatIdx > 0 && runsIdx < chatIdx,
    'runsApiStream must be reachable from the isHermes branch, chatStream from the else branch');
});
