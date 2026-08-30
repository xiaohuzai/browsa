// test/options-model-datalist.test.mjs — provider 卡片的模型自动检测（真实 options.js
// + jsdom，从全新安装起步）：reserved 空槽卡 ⟳ 拉取 /v1/models 灌入 datalist、Save 从
// DOM 收编 discoveredModels、Add Provider 的真实卡检测后立即持久化、失败只闪错误。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/options.html', runScripts: undefined });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.location = dom.window.location;

const storedData = {};
const setCalls = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...storedData };
        if (typeof keys === 'string') return { [keys]: storedData[keys] };
        return { ...storedData };
      },
      set: async (obj) => { setCalls.push(obj); Object.assign(storedData, obj); },
    },
  },
};

await import('../options.js');
await new Promise((r) => setTimeout(r, 50));

const MODELS_BODY = { data: [{ id: 'beta-model' }, { id: 'alpha-model' }, { id: 'beta-model' }] };

function mockModelsFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => MODELS_BODY };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function cardByName(name) {
  return document.querySelector(`.provider[data-name="${name}"]`);
}

test('全新安装：reserved 空槽卡的 Model ID 挂 datalist，⟳ 在 Save 前即可拉取', async () => {
  const card = cardByName('llm-1');
  assert.ok(card?.classList.contains('reserved'), 'reserved 空槽卡存在');
  const input = card.querySelector('[data-k="model"]');
  assert.equal(input.getAttribute('list'), 'models-llm-1', 'datalist 已挂到输入框');

  card.querySelector('[data-k="baseUrl"]').value = 'https://api.example.com';
  card.querySelector('[data-k="apiKey"]').value = 'sk-2';
  const { calls, restore } = mockModelsFetch();
  try {
    card.querySelector('[data-act="fetch-models"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls[0].url, 'https://api.example.com/v1/models');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-2');
    const opts = [...card.querySelectorAll('datalist option')].map((o) => o.value);
    assert.deepEqual(opts, ['alpha-model', 'beta-model'], '去重 + 排序后进 datalist');
    assert.match(card.querySelector('.card-status').textContent, /✓ 2 models/);
    // reserved 卡未落配置：不提前持久化，等 Save 收编
    assert.equal(Object.keys(storedData.providers || {}).length, 0);
  } finally {
    restore();
  }
});

test('reserved 卡 Save：空槽落为真实卡，discoveredModels 从 DOM 收编', async () => {
  const card = cardByName('llm-1');
  card.querySelector('button[data-act="save"]').click();
  await new Promise((r) => setTimeout(r, 20));
  const saved = storedData.providers['llm-1'];
  assert.ok(saved, 'reserved 卡已落配置');
  assert.equal(saved.baseUrl, 'https://api.example.com');
  assert.deepEqual(saved.discoveredModels, ['alpha-model', 'beta-model'], 'Save 时从 datalist 收编');
});

test('已保存卡片：⟳ 读卡片当前值（未 Save 的编辑也生效），结果立即持久化', async () => {
  const card = cardByName('llm-1');
  card.querySelector('[data-k="baseUrl"]').value = 'https://other.example.com';
  const { calls, restore } = mockModelsFetch();
  try {
    card.querySelector('[data-act="fetch-models"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls[0].url, 'https://other.example.com/v1/models', '读的是卡片当前值');
    const persisted = setCalls.filter((o) => o.providers).map((o) => o.providers['llm-1']).pop();
    assert.deepEqual(persisted?.discoveredModels, ['alpha-model', 'beta-model']);
  } finally {
    restore();
  }
});

test('失败路径：非 OK 只闪一行错误，已有候选不被清空', async () => {
  const card = cardByName('llm-1');
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'denied' });
    card.querySelector('[data-act="fetch-models"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(card.querySelector('.card-status').textContent, /❌ HTTP 401/);
    assert.ok(card.querySelectorAll('datalist option').length > 0, '已有候选保留');
  } finally {
    globalThis.fetch = real;
  }
});

test('Agent 卡（Hermes）不渲染 Model ID 与 ⟳', () => {
  const agentCard = [...document.querySelectorAll('.provider')].find((c) => !c.querySelector('[data-k="model"]'));
  assert.ok(agentCard, '存在无 Model ID 字段的 Agent 卡');
  assert.equal(agentCard.querySelector('[data-act="fetch-models"]'), null);
});
