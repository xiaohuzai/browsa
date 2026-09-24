// test/history-compactor.test.mjs
// History-image lifecycle: pure policy (compactEntryImageParts /
// parseFigureLabels / prepareHistoryForModel — the request-side model view)
// plus the two storage mutators' behavior (markImagesSeenInHistory's seen
// stamp and boundUnseenImageBytes' thumbnail budget). Storage pixels must
// NEVER be destroyed by these paths — that invariant (气泡里该有啥就有啥) is
// pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome mock so importing history-compactor.js (which imports
// storage.js) doesn't blow up at module load. The pure functions under test
// never touch chrome.
globalThis.chrome = { runtime: {}, storage: { local: { get: async () => ({}), set: async () => {} } } };

const { compactEntryImageParts, parseFigureLabels, imagePartsBytes, boundUnseenImageBytes, markImagesSeenInHistory } = await import('../lib/handlers/history-compactor.js');
const { prepareHistoryForModel, IMAGE_SEEN_FLAG, buildMessages, buildAnthropicMessages, buildRunsConversationHistory } = await import('../lib/message-builder.js');

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

// Deterministic stand-in for downscaleDataUrl: idempotent (`.thumb`-suffixed
// inputs come back unchanged), which is exactly the real impl's "already
// thumbnail-sized → return input" contract.
const fakeThumb = async (url) => (url.endsWith('.thumb') ? url : `${url}.thumb`);

test('boundUnseenImageBytes: over budget → downscales oldest parked entry to a thumbnail, spares the newest', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { sets, read } = statefulStorage([
    attachEntry('old', big),
    { role: 'assistant', content: 'reply' },
    attachEntry('new', big),
  ]);
  const n = await boundUnseenImageBytes(1500, { downscale: fakeThumb }); // total 2000 → oldest must go
  assert.equal(n, 1);
  const history = read();
  // Display fidelity: the part is STILL an image (a thumbnail), not a label —
  // the bubble must keep its picture.
  assert.equal(history[0].content[1].type, 'image_url', 'oldest attach keeps a display image');
  assert.equal(history[0].content[1].image_url.url, `${big}.thumb`);
  assert.equal(history[2].content[1].image_url.url, big, 'newest attach keeps full pixels');
  assert.ok(sets.length >= 1, 'a write happened');
});

test('boundUnseenImageBytes: within budget → read-only, no write at all', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { sets } = statefulStorage([attachEntry('only', big)]);
  const n = await boundUnseenImageBytes(5000, { downscale: fakeThumb });
  assert.equal(n, 0);
  assert.equal(sets.length, 0, 'no write when within budget');
});

test('boundUnseenImageBytes: single image-bearing entry over budget is spared (floor keeps attach-then-ask intact)', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { sets, read } = statefulStorage([
    { role: 'assistant', content: 'hi' },
    attachEntry('only-bearer', big),
  ]);
  const n = await boundUnseenImageBytes(10, { downscale: fakeThumb });
  assert.equal(n, 0);
  assert.equal(sets.length, 0, 'no write when the only bearer is the newest');
  assert.equal(read()[1].content[1].image_url.url, big);
});

test('boundUnseenImageBytes: undecodable payload → labeled placeholder is the fallback', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { read } = statefulStorage([
    attachEntry('old', big),
    attachEntry('new', big),
  ]);
  const n = await boundUnseenImageBytes(1500, {
    downscale: async () => { throw new Error('undecodable'); },
  });
  assert.equal(n, 1);
  const history = read();
  assert.equal(history[0].content[1].type, 'text', 'fallback keeps the old label behavior');
  assert.match(history[0].content[1].text, /^\[image 1\]$/);
  assert.equal(history[1].content[1].image_url.url, big, 'newest spared');
});

test('boundUnseenImageBytes: downscales as many oldest entries as the budget needs, then stops', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { read } = statefulStorage([
    attachEntry('a', big),
    attachEntry('b', big),
    attachEntry('c', big),
    attachEntry('d', big),
  ]);
  // total 4000, budget 2500 → downscale a+b → remaining 2000 ≤ 2500.
  const n = await boundUnseenImageBytes(2500, { downscale: fakeThumb });
  assert.equal(n, 2);
  const history = read();
  assert.equal(history[0].content[1].image_url.url, `${big}.thumb`);
  assert.equal(history[1].content[1].image_url.url, `${big}.thumb`);
  assert.equal(history[2].content[1].image_url.url, big);
  assert.equal(history[3].content[1].image_url.url, big);
});

test('boundUnseenImageBytes: idempotent — a second run writes nothing', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const { sets } = statefulStorage([attachEntry('old', big), attachEntry('new', big)]);
  await boundUnseenImageBytes(1500, { downscale: fakeThumb });
  const writesAfterFirst = sets.length;
  const n2 = await boundUnseenImageBytes(1500, { downscale: fakeThumb });
  assert.equal(n2, 0);
  assert.equal(sets.length, writesAfterFirst, 'no additional write on the second run');
});

// --------------- markImagesSeenInHistory ------------------------------------

