// test/chat-rebuild-channels.test.mjs
// Behavioral coverage for handleChat's three REBUILD channels + the stateless
// anthropicSystem regression pin.
//
// Why this file exists (C2: behavior tests over source-regex pins): the two
// real chat-handler bugs both lived in the CALL SEQUENCE, not in a pure
// function — ① the continuation/rewrite passes forgot to rebuild the
// responses/anthropic request shapes (the responses channel silently resent
// the ORIGINAL request, regenerating v1 instead of continuing it); ② a bare
// `anthropicSystem` identifier at the dispatch call site threw
// `ReferenceError` on every stateless turn. Both were guarded only by source
// regex pins in chat-handler-internals.test.mjs (assert.match(block/cont/
// rewrite/contFn/rwFn, …) — tests that know the implementation's literal
// text, so every refactor had to touch the tests (negative locality). This
// file drives the REAL handleChat with a stubbed SSE fetch (the seam opened in
// chat-stateless-dispatch.test.mjs) and pins the behavior at the wire: the
// request bodies the provider actually receives. The source pins this
// supersedes were retired from chat-handler-internals.test.mjs; the ones NOT
// covered here (CHOICE_REQUEST/gate literal lockstep, _stCont accumulator
// semantics) stayed put.
//
// Channels under test, per apiStyle:
//   continuation   (finish_reason=length → one silent continue pass)  chat /
//                  responses / anthropic end-to-end; Hermes /v1/runs has no
//                  finishReason wire signal (runsApiStream never returns one),
//                  so its turn.continueWith mirror is pinned at the
//                  createTurnRequest seam instead ("尽力覆盖").
//   timestamp-rewrite (video notes → silent reformat pass)            chat /
//                  responses / anthropic / hermes — the rewrite history must
//                  come from the RAW history's videoSrc entry
//                  (buildTimestampRewriteHistory), NOT the context-aged copy.
//   overflow rescue (context overflow → stub oversized attach → retry) chat /
//                  responses / anthropic / hermes.
//   anthropicSystem: a plain anthropic turn completes and the system prompt
//                  really reaches /v1/messages (②号 bug's regression pin).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- in-memory chrome.storage areas (same pattern as chat-stateless-dispatch)
// get/set structuredClone like the real chrome.storage (de)serialization: a
// live-reference mock leaks in-place mutations across reads — appendToHistory
// pushing into the SAME array `sendHistory` holds grew the continuation
// request by one turn in a first draft of this file.
function makeStorageArea() {
  let store = {};
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  return {
    async get(keys) {
      if (keys == null) return clone(store);
      if (typeof keys === 'string') return { [keys]: clone(store[keys]) };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = clone(store[k]);
        return out;
      }
      return clone(store);
    },
    async set(obj) { store = { ...store, ...clone(obj) }; },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
    _reset() { store = {}; },
  };
}

const localArea = makeStorageArea();
const sessionArea = makeStorageArea();

Object.defineProperty(globalThis, 'chrome', {
  value: {
    storage: { local: localArea, session: sessionArea, onChanged: { addListener: () => {} } },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } },
    runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} },
  },
  writable: true,
  configurable: true,
});

const { handleChat } = await import('../lib/handlers/chat-handler.js');
const { createTurnRequest } = await import('../lib/handlers/turn-request.js');
const { streamPorts } = await import('../lib/state.js');
const { PAGE_CONTEXT_PREFIX } = await import('../lib/constants.js');

const HINTS = 'CAP-HINTS-MARKER';

// ---- wire stubs ------------------------------------------------------------
function sseResponse(events) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, headers: { get: () => 'text/event-stream' } };
}

function httpError(status, text) {
  return { ok: false, status, body: null, text: async () => text, headers: { get: () => '' } };
}

// One chat-completions SSE leg: `text` then a final chunk carrying finish_reason.
function chatLeg({ text = '', finish = 'stop' } = {}) {
  const events = [];
  if (text) events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
  events.push('data: [DONE]\n\n');
  return sseResponse(events);
}

