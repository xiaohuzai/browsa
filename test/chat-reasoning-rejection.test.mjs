// test/chat-reasoning-rejection.test.mjs — reasoning-field rejection recovery.
//
// A provider that does not accept the model's reasoning/thinking body fields
// answers 400/422 naming the field (e.g. `{"error":{"message":"Unsupported
// parameter: reasoning"}}`). CHAT must (1) recognise exactly that shape, (2)
// strip the WHOLE reasoning block and retry once without consuming the
// transient-retry ladder, (3) remember provider+model for the rest of the
// browser session — but only after the stripped retry actually succeeded, so
// a one-off bad gateway cannot silence thinking for a whole model.
//
// The classifier's status regex is ANCHORED on purpose: a 500/502 body that
// quotes an upstream "HTTP 400 ... reasoning" inside its text must NOT be
// treated as a reasoning rejection (the unanchored form matched both).
//
// Harness copied from test/chat-turn-ownership.test.mjs:20-90 (minimal chrome
// mock driving the REAL handleChat), with a real in-memory storage.session so
// the per-provider+model memory is observable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// ─── minimal chrome + storage mock (local + in-memory session) ──────────────
const local = {
  history: [],
  providers: {
    llm1: {
      type: 'llm', alias: 'Test', baseUrl: 'http://test', apiKey: 'k',
      model: 'm1', apiStyle: 'chat', stream: true, temperature: null, maxTokens: 0,
      // One raw passthrough carrying every reasoning/thinking body field the
      // strip has to remove, so "whole block gone" is asserted in one shot.
      reasoningRaw: '{"reasoning":{"effort":"high"},"reasoning_effort":"high","enable_thinking":true,"thinking":{"type":"enabled"}}',
    },
  },
  activeProvider: 'llm1',
  activeModel: '',
  autoSummarizeAttachments: false,
};

const session = {};

function installChrome() {
  globalThis.chrome = {
    runtime: { id: 'test', getURL: (p) => 'chrome-extension://test/' + p },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...local };
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of list) if (k in local) out[k] = local[k];
          return out;
        },
        set: async (obj) => { Object.assign(local, obj); },
        remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) delete local[key]; },
      },
      session: {
        get: async (keys) => {
          if (keys == null) return { ...session };
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of list) if (k in session) out[k] = session[k];
          return out;
        },
        set: async (obj) => { Object.assign(session, obj); },
        remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) delete session[key]; },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  };
}

installChrome();

const { handleChat, isReasoningRejection } = await import('../lib/handlers/chat-handler.js');
const {
  streamState, chatControllers, idleTimerResetters, streamPorts,
  initStreamState, clearStreamState,
} = await import('../lib/state.js');

// ─── classifier (pure) ──────────────────────────────────────────────────────

function apiErr(message) {
  const e = new Error(message);
  e.name = 'ProviderAPIError';
  return e;
}

test('isReasoningRejection: anchored 400/422 status + field name + refusal word', () => {
  const cases = [
    // positive: chat / anthropic labels, both status codes, both casings
    [apiErr('HTTP 400: {"error":{"message":"Unsupported parameter: reasoning"}}'), true],
    [apiErr('/v1/messages HTTP 422: thinking.type: invalid'), true],
    [apiErr('HTTP 400: Unrecognized request argument supplied: reasoning_effort'), true],
    // negative: status code or error class wrong
    [apiErr('HTTP 500: unsupported reasoning'), false],
    [apiErr('HTTP 429: reasoning unsupported'), false],
    [apiErr('HTTP 400: maximum context length exceeded'), false],
    // name gate: bridge/opencode throw bare Errors, never ProviderAPIError
    [new Error('HTTP 400: unsupported reasoning'), false],
    // 400 status without a reasoning field named → not ours (e.g. invalid model)
    [apiErr('HTTP 400: {"error":{"message":"invalid model"}}'), false],
    // ANCHORING: a 5xx body quoting an upstream 400 must not match — the
    // unanchored /HTTP (?:400|422)\b/ form matched both of these.
    [apiErr('HTTP 500: {"error":"upstream returned HTTP 400: unsupported reasoning"}'), false],
    [apiErr('HTTP 502: bad gateway (upstream: /v1/responses HTTP 400 unrecognized reasoning_effort)'), false],
  ];
  for (const [err, expected] of cases) {
    assert.equal(isReasoningRejection(err), expected, `isReasoningRejection(${err.message})`);
  }
  // null/garbage must not throw
  assert.equal(isReasoningRejection(null), false);
  assert.equal(isReasoningRejection('HTTP 400: unsupported reasoning'), false);
});

