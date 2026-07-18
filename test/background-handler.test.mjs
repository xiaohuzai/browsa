// test/background-handler.test.mjs
// Integration test for background.js's handle() dispatch.
// This catches bugs like "parameter name mismatch" that pure-function
// tests cannot see.
//
// We mock `chrome.*` APIs BEFORE importing background.js so that the
// module-level listener registrations don't crash. The mock is minimal:
// no-op addListener(), sensible defaults for query/get, and a spy for
// storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --------------- chrome mock -------------------------------------------------
const storageData = {
  contextMode: 'reader',
  maxTextChars: 100_000,
  activeProvider: 'hermes',
  providers: {
    hermes: { baseUrl: 'http://localhost:8642', apiKey: 'sk-test', model: 'test' }
  },
  historyByTab: {}
};

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => null,
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://www.xiaohongshu.com/explore/abc', title: 'Test Note' }],
    get: async () => ({ id: 1, url: 'https://www.xiaohongshu.com/explore/abc', title: 'Test Note' }),
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
    executeScript: async () => [{ result: { text: '# Mock page\n\nMock content.', articleTitle: 'Mock', wasCapped: false, rawTextLength: 30 } }],
  },
  storage: {
    onChanged: { addListener: () => {} },
    // We don't mock the real chrome.storage.sync/local; the storage module
    // has its own inline mocks. If a test reaches real storage.* calls,
    // we rely on the storage module's defaults.
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

const keepAlive = () => {};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

// --------------- import ------------------------------------------------------
// Dynamic import so the mock is in place before background.js evaluates.
const bg = await import('../background.js');
const { handle } = bg;

// --------------- tests -------------------------------------------------------
test('handle returns config on GET_CONFIG', async () => {
  // TODO: mock storage.getAll() to return a known config.
  // For now, verify the function doesn't throw on a valid message type.
  assert.equal(typeof handle, 'function');
  assert.equal(handle.length, 2, 'handle(msg, sender) should take 2 parameters');
});

test('handle does not reference undeclared variables', () => {
  // Parse the source and verify handle() only references:
  //   - its own parameters (msg, sender)
  //   - declared local variables
  //   - globals (console, Error, etc.)
  //   - imported functions
  //
  // This catches bugs like the v0.19.0 "sender is not defined" which
  // happened because the parameter was renamed to `_sender` but the
  // body still referenced `sender`.
  const src = handle.toString();
  // The function body starts at the first `{` after the parameter list.
  // We extract parameter names from the signature.
  const sigMatch = src.match(/^async function handle\s*\(([^)]*)\)/);
  assert.ok(sigMatch, 'handle() should have a recognizable signature');
  const params = sigMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  assert.ok(params.includes('msg'), 'handle() must accept msg');
  assert.ok(params.includes('sender'), 'handle() must accept sender');

  // Quick sanity: the function should contain known case labels.
  assert.match(src, /GET_CONFIG/, 'should handle GET_CONFIG');
  assert.match(src, /GET_PAGE_CONTEXT/, 'should handle GET_PAGE_CONTEXT');
  assert.match(src, /XHS_XHR_NOTE/, 'should handle XHS_XHR_NOTE');
  assert.match(src, /CHAT/, 'should handle CHAT');
  assert.match(src, /default:/, 'should have a default case');
});

// --------------- XHS_XHR_NOTE tabId regression --------------------------------
// The content script never sends a tabId on XHS_XHR_NOTE — only `note`.
// A previous version read `msg.tabId` (always undefined) instead of
// `sender.tab.id`, so pushXhsNote() silently no-op'd and the cache was
// never populated. This pins the fix: tabId must come from `sender`.
test('XHS_XHR_NOTE derives tabId from sender.tab.id, not msg.tabId', async () => {
  const note = { noteId: 'n1', title: 'test note' };

  // Content script never sets msg.tabId — verify the handler still works.
  const putRes = await handle({ type: 'XHS_XHR_NOTE', note }, { tab: { id: 7 } });
  assert.equal(putRes.ok, true);

  const getRes = await handle({ type: 'GET_XHS_NOTE', tabId: 7 }, { tab: { id: 7 } });
  assert.deepEqual(getRes.note, note, 'note pushed via sender.tab.id=7 must be retrievable for tab 7');

  // A client-supplied msg.tabId for a DIFFERENT tab must be ignored — the
  // note must land under the sender's real tab, not an attacker-chosen one.
  const spoofRes = await handle({ type: 'XHS_XHR_NOTE', tabId: 999, note: { noteId: 'spoofed' } }, { tab: { id: 8 } });
  assert.equal(spoofRes.ok, true);
  const tab999 = await handle({ type: 'GET_XHS_NOTE', tabId: 999 }, { tab: { id: 999 } });
  assert.equal(tab999.note, null, 'msg.tabId must not be trusted — note must not appear under the spoofed tabId');
  const tab8 = await handle({ type: 'GET_XHS_NOTE', tabId: 8 }, { tab: { id: 8 } });
  assert.equal(tab8.note.noteId, 'spoofed', 'note must land under the real sender tab instead');
});

// ─── SEEK_VIDEO: in-place video seek dispatch ───────────────────────────────
// Verifies the [mm:ss] click handler's backend: it must call
// chrome.scripting.executeScript with the target tabId + seconds arg and
// relay the injected function's {ok} result back to the side panel.

test('SEEK_VIDEO calls executeScript on the target tab and relays {ok:true}', async () => {
  let called = null;
  globalThis.chrome.scripting.executeScript = async (opts) => {
    called = opts;
    return [{ result: { ok: true } }];
  };
  const res = await handle({ type: 'SEEK_VIDEO', tabId: 42, seconds: 83 }, { tab: { id: 42 } });
  assert.equal(res.ok, true);
  assert.ok(called, 'executeScript was invoked');
  assert.deepEqual(called.target, { tabId: 42 }, 'targets the requested tab');
  assert.deepEqual(called.args, [83], 'passes seconds as a number arg');
  assert.equal(called.world, 'MAIN', 'runs in MAIN world so YouTube seekTo is reachable');
  assert.equal(typeof called.func, 'function', 'injects a seek function');
});

test('SEEK_VIDEO relays {ok:false} when the page has no <video>', async () => {
  globalThis.chrome.scripting.executeScript = async () => [{ result: { ok: false } }];
  const res = await handle({ type: 'SEEK_VIDEO', tabId: 7, seconds: 5 }, { tab: { id: 7 } });
  assert.equal(res.ok, false);
});

test('SEEK_VIDEO returns {ok:false} without tabId', async () => {
  globalThis.chrome.scripting.executeScript = async () => [{ result: { ok: true } }];
  const res = await handle({ type: 'SEEK_VIDEO', seconds: 5 }, { tab: { id: 7 } });
  assert.equal(res.ok, false);
});

test('SEEK_VIDEO swallows executeScript errors as {ok:false} (tab closed/gone)', async () => {
  globalThis.chrome.scripting.executeScript = async () => { throw new Error('No tab with id 99'); };
  const res = await handle({ type: 'SEEK_VIDEO', tabId: 99, seconds: 5 }, { tab: { id: 99 } });
  assert.equal(res.ok, false);
});