// One /v1/responses SSE leg. `truncated` = incomplete_details.max_output_tokens.
function responsesLeg({ text = '', truncated = false } = {}) {
  const events = [];
  if (text) events.push(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
  const resp = { usage: { input_tokens: 10, output_tokens: 2 } };
  if (truncated) resp.incomplete_details = { reason: 'max_output_tokens' };
  events.push(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: resp })}\n\n`);
  return sseResponse(events);
}

// One /v1/messages SSE leg. `truncated` = stop_reason max_tokens.
function anthropicLeg({ text = '', truncated = false } = {}) {
  const events = [];
  if (text) events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
  events.push(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: truncated ? 'max_tokens' : 'end_turn' }, usage: { input_tokens: 10, output_tokens: 2 } })}\n\n`);
  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return sseResponse(events);
}

// Hermes /v1/runs: the POST returns a run id, the GET streams events.
function hermesRunCreated(runId) {
  return { ok: true, status: 200, json: async () => ({ run_id: runId }), text: async () => '' };
}
function hermesEventsLeg({ text = '' } = {}) {
  return sseResponse([
    `event: message.delta\ndata: ${JSON.stringify({ delta: text })}\n\n`,
    `event: run.completed\ndata: ${JSON.stringify({ output: text, usage: { input_tokens: 10, output_tokens: 2 } })}\n\n`,
  ]);
}

// Install a scripted fetch that records every request body for shape asserts.
function installFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// Capture the chunks handleChat pushes to the side panel (pushChunk → port).
function captureChunks(tabId) {
  const chunks = [];
  streamPorts.set(tabId, { postMessage: (p) => chunks.push(p) });
  return { chunks, release: () => streamPorts.delete(tabId) };
}

const chunkText = (chunks) => chunks.filter((c) => c.type === 'CHUNK').map((c) => c.delta || '').join('');
const doneChunk = (chunks) => chunks.find((c) => c.type === 'DONE');

// Normalize wire turns to [role, text] so Anthropic's cache_control wrapping of
// the last message (content: [{type:'text', …}]) compares like plain strings.
const textOf = (m) => (typeof m?.content === 'string'
  ? m.content
  : (Array.isArray(m?.content) ? m.content : [])
      .filter((p) => p && (p.type === 'text' || p.type === 'input_text'))
      .map((p) => p.text || '')
      .join('\n'));
const normTurns = (entries) => (entries || []).map((m) => [m.role, textOf(m)]);

async function seedProvider(entry) {
  localArea._reset();
  sessionArea._reset();
  await localArea.set({ providers: { p1: entry }, activeProvider: 'p1' });
}

const CHAT_PROVIDER = { type: 'llm', alias: 'MyLLM', baseUrl: 'https://api.test/v1', apiKey: 'k-test', apiStyle: 'chat' };
const RESPONSES_PROVIDER = { type: 'llm', alias: 'Resp', baseUrl: 'https://resp.test/v1', apiKey: 'k-test', apiStyle: 'responses' };
const ANTHROPIC_PROVIDER = { type: 'llm', alias: 'Anti', baseUrl: 'https://anti.test/v1', apiKey: 'k-test', apiStyle: 'anthropic' };
const HERMES_PROVIDER = { type: 'llm', alias: 'Hermes', baseUrl: 'https://hermes.test', apiKey: 'k-test', isHermes: true };

// The continuation instruction the second leg must carry.
const CONT_INSTRUCTION_RE = /Continue exactly from where your reply above was cut off/;
const CONT_NOREPEAT_RE = /Do NOT repeat any content already written/;
const REWRITE_INSTRUCTION_RE = /\[mm:ss\]/;

const OVERFLOW_OPENAI = "This model's maximum context length is 16385 tokens. However, your messages resulted in 24500 tokens.";
const OVERFLOW_ANTHROPIC = 'prompt is too long: 357005 tokens > 200000 maximum';

// =============================================================================
// anthropicSystem — ②号 bug 的回归钉（本批最重要的一条）
// =============================================================================

