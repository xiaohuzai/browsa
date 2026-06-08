// test/page-extractor.test.mjs — end-to-end tests for the page extraction
// pipeline that runs in the page's MAIN world.
//
// We load the IIFE vendor bundles into a vm context, hand them a JSDOM
// environment, then drive them through the same code path as
// lib/page-extractor.js's extractInPageWorld() function. For the
// Xiaohongshu extractor we just run the function body directly against
// a synthesized JSDOM document — no Readability needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function makePageWorld() {
  const jsdom = new JSDOM('');
  const sandbox = {
    document: jsdom.window.document,
    DOMParser: jsdom.window.DOMParser,
    window: jsdom.window,
    console: console
  };
  const ctx = vm.createContext(sandbox);
  return { ctx, jsdom };
}

async function injectVendor(ctx) {
  const rSrc = await readFile(join(ROOT, 'lib/vendor/Readability.iife.js'), 'utf8');
  const tSrc = await readFile(join(ROOT, 'lib/vendor/Turndown.iife.js'), 'utf8');
  vm.runInContext(rSrc, ctx);
  vm.runInContext(tSrc, ctx);
  return {
    Readability: ctx.Readability,
    TurndownService: ctx.TurndownService
  };
}

test('Readability bundle loads and exposes constructor', async () => {
  const { ctx } = makePageWorld();
  const { Readability } = await injectVendor(ctx);
  assert.equal(typeof Readability, 'function', 'Readability should be a constructor');
  assert.equal(Readability.name, 'Readability');
});

test('Turndown bundle loads and exposes constructor', async () => {
  const { ctx } = makePageWorld();
  const { TurndownService } = await injectVendor(ctx);
  assert.equal(typeof TurndownService, 'function', 'TurndownService should be a constructor');
  assert.equal(TurndownService.name, 'TurndownService');
});

test('Readability extracts main article, strips nav/aside/footer', async () => {
  const { ctx, jsdom } = makePageWorld();
  const { Readability } = await injectVendor(ctx);
  const html = `<html><body>
    <nav>SKIP-NAV</nav>
    <aside>SKIP-ASIDE</aside>
    <main>
      <h1>Test Article</h1>
      <p>This is a long enough paragraph to exceed the readability threshold
      and be considered the main content of the page. It needs to be quite
      long to push past charThreshold=1500 in our production code, so let's
      pad it with some additional content to make sure that the article
      parser recognizes it as the main content. Adding more content here
      so Readability has something substantial to extract. The quick brown
      fox jumps over the lazy dog. The quick brown fox jumps over the lazy
      dog. The quick brown fox jumps over the lazy dog. The quick brown
      fox jumps over the lazy dog. The quick brown fox jumps over the lazy
      dog. The quick brown fox jumps over the lazy dog.</p>
    </main>
    <footer>SKIP-FOOTER</footer>
  </body></html>`;
  const doc = new jsdom.window.DOMParser().parseFromString(html, 'text/html');
  const reader = new Readability(doc, { charThreshold: 500, keepClasses: false });
  const article = reader.parse();
  assert.ok(article, 'should return an article');
  assert.ok(article.textContent.includes('Test Article'), 'article should contain h1');
  assert.ok(!article.textContent.includes('SKIP-NAV'), 'article should not include nav');
  assert.ok(!article.textContent.includes('SKIP-ASIDE'), 'article should not include aside');
  assert.ok(!article.textContent.includes('SKIP-FOOTER'), 'article should not include footer');
});

test('Turndown converts h1/p/strong/img/ul/pre to Markdown', async () => {
  const { ctx } = makePageWorld();
  const { TurndownService } = await injectVendor(ctx);
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  const md = td.turndown(`
    <h1>Title</h1>
    <p>paragraph with <strong>bold</strong></p>
    <img src="https://example.com/x.jpg" alt="alt text"/>
    <ul><li>one</li><li>two</li></ul>
    <pre><code class="language-py">print(1)</code></pre>
  `);
  assert.ok(md.startsWith('# Title'), `should start with h1, got: ${md.slice(0, 30)}`);
  assert.ok(md.includes('**bold**'), 'should bold strong');
  assert.ok(md.includes('![alt text](https://example.com/x.jpg)'), 'should image');
  assert.ok(/- one|-   one/.test(md), `should list with dash, got: ${md}`);
  assert.ok(md.includes('```'), 'should have code fence');
});

