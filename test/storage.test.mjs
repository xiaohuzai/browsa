// test/storage.test.mjs
// lib/storage.js had zero dedicated test coverage despite being the
// module nearly every feature (chat history, sessions, providers, mask
// rules, conversation IDs) depends on. This mocks chrome.storage.local
// and chrome.storage.session as simple in-memory stores and exercises
// storage.js's exported functions directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_CONTEXT_PREFIX } from '../lib/constants.js';

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
const sessionArea = makeStorageArea();

Object.defineProperty(globalThis, 'chrome', {
  value: { storage: { local: localArea, session: sessionArea } },
  writable: true,
  configurable: true,
});

const storage = await import('../lib/storage.js');

// Each test resets both storage areas so tests don't leak state into each other.
function reset() {
  localArea._reset();
  sessionArea._reset();
}

// --------------- getAll() ----------------------------------------------------

test('getAll() returns full defaults when storage is empty', async () => {
  reset();
  const all = await storage.getAll();
  assert.equal(all.activeProvider, 'hermes');
  assert.deepEqual(all.history, []);
  assert.equal(all.contextMode, 'auto');
  assert.ok(all.providers.hermes, 'default hermes provider must be present');
  assert.equal(all.providers.hermes.alias, 'Hermes Agent', 'the built-in agent provider is named Hermes Agent');
  assert.equal(all.providers.compatible, undefined, 'no OpenAI-compatible preset — LLM providers are user-added');
  assert.equal(all.providers.anthropic, undefined, 'no Anthropic preset — LLM providers are user-added');
  assert.equal(all.providers['llm-1'], undefined, 'no default LLM card — the LLM group starts empty and is filled via Add Provider');
});

test('getAll() does not resurrect a deleted LLM provider (empty LLM group stays empty)', async () => {
  reset();
  // Simulate a user who deleted every LLM card: storage holds only hermes.
  await localArea.set({ providers: { hermes: { baseUrl: 'http://h' } } });
  const all = await storage.getAll();
  const llmNames = Object.entries(all.providers).filter(([, p]) => (p.type || 'llm') === 'llm').map(([k]) => k);
  assert.deepEqual(llmNames, [], 'deleted LLM providers must stay deleted across reloads');
});

test('getAll() deep-merges a stored provider with defaults (new fields survive old saved configs)', async () => {
  reset();
  // Simulate a provider saved before `temperature`/`maxTokens` existed.
  await localArea.set({ providers: { hermes: { baseUrl: 'http://custom:1234', apiKey: 'sk-x' } } });
  const all = await storage.getAll();
  assert.equal(all.providers.hermes.baseUrl, 'http://custom:1234', 'stored override must win');
  assert.equal(all.providers.hermes.apiKey, 'sk-x');
  assert.equal(all.providers.hermes.type, 'agent', 'default field missing from stored object must survive the merge');
  assert.equal(all.providers.hermes.maxTokens, 0, 'default maxTokens must survive since stored config predates it');
});

test('getAll() preserves a user-added provider not present in DEFAULTS', async () => {
  reset();
  await localArea.set({ providers: { myLocalLlm: { type: 'llm', baseUrl: 'http://localhost:11434' } } });
  const all = await storage.getAll();
  assert.ok(all.providers.myLocalLlm, 'custom provider must not be dropped by the merge');
  assert.equal(all.providers.myLocalLlm.baseUrl, 'http://localhost:11434');
  // Built-in defaults must still be present alongside the custom one.
  assert.ok(all.providers.hermes);
});

// --------------- history: get / set / append / trim --------------------------

test('setHistory trims to the most recent MAX_HISTORY (60) entries', async () => {
  reset();
  const messages = Array.from({ length: 70 }, (_, i) => ({ role: 'user', content: `msg${i}` }));
  await storage.setHistory(messages);
  const history = await storage.getHistory();
  assert.equal(history.length, 60);
  assert.equal(history[0].content, 'msg10', 'the oldest 10 of 70 must be dropped');
  assert.equal(history[59].content, 'msg69');
});

