// test/options-thinking-per-model.test.mjs — 设置页「每模型档位覆盖」（真实
// options.js + jsdom）。
//
// 契约：每个 model id 一行（select 首项 value='' = 继承卡级），两个持久化 map
// ——`reasoningByModel` 与 `modelLevels`——**只由 saveCard 从行 DOM 派生**
// （readPerModelMaps）；不设隐藏 JSON 镜像、不进 BLANK_LLM。模型 id 是用户
// 输入，行模板全程 escapeHtml/escapeAttr，行 id 经 data-per-model-row 往返。
// Reset 顺手清掉该 provider 的 400 记忆（storage.clearReasoningRejected）。

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
// options.js gates Reset behind window.confirm; jsdom's version is unimplemented.
dom.window.confirm = () => true;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// Everything a provider row needs when the test isn't about it.
const llmBase = {
  type: 'llm', stream: true, isHermes: false, apiStyle: 'chat',
  temperature: null, maxTokens: 0,
};

const storedData = {
  providers: {
    // 1) 纯渲染 / 改档 / 继承 / 删 chip：无任何种子 map。
    'llm-1': {
      ...llmBase, alias: 'Toggle 网关', baseUrl: 'http://llm-1', apiKey: 'sk-1',
      model: 'glm-5', models: ['glm-5', 'gpt-5.6'],
    },
    // 2) 转义往返：model id 是用户输入（引号 + 尖括号）。
    'llm-2': {
      ...llmBase, alias: 'Weird', baseUrl: 'http://llm-2', apiKey: 'sk-2',
      model: 'm"<x>', models: ['m"<x>'],
      reasoningByModel: { 'm"<x>': 'max' },
      modelLevels: { 'm"<x>': ['low', 'max'] },
    },
    // 3) 已存档位不在内置词表里：select 仍须保持它（静默丢失回归）。
    'llm-3': {
      ...llmBase, alias: 'Stale', baseUrl: 'http://llm-3', apiKey: 'sk-3',
      model: 'glm-5', models: ['glm-5'],
      reasoningDefault: 'max', reasoningByModel: { 'glm-5': 'max' },
    },
    // 4) 未改动直接 Save / Ping 也不清空：两个 map 都有种子。
    'llm-4': {
      ...llmBase, alias: 'Roundtrip', baseUrl: 'http://llm-4', apiKey: 'sk-4',
      model: 'glm-5', models: ['glm-5'],
      reasoningByModel: { 'glm-5': 'disabled' },
      modelLevels: { 'glm-5': ['low', 'max'] },
    },
    // 5) 自定义词表：无种子，词表靠行内输入打出来。
    'llm-5': {
      ...llmBase, alias: 'Custom', baseUrl: 'http://llm-5', apiKey: 'sk-5',
      model: 'glm-5', models: ['glm-5'],
    },
  },
};
const setCalls = [];
// 记下在飞的重渲快照，避免 set 之后的断言读到同一对象引用。
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

const sessionData = { 'browsa.reasoningRejected': { 'llm-4\u0000glm-5': 1, 'llm-2\u0000x': 1 } };
const sessionWrites = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: clone(storedData[keys]) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, clone(storedData[k])]));
        return clone(storedData);
      },
      set: async (obj) => { setCalls.push(clone(obj)); Object.assign(storedData, clone(obj)); },
    },
    session: {
      get: async (keys) => {
        const list = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(sessionData));
        return Object.fromEntries(list.map((k) => [k, clone(sessionData[k])]));
      },
      set: async (obj) => { sessionWrites.push(clone(obj)); Object.assign(sessionData, clone(obj)); },
      remove: async () => {},
    },
  },
};

// Ping 会真的发请求；这张卡的往返用例只关心里程碑之前的 saveCard 是否写对。
globalThis.fetch = async () => { throw new Error('offline (test)'); };

await import('../options.js');
await tick(50);

const card = (name) => document.querySelector(`.provider[data-name="${name}"]`);
const rowsOf = (c) => [...c.querySelectorAll('[data-per-model-row]')];
const rowOf = (c, id) => rowsOf(c).find((r) => r.dataset.perModelRow === id);
const selectOf = (c, id) => rowOf(c, id)?.querySelector('.per-model-select');
const levelsOf = (c, id) => rowOf(c, id)?.querySelector('.per-model-levels');
const clickSave = (c) => c.querySelector('button[data-act="save"]').click();
const lastSaved = (name) => setCalls.filter((o) => o.providers).map((o) => o.providers[name]).filter(Boolean).pop();
const cardDefaultsOf = (c) => c.querySelector('[data-thinking-select]');
const optionValues = (sel) => [...sel.querySelectorAll('option')].map((o) => o.value);

