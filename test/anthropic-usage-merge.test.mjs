// test/anthropic-usage-merge.test.mjs — Anthropic reports prompt/cache token
// counts only on message_start; message_delta carries output_tokens. The
// shared SSE loop keeps the LAST non-empty usage, so the parser must merge
// them before returning (otherwise the token chip never shows prompt/cache
// for Anthropic providers — the feature was silently absent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnthropicEvent } from '../lib/llm-client.js';

const state = () => ({});

test('message_start + message_delta usage merge (input/cache + output)', () => {
  const st = state();
  const start = parseAnthropicEvent(
    'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 50,
        },
      },
    }),
    st
  );
  assert.deepEqual(start, {}, 'message_start produces no visible delta/usage of its own');

  const delta = parseAnthropicEvent(
    'event: message_delta\ndata: ' + JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 20 },
    }),
    st
  );
  assert.deepEqual(delta.usage, {
    input_tokens: 100,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 50,
    output_tokens: 20,
  }, 'both halves of the usage survive');
  assert.equal(delta.finishReason, 'stop');
});

test('a message_delta with its own input/cache fields still wins per field', () => {
  const st = state();
  parseAnthropicEvent(
    'event: message_start\ndata: ' + JSON.stringify({ message: { usage: { input_tokens: 1, cache_read_input_tokens: 2 } } }),
    st
  );
  const delta = parseAnthropicEvent(
    'event: message_delta\ndata: ' + JSON.stringify({ usage: { input_tokens: 9, output_tokens: 3 } }),
    st
  );
  assert.deepEqual(delta.usage, {
    input_tokens: 9,
    cache_read_input_tokens: 2,
    output_tokens: 3,
  });
});