test('stateless anthropic turn completes and anthropicSystem reaches the wire (ReferenceError regression pin)', async () => {
  // The dispatch used to reference a bare `anthropicSystem` identifier — a
  // ReferenceError on EVERY stateless turn. Pin both halves of the fix: the
  // turn must complete, and the system prompt must actually ride the
  // /v1/messages body (a rebuild that drops `system` is the same bug class).
  await seedProvider(ANTHROPIC_PROVIDER);
  const { calls, restore } = installFetch(() => anthropicLeg({ text: 'ok' }));
  const cap = captureChunks(43);
  try {
    const result = await handleChat({ tabId: 43, userText: 'ping' }, HINTS, '');
    assert.equal(result.full, 'ok');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/messages$/);
    assert.ok(JSON.stringify(calls[0].body.system).includes(HINTS),
      'anthropicSystem must be assembled and sent as the top-level system field');
  } finally {
    cap.release();
    restore();
  }
});

// =============================================================================
// Channel 1: continuation (finish_reason=length → silent continue pass)
// Second request must carry the MERGED conversation (system + history + user
// turn + v1 + continue instruction) — never a resend of the original request.
// =============================================================================

test('continuation (chat): second request carries the merged conversation, not the original', async () => {
  await seedProvider(CHAT_PROVIDER);
  await localArea.set({
    history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
  });
  const V1 = 'V1-PARTIAL-CUT';
  const V2 = 'V2-CONTINUATION';
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? chatLeg({ text: V1, finish: 'length' })
    : chatLeg({ text: V2, finish: 'stop' })));
  const cap = captureChunks(42);
  try {
    const result = await handleChat({ tabId: 42, userText: 'long notes please' }, HINTS, '');
    assert.equal(calls.length, 2, 'truncated reply must trigger exactly one continuation request');
    assert.match(calls[1].url, /chat\/completions$/);

    // Merged, not resent: the second request is the first plus v1 plus the
    // continue instruction (the old bug sent `messages` identical to call 1).
    assert.equal(calls[1].body.messages.length, calls[0].body.messages.length + 2);
    assert.deepEqual(calls[1].body.messages.slice(0, calls[0].body.messages.length), calls[0].body.messages);
    assert.deepEqual(calls[1].body.messages[calls[1].body.messages.length - 2],
      { role: 'assistant', content: V1 }, 'the model must see its own partial reply');
    const last = calls[1].body.messages[calls[1].body.messages.length - 1];
    assert.equal(last.role, 'user');
    assert.match(last.content, CONT_INSTRUCTION_RE);
    assert.match(last.content, CONT_NOREPEAT_RE, 'anti-repetition instruction must ride the continue ask');

    assert.equal(result.full, V1 + V2, 'continuation merges into the reply (resumes mid-sentence)');
    assert.equal(chunkText(cap.chunks), V1, 'the continue pass is silent — its deltas must not reach the UI');
    assert.ok(cap.chunks.some((c) => c.type === 'TS_STATUS'), 'a TS_STATUS progress chip must precede the silent pass');
    assert.ok(!('outputTruncated' in doneChunk(cap.chunks)), 'a cleanly-finished continuation clears the truncation flag');
  } finally {
    cap.release();
    restore();
  }
});

test('continuation (responses): input is rebuilt with v1 + the continue instruction', async () => {
  // The exact regression: continuation used to rebuild ONLY chat messages, so
  // /v1/responses providers resent the ORIGINAL input and regenerated v1.
  await seedProvider(RESPONSES_PROVIDER);
  await localArea.set({
    history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
  });
  const V1 = 'V1-PARTIAL-CUT';
  const V2 = 'V2-CONTINUATION';
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? responsesLeg({ text: V1, truncated: true })
    : responsesLeg({ text: V2 })));
  const cap = captureChunks(44);
  try {
    const result = await handleChat({ tabId: 44, userText: 'long notes please' }, HINTS, '');
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/v1\/responses$/);
    assert.equal(calls[1].body.input.length, calls[0].body.input.length + 2);
    assert.deepEqual(calls[1].body.input.slice(0, calls[0].body.input.length), calls[0].body.input);
    assert.deepEqual(calls[1].body.input[calls[1].body.input.length - 2],
      { role: 'assistant', content: V1 }, 'responses input must be rebuilt with v1 appended (was a resend of the original)');
    const last = calls[1].body.input[calls[1].body.input.length - 1];
    assert.equal(last.role, 'user');
    assert.match(last.content, CONT_INSTRUCTION_RE);
    assert.match(last.content, CONT_NOREPEAT_RE);
    assert.equal(result.full, V1 + V2);
  } finally {
    cap.release();
    restore();
  }
});

