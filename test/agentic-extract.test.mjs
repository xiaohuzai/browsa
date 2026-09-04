// test/agentic-extract.test.mjs — lib/agentic-extract.js: the pure helpers
// (parseAction, assembleDeepText) and the maybeDeepExtract() orchestrator
// against a mocked chrome.* + mocked provider SSE endpoint. The orchestrator
// tests pin the three contract guarantees: hard caps, provider-agnostic
// brain dispatch (chat style here; the style dispatch itself is plain
// plumbing), and fail-open — every failure path returns null and the
// baseline result stays untouched.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── chrome mock scaffolding (installed before the dynamic import) ──────────

let execScriptCalls;
let storageData;
let tabsCreated;
let tabsRemoved;
let sseChunks; // chat-style SSE body the fake fetch serves, one entry per call

function sseOf(text) {
  // Minimal OpenAI-compatible chat.completion chunk stream wrapping `text`.
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'
    + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n'
    + 'data: [DONE]\n\n';
}

function installChromeMock() {
  globalThis.chrome = {
    storage: { local: { get: async () => storageData } },
    alarms: { create: () => {}, clear: () => {} },
    scripting: {
      executeScript: async ({ func, args }) => {
        execScriptCalls.push({ name: func.name, args: args?.[0] });
        switch (func.name) {
          case 'interactiveSnapshot': {
            const n = execScriptCalls.filter((c) => c.name === 'interactiveSnapshot').length;
            if (n === 1) {
              return [{
                result: {
                  count: 2,
                  items: ['[0]<button>加载更多评论</button>', '[1]<button>展开附录</button>'],
                  text: 'Page: t\nClickable controls:\n[0]<button>加载更多评论</button>\n[1]<button>展开附录</button>',
                }
              }];
            }
            return [{ result: { count: 0, items: [], text: 'Page: t\nClickable controls:' } }];
          }
          case 'clickIndexed':
            return [{ result: { found: true, clicked: true, vetoed: false, changed: true, deltaChars: 2500 } }];
          case 'extractInPageWorld':
            return [{ result: { text: 'BASELINE-' + 'x'.repeat(2600) } }];
          case 'extractFullInPageWorld':
            return [{ result: { text: 'PAGE TWO ' + 'y'.repeat(200) } }];
          case 'detectIncompleteness':
            return [{ result: { nextPageHref: null, loadMore: false, expandersLeft: 0 } }];
          default:
            return [{ result: {} }];
        }
      },
    },
    tabs: {
      create: async (opts) => { tabsCreated.push(opts); return { id: 77 }; },
      remove: async (id) => { tabsRemoved.push(id); },
      get: async () => ({ status: 'complete' }),
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    i18n: { getMessage: () => '' },
  };
}

beforeEach(() => {
  execScriptCalls = [];
  tabsCreated = [];
  tabsRemoved = [];
  sseChunks = [];
  storageData = {
    deepExtractEnabled: true,
    activeProvider: 'p1',
    maxTextChars: 1_000_000,
    providers: {
      p1: { type: 'llm', alias: 'P1', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm1', apiStyle: 'chat' },
    },
  };
  globalThis.fetch = async () => new Response(sseOf(''), { status: 200 });
});

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
});

const { parseAction, assembleDeepText, maybeDeepExtract } = await import('../lib/agentic-extract.js');

// ── parseAction ─────────────────────────────────────────────────────────────

test('parseAction: clean click and done objects', () => {
  assert.deepEqual(parseAction('{"click":{"index":7}}'), { click: 7 });
  assert.deepEqual(parseAction('{"done":{}}'), { done: true });
});

test('parseAction: strips markdown fences and prose around the object', () => {
  assert.deepEqual(parseAction('Sure!\n```json\n{"click":{"index":3}}\n```'), { click: 3 });
  assert.deepEqual(parseAction('Step result.\n{"click":{"index":0}} hope this helps'), { click: 0 });
});

