// test/history-compactor.test.mjs
// Pure-function tests for history image compaction (compactEntryImageParts +
// parseFigureLabels). The I/O wrapper compactImagePartsInHistory is thin
// (read -> map -> write-if-changed) and needs a chrome.storage mock; the
// compaction logic itself is fully testable without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome mock so importing history-compactor.js (which imports
// storage.js) doesn't blow up at module load. The pure functions under test
// never touch chrome.
globalThis.chrome = { runtime: {}, storage: { local: { get: async () => ({}), set: async () => {} } } };

const { compactEntryImageParts, parseFigureLabels, imagePartsBytes, boundUnseenImageBytes } = await import('../lib/handlers/history-compactor.js');

// --------------- parseFigureLabels ------------------------------------------

test('parseFigureLabels: extracts numbered labels from ## Figures section in order', () => {
  const text = 'Some body text.\n\n## Figures\nThe descriptions below correspond to the following images in order:\n1. Figure 3: training pipeline\n2. Figure on page 7\n3. Figure 4.2: loss curve';
  assert.deepEqual(parseFigureLabels(text), [
    'Figure 3: training pipeline',
    'Figure on page 7',
    'Figure 4.2: loss curve',
  ]);
});

test('parseFigureLabels: returns [] when there is no ## Figures section', () => {
  assert.deepEqual(parseFigureLabels('just body text, no figures'), []);
  assert.deepEqual(parseFigureLabels(''), []);
  assert.deepEqual(parseFigureLabels(undefined), []);
});

test('parseFigureLabels: ignores non-numbered lines in the section (e.g. the description line)', () => {
  const text = '## Figures\nThe descriptions below correspond to the following images in order:\n1. Figure 1: foo';
  assert.deepEqual(parseFigureLabels(text), ['Figure 1: foo']);
});

// --------------- compactEntryImageParts -------------------------------------

test('compactEntryImageParts: PDF entry - image_url blocks replaced with parsed figure labels, text block intact', () => {
  const entry = {
    role: 'user',
    content: [
      { type: 'text', text: '[Page context]\nURL: https://example.com\nMode: pdf\n---\n\nBody text.\n\n## Figures\nThe descriptions below correspond to the following images in order:\n1. Figure 3: training pipeline\n2. Figure on page 7' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FIG1' } },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FIG2' } },
    ],
  };
  const out = compactEntryImageParts(entry);
  assert.equal(out.content.length, 3);
  // text block unchanged (the figures section + body still there for reference)
  assert.equal(out.content[0].type, 'text');
  assert.match(out.content[0].text, /## Figures/);
  // image_url blocks -> labeled text placeholders, in order
  assert.deepEqual(out.content[1], { type: 'text', text: '[Figure 3: training pipeline]' });
  assert.deepEqual(out.content[2], { type: 'text', text: '[Figure on page 7]' });
});

