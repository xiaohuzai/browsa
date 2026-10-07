// test/options-asr-card.test.mjs — ASR 卡片端到端（真实 options.js + jsdom）：
// 服务商下拉由 lib/asr-providers.js 注册表填充（qwen 在前 = 默认，ark 随后）、
// 提示/占位符/文档链接随动、切换供应商时 Base URL/模型跟随换默认（自定义值保留）、
// 保存链路写入 provider、测试连接按钮接线；以及「模型 ID 字段曾经重复 4 份」的守卫。
//
// 初始种子是一份「已卸载供应商」的配置（'qianwenai'——2026-08-31 移除的第三方转售
// 站；'qwen' 已于 2026-10-06 以官方百炼主体回归注册表并成为默认）——storage 读时归一
// 会把它重置为默认供应商（qwen）的连接字段，供「归一」用例断言。

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

storedData.asr = {
  enabled: true, provider: 'qianwenai', apiKey: 'sk-qianwenai-old',
  baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
  model: 'qwen-audio-3.0-asr-flash-filetrans', videoModel: 'qwen3.8-flash',
  language: 'zh', subtitleSource: 'original',
};

await import('../options.js');
await new Promise((r) => setTimeout(r, 50)); // init() fire-and-forget，等 applyAsr 跑完

test('下拉由注册表填充（qwen 在前 = 默认供应商），归一后的配置选中百炼', () => {
  const sel = document.getElementById('asrProvider');
  assert.ok(sel, '服务商下拉存在');
  assert.deepEqual([...sel.options].map((o) => ({ v: o.value, t: o.textContent })), [
    { v: 'qwen', t: '阿里云百炼' },
    { v: 'ark', t: '火山方舟' },
  ], '只列已实现的服务商，顺序 = 注册表定义序（首位 = 默认）');
  assert.equal(sel.value, 'qwen', '种子是已卸载供应商 → storage 归一为默认百炼');

  assert.equal(document.getElementById('asrBaseUrl').value, 'https://dashscope.aliyuncs.com/compatible-mode/v1', '归一为百炼默认端点');
  assert.equal(document.getElementById('asrModel').value, 'qwen-audio-3.1-asr-flash-filetrans', '归一为百炼默认转写模型');
  assert.equal(document.getElementById('asrVideoModel').value, 'qwen3.8-omni-flash', '归一为百炼默认精读模型');
  assert.match(document.getElementById('asrVideoModel').placeholder, /推荐/, '注册表 defaultVideoModel 驱动「推荐」占位符');
  assert.equal(document.getElementById('asrApiKey').value, '', '已卸载供应商的 key 不残留（待重填）');
  assert.equal(document.getElementById('asrBaseUrl').placeholder, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  const tip = document.getElementById('asrBaseUrlTip');
  assert.match(tip.innerHTML, /api\/v1\/uploads/, 'Base URL 的 ? 提示包含临时文件上传端点');
  const doc = document.getElementById('asrDocLink');
  assert.match(doc.href, /docs\.bailian\.console\.aliyun\.com/);
});

test('切到 ark：Base URL/模型跟随换默认（注册表默认值不残留他厂端点）', () => {
  const sel = document.getElementById('asrProvider');
  sel.value = 'ark';
  sel.dispatchEvent(new window.Event('change'));

  const base = document.getElementById('asrBaseUrl');
  assert.equal(base.value, 'https://ark.cn-beijing.volces.com/api/v3',
    '百炼默认 URL 属于注册表默认值 → 切换时换成方舟默认（用户实测：切了供应商 URL 还指上一家）');
  assert.equal(document.getElementById('asrModel').value, 'doubao-seed-2-1-lite-260915', '模型默认值同样跟随');
  assert.equal(base.placeholder, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.match(document.getElementById('asrApiKey').placeholder, /方舟/);
  assert.equal(document.getElementById('asrModel').placeholder, 'doubao-seed-2-1-lite-260915');
  assert.equal(document.getElementById('asrVideoModel').value, '', 'ark 无 defaultVideoModel → 切换时清空（回退同转写模型语义）');
  assert.match(document.getElementById('asrBaseUrlTip').innerHTML, /api\/v3/, '提示随动');
  assert.match(document.getElementById('asrDocLink').href, /ark\.volcengine\.com/);
});

test('Base URL 留空时切供应商：预填该家默认值', () => {
  const sel = document.getElementById('asrProvider');
  const base = document.getElementById('asrBaseUrl');
  base.value = '';
  sel.value = 'qwen';
  sel.dispatchEvent(new window.Event('change'));
  assert.equal(base.value, 'https://dashscope.aliyuncs.com/compatible-mode/v1', '空值预填百炼默认端点');
});

test('切供应商时自定义端点/模型保留（工作区专属 URL 不是任何注册表默认值）', () => {
  const sel = document.getElementById('asrProvider');
  const base = document.getElementById('asrBaseUrl');
  const custom = 'https://llm-13wi9cyuuunr4nxw.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  base.value = custom;
  document.getElementById('asrModel').value = 'my-finetuned-omni';
  sel.value = 'ark';
  sel.dispatchEvent(new window.Event('change'));
  assert.equal(base.value, custom, '自定义端点保留');
  assert.equal(document.getElementById('asrModel').value, 'my-finetuned-omni', '自定义模型保留');
});

test('模型 ID 字段只有一份（曾因复制粘贴重复 4 份，同 id 干扰 JS 读写）', () => {
  assert.equal(document.querySelectorAll('label[for="asrModel"]').length, 1);
  assert.equal(document.querySelectorAll('#asrModel').length, 1);
});

test('save-asr 选 ark：清空字段后保存回落方舟注册表默认', async () => {
  const sel = document.getElementById('asrProvider');
  sel.value = 'ark';
  document.getElementById('asrBaseUrl').value = ''; // 上一用例的自定义值清空，让 save 回落注册表默认
  document.getElementById('asrModel').value = '';
  sel.dispatchEvent(new window.Event('change'));
  document.getElementById('asrEnabled').checked = true;
  document.getElementById('asrApiKey').value = 'ark-test-key';
  document.querySelector('button[data-act="save-asr"]').click();
  await new Promise((r) => setTimeout(r, 20));

  // setCalls 里可能已有更早用例的 asr 写入——断言的是【本次】点击的落盘。
  const saved = setCalls.filter((o) => o.asr).pop()?.asr;
  assert.ok(saved, 'asr 配置块已写入');
  assert.equal(saved.provider, 'ark');
  assert.equal(saved.enabled, true);
  assert.equal(saved.apiKey, 'ark-test-key');
  assert.equal(saved.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3', 'Base URL 留空 → 注册表默认值');
  assert.equal(saved.model, 'doubao-seed-2-1-lite-260915', '模型留空 → 注册表默认值');
});

test('save-asr 选 qwen（默认）：空字段回落百炼注册表默认（端点/模型）', async () => {
  const sel = document.getElementById('asrProvider');
  sel.value = 'qwen';
  sel.dispatchEvent(new window.Event('change'));
  document.getElementById('asrApiKey').value = 'sk-bailian-test';
  document.getElementById('asrBaseUrl').value = '';
  document.getElementById('asrModel').value = '';
  document.querySelector('button[data-act="save-asr"]').click();
  await new Promise((r) => setTimeout(r, 20));

  const saved = setCalls.filter((o) => o.asr).pop()?.asr;
  assert.equal(saved.provider, 'qwen');
  assert.equal(saved.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'Base URL 留空 → 百炼默认端点');
  assert.equal(saved.model, 'qwen-audio-3.1-asr-flash-filetrans', '模型留空 → 百炼默认转写模型');
  assert.equal(saved.videoModel, 'qwen3.8-omni-flash', '精读模型留空 → 注册表 defaultVideoModel');
  assert.equal(saved.hotwords, '', '热词字段落盘（空串缺省）');
});

test('测试连接：读表单当前值跑适配器 ping，结果写卡片状态位', async () => {
  const sel = document.getElementById('asrProvider');
  sel.value = 'ark';
  sel.dispatchEvent(new window.Event('change'));
  document.getElementById('asrApiKey').value = 'ark-test-key';
  let pingUrl, pingInit;
  globalThis.fetch = async (url, init) => {
    pingUrl = String(url); pingInit = init;
    return { ok: true, json: async () => ({ id: 'resp-1', output: [] }) };
  };
  document.querySelector('button[data-act="test-asr"]').click();
  await new Promise((r) => setTimeout(r, 30));
  delete globalThis.fetch;

  assert.match(pingUrl, /\/responses$/, 'ark ping 走 Responses API 最小补全');
  const body = JSON.parse(pingInit.body);
  assert.equal(body.max_output_tokens, 16, '探针输出上限最小化');
  assert.equal(body.model, 'doubao-seed-2-1-lite-260915', '模型留空时用注册表默认');
  const status = document.getElementById('asr-status');
  assert.match(status.textContent, /✓/, '成功写状态位（含耗时）');
});

test('测试连接：无 Key 直接拦截，不发请求', async () => {
  document.getElementById('asrApiKey').value = '';
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  document.querySelector('button[data-act="test-asr"]').click();
  await new Promise((r) => setTimeout(r, 20));
  delete globalThis.fetch;
  assert.equal(called, false, '无 Key 不发探针');
  assert.match(document.getElementById('asr-status').textContent, /API Key/);
});
