// test/options-model-catalog.test.mjs — 设置页「模型目录」卡（真实 options.js +
// jsdom）。
//
// 契约（单元 E）：
//  - 目录只在用户点按钮时拉取；**页面初始化绝不 fetch**（首屏零网络）。
//  - 导入成功：写 storage.local['modelCatalog']（定向读键，不进 GET_ALL_KEYS），
//    状态行显示模型数 + 日期，按钮文字切「刷新」。
//  - 请求期间两个按钮都 disabled（重复点击不并发第二次导入）。
//  - fetch 失败 / json 抛错：状态行报错、旧目录保留、页面不崩。
//  - 清除：删键、回「未导入」。
//  - 目录只影响【选项列表】：per-model 行与卡级 select 增补词表，Save 绝不把
//    目录派生的词表被动写进 provider 行（provider 行的唯一写入者仍是卡片 DOM）。
//
// 顺序有意义：本文件共用一个 options.js 模块实例（模块级 _modelCatalog /
// cachedCfg 跨用例存活），用例按「种入 → 清除 → 导入 → busy → 失败」排列。

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

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const llmBase = {
  type: 'llm', stream: true, isHermes: false, apiStyle: 'chat',
  temperature: null, maxTokens: 0,
};

// 种目录：mystery-llm 不在 lib/reasoning-levels.js 的任何规则里（inert），
// 所以它出现的每个词都只能来自目录 → 断言不会与内置词表混淆。
const storedData = {
  providers: {
    'llm-1': {
      ...llmBase, alias: 'Catalog', baseUrl: 'http://llm-1', apiKey: 'sk-1',
      model: 'mystery-llm', models: ['mystery-llm'],
    },
  },
  modelCatalog: {
    version: 1,
    fetchedAt: 1760000000000,
    models: { 'mystery-llm': ['low', 'medium', 'high'] },
  },
};

const setCalls = [];
const removeCalls = [];
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

let fetchCalls = [];
let fetchImpl = async () => { throw new Error('fetch must not run during init'); };

globalThis.fetch = async (url, opts) => { fetchCalls.push(String(url)); return fetchImpl(String(url), opts); };

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: clone(storedData[keys]) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, clone(storedData[k])]));
        return clone(storedData);
      },
      set: async (obj) => { setCalls.push(clone(obj)); Object.assign(storedData, clone(obj)); },
      remove: async (keys) => {
        removeCalls.push(clone(keys));
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete storedData[k];
      },
    },
  },
};

await import('../options.js');
await tick(50);

const card = () => document.querySelector('.provider[data-name="llm-1"]');
const importBtn = () => document.querySelector('[data-act="catalog-import"]');
const clearBtn = () => document.querySelector('[data-act="catalog-clear"]');
const statusEl = () => document.getElementById('catalogStatus');
const rowSelect = () => card()?.querySelector('[data-per-model-row="mystery-llm"] .per-model-select');
const cardSelect = () => card()?.querySelector('[data-thinking-select]');
const optionValues = (sel) => [...sel.querySelectorAll('option')].map((o) => o.value);
const lastSaved = () => setCalls.filter((o) => o.providers).map((o) => o.providers['llm-1']).filter(Boolean).pop();

// ─── 1. 初始化：不 fetch；种入的目录直接生效 ────────────────────────────────
test('初始化：零 fetch；种入目录让 mystery-llm 的行/卡级 select 出现目录词表', () => {
  assert.deepEqual(fetchCalls, [], '打开设置页不得发任何网络请求');
  assert.match(importBtn().textContent, /Refresh/i, '已有目录时按钮是「刷新」');
  assert.ok(statusEl().textContent.includes('1'), '状态行含模型数（种入 1 个）');
  assert.deepEqual(optionValues(rowSelect()), ['', 'auto', 'low', 'medium', 'high'],
    '行 select = 继承 + auto + 目录词表');
  assert.deepEqual(optionValues(cardSelect()), ['auto', 'low', 'medium', 'high'],
    '卡级 select 并集同样带目录词表');
});

// ─── 2. 目录只喂选项：Save 不被动写入 provider 行 ───────────────────────────
test('Save 不因目录被动写入：provider 行没有 modelLevels / reasoningByModel', async () => {
  card().querySelector('button[data-act="save"]').click();
  await tick();
  const saved = lastSaved();
  assert.ok(saved, '保存落盘');
  assert.deepEqual(saved.reasoningByModel, {}, '目录不产生 per-model 覆盖');
  assert.deepEqual(saved.modelLevels, {}, '目录不写入自定义词表');
  assert.equal('catalogLevels' in saved, false, '目录字段不进 provider 行');
});

// ─── 3. 清除：删键 + 回「未导入」+ 行词表回落 ───────────────────────────────
test('清除：删除 modelCatalog、状态回空、行 select 不再有目录词', async () => {
  clearBtn().click();
  await tick();
  assert.equal(storedData.modelCatalog, undefined, 'storage 键被删');
  assert.ok(removeCalls.some((k) => k === 'modelCatalog' || (Array.isArray(k) && k.includes('modelCatalog'))));
  assert.match(statusEl().textContent, /No model catalog/i, '状态行回到未导入');
  assert.match(importBtn().textContent, /Import/i, '按钮回到「导入」');
  assert.deepEqual(optionValues(rowSelect()), ['', 'auto'], 'mystery-llm 无内置规则 → 目录清掉后只剩继承/auto');
});

