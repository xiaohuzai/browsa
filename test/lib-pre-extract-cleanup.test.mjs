// test/lib-pre-extract-cleanup.test.mjs — coverage for
// lib/page-extractor.js's preExtractCleanup(): dismisses cookie/consent
// banners, expands folded "read more" content, and scrolls to trigger
// lazy-loaded items before the main extraction runs. Ported concept from
// firecrawl's in-page "actions" system (wait/click/scroll), reimplemented
// from scratch since firecrawl's own implementation lives entirely in a
// remote Playwright service with no reusable code (confirmed via research).
//
// The two safety gates (container-scoped cookie dismissal, danger-word veto)
// are the most important thing to test here — misclicking a destructive
// button would be a real, user-facing bug, not just a missed enhancement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function loadSiblingFn(name, file = join(ROOT, 'lib/page-extractor.js')) {
  const src = await readFile(file, 'utf8');
  const m = src.match(new RegExp(`(?:async\\s+)?function ${name}\\s*\\([^)]*\\)`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  const headerEnd = m.index + m[0].length;
  let i = headerEnd;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '{') throw new Error(`${name}: expected { at offset ${i}`);
  const start = m.index;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`${name}: unbalanced braces`);
  return src.slice(start, i + 1);
}

async function runCleanup(html) {
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  const scrollToCalls = [];
  const ctx = vm.createContext({
    document: dom.window.document,
    window: {
      scrollY: 0,
      scrollTo: (x, y) => scrollToCalls.push([x, y]),
    },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  return { result, scrollToCalls };
}

test('preExtractCleanup: clicks an accept button inside a recognized cookie-banner container', async () => {
  const html = `<!doctype html><html><body>
    <div class="cookie-banner">
      <span>We use cookies.</span>
      <button id="accept-btn">Accept All</button>
    </div>
    <main>Article content here.</main>
  </body></html>`;
  const { result } = await runCleanup(html);
  assert.equal(result.cookieDismissed, true);
});

test('preExtractCleanup: does NOT click a dangerous button even inside a cookie-banner container (danger-word veto)', async () => {
  const html = `<!doctype html><html><body>
    <div class="cookie-banner">
      <button id="danger-btn">确认购买</button>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  let clicked = false;
  dom.window.document.getElementById('danger-btn').addEventListener('click', () => { clicked = true; });
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const ctx = vm.createContext({
    document: dom.window.document,
    window: { scrollY: 0, scrollTo: () => {} },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  assert.equal(clicked, false, 'a button with a purchase-confirmation label must never be clicked');
  assert.equal(result.cookieDismissed, false);
});

test('preExtractCleanup: does NOT click an accept-looking button OUTSIDE any cookie container (container gating)', async () => {
  const html = `<!doctype html><html><body>
    <main>
      <button id="unrelated-btn">同意</button>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  let clicked = false;
  dom.window.document.getElementById('unrelated-btn').addEventListener('click', () => { clicked = true; });
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const ctx = vm.createContext({
    document: dom.window.document,
    window: { scrollY: 0, scrollTo: () => {} },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  assert.equal(clicked, false, 'a button matching accept-text but outside any cookie container must never be clicked');
  assert.equal(result.cookieDismissed, false);
});

test('preExtractCleanup: clicks an aria-expanded=false element to expand collapsed content', async () => {
  const html = `<!doctype html><html><body>
    <main>
      <button aria-expanded="false" id="expand-btn">展开</button>
      <div hidden>Hidden content.</div>
    </main>
  </body></html>`;
  const { result } = await runCleanup(html);
  assert.equal(result.expandedCount, 1);
});

test('preExtractCleanup: expand clicks are capped at MAX_EXPAND (8)', async () => {
  const buttons = Array.from({ length: 12 }, (_, i) => `<button aria-expanded="false" id="e${i}">展开${i}</button>`).join('\n');
  const html = `<!doctype html><html><body><main>${buttons}</main></body></html>`;
  const { result } = await runCleanup(html);
  assert.equal(result.expandedCount, 8, 'must stop at the MAX_EXPAND cap even with more candidates available');
});

test('preExtractCleanup: scroll step calls window.scrollTo and restores the original scroll position', async () => {
  const html = `<!doctype html><html><body><main>Some content.</main></body></html>`;
  const { scrollToCalls } = await runCleanup(html);
  assert.ok(scrollToCalls.length >= 1, 'scrollTo must be called at least once (scroll-to-bottom attempt)');
  const lastCall = scrollToCalls[scrollToCalls.length - 1];
  assert.deepEqual(lastCall, [0, 0], 'final scrollTo call must restore the original scrollY (0 in this test)');
});

test('preExtractCleanup: resolves promptly even when scrollHeight never grows (jsdom always reports 0)', async () => {
  const html = `<!doctype html><html><body><main>Some content.</main></body></html>`;
  const start = Date.now();
  await runCleanup(html);
  const elapsed = Date.now() - start;
  // jsdom's scrollHeight is always 0, so the "no growth" break should fire
  // after the first round -- this must not run anywhere near the full
  // 3.5s budget (which would indicate the loop isn't exiting early).
  assert.ok(elapsed < 2000, `expected an early exit on no-growth, took ${elapsed}ms`);
});

test('preExtractCleanup: returns a well-shaped result object even on a page with no banners/expand targets', async () => {
  const html = `<!doctype html><html><body><main>Plain article, nothing special.</main></body></html>`;
  const { result } = await runCleanup(html);
  assert.deepEqual(Object.keys(result).sort(), ['cookieDismissed', 'expandedCount', 'scrolledRounds']);
  assert.equal(result.cookieDismissed, false);
  assert.equal(result.expandedCount, 0);
});
