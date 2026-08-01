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

const { compactEntryImageParts, parseFigureLabels } = await import('../lib/handlers/history-compactor.js');

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
