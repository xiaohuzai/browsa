// test/options-provider-ping.test.mjs — real execution test of options.js's
// provider ping flow, plus direct tests of lib/llm-client.js's ping()/
// getCapabilities() (previously zero coverage anywhere in the suite).
//
// This is the highest-stakes untested surface in the codebase per project
// memory ("Provider 规则（绝对不能搞错！）"): Hermes/Claude Code (agent
// providers, no Model ID field, ping via /health) vs OpenAI-compatible
// (llm provider, Model ID required, ping via a real max_tokens:1 request)
// must never get their validation/ping rules crossed, and pingCard()'s
// isHermes auto-detection (via /v1/capabilities' run_submission &&
// run_events_sse) drives which streaming API background.js uses for the
// whole session.
//
// options.js has zero exports (same as sidepanel.js) — it calls init()
// unconditionally at module load and only exposes behavior through DOM
// events. So, same convention as test/lib-sidepanel-streaming.test.mjs:
// load the real options.html into jsdom, mock chrome.storage.local +
// global fetch, import the real module, and drive it via simulated clicks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

// --------------- direct tests of lib/llm-client.js's ping()/getCapabilities() ---

function mockFetchSequence(handlers) {
  // handlers: array of (url, opts) => response-like object | throws
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    const h = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return h(String(url), opts);
  };
}

test('ping(): no model, no apiKey — /health ok is sufficient (no /v1/models call)', async () => {
  const { ping } = await import('../lib/llm-client.js');
  let modelsCalled = false;
  mockFetchSequence([
    (url) => { assert.ok(url.endsWith('/health')); return { ok: true }; },
    () => { modelsCalled = true; return { ok: true, json: async () => ({}) }; },
  ]);
  const result = await ping({ baseUrl: 'http://test', apiKey: '' });
  assert.equal(result, 'ok');
  assert.equal(modelsCalled, false, 'must not call /v1/models when there is no apiKey to verify');
});

test('ping(): no model, with apiKey — verifies auth via /v1/models even if /health passed', async () => {
  const { ping } = await import('../lib/llm-client.js');
  const calledUrls = [];
  mockFetchSequence([
    (url) => { calledUrls.push(url); return { ok: true }; },
    (url) => { calledUrls.push(url); return { ok: true, json: async () => ({ data: [] }) }; },
  ]);
  const result = await ping({ baseUrl: 'http://test', apiKey: 'sk-123' });
  assert.equal(result, 'ok');
  assert.ok(calledUrls[0].endsWith('/health'));
  assert.ok(calledUrls[1].endsWith('/v1/models'), '/health is not a real auth gate (200s even with a wrong key), /v1/models is');
});

test('ping(): no model, /health fails but /v1/models succeeds — still ok (non-standard server)', async () => {
  const { ping } = await import('../lib/llm-client.js');
  mockFetchSequence([
    () => { throw new Error('ECONNREFUSED'); },
    () => ({ ok: true, json: async () => ({ data: [] }) }),
  ]);
  const result = await ping({ baseUrl: 'http://test', apiKey: 'sk-123' });
  assert.equal(result, 'ok');
});

test('ping(): no model, /v1/models returns non-ok — throws ProviderAPIError with status text', async () => {
  const { ping } = await import('../lib/llm-client.js');
  mockFetchSequence([
    () => { throw new Error('no health endpoint'); },
    () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }),
  ]);
  await assert.rejects(
    () => ping({ baseUrl: 'http://test', apiKey: 'bad-key' }),
    (e) => { assert.match(e.message, /401/); return true; }
  );
});

test('ping(): model configured — sends a real max_tokens:1 request, not /v1/models', async () => {
  const { ping } = await import('../lib/llm-client.js');
  let sawModelsCall = false;
  let capturedBody = null;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/v1/models')) { sawModelsCall = true; return { ok: true, json: async () => ({}) }; }
    if (u.includes('/v1/chat/completions')) {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, text: async () => '' };
    }
    throw new Error('unexpected URL ' + u);
  };
  const result = await ping({ baseUrl: 'http://test', apiKey: 'k', model: 'gpt-4o' });
  assert.equal(result, 'ok');
  assert.equal(sawModelsCall, false, '/v1/models lists are unreliable — a configured model must be verified by a real request, not a list lookup');
  assert.equal(capturedBody.model, 'gpt-4o');
  assert.equal(capturedBody.max_tokens, 1, 'must cap at 1 token — this is a connectivity check, not real inference');
  assert.equal(capturedBody.stream, false);
});