test('setHistory trims oldest-first once the char budget is exceeded', async () => {
  reset();
  const big = 'x'.repeat(150_000);
  const messages = [
    { role: 'user', content: big },
    { role: 'assistant', content: big },
    { role: 'user', content: big }, // total 450_000 > 300_000 budget
  ];
  await storage.setHistory(messages);
  const history = await storage.getHistory();
  assert.equal(history.length, 2, 'oldest message must be dropped to fit under MAX_TOTAL_CHARS');
  assert.equal(history[0].content, big);
  assert.equal(history[1].content, big);
});

test('setHistory never drops below 1 entry even if a single message exceeds the char budget', async () => {
  reset();
  const huge = 'x'.repeat(400_000);
  await storage.setHistory([{ role: 'user', content: huge }]);
  const history = await storage.getHistory();
  assert.equal(history.length, 1, 'a lone oversized message must be kept, not dropped to zero');
});

test('setHistory only counts text parts of multimodal content, not image data', async () => {
  reset();
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200_000) } }
    ]
  }];
  await storage.setHistory(messages);
  const history = await storage.getHistory();
  assert.equal(history.length, 1, 'image payload must not count toward the char budget and cause eviction');
});

test('appendToHistory pushes onto existing history (sequential calls)', async () => {
  reset();
  await storage.appendToHistory({ role: 'user', content: 'first' });
  await storage.appendToHistory({ role: 'assistant', content: 'second' });
  const history = await storage.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].content, 'first');
  assert.equal(history[1].content, 'second');
});

test('clearHistory empties the history array', async () => {
  reset();
  await storage.appendToHistory({ role: 'user', content: 'x' });
  await storage.clearHistory();
  assert.deepEqual(await storage.getHistory(), []);
});

test('getHistory returns [] when the stored value is missing or malformed', async () => {
  reset();
  assert.deepEqual(await storage.getHistory(), []);
  await localArea.set({ history: 'not-an-array' });
  assert.deepEqual(await storage.getHistory(), [], 'a corrupted non-array history value must fail safe to []');
});

test('removeHistoryEntryByIndex removes exactly one entry and rejects out-of-range indices', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }]);
  const ok = await storage.removeHistoryEntryByIndex(1);
  assert.equal(ok, true);
  assert.deepEqual((await storage.getHistory()).map(m => m.content), ['a', 'c']);

  assert.equal(await storage.removeHistoryEntryByIndex(-1), false);
  assert.equal(await storage.removeHistoryEntryByIndex(99), false);
});

test('truncateHistoryFromIndex drops everything from index onward (inclusive)', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }]);
  const ok = await storage.truncateHistoryFromIndex(1);
  assert.equal(ok, true);
  assert.deepEqual((await storage.getHistory()).map(m => m.content), ['a']);
  assert.equal(await storage.truncateHistoryFromIndex(-1), false);
});

test('removeLastPageContext removes the most recent page-context message and returns its index', async () => {
  reset();
  await storage.setHistory([
    { role: 'user', content: `${PAGE_CONTEXT_PREFIX}\nold page` },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: `${PAGE_CONTEXT_PREFIX}\nnew page` },
  ]);
  const removedIdx = await storage.removeLastPageContext();
  assert.equal(removedIdx, 2, 'must remove the LAST matching page-context message, not the first');
  const history = await storage.getHistory();
  assert.equal(history.length, 2);
  assert.ok(!history.some(m => m.content.includes('new page')));
  assert.ok(history.some(m => m.content.includes('old page')), 'earlier page-context message must be left alone');
});

test('removeLastPageContext returns -1 when there is no page-context message', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'just a normal message' }]);
  assert.equal(await storage.removeLastPageContext(), -1);
});

// --------------- Hermes session identity (chrome.storage.session) -----------

test('getOrCreateHermesSessionId creates once and returns the same id on subsequent calls', async () => {
  reset();
  const id1 = await storage.getOrCreateHermesSessionId('hermes');
  const id2 = await storage.getOrCreateHermesSessionId('hermes');
  assert.equal(id1, id2, 'session id must persist across calls (survives SW restart via storage.session)');
  const idOther = await storage.getOrCreateHermesSessionId('compatible');
  assert.notEqual(id1, idOther, 'different providers must get independent session ids');
});