test('continuation (anthropic): messages rebuilt with v1 + instruction, anthropicSystem kept', async () => {
  await seedProvider(ANTHROPIC_PROVIDER);
  await localArea.set({
    history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
  });
  const V1 = 'V1-PARTIAL-CUT';
  const V2 = 'V2-CONTINUATION';
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? anthropicLeg({ text: V1, truncated: true })
    : anthropicLeg({ text: V2 })));
  const cap = captureChunks(45);
  try {
    const result = await handleChat({ tabId: 45, userText: 'long notes please' }, HINTS, '');
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/v1\/messages$/);

    const t0 = normTurns(calls[0].body.messages);
    const t1 = normTurns(calls[1].body.messages);
    assert.equal(t1.length, t0.length + 2);
    assert.deepEqual(t1.slice(0, t0.length), t0);
    assert.deepEqual(t1[t1.length - 2], ['assistant', V1]);
    assert.equal(t1[t1.length - 1][0], 'user');
    assert.match(t1[t1.length - 1][1], CONT_INSTRUCTION_RE);
    assert.match(t1[t1.length - 1][1], CONT_NOREPEAT_RE);
    assert.equal(result.full, V1 + V2);

    // The rebuild must not drop the system prompt (same bug class as the bare
    // identifier: a continuation that forgets `system` degrades every pass).
    assert.ok(JSON.stringify(calls[0].body.system).includes(HINTS));
    assert.ok(JSON.stringify(calls[1].body.system).includes(HINTS),
      'anthropicSystem must survive the continuation rebuild');
  } finally {
    cap.release();
    restore();
  }
});

test('continuation runs before the timestamp rewrite (the rewrite sees the merged text)', async () => {
  // Both triggers at once: truncated reply AND a video-notes request whose
  // text lacks [mm:ss]. Continuation must run FIRST — the rewrite operates on
  // v1+v2, so its rebuilt history must hold the merged assistant turn.
  await seedProvider(CHAT_PROVIDER);
  const RAW_MARKER = 'RAW-TRANSCRIPT-MARKER-77';
  await localArea.set({ history: videoHistory(RAW_MARKER) });
  const V1 = 'V1-NOTES-BODY ' + 'a'.repeat(60);
  const V2 = 'V2-MORE-NOTES ' + 'b'.repeat(30);
  const V3 = 'V3-FINAL [00:01] done';
  const { calls, restore } = installFetch((call, i) => {
    if (i === 0) return chatLeg({ text: V1, finish: 'length' });
    if (i === 1) return chatLeg({ text: V2, finish: 'stop' });
    return chatLeg({ text: V3, finish: 'stop' });
  });
  const cap = captureChunks(46);
  try {
    const result = await handleChat({ tabId: 46, userText: '总结一下这个视频' }, HINTS, '');
    assert.equal(calls.length, 3, 'continuation pass then rewrite pass');
    // The rewrite request (3rd) carries the MERGED v1+v2 as the assistant turn
    // — proof the continuation ran first and the rewrite rebuilt from it.
    const rewriteNorm = normTurns(calls[2].body.messages);
    const merged = rewriteNorm.find(([role, text]) => role === 'assistant' && text.includes('V1-NOTES-BODY'));
    assert.ok(merged, 'the rewrite conversation must hold the v1 assistant turn');
    assert.ok(merged[1].includes('V2-MORE-NOTES'), 'the rewrite must see the MERGED v1+v2 (continuation ran first)');
    assert.equal(result.full, V3, 'rewrite output replaces the bubble wholesale');
  } finally {
    cap.release();
    restore();
  }
});

test('continuation hops once: a still-truncated continuation surfaces outputTruncated, no third request', async () => {
  await seedProvider(CHAT_PROVIDER);
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? chatLeg({ text: 'V1-CUT', finish: 'length' })
    : chatLeg({ text: 'V2-ALSO-CUT', finish: 'length' })));
  const cap = captureChunks(47);
  try {
    const result = await handleChat({ tabId: 47, userText: 'keep going' }, HINTS, '');
    assert.equal(calls.length, 2, 'one continuation hop only (cost/latency bound)');
    assert.equal(result.full, 'V1-CUTV2-ALSO-CUT');
    assert.equal(doneChunk(cap.chunks).outputTruncated, true,
      'still-truncated flag re-derived from the continuation leg → the UI keeps its continue hint');
  } finally {
    cap.release();
    restore();
  }
});

