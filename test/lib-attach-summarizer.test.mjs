// test/lib-attach-summarizer.test.mjs — coverage for
// lib/handlers/attach-summarizer.js: chunk/summarize/merge very long
// page/video attachments before they enter history (ported from auditing
// BiliNote's chunk-summarize-merge pipeline). Uses the same in-memory
// chrome.storage.local mock pattern as test/storage.test.mjs, plus the
// buildSseStream fetch-mocking pattern from test/chat-stream-approval.test.mjs
// for exercising the real chatStream() calls end to end.

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
    async set(obj) { store = { ...store, ...obj }; },
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
const {
  shouldSummarize, splitIntoChunks, summarizeLongText, maybeSummarizeAttachment
} = await import('../lib/handlers/attach-summarizer.js');

function reset() { localArea._reset(); sessionArea._reset(); }

function buildSseStream(blocks) {
  const encoder = new TextEncoder();
  let text = '';
  for (const b of blocks) {
    if (b.event) text += `event: ${b.event}\n`;
    text += `data: ${JSON.stringify(b.data)}\n\n`;
  }
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); }
  });
}

function sseFor(text) {
  return buildSseStream([{ data: { choices: [{ delta: { content: text } }] } }]);
}

const PROVIDER = { baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' };

// ─── shouldSummarize ─────────────────────────────────────────────────────────

test('shouldSummarize: below threshold is false, above is true', () => {
  assert.equal(shouldSummarize('a'.repeat(100), 200), false);
  assert.equal(shouldSummarize('a'.repeat(300), 200), true);
});

test('shouldSummarize: 0/undefined threshold falls back to the 40,000-char default', () => {
  assert.equal(shouldSummarize('a'.repeat(39_999), 0), false);
  assert.equal(shouldSummarize('a'.repeat(40_001), 0), true);
  assert.equal(shouldSummarize('a'.repeat(40_001), undefined), true);
});

test('shouldSummarize: empty/falsy text is always false', () => {
  assert.equal(shouldSummarize('', 10), false);
  assert.equal(shouldSummarize(null, 10), false);
});

// ─── splitIntoChunks ─────────────────────────────────────────────────────────

test('splitIntoChunks: empty text returns no chunks', () => {
  assert.deepEqual(splitIntoChunks(''), []);
});

test('splitIntoChunks: never splits a line in half — packs whole lines greedily', () => {
  const lines = ['[00:00] one', '[00:05] two', '[00:10] three'];
  const text = lines.join('\n');
  // Chunk size small enough to force a split, but every resulting chunk's
  // lines must still be complete, unmangled originals.
  const chunks = splitIntoChunks(text, 15);
  const rejoined = chunks.join('\n').split('\n');
  assert.deepEqual(rejoined, lines, 'every original line must appear intact across the chunk boundaries');
  assert.ok(chunks.length > 1, 'a small chunk size should force more than one chunk');
});

test('splitIntoChunks: a single line longer than the budget still terminates (own oversized chunk, no infinite loop)', () => {
  const hugeLine = 'x'.repeat(1000);
  const chunks = splitIntoChunks(hugeLine, 10);
  assert.deepEqual(chunks, [hugeLine]);
});

test('splitIntoChunks: exact multiples of the chunk size pack cleanly', () => {
  const text = 'aaaa\nbbbb\ncccc';
  const chunks = splitIntoChunks(text, 5); // "aaaa\n" = 5 chars exactly
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join('\n').split('\n').join('\n'), text);
});

// ─── summarizeLongText ───────────────────────────────────────────────────────

test('summarizeLongText: makes one fetch call per chunk plus one merge call, returns the merge result', async () => {
  const chunkText = Array.from({ length: 20 }, (_, i) => `[00:${String(i).padStart(2, '0')}] line ${i}`).join('\n');
  let calls = 0;
  const requestBodies = [];
  globalThis.fetch = async (_url, init) => {
    calls++;
    requestBodies.push(JSON.parse(init.body));
    // Every call gets a distinguishable canned reply: chunk calls echo a
    // marker, the merge call (last) gets its own marker.
    const isMerge = requestBodies.length > 1 && requestBodies[requestBodies.length - 1].messages[0].content.includes('Merge them');
    return { ok: true, status: 200, body: sseFor(isMerge ? 'MERGED_RESULT' : 'chunk summary'), text: async () => '' };
  };

  const result = await summarizeLongText({ text: chunkText, mode: 'youtube', provider: PROVIDER, chunkSizeChars: 40 });
  assert.equal(result, 'MERGED_RESULT');
  assert.ok(calls > 2, 'expected multiple chunk calls plus a merge call');
  // Last call must be the merge call, given all preceding ones the chunk summaries.
  const lastBody = requestBodies[requestBodies.length - 1];
  assert.match(lastBody.messages[0].content, /Merge them/);
});