test('parseAction: garbage, empty, and malformed replies all fail closed to done', () => {
  assert.deepEqual(parseAction(''), { done: true });
  assert.deepEqual(parseAction(null), { done: true });
  assert.deepEqual(parseAction('I would click the button'), { done: true });
  assert.deepEqual(parseAction('{"click":{"index":"seven"}}'), { done: true });
  assert.deepEqual(parseAction('{"click":{"index":1e9}}'), { done: true });
  assert.deepEqual(parseAction('{"click":7}'), { done: true });
  assert.deepEqual(parseAction('{"click":{"index":-2}}'), { done: true });
});

test('parseAction: braces inside strings do not derail the balance scan', () => {
  assert.deepEqual(parseAction('{"click":{"index":2,"note":"curly } brace"}}'), { click: 2 });
});

// ── assembleDeepText ────────────────────────────────────────────────────────

test('assembleDeepText: adopts the re-extracted text only on a meaningful gain', () => {
  const base = 'b'.repeat(1000);
  const bigger = base + 'NEW'.repeat(100); // +300 chars
  const smaller = base.slice(0, 900);
  assert.equal(assembleDeepText({ baselineText: base, finalText: bigger, pages: [] }), bigger);
  assert.equal(assembleDeepText({ baselineText: base, finalText: smaller, pages: [] }), base);
});

test('assembleDeepText: appends walked pages with [Page N] markers, skipping repeats', () => {
  const out = assembleDeepText({
    baselineText: 'page one body',
    finalText: 'page one body',
    pages: ['page two body '.repeat(30), 'page one body', 'page three body '.repeat(30)],
  });
  assert.ok(out.includes('\n\n[Page 2]\n\npage two body'));
  // duplicate of page one is skipped, and the last page still numbers sequentially
  assert.ok(out.includes('\n\n[Page 3]\n\npage three body'));
  assert.ok(!out.includes('[Page 4]'));
});

// ── maybeDeepExtract (integration, mocked chrome + provider) ───────────────

test('maybeDeepExtract: no signals → null, nothing executed', async () => {
  installChromeMock();
  const res = await maybeDeepExtract({
    tabId: 1,
    ctx: { text: 'BASE', deepExtractSignals: { nextPageHref: null, loadMore: false, expandersLeft: 0 } },
    textCap: 1000, query: '', redoMode: 'reader',
  });
  assert.equal(res, null);
  assert.equal(execScriptCalls.length, 0);
});

test('maybeDeepExtract: setting off → null', async () => {
  installChromeMock();
  storageData.deepExtractEnabled = false;
  const res = await maybeDeepExtract({
    tabId: 1,
    ctx: { text: 'BASE', deepExtractSignals: { nextPageHref: null, loadMore: true, expandersLeft: 0 } },
    textCap: 1000, query: '', redoMode: 'reader',
  });
  assert.equal(res, null);
});

test('maybeDeepExtract: no provider configured → null', async () => {
  installChromeMock();
  storageData.activeProvider = 'ghost';
  const res = await maybeDeepExtract({
    tabId: 1,
    ctx: { text: 'BASE', deepExtractSignals: { nextPageHref: null, loadMore: true, expandersLeft: 0 } },
    textCap: 1000, query: '', redoMode: 'reader',
  });
  assert.equal(res, null);
});

test('maybeDeepExtract: brain clicks, re-extraction wins, result carries the gain', async () => {
  installChromeMock();
  // step 1 brain → click 0; step 2 brain → done
  sseChunks = [];
  globalThis.fetch = async () => {
    const body = sseChunks.length === 0 ? sseOf('{"click":{"index":0}}') : sseOf('{"done":{}}');
    sseChunks.push(body);
    return new Response(body, { status: 200 });
  };

  const res = await maybeDeepExtract({
    tabId: 1,
    ctx: { text: 'BASE', meta: { url: 'https://example.com/a' }, deepExtractSignals: { nextPageHref: null, loadMore: true, expandersLeft: 0 } },
    textCap: 100_000, query: '', redoMode: 'reader',
  });
  assert.ok(res, 'expected an upgrade');
  assert.equal(res.clicks, 1);
  assert.equal(res.pages, 0);
  assert.ok(res.text.startsWith('BASELINE-'));
  assert.ok(res.text.length > 'BASE'.length + 200);
  // brain saw a snapshot, clicked by index, then saw a second snapshot
  const names = execScriptCalls.map((c) => c.name);
  assert.deepEqual(names.filter((n) => n === 'interactiveSnapshot').length, 2);
  assert.deepEqual(names.filter((n) => n === 'clickIndexed').length, 1);
  // progress was pushed at least once (start + step)
});