test('ping(): apiStyle responses — verifies via /v1/responses with input + max_output_tokens:1', async () => {
  const { ping } = await import('../lib/llm-client.js');
  let capturedBody = null;
  let capturedUrl = null;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return { ok: true, text: async () => '' };
  };
  const result = await ping({ baseUrl: 'http://test', apiKey: 'k', model: 'gpt-5', apiStyle: 'responses' });
  assert.equal(result, 'ok');
  assert.equal(capturedUrl, 'http://test/v1/responses');
  assert.equal(capturedBody.model, 'gpt-5');
  assert.equal(capturedBody.input, 'hi', 'responses uses input, not messages');
  assert.equal(capturedBody.max_output_tokens, 1);
});

test('ping(): apiStyle anthropic — verifies via /v1/messages with max_tokens:1 (Anthropic requires it)', async () => {
  const { ping } = await import('../lib/llm-client.js');
  let capturedBody = null;
  let capturedUrl = null;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return { ok: true, text: async () => '' };
  };
  const result = await ping({ baseUrl: 'http://test', apiKey: 'k', model: 'claude-3-5', apiStyle: 'anthropic' });
  assert.equal(result, 'ok');
  assert.equal(capturedUrl, 'http://test/v1/messages');
  assert.equal(capturedBody.model, 'claude-3-5');
  assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(capturedBody.max_tokens, 1);
});

test('ping(): model configured, server returns non-ok — throws ProviderAPIError', async () => {
  const { ping } = await import('../lib/llm-client.js');
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'model not found' });
  await assert.rejects(
    () => ping({ baseUrl: 'http://test', apiKey: 'k', model: 'nonexistent-model' }),
    (e) => { assert.match(e.message, /404/); return true; }
  );
});

test('ping(): network error on the model-configured path throws ProviderNetworkError', async () => {
  const { ping } = await import('../lib/llm-client.js');
  globalThis.fetch = async () => { throw new Error('DNS resolution failed'); };
  await assert.rejects(
    () => ping({ baseUrl: 'http://test', apiKey: 'k', model: 'gpt-4o' }),
    (e) => { assert.match(e.message, /Network error/); return true; }
  );
});

test('ping(): throws ProviderConfigError when baseUrl is missing', async () => {
  const { ping } = await import('../lib/llm-client.js');
  await assert.rejects(() => ping({ baseUrl: '', apiKey: '' }));
});

test('getCapabilities(): returns parsed JSON on success', async () => {
  const { getCapabilities } = await import('../lib/llm-client.js');
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith('/v1/capabilities'));
    return { ok: true, json: async () => ({ features: { run_submission: true, run_events_sse: true } }) };
  };
  const caps = await getCapabilities({ baseUrl: 'http://test', apiKey: 'k' });
  assert.deepEqual(caps, { features: { run_submission: true, run_events_sse: true } });
});

test('getCapabilities(): returns null (not throw) on a non-ok response — non-Hermes servers lack this endpoint', async () => {
  const { getCapabilities } = await import('../lib/llm-client.js');
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const caps = await getCapabilities({ baseUrl: 'http://test', apiKey: 'k' });
  assert.equal(caps, null);
});

test('getCapabilities(): returns null on a network error', async () => {
  const { getCapabilities } = await import('../lib/llm-client.js');
  globalThis.fetch = async () => { throw new Error('offline'); };
  const caps = await getCapabilities({ baseUrl: 'http://test', apiKey: 'k' });
  assert.equal(caps, null);
});

test('getCapabilities(): returns null immediately when baseUrl is missing (no fetch)', async () => {
  const { getCapabilities } = await import('../lib/llm-client.js');
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const caps = await getCapabilities({ baseUrl: '', apiKey: 'k' });
  assert.equal(caps, null);
  assert.equal(called, false);
});