test('no continuation when the first reply ends normally (gate on finish_reason)', async () => {
  await seedProvider(CHAT_PROVIDER);
  const { calls, restore } = installFetch(() => chatLeg({ text: 'a complete reply', finish: 'stop' }));
  const cap = captureChunks(48);
  try {
    await handleChat({ tabId: 48, userText: 'hi' }, HINTS, '');
    assert.equal(calls.length, 1, 'a cleanly-finished reply must not trigger a continuation request');
  } finally {
    cap.release();
    restore();
  }
});

test('hermes mirror: turn.continueWith rebuilds runsInput + conversation_history (best-effort — runs has no finishReason signal)', async () => {
  // runsApiStream never returns finishReason, so the Hermes continuation leg is
  // unreachable through the wire — pin its rebuild at the turn-request seam
  // (the same object handleChat calls) instead. Stateless kinds are pinned
  // end-to-end above.
  await seedProvider(HERMES_PROVIDER);
  const turn = createTurnRequest({
    provider: HERMES_PROVIDER,
    activeProvider: 'p1',
    all: { activeProvider: 'p1', providers: { p1: HERMES_PROVIDER } },
    msg: { userText: 'Q-ORIG' },
    sendHistory: [{ role: 'user', content: 'prior' }],
    effectiveSystemPrompt: 'SYS',
  });
  await turn.prepare();
  assert.deepEqual(turn.runsConvHistory, [{ role: 'user', content: 'prior' }]);
  turn.continueWith('CONT-INSTRUCTION', 'V1-PARTIAL');
  assert.equal(turn.runsInput, 'CONT-INSTRUCTION', 'the continue ask becomes the run input');
  assert.deepEqual(turn.runsConvHistory, [
    { role: 'user', content: 'prior' },
    { role: 'user', content: 'Q-ORIG' },
    { role: 'assistant', content: 'V1-PARTIAL' },
  ], 'conversation_history must be rebuilt with the user turn + v1 appended');
});

// =============================================================================
// Channel 2: timestamp-rewrite (video notes → silent reformat pass)
// The rewrite history comes from the RAW history's videoSrc entry
// (buildTimestampRewriteHistory) — never the context-aged copy — trimmed to
// video entry + this turn + v1.
// =============================================================================

// A history whose video attach has gone COLD for the aging pass (not the
// newest attach, ≥3 user turns behind it, ≥8000 chars) — so `sendHistory` is a
// stub while the RAW entry still holds the transcript the rewrite must see.
function videoHistory(rawMarker = 'RAW-TRANSCRIPT-MARKER-77', newerMarker = 'NEWER-PAGE-MARKER-88') {
  const transcript = `${PAGE_CONTEXT_PREFIX}\nURL: https://youtu.be/x\nTitle: Talk\n${rawMarker} ` + 't'.repeat(8200);
  return [
    { role: 'user', content: transcript, videoSrc: { tabId: 7, url: 'https://youtu.be/x' }, attachId: 'att-video' },
    { role: 'assistant', content: 'ack' },
    { role: 'user', content: `${PAGE_CONTEXT_PREFIX}\nURL: https://newer.example/\n${newerMarker}`, attachId: 'att-newer' },
    { role: 'assistant', content: 'ok-1' },
    { role: 'user', content: 'q-1' },
    { role: 'assistant', content: 'a-1' },
    { role: 'user', content: 'q-2' },
  ];
}
const RAW_MARKER = 'RAW-TRANSCRIPT-MARKER-77';
const NEWER_MARKER = 'NEWER-PAGE-MARKER-88';
const V1_NOTES = 'V1-NOTES-WITHOUT-TIMESTAMPS ' + 'n'.repeat(60);

