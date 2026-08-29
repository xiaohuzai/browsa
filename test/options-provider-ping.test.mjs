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

test('ping(): Ark-style versioned base (.../api/plan/v3) appends endpoints WITHOUT an extra /v1', async () => {
  // 方舟网关的版本段在 base 里（官方给 Cline/Cursor 的 base 即 …/api/plan/v3），
  // 再拼 /v1 得到 …/v3/v1/chat/completions —— plan 网关带 key 也 404（2026-08-28 实测）。
  const { ping } = await import('../lib/llm-client.js');
  const called = [];
  mockFetchSequence([
    (url) => { called.push(String(url)); return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }; },
  ]);
  const result = await ping({ baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', apiKey: 'ark-key', model: 'doubao-seed-1-8', apiStyle: 'chat' });
  assert.equal(result, 'ok');
  assert.equal(called[0], 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions');

  // responses 风格同理
  called.length = 0;
  await ping({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'ark-key', model: 'doubao-seed-1-6', apiStyle: 'responses' });
  assert.equal(called[0], 'https://ark.cn-beijing.volces.com/api/v3/responses');
});

test('ping(): base already ending in /v1 is not double-prefixed', async () => {
  const { ping } = await import('../lib/llm-client.js');
  const called = [];
  mockFetchSequence([
    (url) => { called.push(String(url)); return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }; },
  ]);
  await ping({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-test', apiStyle: 'chat' });
  assert.equal(called[0], 'https://api.openai.com/v1/chat/completions');
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

test('ping(): /health ok + /v1/models 404 — trust /health (Hermes/OpenViking: no model listing, traffic on /v1/runs)', async () => {
  const { ping } = await import('../lib/llm-client.js');
  mockFetchSequence([
    () => ({ ok: true }),                                   // /health
    () => ({ ok: false, status: 404, text: async () => 'Not Found' }), // /v1/models
  ]);
  const result = await ping({ baseUrl: 'http://test', apiKey: 'sk-123' });
  assert.equal(result, 'ok');
});

test('ping(): /v1/models 404 WITHOUT a passing /health — still throws (no corroboration)', async () => {
  const { ping } = await import('../lib/llm-client.js');
  mockFetchSequence([
    () => { throw new Error('no health endpoint'); },
    () => ({ ok: false, status: 404, text: async () => 'Not Found' }),
  ]);
  await assert.rejects(
    () => ping({ baseUrl: 'http://test', apiKey: 'sk-123' }),
    (e) => { assert.match(e.message, /404/); return true; }
  );
});

test('ping(): apiStyle anthropic sends x-api-key + anthropic-version (official API requires both)', async () => {
  const { ping } = await import('../lib/llm-client.js');
  let capturedHeaders = null;
  globalThis.fetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, text: async () => '' };
  };
  const result = await ping({ baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-x', apiStyle: 'anthropic' });
  assert.equal(result, 'ok');
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant', 'official Anthropic auth is x-api-key, not Bearer');
  assert.ok(capturedHeaders['anthropic-version'], 'anthropic-version is mandatory (400 without it)');
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

function findProviderCard(displayName) {
  // Cards are located by their rendered title (the alias or default name),
  // since the raw provider-map key is opaque and never shown in the DOM.
  const cards = [...document.querySelectorAll('.provider')];
  return cards.find((c) => c.querySelector('.name')?.textContent === displayName);
}

function providerCards() {
  return [...document.querySelectorAll('.provider')];
}

function clickAddProvider() {
  const btn = document.querySelector('.add-provider-btn');
  assert.ok(btn, 'an Add Provider button must be present');
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
}

// Add a fresh blank LLM card and return it. On a fresh install a render-only
// "reserved slot" (LLM 1) is shown — so the first card is created by filling
// in the reserved slot's baseUrl and Saving it (committing it to storage as
// `llm-1`). "＋ Add Provider" is always available; once at least one LLM
// provider exists it appends a NEW card below the existing ones.
// renderProviders() re-renders asynchronously after each storage write, so
// the caller must await this helper.
async function addLlmCard() {
  const reserved = document.querySelector('.provider.reserved');
  if (reserved) {
    reserved.querySelector('[data-k="baseUrl"]').value = 'http://reserved-' + Math.random().toString(36).slice(2);
    reserved.querySelector('button[data-act="save"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const committed = findProviderCard('LLM 1');
    assert.ok(committed, 'saving the reserved slot must commit it as a real LLM 1 card');
    return committed;
  }
  clickAddProvider();
  await new Promise((r) => setTimeout(r, 10));
  const cards = providerCards();
  return cards[cards.length - 1];
}

test('options.js: init() renders the Hermes Agent card plus a reserved empty LLM slot', () => {
  const cards = providerCards();
  assert.equal(cards.length, 2, 'Hermes Agent + one reserved empty LLM slot');
  assert.equal(findProviderCard('Hermes Agent') != null, true, 'Hermes Agent card present');
  const reserved = document.querySelector('.provider.reserved');
  assert.equal(reserved != null, true, 'an empty LLM group shows a reserved empty slot card');
  assert.equal(findProviderCard('LLM 1'), reserved, 'the reserved slot renders as the LLM 1 card');
  assert.equal(reserved.querySelector('[data-act="delete"]'), null, 'the reserved slot has no delete button (nothing persisted yet)');
  assert.equal(document.querySelector('.add-provider-btn') != null, true, 'Add Provider button is always present — even with the reserved slot');
});

test('options.js: configuring + saving the reserved slot does NOT auto-create an extra empty card', async () => {
  // User report: after filling the reserved LLM 1 and saving, no new LLM2 may
  // appear on its own — the slot is consumed and new empties only come from
  // an explicit "＋ Add Provider" click, placed BELOW the configured one.
  const reserved = document.querySelector('.provider.reserved');
  assert.ok(reserved, 'reserved slot is showing on fresh install');
  reserved.querySelector('[data-k="alias"]').value = 'My OpenAI';
  reserved.querySelector('[data-k="baseUrl"]').value = 'http://openai';
  reserved.querySelector('[data-k="model"]').value = 'gpt-4o';
  reserved.querySelector('button[data-act="save"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(document.querySelector('.provider.reserved'), null, 'the reserved slot is consumed once a provider is committed');
  const names = providerCards().map((c) => c.querySelector('.name').textContent);
  assert.deepEqual(names, ['Hermes Agent', 'My OpenAI'], 'only the configured provider renders — no auto-appearing empty card');

  // Now an explicit Add appends a new card BELOW the configured one.
  clickAddProvider();
  await new Promise((r) => setTimeout(r, 10));
  const after = providerCards().map((c) => c.querySelector('.name').textContent);
  assert.deepEqual(after, ['Hermes Agent', 'My OpenAI', 'LLM 2'], 'Add appends below the configured provider');
  const added = providerCards()[providerCards().length - 1];
  assert.ok(added.querySelector('[data-act="delete"]'), 'the appended card is a real, deletable provider');
});

test('options.js: the Hermes Agent card exposes ONLY Base URL + API key (its own /v1/runs protocol needs no configuration)', () => {
  const hermesCard = findProviderCard('Hermes Agent');
  assert.ok(hermesCard, 'Hermes Agent card present');
  assert.ok(hermesCard.querySelector('[data-k="baseUrl"]'), 'agent card exposes Base URL');
  assert.ok(hermesCard.querySelector('[data-k="apiKey"]'), 'agent card exposes API key');
  // No protocol dropdown: Hermes Agent speaks its own /v1/runs protocol.
  assert.equal(hermesCard.querySelector('[data-k="apiStyle"]'), null, 'agent cards must NOT expose an apiStyle select');
  // No Alias / Model fields, no delete button (fixed, not user-configurable beyond url+key).
  assert.equal(hermesCard.querySelector('[data-k="alias"]'), null, 'agent cards have no alias field');
  assert.equal(hermesCard.querySelector('[data-k="model"]'), null, 'agent cards have no model field');
  assert.equal(hermesCard.querySelector('[data-act="delete"]'), null, 'agent cards are not removable');
  // API Server 说明走 Base URL 标签上的 ? 悬浮提示（2026-08-30 用户反馈：不要
  // 常驻的 📖 链接行，悬停才出现）。
  const baseUrlTip = hermesCard.querySelector('[data-k="baseUrl"]')?.closest('label')?.querySelector('.tip .tip-bubble');
  assert.ok(baseUrlTip, 'Base URL label carries a ? tooltip');
  assert.match(baseUrlTip.textContent, /API Server/, 'tooltip explains the Hermes API Server requirement');
  const docLink = baseUrlTip.querySelector('a[href="https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server"]');
  assert.ok(docLink, 'tooltip links the official API Server docs');
  assert.equal(docLink.target, '_blank', 'docs open in a new tab');
});

test('options.js: provider cards expose Max output tokens (truncation control) but still no Temperature', async () => {
  // maxTokens 2026-08-29 重新露出：字段一直在 BLANK_LLM/推理管线里，但没有 UI
  // 用户就无法提高输出预算——真实故障：视频笔记类长回复被 16K 上限截断且无处可调。
  // Temperature 保持删除（无对应故障，纯旋钮）。
  const card = await addLlmCard();
  const mt = card.querySelector('[data-k="maxTokens"]');
  assert.ok(mt, 'Max tokens field exposed');
  assert.equal(mt.type, 'number', 'maxTokens is a number input');
  assert.ok(!card.querySelector('[data-k="temperature"]'), 'Temperature field stays removed');
});

test('options.js: adding a provider appends a new LLM card with alias + protocol select + delete', async () => {
  // Commit the reserved slot as the first provider first — only once at least
  // one LLM provider exists does the Add button appear and append a new card.
  await addLlmCard();
  const before = providerCards().length;
  const card = await addLlmCard();
  assert.equal(providerCards().length, before + 1, 'Add Provider appends a card');
  const sel = card.querySelector('[data-k="apiStyle"]');
  assert.ok(sel, 'each LLM card exposes an apiStyle select');
  assert.ok(sel.querySelector('option[value="chat"]'), 'must offer chat option');
  assert.ok(sel.querySelector('option[value="responses"]'), 'must offer responses option');
  assert.ok(sel.querySelector('option[value="anthropic"]'), 'must offer anthropic option');
  assert.equal(sel.value, 'chat', 'a fresh LLM provider defaults to chat');
  assert.ok(card.querySelector('[data-k="alias"]'), 'LLM cards expose an Alias field');
  assert.ok(card.querySelector('[data-k="model"]'), 'LLM cards expose a Model ID field');
  assert.ok(card.querySelector('[data-act="delete"]'), 'LLM cards expose a delete button');
});

test('options.js: each added provider can pick its own protocol (anthropic etc.) and the select persists on Save', async () => {
  const card = await addLlmCard();
  const sel = card.querySelector('[data-k="apiStyle"]');
  sel.value = 'anthropic';
  card.querySelector('button[data-act="save"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const providersSet = setCalls.filter((c) => c.providers).pop();
  const added = Object.values(providersSet.providers).find((p) => p.type === 'llm' && p.apiStyle === 'anthropic');
  assert.ok(added, 'a provider configured with anthropic protocol must be persisted');
});

test('options.js: the Alias field is persisted on Save', async () => {
  const card = await addLlmCard();
  card.querySelector('[data-k="alias"]').value = '我的 Claude';
  card.querySelector('button[data-act="save"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const providersSet = setCalls.filter((c) => c.providers).pop();
  const added = Object.values(providersSet.providers).find((p) => p.type === 'llm' && p.alias === '我的 Claude');
  assert.ok(added, 'alias must be persisted');
});

test('options.js: pinging an LLM provider with no Model ID set is rejected before any network call', async () => {
  const card = await addLlmCard();
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
  const card = findProviderCard('Hermes Agent');
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
  const card = await addLlmCard();
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
  const allLlm = Object.values(last.providers).filter((p) => p.type === 'llm');
  const llm = allLlm[allLlm.length - 1]; // the freshly added + pinged one
  assert.equal(llm.isHermes, true,
    'isHermes must reflect run_submission && run_events_sse, not the generic responses_api field');
});

test('options.js: capabilities missing run_events_sse (only run_submission) does NOT set isHermes', async () => {
  const card = await addLlmCard();
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
  const card = findProviderCard('Hermes Agent');
  card.querySelector('[data-k="baseUrl"]').value = 'http://unreachable-host';
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  assert.match(card.querySelector('.card-status').textContent, /❌/);
  assert.match(card.querySelector('.provider-badge').textContent, /unreachable/);
});

test('options.js: deleting an LLM provider removes it (card count decreases by one)', async () => {
  // Commit the reserved slot as the first provider, then Add a second one so
  // there is a genuinely added (and deletable) card to remove.
  const first = await addLlmCard();
  assert.equal(first.querySelector('[data-act="delete"]') != null, true, 'a committed provider becomes deletable');
  const before = providerCards().length;
  const card = await addLlmCard();
  assert.equal(providerCards().length, before + 1, 'add grew the list by one');
  assert.equal(card.querySelector('[data-act="delete"]') != null, true);
  card.querySelector('[data-act="delete"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(providerCards().length, before, 'delete shrank the list back by one');
  assert.equal(findProviderCard('Hermes Agent') != null, true, 'Hermes is never removed');
});

test('options.js: an agent provider (Hermes) has no delete button and cannot be removed', () => {
  const hermesCard = findProviderCard('Hermes Agent');
  assert.equal(hermesCard.querySelector('[data-act="delete"]'), null);
});

test('options.js: removing the active LLM provider falls back to Hermes as the active provider', async () => {
  // Make an added LLM provider active via a successful first ping (the
  // auto-switch path), then delete it: activeProvider must fall back to
  // 'hermes' so there is always a valid active provider.
  const card = await addLlmCard();
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-llm-active-del';
  card.querySelector('[data-k="model"]').value = 'my-model';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) return { ok: true, text: async () => '' };
    if (u.endsWith('/v1/capabilities')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({}) };
  };
  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));

  card.querySelector('[data-act="delete"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const activeSets = setCalls.filter((c) => 'activeProvider' in c);
  assert.equal(activeSets[activeSets.length - 1].activeProvider, 'hermes',
    'deleting the active LLM provider must fall back to Hermes');
});

// --------------- auto-switch active provider on first successful ping ------
// Hermes ships with an empty baseUrl by default, so "has a baseUrl" is never
// a strong enough signal that the user actually intends to use a provider.
// "Reachable" (a real, successful ping) is the strong signal instead -- the
// first time a provider goes from not-reachable to reachable, it becomes
// the active provider, so filling in and verifying an added LLM provider
// doesn't silently leave the dropdown pointed at whatever was active before.

test('options.js: first successful ping on a not-yet-reachable provider auto-switches the active provider', async () => {
  // A freshly added LLM provider starts not-reachable and not-active.
  // Pinging it successfully is the first transition to reachable, which
  // must make it the active provider.
  const card = await addLlmCard();
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-llm-auto';
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
  assert.equal(activeProviderSets.length, 1, 'a successful first-time ping must persist the new active provider exactly once');
  assert.notEqual(activeProviderSets[0].activeProvider, 'hermes', 'the added LLM provider became active');
  assert.ok(card.classList.contains('active'), 'the pinged card must visually become the active one');
  assert.match(card.querySelector('.card-status').textContent, /set as active provider/);
});

test('options.js: re-pinging an already-reachable provider does not steal active-provider status from a different provider', async () => {
  // A first successful ping on a fresh LLM provider makes it active (auto
  // switch); a SECOND ping on the now-already-reachable provider must NOT
  // change the active provider again.
  const card = await addLlmCard();
  card.querySelector('[data-k="baseUrl"]').value = 'http://test-llm-reping';
  card.querySelector('[data-k="model"]').value = 'my-model';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/chat/completions')) return { ok: true, text: async () => '' };
    if (u.endsWith('/v1/capabilities')) return { ok: false, status: 404 };
    return { ok: true, json: async () => ({}) };
  };

  // First ping: fresh provider -> becomes reachable -> auto-switch active.
  setCalls.length = 0;
  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const first = setCalls.filter((c) => 'activeProvider' in c);
  assert.equal(first.length, 1, 'first successful ping must switch the active provider once');

  // Second ping: already reachable -> must NOT change the active provider.
  setCalls.length = 0;
  card.querySelector('button[data-act="ping"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const second = setCalls.filter((c) => 'activeProvider' in c);
  assert.equal(second.length, 0, 're-pinging an already-reachable provider must not change the active provider');
});
