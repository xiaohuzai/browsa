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
  for (const k of Object.keys(stored)) if (k.startsWith('session_')) delete stored[k];
  clearStreamState(tabId);
  if (extra) initStreamState(tabId, extra);
}

test('persistTurnEntry: a watched stream writes the LIVE history', async () => {
  reset('t1', { originSessionId: 's1' });
  // Seed the NEW split-key layout directly (light index + body key): the
  // watched path never touches sessions at all, so nothing migrates here.
  stored.savedSessions = [{ id: 's1', name: 'A', createdAt: 1, pinned: false, textDigest: 'q' }];
  stored['session_s1'] = [{ role: 'user', content: 'q' }];
  await persistTurnEntry('t1', { role: 'assistant', content: 'reply' });
  assert.deepEqual(stored.history.map((m) => m.content), ['reply']);
  // 批E split-key layout: the snapshot body lives in its own session_<id> key
  // (the seeded legacy index entry migrates on first access).
  assert.equal(stored['session_s1'].length, 1, 'the snapshot must not grow while the panel watches');
});

test('persistTurnEntry: a backgrounded stream writes its ORIGIN session snapshot', async () => {
  reset('t2', { originSessionId: 's1' });
  streamState.get('t2').bg = true; // switched away mid-turn
  stored.savedSessions = [{ id: 's1', name: 'A', history: [{ role: 'user', content: 'q' }] }];
  stored.history = [{ role: 'user', content: 'the OTHER conversation' }];
  await persistTurnEntry('t2', { role: 'assistant', content: 'bg reply' });
  assert.deepEqual(stored['session_s1'].map((m) => m.content), ['q', 'bg reply'], 'the reply joins its own session');
  assert.deepEqual(stored.history.map((m) => m.content), ['the OTHER conversation'], 'the switched-to conversation is untouched');
});

test('persistTurnEntry: a deleted origin session is RESCUED, never leaked into live history', async () => {
  // 2026-10-17 裁决修正: the old fallback appended the reply to LIVE history —
  // writing it into whatever conversation the user had switched TO, which is
  // exactly the cross-session leak bg routing exists to prevent. Dropping the
  // turn instead would contradict "never silently drop a turn". The rescue
  // recreates the origin session under its id, so BOTH hold: the text is
  // preserved and the visible conversation is untouched.
  reset('t3', { originSessionId: 'gone' });
  streamState.get('t3').bg = true;
  stored.history = [{ role: 'user', content: 'the OTHER conversation' }];
  const res = await persistTurnEntry('t3', { role: 'assistant', content: 'orphan' });
  assert.equal(res.toSession, true, 'the rescued entry belongs to its origin session, not live history');
  assert.deepEqual(stored.history.map((m) => m.content), ['the OTHER conversation'],
    'the conversation on screen must not receive another conversation\'s reply');
  assert.deepEqual(stored['session_gone'].map((m) => m.content), ['orphan'],
    'the turn is preserved in a recreated origin session');
  const index = stored.savedSessions.find((s) => s.id === 'gone');
  assert.ok(index?.name, 'the recovered session is listed in the drawer with a recognizable name');
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
  assert.equal(stored['session_s1'][0].interrupted, true);
});
