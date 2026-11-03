// test/lib-tab-helpers.test.mjs — the four chrome-facing helpers shared by the
// extractor cascade and the PDF/office attach pipelines. They had no test at all
// (the 2026-11-03 audit: 3 of 4 exports referenced nowhere in test/), so a wrong
// window id, a lost quality option or a swallowed PDF probe would have shipped
// silently — each of those changes what the user sees in the first message.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const state = {
  tabs: [],
  contentType: 'text/html',
  captureResult: 'data:image/jpeg;base64,AA',
  captureArgs: null,
  fetchImpl: null,
};

globalThis.chrome = {
  tabs: {
    query: async () => state.tabs,
    get: async (id) => ({ id, windowId: 7 }),
    captureVisibleTab: async (windowId, opts) => {
      state.captureArgs = [windowId, opts];
      return state.captureResult;
    },
  },
  scripting: {
    executeScript: async () => {
      if (state.contentType === 'throw') throw new Error('tab cannot be scripted');
      return [{ result: state.contentType === 'application/pdf' }];
    },
  },
};
globalThis.fetch = async (...args) => state.fetchImpl(...args);

const { getActiveTab, isPdfDocument, checkContentTypeIsPdf, captureVisibleTab } =
  await import('../lib/tab-helpers.js');

test('getActiveTab: returns the active tab of the last-focused window', async () => {
  state.tabs = [{ id: 3, url: 'https://a.example/' }];
  assert.deepEqual(await getActiveTab(), { id: 3, url: 'https://a.example/' });
  state.tabs = [];
  assert.equal(await getActiveTab(), undefined, 'no active tab yields undefined, not a throw');
});

test('isPdfDocument: reads document.contentType in the MAIN world and degrades to false', async () => {
  state.contentType = 'application/pdf';
  assert.equal(await isPdfDocument(9), true);
  state.contentType = 'text/html';
  assert.equal(await isPdfDocument(9), false);
  state.contentType = 'throw';
  assert.equal(await isPdfDocument(9), false, 'an injection failure must not break the attach flow');
});

test('checkContentTypeIsPdf: HEAD-checks the URL, tolerates missing/garbage headers', async () => {
  state.fetchImpl = async (url, init) => {
    assert.equal(init.method, 'HEAD');
    assert.equal(url, 'https://files.example/doc');
    return { headers: { get: () => 'Application/PDF; charset=binary' } };
  };
  assert.equal(await checkContentTypeIsPdf('https://files.example/doc'), true, 'case-insensitive match');

  state.fetchImpl = async () => ({ headers: { get: () => null } });
  assert.equal(await checkContentTypeIsPdf('https://files.example/page'), false, 'null content-type');

  state.fetchImpl = async () => { throw new Error('network down'); };
  assert.equal(await checkContentTypeIsPdf('https://files.example/doc'), false, 'network failure degrades to false');
});

test('captureVisibleTab: JPEG q70 from the tab OWN window', async () => {
  assert.equal(await captureVisibleTab(11), 'data:image/jpeg;base64,AA');
  assert.deepEqual(state.captureArgs, [7, { format: 'jpeg', quality: 70 }],
    'the window id must come from tabs.get (captureVisibleTab is window-scoped)');
});
