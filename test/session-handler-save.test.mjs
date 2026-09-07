// test/session-handler-save.test.mjs — SAVE_SESSION's write-back dispatch:
// msg.id (activeSessionId) updates the existing session IN PLACE; a missing
// or stale (deleted) id falls back to archiving a new session. This is the
// fix for "every drawer click forks a duplicate session" — the handler is the
// branch point, the storage functions underneath have their own tests in
// test/storage.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeStorageArea() {
  let store = {};
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
    async set(obj) {
      store = { ...store, ...obj };
    },
    _reset() { store = {}; },
    _dump() { return store; }
  };
}

const localArea = makeStorageArea();
Object.defineProperty(globalThis, 'chrome', {
  value: { storage: { local: localArea, session: makeStorageArea() } },
  writable: true,
  configurable: true,
});

const storage = await import('../lib/storage.js');
const { handleSession } = await import('../lib/handlers/session-handler.js');

function reset() {
  localArea._reset();
}

test('SAVE_SESSION without an id archives a NEW session (fresh-conversation safety net)', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'a' }]);
  const res = await handleSession({ type: 'SAVE_SESSION' });
  assert.equal(res.ok, true);
  assert.ok(res.session.id, 'a fresh conversation gets a brand-new session id');
  assert.equal((await storage.getSavedSessions()).length, 1);
});

test('SAVE_SESSION with the active id writes back IN PLACE — no fork, latest history wins', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'v1' }]);
  const s1 = await handleSession({ type: 'SAVE_SESSION' });
  assert.ok(s1.session.id);

  // Conversation continues after being loaded, then the user clicks another
  // session in the drawer → SAVE_SESSION carries the active id.
  await storage.setHistory([{ role: 'user', content: 'v1' }, { role: 'assistant', content: 'v2' }]);
  const res = await handleSession({ type: 'SAVE_SESSION', id: s1.session.id });

  assert.equal(res.session.id, s1.session.id, 'must write back into the SAME session');
  const list = await storage.getSavedSessions();
  assert.equal(list.length, 1, 'write-back must NOT grow the list');
  const full = await storage.getSessionFull(s1.session.id);
  assert.deepEqual(full.history.map(m => m.content), ['v1', 'v2'], 'snapshot must be the latest live history');
});

test('SAVE_SESSION with a stale (deleted) id falls back to archiving a NEW session', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'a' }]);
  const s1 = await handleSession({ type: 'SAVE_SESSION' });
  await storage.deleteSession(s1.session.id); // user deleted it from the drawer meanwhile

  await storage.setHistory([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  const res = await handleSession({ type: 'SAVE_SESSION', id: s1.session.id });

  assert.ok(res.session.id && res.session.id !== s1.session.id, 'unknown id → new archive, nothing lost');
  const list = await storage.getSavedSessions();
  assert.equal(list.length, 1);
  assert.deepEqual((await storage.getSessionFull(res.session.id)).history.map(m => m.content), ['a', 'b']);
});
