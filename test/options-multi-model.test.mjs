// test/options-multi-model.test.mjs — LLM 卡片多模型（真实 options.js + jsdom）：
// Model ID 输入框逗号分隔多值，Save 规范化为 models 全量列表 + model 首个；
// 卡片重开时输入框回填全量列表。

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

test('卡片重开：Model ID 输入框回填全量列表（逗号 + 空格分隔）', () => {
  const input = card().querySelector('[data-k="model"]');
  assert.equal(input.value, 'glm-5.3-flash, doubao-seed-2-0-code');
});

test('Save：逗号分隔多值规范化为 models 全量 + model 首个，去重去空保序', async () => {
  const input = card().querySelector('[data-k="model"]');
  input.value = ' kimi-k2.7 , glm-5.3-flash ,, kimi-k2.7,  ';
  card().querySelector('button[data-act="save"]').click();
  await new Promise((r) => setTimeout(r, 20));

  const saved = setCalls.filter((o) => o.providers).map((o) => o.providers['llm-1']).pop();
  assert.deepEqual(saved.models, ['kimi-k2.7', 'glm-5.3-flash'], '去空去重保序');
  assert.equal(saved.model, 'kimi-k2.7', 'model = 第一个（Ping/旧路径消费方语义不变）');
});

test('Save 清空 Model ID → models 空、model 空', async () => {
  const input = card().querySelector('[data-k="model"]');
  input.value = '   ';
  card().querySelector('button[data-act="save"]').click();
  await new Promise((r) => setTimeout(r, 20));

  const saved = setCalls.filter((o) => o.providers).map((o) => o.providers['llm-1']).pop();
  assert.deepEqual(saved.models, []);
  assert.equal(saved.model, '');
});

test('Agent 卡（Hermes，无 model 字段）不做多模型规范化', async () => {
  const agentCard = [...document.querySelectorAll('.provider')].find((c) => !c.querySelector('[data-k="model"]'));
  assert.ok(agentCard, 'Agent 卡存在');
  agentCard.querySelector('button[data-act="save"]').click();
  await new Promise((r) => setTimeout(r, 20));
  const saved = setCalls.filter((o) => o.providers).map((o) => o.providers.hermes).pop();
  assert.equal('models' in saved, false, 'Hermes 不引入 models 字段');
});
