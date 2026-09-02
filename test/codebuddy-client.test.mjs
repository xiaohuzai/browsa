// test/codebuddy-client.test.mjs
// Unit tests for lib/codebuddy-client.js — the WorkBuddy (CodeBuddy CLI
// headless) client over a mocked chrome.runtime.connectNative port. Wire
// shapes follow the OFFICIAL headless docs (codebuddy.ai/docs/cli/headless):
// system/init with session_id, assistant messages with text/tool_use blocks,
// task_* progress events, terminal result with is_error/usage. The bridge
// control frame {"argv":[...]} must precede everything else.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeBridge {
  constructor() {
    this.frames = [];
    this.closed = false;
    this.disconnectReason = null;
    this._msg = null;
    this._disc = null;
    this._handlers = [];
    const self = this;
    globalThis.chrome = {
      runtime: {
        get lastError() { return self.disconnectReason ? { message: self.disconnectReason } : null; },
        connectNative: (name) => {
          assert.equal(name, 'com.xiaohuzai.browsa_codebuddy');
          return {
            onMessage: { addListener: (fn) => { self._msg = fn; } },
            onDisconnect: { addListener: (fn) => { self._disc = fn; } },
            postMessage: (obj) => {
              self.frames.push(obj);
              for (const h of self._handlers) h(obj, self);
            },
            disconnect: () => { self.closed = true; },
          };
        },
      },
    };
  }

  // Script the engine side. handler(clientFrame, bridge) fires per frame.
  start(handler) { this._handlers.push(handler); }
  send(msg) { this._msg?.(msg); }
  die(reason) {
    this.disconnectReason = reason;
    this.closed = true;
    this._disc?.();
  }

  // Standard scripted turn: init (echoing injected argv) → steps → result.
  scriptTurn({ text = '答', sessionId = 'sess-1', steps = [], result = { subtype: 'success', is_error: false, result: '答', usage: { input_tokens: 10, output_tokens: 5 } } } = {}) {
    this.start((f, b) => {
      if (f.type === 'user') {
        setTimeout(() => {
          b.send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'm1', version: '2.0.0' });
          for (const step of steps) step(b);
          b.send({ type: 'result', ...result, session_id: sessionId });
        }, 5);
      }
    });
  }
}

async function freshClient() {
  return import('../lib/codebuddy-client.js');
}

const userInputFrames = (bridge) => bridge.frames.filter((f) => f.type === 'user');

test('codebuddyStream: happy path — control frame first, init sessionId, text + progress, usage', async () => {
  const { codebuddyStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.scriptTurn({
    steps: [
      (b) => b.send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la /long/path/that/is/way/too/long/for/one/line/and/keeps/going/and/going/yes/really/long' } }] } }),
      (b) => b.send({ type: 'task_progress', task_id: 't1', description: 'reading files' }),
      (b) => b.send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } }),
    ],
    result: { subtype: 'success', is_error: false, result: '你好', usage: { input_tokens: 10, output_tokens: 5 } },
  });

  const deltas = [];
  const progress = [];
  let seenSessionId = null;
  const result = await codebuddyStream({
    message: 'hi',
    sessionId: null,
    onSessionId: (id) => { seenSessionId = id; },
    onDelta: (d) => deltas.push(d),
    onToolProgress: (t) => progress.push(t),
  });

  // Control frame must be the very first thing sent, empty argv when fresh.
  assert.deepEqual(bridge.frames[0], { argv: [] });
  assert.equal(seenSessionId, 'sess-1');
  assert.equal(result.full, '你好');
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  assert.deepEqual(deltas, ['你好']);
  assert.equal(progress.length, 2);
  assert.match(progress[0], /^workbuddy ▶ Bash: ls -la /);
  assert.equal(progress[1], 'workbuddy 后台进度: reading files');
  // User frame carries the official shape.
  const uf = userInputFrames(bridge)[0];
  assert.deepEqual(uf.message.content, [{ type: 'text', text: 'hi' }]);
  assert.equal(bridge.closed, true, 'port disconnected after the turn');
});

