// test/lib-persist-turn-routing.test.mjs — session-switch background streams
// (2026-09-24): a turn entry lands where the turn's conversation LIVES.
//
// Routing rule under test: live history while the panel watches the stream
// (`bg` false), the ORIGIN session's snapshot once backgrounded — never the
// conversation the user switched to. Plus the pushChunk background gate
// (other conversations' replies must not render on screen) and the
// interrupted-turn salvage's writer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const stored = { history: [], savedSessions: [] };
globalThis.chrome = {
  runtime: {},
  storage: {
    local: {
      get: async (key) => {
        if (key === null) return { ...stored };
        const keys = typeof key === 'string' ? [key] : key;
        const out = {};
        for (const k of keys) if (k in stored) out[k] = stored[k];
        return out;
      },
      set: async (obj) => { Object.assign(stored, obj); },
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

const { persistTurnEntry } = await import('../lib/handlers/chat-handler.js');
const { initStreamState, clearStreamState, streamState, pushChunk, streamPorts } = await import('../lib/state.js');

function reset(tabId, extra) {
  stored.history = [];
  stored.savedSessions = [];
  clearStreamState(tabId);
  if (extra) initStreamState(tabId, extra);
}

test('persistTurnEntry: a watched stream writes the LIVE history', async () => {
  reset('t1', { originSessionId: 's1' });
  stored.savedSessions = [{ id: 's1', name: 'A', history: [{ role: 'user', content: 'q' }] }];
  await persistTurnEntry('t1', { role: 'assistant', content: 'reply' });
  assert.deepEqual(stored.history.map((m) => m.content), ['reply']);
  assert.equal(stored.savedSessions[0].history.length, 1, 'the snapshot must not grow while the panel watches');
});

test('persistTurnEntry: a backgrounded stream writes its ORIGIN session snapshot', async () => {
  reset('t2', { originSessionId: 's1' });
  streamState.get('t2').bg = true; // switched away mid-turn
  stored.savedSessions = [{ id: 's1', name: 'A', history: [{ role: 'user', content: 'q' }] }];
  stored.history = [{ role: 'user', content: 'the OTHER conversation' }];
  await persistTurnEntry('t2', { role: 'assistant', content: 'bg reply' });
  assert.deepEqual(stored.savedSessions[0].history.map((m) => m.content), ['q', 'bg reply'], 'the reply joins its own session');
  assert.deepEqual(stored.history.map((m) => m.content), ['the OTHER conversation'], 'the switched-to conversation is untouched');
});

test('persistTurnEntry: backgrounded with a deleted origin session falls back to the live append', async () => {
  reset('t3', { originSessionId: 'gone' });
  streamState.get('t3').bg = true;
  await persistTurnEntry('t3', { role: 'assistant', content: 'orphan' });
  assert.deepEqual(stored.history.map((m) => m.content), ['orphan'], 'never silently drop a turn');
});

test('pushChunk: backgrounded streams stay silent except approval/clarify', async () => {
  reset('t4', { originSessionId: 's1' });
  const posted = [];
  streamPorts.set('t4', { postMessage: (p) => posted.push(p) });
  const st = streamState.get('t4');
  st.bg = true;
  pushChunk('t4', { type: 'CHUNK', delta: 'x' });
  pushChunk('t4', { type: 'DONE', full: 'y' });
  assert.deepEqual(posted, [], "another conversation must not render this stream");
  st.bg = false;
  pushChunk('t4', { type: 'CHUNK', delta: 'x' });
  assert.equal(posted.length, 1, 're-attached streams render again');
  st.bg = true;
  pushChunk('t4', { type: 'APPROVAL', data: {} });
  assert.equal(posted.length, 2, 'a blocked tool call must reach the human whatever is on screen');
  streamPorts.delete('t4');
});

test('interrupted-turn salvage shape persists via the same writer (interrupted flag)', async () => {
  reset('t5', { originSessionId: 's1' });
  streamState.get('t5').bg = true;
  stored.savedSessions = [{ id: 's1', name: 'A', history: [] }];
  await persistTurnEntry('t5', { role: 'assistant', content: 'half a thought', interrupted: true });
  assert.equal(stored.savedSessions[0].history[0].interrupted, true);
});