// ─── end-to-end through the REAL handleChat ─────────────────────────────────

function encodeSse(text) {
  return new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":' + JSON.stringify(text) + '},"finish_reason":"stop"}]}\n\n'
  );
}

function okSse(text) {
  return {
    ok: true, status: 200,
    body: new ReadableStream({
      start(c) { c.enqueue(encodeSse(text)); c.close(); },
    }),
    text: async () => '',
  };
}

function httpError(status, text) {
  return { ok: false, status, text: async () => text };
}

function posted(tabId) {
  const out = [];
  streamPorts.set(tabId, { postMessage: (m) => out.push(m) });
  return out;
}

function cleanup(tabId) {
  clearStreamState(tabId);
  streamPorts.delete(tabId);
  chatControllers.delete(tabId);
  idleTimerResetters.delete(tabId);
}

function resetLocal() { local.history = []; }
function resetSession() { for (const k of Object.keys(session)) delete session[k]; }
const memoryKey = (provider, model) => `${provider}\u0000${model}`;
const rejected = () => session['browsa.reasoningRejected'] || {};

const REASONING_BODY_FIELDS = ['reasoning', 'reasoning_effort', 'enable_thinking', 'thinking'];

test('400 naming reasoning: strip the whole block, retry once, remember only after success', async () => {
  resetLocal();
  resetSession();
  const bodies = [];
  globalThis.fetch = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? httpError(400, '{"error":{"message":"Unsupported parameter: reasoning"}}')
      : okSse('recovered');
  };
  const tabId = 21;
  const events = posted(tabId);

  await handleChat({ type: 'CHAT', userText: 'hi', tabId, sessionId: '' }, '', '');

  assert.equal(bodies.length, 2, 'exactly one stripped retry');
  for (const k of REASONING_BODY_FIELDS) {
    assert.ok(k in bodies[0], `first attempt must carry ${k} (the rejection has a field to point at)`);
    assert.equal(k in bodies[1], false, `retry must not carry ${k} — the whole reasoning block is nulled`);
  }
  assert.equal(events.find((e) => e.type === 'DONE').full, 'recovered',
    'the accumulator was reset before the strip retry, so DONE carries only the retried reply');
  assert.equal(events.filter((e) => e.type === 'DONE').length, 1, 'the retried turn finalizes once');
  assert.equal(events.filter((e) => e.type === 'RETRY').length, 0,
    'attempt-- keeps the transient ladder untouched, so no RETRY chunk is pushed');
  assert.equal(events.filter((e) => e.type === 'TOOL_PROGRESS' && e.msgKey === 'reasoningUnsupportedRetry').length, 1,
    'the user is told why the request is being retried');
  assert.equal(rejected()[memoryKey('llm1', 'm1')], 1,
    'provider+model is remembered — only because the stripped retry succeeded');
  cleanup(tabId);
});

test('a remembered provider+model is suppressed from the first attempt of the next turn', async () => {
  resetLocal();
  resetSession();
  session['browsa.reasoningRejected'] = { [memoryKey('llm1', 'm1')]: 1 };
  const bodies = [];
  globalThis.fetch = async (url, opts = {}) => { bodies.push(JSON.parse(opts.body)); return okSse('ok'); };
  const tabId = 22;
  const events = posted(tabId);

  await handleChat({ type: 'CHAT', userText: 'again', tabId, sessionId: '' }, '', '');

  assert.equal(bodies.length, 1, 'no rejection → no retry');
  for (const k of REASONING_BODY_FIELDS) assert.equal(k in bodies[0], false, `suppressed field ${k}`);
  assert.equal(events.filter((e) => e.type === 'DONE').length, 1);
  cleanup(tabId);
});

