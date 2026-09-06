// test/selection-explain.test.mjs
// 划词内联解释后端（lib/handlers/selection-explain.js）的纯函数 + 端口会话测试。
// 端口与流式函数全部依赖注入，不需要 chrome mock —— 与
// background-handler.test.mjs 的重量级集成测试互补，这里覆盖协议与分支逻辑。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExplainRequest,
  handleExplainPort,
  isMostlyCjk,
  EXPLAIN_MAX_TOKENS,
  EXPLAIN_TEXT_CAP,
} from '../lib/handlers/selection-explain.js';

function makeFakePort() {
  const msgListeners = [];
  const discListeners = [];
  const sent = [];
  const port = {
    onMessage: { addListener: (f) => msgListeners.push(f) },
    onDisconnect: { addListener: (f) => discListeners.push(f) },
    postMessage: (m) => sent.push(m),
    disconnect() { for (const f of [...discListeners]) f(); },
    emit(msg) { for (const f of [...msgListeners]) f(msg); },
    sent,
  };
  return port;
}

function makeStreams() {
  const calls = [];
  const streams = {
    chatStream: async (args) => { calls.push({ fn: 'chat', args }); args.onDelta('Hel'); args.onDelta('lo'); },
    responsesStream: async (args) => { calls.push({ fn: 'responses', args }); args.onDelta('R'); },
    anthropicStream: async (args) => { calls.push({ fn: 'anthropic', args }); args.onDelta('A'); },
  };
  return { calls, streams };
}

const CFG = {
  activeProvider: 'p1',
  providers: { p1: { baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'm1' } },
};

const flush = () => new Promise((r) => setTimeout(r, 10));

test('buildExplainRequest: zh default, en opt-in, trims and caps text', () => {
  const zh = buildExplainRequest('  serendipity  ');
  assert.equal(zh.user, 'serendipity');
  assert.equal(zh.mode, 'explain');
  assert.match(zh.system, /简体中文/);
  assert.doesNotMatch(zh.system, /Reply in English/);

  const en = buildExplainRequest('serendipity', 'en');
  assert.match(en.system, /Reply in English/);
  assert.doesNotMatch(en.system, /简体中文/);

  const cap = buildExplainRequest('x'.repeat(EXPLAIN_TEXT_CAP + 500));
  assert.equal(cap.user.length, EXPLAIN_TEXT_CAP);
});

test('isMostlyCjk: CJK vs latin counting', () => {
  assert.equal(isMostlyCjk('这是一段中文'), true);
  assert.equal(isMostlyCjk('mostly english words'), false);
  assert.equal(isMostlyCjk('混合 mixed 内容 content'), false);
  assert.equal(isMostlyCjk(''), false);
});

test('buildExplainRequest translate: target language flips when text already in UI language', () => {
  // 界面中文 + 英文选区 → 译成中文
  const toZh = buildExplainRequest('documentation', 'zh', 'translate');
  assert.equal(toZh.mode, 'translate');
  assert.match(toZh.system, /翻译成简体中文/);
  // 界面中文 + 中文选区 → 翻成英文
  const toEn = buildExplainRequest('这是一段中文', 'zh', 'translate');
  assert.match(toEn.system, /Translate the selected text into English/);
  // 界面英文 + 中文选区 → 译成英文（= 界面语言）
  assert.match(buildExplainRequest('这是一段中文', 'en', 'translate').system, /Translate the selected text into English/);
  // 界面英文 + 英文选区 → 翻成中文（翻转）
  assert.match(buildExplainRequest('documentation', 'en', 'translate').system, /翻译成简体中文/);
  // 未知 mode 兜底为 explain
  assert.equal(buildExplainRequest('abc', 'zh', 'nonsense').mode, 'explain');
});

test('handleExplainPort: mode threads through to the system prompt', async () => {
  const port = makeFakePort();
  const { calls, streams } = makeStreams();
  handleExplainPort(port, { getAll: async () => CFG, streams });
  port.emit({ type: 'EXPLAIN_REQUEST', text: 'documentation', lang: 'zh', mode: 'translate' });
  await flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.messages[0].content, /翻译成简体中文/);
  assert.deepEqual(port.sent.at(-1), { type: 'EXPLAIN_DONE' });
});