// ─── 渲染：一 model 一行，选项 = 内置词表，且没有隐藏 JSON 镜像 ────────────────
test('渲染：每个 model id 一行；glm-5 行的选项 = 继承 + auto + 开关词表；无 data-k 镜像', () => {
  const c = card('llm-1');
  assert.ok(c, 'llm-1 卡存在');
  assert.deepEqual(rowsOf(c).map((r) => r.dataset.perModelRow), ['glm-5', 'gpt-5.6'], '一 model 一行，顺序按 chip 顺序');
  assert.deepEqual(optionValues(selectOf(c, 'glm-5')), ['', 'auto', 'disabled', 'enabled'],
    'glm-5 是开关词表：首项空值 = 继承卡级，然后 auto / disabled / enabled');
  assert.equal(selectOf(c, 'glm-5').value, '', '无覆盖时默认选中「继承」');
  assert.ok(optionValues(selectOf(c, 'gpt-5.6')).includes('xhigh'), 'gpt-5.6 走全档词表');
  assert.equal(c.querySelector('[data-k="reasoningByModel"]'), null, '两个 map 没有隐藏 data-k 镜像（单一写入者）');
  assert.equal(c.querySelector('[data-k="modelLevels"]'), null, '两个 map 没有隐藏 data-k 镜像（单一写入者）');
});

// ─── 转义往返：模型 id 是用户输入 ────────────────────────────────────────────
test('转义往返：model id 含 " 与 <> 时 dataset 逐字还原，Save 后 map 键逐字保留', async () => {
  const c = card('llm-2');
  const rows = rowsOf(c);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.perModelRow, 'm"<x>', 'data-per-model-row 转义后经 dataset 读回原值');
  assert.equal(c.querySelector('.per-model-id').textContent, 'm"<x>', '行内 id 文本原样渲染（不注入标签）');
  assert.equal(selectOf(c, 'm"<x>').value, 'max', '行 select 按已存覆盖重建并选中');
  assert.equal(levelsOf(c, 'm"<x>').value, 'low, max', '行内自定义词表同样往返');

  clickSave(c);
  await tick();
  const saved = lastSaved('llm-2');
  assert.deepEqual(saved.reasoningByModel, { 'm"<x>': 'max' }, 'map 键就是原始模型 id（逐字）');
  assert.deepEqual(saved.modelLevels, { 'm"<x>': ['low', 'max'] });
});

// ─── 往返 1：未改动直接 Save ─────────────────────────────────────────────────
test('往返 1：未碰控件直接 Save，两个 map 原样落盘', async () => {
  clickSave(card('llm-4'));
  await tick();
  const saved = lastSaved('llm-4');
  assert.deepEqual(saved.reasoningByModel, { 'glm-5': 'disabled' }, '未改动即原样保存（行 DOM 派生不吞掉旧值）');
  assert.deepEqual(saved.modelLevels, { 'glm-5': ['low', 'max'] });
});

// ─── 往返 2：Ping 也走 saveCard，但不得清空 ──────────────────────────────────
test('往返 2：点 Ping 落盘后两个 map 仍原样（pingCard 复用 saveCard）', async () => {
  const c = card('llm-4');
  c.querySelector('button[data-act="ping"]').click();
  await tick(60);
  const saved = lastSaved('llm-4');
  assert.deepEqual(saved.reasoningByModel, { 'glm-5': 'disabled' });
  assert.deepEqual(saved.modelLevels, { 'glm-5': ['low', 'max'] });
});

// ─── 保存档位 / 继承 ─────────────────────────────────────────────────────────
test('保存档位：glm-5 行选 disabled → 键有值；再选「继承」→ 键消失', async () => {
  const c = card('llm-1');
  selectOf(c, 'glm-5').value = 'disabled';
  clickSave(c);
  await tick();
  assert.deepEqual(lastSaved('llm-1').reasoningByModel, { 'glm-5': 'disabled' }, '显式档位写成 map 条目');

  const c2 = card('llm-1');
  selectOf(c2, 'glm-5').value = '';
  clickSave(c2);
  await tick();
  const saved = lastSaved('llm-1');
  assert.equal('glm-5' in saved.reasoningByModel, false, '选回「继承」= 键整体缺席（落到卡级默认）');
  assert.deepEqual(saved.reasoningByModel, {});
});

// ─── 自定义词表：改了行内词表，该行选项立即出现这些词 ────────────────────────
test('自定义词表：行内输入 low, max → change → 该行选项出现；选 max → Save 两个 map 同时写', async () => {
  const c = card('llm-5');
  assert.deepEqual(optionValues(selectOf(c, 'glm-5')), ['', 'auto', 'disabled', 'enabled'], '起点是内置开关词表');

  levelsOf(c, 'glm-5').value = 'low, max';
  levelsOf(c, 'glm-5').dispatchEvent(new dom.window.Event('change', { bubbles: true }));

  assert.deepEqual(optionValues(selectOf(c, 'glm-5')), ['', 'auto', 'low', 'max'], '自定义词表成为该行词表');
  selectOf(c, 'glm-5').value = 'max';
  clickSave(card('llm-5'));
  await tick();
  const saved = lastSaved('llm-5');
  assert.deepEqual(saved.modelLevels, { 'glm-5': ['low', 'max'] }, '>0 个词才写 modelLevels');
  assert.deepEqual(saved.reasoningByModel, { 'glm-5': 'max' }, '词表外的档位也能保存（由引擎就近拟合）');
});

