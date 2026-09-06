// test/lib-message-builder-aging.test.mjs
// Coverage for ageStaleAttachments() — context aging (send-time stubbing of
// cold attached-page blocks). The dominant latency on big-context sessions is
// re-sending every old page context on every turn; aging replaces blocks that
// have gone cold with a one-line stub, WITHOUT touching storage (the stub is
// computed deterministically from the entry itself, so it is byte-identical
// on later turns and the UI keeps reading the full text).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ageStaleAttachments } from '../lib/message-builder.js';

const PREFIX = '[Page context attached by browsa]';

function attach(url, title, body) {
  return `${PREFIX}\nURL: ${url}\nTitle: ${title}\nMode: reader\n---\n\n${body}`;
}

test('ageStaleAttachments: cold older attach is stubbed, newest attach stays whole', () => {
  const big = 'y'.repeat(9000);
  const history = [
    { role: 'user', content: attach('https://a.com', 'A', big) },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'user', content: 'q3' },
    { role: 'user', content: attach('https://b.com', 'B', big) },
  ];
  const out = ageStaleAttachments(history);
  // A is cold: a newer attach exists, 3 user turns after it, >8000 chars → stub.
  assert.match(String(out[0].content), /Attached page context trimmed/);
  assert.match(String(out[0].content), /Title: A/);
  assert.match(String(out[0].content), /URL: https:\/\/a\.com/);
  assert.match(String(out[0].content), /~90\d\d chars/);
  // B is the newest attach — the active context — never aged.
  assert.equal(out[5].content, history[5].content);
});

test('ageStaleAttachments: no-op cases return the SAME array (identity)', () => {
  const plain = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  assert.equal(ageStaleAttachments(plain), plain);

  const freshAttach = [
    { role: 'user', content: attach('https://a.com', 'A', 'z'.repeat(9000)) },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'q1' },
  ];
  assert.equal(ageStaleAttachments(freshAttach), freshAttach, 'only 1 user turn after → not cold');
});

test('ageStaleAttachments: small attaches are never aged (minChars floor)', () => {
  const history = [
    { role: 'user', content: attach('https://a.com', 'A', 's'.repeat(100)) },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'user', content: 'q3' },
    { role: 'user', content: attach('https://b.com', 'B', 'b'.repeat(9000)) },
  ];
  const out = ageStaleAttachments(history);
  assert.equal(out[0].content, history[0].content, '~180 chars total < 8000 floor → untouched');
});

test('ageStaleAttachments: stub is deterministic (byte-identical across calls — one cache break, not per-turn)', () => {
  const mk = () => [
    { role: 'user', content: attach('https://a.com/p?x=1', 'Long <Article> & "Quotes"', 'd'.repeat(12000)) },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'user', content: 'q3' },
    { role: 'user', content: attach('https://b.com', 'B', 'n'.repeat(9000)) },
  ];
  const a = ageStaleAttachments(mk());
  const b = ageStaleAttachments(mk());
  assert.equal(a[0].content, b[0].content);
  assert.match(a[0].content, /Long <Article> & "Quotes"/);
});

test('ageStaleAttachments: array-content attach (multimodal entry) is stubbed to a plain string', () => {
  const history = [
    { role: 'user', content: [
      { type: 'text', text: attach('https://a.com', 'A', 'm'.repeat(9000)) },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ] },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'user', content: 'q3' },
    { role: 'user', content: attach('https://b.com', 'B', 'n'.repeat(9000)) },
  ];
  const out = ageStaleAttachments(history);
  assert.equal(typeof out[0].content, 'string');
  assert.match(out[0].content, /Attached page context trimmed/);
});

test('ageStaleAttachments: non-attach entries untouched; videoSrc property survives the stub', () => {
  const history = [
    { role: 'assistant', content: `${PREFIX}\nfake` }, // assistant role → never an attach
    { role: 'user', content: attach('https://a.com', 'A', 'v'.repeat(9000)), videoSrc: { tabId: 2 } },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'user', content: 'q3' },
    { role: 'user', content: attach('https://b.com', 'B', 'n'.repeat(9000)) },
  ];
  const out = ageStaleAttachments(history);
  assert.equal(out[0].content, history[0].content, 'assistant entry never aged');
  assert.deepEqual(out[1].videoSrc, { tabId: 2 }, 'videoSrc stamp preserved on the stubbed entry');
  assert.match(String(out[1].content), /Title: A/);
});

test('ageStaleAttachments: opts honored (minUserTurnsAfter / minChars)', () => {
  const history = [
    { role: 'user', content: attach('https://a.com', 'A', 'o'.repeat(500)) },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'user', content: attach('https://b.com', 'B', 'n'.repeat(9000)) },
  ];
  const aged = ageStaleAttachments(history, { minUserTurnsAfter: 2, minChars: 100 });
  assert.match(String(aged[0].content), /Attached page context trimmed/);
  const kept = ageStaleAttachments(history, { minUserTurnsAfter: 5, minChars: 100 });
  assert.equal(kept[0].content, history[0].content);
});