test('summarizeLongText: video mode system prompt requires preserving [mm:ss] markers; generic mode does not mention them', async () => {
  let videoPrompt = '';
  let genericPrompt = '';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!videoPrompt) videoPrompt = body.messages[0].content;
    return { ok: true, status: 200, body: sseFor('summary'), text: async () => '' };
  };
  await summarizeLongText({ text: 'short text, one chunk', mode: 'bilibili', provider: PROVIDER });
  assert.match(videoPrompt, /\[mm:ss\]/, 'video-mode prompt must mention preserving [mm:ss] markers');

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!genericPrompt) genericPrompt = body.messages[0].content;
    return { ok: true, status: 200, body: sseFor('summary'), text: async () => '' };
  };
  await summarizeLongText({ text: 'short text, one chunk', mode: 'reader', provider: PROVIDER });
  assert.doesNotMatch(genericPrompt, /\[mm:ss\]/, 'generic-mode prompt must not mention timestamp markers');
});

test('summarizeLongText: a single-chunk input (no newlines) summarizes directly with no merge call', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    return { ok: true, status: 200, body: sseFor('one summary'), text: async () => '' };
  };
  const result = await summarizeLongText({ text: 'one long line with no breaks', mode: 'reader', provider: PROVIDER });
  assert.equal(result, 'one summary');
  assert.equal(calls, 1, 'a single chunk needs no separate merge call');
});

// ─── maybeSummarizeAttachment ────────────────────────────────────────────────

test('maybeSummarizeAttachment: replaces the matching history entry\'s content on success', async () => {
  reset();
  const attachId = 'attach-1';
  await storage.appendToHistory({ role: 'user', content: 'ORIGINAL LONG TEXT', attachId });
  globalThis.fetch = async () => ({ ok: true, status: 200, body: sseFor('condensed summary'), text: async () => '' });

  await maybeSummarizeAttachment({
    attachId,
    ctx: { text: 'a'.repeat(50_000), mode: 'reader', meta: { url: 'https://x.test', title: 'X' } },
    provider: PROVIDER
  });

  const history = await storage.getHistory();
  assert.equal(history.length, 1);
  assert.match(history[0].content, /condensed summary/);
  assert.match(history[0].content, /auto-condensed from 50,000 chars/);
  assert.equal(history[0].summarized, true);
});

test('maybeSummarizeAttachment: no-op when the attachId is no longer present (undone/deleted/truncated race)', async () => {
  reset();
  await storage.appendToHistory({ role: 'user', content: 'UNRELATED ENTRY', attachId: 'other-id' });
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, body: sseFor('x'), text: async () => '' }; };

  await maybeSummarizeAttachment({
    attachId: 'gone-id',
    ctx: { text: 'a'.repeat(50_000), mode: 'reader', meta: { url: 'https://x.test', title: 'X' } },
    provider: PROVIDER
  });

  assert.ok(fetchCalled, 'the summarization pipeline still runs (the race is discovered only when writing back)');
  const history = await storage.getHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].content, 'UNRELATED ENTRY', 'the unrelated entry must be completely untouched');
});

test('maybeSummarizeAttachment: no-op (and no fetch at all) when no provider baseUrl is configured', async () => {
  reset();
  const attachId = 'attach-2';
  await storage.appendToHistory({ role: 'user', content: 'ORIGINAL', attachId });
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, body: sseFor('x'), text: async () => '' }; };

  await maybeSummarizeAttachment({
    attachId,
    ctx: { text: 'a'.repeat(50_000), mode: 'reader', meta: { url: 'https://x.test', title: 'X' } },
    provider: { baseUrl: '' }
  });

  assert.equal(fetchCalled, false);
  const history = await storage.getHistory();
  assert.equal(history[0].content, 'ORIGINAL');
});

test('maybeSummarizeAttachment: leaves the original entry untouched when the LLM call fails', async () => {
  reset();
  const attachId = 'attach-3';
  await storage.appendToHistory({ role: 'user', content: 'ORIGINAL', attachId });
  globalThis.fetch = async () => { throw new Error('network down'); };

  await maybeSummarizeAttachment({
    attachId,
    ctx: { text: 'a'.repeat(50_000), mode: 'reader', meta: { url: 'https://x.test', title: 'X' } },
    provider: PROVIDER
  });

  const history = await storage.getHistory();
  assert.equal(history[0].content, 'ORIGINAL', 'original content must survive a failed summarization attempt');
  assert.equal(history[0].summarized, undefined);
});

test('maybeSummarizeAttachment: no-op when attachId or ctx.text is missing', async () => {
  reset();
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, body: sseFor('x'), text: async () => '' }; };
  await maybeSummarizeAttachment({ attachId: null, ctx: { text: 'x' }, provider: PROVIDER });
  await maybeSummarizeAttachment({ attachId: 'id', ctx: { text: '' }, provider: PROVIDER });
  assert.equal(fetchCalled, false);
});
