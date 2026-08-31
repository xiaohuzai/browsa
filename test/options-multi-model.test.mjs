// test/options-multi-model.test.mjs — LLM 卡片多模型（真实 options.js + jsdom）：
// Model ID 是 chips 编辑器——chip 逐项增删（✕ / ＋ / 回车），真实值同步进隐藏的
// data-k="model" 逗号串，Save 走既有规范化（models 全量 + model 首个）。

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

const storedData = {
  providers: {
    'llm-1': {
      type: 'llm', alias: '方舟 Coding', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      apiKey: 'sk-1', model: 'glm-5.3-flash', models: ['glm-5.3-flash', 'doubao-seed-2-0-code'],
      stream: true, isHermes: false, apiStyle: 'chat', temperature: null, maxTokens: 0,
    },
  },
};
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

const card = () => document.querySelector('.provider[data-name="llm-1"]');
const chips = (c) => [...c.querySelectorAll('.chip')].map((el) => el.dataset.id);
const hidden = (c) => c.querySelector('input[data-k="model"]');
const addViaInput = (c, value, { enter = true, clickPlus = false } = {}) => {
  const input = c.querySelector('.chip-input');
  input.value = value;
  if (enter) input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  if (clickPlus) c.querySelector('.chip-add').click();
  input.value = '';
};

test('卡片重开：已有 models 渲染为 chip 列表，隐藏 input 承载逗号串', () => {
  const c = card();
  assert.deepEqual(chips(c), ['glm-5.3-flash', 'doubao-seed-2-0-code']);
  assert.equal(hidden(c).value, 'glm-5.3-flash, doubao-seed-2-0-code');
  assert.ok(c.querySelector('.chip-input'), '行尾输入框存在');
  assert.ok(c.querySelector('.chip-add'), '＋ 按钮存在');
});

test('输入 + 回车添加 chip；重复 ID 去重；逗号串自动拆分', () => {
  const c = card();
  addViaInput(c, 'kimi-k2.7');
  assert.deepEqual(chips(c), ['glm-5.3-flash', 'doubao-seed-2-0-code', 'kimi-k2.7']);
  addViaInput(c, 'kimi-k2.7', { enter: false, clickPlus: true });
  assert.equal(chips(c).length, 3, '重复 ID 不重复入列（＋ 按钮同规则）');
  addViaInput(c, 'glm-5.3-flash, deepseek-v4,');
  assert.deepEqual(chips(c), ['glm-5.3-flash', 'doubao-seed-2-0-code', 'kimi-k2.7', 'deepseek-v4'],
    '逗号分隔粘贴自动拆成多个 chip');
  assert.equal(hidden(c).value, 'glm-5.3-flash, doubao-seed-2-0-code, kimi-k2.7, deepseek-v4');
});

test('chip ✕ 移除；全部移除后隐藏 input 为空', () => {
  const c = card();
  c.querySelector('.chip[data-id="doubao-seed-2-0-code"] .chip-x').click();
  assert.deepEqual(chips(c), ['glm-5.3-flash', 'kimi-k2.7', 'deepseek-v4']);
  assert.equal(hidden(c).value, 'glm-5.3-flash, kimi-k2.7, deepseek-v4');
  for (const id of [...chips(c)]) c.querySelector(`.chip[data-id="${id}"] .chip-x`).click();
  assert.equal(hidden(c).value, '');
  // 还原初始两条，供后续用例使用
  addViaInput(c, 'glm-5.3-flash, doubao-seed-2-0-code');
  assert.deepEqual(chips(c), ['glm-5.3-flash', 'doubao-seed-2-0-code']);
});

test('Save：models 全量 + model 首个（既有规范化不变）', async () => {
  const c = card();
  c.querySelector('button[data-act="save"]').click();
  await new Promise((r) => setTimeout(r, 20));
  const saved = setCalls.filter((o) => o.providers).map((o) => o.providers['llm-1']).pop();
  assert.deepEqual(saved.models, ['glm-5.3-flash', 'doubao-seed-2-0-code']);
  assert.equal(saved.model, 'glm-5.3-flash', 'Ping/旧消费方读 model = 第一个');
});

test('Agent 卡（Hermes）没有 chips 编辑器', () => {
  const agentCard = [...document.querySelectorAll('.provider')].find((c) => !c.querySelector('[data-model-chips]'));
  assert.ok(agentCard, 'Agent 卡存在');
  assert.equal(agentCard.querySelector('.chip-input'), null);
});
