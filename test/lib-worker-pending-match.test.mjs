// test/lib-worker-pending-match.test.mjs — pure tests for matchPending(), the
// reply→request matching rule of the pdf/office worker protocol
// (lib/sidepanel/pdf-inspector-worker-client.js owns it; office-extractor.js
// imports + re-exports the same function). This is the defect-B3 data-
// integrity fix: the clients used to resolve replies with a blind FIFO
// shift(), so a timed-out request's LATE worker reply landed on the NEXT
// queued request — one document's parse result answering a different
// document's call. No Worker, no wasm, no big buffers here — just queue
// bookkeeping (dev-box discipline: 2C/4G, keep tests cheap).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchPending } from '../lib/sidepanel/pdf-inspector-worker-client.js';
import { matchPending as officeMatchPending } from '../lib/sidepanel/office-extractor.js';

const entry = (requestId) => ({ requestId, resolve: () => {} });
const ids = (pending) => pending.map((e) => e.requestId);

test('both worker clients share ONE matchPending implementation (office re-exports the pdf client\'s — no second copy to drift)', () => {
  assert.equal(officeMatchPending, matchPending);
});

test('a reply resolves THE request carrying its requestId, whatever the arrival order', () => {
  const pending = [entry(1), entry(2), entry(3)];
  const hit = matchPending(pending, 2);
  assert.equal(hit?.requestId, 2, 'an out-of-order reply must resolve its own request');
  assert.deepEqual(ids(pending), [1, 3]);
  assert.equal(matchPending(pending, 1)?.requestId, 1);
  assert.equal(matchPending(pending, 3)?.requestId, 3);
  assert.equal(pending.length, 0);
});

test('a late reply for an already-timed-out request is dropped and never resolves the NEXT queued request (B3)', () => {
  // Request A(id 1) is in flight when its timeout fires: the timeout path
  // dequeues the entry and resolves null (pdf.js / placeholder fallback).
  // Request B(id 2) queues up afterwards.
  const a = entry(1);
  const pending = [a];
  pending.splice(pending.indexOf(a), 1); // exactly what the timeout handler does
  const b = entry(2);
  pending.push(b);

  // A's reply finally arrives now. The old blind shift() handed it to B —
  // B's caller received A's whole document result.
  assert.equal(matchPending(pending, 1), null, 'a stale reply must find no home and be dropped');
  assert.deepEqual(ids(pending), [2], 'B must still be queued, untouched');

  // B's genuine reply still works afterwards: the first request after a
  // timeout is never polluted by the stale one.
  assert.equal(matchPending(pending, 2), b);
  assert.equal(pending.length, 0);
});

test('an unknown requestId is dropped without touching the queue; an empty queue drops everything', () => {
  const pending = [entry(5)];
  assert.equal(matchPending(pending, 999), null);
  assert.deepEqual(ids(pending), [5], 'an unmatched reply must leave the queue exactly as it was');
  assert.equal(matchPending(pending, 1), null);
  assert.deepEqual(ids(pending), [5]);
  assert.equal(matchPending([], 5), null);
});

test('an id-less reply (repliers predating the id protocol — the existing test doubles) falls back to FIFO order', () => {
  const pending = [entry(1), entry(2)];
  assert.equal(matchPending(pending, undefined)?.requestId, 1);
  assert.equal(matchPending(pending, undefined)?.requestId, 2);
  assert.equal(matchPending(pending, undefined), null);
});

// The id protocol is half client-side: if a worker script forgets to echo the
// requestId it was given, every real reply degrades to the id-less FIFO
// fallback above — the B3 bug returns silently and every existing test stays
// green (their doubles reply id-less too). And if a client stops SENDING the
// id, the echo comes back undefined with the same result. Pin both halves at
// the source level (line-based: every call site below is a single line).
test('the worker scripts echo requestId on every reply, and the clients send it on every real request', async () => {
  const read = (f) => readFile(new URL('../lib/sidepanel/' + f, import.meta.url), 'utf8');

  for (const f of ['pdf-inspector.worker.js', 'office-inspector.worker.js']) {
    const replies = (await read(f)).split('\n').filter((l) => l.includes('self.postMessage('));
    assert.ok(replies.length >= 2, `${f} must post both a success and an error reply`);
    for (const line of replies) {
      assert.match(line, /requestId/, `${f}: every reply must echo requestId — got: ${line.trim()}`);
    }
  }

  for (const f of ['pdf-inspector-worker-client.js', 'office-extractor.js']) {
    const requests = (await read(f)).split('\n')
      .filter((l) => l.includes('postMessage(') && !l.includes('warmup'));
    assert.ok(requests.length >= 1, `${f} must send at least one real worker request`);
    for (const line of requests) {
      assert.match(line, /requestId/, `${f}: every real request must carry requestId — got: ${line.trim()}`);
    }
  }
});
