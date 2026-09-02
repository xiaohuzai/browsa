// test/codex-client.test.mjs
// Unit tests for lib/codex-client.js — the Codex app-server client over a
// mocked chrome.runtime.connectNative port. Wire shapes mirror what was
// verified live against codex-cli 0.149.1 (see module header of
// codex-client.js): initialize/initialized handshake, thread/start →
// turn/start, agentMessage text arriving on item/started AND item/completed
// (with deltas possibly absent entirely), approvals as server→client
// requests with snake_case ReviewDecision replies, turn/completed failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Fake native-messaging bridge: emulates both the bridge process frame piping
// and the codex app-server behind it. Tests script its behavior per case.

class FakeBridge {
  constructor() {
    this.frames = [];          // every frame the client posted (methods + responses)
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
          assert.equal(name, 'com.agentbridge.codex');
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

  // Register the codex-side behavior: handler(clientFrame, bridge).
  start(handler) { this._handlers.push(handler); }

  // Deliver a frame to the client (notification, response, or server request).
  send(msg) { this._msg?.(msg); }

  // Simulate the host process dying (bridge missing, crash, Chrome kill).
  die(reason) {
    this.disconnectReason = reason;
    this.closed = true;
    this._disc?.();
  }

  // Standard handshake + thread/start, returning the threadId used.
  handshake({ threadId = 'th1', failResume = false } = {}) {
    this.start((f, b) => {
      if (f.method === 'initialize') b.send({ id: f.id, result: { userAgent: 'browsa/0.149.1 (test)', codexHome: '/home/u/.codex' } });
      else if (f.method === 'thread/resume') {
        if (failResume) b.send({ id: f.id, error: { message: 'thread not found' } });
        else b.send({ id: f.id, result: { thread: { id: f.params.threadId } } });
      } else if (f.method === 'thread/start') b.send({ id: f.id, result: { thread: { id: threadId } } });
    });
  }

  // Drive a scripted turn after turn/start: emit each entry (a function
  // receiving the bridge for side effects), then a terminal turn/completed.
  // Emissions are async (next tick) — the real engine streams notifications
  // as they happen, never synchronously inside the turn/start response.
  // noTerminal keeps the turn in flight (abort / bridge-death tests).
  scriptTurn(steps, { finalStatus = 'completed', finalError = null, noTerminal = false } = {}) {
    let turnId = null;
    this.start((f, b) => {
      if (f.method === 'turn/start') {
        turnId = `tn-${f.id}`;
        b.send({ id: f.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        setTimeout(() => {
          for (const step of steps) step(b, turnId);
          if (!noTerminal) {
            b.send({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: turnId, status: finalStatus, error: finalError } } });
          }
        }, 5);
      }
    });
    return () => turnId;
  }
}

async function freshClient() {
  const mod = await import('../lib/codex-client.js');
  return mod;
}

const deltasOf = (frames) => frames.filter((f) => f.method === 'item/agentMessage/delta')
  .map((f) => f.params.delta);

// ---------------------------------------------------------------------------

test('codexStream: happy path — deltas stream, item texts dedup against them', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  bridge.scriptTurn([
    (b) => b.send({ method: 'item/agentMessage/delta', params: { delta: 'HE' } }),
    (b) => b.send({ method: 'item/started', params: { item: { type: 'agentMessage', text: 'HELLO' } } }),
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'HELLO' } } }),
  ]);

  const deltas = [];
  const result = await codexStream({
    message: 'hi',
    threadId: null,
    onDelta: (d) => deltas.push(d),
    onToolProgress: () => {},
    signal: undefined,
  });

  assert.equal(result.full, 'HELLO', 'delta + remainder must assemble the full text exactly once');
  assert.deepEqual(deltas, ['HE', 'LLO']);
  // Wire calls in order: initialize → initialized → thread/start → turn/start
  const methods = bridge.frames.filter((f) => f.method).map((f) => f.method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/start', 'turn/start']);
  const turn = bridge.frames.find((f) => f.method === 'turn/start');
  assert.equal(turn.params.threadId, 'th1');
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'hi' }]);
  assert.equal(bridge.closed, true, 'the port must be disconnected after the turn');
});

test('codexStream: short replies with NO delta — full text emitted exactly once', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  // Live-verified shape: item/started AND item/completed both carry the whole
  // text; without deltas they must not double-render.
  bridge.scriptTurn([
    (b) => b.send({ method: 'item/started', params: { item: { type: 'agentMessage', text: 'OK' } } }),
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'OK' } } }),
  ]);

  const result = await codexStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} });
  assert.equal(result.full, 'OK');
});

