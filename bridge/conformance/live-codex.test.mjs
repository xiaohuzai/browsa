// conformance/live-codex.test.mjs — the REAL engine, not a fake.
//
// `npm test` proves the transport contract against scripted fakes; this suite
// proves the codex BACKEND RECIPE (backends/codex.json) against the actual
// `codex app-server --stdio` binary found on this machine. It drives the real
// baked host shim with real NM framing and exercises exactly the methods the
// browsa client uses: initialize/initialized, thread/start, turn/start →
// streamed items → turn/completed, thread/resume (in-band session resume),
// and model/list (the options-page Ping).
//
// Skips silently when codex is not installed. The turn test costs one real
// model call and needs a working engine auth (ChatGPT login in ~/.codex or
// an env-key provider like ARK_API_KEY) — without it that test skips with the
// engine's own reason instead of failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bake, nmClient } from './harness.mjs';

// Same discovery roots as the host shim (hosts/nm-bridge.sh): PATH extensions
// + codex desktop app's managed copy.
function findCodex() {
  const roots = [
    ...['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local/bin'), join(homedir(), '.cargo/bin')],
    join(homedir(), '.codex/packages/standalone/current'),
  ];
  for (const dir of roots) {
    const p = join(dir, 'codex');
    try { if (existsSync(p)) return p; } catch { /* unreadable dir — keep looking */ }
  }
  try { return execFileSync('which', ['codex'], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

const codexBin = findCodex();
const hasLogin = existsSync(join(homedir(), '.codex/auth.json'));
const hasEnvKey = Object.keys(process.env).some((k) => /API_KEY|ARK_/i.test(k));

// When the resolved binary sits in one of the shim's own discovery roots, bake
// WITHOUT an override so the shim's PATH extension + managed-copy fallback get
// exercised for real; only fall back to baking an absolute path otherwise.
const shimDiscoveryRoots = new Set([
  join(homedir(), '.local/bin'),
  join(homedir(), '.cargo/bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  join(homedir(), '.codex/packages/standalone/current'),
]);
const binDir = codexBin ? codexBin.replace(/\/codex$/, '') : null;
const usesShimDiscovery = binDir ? shimDiscoveryRoots.has(binDir) : false;

// Handshake helper: control frame → initialize → initialized. Returns the
// initialize result. Every engine conversation starts with this exact
// sequence — the same one browsa's codex-client.js performs.
async function handshake(c, idBase = 0) {
  c.send({ argv: [] }); // control frame first — the shim's wire contract
  c.send({ method: 'initialize', params: { clientInfo: { name: 'agent-bridge-live', version: '0.0.0' } }, id: idBase });
  const init = await c.wait((m) => m.id === idBase, 'initialize', 30000);
  if (init.error) throw new Error(`initialize rejected: ${JSON.stringify(init.error)}`);
  c.send({ method: 'initialized' });
  return init.result;
}

test('live codex: shim discovers the real binary, handshake + thread/start + model/list', { skip: !codexBin && 'codex not installed on this machine' }, async () => {
  const b = bake('codex', usesShimDiscovery ? {} : { binOverride: codexBin });
  const c = nmClient(b.host);
  const init = await handshake(c);
  console.error(`  engine userAgent: ${init.userAgent} · codexHome: ${init.codexHome}`);
  assert.ok(init.codexHome, 'initialize must report codexHome');

  c.send({ method: 'thread/start', params: {}, id: 1 });
  const th = await c.wait((m) => m.id === 1, 'thread/start', 30000);
  assert.ok(th.result?.thread?.id, `thread/start returned no id: ${JSON.stringify(th)}`);

  // model/list backs browsa's codexPing — must exist on this engine version.
  c.send({ method: 'model/list', params: {}, id: 2 });
  const models = await c.wait((m) => m.id === 2, 'model/list', 30000);
  assert.ok(Array.isArray(models.result?.data) && models.result.data.length > 0,
    `model/list unusable for the Ping: ${JSON.stringify(models)}`);
  console.error(`  model/list: ${models.result.data.length} models`);
  c.closeStdin();
});

test('live codex: a real turn streams an agentMessage and the thread resumes in-band', { skip: !codexBin && 'codex not installed' }, async (t) => {
  if (!hasLogin && !hasEnvKey) {
    t.skip('no engine auth on this machine (no ~/.codex/auth.json, no API-key env) — install one to run the turn check');
    return;
  }
  const b = bake('codex', usesShimDiscovery ? {} : { binOverride: codexBin });
  const c = nmClient(b.host);
  await handshake(c);

  c.send({ method: 'thread/start', params: {}, id: 1 });
  const started = await c.wait((m) => m.id === 1, 'thread/start', 30000);
  const threadId = started.result?.thread?.id;
  assert.ok(threadId, 'thread/start returned no id');

  c.send({
    method: 'turn/start',
    params: {
      threadId,
      input: [{ type: 'text', text: 'Reply with the single word: pong' }],
    },
    id: 2,
  });
  const turnResp = await c.wait((m) => m.id === 2, 'turn/start', 30000);
  if (turnResp.error) {
    if (/Missing environment variable|API key|Unauthorized|login|auth/i.test(turnResp.error.message || '')) {
      t.skip(`engine auth not configured: ${turnResp.error.message}`);
      return;
    }
    assert.fail(`turn/start rejected: ${JSON.stringify(turnResp.error)}`);
  }

  // Wait for the terminal notification; the streamed agentMessage items land
  // as method frames while the turn/start response already arrived.
  const done = await c.wait((m) => m.method === 'turn/completed', 'turn/completed', 300000);
  const status = done.params?.turn?.status;
  if (status !== 'completed') {
    const msg = done.params?.turn?.error?.message || '(no error detail)';
    if (/Missing environment variable|API key|Unauthorized|login|auth/i.test(msg)) {
      t.skip(`engine auth not configured: ${msg}`);
      return;
    }
    assert.fail(`turn ended with status=${status}: ${msg}`);
  }
  const texts = c.frames
    .filter((m) => m.method === 'item/completed' && m.params?.item?.type === 'agentMessage')
    .map((m) => m.params.item.text);
  console.error(`  turn output: ${JSON.stringify(texts).slice(0, 200)}`);
  assert.ok(texts.some((x) => /pong/i.test(x || '')), 'agentMessage should contain the requested reply');

  // End the first connection BEFORE resuming: Chrome kills the bridge on port
  // disconnect, so a resumed turn in browsa always starts a fresh engine —
  // and a live first engine holds SQLite state locks that can stall the
  // second instance's startup (observed on this machine).
  c.closeStdin();
  await new Promise((r) => setTimeout(r, 1500));

  // In-band session resume — codex.json's resumeMode. A fresh app-server
  // process must accept the same thread id.
  const c2 = nmClient(b.host);
  await handshake(c2);
  c2.send({ method: 'thread/resume', params: { threadId }, id: 1 });
  const resumed = await c2.wait((m) => m.id === 1, 'thread/resume', 30000);
  if (resumed.error) assert.fail(`thread/resume rejected: ${JSON.stringify(resumed.error)}`);
  assert.equal(resumed.result?.thread?.id, threadId, 'resumed thread must keep its id');
  c2.closeStdin();
});

test('live codex: resume of a bogus thread id fails cleanly (JSON-RPC error, no crash)', { skip: !codexBin && 'codex not installed' }, async () => {
  const b = bake('codex', usesShimDiscovery ? {} : { binOverride: codexBin });
  const c = nmClient(b.host);
  await handshake(c);
  c.send({ method: 'thread/resume', params: { threadId: 'th-does-not-exist-xyz' }, id: 1 });
  const resp = await c.wait((m) => m.id === 1, 'thread/resume', 30000);
  assert.ok(resp.error, 'bogus resume must return an error, not silence');
  console.error(`  bogus resume error: ${JSON.stringify(resp.error).slice(0, 160)}`);
  // The bridge must stay alive after an engine-level error — a later request
  // on the same connection still works (browsa relies on this for the
  // stale-thread fallback path).
  c.send({ method: 'thread/start', params: {}, id: 2 });
  const th = await c.wait((m) => m.id === 2, 'thread/start after error', 30000);
  assert.ok(th.result?.thread?.id, 'connection still usable after an engine error');
  c.closeStdin();
});
