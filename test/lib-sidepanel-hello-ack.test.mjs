// test/lib-sidepanel-hello-ack.test.mjs — waitForStreamHelloAck 的超时清理回归
// （2026-11-03 审计）。旧实现超时只 resolve、不移除 once 监听：迟到的 ACK 会在
// await 已返回后才触发 onAck（时序倒置）；onSend 又只在 onAck 里挂 chunk 监听，
// 超时路径整轮回复丢失。修复：超时移除 once；onSend 幂等补挂（见 sidepanel.js）。
// 这里抽出函数真实执行，钉住握手本身的可观测行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../sidepanel.js', import.meta.url), 'utf8');
function extractFn(name) {
  const m = src.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`));
  assert.ok(m, `${name} found`);
  let i = m.index + m[0].length;
  let depth = 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(m.index, i);
}
const fnSrc = extractFn('waitForStreamHelloAck');

function makePort() {
  const listeners = new Set();
  return {
    posted: [],
    onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    postMessage(m) { this.posted.push(m); },
    deliver(m) { for (const fn of [...listeners]) fn(m); },
    listenerCount: () => listeners.size,
  };
}
test('ACK arrives: onAck fires once, promise resolves, listener removed', async () => {
  const port = makePort();
  let acks = 0;
  const listeners = new Set();
  port.onMessage = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  port.deliver = (m) => { for (const fn of [...listeners]) fn(m); };
  let timeoutCb = null;
  const ctx = vm.createContext({ setTimeout: (fn) => { timeoutCb = fn; return 1; }, clearTimeout: () => { timeoutCb = null; }, port, opts: { onAck: () => { acks++; } } });
  const p = vm.runInContext(`${fnSrc}\nwaitForStreamHelloAck(port, 7, opts);`, ctx);
  assert.equal(port.posted[0].type, 'STREAM_HELLO');
  port.deliver({ type: 'STREAM_HELLO_ACK' });
  await p;
  assert.equal(acks, 1, 'onAck fired on ACK');
  assert.equal(listeners.size, 0, 'once listener removed after ACK');
  assert.equal(timeoutCb, null, 'timeout cleared after ACK');
});

test('timeout: resolves and removes the once listener so a late ACK cannot fire onAck', async () => {
  const port = makePort();
  let acks = 0;
  const listeners = new Set();
  port.onMessage = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  port.deliver = (m) => { for (const fn of [...listeners]) fn(m); };
  let timeoutCb = null;
  const ctx = vm.createContext({ setTimeout: (fn) => { timeoutCb = fn; return 1; }, clearTimeout: () => { timeoutCb = null; }, port, opts: { onAck: () => { acks++; } } });
  const p = vm.runInContext(`${fnSrc}\nwaitForStreamHelloAck(port, 7, opts);`, ctx);
  assert.equal(typeof timeoutCb, 'function', 'a safety-net timeout is armed');
  timeoutCb(); // 500ms 到，ACK 仍未到
  await p;
  assert.equal(acks, 0, 'no ACK → onAck not fired');
  assert.equal(listeners.size, 0, 'timeout must remove the once listener');
  port.deliver({ type: 'STREAM_HELLO_ACK' }); // 迟到 ACK
  assert.equal(acks, 0, 'late ACK must not fire onAck after the await returned (listener gone)');
});

test('resume:true rides the HELLO; default omits it', async () => {
  for (const [opts, expected] of [[{ resume: true }, true], [{}, false]]) {
    const port = makePort();
    let timeoutCb = null;
    const ctx = vm.createContext({ setTimeout: (fn) => { timeoutCb = fn; return 1; }, clearTimeout: () => {}, port, opts });
    const p = vm.runInContext(`${fnSrc}\nwaitForStreamHelloAck(port, 7, opts);`, ctx);
    assert.equal(!!port.posted[0].resume, expected);
    port.deliver({ type: 'STREAM_HELLO_ACK' });
    await p;
  }
});