test('codexStream: reasoning summary becomes one <thinking> block, deduped across started/completed', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  bridge.scriptTurn([
    (b) => b.send({ method: 'item/started', params: { item: { type: 'reasoning', id: 'r1', summary: ['想一下。'] } } }),
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'reasoning', id: 'r1', summary: ['想一下。'] } } }),
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '答' } } }),
  ]);

  const result = await codexStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} });
  assert.equal(result.full, '<thinking>\n想一下。\n</thinking>\n\n答');
});

test('codexStream: command items surface as TOOL_PROGRESS lines', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  bridge.scriptTurn([
    (b) => b.send({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: ['ls', '-la', '/tmp/very/long/path/that/goes/on/and/on/and/on/for/quite/a/while/indeed/yes'] } } }),
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', command: ['ls'], exitCode: 0 } } }),
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } }),
  ]);

  const progress = [];
  await codexStream({ message: 'x', onDelta: () => {}, onToolProgress: (t) => progress.push(t) });
  assert.equal(progress.length, 2);
  assert.match(progress[0], /^codex 命令: ls -la/);
  assert.match(progress[1], /✓$/);
});

test('codexStream: execCommandApproval → respond closure sends snake_case decisions', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  let approvalData = null;
  bridge.scriptTurn([
    (b, turnId) => {
      b.send({ id: 900, method: 'execCommandApproval', params: { conversationId: 'th1', callId: 'call1', command: ['rm', '-rf', '/tmp/x'], cwd: '/tmp', reason: '需要清理' } });
      b.send({ id: 901, method: 'execCommandApproval', params: { conversationId: 'th1', callId: 'call2', command: ['ls'] } });
      b.send({ id: 902, method: 'applyPatchApproval', params: { conversationId: 'th1', callId: 'call3', fileChanges: { '/a.js': {} } } });
    },
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'ok' } } }),
  ]);

  await codexStream({
    message: 'x',
    onDelta: () => {},
    onToolProgress: () => {},
    onApproval: (data) => {
      if (data.approvalId === 'call1') { assert.equal(data.command, 'rm -rf /tmp/x'); assert.equal(data.description, '需要清理'); data.respond('allow'); }
      else if (data.approvalId === 'call2') data.respond('deny');
      else if (data.approvalId === 'call3') { assert.match(data.command, /1 个文件/); data.respond('allow_session'); }
    },
  });

  const respond = (id) => bridge.frames.find((f) => f.id === id);
  assert.deepEqual({ id: 900, result: { decision: 'approved' } }, { id: 900, result: respond(900).result });
  assert.equal(respond(901).result.decision, 'denied');
  assert.equal(respond(902).result.decision, 'approved_for_session');
});

test('codexStream: without onApproval the request is auto-denied (no hang)', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  bridge.scriptTurn([
    (b) => b.send({ id: 910, method: 'execCommandApproval', params: { conversationId: 'th1', callId: 'c', command: ['x'] } }),
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'ok' } } }),
  ]);
  const result = await codexStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} });
  assert.equal(bridge.frames.find((f) => f.id === 910).result.decision, 'denied');
  assert.equal(result.full, 'ok');
});

test('codexStream: turn fails → rejects with the engine message', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  bridge.scriptTurn([], { finalStatus: 'failed', finalError: { message: 'Missing environment variable: `ARK_API_KEY`.' } });
  await assert.rejects(
    () => codexStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} }),
    /ARK_API_KEY/,
  );
});

test('codexStream: threadId resumes the stored thread; fresh thread id propagates via onThreadId', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  bridge.scriptTurn([
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'a' } } }),
  ]);
  let seenThreadId = null;
  await codexStream({ message: 'x', threadId: 'th-stored', onThreadId: (id) => { seenThreadId = id; }, onDelta: () => {}, onToolProgress: () => {} });
  assert.equal(bridge.frames.find((f) => f.method === 'thread/resume').params.threadId, 'th-stored');
  assert.equal(seenThreadId, 'th-stored');
  assert.ok(!bridge.frames.some((f) => f.method === 'thread/start'), 'no thread/start when resuming');
});

test('codexStream: stale thread falls back to thread/start instead of failing the turn', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake({ failResume: true, threadId: 'th-new' });
  bridge.scriptTurn([
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'a' } } }),
  ]);
  let seenThreadId = null;
  const result = await codexStream({ message: 'x', threadId: 'th-stale', onThreadId: (id) => { seenThreadId = id; }, onDelta: () => {}, onToolProgress: () => {} });
  assert.equal(seenThreadId, 'th-new');
  assert.equal(result.full, 'a');
});

