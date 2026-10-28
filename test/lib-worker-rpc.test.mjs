// test/lib-worker-rpc.test.mjs — behavior tests for createWorkerRpc(), the
// shared worker request/reply state machine behind the pdf and office
// clients (lib/sidepanel/worker-rpc.js). The two clients used to carry
// byte-twin copies of ensureWorker/queue/timeout bookkeeping; this factory is
// the single implementation. Real reply matching semantics are pinned in
// test/lib-worker-pending-match.test.mjs; here we pin the wrapper: id
// correlation, timeout→null, sticky workerFailed, transfer lists, and the
// protocol-external post() (pdf warmup) + idle-reset hooks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = { runtime: { getURL: (p) => 'chrome-extension://fake/' + p } };

// Fake worker whose replies can be scripted per instance.
function installFakeWorker() {
  const instances = [];
  class FakeWorker {
    constructor() {
      this._listeners = { message: [], error: [] };
      this.posted = [];
      instances.push(this);
    }
    addEventListener(type, fn) { this._listeners[type].push(fn); }
    postMessage(data, transfer) {
      this.posted.push({ data, transfer });
      // echo the payload back, tagged with ok — WITH the requestId, matching
      // the real worker scripts' reply shape.
      for (const fn of this._listeners.message) fn({ data: { ...data, ok: true, echoed: true } });
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  return instances;
}

function freshRpc(opts) {
  return import('../lib/sidepanel/worker-rpc.js?t=' + Math.random()).then(({ createWorkerRpc }) =>
    createWorkerRpc({ workerUrl: () => 'chrome-extension://fake/w.js', timeoutMs: 30, label: 'test', ...opts }));
}

test('call() posts the message plus a correlation id and resolves the reply minus the id', async () => {
  const instances = installFakeWorker();
  const rpc = await freshRpc();
  const res = await rpc.call({ bytes: 'B', options: {} });
  assert.equal(res.ok, true);
  assert.equal(res.echoed, true);
  assert.equal(res.requestId, undefined, 'reply envelope must be resolved WITHOUT the correlation id');
  assert.equal(instances[0].posted[0].data.requestId, 1, 'first request gets correlation id 1');
  const res2 = await rpc.call({ bytes: 'C' });
  assert.equal(instances[0].posted[1].data.requestId, 2, 'ids increment per request');
  assert.equal(res2.ok, true);
});

test('a reply is matched BY id: an out-of-order reply resolves its own caller', async () => {
  const instances = installFakeWorker();
  const rpc = await freshRpc();
  rpc.ensure(); // materialize the worker before suppressing its auto-echo
  const wk = instances[0];
  wk.postMessage = (data) => { wk.posted.push({ data }); };
  const p1 = rpc.call({ n: 1 });
  const p2 = rpc.call({ n: 2 });
  // Reply to request 2 FIRST.
  for (const fn of wk._listeners.message) fn({ data: { requestId: 2, ok: true, which: 'two' } });
  for (const fn of wk._listeners.message) fn({ data: { requestId: 1, ok: true, which: 'one' } });
  assert.equal((await p1).which, 'one');
  assert.equal((await p2).which, 'two');
});

test('timeout resolves null and a later reply for that id is dropped, not re-queued', async () => {
  const instances = installFakeWorker();
  const rpc = await freshRpc({ timeoutMs: 20 });
  rpc.ensure();
  const wk = instances[0];
  wk.postMessage = (data) => { wk.posted.push({ data }); };
  const p = rpc.call({ n: 1 });
  assert.equal(await p, null, 'timed-out request resolves null (caller fail-opens)');
  // The late reply arrives after the timeout — the next queued request must NOT receive it.
  const p2 = rpc.call({ n: 2 });
  for (const fn of wk._listeners.message) fn({ data: { requestId: 1, ok: true, stale: true } });
  wk.postMessage = null; // restore nothing; reply for id 2 manually
  for (const fn of wk._listeners.message) fn({ data: { requestId: 2, ok: true, fresh: true } });
  const r2 = await p2;
  assert.equal(r2.fresh, true, 'next request still gets its own reply');
  assert.equal(r2.stale, undefined);
});

test('worker construction failure is sticky: null forever after, per instance', async () => {
  const prevWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { throw new Error('no worker for you'); } };
  try {
    const rpc = await freshRpc();
    assert.equal(await rpc.call({ n: 1 }), null);
    assert.equal(await rpc.call({ n: 2 }), null, 'second call must not retry construction');
    assert.equal(rpc.ensure(), null);
    // worker 从未构造成功 → reset() 是 no-op（与 office 空闲释放的守卫一致：
    // 只在真 worker 存在时授予新机会），构造失败保持粘性。
    rpc.reset();
    assert.equal(rpc.ensure(), null, 'construction failure stays sticky');
  } finally {
    globalThis.Worker = prevWorker;
  }
});

test('worker error event flips the sticky flag but leaves queued state consistent', async () => {
  const instances = installFakeWorker();
  const rpc = await freshRpc();
  rpc.ensure();
  const wk = instances[0];
  wk.postMessage = () => {};
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    for (const fn of wk._listeners.error) fn(new Error('boom'));
    assert.equal(await rpc.call({ n: 1 }), null, 'after an error event, calls resolve null');
    assert.match(warnings.join('\n'), /worker error/);
  } finally {
    console.warn = origWarn;
  }
});

test('transfer option moves the byte buffer; default posts without a transfer list', async () => {
  const instances = installFakeWorker();
  const rpc = await freshRpc();
  const bytes = new Uint8Array([1, 2, 3]);
  await rpc.call({ bytes }, { transfer: true });
  assert.deepEqual(instances.at(-1).posted.at(-1).transfer, [bytes.buffer], 'transfer:true moves the buffer');
  await rpc.call({ bytes });
  assert.deepEqual(instances.at(-1).posted.at(-1).transfer, [], 'default transfer list is empty');
  const notBytes = { blob: new Uint8Array([1]) };
  await rpc.call(notBytes, { transfer: true });
  assert.deepEqual(instances.at(-1).posted.at(-1).transfer, [], 'no .bytes → no transfer list');
});

test('post() sends a protocol-external message (warmup) without queue bookkeeping', async () => {
  const instances = installFakeWorker();
  const rpc = await freshRpc();
  rpc.post({ type: 'warmup', wasmUrl: 'w' });
  assert.equal(instances[0].posted[0].data.type, 'warmup');
  assert.equal(instances[0].posted[0].data.requestId, undefined, 'warmup carries no correlation id');
  await rpc.call({ n: 1 });
  assert.equal(instances[0].posted[1].data.requestId, 1, 'warmup must not consume a correlation id');
});

test('isIdle/reset back the office idle-release policy', async () => {
  const instances = installFakeWorker();
  const rpc = await freshRpc();
  assert.equal(rpc.isIdle(), true);
  rpc.ensure();
  const wk = instances[0];
  wk.postMessage = () => {};
  const pending = rpc.call({ n: 1 });
  assert.equal(rpc.isIdle(), false, 'in-flight request → not idle');
  for (const fn of wk._listeners.message) fn({ data: { requestId: 1, ok: true } });
  await pending;
  assert.equal(rpc.isIdle(), true);
  rpc.reset();
  assert.equal(wk.terminated, true, 'reset terminates the worker');
  assert.notEqual(rpc.ensure(), instances[0], 'next ensure builds a fresh worker');
});