test('a stripped retry that fails again writes no memory and the next turn still sends reasoning', async () => {
  resetLocal();
  resetSession();
  const bodies = [];
  globalThis.fetch = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? httpError(400, '{"error":{"message":"Unsupported parameter: reasoning"}}')
      : httpError(400, '{"error":{"message":"invalid model"}}');
  };
  const tabId = 23;
  const events = posted(tabId);

  await assert.rejects(
    handleChat({ type: 'CHAT', userText: 'x', tabId, sessionId: '' }, '', ''),
    /invalid model/,
  );

  assert.equal(bodies.length, 2, 'exactly one stripped retry, then the real error surfaces');
  assert.equal(events.filter((e) => e.type === 'ERROR').length, 1);
  assert.equal(rejected()[memoryKey('llm1', 'm1')], undefined,
    'a still-failing turn must not silence the model for the rest of the session');
  // The retry failed → the next turn starts fresh WITH reasoning fields again.
  const freshBodies = [];
  globalThis.fetch = async (url, opts = {}) => { freshBodies.push(JSON.parse(opts.body)); return okSse('ok'); };
  const tabId2 = 24;
  const events2 = posted(tabId2);
  await handleChat({ type: 'CHAT', userText: 'y', tabId: tabId2, sessionId: '' }, '', '');
  assert.ok('reasoning' in freshBodies[0], 'nothing was remembered, so the field is sent again');
  assert.equal(events2.filter((e) => e.type === 'DONE').length, 1);
  cleanup(tabId);
  cleanup(tabId2);
});

test('a 400 that names no reasoning field is not retried and writes no memory', async () => {
  resetLocal();
  resetSession();
  const bodies = [];
  globalThis.fetch = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body));
    return httpError(400, '{"error":{"message":"invalid model"}}');
  };
  const tabId = 25;
  const events = posted(tabId);

  await assert.rejects(
    handleChat({ type: 'CHAT', userText: 'x', tabId, sessionId: '' }, '', ''),
    /invalid model/,
  );

  assert.equal(bodies.length, 1, 'unrelated 400s take the existing throw path');
  assert.equal(events.filter((e) => e.type === 'ERROR').length, 1);
  assert.equal(events.filter((e) => e.type === 'TOOL_PROGRESS').length, 0);
  assert.deepEqual(rejected(), {}, 'nothing remembered');
  cleanup(tabId);
});

test('429 transient retry keeps sending the reasoning fields (no strip)', async () => {
  resetLocal();
  resetSession();
  const bodies = [];
  globalThis.fetch = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? httpError(429, '{"error":{"message":"rate limit"}}')
      : okSse('ok');
  };
  const tabId = 26;
  const events = posted(tabId);

  await handleChat({ type: 'CHAT', userText: 'x', tabId, sessionId: '' }, '', '');

  assert.equal(bodies.length, 2, 'the 429 retry ladder still fires');
  assert.ok('reasoning' in bodies[0] && 'reasoning' in bodies[1],
    'a rate-limit retry must never strip reasoning');
  assert.equal(events.filter((e) => e.type === 'RETRY').length, 1);
  assert.deepEqual(rejected(), {});
  cleanup(tabId);
});

