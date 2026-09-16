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

// ─── stubOversizedAttachments (context-overflow self-rescue) ─────────────────
// 2026-09-16 real report: an 18-page arXiv PDF (67.8K chars ≈ 35K tokens) plus
// 9 figure images overflowed a 64K-class window via Hermes on the FIRST turn
// after attach, and neither Hermes's auto-shrink nor context aging could
// recover (aging never touches the NEWEST attach). The rescue stubs every
// oversized attach — newest included, figures dropped — so the retried turn
// fits. Deliberately different from aging: latency vs. making the request fit.

import { stubOversizedAttachments } from '../lib/message-builder.js';

test('stubOversizedAttachments: stubs the NEWEST oversized attach too (aging never does)', () => {
  const history = [{ role: 'user', attachId: 'a-1', content: attach('https://arxiv.org/pdf/2307.03172', 'Lost in the Middle', 'p'.repeat(67_801)) }];
  const { history: out, changed } = stubOversizedAttachments(history);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].attachId, 'a-1');
  assert.match(String(out[0].content), /too large for the model's context window/);
  assert.match(String(out[0].content), /Title: Lost in the Middle/);
  assert.match(String(out[0].content), /URL: https:\/\/arxiv\.org\/pdf\/2307\.03172/);
  assert.match(String(out[0].content), /Original size: ~6\d{4} chars/, 'the stub carries the true original size (body + header, not just the body)');
  // the stub must still open with PAGE_CONTEXT_PREFIX — the sidepanel skips
  // attach entries from bubble rendering by that prefix, and the persisted
  // stub would otherwise start rendering as a user bubble.
  assert.ok(String(out[0].content).startsWith(PREFIX));
  // input array untouched
  assert.ok(history[0].content.includes('p'.repeat(100)));
});

test('stubOversizedAttachments: multimodal (figure) entries lose their image parts', () => {
  const history = [{
    role: 'user', attachId: 'pdf-1',
    content: [
      { type: 'text', text: attach('https://arxiv.org/pdf/x', 'Figured Doc', 'f'.repeat(9000)) },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FIG1' } },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,FIG2' } },
    ],
  }];
  const { history: out, changed } = stubOversizedAttachments(history);
  assert.equal(changed.length, 1);
  assert.equal(Array.isArray(out[0].content), false, 'figure blocks must not survive — they can be ~15K tokens and the retried turn cannot fit with them');
  assert.equal(String(out[0].content).includes('FIG1'), false);
});

test('stubOversizedAttachments: small attaches and plain messages are untouched', () => {
  const history = [
    { role: 'user', attachId: 'small', content: attach('https://s.com', 'Small', 'tiny body') },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'a plain question mentioning ' + PREFIX + ' in passing' },
  ];
  const { history: out, changed } = stubOversizedAttachments(history);
  assert.equal(changed.length, 0);
  assert.deepEqual(out, history, 'nothing eligible → identical content, input array never mutated');
});