test('resetHermesSessionId always issues a fresh id, replacing the stored one', async () => {
  reset();
  const before = await storage.getOrCreateHermesSessionId('hermes');
  const after = await storage.resetHermesSessionId('hermes');
  assert.notEqual(before, after);
  const fetchedAfterReset = await storage.getOrCreateHermesSessionId('hermes');
  assert.equal(fetchedAfterReset, after, 'the reset id must be the one persisted going forward');
});

// --------------- saved sessions -----------------------------------------------

test('saveCurrentSession returns null when there is no history to save', async () => {
  reset();
  assert.equal(await storage.saveCurrentSession('name'), null);
});

test('saveCurrentSession auto-names from the first non-page-context user message', async () => {
  reset();
  await storage.setHistory([
    { role: 'user', content: `${PAGE_CONTEXT_PREFIX}\nsome page dump` },
    { role: 'user', content: 'What is the capital of France?' },
  ]);
  const session = await storage.saveCurrentSession();
  assert.ok(session);
  assert.equal(session.name, 'What is the capital of France?');
  assert.equal(session.history.length, 2, 'saved session must snapshot the full history, including page context');
});

test('saveCurrentSession truncates an explicit name to 80 chars', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'x' }]);
  const longName = 'y'.repeat(200);
  const session = await storage.saveCurrentSession(longName);
  assert.equal(session.name.length, 80);
});

test('getSavedSessions returns metadata only (no history payload), newest first', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'first conversation' }]);
  const s1 = await storage.saveCurrentSession('First');
  await storage.setHistory([{ role: 'user', content: 'second conversation' }]);
  const s2 = await storage.saveCurrentSession('Second');

  const list = await storage.getSavedSessions();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, s2.id, 'newest session must come first');
  assert.equal(list[1].id, s1.id);
  assert.ok(!('history' in list[0]), 'list entries must not include the full history payload');
});

test('loadSession restores a saved session into the live history and returns its length', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
  const session = await storage.saveCurrentSession('saved');
  await storage.clearHistory();
  assert.deepEqual(await storage.getHistory(), []);

  const len = await storage.loadSession(session.id);
  assert.equal(len, 2);
  assert.deepEqual((await storage.getHistory()).map(m => m.content), ['a', 'b']);
});

test('loadSession returns 0 for an unknown session id and does not touch history', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'untouched' }]);
  const len = await storage.loadSession('does-not-exist');
  assert.equal(len, 0);
  assert.deepEqual((await storage.getHistory()).map(m => m.content), ['untouched']);
});

test('deleteSession removes only the targeted session', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'one' }]);
  const s1 = await storage.saveCurrentSession('One');
  await storage.setHistory([{ role: 'user', content: 'two' }]);
  const s2 = await storage.saveCurrentSession('Two');

  await storage.deleteSession(s1.id);
  const list = await storage.getSavedSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, s2.id);
});

test('renameSession updates the name and truncates to 80 chars', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'x' }]);
  const session = await storage.saveCurrentSession('Old name');
  await storage.renameSession(session.id, 'New name');
  const full = await storage.getSessionFull(session.id);
  assert.equal(full.name, 'New name');

  await storage.renameSession(session.id, 'z'.repeat(200));
  const full2 = await storage.getSessionFull(session.id);
  assert.equal(full2.name.length, 80);
});

test('clearAllSessions empties the saved-sessions list', async () => {
  reset();
  await storage.setHistory([{ role: 'user', content: 'x' }]);
  await storage.saveCurrentSession('One');
  await storage.clearAllSessions();
  assert.deepEqual(await storage.getSavedSessions(), []);
});

test('getSessionFull returns null for an unknown id', async () => {
  reset();
  assert.equal(await storage.getSessionFull('nope'), null);
});

test('saveCurrentSession evicts the oldest session once MAX_SESSIONS (50) is exceeded', async () => {
  reset();
  for (let i = 0; i < 51; i++) {
    await storage.setHistory([{ role: 'user', content: `conversation ${i}` }]);
    await storage.saveCurrentSession(`Session ${i}`);
  }
  const list = await storage.getSavedSessions();
  assert.equal(list.length, 50, 'only the newest 50 sessions must be retained');
  assert.ok(!list.some(s => s.name === 'Session 0'), 'the oldest session (0) must have been evicted');
  assert.ok(list.some(s => s.name === 'Session 50'), 'the newest session must be present');
});