// Shared shape asserts for a rewrite request given its normalized turns.
// `instructionLast` is false for Hermes /v1/runs, where the rewrite ask rides
// the top-level `input` field and conversation_history ends at v1.
function assertRewriteShape(t, calls0Text, { instructionLast = true } = {}) {
  const raw = t.find(([role, text]) => text.includes(RAW_MARKER));
  assert.ok(raw, 'the rewrite request must carry the RAW video transcript (buildTimestampRewriteHistory reads the raw history)');
  assert.ok(!calls0Text.includes(RAW_MARKER), 'the transcript must be aged OUT of the normal send (contrast: raw vs aged)');
  assert.ok(calls0Text.includes('trimmed to keep replies fast'), 'the first request carries the aged stub instead');
  const v1 = t.find(([role, text]) => role === 'assistant' && text.includes('V1-NOTES'));
  assert.ok(v1, 'the model must see its own v1 notes in the rewrite conversation');
  const userTurn = t.find(([role, text]) => role === 'user' && text === '总结一下这个视频');
  assert.ok(userTurn, "the rewrite conversation must carry this turn's user ask");
  if (instructionLast) {
    assert.match(t[t.length - 1][1], REWRITE_INSTRUCTION_RE, 'the last turn is the reformat instruction');
  }
  const all = JSON.stringify(t);
  assert.ok(!all.includes(NEWER_MARKER) && !all.includes('q-2'),
    'rewrite history is trimmed to video entry + this turn + v1 (not the whole session)');
}

test('timestamp-rewrite (chat): rebuilt from the RAW video entry + v1, trimmed, silent', async () => {
  await seedProvider(CHAT_PROVIDER);
  await localArea.set({ history: videoHistory() });
  const V2 = 'V2-REWRITTEN [00:01] done';
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? chatLeg({ text: V1_NOTES, finish: 'stop' })
    : chatLeg({ text: V2, finish: 'stop' })));
  const cap = captureChunks(50);
  try {
    const result = await handleChat({ tabId: 50, userText: '总结一下这个视频' }, HINTS, '');
    assert.equal(calls.length, 2, 'a timestamp-less notes reply on a video page triggers exactly one rewrite request');
    assertRewriteShape(normTurns(calls[1].body.messages), JSON.stringify(calls[0].body.messages));
    assert.equal(result.full, V2, 'the rewritten text replaces the reply wholesale');
    assert.equal(chunkText(cap.chunks), V1_NOTES, 'rewrite pass is silent (v1 stays on screen until DONE swaps it)');
    assert.ok(cap.chunks.some((c) => c.type === 'TS_STATUS'), 'TS_STATUS chip announces the rewrite');
  } finally {
    cap.release();
    restore();
  }
});

test('timestamp-rewrite (responses): input rebuilt from the RAW video entry + v1', async () => {
  await seedProvider(RESPONSES_PROVIDER);
  await localArea.set({ history: videoHistory() });
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? responsesLeg({ text: V1_NOTES })
    : responsesLeg({ text: 'V2-REWRITTEN [00:01] done' })));
  const cap = captureChunks(51);
  try {
    await handleChat({ tabId: 51, userText: '总结一下这个视频' }, HINTS, '');
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/v1\/responses$/);
    assertRewriteShape(normTurns(calls[1].body.input), JSON.stringify(calls[0].body.input));
  } finally {
    cap.release();
    restore();
  }
});

test('timestamp-rewrite (anthropic): messages rebuilt from the RAW video entry, anthropicSystem kept', async () => {
  await seedProvider(ANTHROPIC_PROVIDER);
  await localArea.set({ history: videoHistory() });
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? anthropicLeg({ text: V1_NOTES })
    : anthropicLeg({ text: 'V2-REWRITTEN [00:01] done' })));
  const cap = captureChunks(52);
  try {
    await handleChat({ tabId: 52, userText: '总结一下这个视频' }, HINTS, '');
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/v1\/messages$/);
    assertRewriteShape(normTurns(calls[1].body.messages), JSON.stringify(calls[0].body.messages));
    assert.ok(JSON.stringify(calls[1].body.system).includes(HINTS),
      'anthropicSystem must survive the rewrite rebuild');
  } finally {
    cap.release();
    restore();
  }
});

