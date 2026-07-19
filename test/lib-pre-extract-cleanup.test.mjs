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

// --- Virtualized/windowed-feed scroll-and-restore ---------------------------
// Ported from auditing crawl4ai's _handle_virtual_scroll -- a virtualized
// feed REPLACES off-screen items in the DOM as the user scrolls (unlike
// ordinary lazy-load, which only appends), so items snapshotted before a
// scroll round that are no longer present afterward must be restored as
// invisible clones for the later extraction pass to still see them.

test('preExtractCleanup: restores items that a simulated virtualized feed removed during scroll', async () => {
  const html = `<!doctype html><html><body>
    <div id="feed">
      <div class="post">Post Alpha content here</div>
      <div class="post">Post Beta content here</div>
      <div class="post">Post Gamma content here</div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  const doc = dom.window.document;
  const feed = doc.getElementById('feed');

  // jsdom has no layout engine (scrollHeight/clientHeight always report 0);
  // stub them so the feed container passes the "meaningfully scrollable"
  // gate in findFeedCandidate, same technique already used elsewhere in this
  // suite for offsetWidth/offsetHeight.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this === feed ? 5000 : 0; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this === feed ? 500 : 0; } });

  const fnBody = await loadSiblingFn('preExtractCleanup');

  // Simulate windowing: the first scrollTo call removes "Post Alpha" (as a
  // real virtualized list would when it scrolls out of the render window)
  // and appends a new "Post Delta" item -- child count stays roughly flat,
  // so the ordinary lazy-load "did it grow?" check alone wouldn't catch this.
  let scrollCalls = 0;
  const ctx = vm.createContext({
    document: doc,
    window: {
      scrollY: 0,
      innerHeight: 800,
      scrollTo: () => {
        scrollCalls++;
        if (scrollCalls === 1) {
          const alpha = [...feed.children].find((c) => c.textContent.includes('Alpha'));
          if (alpha) feed.removeChild(alpha);
          const delta = doc.createElement('div');
          delta.className = 'post';
          delta.textContent = 'Post Delta content here';
          feed.appendChild(delta);
        }
      },
    },
    setTimeout,
  });

  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);

  const restored = feed.querySelectorAll('[data-browsa-restored="1"]');
  assert.ok(restored.length >= 1, 'at least one removed item must be restored as a clone');
  const restoredText = [...restored].map((el) => el.textContent).join(' ');
  assert.match(restoredText, /Alpha/, 'the specific item removed mid-scroll (Alpha) must be among the restored clones');
  // Restored clones must be invisible (off-screen), not affecting layout
  assert.match(restored[0].style.cssText, /position:\s*absolute/, 'restored clone must be positioned off-screen, not display:none/hidden');
  assert.ok(result.feedItemsRestored >= 1);
});

test('preExtractCleanup: restores image-only (no visible text) feed items too (regression for falsy-empty-string hash key bug)', async () => {
  const html = `<!doctype html><html><body>
    <div id="feed">
      <div class="post"><img src="https://example.com/photo-alpha.jpg"></div>
      <div class="post"><img src="https://example.com/photo-beta.jpg"></div>
      <div class="post"><img src="https://example.com/photo-gamma.jpg"></div>
    </div>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  const doc = dom.window.document;
  const feed = doc.getElementById('feed');

  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this === feed ? 5000 : 0; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this === feed ? 500 : 0; } });

  const fnBody = await loadSiblingFn('preExtractCleanup');

  let scrollCalls = 0;
  const ctx = vm.createContext({
    document: doc,
    window: {
      scrollY: 0,
      innerHeight: 800,
      scrollTo: () => {
        scrollCalls++;
        if (scrollCalls === 1) {
          const alpha = [...feed.children].find((c) => c.querySelector('img').src.includes('alpha'));
          if (alpha) feed.removeChild(alpha);
          const delta = doc.createElement('div');
          delta.className = 'post';
          const img = doc.createElement('img');
          img.src = 'https://example.com/photo-delta.jpg';
          delta.appendChild(img);
          feed.appendChild(delta);
        }
      },
    },
    setTimeout,
  });

  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);

  const restored = feed.querySelectorAll('[data-browsa-restored="1"]');
  assert.ok(restored.length >= 1, 'at least one removed image-only item must be restored -- an empty textContent must not be silently skipped');
  const restoredSrcs = [...restored].map((el) => el.querySelector('img')?.src || '').join(' ');
  assert.match(restoredSrcs, /alpha/, 'the specific image-only item removed mid-scroll must be among the restored clones');
});

test('preExtractCleanup: does nothing feed-related on a page with no repeated-group container', async () => {
  const html = `<!doctype html><html><body><main>Just one plain article, no list.</main></body></html>`;
  const { result } = await runCleanup(html);
  assert.equal(result.feedItemsRestored, undefined, 'feedItemsRestored must not be set when no feed candidate was found');
});
