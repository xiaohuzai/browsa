// test/options-provider-concurrent.test.mjs — provider 表级并发写入（真实 options.js + jsdom）。
// persistProvider 的 read-merge-write 必须救回 storage 里【被并发修改的既有行】，
// 不只是【新增行】。此前合并只 `if (!(k in next)) next[k]=v`，两边都存在的 key
// 一律保留页面加载时的旧快照：开两个设置页，A 改了 llm-1 并保存，B 仍持旧快照，
// B 保存另一张卡 llm-2 时整表写回会把 llm-1 回退成旧值——A 的修改被静默抹掉。
// 本用例用真实 UI 动作（点 llm-2 卡的 Save）触发，断言用户可见的存储结果。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { mergeProviderRow } from '../lib/provider-merge.js';
import { DEFAULT_PROVIDERS } from '../lib/storage.js';

const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/options.html', runScripts: undefined });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.location = dom.window.location;

const llm = (alias, apiKey, model) => ({
  type: 'llm', alias, baseUrl: `https://${alias}.example/v1`, apiKey, model, models: [model],
  stream: true, isHermes: false, apiStyle: 'chat', temperature: null, maxTokens: 0,
});
const storedData = {
  providers: { 'llm-1': llm('a', 'sk-1', 'm1'), 'llm-2': llm('b', 'sk-other', 'm2') },
};
const setCalls = [];
let failProviderRead = false; // 读失败用例：storage.get('providers') 拒绝

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (failProviderRead && (keys === 'providers' || keys == null || (Array.isArray(keys) && keys.includes('providers')))) {
          throw new Error('storage read failed');
        }
        // 深拷贝进出（同 options-provider-ping.test.mjs）：真实 API 会序列化。
        // 不克隆时页面快照与 storedData 别名共享，测试里的「另一页删除」会
        // 顺手删掉本页快照——复活 bug 被 harness 自己掩盖。
        const clone = (v) => (v === undefined ? undefined : structuredClone(v));
        if (typeof keys === 'string') return { [keys]: clone(storedData[keys]) };
        return clone(storedData);
      },
      set: async (obj) => { setCalls.push(structuredClone(obj)); Object.assign(storedData, structuredClone(obj)); },
    },
  },
};

await import('../options.js');
await new Promise((r) => setTimeout(r, 50));

// ─── 合并策略纯函数：四态直测（不经 DOM seam）───────────────────────────────

test('mergeProviderRow: 并发编辑 storage 赢', () => {
  const stored = { 'llm-1': { apiKey: 'sk-new' }, 'llm-2': { apiKey: 'sk-2' } };
  const next = mergeProviderRow(stored, {}, 'llm-2', { apiKey: 'sk-mine' });
  assert.equal(next['llm-1'].apiKey, 'sk-new', '不写的行以 storage 为准');
  assert.equal(next['llm-2'].apiKey, 'sk-mine', '正在写的行用新值');
  assert.equal(stored['llm-2'].apiKey, 'sk-2', '输入表不被改写（返回新表）');
});

test('mergeProviderRow: 并发新增保留', () => {
  const stored = { 'llm-1': { apiKey: 'a' }, 'llm-9': { apiKey: 'created-elsewhere' } };
  const next = mergeProviderRow(stored, {}, 'llm-1', { apiKey: 'b' });
  assert.equal(next['llm-9'].apiKey, 'created-elsewhere', '别的页新增的行必须保留');
});

test('mergeProviderRow: 并发删除不复活（基底不是页面快照）', () => {
  // 页面快照里还有 llm-2，但 storage 已删——纯函数根本不收页面快照，无从复活。
  const stored = { 'llm-1': { apiKey: 'a' } };
  const next = mergeProviderRow(stored, {}, 'llm-1', { apiKey: 'b' });
  assert.equal('llm-2' in next, false);
  // 显式删除：value === undefined 删行。
  const del = mergeProviderRow({ 'llm-1': {}, 'llm-2': {} }, {}, 'llm-2', undefined);
  assert.deepEqual(Object.keys(del), ['llm-1']);
});