test('maybeDeepExtract: provider failure mid-loop → fail-open null, baseline kept', async () => {
  installChromeMock();
  globalThis.fetch = async () => { throw new Error('connection reset'); };
  const res = await maybeDeepExtract({
    tabId: 1,
    ctx: { text: 'BASE', meta: { url: 'https://example.com/a' }, deepExtractSignals: { nextPageHref: null, loadMore: true, expandersLeft: 0 } },
    textCap: 1000, query: '', redoMode: 'reader',
  });
  assert.equal(res, null);
});

test('maybeDeepExtract: walks URL pagination in a background tab and closes it', async () => {
  installChromeMock();
  execScriptCalls = [];
  // No interactive controls → the brain loop exits immediately; only the walker runs.
  const res = await maybeDeepExtract({
    tabId: 1,
    ctx: { text: 'PAGE ONE', meta: { url: 'https://example.com/a' }, deepExtractSignals: { nextPageHref: 'https://example.com/a?page=2', loadMore: false, expandersLeft: 0 } },
    textCap: 100_000, query: '', redoMode: 'reader',
  });
  assert.ok(res, 'expected page-2 append');
  assert.equal(res.pages, 1);
  assert.ok(res.text.includes('\n\n[Page 2]\n\n'));
  assert.ok(res.text.includes('PAGE TWO'));
  assert.deepEqual(tabsCreated, [{ url: 'https://example.com/a?page=2', active: false }]);
  assert.deepEqual(tabsRemoved, [77]);
  // the walker tab got cleanup + full extraction + its own probe
  assert.ok(execScriptCalls.some((c) => c.name === 'preExtractCleanup'));
  assert.ok(execScriptCalls.some((c) => c.name === 'extractFullInPageWorld'));
});

test('maybeDeepExtract: walker dedupes a page-2 that repeats page 1', async () => {
  installChromeMock();
  const origExec = globalThis.chrome.scripting.executeScript;
  globalThis.chrome.scripting.executeScript = async (opts) => {
    if (opts.func.name === 'extractFullInPageWorld') return [{ result: { text: 'PAGE ONE' } }];
    return origExec(opts);
  };
  const res = await maybeDeepExtract({
    tabId: 1,
    ctx: { text: 'PAGE ONE', meta: { url: 'https://example.com/a' }, deepExtractSignals: { nextPageHref: 'https://example.com/a?page=2', loadMore: false, expandersLeft: 0 } },
    textCap: 100_000, query: '', redoMode: 'reader',
  });
  assert.equal(res, null); // page 2 added nothing → no upgrade at all
  assert.deepEqual(tabsRemoved, [77]); // walker tab still cleaned up
});

test('maybeDeepExtract: brain repeating an index is cut off mechanically', async () => {
  installChromeMock();
  globalThis.fetch = async () => new Response(sseOf('{"click":{"index":0}}'), { status: 200 });
  const res = await maybeDeepExtract({
    tabId: 1,
    ctx: { text: 'BASE', meta: { url: 'https://example.com/a' }, deepExtractSignals: { nextPageHref: null, loadMore: true, expandersLeft: 0 } },
    textCap: 100_000, query: '', redoMode: 'reader',
  });
  // step 1 clicked index 0; step 2 brain repeats index 0 → loop breaks. Only
  // one click ever happened (plus the redone extraction).
  assert.ok(res);
  assert.equal(res.clicks, 1);
  assert.deepEqual(execScriptCalls.filter((c) => c.name === 'clickIndexed').length, 1);
});
