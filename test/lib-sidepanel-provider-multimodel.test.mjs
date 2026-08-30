// test/lib-sidepanel-provider-multimodel.test.mjs — 主页下拉的多模型形态（真实
// sidepanel.js + jsdom，独立 GET_CONFIG 形状避免与其它 sidepanel 测试串状态）：
// 多模型 provider 每个模型一个选项（Alias · model — 状态）、activeModel 精确回填、
// 切换时 SET_ACTIVE_PROVIDER 携带选中的具体模型。

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
    hermes: { baseUrl: 'http://default-hermes' },
    'llm-1': {
      alias: '方舟 Coding', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      model: 'glm-5.3-flash', models: ['glm-5.3-flash', 'doubao-seed-2-0-code', 'kimi-k2.7'],
    },
  },
  pingStates: { 'llm-1': 'reachable' },
  activeProvider: 'llm-1',
  activeModel: 'doubao-seed-2-0-code',
};

const sent = [];
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
      sent.push(msg);
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

await import('../sidepanel.js');
await new Promise((r) => setTimeout(r, 100));

const providerSel = document.getElementById('provider');

test('多模型 provider 每个模型一个选项（Alias · model — 状态），单模型/Agent 保持纯 Alias', () => {
  const opts = [...providerSel.options];
  assert.deepEqual(opts.map((o) => o.value), ['llm-1', 'llm-1', 'llm-1', 'hermes'],
    'reachable 的多模型卡展开 3 个选项在前，hermes 一个');
  const labels = opts.slice(0, 3).map((o) => o.textContent);
  assert.match(labels[0], /方舟 Coding · glm-5\.3-flash — ● reachable/);
  assert.match(labels[1], /方舟 Coding · doubao-seed-2-0-code — ● reachable/);
  assert.match(labels[2], /方舟 Coding · kimi-k2\.7 — ● reachable/);
  assert.match(opts[3].textContent, /^Hermes Agent — /, 'Agent 卡无 model 后缀');
});

test('选中回填：activeModel 精确匹配到具体模型选项', () => {
  const sel = providerSel.options[providerSel.selectedIndex];
  assert.equal(sel.value, 'llm-1');
  assert.equal(sel.dataset.model, 'doubao-seed-2-0-code');
});

test('切换：SET_ACTIVE_PROVIDER 携带选中的具体模型', async () => {
  sent.length = 0;
  providerSel.value = 'llm-1'; // 多个 option 同 value，需按 index 选中
  const target = [...providerSel.options].find((o) => o.dataset.model === 'kimi-k2.7');
  target.selected = true;
  providerSel.dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 20));

  const msg = sent.find((m) => m.type === 'SET_ACTIVE_PROVIDER');
  assert.ok(msg, '切换消息已发送');
  assert.equal(msg.name, 'llm-1');
  assert.equal(msg.model, 'kimi-k2.7', '具体模型随 provider 一起落存储');
});

test('activeModel 缺失（老配置）：storage.onChanged 触发重建时回退该 provider 第一个选项', async () => {
  fakeCfg.activeModel = '';
  storageListener({ activeProvider: { newValue: 'llm-1' } }, 'local');
  await new Promise((r) => setTimeout(r, 20));
  const sel = providerSel.options[providerSel.selectedIndex];
  assert.equal(sel.value, 'llm-1');
  assert.equal(sel.dataset.model, 'glm-5.3-flash', 'fallback = 该 provider 的第一个模型（即 provider.model）');
  // 复位，避免影响后续用例
  fakeCfg.activeModel = 'doubao-seed-2-0-code';
  storageListener({ activeProvider: { newValue: 'llm-1' } }, 'local');
  await new Promise((r) => setTimeout(r, 20));
});
