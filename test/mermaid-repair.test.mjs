// test/mermaid-repair.test.mjs — 「AI 修复重绘」：
// 1) 纯函数：extractMermaidFence（围栏提取/无围栏兜底）、formatMermaidParseError
//    （token 转储 → 行号+出错原文短句；非 parse error 返回 null）
// 2) 走真实 background.js handle()：REPAIR_MERMAID 用当前 provider 发修复请求
//    （SSE mock），修好返回 { ok, source }；无 provider / 空回复 / 网络失败诚实
//    返回 ok:false——前端按钮据其复位重试，绝不静默假装成功。
// 渲染层（render.js）在修复稿上屏前还有一道本地 mermaid parse 校验，属渲染器
// 职责，不在本文件（jsdom 加载 3MB mermaid bundle 不现实，与既有测试同一取舍）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMermaidFence, repairMermaid } from '../lib/handlers/mermaid-repair.js';
import { formatMermaidParseError } from '../lib/sidepanel/mermaid-utils.js';

// ── 纯函数 ───────────────────────────────────────────────────────────────────

test('extractMermaidFence: 取第一个 mermaid 围栏，剥掉围栏本身', () => {
  const reply = 'Here is the fixed diagram:\n\n```mermaid\nsequenceDiagram\n    A->>B: ok\n```\n\nDone.';
  assert.equal(extractMermaidFence(reply), 'sequenceDiagram\n    A->>B: ok');
});

test('extractMermaidFence: ```mmd 围栏也认；正文里的 ``` 噪音不干扰', () => {
  const reply = '```mmd\nflowchart TD\n    A-->B\n```';
  assert.equal(extractMermaidFence(reply), 'flowchart TD\n    A-->B');
});

test('extractMermaidFence: 无围栏时退回整段修剪文本（前端 parse 校验兜底）', () => {
  assert.equal(extractMermaidFence('sequenceDiagram\n    A->>B: hi'), 'sequenceDiagram\n    A->>B: hi');
  assert.equal(extractMermaidFence('   \n  '), null);
  assert.equal(extractMermaidFence(undefined), null);
});

const REAL_PARSE_ERROR = [
  'Parse error on line 12:',
  '...执行结果    API结果生成最终回复    API-->>Client: ',
  '----------------------^',
  "Expecting '()', 'SOLID_OPEN_ARROW', 'SOLID_ARROW', got 'NEWLINE'",
].join('\n');

test('formatMermaidParseError: token 转储 → 行号 + 出错原文 + Expecting 尾巴', () => {
  const out = formatMermaidParseError(REAL_PARSE_ERROR);
  assert.ok(out, 'parse error 应被识别');
  assert.equal(out.line, 12);
  assert.match(out.excerpt, /API结果生成最终回复/);
  assert.match(out.expecting, /^Expecting .* got 'NEWLINE'$/);
});

test('formatMermaidParseError: 非 parse error（加载失败等）返回 null', () => {
  assert.equal(formatMermaidParseError('mermaid 模块加载失败，请检查控制台'), null);
  assert.equal(formatMermaidParseError(undefined), null);
});

// ── 走真实 background handle() ──────────────────────────────────────────────

function makeStorageArea(initial = {}) {
  let store = { ...initial };
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      return { ...store };
    },
    async set(obj) { store = { ...store, ...obj }; },
    async remove(key) { delete store[key]; },
    _set(obj) { store = { ...store, ...obj }; },
  };
}

const localArea = makeStorageArea({
  activeProvider: 'compatible',
  providers: {
    compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: 'sk-test', model: 'test-model', apiStyle: 'chat', stream: true, maxTokens: 0, temperature: null },
  },
});
const sessionArea = makeStorageArea();

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => null,
    getURL: (p) => p,
    lastError: undefined,
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://example.com', title: 'Test' }],
    get: async () => ({ id: 1, url: 'https://example.com', title: 'Test', favIconUrl: '' }),
  },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  storage: {
    local: localArea,
    session: sessionArea,
    onChanged: { addListener: () => {} },
  },
  action: { setBadgeText: () => {}, onClicked: { addListener: () => {} } },
  commands: { onCommand: { addListener: () => {} } },
  windows: { onFocusChanged: { addListener: () => {} } },
  scripting: { executeScript: async () => [] },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  declarativeNetRequest: { updateSessionRules: async () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
};
globalThis.chrome = chromeMock;

const bg = await import('../background.js');
const { handle } = bg;

