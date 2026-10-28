// lib/sidepanel/match-pending.js — the pure reply→request matching rule for
// the pdf/office worker protocol, owned here (ONE implementation; both worker
// clients re-export this exact function so existing import paths stay put —
// test/lib-worker-pending-match.test.mjs pins the identity). No Worker/DOM
// deps — unit-tested in test/lib-worker-pending-match.test.mjs. Returns the
// pending entry the reply belongs to, REMOVED from the queue, or null when
// the reply must be dropped:
//
// - Reply carries a requestId → only that exact entry resolves. An id whose
//   entry is gone (it already timed out and resolved null) finds nothing and
//   returns null — the late reply is dropped instead of resolving the NEXT
//   queued request with the WRONG document's result (defect B3).
// - Reply carries NO id at all → replier predates the id protocol (test
//   doubles in test/lib-pdf-extractor-*.test.mjs /
//   test/lib-pdf-inspector-worker-client.test.mjs post exactly this shape):
//   fall back to the old FIFO order so they keep working. Cannot re-open B3
//   for real traffic — both worker scripts echo the id on every reply.

export function matchPending(pending, requestId) {
  if (requestId == null) return pending.shift() ?? null;
  const idx = pending.findIndex((e) => e.requestId === requestId);
  if (idx === -1) return null;
  return pending.splice(idx, 1)[0];
}
