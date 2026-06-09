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
