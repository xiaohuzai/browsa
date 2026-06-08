// test/page-extractor.test.mjs — end-to-end test for the Readability +
// Turndown pipeline that runs in the page's MAIN world.
//
// We load the IIFE vendor bundles into a vm context, hand them a JSDOM
// environment, then drive them through the same code path as
// lib/page-extractor.js's extractInPageWorld() function.

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
