// test/lib-attach-change-tracker.test.mjs — coverage for
// lib/handlers/attach-change-tracker.js: local, offline "did this page
// change since it was last attached" detection (ported concept from
// firecrawl's change-tracking-diff.ts, minus the network/DB round-trip --
// browsa keeps only a hash+length+timestamp per (mode, url) key, not a full
// previous-markdown copy). Uses the same in-memory chrome.storage.local mock
// pattern as test/lib-attach-summarizer.test.mjs/test/storage.test.mjs.

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

Object.defineProperty(globalThis, 'chrome', {
  value: { storage: { local: localArea } },
  writable: true,
  configurable: true,
});

const { hashText, checkAndRecordAttachChange } = await import('../lib/handlers/attach-change-tracker.js');

function reset() { localArea._reset(); }

test('hashText is deterministic for the same input', () => {
  assert.equal(hashText('hello world'), hashText('hello world'));
});

test('hashText differs for different input', () => {
  assert.notEqual(hashText('hello world'), hashText('hello there'));
});

test('checkAndRecordAttachChange: first attach of a key returns changed:false', async () => {
  reset();
  const result = await checkAndRecordAttachChange('reader::https://example.com/a', 'first content');
  assert.equal(result.changed, false);
});

test('checkAndRecordAttachChange: second attach with different text returns changed:true with previous timestamp', async () => {
  reset();
  await checkAndRecordAttachChange('reader::https://example.com/a', 'version one');
  const result = await checkAndRecordAttachChange('reader::https://example.com/a', 'version two, quite different');
  assert.equal(result.changed, true);
  assert.equal(typeof result.previousAttachedAt, 'number');
  assert.equal(result.previousLength, 'version one'.length);
});

test('checkAndRecordAttachChange: second attach with identical text returns changed:false', async () => {
  reset();
  await checkAndRecordAttachChange('reader::https://example.com/a', 'same content every time');
  const result = await checkAndRecordAttachChange('reader::https://example.com/a', 'same content every time');
  assert.equal(result.changed, false);
});

test('checkAndRecordAttachChange: different (mode, url) keys are tracked independently', async () => {
  reset();
  await checkAndRecordAttachChange('reader::https://example.com/a', 'reader-mode text');
  // Same URL, different mode -- must not be treated as "the same page changed".
  const result = await checkAndRecordAttachChange('dom::https://example.com/a', 'completely different dom-mode text');
  assert.equal(result.changed, false, 'a different mode for the same URL must not compare against the other mode\'s snapshot');
});

test('checkAndRecordAttachChange: missing key or text is a no-op returning changed:false', async () => {
  reset();
  assert.deepEqual(await checkAndRecordAttachChange('', 'text'), { changed: false });
  assert.deepEqual(await checkAndRecordAttachChange('reader::https://x.com', ''), { changed: false });
});

test('checkAndRecordAttachChange: snapshot count never exceeds MAX_SNAPSHOTS, oldest evicted first', async () => {
  reset();
  // 50 is the documented cap in attach-change-tracker.js -- write 55 distinct
  // keys and confirm only the newest 50 survive.
  for (let i = 0; i < 55; i++) {
    await checkAndRecordAttachChange(`reader::https://example.com/${i}`, `content for page ${i}`);
  }
  const { browsaAttachSnapshots } = await localArea.get('browsaAttachSnapshots');
  const keys = Object.keys(browsaAttachSnapshots);
  assert.equal(keys.length, 50, 'must evict down to the 50-entry cap');
  assert.ok(!keys.includes('reader::https://example.com/0'), 'oldest entry (index 0) must be evicted first');
  assert.ok(keys.includes('reader::https://example.com/54'), 'newest entry must survive');
});