test('end-to-end: Readability → Turndown pipeline', async () => {
  const { ctx, jsdom } = makePageWorld();
  const { Readability, TurndownService } = await injectVendor(ctx);
  const html = `<html><body>
    <nav>nav-strip</nav>
    <main>
      <h1>Pipeline Test</h1>
      <p>${'A long paragraph. '.repeat(80)}</p>
      <h2>Section</h2>
      <p>Another paragraph.</p>
    </main>
  </body></html>`;
  const doc = new jsdom.window.DOMParser().parseFromString(html, 'text/html');
  const reader = new Readability(doc, { charThreshold: 500, keepClasses: false });
  const article = reader.parse();
  const td = new TurndownService({ headingStyle: 'atx' });
  const md = td.turndown(article.content);
  assert.ok(md.includes('# Pipeline Test'), 'md should have h1');
  assert.ok(md.includes('## Section'), 'md should have h2');
  assert.ok(!md.includes('nav-strip'), 'md should not have nav text');
});

// --- Xiaohongshu extractor --------------------------------------------------
// We read the extractor function body straight from lib/page-extractor.js
// and execute it inside a vm sandbox that mimics the page world (a global
// `document` + `DOMParser`). This keeps the test in lockstep with the
// production source — no risk of the two drifting apart. If the function
// ever stops existing or its signature changes, the tests will fail loudly.