// --------------- options.js: real jsdom execution test of pingCard() --------

const html = await readFile(new URL('../options.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/options.html', runScripts: undefined });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.location = dom.window.location;

const storedData = {}; // in-memory chrome.storage.local backing store
const setCalls = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...storedData };
        if (typeof keys === 'string') return { [keys]: storedData[keys] };
        return { ...storedData };
      },
      set: async (obj) => { setCalls.push(obj); Object.assign(storedData, obj); },
    },
  },
};

await import('../options.js');
// options.js's init() is fire-and-forget (storage.getAll() -> renderProviders()
// -> ... ), same convention as sidepanel.js. Let it settle before driving the UI.
await new Promise((r) => setTimeout(r, 50));

function findProviderCard(name) {
  // Provider cards don't carry the raw provider-map key as a DOM attribute,
  // so locate by the prettyProviderName() label options.js renders instead.
  const cards = [...document.querySelectorAll('.provider')];
  const labels = { hermes: 'Hermes', compatible: 'OpenAI-compatible', anthropic: 'Anthropic' };
  const target = labels[name] || name;
  return cards.find((c) => c.querySelector('.name')?.textContent === target);
}

test('options.js: init() rendered all default provider cards without throwing', () => {
  const cards = document.querySelectorAll('.provider');
  assert.equal(cards.length, 3, 'hermes, compatible, anthropic');
});

test('options.js: provider cards no longer expose Temperature / Max tokens fields', () => {
  const cards = document.querySelectorAll('.provider');
  for (const card of cards) {
    assert.ok(!card.querySelector('[data-k="temperature"]'), 'Temperature field removed');
    assert.ok(!card.querySelector('[data-k="maxTokens"]'), 'Max tokens field removed');
  }
});

test('options.js: each provider card exposes an apiStyle select; anthropic defaults to anthropic, others to chat', () => {
  const hermesCard = findProviderCard('hermes');
  const compatibleCard = findProviderCard('compatible');
  const anthropicCard = findProviderCard('anthropic');
  for (const card of [hermesCard, compatibleCard, anthropicCard]) {
    const sel = card.querySelector('[data-k="apiStyle"]');
    assert.ok(sel, 'each provider card must expose an apiStyle select');
    assert.ok(sel.querySelector('option[value="chat"]'), 'must offer chat option');
    assert.ok(sel.querySelector('option[value="responses"]'), 'must offer responses option');
    assert.ok(sel.querySelector('option[value="anthropic"]'), 'must offer anthropic option');
  }
  assert.equal(compatibleCard.querySelector('[data-k="apiStyle"]').value, 'chat', 'compatible defaults to chat');
  assert.equal(anthropicCard.querySelector('[data-k="apiStyle"]').value, 'anthropic', 'anthropic defaults to anthropic');
});

test('options.js: LLM provider (compatible) card shows a Model ID field; agent providers (hermes) do not', () => {
  const compatibleCard = findProviderCard('compatible');
  const hermesCard = findProviderCard('hermes');
  assert.ok(compatibleCard.querySelector('[data-k="model"]'), 'OpenAI-compatible must show Model ID');
  assert.ok(!hermesCard.querySelector('[data-k="model"]'), 'Hermes must NOT show Model ID');
});

test('options.js: pinging an LLM provider with no Model ID set is rejected before any network call', async () => {
  const card = findProviderCard('compatible');
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-llm';
  card.querySelector('[data-k="model"]').value = '';
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true }; };

  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(fetchCalled, false, 'must not ping when an LLM provider has no Model ID');
  assert.match(card.querySelector('.card-status').textContent, /Model ID is required/);
});

test('options.js: pinging an agent provider (Hermes) with no model set proceeds anyway (no Model ID requirement)', async () => {
  const card = findProviderCard('hermes');
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-hermes';
  let healthCalled = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/health')) { healthCalled = true; return { ok: true }; }
    if (u.endsWith('/v1/capabilities')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({}) };
  };

  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(healthCalled, true, 'agent providers must be pingable without a Model ID');
  assert.match(card.querySelector('.card-status').textContent, /✅/);
});

