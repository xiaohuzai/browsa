// test/lib-deep-extract-pagefuncs.test.mjs — the three page-world functions
// added for deep extraction (lib/page-extractor.js): detectIncompleteness(),
// interactiveSnapshot(), clickIndexed(). Each is executed via
// chrome.scripting.executeScript's `func:` serialization in real Chrome, so
// every test here extracts the function source by brace-balancing and runs
// it in a vm sandbox whose ONLY page globals are the ones we hand it —
// which doubles as the self-containment regression (a stray reference to a
// module-level sibling throws ReferenceError and fails the test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EXTRACTOR = join(ROOT, 'lib/page-extractor.js');

async function loadSiblingFn(name, file = EXTRACTOR) {
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

// Build the minimal page-world sandbox: exactly the globals a MAIN-world
// function may touch. Anything else the function references is a bug.
function makeCtx(html, { url = 'https://example.com/a' } = {}) {
  const dom = new JSDOM(html, { url });
  return {
    dom,
    ctx: vm.createContext({
      document: dom.window.document,
      location: { href: url },
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      URL: globalThis.URL,
      setTimeout,
    }),
  };
}

// ── detectIncompleteness ────────────────────────────────────────────────────

test('detectIncompleteness: rel=next link wins and resolves to an absolute URL', async () => {
  const fn = await loadSiblingFn('detectIncompleteness');
  const { dom, ctx } = makeCtx(`<!doctype html><html><head>
    <link rel="next" href="/a?page=2"></head><body><p>hello</p></body></html>`);
  const out = await vm.runInContext(`${fn}\ndetectIncompleteness()`, ctx);
  assert.equal(out.nextPageHref, 'https://example.com/a?page=2');
  assert.equal(out.loadMore, false);
  assert.equal(out.expandersLeft, 0);
  dom.window.close();
});

test('detectIncompleteness: bare "›" only counts inside a pagination container', async () => {
  const fn = await loadSiblingFn('detectIncompleteness');
  // Breadcrumb "›" outside any pagination container must NOT fire…
  const { ctx: ctx1 } = makeCtx(`<body>
    <nav><a href="/b">Home</a> › <a href="/c">Sub</a></nav></body>`);
  const out1 = await vm.runInContext(`${fn}\ndetectIncompleteness()`, ctx1);
  assert.equal(out1.nextPageHref, null);
  // …but the same symbol inside a pagination list is a next control.
  const { ctx: ctx2 } = makeCtx(`<body>
    <ul class="pagination"><li><a href="/a?page=2">›</a></li></ul></body>`);
  const out2 = await vm.runInContext(`${fn}\ndetectIncompleteness()`, ctx2);
  assert.equal(out2.nextPageHref, 'https://example.com/a?page=2');
});

test('detectIncompleteness: standalone 下一页 anchor is found, self-link is rejected', async () => {
  const fn = await loadSiblingFn('detectIncompleteness');
  const { ctx } = makeCtx(`<body><a href="/a?page=2">下一页</a></body>`);
  const out = await vm.runInContext(`${fn}\ndetectIncompleteness()`, ctx);
  assert.equal(out.nextPageHref, 'https://example.com/a?page=2');

  const { ctx: ctxSelf } = makeCtx(`<body><a href="/a">下一页</a></body>`, { url: 'https://example.com/a' });
  const outSelf = await vm.runInContext(`${fn}\ndetectIncompleteness()`, ctxSelf);
  assert.equal(outSelf.nextPageHref, null); // points right back here
});

test('detectIncompleteness: load-more button by text and by class', async () => {
  const fn = await loadSiblingFn('detectIncompleteness');
  const { ctx } = makeCtx(`<body>
    <button>加载更多评论</button>
    <div class="load-more-btn">⋯</div></body>`);
  const out = await vm.runInContext(`${fn}\ndetectIncompleteness()`, ctx);
  assert.equal(out.loadMore, true);
});

test('detectIncompleteness: collapsed details/summary counts, chrome-region expander does not', async () => {
  const fn = await loadSiblingFn('detectIncompleteness');
  const { ctx } = makeCtx(`<body>
    <details><summary>查看附录</summary><p> appendix </p></details>
    <nav><button aria-expanded="false">菜单</button></nav></body>`);
  const out = await vm.runInContext(`${fn}\ndetectIncompleteness()`, ctx);
  assert.equal(out.expandersLeft, 1); // nav menu excluded
});

test('detectIncompleteness: a complete page fires no signals', async () => {
  const fn = await loadSiblingFn('detectIncompleteness');
  const { ctx } = makeCtx(`<body><article><p>${'word '.repeat(50)}</p></article></body>`);
  const out = await vm.runInContext(`${fn}\ndetectIncompleteness()`, ctx);
  assert.equal(out.nextPageHref, null);
  assert.equal(out.loadMore, false);
  assert.equal(out.expandersLeft, 0);
});

// ── interactiveSnapshot ─────────────────────────────────────────────────────

test('interactiveSnapshot: lists safe controls with data-browsa-ix, excludes real-href anchors and chrome regions', async () => {
  const fn = await loadSiblingFn('interactiveSnapshot');
  const { dom, ctx } = makeCtx(`<body>
    <nav><button>nav toggle</button></nav>
    <a href="https://elsewhere.example/x">navigating link</a>
    <a href="#more">hash toggle</a>
    <button aria-expanded="false">加载更多评论</button>
    <span role="button">展开详情</span></body>`);
  const out = await vm.runInContext(`${fn}\ninteractiveSnapshot({ maxChars: 5000 })`, ctx);
  // hash toggle + load-more + role=button; nav button and real link excluded
  assert.equal(out.count, 3);
  assert.equal(out.items.length, 3);
  assert.ok(out.items.some((l) => l.includes('加载更多评论') && l.includes('aria-expanded=false')));
  assert.ok(!out.text.includes('navigating link'));
  assert.ok(!out.text.includes('nav toggle'));
  // tags were stamped for clickIndexed to re-find
  const tagged = dom.window.document.querySelectorAll('[data-browsa-ix]');
  assert.equal(tagged.length, 3);
  dom.window.close();
});

test('interactiveSnapshot: empty page yields count 0', async () => {
  const fn = await loadSiblingFn('interactiveSnapshot');
  const { ctx } = makeCtx(`<body><p>plain text only</p></body>`);
  const out = await vm.runInContext(`${fn}\ninteractiveSnapshot()`, ctx);
  assert.equal(out.count, 0);
  assert.ok(out.text.length > 0); // header still present, harmless
});

// ── clickIndexed ────────────────────────────────────────────────────────────

test('clickIndexed: clicking a load-more that appends content reports the delta', async () => {
  const snapshot = await loadSiblingFn('interactiveSnapshot');
  const click = await loadSiblingFn('clickIndexed');
  const { dom, ctx } = makeCtx(`<body>
    <div id="feed"><p>item 1</p></div>
    <button id="more">加载更多</button></body>`);
  dom.window.document.getElementById('more').onclick = () => {
    const p = dom.window.document.createElement('p');
    p.textContent = 'item 2 with plenty of fresh text';
    dom.window.document.getElementById('feed').appendChild(p);
  };
  const script = `${snapshot}\nconst snap = interactiveSnapshot();\n${click}\n(async () => clickIndexed({ index: 0, settleMs: 800 }))()`;
  const out = await vm.runInContext(script, ctx);
  assert.equal(out.found, true);
  assert.equal(out.clicked, true);
  assert.equal(out.changed, true);
  assert.ok(out.deltaChars > 0);
});

test('clickIndexed: danger-word control is vetoed without clicking', async () => {
  const snapshot = await loadSiblingFn('interactiveSnapshot');
  const click = await loadSiblingFn('clickIndexed');
  const { dom, ctx } = makeCtx(`<body><button>删除全部评论</button></body>`);
  let clickedFlag = false;
  dom.window.document.querySelector('button').onclick = () => { clickedFlag = true; };
  const script = `${snapshot}\n${click}\n(async () => { interactiveSnapshot(); return clickIndexed({ index: 0, settleMs: 100 }); })()`;
  const out = await vm.runInContext(script, ctx);
  assert.equal(out.vetoed, true);
  assert.equal(out.clicked, false);
  assert.equal(clickedFlag, false);
});

test('clickIndexed: already-open expander and unknown index are no-ops', async () => {
  const snapshot = await loadSiblingFn('interactiveSnapshot');
  const click = await loadSiblingFn('clickIndexed');
  const { dom, ctx } = makeCtx(`<body><button aria-expanded="true">收起</button></body>`);
  const script = `${snapshot}\n${click}\n(async () => {
    interactiveSnapshot();
    const open = await clickIndexed({ index: 0, settleMs: 100 });
    const missing = await clickIndexed({ index: 42, settleMs: 100 });
    return { open, missing };
  })()`;
  const out = await vm.runInContext(script, ctx);
  assert.equal(out.open.found, true);
  assert.equal(out.open.clicked, false);
  assert.equal(out.missing.found, false);
});