// ─── 4. 导入：只有点击才 fetch；成功后写 storage + 状态/按钮更新 ─────────────
test('点击导入：fetch models.dev → 写 {modelCatalog:{version:1,…}} → 状态含模型数/日期', async () => {
  const fixture = {
    'prov-a': {
      models: {
        'new-model-a': { reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
        'new-model-b': { reasoning_options: [{ type: 'toggle' }] },
      },
    },
  };
  fetchImpl = async () => ({ ok: true, json: async () => fixture });
  const before = fetchCalls.length;

  importBtn().click(); // 同步段：置 busy、禁用按钮、发起 fetch
  await tick(40);

  assert.equal(fetchCalls.length, before + 1, '点击才发一次请求');
  assert.equal(fetchCalls[before], 'https://models.dev/api.json');
  const written = setCalls.map((o) => o.modelCatalog).filter(Boolean).pop();
  assert.ok(written, '写入了 modelCatalog');
  assert.equal(written.version, 1);
  assert.deepEqual(Object.keys(written.models).sort(), ['new-model-a', 'new-model-b']);
  assert.equal(typeof written.fetchedAt, 'number');
  assert.ok(statusEl().textContent.includes('2'), '状态行显示模型数 2');
  assert.match(importBtn().textContent, /Refresh/i, '导入后按钮变「刷新」');
  assert.equal(clearBtn().disabled, false, 'idle 时按钮可用');
});

// ─── 5. busy：请求在飞期间两个按钮都 disabled ───────────────────────────────
test('busy：请求在飞期间 import / clear 都 disabled，完成后恢复', async () => {
  let release;
  const parked = new Promise((res) => { release = res; });
  fetchImpl = () => parked;

  importBtn().click();
  assert.equal(importBtn().disabled, true, 'busy 时导入按钮禁用');
  assert.equal(clearBtn().disabled, true, 'busy 时清除按钮禁用');

  release({ ok: true, json: async () => ({ p: { models: { 'only-model': { reasoning_options: [{ type: 'effort', values: ['low'] }] } } } }) });
  await tick(40);
  assert.equal(importBtn().disabled, false, '完成后恢复');
  assert.equal(clearBtn().disabled, false);
  assert.ok(statusEl().textContent.includes('1'), '新目录生效');
});

// ─── 6. 失败：fetch 抛错 / json 抛错 → 报错、旧目录保留、页面不崩 ────────────
test('fetch 抛错：状态报错、旧目录原样、页面仍可保存', async () => {
  const before = clone(storedData.modelCatalog);
  fetchImpl = async () => { throw new Error('offline'); };

  importBtn().click();
  await tick(40);

  assert.match(statusEl().textContent, /fail/i, '状态行报错');
  assert.deepEqual(storedData.modelCatalog, before, '旧目录不被破坏');
  assert.ok(statusEl().textContent.length > 0);
  card().querySelector('button[data-act="save"]').click();
  await tick();
  assert.ok(lastSaved(), '页面没崩：Save 仍能落盘');
});

test('json 抛错：同上，旧目录保留', async () => {
  const before = clone(storedData.modelCatalog);
  fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });

  importBtn().click();
  await tick(40);

  assert.match(statusEl().textContent, /fail/i);
  assert.deepEqual(storedData.modelCatalog, before, '解析失败不改写存储');
  assert.ok(document.querySelector('.provider[data-name="llm-1"]'), '卡片仍在');
});

test('HTTP 非 2xx：同样按失败处理（不把错误页当目录）', async () => {
  const before = clone(storedData.modelCatalog);
  fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });

  importBtn().click();
  await tick(40);

  assert.match(statusEl().textContent, /fail/i);
  assert.deepEqual(storedData.modelCatalog, before);
});

// ─── 7. 超时：fetch 必须带 AbortSignal；到期后 busy 解锁（无永久禁用）──────
// 无超时的话「服务器接受连接却不回包」会把 _catalogBusy 永久钉在 true：两个
// 按钮永久禁用、状态行停在 Fetching…，除刷新设置页外无恢复路径。这里把
// AbortSignal.timeout 的时长压到 10ms 并让 fetch 挂到 signal abort 上，验证
// 的是真实超时链路（而不是手写一个 reject）。
test('超时：fetch 带 AbortSignal.timeout，到期后 busy 解除、状态报错、仍可再导入', async () => {
  const originalTimeout = AbortSignal.timeout;
  let timeoutMs = null;
  AbortSignal.timeout = (ms) => { timeoutMs = ms; return originalTimeout.call(AbortSignal, 10); };
  let seenSignal = null;
  fetchImpl = (_url, opts) => new Promise((_, reject) => {
    seenSignal = opts?.signal;
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
  });
  const before = clone(storedData.modelCatalog);

  try {
    importBtn().click();
    assert.equal(importBtn().disabled, true, '请求在飞：导入按钮禁用');
    assert.equal(clearBtn().disabled, true, '请求在飞：清除按钮禁用');
    await tick(80);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.ok(seenSignal && typeof seenSignal.aborted === 'boolean', 'fetch 收到 AbortSignal');
  assert.ok(timeoutMs > 0 && timeoutMs <= 30_000, `设置了有限超时（${timeoutMs}ms）`);
  assert.equal(importBtn().disabled, false, '超时后导入按钮解锁（不会永久禁用）');
  assert.equal(clearBtn().disabled, false, '超时后清除按钮解锁');
  assert.match(statusEl().textContent, /fail/i, '状态行报错');
  assert.deepEqual(storedData.modelCatalog, before, '超时不改写旧目录');

  // 恢复路径：解锁后点按钮仍能重新导入。
  fetchImpl = async () => ({ ok: true, json: async () => ({ p: { models: { 'after-timeout': { reasoning_options: [{ type: 'toggle' }] } } } }) });
  importBtn().click();
  await tick(40);
  assert.ok(storedData.modelCatalog && 'after-timeout' in storedData.modelCatalog.models, '超时后仍可再次导入');
});