test('markImagesSeenInHistory: stamps image-bearing entries once, pixels untouched', async () => {
  const { read } = statefulStorage([
    attachEntry('a', 'data:image/png;base64,AAA'),
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'plain text' },
    attachEntry('b', 'data:image/png;base64,BBB'),
  ]);
  const n = await markImagesSeenInHistory();
  assert.equal(n, 2, 'both image-bearing entries stamped');
  const history = read();
  assert.equal(history[0][IMAGE_SEEN_FLAG], true);
  assert.equal(history[0].content[1].type, 'image_url', 'pixels untouched');
  assert.equal(history[0].content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.equal(history[1][IMAGE_SEEN_FLAG], undefined, 'assistant turn untouched');
  assert.equal(history[2][IMAGE_SEEN_FLAG], undefined, 'text-only turn untouched');
  assert.equal(history[3][IMAGE_SEEN_FLAG], true);
  const n2 = await markImagesSeenInHistory();
  assert.equal(n2, 0, 'idempotent');
});

// --------------- prepareHistoryForModel (request-side compaction) ------------

function imageEntry(extra, url = 'data:image/png;base64,PIX') {
  return {
    role: 'user',
    ...extra,
    content: [
      { type: 'text', text: (extra && extra.text) || 'look' },
      { type: 'image_url', image_url: { url } },
    ],
  };
}

test('prepareHistoryForModel: seen images become labels (figure captions win) and the flag never leaks', () => {
  const entry = {
    role: 'user',
    [IMAGE_SEEN_FLAG]: true,
    content: [
      { type: 'text', text: 'body\n\n## Figures\n1. Figure 3: training pipeline' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,PIX' } },
    ],
  };
  const out = prepareHistoryForModel([entry]);
  assert.deepEqual(out[0].content, [
    { type: 'text', text: 'body\n\n## Figures\n1. Figure 3: training pipeline' },
    { type: 'text', text: '[Figure 3: training pipeline]' },
  ]);
  assert.ok(!JSON.stringify(out).includes(IMAGE_SEEN_FLAG), 'flag stripped from the model view');
});

test('prepareHistoryForModel: unseen images pass through by reference (ADR-0005 — restored snapshots resend pixels)', () => {
  const entry = imageEntry();
  const out = prepareHistoryForModel([entry]);
  assert.equal(out[0], entry, 'untouched entries keep identity');
  assert.equal(out[0].content[1].type, 'image_url', 'pixels ride the request');
});

test('prepareHistoryForModel: the flag is stripped even from text-only entries', () => {
  const entry = { role: 'user', [IMAGE_SEEN_FLAG]: true, content: 'plain' };
  const out = prepareHistoryForModel([entry]);
  assert.deepEqual(out[0], { role: 'user', content: 'plain' });
  assert.notEqual(out[0], entry);
});

test('prepareHistoryForModel: mixed history — only seen image entries are rewritten', () => {
  const seen = imageEntry({ [IMAGE_SEEN_FLAG]: true }, 'data:image/png;base64,OLD');
  const fresh = imageEntry({}, 'data:image/png;base64,NEW');
  const text = { role: 'assistant', content: 'reply' };
  const out = prepareHistoryForModel([seen, fresh, text]);
  assert.equal(out[0].content[1].type, 'text');
  assert.equal(out[1], fresh);
  assert.equal(out[2], text);
  assert.notEqual(out[0], seen);
});

// --------------- builder integration (what the provider actually receives) --

test('buildMessages: answered images become labels; unanswered ride as pixels; flag never leaks', () => {
  const seen = { role: 'user', [IMAGE_SEEN_FLAG]: true, content: [
    { type: 'text', text: 'seen turn' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } },
  ] };
  const fresh = { role: 'user', content: [
    { type: 'text', text: 'fresh turn' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,NEW' } },
  ] };
  const msgs = buildMessages({ history: [seen, fresh], userText: 'q', systemPrompt: 'sys' });
  const wire = JSON.stringify(msgs);
  assert.ok(!wire.includes('OLD'), 'answered pixels are not resent');
  assert.ok(wire.includes('NEW'), 'fresh pixels ride the request');
  assert.ok(!wire.includes(IMAGE_SEEN_FLAG), 'no flag in the request body');
  assert.ok(wire.includes('[image 1]'), 'answered image becomes a label');
});

test('buildAnthropicMessages: answered → no image blocks; unanswered → base64 image blocks', () => {
  const seen = { role: 'user', [IMAGE_SEEN_FLAG]: true, content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } },
  ] };
  const fresh = { role: 'user', content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,NEW' } },
  ] };
  const out = buildAnthropicMessages({ userText: 'q' }, [seen, fresh]);
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes('OLD'));
  assert.ok(wire.includes('NEW'));
  assert.ok(wire.includes('"type":"image"'), 'fresh image becomes an Anthropic image block');
});

test('buildRunsConversationHistory (responses style): answered → labels; unanswered → input_image', () => {
  const seen = { role: 'user', [IMAGE_SEEN_FLAG]: true, content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } },
  ] };
  const fresh = { role: 'user', content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,NEW' } },
  ] };
  const out = buildRunsConversationHistory([seen, fresh], { partStyle: 'responses' });
  assert.deepEqual(out[0].content, [{ type: 'input_text', text: '[image 1]' }]);
  assert.deepEqual(out[1].content, [{ type: 'input_image', image_url: 'data:image/png;base64,NEW' }]);
});
