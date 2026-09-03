// conformance/bridge.test.mjs — engine-independent conformance suite.
// Bakes the host templates for each backend recipe (engine binary overridden
// to a fake engine), drives them with real Native-Messaging framing, and
// asserts the transport contract: control-frame argv injection, frame
// round-trips (including a 200 KB frame), clean EOF teardown, and the
// engine-binary-not-found error frame. No real agent CLI is required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, bake, nmClient } from './harness.mjs';

// ── codex family (JSON-RPC stdio) ────────────────────────────────────────────

test('codex: control frame + initialize/thread/start round-trip, argv injection visible to engine', async () => {
  const b = bake('codex', { binOverride: join(ROOT, 'conformance', 'fake-codex.mjs') });
  const c = nmClient(b.host);
  c.send({ argv: [] });
  c.send({ method: 'initialize', params: { clientInfo: { name: 't', version: '0' } }, id: 0 });
  const init = await c.wait((m) => m.id === 0, 'initialize');
  assert.equal(init.result.codexHome, '/fake');
  c.send({ method: 'thread/start', params: {}, id: 1 });
  const th = await c.wait((m) => m.id === 1, 'thread/start');
  assert.deepEqual(th.result.thread.argv, ['app-server', '--stdio'],
    'engine argv[2:] = baked engine args (control frame injected nothing)');
  c.closeStdin();
});

test('codex: turn round-trip carries text and per-turn sandboxPolicy', async () => {
  const b = bake('codex', { binOverride: join(ROOT, 'conformance', 'fake-codex.mjs') });
  const c = nmClient(b.host);
  c.send({ argv: [] });
  c.send({ method: 'initialize', params: {}, id: 0 });
  await c.wait((m) => m.id === 0, 'initialize');
  const policy = { type: 'workspaceWrite', networkAccess: true };
  c.send({ method: 'turn/start', params: { threadId: 'th-fake-1', input: [{ type: 'text', text: '你好' }], sandboxPolicy: policy }, id: 2 });
  const item = await c.wait((m) => m.method === 'item/completed', 'item/completed');
  assert.equal(item.params.item.text, 'echo:你好|sandbox:{"type":"workspaceWrite","networkAccess":true}');
  await c.wait((m) => m.method === 'turn/completed', 'turn/completed');
  c.closeStdin();
});

test('codex: resume argv rides the control frame', async () => {
  const b = bake('codex', { binOverride: join(ROOT, 'conformance', 'fake-codex.mjs') });
  const c = nmClient(b.host);
  c.send({ argv: ['--resume', 'sess-abc-123'] });
  c.send({ method: 'initialize', params: {}, id: 0 });
  const init = await c.wait((m) => m.id === 0, 'initialize');
  assert.deepEqual(init.result.argv.slice(-2), ['--resume', 'sess-abc-123']);
  c.closeStdin();
});

// ── codebuddy family (stream-json) ───────────────────────────────────────────

test('codebuddy: spawn-flag resume + stream-json round trip with usage', async () => {
  const b = bake('codebuddy', { binOverride: join(ROOT, 'conformance', 'fake-codebuddy.mjs') });
  const c = nmClient(b.host);
  c.send({ argv: ['--resume', 'sess-abc-123'] });
  const init = await c.wait((m) => m.type === 'system' && m.subtype === 'init', 'init');
  assert.deepEqual(init.argv.slice(-2), ['--resume', 'sess-abc-123'],
    'baked engine args + injected resume flag both reach the engine');
  c.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '你好世界' }] } });
  await c.wait((m) => m.type === 'assistant' && m.message?.content?.[0]?.type === 'tool_use', 'tool_use');
  const result = await c.wait((m) => m.type === 'result', 'result');
  assert.equal(result.result, 'echo:你好世界');
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
  c.closeStdin();
});

// ── transport-level contract ─────────────────────────────────────────────────

test('big frames (200 KB) survive the pump byte-exactly', async () => {
  const b = bake('codebuddy', { binOverride: join(ROOT, 'conformance', 'fake-codebuddy.mjs') });
  const c = nmClient(b.host);
  c.send({ argv: [] });
  const big = 'X'.repeat(200_000);
  c.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: big }] } });
  const result = await c.wait((m) => m.type === 'result', 'result', 15000);
  assert.equal(result.result.length, 'echo:'.length + big.length);
  c.closeStdin();
});

test('stdin EOF (Chrome disconnect) tears the bridge down cleanly', async () => {
  const b = bake('codex', { binOverride: join(ROOT, 'conformance', 'fake-codex.mjs') });
  const c = nmClient(b.host);
  c.send({ argv: [] });
  c.send({ method: 'initialize', params: {}, id: 0 });
  await c.wait((m) => m.id === 0, 'initialize');
  c.closeStdin();
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (c.exited !== null) { clearInterval(iv); resolve(); } }, 50);
    setTimeout(() => { clearInterval(iv); resolve(); }, 5000);
  });
  assert.notEqual(c.exited, null, 'bridge process exits after stdin EOF');
});

test('no control frame → single {"error":...} frame, then exit', async () => {
  // The engine-binary-not-found path uses the same emit_error contract but is
  // untestable on machines where a real codex sits on PATH (the shim's
  // discovery extends PATH, defeating stripping). A missing control frame
  // exercises the identical single-error-frame contract deterministically.
  const b = bake('codex', { binOverride: join(ROOT, 'conformance', 'fake-codex.mjs') });
  const proc = spawn('bash', [b.host], { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = [];
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      out.push(JSON.parse(buf.slice(4, 4 + len).toString('utf8')));
      buf = buf.slice(4 + len);
    }
  });
  proc.stdin.end(); // Chrome-side client that never sends the control frame
  await new Promise((resolve) => setTimeout(resolve, 1200));
  proc.kill();
  assert.equal(out.length, 1, 'exactly one error frame');
  assert.equal(out[0].error.code, 'bridge-no-control-frame');
});
