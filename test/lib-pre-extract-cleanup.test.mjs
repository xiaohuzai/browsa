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

async function runCleanup(html, setup) {
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  if (setup) setup(dom);
  const scrollToCalls = [];
  const paintSuppressedAtScroll = [];
  const ctx = vm.createContext({
    document: dom.window.document,
    window: {
      scrollY: 0,
      scrollTo: (x, y) => {
        scrollToCalls.push([x, y]);
        paintSuppressedAtScroll.push(dom.window.document.documentElement.style.opacity);
      },
    },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  return { result, scrollToCalls, paintSuppressedAtScroll, dom };
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
  // Real expanders: each click appends fresh text, so the zero-delta
  // bail-out must NOT fire and the pass runs to the MAX_EXPAND cap.
  const { result } = await runCleanup(html, (dom) => {
    for (let i = 0; i < 12; i++) {
      dom.window.document.getElementById(`e${i}`).onclick = () => {
        const p = dom.window.document.createElement('p');
        p.textContent = `appended section ${i} `.repeat(4);
        dom.window.document.querySelector('main').appendChild(p);
      };
    }
  });
  assert.equal(result.expandedCount, 8, 'must stop at the MAX_EXPAND cap even with more candidates available');
});

test('preExtractCleanup: zero-delta bail — sterile expanders stop the pass after two clicks', async () => {
  const buttons = Array.from({ length: 12 }, (_, i) => `<button aria-expanded="false" id="e${i}">展开${i}</button>`).join('\n');
  const html = `<!doctype html><html><body><main>${buttons}</main></body></html>`;
  // No-op buttons (clicks change nothing): decoration, not content gates —
  // the crawl4ai-style zero-delta rule must cut the pass at two sterile
  // clicks instead of burning the full budget on twelve.
  const { result } = await runCleanup(html);
  assert.equal(result.expandedCount, 2, 'two consecutive zero-delta clicks must stop the expansion pass');
});

test('preExtractCleanup: a static page with no lazy signals must NOT scroll at all (page stays still)', async () => {
  const html = `<!doctype html><html><body><main>Some content.</main></body></html>`;
  const { scrollToCalls } = await runCleanup(html);
  assert.equal(scrollToCalls.length, 0, 'a page with no lazy-loading/virtualization signals must not be scrolled — the visible scroll-jump on every attach was reported as unsettling');
});

test('preExtractCleanup: a lazy-loading page IS scrolled to bottom and the original position restored', async () => {
  const html = `<!doctype html><html><body>
    <main><img loading="lazy" src="https://example.com/pic.jpg"><p>Article.</p></main>
  </body></html>`;
  const { scrollToCalls } = await runCleanup(html);
  assert.ok(scrollToCalls.length >= 1, 'a page with lazy-load signals must still be scrolled');
  const lastCall = scrollToCalls[scrollToCalls.length - 1];
  assert.deepEqual(lastCall, [0, 0], 'final scrollTo call must restore the original scrollY (0 in this test)');
});

test('preExtractCleanup: the page is paint-suppressed only DURING the scroll phase, restored afterwards', async () => {
  const html = `<!doctype html><html><body>
    <main><img loading="lazy" src="https://example.com/pic.jpg"><p>Article.</p></main>
  </body></html>`;
  const { paintSuppressedAtScroll, dom } = await runCleanup(html);
  assert.ok(paintSuppressedAtScroll.length >= 1);
  assert.equal(paintSuppressedAtScroll[0], '0', 'the scroll phase must run while the document is paint-suppressed via opacity (the user sees a blink, not the page scrolling itself). opacity, not visibility: visibility is inherited and scroll-reveal sites choreograph against it');
  assert.equal(dom.window.document.documentElement.style.visibility, '', 'visibility must be restored once the scroll phase ends');
});

test('preExtractCleanup: a static page is never paint-suppressed at all', async () => {
  const html = `<!doctype html><html><body><main>Plain article.</main></body></html>`;
  const { paintSuppressedAtScroll, dom } = await runCleanup(html);
  assert.equal(paintSuppressedAtScroll.length, 0);
  assert.equal(dom.window.document.documentElement.style.visibility, '');
});

test('preExtractCleanup: resolves promptly even when scrollHeight never grows (jsdom always reports 0)', async () => {
  const html = `<!doctype html><html><body>
    <main><img loading="lazy" src="https://example.com/pic.jpg">Some content.</main>
  </body></html>`;
  const start = Date.now();
  await runCleanup(html);
  const elapsed = Date.now() - start;
  // jsdom's scrollHeight is always 0, so the "no growth" break should fire
  // after the first round -- this must not run anywhere near the full
  // 3.5s budget (which would indicate the loop isn't exiting early).
  assert.ok(elapsed < 2000, `expected an early exit on no-growth, took ${elapsed}ms`);
});

test('preExtractCleanup: does NOT expand controls inside chrome regions (nav/header/footer)', async () => {
  const html = `<!doctype html><html><body>
    <nav><button aria-expanded="false" id="nav-btn">展开菜单</button></nav>
    <header><button aria-expanded="false" id="hdr-btn">展开</button></header>
    <main><button aria-expanded="false" id="art-btn">展开</button></main>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  const clicked = [];
  for (const id of ['nav-btn', 'hdr-btn', 'art-btn']) {
    dom.window.document.getElementById(id).addEventListener('click', () => clicked.push(id));
  }
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const ctx = vm.createContext({
    document: dom.window.document,
    window: { scrollY: 0, scrollTo: () => {} },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  assert.deepEqual(clicked, ['art-btn'], 'only the in-article expander may be clicked; nav/header disclosure widgets are site chrome (the reported GitHub mega-menu incident)');
  assert.equal(result.expandedCount, 1);
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

// Regression: real user report — attaching
// https://hfviewer.com/blog/architecture-trends-over-5-years failed with
// "⚠ Failed to read page DOM: Frame with ID 0 was removed." The site's brand
// link is `<a id="brand" aria-expanded="false" href="/">`: it sits outside any
// nav/header (so the chrome exclusion misses it) and carries no danger word,
// so Step 2 clicked it, the tab navigated to the home page, and the frame the
// extraction was about to read was destroyed. Anchors are only safe when they
// cannot navigate — same rule interactiveSnapshot already applies.
test('preExtractCleanup: does NOT click an anchor with a real href (regression: navigating click destroyed the frame mid-attach)', async () => {
  const html = `<!doctype html><html><body>
    <main>
      <a id="brand" href="/" aria-expanded="false">hfviewer by embedl</a>
      <button aria-expanded="false" id="expand-btn">展开</button>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/blog/post' });
  let navClicked = false;
  dom.window.document.getElementById('brand').addEventListener('click', () => { navClicked = true; });
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const ctx = vm.createContext({
    document: dom.window.document,
    window: { scrollY: 0, scrollTo: () => {} },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  assert.equal(navClicked, false, 'an <a href="/"> must never be clicked: it navigates the tab and the extraction dies on a destroyed frame');
  assert.equal(result.expandedCount, 1, 'the genuine href-less expander next to it must still be clicked');
});

test('preExtractCleanup: still clicks href-less / hash / javascript: anchors (they are pure JS toggles)', async () => {
  const html = `<!doctype html><html><body>
    <main>
      <a id="a1" aria-expanded="false">展开一</a>
      <a id="a2" href="#" aria-expanded="false">展开二</a>
      <a id="a3" href="javascript:void(0)" aria-expanded="false">展开三</a>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/blog/post' });
  for (const id of ['a1', 'a2', 'a3']) {
    // Each click appends text so the zero-delta bail-out does not cut the pass.
    dom.window.document.getElementById(id).addEventListener('click', () => {
      const p = dom.window.document.createElement('p');
      p.textContent = `revealed by ${id} `.repeat(6);
      dom.window.document.querySelector('main').appendChild(p);
    });
  }
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const ctx = vm.createContext({
    document: dom.window.document,
    window: { scrollY: 0, scrollTo: () => {} },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  assert.equal(result.expandedCount, 3, 'href-less/#/javascript: anchors cannot navigate and must stay eligible');
});

// Regression: real user report — attaching
// https://labuladong.online/zh/ai-coding/llm/lora-fine-tuning/ degraded to the
// 124K-char full-text wall (autoMode=full) because Step 2 clicked the site's
// 「清除阅读历史」 button, which popped a destructive-confirmation dialog that
// Readability then scored as the article. Three guards pin the fix.

test('preExtractCleanup: expand candidates inside <aside> are site chrome and must not be clicked (aligned with isChromeNoise)', async () => {
  const html = `<!doctype html><html><body>
    <aside><button aria-expanded="false" id="sidebar-btn">清除阅读历史</button></aside>
    <main><button aria-expanded="false" id="content-btn">展开正文</button></main>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/blog/post' });
  let sidebarClicked = false;
  dom.window.document.getElementById('sidebar-btn').addEventListener('click', () => { sidebarClicked = true; });
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const ctx = vm.createContext({
    document: dom.window.document,
    window: { scrollY: 0, scrollTo: () => {} },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  assert.equal(sidebarClicked, false, 'a sidebar utility button is chrome, not a content gate — clicking it armed a destructive action on the reported site');
  assert.equal(result.expandedCount, 1, 'the genuine expander in <main> must still be clicked');
});

test('preExtractCleanup: destructive labels (清除/clear/reset family) are vetoed even outside chrome regions', async () => {
  const html = `<!doctype html><html><body>
    <main>
      <button aria-expanded="false" id="clear-history">清除阅读历史</button>
      <button aria-expanded="false" id="clear-en">Clear reading history</button>
      <button aria-expanded="false" id="reset-en">Reset all</button>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/blog/post' });
  let clicked = 0;
  for (const id of ['clear-history', 'clear-en', 'reset-en']) {
    dom.window.document.getElementById(id).addEventListener('click', () => { clicked++; });
  }
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const ctx = vm.createContext({
    document: dom.window.document,
    window: { scrollY: 0, scrollTo: () => {} },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  assert.equal(clicked, 0, 'none of the destructive-label buttons may be clicked');
  assert.equal(result.expandedCount, 0);
});

test('preExtractCleanup: a click that pops a dialog is rolled back, the dialog dismissed, and the pass stops', async () => {
  const html = `<!doctype html><html><body>
    <main>
      <button aria-expanded="false" id="arm">Show more</button>
      <button aria-expanded="false" id="second">Show even more</button>
      <dialog id="dlg"><p>Confirm destructive action?</p><button id="cancel">取消</button></dialog>
    </main>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://example.com/blog/post' });
  const doc = dom.window.document;
  let secondClicked = false;
  doc.getElementById('second').addEventListener('click', () => { secondClicked = true; });
  // The site's own handler: arming click opens the dialog, 取消 closes it.
  // (jsdom has no HTMLDialogElement.close(), so the handler mirrors what a
  // real browser's close() does via the reflected `open` attribute.)
  doc.getElementById('arm').addEventListener('click', () => { doc.getElementById('dlg').open = true; });
  doc.getElementById('cancel').addEventListener('click', () => { doc.getElementById('dlg').open = false; });
  const fnBody = await loadSiblingFn('preExtractCleanup');
  const ctx = vm.createContext({
    document: doc,
    window: { scrollY: 0, scrollTo: () => {} },
    setTimeout,
  });
  const result = await vm.runInContext(`${fnBody}\npreExtractCleanup()`, ctx);
  assert.equal(doc.getElementById('dlg').open, false, 'a dialog the pass opened must be dismissed, not left for Readability to score as the article');
  assert.equal(result.expandedCount, 0, 'a dialog-opening click expanded no content — must not count as an expansion');
  assert.equal(result.dialogsDismissed, 1);
  assert.equal(secondClicked, false, 'the pass must stop once a click has popped a dialog');
});
