// test/mask-rules.test.mjs
// Mask rules (background.js ~line 643-654) redact sensitive text (emails,
// API keys, etc.) from attached page/selection content before it's stored
// in history and sent to the LLM. This is a privacy feature and had zero
// test coverage — a broken regex or an accidentally-skipped rule would
// silently leak sensitive text to whatever provider the user configured.
//
// We exercise it behaviorally through handle({ type: 'ATTACH_PAGE',
// mode: 'selected', ... }), which is the simplest path that reaches the
// mask-rule block without needing to mock an LLM call.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeStorageArea(initial = {}) {
  let store = { ...initial };
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      return { ...store };
    },
    async set(obj) { store = { ...store, ...obj }; },
    async remove(key) { delete store[key]; },
    _set(obj) { store = { ...store, ...obj }; },
  };
}

const localArea = makeStorageArea({
  maskRules: [
    { pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', flags: 'gi', replacement: '[EMAIL]' },
    { pattern: 'sk-[A-Za-z0-9]{10,}', flags: 'g', replacement: '[API_KEY]' },
  ],
});
const sessionArea = makeStorageArea();

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
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Test' }],
    get: async () => ({ id: 1, url: 'https://example.com', title: 'Test', favIconUrl: '' }),
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
    executeScript: async () => [{ result: { text: 'unused in selected mode', articleTitle: 'Mock', wasCapped: false, rawTextLength: 20 } }],
  },
  storage: {
    onChanged: { addListener: () => {} },
    local: localArea,
    session: sessionArea,
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
const { handle } = bg;

// Each test uses its own tabId. handle()'s 'selected' mode intentionally
// prefers a cached selection over msg.text (`selectionCache.get(tabId) ||
// msg.text`) so a slow right-click round trip still works — sharing a
// tabId across tests would make later tests see an earlier test's cached
// text instead of their own.
let nextTabId = 100;

test('mask rules redact an email address from attached selection text', async () => {
  const tabId = nextTabId++;
  const res = await handle({
    type: 'ATTACH_PAGE',
    tabId,
    mode: 'selected',
    text: 'Contact me at jane.doe@example.com for details.'
  }, { tab: { id: tabId } });

  assert.equal(res.ok, true);
  assert.ok(!res.ctx.text.includes('jane.doe@example.com'), 'raw email must not survive masking');
  assert.ok(res.ctx.text.includes('[EMAIL]'), 'masked placeholder must be present');
});

test('mask rules redact an API-key-shaped token via a second independent rule', async () => {
  const tabId = nextTabId++;
  const res = await handle({
    type: 'ATTACH_PAGE',
    tabId,
    mode: 'selected',
    text: 'export KEY=sk-abcdefghijklmnop123'
  }, { tab: { id: tabId } });

  assert.equal(res.ok, true);
  assert.ok(!res.ctx.text.includes('sk-abcdefghijklmnop123'));
  assert.ok(res.ctx.text.includes('[API_KEY]'));
});

test('mask rules apply ALL configured rules, not just the first match', async () => {
  const tabId = nextTabId++;
  const res = await handle({
    type: 'ATTACH_PAGE',
    tabId,
    mode: 'selected',
    text: 'Email jane@example.com, key sk-abcdefghijklmnop123'
  }, { tab: { id: tabId } });

  assert.ok(res.ctx.text.includes('[EMAIL]'));
  assert.ok(res.ctx.text.includes('[API_KEY]'));
  assert.ok(!res.ctx.text.includes('jane@example.com'));
  assert.ok(!res.ctx.text.includes('sk-abcdefghijklmnop123'));
});

test('a malformed rule pattern is skipped without crashing or blocking other rules', async () => {
  const tabId = nextTabId++;
  localArea._set({
    maskRules: [
      { pattern: '(unterminated[', flags: 'gi', replacement: '[BAD]' }, // invalid regex
      { pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', flags: 'gi', replacement: '[EMAIL]' },
    ],
  });
  const res = await handle({
    type: 'ATTACH_PAGE',
    tabId,
    mode: 'selected',
    text: 'Reach me at bob@example.com please.'
  }, { tab: { id: tabId } });

  assert.equal(res.ok, true, 'a bad regex in one rule must not fail the whole ATTACH_PAGE call');
  assert.ok(res.ctx.text.includes('[EMAIL]'), 'the valid rule after the broken one must still run');
  assert.ok(!res.ctx.text.includes('bob@example.com'));

  // restore for subsequent tests
  localArea._set({
    maskRules: [
      { pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', flags: 'gi', replacement: '[EMAIL]' },
      { pattern: 'sk-[A-Za-z0-9]{10,}', flags: 'g', replacement: '[API_KEY]' },
    ],
  });
});

test('a rule with no pattern is skipped (no crash on empty/undefined pattern)', async () => {
  const tabId = nextTabId++;
  localArea._set({ maskRules: [{ replacement: '[X]' }, { pattern: '', replacement: '[Y]' }] });
  const res = await handle({
    type: 'ATTACH_PAGE',
    tabId,
    mode: 'selected',
    text: 'plain text, nothing to mask'
  }, { tab: { id: tabId } });

  assert.equal(res.ok, true);
  assert.equal(res.ctx.text, 'plain text, nothing to mask');
});

test('no mask rules configured leaves text untouched', async () => {
  const tabId = nextTabId++;
  localArea._set({ maskRules: [] });
  const res = await handle({
    type: 'ATTACH_PAGE',
    tabId,
    mode: 'selected',
    text: 'my email is untouched@example.com'
  }, { tab: { id: tabId } });

  assert.equal(res.ok, true);
  assert.equal(res.ctx.text, 'my email is untouched@example.com');
});

test('the default replacement is *** when a matching rule has no explicit replacement', async () => {
  const tabId = nextTabId++;
  localArea._set({ maskRules: [{ pattern: 'secret', flags: 'gi' }] });
  const res = await handle({
    type: 'ATTACH_PAGE',
    tabId,
    mode: 'selected',
    text: 'the secret word'
  }, { tab: { id: tabId } });

  assert.equal(res.ok, true);
  assert.ok(res.ctx.text.includes('***'));
  assert.ok(!res.ctx.text.includes('secret'));
});
