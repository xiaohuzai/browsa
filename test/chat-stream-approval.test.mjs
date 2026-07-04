// test/chat-stream-approval.test.mjs
// Regression coverage for chatStream() (/v1/chat/completions) approval and
// clarification handling. Hermes gates dangerous tools (execute_code,
// terminal, ...) behind an approval flow on /v1/chat/completions too, not
// just /v1/runs — without this handling, a dangerous tool call just hangs
// waiting for a response that never comes, and the agent reports it as
// "blocked" (see hermes-agent tools/approval.py: check_dangerous_command()
// returns {approved: false, status: "approval_required"} for platform=
// "api_server", the same platform both /v1/runs and /v1/chat/completions use).

import { test } from 'node:test';
import assert from 'node:assert/strict';

function buildSseStream(blocks) {
  const encoder = new TextEncoder();
  let text = '';
  for (const b of blocks) {
    if (b.event) text += `event: ${b.event}\n`;
    text += `data: ${JSON.stringify(b.data)}\n\n`;
  }
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

function mockFetchWithStream(blocks) {
  globalThis.fetch = async () => ({
    ok: true, status: 200, body: buildSseStream(blocks), text: async () => ''
  });
}

test('chatStream: approval.request invokes onApproval with the parsed payload', async () => {
  const { chatStream } = await import('../lib/openai-client.js');
  mockFetchWithStream([
    { event: 'approval.request', data: { tool: 'terminal', command: 'rm -rf /tmp/x', approval_id: 'appr_1', run_id: 'run_9', risk_level: 'high' } },
    { data: { choices: [{ delta: { content: 'done' } }] } },
  ]);

  let seen = null;
  const result = await chatStream({
    baseUrl: 'http://test', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }],
    onDelta: () => {},
    onApproval: (data) => { seen = data; },
  });

  assert.ok(seen, 'onApproval must be called');
  assert.equal(seen.tool, 'terminal');
  assert.equal(seen.approval_id, 'appr_1');
  assert.equal(seen.run_id, 'run_9', 'run_id must come through from the raw payload (chatStream has no separate run-creation step)');
  assert.equal(result.full, 'done');
});

test('chatStream: hermes.approval.request (legacy event name alias) also invokes onApproval', async () => {
  const { chatStream } = await import('../lib/openai-client.js');
  mockFetchWithStream([
    { event: 'hermes.approval.request', data: { tool: 'execute_code', approval_id: 'appr_2' } },
    { data: { choices: [{ delta: { content: 'ok' } }] } },
  ]);

  let seen = null;
  await chatStream({
    baseUrl: 'http://test', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }],
    onDelta: () => {},
    onApproval: (data) => { seen = data; },
  });

  assert.ok(seen, 'onApproval must be called for the hermes.approval.request alias too');
  assert.equal(seen.tool, 'execute_code');
});

test('chatStream: clarification.request invokes onClarify, not onApproval', async () => {
  const { chatStream } = await import('../lib/openai-client.js');
  mockFetchWithStream([
    { event: 'clarification.request', data: { question: 'Which file?', clarify_id: 'clar_1' } },
    { data: { choices: [{ delta: { content: 'ok' } }] } },
  ]);

  let approvalCalled = false;
  let clarifySeen = null;
  await chatStream({
    baseUrl: 'http://test', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }],
    onDelta: () => {},
    onApproval: () => { approvalCalled = true; },
    onClarify: (data) => { clarifySeen = data; },
  });

  assert.equal(approvalCalled, false, 'onApproval must not fire for a clarification event');
  assert.ok(clarifySeen, 'onClarify must be called');
  assert.equal(clarifySeen.question, 'Which file?');
});

test('chatStream: without onApproval/onClarify callbacks, approval events are safely ignored (no crash, delta still flows)', async () => {
  const { chatStream } = await import('../lib/openai-client.js');
  mockFetchWithStream([
    { event: 'approval.request', data: { tool: 'terminal' } },
    { data: { choices: [{ delta: { content: 'still works' } }] } },
  ]);

  const deltas = [];
  const result = await chatStream({
    baseUrl: 'http://test', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }],
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(deltas.join(''), 'still works');
  assert.equal(result.full, 'still works');
});