test('mergeProviderRow: 内置默认行未入库时保留，名单以 DEFAULT_PROVIDERS 为准', () => {
  const next = mergeProviderRow({}, DEFAULT_PROVIDERS, 'llm-1', { apiKey: 'x' });
  for (const name of Object.keys(DEFAULT_PROVIDERS)) {
    assert.ok(next[name], `默认行 ${name} 尚未入 storage，合并后必须仍在`);
  }
  // storage 已持有的默认行：storage 赢，默认值不回退。
  const edited = mergeProviderRow({ hermes: { baseUrl: 'http://mine' } }, DEFAULT_PROVIDERS, 'llm-1', {});
  assert.equal(edited.hermes.baseUrl, 'http://mine');
});

test('保存另一张卡不得抹掉并发写入的既有 provider（lost-update 回归）', async () => {
  // 模拟另一个设置页在本页加载之后改了 llm-1 的 apiKey（storage 已是新值，
  // 本页 cachedCfg 仍是加载时的旧快照）。
  storedData.providers['llm-1'] = { ...storedData.providers['llm-1'], apiKey: 'sk-2' };

  const c2 = document.querySelector('.provider[data-name="llm-2"]');
  assert.ok(c2, 'llm-2 卡存在');
  c2.querySelector('button[data-act="save"]').click();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(storedData.providers['llm-1'].apiKey, 'sk-2',
    '并发修改的 llm-1 必须保留 storage 新值，不被本页旧快照回退');
  assert.equal(storedData.providers['llm-2'].apiKey, 'sk-other', 'llm-2 自身正常保存');
});

test('页面独有的内置默认行（尚未入 storage）不被合并丢弃', async () => {
  // 内置 agent 卡（hermes 等）在用户首次保存前不在 storage 里；合并后仍须存在。
  assert.ok(storedData.providers.hermes || document.querySelector('.provider[data-name="hermes"]'),
    '内置 hermes 卡仍在（合并以页面表为底保留默认行）');
});

test('并发删除不复活：另一页删掉的行不得从本页快照写回（lost-delete 回归）', async () => {
  // 模拟另一个设置页在本页加载之后删掉了 llm-2；本页 cachedCfg 仍持有它。
  // 旧合并基底是页面快照——storage 赢的只是「storage 还持有的行」，被删的行
  // 会从快照复活。点 llm-1 的 Save 后 llm-2 必须仍然缺席。
  delete storedData.providers['llm-2'];

  const c1 = document.querySelector('.provider[data-name="llm-1"]');
  assert.ok(c1, 'llm-1 卡存在');
  c1.querySelector('button[data-act="save"]').click();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal('llm-2' in storedData.providers, false,
    '被并发删除的 llm-2 不得从页面快照复活');
  assert.ok(storedData.providers['llm-1'], 'llm-1 自身正常保存');
});

test('storage 读失败必须放弃本次写入（绝不带残缺基底落盘）', async () => {
  // 新基底完全来自 storage；把读失败的 null 当空表会一次性抹掉全部用户行。
  // 读失败 → flash 错误 + 不写。
  failProviderRead = true;
  const before = JSON.stringify(storedData.providers);
  const setsBefore = setCalls.length;
  try {
    const c1 = document.querySelector('.provider[data-name="llm-1"]');
    c1.querySelector('button[data-act="save"]').click();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    failProviderRead = false;
  }
  assert.equal(setCalls.length, setsBefore, '读失败后不得有任何 storage.set');
  assert.equal(JSON.stringify(storedData.providers), before, '存储表原样不动');
  assert.match(document.getElementById('status').className, /err/, '读失败必须有可见的错误 flash');
});

test('同页两张卡并发保存都被串行化——后写不覆盖前行（read-merge-write 锁）', async () => {
  // Without the storage-level chain lock both saves snapshot the SAME
  // pre-state inside their get→merge→set windows; the later write clobbers
  // the earlier row. Fire both clicks in the same tick.
  const c1 = document.querySelector('.provider[data-name="llm-1"]');
  const c2 = document.querySelector('.provider[data-name="llm-2"]');
  c1.querySelector('[data-k="apiKey"]').value = 'sk-A-edit';
  c2.querySelector('[data-k="apiKey"]').value = 'sk-B-edit';
  c1.querySelector('button[data-act="save"]').click();
  c2.querySelector('button[data-act="save"]').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(storedData.providers['llm-1'].apiKey, 'sk-A-edit', 'first save survives the second');
  assert.equal(storedData.providers['llm-2'].apiKey, 'sk-B-edit', 'second save lands too');
});