test('a superseded turn\'s reasoning strip pushes nothing into the newer turn\'s port', async () => {
  resetLocal();
  resetSession();
  let releaseFirst;
  let call = 0;
  globalThis.fetch = async (url, opts = {}) => {
    call++;
    if (call === 1) {
      await new Promise((resolve) => { releaseFirst = resolve; });
      return httpError(400, '{"error":{"message":"Unsupported parameter: reasoning"}}');
    }
    return okSse('ok');
  };
  const tabId = 15;
  const events = posted(tabId);

  const turnA = handleChat({ type: 'CHAT', userText: 'from A', tabId, sessionId: '' }, '', '');
  for (let i = 0; i < 200 && !releaseFirst; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(releaseFirst, 'turn A parked inside attempt 1');

  // Supersede BEFORE the 400 arrives: the strip retry now runs unowned.
  const controllerB = new AbortController();
  chatControllers.set(tabId, controllerB);
  const stateB = initStreamState(tabId, { providerLabel: 'Test', originSessionId: '' });
  releaseFirst();
  await turnA;

  assert.equal(events.filter((e) => e.type === 'TOOL_PROGRESS' && e.msgKey === 'reasoningUnsupportedRetry').length, 0,
    'the strip notice belongs to the dead turn — it must not land in the newer bubble');
  assert.equal(events.filter((e) => e.type === 'RETRY').length, 0);
  assert.equal(events.filter((e) => e.type === 'DONE').length, 0);
  assert.equal(streamState.get(tabId), stateB, 'the newer turn\'s accumulator survives the strip reset');
  cleanup(tabId);
});

// ─── catalog read is gated (unit E) ─────────────────────────────────────────
// The models.dev catalog is ~200KB. Only the stateless stream path can ever
// consume it (streamCommon → reasoningFieldsFor), so the read must live AFTER
// the turn kind is decided and be gated on STATELESS_REASONING_KINDS — an
// ungated read would make every agent turn (hermes/opencode/bridge/squilla)
// deserialize the blob for nothing. Source pin, not a runtime test: the cost
// being guarded is exactly "this line runs on the agent path".

test('catalog read is gated to stateless turns and sits after the kind decision', async () => {
  const src = await readFile(new URL('../lib/handlers/chat-handler.js', import.meta.url), 'utf8');
  const gated = 'const modelCatalog = STATELESS_REASONING_KINDS.has(kind) ? await storage.getModelCatalog() : null;';
  const kindAt = src.indexOf('const { kind } = turn;');
  const readAt = src.indexOf(gated);
  assert.ok(kindAt >= 0, 'kind decision present');
  assert.ok(readAt > kindAt, 'the catalog read must come AFTER `const { kind } = turn;`');
  assert.equal((src.match(/await storage\.getModelCatalog\(\)/g) || []).length, 1,
    'exactly one read, and it is the gated one — no ungated catalog read anywhere');

  const sub = await readFile(new URL('../lib/handlers/subchat-handler.js', import.meta.url), 'utf8');
  assert.match(sub, /stateless \? await storage\.getModelCatalog\(\) : null/,
    'SUBCHAT reads the catalog only behind the same stateless-provider gate');
  assert.equal((sub.match(/await storage\.getModelCatalog\(\)/g) || []).length, 1);
});

// ─── catalog vocabulary vs strip: strip wins (unit E) ──────────────────────
// The imported models.dev catalog can supply a vocabulary a provider card never
// had (reasoningDefault:'high' on a model the registry does not know). That
// must NOT resurrect the reasoning object on a turn the strip decision owns —
// stripReasoning is the higher priority.

test('a catalog-supplied vocabulary never resurrects reasoning on a stripped turn', async () => {
  resetLocal();
  resetSession();
  local.modelCatalog = { version: 1, fetchedAt: 1, models: { 'catalog-only': ['low', 'high'] } };
  local.providers.llm2 = {
    type: 'llm', alias: 'Catalog', baseUrl: 'http://catalog', apiKey: 'k',
    model: 'catalog-only', apiStyle: 'chat', stream: true, temperature: null, maxTokens: 0,
    reasoningDefault: 'high',
  };
  local.activeProvider = 'llm2';
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? httpError(400, '{"error":{"message":"Unsupported parameter: reasoning"}}')
      : okSse('ok');
  };
  const tabId = 27;
  const events = posted(tabId);

  try {
    await handleChat({ type: 'CHAT', userText: 'hi', tabId, sessionId: '' }, '', '');
    assert.ok('reasoning' in bodies[0], 'the catalog vocabulary produced a real reasoning body');
    assert.equal('reasoning' in bodies[1], false, 'stripReasoning outranks the catalog');
    assert.equal(events.filter((e) => e.type === 'DONE').length, 1);
  } finally {
    cleanup(tabId);
    delete local.providers.llm2;
    delete local.modelCatalog;
    local.activeProvider = 'llm1';
  }
});