test('timestamp-rewrite (hermes): /v1/runs rebuilt with RAW transcript + v1 in conversation_history', async () => {
  await seedProvider(HERMES_PROVIDER);
  await localArea.set({ history: videoHistory() });
  let run = 0;
  const { calls, restore } = installFetch((call) => {
    if (call.method === 'POST') return hermesRunCreated(`run_${++run}`);
    return hermesEventsLeg({ text: run === 1 ? V1_NOTES : 'V2-REWRITTEN [00:01] done' });
  });
  const cap = captureChunks(53);
  try {
    const result = await handleChat({ tabId: 53, userText: '总结一下这个视频' }, HINTS, '');
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 2, 'one /v1/runs submission per pass');
    assert.match(posts[1].body.input, REWRITE_INSTRUCTION_RE, 'the rewrite ask becomes the run input');
    assertRewriteShape(normTurns(posts[1].body.conversation_history), JSON.stringify(posts[0].body.conversation_history),
      { instructionLast: false });
    assert.equal(result.full, 'V2-REWRITTEN [00:01] done');
  } finally {
    cap.release();
    restore();
  }
});

test('timestamp-rewrite failure keeps v1 (the reply the user already saw)', async () => {
  await seedProvider(CHAT_PROVIDER);
  await localArea.set({ history: videoHistory() });
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? chatLeg({ text: V1_NOTES, finish: 'stop' })
    : httpError(502, 'upstream exploded')));
  const cap = captureChunks(54);
  try {
    const result = await handleChat({ tabId: 54, userText: '总结一下这个视频' }, HINTS, '');
    assert.equal(calls.length, 2);
    assert.equal(result.full, V1_NOTES, 'a failed rewrite must keep v1, never discard it');
    assert.equal(doneChunk(cap.chunks).full, V1_NOTES);
  } finally {
    cap.release();
    restore();
  }
});

// =============================================================================
// Channel 3: overflow self-rescue (context overflow → stub oversized attach →
// one retry). The retried request must carry the stub, drop the attachment
// images, and storage is only rewritten after the retry succeeds.
// =============================================================================

const BIG_MARKER = 'BIG-ATTACH-MARKER-55';
const STUB_MARKER = /was too large for the model's context window/;

function bigAttachHistory() {
  const text = `${PAGE_CONTEXT_PREFIX}\nURL: https://big.example/doc\nTitle: BigDoc\n${BIG_MARKER} ` + 'x'.repeat(8200);
  return [
    {
      role: 'user',
      attachId: 'att-big',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,IMGPIX' } },
      ],
    },
    { role: 'assistant', content: 'ready' },
  ];
}

function assertStubbed(bodyObj, label) {
  const s = JSON.stringify(bodyObj);
  assert.ok(!s.includes(BIG_MARKER), `${label}: the raw attachment text must be stubbed out`);
  assert.ok(!s.includes('IMGPIX'), `${label}: attachment image parts must be dropped (they alone can be ~15K tokens)`);
  assert.match(s, STUB_MARKER, `${label}: the stub keeps a labeled placeholder`);
  assert.ok(s.includes('https://big.example/doc'), `${label}: the stub keeps the URL so the model can ask to re-attach`);
}

test('overflow rescue (chat): the retried request carries the stub and drops attachment images', async () => {
  await seedProvider(CHAT_PROVIDER);
  await localArea.set({ history: bigAttachHistory() });
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? httpError(400, OVERFLOW_OPENAI)
    : chatLeg({ text: 'STUBBED-ANSWER', finish: 'stop' })));
  const cap = captureChunks(55);
  try {
    const result = await handleChat({ tabId: 55, userText: 'What does the document say?' }, HINTS, '');
    assert.equal(calls.length, 2, 'one overflow rescue retry');
    const s0 = JSON.stringify(calls[0].body);
    assert.ok(s0.includes(BIG_MARKER) && s0.includes('IMGPIX'), 'the first request carries the raw attachment + images');
    assertStubbed(calls[1].body, 'retry');
    assert.ok(cap.chunks.some((c) => c.type === 'TOOL_PROGRESS' && /已临时裁剪大附件/.test(c.text || '')),
      'the user is told the attachments were trimmed');
    assert.equal(result.full, 'STUBBED-ANSWER');

    // Storage is rewritten ONLY after the retry succeeded (attachId-keyed).
    const { history } = await localArea.get('history');
    const stored = history.find((m) => m.attachId === 'att-big');
    assert.ok(!JSON.stringify(stored).includes(BIG_MARKER), 'the stub is persisted to history on success');
    assert.match(stored.content, STUB_MARKER);
  } finally {
    cap.release();
    restore();
  }
});