function sseFor(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

// responses / anthropic 的 SSE 事件形状与 chat completions 不同，按各自协议给
function sseForResponses(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

function sseForAnthropic(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

const BROKEN_SOURCE = `sequenceDiagram
    participant API as "Hermes API Server (:8642)"
    API结果生成最终回复
    API-->>Client: "[DONE]"`;

test('REPAIR_MERMAID：用当前 provider 发修复请求，返回抽取出的源码', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, body: sseFor('前置废话\n```mermaid\nsequenceDiagram\n    API->>API: 结果生成最终回复\n```'), text: async () => '' };
  };

  const res = await handle({ type: 'REPAIR_MERMAID', source: BROKEN_SOURCE, error: REAL_PARSE_ERROR });

  assert.equal(res.ok, true);
  assert.equal(res.source, 'sequenceDiagram\n    API->>API: 结果生成最终回复');

  // 请求形状：打到 chat/completions，带 system 修复指令，用户消息含坏源码与解析错误
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.equal(calls[0].body.model, 'test-model');
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[0].content, /repair broken Mermaid/i);
  assert.match(calls[0].body.messages[1].content, /API结果生成最终回复/, '坏源码原文要发给模型');
  assert.match(calls[0].body.messages[1].content, /Parse error on line 12/, '解析错误头几行发给模型');
});

test('REPAIR_MERMAID：模型回复无围栏 → 返回整段修剪文本，仍算 ok', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, body: sseFor('sequenceDiagram\n    A->>B: hi'), text: async () => '' });
  const res = await handle({ type: 'REPAIR_MERMAID', source: BROKEN_SOURCE, error: '' });
  assert.equal(res.ok, true);
  assert.equal(res.source, 'sequenceDiagram\n    A->>B: hi');
});

test('REPAIR_MERMAID：无可用 provider（baseUrl 为空）→ 诚实 ok:false', async () => {
  const saved = localArea._set({ activeProvider: 'hermes', providers: { hermes: { type: 'agent', alias: '', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: true, apiStyle: 'chat', temperature: null, maxTokens: 0 } } });
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, body: sseFor('x'), text: async () => '' }; };
  const res = await handle({ type: 'REPAIR_MERMAID', source: BROKEN_SOURCE, error: '' });
  assert.equal(res.ok, false);
  assert.match(res.error, /No active AI provider/);
  assert.equal(fetchCalled, false, '不该发起任何请求');
  // 复原
  localArea._set({ activeProvider: 'compatible', providers: { compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: 'sk-test', model: 'test-model', apiStyle: 'chat', stream: true, maxTokens: 0, temperature: null } } });
});

test('REPAIR_MERMAID：模型返回空内容 → ok:false "no mermaid code"', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, body: sseFor(''), text: async () => '' });
  const res = await handle({ type: 'REPAIR_MERMAID', source: BROKEN_SOURCE, error: '' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no mermaid code/);
});

test('REPAIR_MERMAID：网络失败 → ok:false 带错误信息（按钮据此复位可重试）', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const res = await handle({ type: 'REPAIR_MERMAID', source: BROKEN_SOURCE, error: '' });
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED|Network error/);
});

test('repairMermaid 直调：apiStyle responses/anthropic 走对应流函数', async () => {
  // responses：instructions + input 形状
  {
    let body;
    globalThis.fetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, body: sseForResponses('```mermaid\nA-->B\n```'), text: async () => '' }; };
    const out = await repairMermaid({ provider: { baseUrl: 'http://x', apiKey: 'k', apiStyle: 'responses', maxTokens: 0 }, model: 'm1', source: 'A B', errorText: '' });
    assert.equal(out, 'A-->B');
    assert.ok(body.instructions, 'responses 用 instructions 承载 system');
    assert.match(body.input, /A B/);
  }
  // anthropic：system + messages 形状
  {
    let body;
    globalThis.fetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, body: sseForAnthropic('```mermaid\nA-->B\n```'), text: async () => '' }; };
    const out = await repairMermaid({ provider: { baseUrl: 'http://x', apiKey: 'k', apiStyle: 'anthropic', maxTokens: 0 }, model: 'm2', source: 'A B', errorText: '' });
    assert.equal(out, 'A-->B');
    assert.ok(body.system, 'anthropic 用 system 字段');
    assert.equal(body.messages[0].role, 'user');
    assert.ok(body.max_tokens > 0, 'anthropic max_tokens 必填已兜底');
  }
});