test('handleExplainPort: happy path streams CHUNKs then DONE, fixed small maxTokens, signal wired', async () => {
  const port = makeFakePort();
  const { calls, streams } = makeStreams();
  handleExplainPort(port, { getAll: async () => CFG, streams });

  port.emit({ type: 'EXPLAIN_REQUEST', text: 'serendipity', lang: 'zh' });
  await flush();

  assert.equal(calls.length, 1);
  const { args } = calls[0];
  assert.equal(args.maxTokens, EXPLAIN_MAX_TOKENS);
  assert.ok(args.signal instanceof AbortSignal);
  assert.equal(args.model, 'm1');
  assert.deepEqual(args.messages[0], { role: 'system', content: buildExplainRequest('serendipity', 'zh').system });
  assert.deepEqual(args.messages[1], { role: 'user', content: 'serendipity' });

  const chunks = port.sent.filter((m) => m.type === 'EXPLAIN_CHUNK');
  assert.deepEqual(chunks.map((m) => m.delta), ['Hel', 'lo']);
  assert.deepEqual(port.sent.at(-1), { type: 'EXPLAIN_DONE' });
});

test('handleExplainPort: apiStyle dispatch — responses uses instructions/input, anthropic uses system/messages', async () => {
  for (const [apiStyle, fn] of [['responses', 'responses'], ['anthropic', 'anthropic']]) {
    const port = makeFakePort();
    const { calls, streams } = makeStreams();
    handleExplainPort(port, {
      getAll: async () => ({ ...CFG, providers: { p1: { ...CFG.providers.p1, apiStyle } } }),
      streams,
    });
    port.emit({ type: 'EXPLAIN_REQUEST', text: 'ctx', lang: 'en' });
    await flush();
    assert.equal(calls[0].fn, fn, apiStyle);
    if (apiStyle === 'responses') {
      assert.ok(calls[0].args.instructions.startsWith('You are an on-page selection explainer'));
      assert.equal(calls[0].args.input, 'ctx');
    } else {
      assert.equal(calls[0].args.system, buildExplainRequest('ctx', 'en').system);
      assert.deepEqual(calls[0].args.messages, [{ role: 'user', content: 'ctx' }]);
    }
    assert.deepEqual(port.sent.at(-1), { type: 'EXPLAIN_DONE' });
  }
});

test('handleExplainPort: config errors land as EXPLAIN_ERROR (no DONE)', async () => {
  const port = makeFakePort();
  const { calls, streams } = makeStreams();
  handleExplainPort(port, { getAll: async () => ({ activeProvider: 'none', providers: {} }), streams });
  port.emit({ type: 'EXPLAIN_REQUEST', text: 'abc' });
  await flush();
  assert.equal(calls.length, 0);
  const err = port.sent.find((m) => m.type === 'EXPLAIN_ERROR');
  assert.ok(err);
  assert.match(err.message, /Provider "none" not configured/);
  assert.ok(!port.sent.some((m) => m.type === 'EXPLAIN_DONE'));
});

test('handleExplainPort: stream failure posts EXPLAIN_ERROR with the message', async () => {
  const port = makeFakePort();
  handleExplainPort(port, {
    getAll: async () => CFG,
    streams: { chatStream: async () => { throw new Error('502 bad gateway'); } },
  });
  port.emit({ type: 'EXPLAIN_REQUEST', text: 'abc' });
  await flush();
  const err = port.sent.find((m) => m.type === 'EXPLAIN_ERROR');
  assert.equal(err.message, '502 bad gateway');
});

test('handleExplainPort: empty text errors without touching the provider', async () => {
  const port = makeFakePort();
  const { calls, streams } = makeStreams();
  handleExplainPort(port, { getAll: async () => CFG, streams });
  port.emit({ type: 'EXPLAIN_REQUEST', text: '   ' });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(port.sent[0].type, 'EXPLAIN_ERROR');
});

test('handleExplainPort: only the first EXPLAIN_REQUEST starts a session', async () => {
  const port = makeFakePort();
  const { calls, streams } = makeStreams();
  handleExplainPort(port, { getAll: async () => CFG, streams });
  port.emit({ type: 'EXPLAIN_REQUEST', text: 'first' });
  port.emit({ type: 'EXPLAIN_REQUEST', text: 'second' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.messages[1].content, 'first');
});

test('handleExplainPort: port disconnect aborts the upstream stream and no error is posted', async () => {
  const port = makeFakePort();
  let observedAbort = null;
  handleExplainPort(port, {
    getAll: async () => CFG,
    streams: {
      chatStream: (args) => new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 200);
        args.signal.addEventListener('abort', () => {
          clearTimeout(t);
          observedAbort = args.signal.aborted;
          reject(new DOMException('Stream aborted', 'AbortError'));
        });
      }),
    },
  });
  port.emit({ type: 'EXPLAIN_REQUEST', text: 'abc' });
  await flush(); // stream now pending
  port.disconnect(); // user closed the popover
  await flush();
  assert.equal(observedAbort, true);
  assert.ok(!port.sent.some((m) => m.type === 'EXPLAIN_ERROR'));
  assert.ok(!port.sent.some((m) => m.type === 'EXPLAIN_DONE'));
});
