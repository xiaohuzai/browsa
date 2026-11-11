// test/chat-failure-ladder.test.mjs — the turn-failure decision ladder as a
// pure function. handleChat's catch used to encode ordering + one-shot
// budgets in statement order inside a 700-line function; classifyTurnFailure
// owns that policy now, so the ladder is pinned here as a table instead of
// only through full-turn integration mocks.
//
// Contract pinned:
//   abort > strip-reasoning > stub-overflow > transient retry > fail.
//   One-shot budgets (reasoningStripped / overflowRescued) never recharge;
//   the strip retry and the overflow rescue do NOT consume the transient
//   ladder (the handler does attempt-- for both); a reasoning verdict beats
//   an overflow-looking message (more specific verdict first).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { classifyTurnFailure } = await import('../lib/handlers/chat-failure-ladder.js');
const { isReasoningRejection, isContextOverflowError } = await import('../lib/handlers/chat-handler.js');

const predicates = { isReasoningRejection, isContextOverflowError };
const classify = (e, state) => classifyTurnFailure(e, state, predicates);

function apiErr(message) {
  const e = new Error(message);
  e.name = 'ProviderAPIError';
  return e;
}
function netErr(message = 'fetch failed') {
  const e = new Error(message);
  e.name = 'ProviderNetworkError';
  return e;
}

const fresh = (over = {}) => ({
  attempt: 1,
  maxRetries: 2,
  reasoningStripped: false,
  overflowRescued: false,
  stateless: true,
  overflowRescuable: true,
  isAbort: false,
  ...over,
});

const REASONING_400 = apiErr('HTTP 400: {"error":{"message":"Unsupported parameter: reasoning"}}');
const OVERFLOW = apiErr('HTTP 400: This model\'s maximum context length is 16385 tokens.');
const RATE_LIMIT = apiErr('HTTP 429: rate limited');
const REAL_400 = apiErr('HTTP 400: {"error":{"message":"invalid model"}}');

test('ladder order: abort beats everything, even a reasoning-shaped error', () => {
  assert.equal(classify(REASONING_400, fresh({ isAbort: true })), 'abort');
  const named = new Error('nested timeout');
  named.name = 'AbortError';
  assert.equal(classify(named, fresh({ isAbort: true })), 'abort');
});

test('reasoning rejection: strip once, only for stateless providers', () => {
  assert.equal(classify(REASONING_400, fresh()), 'strip-reasoning');
  assert.equal(classify(REASONING_400, fresh({ reasoningStripped: true })), 'fail',
    'the one-shot budget never recharges');
  assert.equal(classify(REASONING_400, fresh({ stateless: false })), 'fail',
    'agent kinds have no reasoning body field to strip');
});

test('overflow: stub once, only when the turn is rescuable', () => {
  assert.equal(classify(OVERFLOW, fresh()), 'stub-overflow');
  assert.equal(classify(OVERFLOW, fresh({ overflowRescued: true })), 'fail');
  assert.equal(classify(OVERFLOW, fresh({ overflowRescuable: false })), 'fail',
    'server-side transcripts (bridge/opencode) cannot shrink by resending less');
});

test('a body naming BOTH reasoning refusal and overflow takes the reasoning verdict first', () => {
  const both = apiErr('HTTP 400: unsupported reasoning field; maximum context length exceeded');
  assert.equal(classify(both, fresh()), 'strip-reasoning',
    'the more specific verdict wins — overflow-first would discard attachment precision');
  assert.equal(classify(both, fresh({ reasoningStripped: true })), 'stub-overflow',
    'with the strip budget spent, the overflow reading is still available');
});

test('transient ladder: network + 429 retry within budget, everything else fails', () => {
  assert.equal(classify(netErr(), fresh()), 'retry');
  assert.equal(classify(RATE_LIMIT, fresh()), 'retry');
  assert.equal(classify(netErr(), fresh({ attempt: 2 })), 'retry');
  assert.equal(classify(netErr(), fresh({ attempt: 3 })), 'fail', 'MAX_RETRIES=2 → attempts 1..3');
  assert.equal(classify(REAL_400, fresh()), 'fail', 'a real 400 is not retried');
  assert.equal(classify(new Error('boom'), fresh()), 'fail');
  // Known tradeoff, pinned as-is: the transient predicate is a substring
  // match on 429, so a 5xx body quoting "429" also rides the ladder. Same
  // behavior the inline catch had — do not tighten here without a ruling.
  assert.equal(classify(apiErr('HTTP 500: upstream said 429 once'), fresh()), 'retry',
    'substring predicate preserved verbatim from the inline ladder');
  assert.equal(classify(apiErr('HTTP 500: bad gateway'), fresh()), 'fail');
});

test('one-shot verdicts do not depend on the transient budget', () => {
  assert.equal(classify(REASONING_400, fresh({ attempt: 3 })), 'strip-reasoning');
  assert.equal(classify(OVERFLOW, fresh({ attempt: 3 })), 'stub-overflow');
});

test('sequence: strip → overflow → retry → retry → fail across one turn', () => {
  const state = fresh();
  const seen = [];
  const feed = (e) => {
    const v = classify(e, state);
    seen.push(v);
    if (v === 'strip-reasoning') state.reasoningStripped = true;
    else if (v === 'stub-overflow') state.overflowRescued = true;
    else if (v === 'retry') state.attempt++;
    return v;
  };
  feed(REASONING_400);          // strip (attempt stays 1 via handler attempt--)
  feed(OVERFLOW);               // stub  (attempt stays 1)
  feed(netErr());               // retry → attempt 2
  feed(RATE_LIMIT);             // retry → attempt 3
  feed(netErr());               // budget spent
  assert.deepEqual(seen, ['strip-reasoning', 'stub-overflow', 'retry', 'retry', 'fail']);
});
