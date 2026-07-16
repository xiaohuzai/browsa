// test/lib-sidepanel-provider-select.test.mjs — real execution test for
// populateProviderSelect()'s reachable-first sort. Kept in its own file (same
// convention as test/lib-sidepanel-ui-prefs.test.mjs) so this file's
// GET_CONFIG response (a custom providers/pingStates/activeProvider shape)
// doesn't collide with other sidepanel test files' shared module-level state.
//
// "Configured" (has a baseUrl) is not a strong enough signal to sort on —
// Hermes ships with a non-empty default baseUrl, so it would always sort
// first even if the user never intended to use it. Reachable (a verified
// ping) is the real signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

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

const fakeCfg = {
  providers: {
    hermes:       { baseUrl: 'http://default-hermes' },   // "configured" by default, but never pinged
    'claude-code': { baseUrl: '' },                        // unconfigured
    compatible:   { baseUrl: 'http://my-llm' },            // configured AND reachable
  },
  pingStates: { compatible: 'reachable' },
  activeProvider: 'hermes',
};

globalThis.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com/', title: 'Example' }],
    get: async (id) => ({ id, url: 'https://example.com/', title: 'Example' }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  runtime: {
    connect: () => ({
      name: '', sent: [],
      onMessage: { addListener: () => {}, removeListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {},
      disconnect: () => {},
    }),
    sendMessage: (msg, cb) => {
      let res = { ok: true };
      if (msg.type === 'GET_CONFIG') res = { data: fakeCfg };
      if (msg.type === 'STREAM_PEEK') res = { inFlight: false };
      cb(res);
    },
    lastError: undefined,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), remove: async () => {} },
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const providerSel = document.getElementById('provider');

test('populateProviderSelect sorts the reachable provider first, ahead of a merely-configured-by-default one', () => {
  const optionOrder = [...providerSel.options].map((o) => o.value);
  assert.equal(optionOrder[0], 'compatible', 'the only reachable provider must sort to the top');
  assert.deepEqual(new Set(optionOrder), new Set(['hermes', 'claude-code', 'compatible']), 'all providers must still be present');
});

test('populateProviderSelect keeps stable relative order among non-reachable providers', () => {
  const optionOrder = [...providerSel.options].map((o) => o.value);
  const hermesIdx = optionOrder.indexOf('hermes');
  const claudeIdx = optionOrder.indexOf('claude-code');
  assert.ok(hermesIdx < claudeIdx, 'hermes and claude-code are both non-reachable; original relative order (hermes before claude-code) must be preserved');
});

test('populateProviderSelect still selects the persisted activeProvider regardless of sort position', () => {
  const selected = providerSel.options[providerSel.selectedIndex];
  assert.equal(selected.value, 'hermes', 'activeProvider (hermes) must stay selected even though it is not sorted first');
});