test('options.js: successful ping with run_submission+run_events_sse capabilities sets isHermes=true and persists it', async () => {
  const card = findProviderCard('compatible');
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-runs-capable';
  card.querySelector('[data-k="model"]').value = 'my-model';
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) return { ok: true, text: async () => '' };
    if (u.endsWith('/v1/capabilities')) {
      return { ok: true, json: async () => ({ features: { run_submission: true, run_events_sse: true } }) };
    }
    throw new Error('unexpected URL ' + u);
  };

  setCalls.length = 0;
  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.match(card.querySelector('.card-status').textContent, /runs:✓/);
  const providersSets = setCalls.filter((c) => c.providers);
  const last = providersSets[providersSets.length - 1];
  assert.equal(last.providers.compatible.isHermes, true,
    'isHermes must reflect run_submission && run_events_sse, not the generic responses_api field');
});

test('options.js: capabilities missing run_events_sse (only run_submission) does NOT set isHermes', async () => {
  const card = findProviderCard('compatible');
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-partial-caps';
  card.querySelector('[data-k="model"]').value = 'my-model';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) return { ok: true, text: async () => '' };
    if (u.endsWith('/v1/capabilities')) {
      return { ok: true, json: async () => ({ features: { run_submission: true, run_events_sse: false, responses_api: true } }) };
    }
    throw new Error('unexpected URL ' + u);
  };

  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.match(card.querySelector('.card-status').textContent, /runs:✗/,
    'responses_api alone must not be treated as run-API support -- only run_submission && run_events_sse gates isHermes');
});

test('options.js: a failed ping sets the unreachable badge and shows the error message', async () => {
  const card = findProviderCard('hermes');
  card.querySelector('[data-k="baseUrl"]').value = 'http://unreachable-host';
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.match(card.querySelector('.card-status').textContent, /❌/);
  assert.match(card.querySelector('.provider-badge').textContent, /unreachable/);
});

// --------------- auto-switch active provider on first successful ping ------
// Hermes ships with a non-empty default baseUrl, so "has a baseUrl" is never
// a strong enough signal that the user actually intends to use a provider.
// "Reachable" (a real, successful ping) is the strong signal instead — the
// first time a provider goes from not-reachable to reachable, it becomes
// the active provider, so filling in and verifying e.g. OpenAI-compatible
// doesn't silently leave the dropdown pointed at whatever was active before.

test('options.js: first successful ping on a not-yet-reachable provider auto-switches the active provider', async () => {
  // By this point in the file: the earlier 'failed ping' test left hermes
  // unreachable, and a later compatible ping made compatible the active
  // provider. So hermes is a not-reachable, non-active provider -- pinging
  // it successfully is the first transition to reachable, which must make
  // it the active provider.
  const card = findProviderCard('hermes');
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-hermes-auto';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/health')) return { ok: true };
    if (u.endsWith('/v1/capabilities')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({}) };
  };

  setCalls.length = 0;
  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const activeProviderSets = setCalls.filter((c) => 'activeProvider' in c);
  assert.equal(activeProviderSets.length, 1, 'a successful first-time ping must persist the new active provider exactly once');
  assert.equal(activeProviderSets[0].activeProvider, 'hermes');
  assert.ok(card.classList.contains('active'), 'the pinged card must visually become the active one');
  assert.match(card.querySelector('.card-status').textContent, /set as active provider/);
});

test('options.js: re-pinging an already-reachable provider does not steal active-provider status from a different provider', async () => {
  // The auto-switch test above left hermes reachable AND active, and
  // compatible already reachable (from the earlier ping tests). Re-pinging
  // compatible (already reachable, not active) must NOT steal the active
  // status away from hermes.
  const card = findProviderCard('compatible');
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-compatible-reping';
  card.querySelector('[data-k="model"]').value = 'my-model';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) return { ok: true, text: async () => '' };
    if (u.endsWith('/v1/capabilities')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({}) };
  };

  setCalls.length = 0;
  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  const activeProviderSets = setCalls.filter((c) => 'activeProvider' in c);
  assert.equal(activeProviderSets.length, 0, 're-pinging an already-reachable provider must not change the active provider');
});