test('codexStream: usage sums across thread/tokenUsage groups', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  bridge.scriptTurn([
    (b) => b.send({ method: 'thread/tokenUsage/updated', params: { threadId: 'th1', usage: { groups: [
      { model: 'm1', input_tokens: 10, cached_input_tokens: 5, output_tokens: 20, total_tokens: 35 },
      { model: 'm2', input_tokens: 7, cached_input_tokens: 0, output_tokens: 3, total_tokens: 10 },
    ] } } }),
    (b) => b.send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'a' } } }),
  ]);
  const result = await codexStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} });
  assert.deepEqual(result.usage, { input_tokens: 22, output_tokens: 23, total_tokens: 45 });
});

test('codexStream: abort sends turn/interrupt and rejects with AbortError', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  const ctrl = new AbortController();
  bridge.scriptTurn([
    (b, turnId) => {
      setTimeout(() => ctrl.abort(), 15);
    },
  ], { noTerminal: true });

  await assert.rejects(
    () => codexStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {}, signal: ctrl.signal }),
    (e) => e.name === 'AbortError',
  );
  const interrupt = bridge.frames.find((f) => f.method === 'turn/interrupt');
  assert.ok(interrupt, 'turn/interrupt must be sent over the port');
  assert.ok(interrupt.params.turnId, 'interrupt carries the turn id');
  assert.equal(bridge.closed, true);
});

test('codexStream: bridge dies mid-turn → ProviderAPIError, no hang', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.handshake();
  bridge.scriptTurn([
    (b) => setTimeout(() => b.die('Native host has exited'), 15),
  ], { noTerminal: true });
  await assert.rejects(
    () => codexStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} }),
    /Native host has exited/,
  );
});

test('codexStream: shim binary-not-found frame surfaces the exact reason', async () => {
  const { codexStream } = await freshClient();
  const bridge = new FakeBridge();
  bridge.start(() => {});
  setTimeout(() => bridge.send({ error: { code: 'codex-binary-not-found', message: '没找到 codex。' } }), 5);
  await assert.rejects(
    () => codexStream({ message: 'x', onDelta: () => {}, onToolProgress: () => {} }),
    /没找到 codex/,
  );
});

test('codexPing: reachable engine reports version + model count', async () => {
  const { codexPing } = await freshClient();
  const bridge = new FakeBridge();
  bridge.start((f, b) => {
    if (f.method === 'initialize') b.send({ id: f.id, result: { userAgent: 'browsa/0.149.1 (Ubuntu; x86_64)', codexHome: '/x' } });
    else if (f.method === 'model/list') b.send({ id: f.id, result: { data: [{ id: 'a' }, { id: 'b' }] } });
  });
  const reply = await codexPing();
  assert.match(reply, /ok — codex 0\.149\.1 · 2 个模型/);
  assert.equal(bridge.closed, true);
});

test('codexPing: host not registered → install hint, not a raw error', async () => {
  const { codexPing } = await freshClient();
  const bridge = new FakeBridge();
  bridge.start(() => {});
  setTimeout(() => bridge.die('Access to the specified native messaging host is forbidden'), 5);
  await assert.rejects(() => codexPing(), /桥接未安装/);
});

// ---------------------------------------------------------------------------
// buildCodexTurn (message assembly; no images in v1 — see chat-handler comment)

test('buildCodexTurn: forwards trailing page context, keeps images local, dedups nothing else', async () => {
  const { buildCodexTurn } = await import('../lib/handlers/chat-handler.js');
  const { PAGE_CONTEXT_PREFIX } = await import('../lib/constants.js');
  const ctx = PAGE_CONTEXT_PREFIX + '# Page\n\ncontent';

  // Plain text only. (Returns the message string directly — Codex has no
  // attachment channel, unlike buildSquillaTurn's {message, attachments}.)
  assert.equal(buildCodexTurn({ userText: 'hi' }, '', []), 'hi');

  // Latest-turn page context is forwarded with the anti-fetch directive.
  const withCtx = buildCodexTurn({ userText: '总结' }, '请始终用中文回答。', [{ role: 'user', content: ctx }]);
  assert.ok(withCtx.startsWith(ctx));
  assert.ok(withCtx.includes('不要重新访问或抓取'));
  assert.ok(withCtx.endsWith('总结'));

  // Array-part context (text + images): text joined, images NOT converted to
  // attachments (Codex v1 carries no attachment channel in browsa).
  const arr = buildCodexTurn({ userText: 'q' }, '', [
    { role: 'user', content: [{ type: 'text', text: ctx }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } }] },
  ]);
  assert.ok(arr.startsWith(ctx));

  // Earlier Q&A stops the context walk — no page re-send.
  const stopped = buildCodexTurn({ userText: 'q' }, '', [
    { role: 'user', content: '普通提问' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: ctx },
    { role: 'assistant', content: '页答' },
  ]);
  assert.equal(stopped, 'q');
});
