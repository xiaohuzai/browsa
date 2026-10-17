// test/approval-relay-contracts.test.mjs — the relay contract the 2026-10-17
// audit found unpinned: a relay POST must have a timeout (an unresponsive
// server used to hang the panel's sendMessage for minutes) and a non-2xx must
// carry the server's reason instead of a bare ok:false.
//
// approval-relay.js had NO direct test before this file: the existing
// approval-clarify tests drive the handle() path with stubbed relays, so the
// relay module's own fetch behavior was never exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { relayApproval, relayClarify } = await import('../lib/handlers/approval-relay.js');

const pending = { kind: 'hermes', baseUrl: 'http://test', runId: 'run-1', approvalId: 'ap-1' };

test('relayApproval: a 2xx returns ok', async () => {
  globalThis.fetch = async (url, init) => {
    assert.match(url, /\/v1\/runs\/run-1\/approval$/);
    assert.ok(init.signal, 'the relay POST must carry an abort signal (timeout)');
    assert.equal(JSON.parse(init.body).approval_id, 'ap-1');
    return { ok: true, status: 200, text: async () => '' };
  };
  assert.deepEqual(await relayApproval(pending, 'once'), { ok: true });
});

test('relayApproval: a non-2xx surfaces the server reason, not a bare ok:false', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 409, text: async () => 'approval already resolved' });
  const res = await relayApproval(pending, 'deny');
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /already resolved/, 'the server body must reach the caller so the card can explain itself');
});

test('relayClarify: same timeout + error-detail contract', async () => {
  let signalSeen = false;
  globalThis.fetch = async (_url, init) => {
    signalSeen = !!init?.signal;
    return { ok: false, status: 500, text: async () => 'gateway exploded' };
  };
  const res = await relayClarify(
    { kind: 'hermes', baseUrl: 'http://test', runId: 'run-1', clarifyId: 'cl-1' },
    'answer'
  );
  assert.ok(signalSeen, 'clarify relay must also carry a timeout signal');
  assert.equal(res.ok, false);
  assert.match(res.error, /gateway exploded/);
});

test('relayClarify: a body-less non-2xx still yields an actionable message', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
  const res = await relayClarify(
    { kind: 'hermes', baseUrl: 'http://test', runId: 'r', clarifyId: 'c' },
    'x'
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 503/);
});
