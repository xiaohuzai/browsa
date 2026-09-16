// test/lib-page-extract-frame-gone.test.mjs — runGenericExtraction's handling of
// a frame destroyed mid-read. Real user report: attaching an article while the
// tab navigated produced "⚠ Failed to read page DOM: Frame with ID 0 was
// removed." — a raw chrome.scripting string shown to the user for a tab that
// was perfectly fine. The contract pinned here:
//   • same URL  ⇒ the page reloaded itself in place, retry once (silent)
//   • URL moved ⇒ typed `page-navigated` code so the side panel can say it in
//                 the user's own language, instead of attaching the wrong page
// Note: preExtractCleanup is NOT the first thing to blame here — it was a
// separate misclick bug (see lib-pre-extract-cleanup.test.mjs). Any ordinary
// redirect or SPA reload inside the ~3.5s cleanup window lands here.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let tabUrl;
let navigateOnThrow;
let threw;
let injectCalls;

function installChromeMock() {
  globalThis.chrome = {
    scripting: {
      executeScript: async ({ func }) => {
        injectCalls.push(func?.name || '(anonymous)');
        if (func?.name === 'extractInPageWorld') {
          if (!threw) {
            threw = true;
            if (navigateOnThrow) tabUrl = 'https://example.com/';
            throw new Error('Frame with ID 0 was removed.');
          }
          return [{ result: { text: 'READER ' + 'x'.repeat(600) } }];
        }
        // Everything else (the site fast-path probes, isPdfDocument's
        // `() => document.contentType === 'application/pdf'`, whose inferred
        // name is "func") must come back falsy so the cascade reaches
        // runGenericExtraction instead of taking a shortcut.
        return [{ result: false }];
      },
    },
    tabs: { get: async (id) => ({ id, url: tabUrl, title: 'T', favIconUrl: '' }) },
    i18n: { getMessage: () => '' },
    runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  };
}

beforeEach(() => {
  tabUrl = 'https://example.com/blog/post';
  navigateOnThrow = false;
  threw = false;
  injectCalls = [];
  installChromeMock();
});

afterEach(() => { delete globalThis.chrome; });

test('extractActiveTab: a destroyed frame with an UNCHANGED url is retried once and the read succeeds', async () => {
  const { extractActiveTab } = await import('../lib/page-extractor.js');
  const ctx = await extractActiveTab({ mode: 'auto', tabId: 7 });
  assert.equal(threw, true, 'the mock must have destroyed the frame once');
  assert.equal(
    injectCalls.filter((n) => n === 'extractInPageWorld').length, 2,
    'a same-URL frame loss is a same-page reload: inject once more instead of failing the attach'
  );
  assert.match(ctx.text, /^READER /);
});

test('extractActiveTab: a frame loss after the tab MOVED fails with a typed page-navigated code', async () => {
  navigateOnThrow = true;
  const { extractActiveTab } = await import('../lib/page-extractor.js');
  await assert.rejects(
    () => extractActiveTab({ mode: 'auto', tabId: 7 }),
    (e) => {
      assert.equal(e.code, 'page-navigated', 'the side panel translates this code; without it the raw Chrome string reaches the user');
      assert.doesNotMatch(e.message, /Frame with ID 0/, 'the raw chrome.scripting string must not be the message');
      return true;
    }
  );
  assert.equal(
    injectCalls.filter((n) => n === 'extractInPageWorld').length, 1,
    'do not retry against a different page — that would attach content the user never asked for'
  );
});
