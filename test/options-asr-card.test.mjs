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

// 预置一份「已卸载供应商」的 ASR 配置，验证 applyAsr 的回落行为
storedData.asr = {
  enabled: true, provider: 'qwen', apiKey: 'sk-qwen-old',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-audio-3.0-asr-flash-filetrans', videoModel: 'qwen3.8-flash',
  language: 'zh', subtitleSource: 'original',
};

await import('../options.js');
await new Promise((r) => setTimeout(r, 50)); // init() fire-and-forget，等 applyAsr 跑完

test('服务商下拉由注册表填充，ark 元数据驱动占位符/?提示/文档链接', () => {
  const sel = document.getElementById('asrProvider');
  assert.ok(sel, '服务商下拉存在');
  assert.deepEqual([...sel.options].map((o) => ({ v: o.value, t: o.textContent })), [
    { v: 'ark', t: '火山方舟' },
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

test('存过已卸载供应商（qwen）的 ASR 配置：storage 读时归一，UI 回落 ark 默认', () => {
  // storedData.asr 在文件顶部播种（provider 'qwen' 已不在注册表）；
  // storage.getAll 归一化把连接字段换回方舟默认值（key 清空待重填），UI 原样呈现
  assert.equal(document.getElementById('asrProvider').value, 'ark', '服务商回落 ark');
  assert.equal(document.getElementById('asrBaseUrl').value, 'https://ark.cn-beijing.volces.com/api/v3', 'baseUrl 归一为方舟默认');
  assert.equal(document.getElementById('asrModel').value, 'doubao-seed-2-0-lite-260428', '模型归一为方舟默认');
  assert.equal(document.getElementById('asrApiKey').value, '', '千问 key 不残留（待重填）');
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