// ─── 静默丢失回归：已存档位不在词表里时不许回落 auto ─────────────────────────
test('静默丢失回归：已存 reasoningByModel / reasoningDefault 不在词表里仍保持选中', async () => {
  const c = card('llm-3');
  assert.equal(selectOf(c, 'glm-5').value, 'max', 'per-model 行保持已存档位（补一项，不回落）');
  assert.equal(cardDefaultsOf(c).value, 'max', '卡级 select 保持已存档位（补一项，不回落）');
  clickSave(card('llm-3'));
  await tick();
  const saved = lastSaved('llm-3');
  assert.deepEqual(saved.reasoningByModel, { 'glm-5': 'max' }, '不改只保存不会把档位静默改写成 auto');
  assert.equal(saved.reasoningDefault, 'max');
});

// ─── 删 chip：行消失，孤儿键不落盘 ───────────────────────────────────────────
test('删 chip：✕ gpt-5.6 → 行数 1；Save 后 map 只剩 glm-5', async () => {
  const c = card('llm-1');
  selectOf(c, 'glm-5').value = 'enabled';
  selectOf(c, 'gpt-5.6').value = 'high';
  clickSave(c);
  await tick();
  assert.deepEqual(lastSaved('llm-1').reasoningByModel, { 'glm-5': 'enabled', 'gpt-5.6': 'high' }, '两张行都落盘');

  c.querySelector('.chip[data-id="gpt-5.6"] .chip-x').click();
  assert.deepEqual(rowsOf(c).map((r) => r.dataset.perModelRow), ['glm-5'], '删 chip 后行同步消失');
  assert.equal(selectOf(c, 'glm-5').value, 'enabled', '其余行的选择不受影响');

  clickSave(c);
  await tick();
  assert.deepEqual(Object.keys(lastSaved('llm-1').reasoningByModel), ['glm-5'], '被删模型的孤儿键不写回');
});

// ─── 卡间独立：新卡的两 map 各自派生，不共享 ─────────────────────────────────
test('卡间独立：两张新卡各存各的 map（两个 map 不进 BLANK_LLM 的共享引用）', async () => {
  const addTab = () => document.querySelector('.provider-tab-add');
  assert.ok(addTab(), '＋ Add Provider 标签存在');
  addTab().click();
  await tick();
  addTab().click();
  await tick();

  const a = () => card('llm-6');
  const b = () => card('llm-7');
  assert.ok(a() && b(), '两次 Add 得到两张新卡');

  // A 卡：加一个模型，词表打 'x'
  const chipInput = a().querySelector('.chip-input');
  chipInput.value = 'glm-5';
  chipInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  levelsOf(a(), 'glm-5').value = 'x';
  levelsOf(a(), 'glm-5').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(b().querySelector('[data-per-model-row]'), null, 'B 卡没有模型 → 没有行（也不受 A 影响）');

  clickSave(a());
  await tick();
  assert.deepEqual(lastSaved('llm-6').modelLevels, { 'glm-5': ['x'] });
  assert.deepEqual(lastSaved('llm-6').reasoningByModel, {});

  clickSave(b());
  await tick();
  assert.deepEqual(lastSaved('llm-7').reasoningByModel, {}, 'B 卡存自己的空 map');
  assert.deepEqual(lastSaved('llm-7').modelLevels, {});
  assert.deepEqual(lastSaved('llm-6').modelLevels, { 'glm-5': ['x'] }, 'A 卡的 map 不被 B 卡保存污染');
  assert.equal(levelsOf(a(), 'glm-5').value, 'x', 'A 卡行内词表原样保留');
});

// ─── Reset：清掉该 provider 的 400 记忆（B 导出的唯一调用点）─────────────────
test('Reset 清记忆：确认后 clearReasoningRejected 调用一次，且只清本 provider 的键', async () => {
  sessionData['browsa.reasoningRejected'] = { 'llm-4\u0000glm-5': 1, 'llm-2\u0000x': 1 };
  const before = sessionWrites.length;
  card('llm-4').querySelector('button[data-act="reset"]').click();
  await tick(40);

  const writes = sessionWrites.slice(before).filter((o) => o['browsa.reasoningRejected']);
  assert.equal(writes.length, 1, 'Reset 只写一次会话记忆（clearReasoningRejected）');
  assert.deepEqual(sessionData['browsa.reasoningRejected'], { 'llm-2\u0000x': 1 },
    '本 provider 的键消失，别家的记忆不动');
  assert.equal(card('llm-4').querySelector('[data-per-model-row]'), null, 'Reset 后卡是纯 BLANK_LLM（无模型 → 无行）');
});

// ─── 护栏：必填标记数量、Agent 卡无该容器 ────────────────────────────────────
test('护栏：LLM 卡 .req 仍恰好 2 个；Agent 卡没有 [data-per-model]', () => {
  assert.equal(card('llm-1').querySelectorAll('.req').length, 2, '新字段不带 reqMark()');
  const agentCard = [...document.querySelectorAll('.provider')]
    .find((c) => !c.querySelector('[data-model-chips]'));
  assert.ok(agentCard, 'Agent 卡存在');
  assert.equal(agentCard.querySelector('[data-per-model]'), null, 'Agent 卡没有 per-model 死配置面');
});