async function runXhsInSandbox(html) {
  // Extract the function body of `extractXiaohongshuInPageWorld` from the
  // real source file. We match the `function ...(...)` header and grab
  // everything up to the matching closing brace. We strip the outer
  // braces so we can re-emit it as a top-level function declaration in
  // the sandbox, then invoke it.
  const src = await readFile(join(ROOT, 'lib/page-extractor.js'), 'utf8');
  const fnMatch = src.match(/function extractXiaohongshuInPageWorld\(\)\s*\{/);
  if (!fnMatch) throw new Error('extractXiaohongshuInPageWorld not found in page-extractor.js');
  const start = fnMatch.index;
  // Walk forward, counting braces, to find the matching close.
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error('unbalanced braces in extractXiaohongshuInPageWorld');
  const fnBody = src.slice(start, i + 1);

  const dom = new JSDOM(html);
  const ctx = vm.createContext({
    document: dom.window.document,
    DOMParser: dom.window.DOMParser
  });
  // Emit as a top-level declaration so `document` resolves from the sandbox
  // global, exactly as it would in the page world.
  return vm.runInContext(`${fnBody}\n;extractXiaohongshuInPageWorld();`, ctx);
}

test('xhs extractor: extracts title and desc from real-looking detail page', async () => {
  const out = await runXhsInSandbox(`<!doctype html>
    <html><body>
      <div id="app">
        <header>推荐 feed 列表（应该被忽略）</header>
        <main>
          <div id="detail-title">自驾转具身，如何克服水土不服</div>
          <div id="detail-desc">去年从某新势力跳到具身创业公司，说说几点感受。1. 算法栈完全不一样...
          </div>
        </main>
        <aside>相关推荐</aside>
      </div>
    </body></html>`);
  assert.equal(out.error, undefined, 'should not error');
  assert.equal(out.articleTitle, '自驾转具身，如何克服水土不服');
  assert.ok(out.text.startsWith('# 自驾转具身，如何克服水土不服'));
  assert.ok(out.text.includes('算法栈完全不一样'));
  assert.ok(!out.text.includes('推荐 feed'), 'must not include unrelated feed text');
  assert.ok(!out.text.includes('相关推荐'), 'must not include sidebar text');
  assert.equal(out.source, 'xiaohongshu');
  assert.equal(out.imageCount, 0);
});

test('xhs extractor: returns error when anchors are missing', async () => {
  const out = await runXhsInSandbox(`<!doctype html><html><body><div>just a normal page</div></body></html>`);
  assert.ok(out.error, 'should return error when anchors are missing');
  assert.match(out.error, /detail-title|detail-desc/);
});

test('xhs extractor: counts images inside swiper', async () => {
  const out = await runXhsInSandbox(`<!doctype html>
    <html><body>
      <div id="detail-title">多图笔记</div>
      <div id="detail-desc">正文</div>
      <div class="swiper">
        <div class="swiper-slide"><img src="a.jpg"></div>
        <div class="swiper-slide"><img src="b.jpg"></div>
        <div class="swiper-slide"><img src="c.jpg"></div>
      </div>
    </body></html>`);
  assert.equal(out.imageCount, 3);
});

test('xhs extractor: collects tags (auto-prefixes #)', async () => {
  const out = await runXhsInSandbox(`<!doctype html>
    <html><body>
      <div id="detail-title">标题</div>
      <div id="detail-desc">正文</div>
      <a class="tag">自驾</a>
      <a class="tag">具身智能</a>
      <a class="tag">#跳槽</a>
    </body></html>`);
  assert.ok(out.text.includes('#自驾'), `should prefix #, got: ${out.text}`);
  assert.ok(out.text.includes('#具身智能'));
  assert.ok(out.text.includes('#跳槽'), 'existing # should be preserved');
});

test('xhs extractor: collects top comments when present', async () => {
  const out = await runXhsInSandbox(`<!doctype html>
    <html><body>
      <div id="detail-title">标题</div>
      <div id="detail-desc">正文</div>
      <div class="comment-item">
        <div class="content">第一条评论的内容写在这里</div>
      </div>
      <div class="comment-item">
        <div class="content">第二条评论</div>
      </div>
    </body></html>`);
  assert.ok(out.text.includes('## Top comments'));
  assert.ok(out.text.includes('1. 第一条评论'));
  assert.ok(out.text.includes('2. 第二条评论'));
});

// --- XHS anchor poll --------------------------------------------------------
// Mirrors the polling function injected into the page before the extractor
// runs. The poll resolves as soon as #detail-desc is present and has
// non-whitespace text, OR after waitMs, whichever comes first.

function runXhsPollInSandbox(initialHtml, waitMs = 1000, pollMs = 25, mutateAt = null) {
  const dom = new JSDOM(initialHtml);
  const ctx = vm.createContext({
    document: dom.window.document,
    setTimeout: setTimeout,
    Date: Date
  });
  const src = `
    (async () => {
      const start = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const t = document.querySelector('#detail-title');
        const d = document.querySelector('#detail-desc');
        if (t && d && (d.textContent || '').trim()) {
          return { ready: true, waited: Date.now() - start };
        }
        if (Date.now() - start > ${waitMs}) {
          return { ready: false, waited: Date.now() - start };
        }
        await new Promise((r) => setTimeout(r, ${pollMs}));
      }
    })()
  `;
  const p = vm.runInContext(src, ctx);
  // Optionally schedule a DOM mutation that should let the poll resolve.
  if (mutateAt !== null) {
    setTimeout(() => {
      const desc = dom.window.document.querySelector('#detail-desc');
      if (desc) desc.textContent = 'late XHR injected content';
    }, mutateAt);
  }
  return p;
}

test('xhs poll: resolves immediately when anchors already present', async () => {
  const p = runXhsPollInSandbox(
    `<html><body><div id="detail-title">t</div><div id="detail-desc">d</div></body></html>`,
    1000, 25
  );
  const out = await p;
  assert.equal(out.ready, true);
  assert.ok(out.waited < 100, `should be near-instant, got ${out.waited}ms`);
});

test('xhs poll: waits for late XHR injection', async () => {
  const p = runXhsPollInSandbox(
    `<html><body><div id="detail-title">t</div><div id="detail-desc"></div></body></html>`,
    1000, 25,
    100  // inject content after 100ms
  );
  const out = await p;
  assert.equal(out.ready, true);
  assert.ok(out.waited >= 100, `should have waited for injection, got ${out.waited}ms`);
  assert.ok(out.waited < 500, `should not have waited too long, got ${out.waited}ms`);
});

test('xhs poll: times out when anchors never appear', async () => {
  const p = runXhsPollInSandbox(
    `<html><body><p>no anchors</p></body></html>`,
    200, 25
  );
  const out = await p;
  assert.equal(out.ready, false);
  assert.ok(out.waited >= 200, `should have hit timeout, got ${out.waited}ms`);
});

test('xhs poll: does not treat whitespace-only desc as ready', async () => {
  const p = runXhsPollInSandbox(
    `<html><body>
       <div id="detail-title">t</div>
       <div id="detail-desc">   \n   </div>
     </body></html>`,
    200, 25
  );
  const out = await p;
  assert.equal(out.ready, false, 'whitespace-only desc should not satisfy the poll');
});
