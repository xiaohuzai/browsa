// test/lib-sidepanel-bridge-endpoint-ping.test.mjs — 主页下拉的 bridge 每端点
// Ping 状态（providers.bridge.endpointPing）回归测试。#169 加这块时只 pin 了
// sidepanel.js 源码形状（options-provider-ping 的 source pin），从未用
// bridge+endpointPing 的数据真正执行 populateProviderSelect——而该块曾把
// `model` 的引用写在 `for (const model of modelList)` 声明之前，bridge 卡只要
// 带非空 endpointPing 就抛 ReferenceError，整棵下拉被清空（用户实际报告）。
// 这里按真实形状执行：每端点各显各的状态；endpointPing 缺席回落卡级聚合。

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

const URL_A = 'http://127.0.0.1:3948';
const URL_B = 'http://127.0.0.1:3949';

const fakeCfg = {
  providers: {
    hermes: { type: 'agent', alias: 'Hermes Agent', baseUrl: 'http://default-hermes', apiKey: '', model: '', isHermes: true, apiStyle: 'chat' },
    bridge: {
      type: 'agent', alias: 'Agent Bridge (Codex / Claude Code / pi …)',
      baseUrl: URL_A, apiKey: '', model: URL_A, models: [URL_A, URL_B],
      stream: true, isBridge: true, apiStyle: 'chat', temperature: null, maxTokens: 0,
      bridgeAgents: { [URL_A]: 'codex', [URL_B]: 'claude' },
      endpointPing: { [URL_A]: 'reachable', [URL_B]: 'unreachable' },
    },
  },
  // 卡级聚合故意「全通」：per-endpoint 选项必须用各自端点的状态，不能串味。
  pingStates: { bridge: 'reachable', hermes: 'unreachable' },
  activeProvider: 'bridge',
  activeModel: URL_A,
};

let storageListener = null;

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
    onChanged: { addListener: (fn) => { storageListener = fn; } },
  },
  action: { setBadgeText: () => {} },
  downloads: { download: async () => {} },
};

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

function optionTexts() {
  const sel = document.getElementById('provider');
  return [...sel.options].map((o) => o.textContent);
}

test('bridge + endpointPing: dropdown renders one entry per endpoint with ITS OWN status (regression: ReferenceError: model)', () => {
  const texts = optionTexts();
  assert.deepEqual(texts, [
    'Agent Bridge · codex — ● reachable',
    'Agent Bridge · claude — ○ unreachable',
    'Hermes Agent — ○ unreachable',
  ]);
  assert.deepEqual(unhandled, [], 'populateProviderSelect must not throw with per-endpoint ping data');
});

test('onChanged re-populate path (the reported stack) handles endpointPing without rejecting', async () => {
  assert.ok(storageListener, 'storage.onChanged listener registered');
  await storageListener({ providers: { newValue: {} } }, 'local');
  assert.deepEqual(unhandled, [], 'the sidepanel.js:513 re-populate call must not reject');
  assert.equal(optionTexts().length, 3, 'dropdown intact after re-populate');
});

test('endpointPing absent (legacy data): entries fall back to the card-level aggregate', async () => {
  delete fakeCfg.providers.bridge.endpointPing;
  fakeCfg.pingStates = { bridge: 'reachable', hermes: 'unreachable' };
  await storageListener({ providers: { newValue: {} } }, 'local');
  assert.deepEqual(optionTexts(), [
    'Agent Bridge · codex — ● reachable',
    'Agent Bridge · claude — ● reachable',
    'Hermes Agent — ○ unreachable',
  ]);
});

test('endpointPing present but one endpoint untested: that entry reads not pinged', async () => {
  fakeCfg.providers.bridge.endpointPing = { [URL_A]: 'reachable' };
  await storageListener({ providers: { newValue: {} } }, 'local');
  assert.deepEqual(optionTexts(), [
    'Agent Bridge · codex — ● reachable',
    'Agent Bridge · claude — not pinged',
    'Hermes Agent — ○ unreachable',
  ]);
});
