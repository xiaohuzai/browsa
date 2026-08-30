// test/options-asr-card.test.mjs — ASR 卡片端到端（真实 options.js + jsdom）：
// 服务商下拉由 lib/asr-providers.js 注册表填充、提示/占位符/文档链接随动、
// 保存链路写入 provider；以及「模型 ID 字段曾经重复 4 份」的回归守卫。

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
await new Promise((r) => setTimeout(r, 50)); // init() fire-and-forget，等 applyAsr 跑完

test('服务商下拉由注册表填充，ark 元数据驱动占位符/?提示/文档链接', () => {
  const sel = document.getElementById('asrProvider');
  assert.ok(sel, '服务商下拉存在');
  assert.deepEqual([...sel.options].map((o) => ({ v: o.value, t: o.textContent })), [
    { v: 'ark', t: '火山方舟' },
    { v: 'qwen', t: '千问AI平台' },
  ], '只列已实现的服务商');
  assert.equal(sel.value, 'ark', '默认选中 ark');

  assert.equal(document.getElementById('asrBaseUrl').placeholder, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.match(document.getElementById('asrApiKey').placeholder, /方舟/);
  assert.equal(document.getElementById('asrModel').placeholder, 'doubao-seed-2-0-lite-260428');
  const tip = document.getElementById('asrBaseUrlTip');
  assert.match(tip.innerHTML, /api\/v3/, 'Base URL 的 ? 提示来自注册表');
  const doc = document.getElementById('asrDocLink');
  assert.match(doc.href, /ark\.volcengine\.com/);
  assert.match(doc.textContent, /火山方舟/);
});

test('模型 ID 字段只有一份（曾因复制粘贴重复 4 份，同 id 干扰 JS 读写）', () => {
  assert.equal(document.querySelectorAll('label[for="asrModel"]').length, 1);
  assert.equal(document.querySelectorAll('#asrModel').length, 1);
});

test('save-asr 把 provider 写入 asr 配置块', async () => {
  document.getElementById('asrEnabled').checked = true;
  document.getElementById('asrApiKey').value = 'ark-test-key';
  document.querySelector('button[data-act="save-asr"]').click();
  await new Promise((r) => setTimeout(r, 20));

  const saved = setCalls.find((o) => o.asr)?.asr;
  assert.ok(saved, 'asr 配置块已写入');
  assert.equal(saved.provider, 'ark');
  assert.equal(saved.enabled, true);
  assert.equal(saved.apiKey, 'ark-test-key');
  assert.equal(saved.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3', 'Base URL 留空 → 注册表默认值');
  assert.equal(saved.model, 'doubao-seed-2-0-lite-260428', '模型留空 → 注册表默认值');
});

test('切换到 qwen：占位符/?提示/文档链接随注册表切换，视频模型给推荐值', () => {
  const sel = document.getElementById('asrProvider');
  sel.value = 'qwen';
  sel.dispatchEvent(new window.Event('change'));
  assert.equal(document.getElementById('asrBaseUrl').placeholder, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(document.getElementById('asrModel').placeholder, 'qwen3.5-omni-flash');
  assert.equal(document.getElementById('asrVideoModel').placeholder, 'qwen3.8-flash（推荐）');
  const tip = document.getElementById('asrBaseUrlTip');
  assert.match(tip.innerHTML, /compatible-mode\/v1/, 'qwen 的 ? 提示来自注册表');
  const doc = document.getElementById('asrDocLink');
  assert.match(doc.href, /platform\.qianwenai\.com/);
  assert.match(doc.textContent, /千问/);
});

test('qwen 保存：模型留空走注册表默认（转写 Omni / 视频视觉系两个模型分工）', async () => {
  const sel = document.getElementById('asrProvider');
  sel.value = 'qwen';
  sel.dispatchEvent(new window.Event('change'));
  document.getElementById('asrEnabled').checked = true;
  document.getElementById('asrApiKey').value = 'sk-qwen-test';
  document.getElementById('asrBaseUrl').value = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  document.querySelector('button[data-act="save-asr"]').click();
  await new Promise((r) => setTimeout(r, 20));

  const saved = setCalls.filter((o) => o.asr).map((o) => o.asr).pop();
  assert.ok(saved, 'asr 配置块已写入');
  assert.equal(saved.provider, 'qwen');
  assert.equal(saved.model, 'qwen3.5-omni-flash', '转写模型留空 → 注册表默认 Omni');
  assert.equal(saved.videoModel, 'qwen3.8-flash', '视频模型留空 → 注册表推荐视觉系模型');
  // 复位，避免影响后续/其它用例对默认供应商的假设
  sel.value = 'ark';
  sel.dispatchEvent(new window.Event('change'));
});