test('overflow rescue keeps the raw attachment in storage when the retry also fails', async () => {
  await seedProvider(CHAT_PROVIDER);
  await localArea.set({ history: bigAttachHistory() });
  const { calls, restore } = installFetch(() => httpError(400, OVERFLOW_OPENAI));
  const cap = captureChunks(56);
  try {
    await assert.rejects(
      () => handleChat({ tabId: 56, userText: 'What does the document say?' }, HINTS, ''),
      /maximum context length/,
    );
    const { history } = await localArea.get('history');
    const stored = history.find((m) => m.attachId === 'att-big');
    assert.ok(JSON.stringify(stored).includes(BIG_MARKER),
      'a still-failing turn must never destroy the raw attachment text');
  } finally {
    cap.release();
    restore();
  }
});

test('overflow rescue (responses): rebuildFrom rebuilds the responses input from the stubbed history', async () => {
  await seedProvider(RESPONSES_PROVIDER);
  await localArea.set({ history: bigAttachHistory() });
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? httpError(400, OVERFLOW_OPENAI)
    : responsesLeg({ text: 'STUBBED-ANSWER' })));
  const cap = captureChunks(57);
  try {
    const result = await handleChat({ tabId: 57, userText: 'What does the document say?' }, HINTS, '');
    assert.equal(calls.length, 2);
    assert.ok(JSON.stringify(calls[0].body.input).includes(BIG_MARKER));
    assertStubbed(calls[1].body.input, 'responses retry');
    assert.equal(result.full, 'STUBBED-ANSWER');
  } finally {
    cap.release();
    restore();
  }
});

test('overflow rescue (anthropic): rebuildFrom rebuilds the messages and keeps anthropicSystem', async () => {
  await seedProvider(ANTHROPIC_PROVIDER);
  await localArea.set({ history: bigAttachHistory() });
  const { calls, restore } = installFetch((call, i) => (i === 0
    ? httpError(400, OVERFLOW_ANTHROPIC)
    : anthropicLeg({ text: 'STUBBED-ANSWER' })));
  const cap = captureChunks(58);
  try {
    const result = await handleChat({ tabId: 58, userText: 'What does the document say?' }, HINTS, '');
    assert.equal(calls.length, 2);
    assert.ok(JSON.stringify(calls[0].body.messages).includes(BIG_MARKER));
    assertStubbed(calls[1].body.messages, 'anthropic retry');
    assert.ok(JSON.stringify(calls[1].body.system).includes(HINTS),
      'anthropicSystem must survive the overflow rebuild');
    assert.equal(result.full, 'STUBBED-ANSWER');
  } finally {
    cap.release();
    restore();
  }
});

test('overflow rescue (hermes): rebuildFrom rebuilds conversation_history from the stubbed history', async () => {
  await seedProvider(HERMES_PROVIDER);
  await localArea.set({ history: bigAttachHistory() });
  let run = 0;
  const { calls, restore } = installFetch((call) => {
    if (call.method === 'POST') {
      run += 1;
      return run === 1 ? httpError(400, OVERFLOW_ANTHROPIC) : hermesRunCreated('run_ok');
    }
    return hermesEventsLeg({ text: 'STUBBED-ANSWER' });
  });
  const cap = captureChunks(59);
  try {
    const result = await handleChat({ tabId: 59, userText: 'What does the document say?' }, HINTS, '');
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 2);
    assert.ok(JSON.stringify(posts[0].body.conversation_history).includes(BIG_MARKER));
    assertStubbed(posts[1].body.conversation_history, 'hermes retry');
    assert.equal(posts[1].body.input, 'What does the document say?', 'the current-turn input is untouched by the stub');
    assert.equal(result.full, 'STUBBED-ANSWER');
  } finally {
    cap.release();
    restore();
  }
});