test('compactEntryImageParts: non-PDF entry (no ## Figures) - uses [image N] placeholders', () => {
  const entry = {
    role: 'user',
    content: [
      { type: 'text', text: '[Page context]\nMode: reader\n---\n\nSome blog body.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
    ],
  };
  const out = compactEntryImageParts(entry);
  assert.deepEqual(out.content[1], { type: 'text', text: '[image 1]' });
  assert.deepEqual(out.content[2], { type: 'text', text: '[image 2]' });
});

test('compactEntryImageParts: more image_url blocks than labels - extras fall back to [image N]', () => {
  // 1 label in the figures section, but 2 image_url blocks (defensive: shouldn't
  // happen in production since both derive from the same array, but must not
  // crash or mislabel).
  const entry = {
    role: 'user',
    content: [
      { type: 'text', text: '## Figures\n1. Figure 1: only label' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
    ],
  };
  const out = compactEntryImageParts(entry);
  assert.deepEqual(out.content[1], { type: 'text', text: '[Figure 1: only label]' });
  assert.deepEqual(out.content[2], { type: 'text', text: '[image 2]' });
});

test('compactEntryImageParts: idempotent - a second pass is a no-op (returns same reference)', () => {
  const entry = {
    role: 'user',
    content: [
      { type: 'text', text: '## Figures\n1. Figure 1: foo' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
    ],
  };
  const once = compactEntryImageParts(entry);
  const twice = compactEntryImageParts(once);
  assert.equal(twice, once, 'second pass must return the same object (no image_url left)');
  assert.deepEqual(twice.content, once.content);
});

test('compactEntryImageParts: entry with no image_url parts is returned unchanged (same reference)', () => {
  const entry = { role: 'user', content: [{ type: 'text', text: 'plain text' }] };
  assert.equal(compactEntryImageParts(entry), entry);
});

test('compactEntryImageParts: string content (assistant turn) is untouched', () => {
  const entry = { role: 'assistant', content: 'the model reply text' };
  assert.equal(compactEntryImageParts(entry), entry);
});

test('compactEntryImageParts: null/undefined/non-array-content entries are untouched', () => {
  assert.equal(compactEntryImageParts(null), null);
  assert.equal(compactEntryImageParts(undefined), undefined);
  const e = { role: 'user', content: 'a string' };
  assert.equal(compactEntryImageParts(e), e);
});

test('compactEntryImageParts: image-only entry (no text part) still compacts with [image N]', () => {
  const entry = {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ONLY' } }],
  };
  const out = compactEntryImageParts(entry);
  assert.deepEqual(out.content, [{ type: 'text', text: '[image 1]' }]);
});

test('compactEntryImageParts: preserves other (non-image) part types alongside images', () => {
  const entry = {
    role: 'user',
    content: [
      { type: 'text', text: 'body' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,A' } },
      { type: 'text', text: 'interstitial text' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
    ],
  };
  const out = compactEntryImageParts(entry);
  assert.deepEqual(out.content, [
    { type: 'text', text: 'body' },
    { type: 'text', text: '[image 1]' },
    { type: 'text', text: 'interstitial text' },
    { type: 'text', text: '[image 2]' },
  ]);
});

// --------------- imagePartsBytes ---------------------------------------------

test('imagePartsBytes: sums data-URL lengths across image_url parts (both shapes)', () => {
  const u1 = 'data:image/jpeg;base64,AAAA';
  const u2 = 'data:image/png;base64,BBBBBB';
  const entry = {
    role: 'user',
    content: [
      { type: 'text', text: 'body' },
      { type: 'image_url', image_url: { url: u1 } },
      { type: 'image_url', image_url: u2 }, // bare-string shape (defensive)
    ],
  };
  assert.equal(imagePartsBytes(entry), u1.length + u2.length);
});

test('imagePartsBytes: string content / null / text-only entries are 0', () => {
  assert.equal(imagePartsBytes({ role: 'assistant', content: 'reply' }), 0);
  assert.equal(imagePartsBytes(null), 0);
  assert.equal(imagePartsBytes(undefined), 0);
  assert.equal(imagePartsBytes({ role: 'user', content: [{ type: 'text', text: 'x' }] }), 0);
});

// --------------- boundUnseenImageBytes ---------------------------------------
// I/O tests with a stateful chrome.storage.local mock; budget is injected so
// the boundary is exercised with KB-scale strings, never real multi-MB blobs.

function attachEntry(label, url) {
  return {
    role: 'user',
    content: [{ type: 'text', text: `attach ${label}` }, { type: 'image_url', image_url: { url } }],
  };
}

function statefulStorage(initialHistory) {
  let stored = { history: JSON.parse(JSON.stringify(initialHistory)) };
  const sets = [];
  globalThis.chrome.storage.local = {
    get: async (key) => {
      if (key === null) return { ...stored };
      const keys = typeof key === 'string' ? [key] : key;
      const out = {};
      for (const k of keys) if (k in stored) out[k] = stored[k];
      return out;
    },
    set: async (obj) => { sets.push(obj); Object.assign(stored, obj); },
  };
  return { sets, read: () => stored.history };
}

test('boundUnseenImageBytes: over budget → compacts oldest parked entry, spares the newest', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { sets, read } = statefulStorage([
    attachEntry('old', big),
    { role: 'assistant', content: 'reply' },
    attachEntry('new', big),
  ]);
  const n = await boundUnseenImageBytes(1500); // total 2000 → oldest must go
  assert.equal(n, 1);
  const history = read();
  assert.equal(history[0].content[1].type, 'text', 'oldest attach compacted to placeholder');
  assert.match(history[0].content[1].text, /^\[image 1\]$/);
  assert.equal(history[2].content[1].type, 'image_url', 'newest attach keeps its pixels');
  assert.ok(sets.length >= 1, 'a write happened');
});

test('boundUnseenImageBytes: within budget → read-only, no write at all', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { sets } = statefulStorage([attachEntry('only', big)]);
  const n = await boundUnseenImageBytes(5000);
  assert.equal(n, 0);
  assert.equal(sets.length, 0, 'no write when within budget');
});

test('boundUnseenImageBytes: single image-bearing entry over budget is spared (floor keeps attach-then-ask intact)', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { sets, read } = statefulStorage([
    { role: 'assistant', content: 'hi' },
    attachEntry('only-bearer', big),
  ]);
  const n = await boundUnseenImageBytes(10);
  assert.equal(n, 0);
  assert.equal(sets.length, 0, 'no write when the only bearer is the newest');
  assert.equal(read()[1].content[1].type, 'image_url');
});

test('boundUnseenImageBytes: compacts as many oldest entries as the budget needs, then stops', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { read } = statefulStorage([
    attachEntry('a', big),
    attachEntry('b', big),
    attachEntry('c', big),
    attachEntry('d', big),
  ]);
  // total 4000, budget 2500 → compact a+b → remaining 2000 ≤ 2500.
  const n = await boundUnseenImageBytes(2500);
  assert.equal(n, 2);
  const history = read();
  assert.equal(history[0].content[1].type, 'text');
  assert.equal(history[1].content[1].type, 'text');
  assert.equal(history[2].content[1].type, 'image_url');
  assert.equal(history[3].content[1].type, 'image_url');
});

test('boundUnseenImageBytes: idempotent — a second run writes nothing', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { sets } = statefulStorage([attachEntry('old', big), attachEntry('new', big)]);
  await boundUnseenImageBytes(1500);
  const writesAfterFirst = sets.length;
  const n2 = await boundUnseenImageBytes(1500);
  assert.equal(n2, 0);
  assert.equal(sets.length, writesAfterFirst, 'no additional write on the second run');
});
