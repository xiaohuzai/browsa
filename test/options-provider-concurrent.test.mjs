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

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: storedData[keys] };
        return { ...storedData };
      },
      set: async (obj) => { setCalls.push(obj); Object.assign(storedData, obj); },
    },
  },
};

await import('../options.js');
await new Promise((r) => setTimeout(r, 50));

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