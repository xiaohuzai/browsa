// test/responses-stream.test.mjs
// Regression test for the "reasoning block swallows the final agent
// reply" bug: responsesApiStream() diffed response.completed's text
// against `full.length`, but `full` also accumulates injected
// <thinking>...</thinking> block text from response.output_item.done
// (reasoning) events. When a tool-using turn only emits its real answer
// inside response.completed (per the code's own comment: "post-tool
// text only appears here"), a thinking block longer than that answer
// made `completedText.length > full.length` false, and the answer was
// silently dropped — never reaching onDelta, never persisted to history.
//
// Fix: track `messageTextLen` (message-only text length) separately
// from `full`, and diff response.completed against that instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Builds a fake SSE ReadableStream body from a list of {event, data} pairs,
// in the "event: X\ndata: {...}\n\n" shape responsesApiStream() parses.
function buildSseStream(events) {
  const encoder = new TextEncoder();
  let text = '';
  for (const { event, data } of events) {
    text += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

function mockFetchWithEvents(events) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: buildSseStream(events),
    text: async () => ''
  });
}

test('responsesApiStream: reasoning block does not swallow a tool-turn final answer (regression)', async () => {
  const { responsesApiStream } = await import('../lib/openai-client.js');

  // Thinking text is deliberately longer than the final answer, which is
  // exactly the shape that triggered the bug: full.length (padded by the
  // <thinking> block) ends up bigger than completedText.length, so the
  // old `completedText.length > full.length` check never fires.
  mockFetchWithEvents([
    {
      event: 'response.output_item.done',
      data: { item: { type: 'reasoning', summary: [{ text: 'Let me think about this problem carefully and check the available tools before answering.' }] } }
    },
    {
      event: 'response.completed',
      data: {
        response: {
          usage: { total_tokens: 42 },
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }
          ]
        }
      }
    }
  ]);

  const deltas = [];
  const result = await responsesApiStream({
    baseUrl: 'http://test',
    apiKey: 'k',
    input: 'hi',
    onDelta: (d) => deltas.push(d)
  });

  const emitted = deltas.join('');
  assert.ok(emitted.includes('Done.'), `final answer must be emitted via onDelta, got: ${JSON.stringify(deltas)}`);
  assert.ok(result.full.includes('Done.'), `final answer must be present in the returned full text, got: ${JSON.stringify(result.full)}`);
  assert.equal(result.usage?.total_tokens, 42);
});

test('responsesApiStream: plain delta-only turn (no thinking, no tools) is unaffected', async () => {
  const { responsesApiStream } = await import('../lib/openai-client.js');

  mockFetchWithEvents([
    { event: 'response.output_text.delta', data: { delta: 'Hello' } },
    { event: 'response.output_text.delta', data: { delta: ' world' } },
    {
      event: 'response.completed',
      data: {
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }]
        }
      }
    }
  ]);

  const deltas = [];
  const result = await responsesApiStream({
    baseUrl: 'http://test',
    apiKey: 'k',
    input: 'hi',
    onDelta: (d) => deltas.push(d)
  });

  assert.equal(deltas.join(''), 'Hello world', 'response.completed must not re-emit text already streamed via deltas');
  assert.equal(result.full, 'Hello world');
});

test('responsesApiStream: partial deltas before tools, remainder streamed after (no duplication, no loss)', async () => {
  const { responsesApiStream } = await import('../lib/openai-client.js');

  mockFetchWithEvents([
    { event: 'response.output_text.delta', data: { delta: 'Pre-tool text. ' } },
    { event: 'response.output_item.added', data: { item: { type: 'function_call', name: 'search' } } },
    {
      event: 'response.completed',
      data: {
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Pre-tool text. Post-tool answer.' }] }]
        }
      }
    }
  ]);

  const deltas = [];
  const result = await responsesApiStream({
    baseUrl: 'http://test',
    apiKey: 'k',
    input: 'hi',
    onDelta: (d) => deltas.push(d),
    onToolProgress: () => {}
  });

  assert.equal(deltas.join(''), 'Pre-tool text. Post-tool answer.', 'only the unstreamed remainder should be emitted after response.completed');
  assert.equal(result.full, 'Pre-tool text. Post-tool answer.');
});