test('codebuddyStream: resume injects --resume through the control frame; bad ids are dropped', async () => {
  const { codebuddyStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.scriptTurn({});
  await codebuddyStream({ message: 'x', sessionId: 'sess-abc-123', onDelta: () => {}, onToolProgress: () => {} });
  assert.deepEqual(bridge.frames[0], { argv: ['--resume', 'sess-abc-123'] });

  const bridge2 = new FakeBridge();
  bridge2.scriptTurn({});
  // Session ids come from the engine (uuid-ish), but a hostile/garbage value
  // must not pass the shim's charset gate — it becomes a fresh session.
  await codebuddyStream({ message: 'x', sessionId: 'bad id; rm -rf', onDelta: () => {}, onToolProgress: () => {} });
  assert.deepEqual(bridge2.frames[0], { argv: [] });
});

test('codebuddyStream: pasted image data URLs ride as base64 blocks; http URLs skipped', async () => {
  const { codebuddyStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.scriptTurn({});
  await codebuddyStream({
    message: '看图',
    images: ['data:image/png;base64,iVBORw0K', 'https://example.com/x.jpg', 'data:text/plain;base64,aGk='],
    onDelta: () => {}, onToolProgress: () => {},
  });
  const content = userInputFrames(bridge)[0].message.content;
  assert.deepEqual(content[0], { type: 'text', text: '看图' });
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } });
  assert.equal(content.length, 2, 'http(s) and non-image data URLs are dropped');
});

test('codebuddyStream: result error with no text → rejects with the engine message', async () => {
  const { codebuddyStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.scriptTurn({ result: { subtype: 'error_during_execution', is_error: true, result: '需要登录后才能继续' } });
  await assert.rejects(
    () => codebuddyStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} }),
    /需要登录/,
  );
});

test('codebuddyStream: text streamed then error → still surfaces the failure', async () => {
  const { codebuddyStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.scriptTurn({
    steps: [(b) => b.send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '部分内容' }] } })],
    result: { subtype: 'error_during_execution', is_error: true, result: '中途崩了' },
  });
  await assert.rejects(
    () => codebuddyStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} }),
    /中途崩了/,
  );
});

test('codebuddyStream: bridge dies mid-turn → rejects, no hang', async () => {
  const { codebuddyStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.start((f, b) => {
    if (f.type === 'user') setTimeout(() => b.die('Native host has exited'), 15);
  });
  await assert.rejects(
    () => codebuddyStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} }),
    /Native host has exited/,
  );
});

test('codebuddyStream: abort disconnects the port and rejects with AbortError', async () => {
  const { codebuddyStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.start((f, b) => {
    if (f.type === 'user') setTimeout(() => { /* never completes */ }, 5);
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 15);
  await assert.rejects(
    () => codebuddyStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {}, signal: ctrl.signal }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(bridge.closed, true);
});

test('codebuddyPing: init event reports version + model', async () => {
  const { codebuddyPing } = await freshClient();
  const bridge = new FakeBridge();
  bridge.start((f, b) => {
    if (f.argv !== undefined) {
      setTimeout(() => b.send({ type: 'system', subtype: 'init', session_id: 's', model: 'glm-5.3', version: '2.143.0' }), 5);
    }
  });
  const reply = await codebuddyPing();
  assert.match(reply, /codebuddy 2\.143\.0 · 模型 glm-5\.3/);
  assert.equal(bridge.closed, true);
});

test('codebuddyPing: host not registered → install hint, not a raw error', async () => {
  const { codebuddyPing } = await freshClient();
  const bridge = new FakeBridge();
  bridge.start(() => {});
  setTimeout(() => bridge.die('Access to the specified native messaging host is forbidden'), 5);
  await assert.rejects(() => codebuddyPing(), /桥接未安装/);
});
