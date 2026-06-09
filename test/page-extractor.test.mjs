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

async function runXhsInSandbox(html, url = 'https://www.xiaohongshu.com/explore/6a141d03000000003502b14f') {
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

  const dom = new JSDOM(html, { url });
  const ctx = vm.createContext({
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    location: dom.window.location
  });
  // Emit as a top-level declaration so `document` / `location` resolve
  // from the sandbox global, exactly as they would in the page world.
  // gradeXiaohongshuResult is a sibling function the extractor calls
  // — it has to be loaded into the sandbox too.
  const siblingBody = await loadSiblingFn('gradeXiaohongshuResult');
  return vm.runInContext(
    `${siblingBody}\n${fnBody}\n;extractXiaohongshuInPageWorld();`,
    ctx
  );
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

// --- INITIAL_STATE extractor path -------------------------------------------
// The full extractXiaohongshuInPageWorld function tries two sources.
// runXhsInSandbox already exercises the DOM fallback (the existing 5 tests).
// Here we add tests that synthesize window.__INITIAL_STATE__ and verify
// the INITIAL_STATE branch wins over the DOM branch (richer data, no race).

async function runXhsWithStateInSandbox(html, initialState) {
  const dom = new JSDOM(html, { url: 'https://www.xiaohongshu.com/explore/6a141d03000000003502b14f' });
  // Inject the global
  dom.window.__INITIAL_STATE__ = initialState;
  const ctx = vm.createContext({
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    window: dom.window,
    location: dom.window.location,
    __INITIAL_STATE__: initialState
  });
  const src = await readFile(join(ROOT, 'lib/page-extractor.js'), 'utf8');
  const fnMatch = src.match(/function extractXiaohongshuInPageWorld\(\)\s*\{/);
  const start = fnMatch.index;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fnBody = src.slice(start, i + 1);
  const siblingBody = await loadSiblingFn('gradeXiaohongshuResult');
  return vm.runInContext(
    `${siblingBody}\n${fnBody}\n;extractXiaohongshuInPageWorld();`,
    ctx
  );
}

test('xhs INITIAL_STATE: extracts title, desc, author, stats, tags', async () => {
  const html = `<html><body><div id="detail-title">DOM_TITLE_IGNORE</div><div id="detail-desc">DOM_DESC_IGNORE</div></body></html>`;
  const out = await runXhsWithStateInSandbox(html, {
    note: {
      noteDetailMap: {
        '6a141d03000000003502b14f': {
          note: {
            title: '创业早期最大的幻觉之一',
            desc: '创业团队常误以为"凑了一个局"即为团队',
            user: { nickname: '某创业 CEO' },
            imageList: [{ url: 'a' }, { url: 'b' }],
            tagList: [{ name: '心智模式提升' }, { name: '#创业的本质' }],
            interactInfo: { likedCount: 1234, commentCount: 56 }
          }
        }
      }
    }
  });
  assert.equal(out.xhsSubSource, 'initial-state');
  assert.equal(out.articleTitle, '创业早期最大的幻觉之一');
  assert.equal(out.articleByline, '某创业 CEO');
  assert.ok(out.text.includes('# 创业早期最大的幻觉之一'));
  assert.ok(out.text.includes('**作者**: 某创业 CEO'));
  assert.ok(out.text.includes('创业团队常误以为'));
  assert.ok(out.text.includes('#心智模式提升'), 'should auto-prefix #');
  assert.ok(out.text.includes('#创业的本质'), 'should preserve existing #');
  assert.ok(out.text.includes('👍 1234'), 'should include like count');
  assert.ok(out.text.includes('💬 56'), 'should include comment count');
  assert.ok(out.text.includes('🖼 2 图'), 'should include image count');
  // DOM should NOT be consulted when INITIAL_STATE is present
  assert.ok(!out.text.includes('DOM_TITLE_IGNORE'), 'should not include DOM title');
  assert.ok(!out.text.includes('DOM_DESC_IGNORE'), 'should not include DOM desc');
});

test('xhs INITIAL_STATE: falls back to DOM when state is empty', async () => {
  const html = `<html><body>
    <div id="detail-title">DOM only title</div>
    <div id="detail-desc">DOM only desc with content</div>
  </body></html>`;
  const out = await runXhsWithStateInSandbox(html, {
    note: { noteDetailMap: { '6a141d03000000003502b14f': { note: {} } } }
  });
  assert.equal(out.xhsSubSource, 'dom');
  assert.ok(out.text.includes('DOM only title'));
  assert.ok(out.text.includes('DOM only desc with content'));
});

test('xhs INITIAL_STATE: falls back to DOM when state is missing the noteId', async () => {
  const html = `<html><body>
    <div id="detail-title">DOM fallback title</div>
    <div id="detail-desc">DOM fallback desc</div>
  </body></html>`;
  const out = await runXhsWithStateInSandbox(html, {
    note: { noteDetailMap: {} }  // different noteId
  });
  assert.equal(out.xhsSubSource, 'dom');
  assert.ok(out.text.includes('DOM fallback title'));
});

test('xhs INITIAL_STATE: returns error when both sources fail', async () => {
  const html = `<html><body><p>no anchors, no state</p></body></html>`;
  const out = await runXhsWithStateInSandbox(html, { note: { noteDetailMap: {} } });
  assert.ok(out.error, 'should return error');
  assert.match(out.error, /detail-title/);
});

// --- Xiaohongshu grading guard ---------------------------------------------
// gradeXiaohongshuResult is a small pure function that decides whether
// the XHS extraction result looks trustworthy. We extract it from
// page-extractor.js and exercise it directly. This is the v0.18.0
// "honest mode" gate: rather than pretending the result is fine, we
// surface a yellow banner when desc is suspiciously short or empty.

async function runGrade(args) {
  const fnBody = await loadSiblingFn('gradeXiaohongshuResult');
  const ctx = vm.createContext({});
  vm.runInContext(fnBody, ctx);
  return vm.runInContext(
    `gradeXiaohongshuResult(${JSON.stringify(args)})`,
    ctx
  );
}

test('grade: full real-looking note is NOT degraded', async () => {
  const r = await runGrade({
    desc: '创业团队常误以为"凑了一个局"即为团队，实则松散。真正的团队需共同目标、深度投入。',
    title: '创业早期最大的幻觉之一',
    imageCount: 0,
    source: 'initial-state'
  });
  assert.equal(r.xhsDegraded, false);
  // Cross-vm objects don't share prototypes; deepEqual is too strict.
  // Compare JSON shape instead.
  assert.equal(JSON.stringify(r.xhsDegradeReasons), '[]');
  assert.ok(r.xhsDescLen > 30);
});

test('grade: tiny desc (the v0.16.x failure mode) IS degraded', async () => {
  // This is what happens when 小红书 returns a skeleton or wrong note
  // because the user isn't logged in / x-s signing failed / etc.
  const r = await runGrade({
    desc: '创业',  // 2 chars
    title: '某标题',
    imageCount: 0,
    source: 'dom'
  });
  assert.equal(r.xhsDegraded, true);
  assert.ok(r.xhsDegradeReasons.some((s) => /desc too short/.test(s)));
});

test('grade: empty title is degraded', async () => {
  const r = await runGrade({
    desc: 'Some reasonable desc that exceeds the threshold',
    title: '',
    imageCount: 5,
    source: 'initial-state'
  });
  assert.equal(r.xhsDegraded, true);
  assert.ok(r.xhsDegradeReasons.some((s) => /title empty/.test(s)));
});

test('grade: no images + short desc is degraded (videos with caption still pass)', async () => {
  const r1 = await runGrade({ desc: '短', title: 't', imageCount: 0, source: 'dom' });
  assert.equal(r1.xhsDegraded, true, 'no images + 1-char desc should flag');
  // If the desc is longer (a real video caption), it's fine even with 0 images
  const r2 = await runGrade({ desc: '这是一段超过三十个字符的足够长的视频说明文字好好好好好呀呀呀呀', title: 't', imageCount: 0, source: 'dom' });
  assert.ok(r2.xhsDescLen > 30, `want >30 chars, got ${r2.xhsDescLen}`);
  assert.equal(r2.xhsDegraded, false, 'long caption + no images is fine');
});

test('grade: missing fields default cleanly (no crash)', async () => {
  const r = await runGrade({});
  assert.equal(r.xhsDegraded, true, 'missing everything = degraded');
  assert.equal(r.xhsDescLen, 0);
});

test('end-to-end: full XHS INITIAL_STATE pipeline returns xhsDegraded=false for a real note', async () => {
  const html = `<html><body><div id="detail-title">x</div><div id="detail-desc">x</div></body></html>`;
  const out = await runXhsWithStateInSandbox(html, {
    note: { noteDetailMap: { '6a141d03000000003502b14f': { note: {
      title: '创业早期最大的幻觉之一',
      desc: '创业团队常误以为凑了一个局即为团队。真正的团队需共同目标、深度投入。',
      user: { nickname: '某 CEO' },
      imageList: [],
      tagList: [],
      interactInfo: { likedCount: 10, commentCount: 0 }
    } } } }
  });
  assert.equal(out.xhsDegraded, false, 'a real-looking note should NOT be flagged');
});

test('end-to-end: empty INITIAL_STATE desc flags degraded', async () => {
  const html = `<html><body><div id="detail-title">x</div><div id="detail-desc">x</div></body></html>`;
  const out = await runXhsWithStateInSandbox(html, {
    note: { noteDetailMap: { '6a141d03000000003502b14f': { note: {
      title: '某标题',
      desc: '',  // empty — the failure mode we want to surface
      user: { nickname: 'x' },
      imageList: [],
      tagList: [],
      interactInfo: {}
    } } } }
  });
  assert.equal(out.xhsDegraded, true);
});

// --- Navigation broadcast (background.js → side panel) ----------------------
// We extract the pure dedupeAndBroadcast function from background.js and
// test it directly. The function takes (lastNavMap, navPortsMap, tabId, url)
// and returns the new map + number of ports notified. The navPortsMap is
// `Map<tabId, Set<port>>` where each port has a postMessage method. We
// can't serialize those across the vm boundary, so we stash the port
// objects in a registry and reference them by id.

const portRegistry = new Map();
let portIdCounter = 0;
function makePort(label, sink) {
  const id = ++portIdCounter;
  const port = {
    __portId: id,
    label,
    postMessage: (m) => sink.push({ ...m, __portId: id, __label: label })
  };
  portRegistry.set(id, port);
  return port;
}

async function loadDedupeFn() {
  const src = await readFile(join(ROOT, 'background.js'), 'utf8');
  const m = src.match(/function dedupeAndBroadcast\([^)]*\)\s*\{/);
  if (!m) throw new Error('dedupeAndBroadcast not found in background.js');
  const start = m.index;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// Extract a top-level function body from a file by name. Used to
// inject sibling functions into the vm sandbox so the function under
// test can call them. Reads lib/page-extractor.js by default.
//
// Caveat: the function's parameter list may contain a destructured
// object like `({ desc, title })` which has its own `{...}` braces.
// We have to find the OPENING `{` of the function BODY, not the
// parameter list. The body always follows the closing `)` of the
// parameter list, possibly with whitespace and arrow markers.
async function loadSiblingFn(name, file = join(ROOT, 'lib/page-extractor.js')) {
  const src = await readFile(file, 'utf8');
  // Match the function name and the position of the closing paren
  // of its parameter list.
  const m = src.match(new RegExp(`function ${name}\\s*\\([^)]*\\)`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  const headerEnd = m.index + m[0].length;
  // Skip whitespace / comments / newlines to find the body's `{`.
  let i = headerEnd;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '{') throw new Error(`${name}: expected { at offset ${i}, got ${src[i]}`);
  const start = m.index; // include the full "function name(...) {" header
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`${name}: unbalanced braces`);
  return src.slice(start, i + 1);
}

async function runDedupe(lastNavMap, navPortsMap, tabId, url) {
  // Build a side map: tabId → array of portId. The function we're testing
  // works on `Map<tabId, Set<port>>` where Set stores the actual port
  // objects. Inside the vm sandbox we rebuild the Map+Set structure from
  // the id arrays, but the postMessage method has to be replaced with a
  // bridge that calls back into our Node-side port.
  const navPortsSerialized = [];
  for (const [tid, portSet] of navPortsMap) {
    const ids = [];
    for (const port of portSet) {
      ids.push(port.__portId);
    }
    navPortsSerialized.push([tid, ids]);
  }
  // The vm sandbox needs the real port objects so postMessage works. We
  // hand them in via a global `__ports` map keyed by id.
  const portsForVm = {};
  for (const [, portSet] of navPortsMap) {
    for (const port of portSet) {
      portsForVm[port.__portId] = port;
    }
  }
  const fnSrc = await loadDedupeFn();
  const ctx = vm.createContext({
    __ports: portsForVm,
    // Wrap postMessage to look up the real port by id
    postMessageById: (id, msg) => {
      const p = portRegistry.get(id);
      if (p) p.postMessage(msg);
    }
  });
  // Rewrite the function source so `p.postMessage(...)` calls the bridge
  // instead. We do this with a tiny in-place string substitution that
  // targets the postMessage call inside the function body.
  const bridgeFn = fnSrc.replace(
    /p\.postMessage\(\s*\{ type: 'NAVIGATED', tabId, url, title: '' \}\s*\)/,
    `postMessageById(p.__portId, { type: 'NAVIGATED', tabId, url, title: '' })`
  );
  // The first runInContext just loads the function into the sandbox so
  // it's available for the second call below. (We can't `eval` then call
  // in one step because `arguments` isn't available in vm top-level code.)
  vm.runInContext(bridgeFn, ctx);
  // The function expects `Map<tabId, url>` and `Map<tabId, Set<port>>`.
  // JSON serialization only gave us arrays of [k, v] pairs. Rebuild
  // them inside the sandbox so the function sees the real types.
  return vm.runInContext(
    `(function() {`
    + ` const lastNavMap = new Map(${JSON.stringify([...lastNavMap])});`
    + ` const navPortsMap = new Map(${JSON.stringify(navPortsSerialized)}`
    + `   .map(([k, ids]) => [k, new Set(ids.map(id => __ports[id]))]));`
    + ` return dedupeAndBroadcast(lastNavMap, navPortsMap, ${tabId}, ${JSON.stringify(url)});`
    + `})()`,
    ctx
  );
}

test('nav broadcast: first URL for a tab is broadcast and recorded', async () => {
  const sink = [];
  const port = makePort('A', sink);
  const lastNav = new Map();
  const navPorts = new Map([[1, new Set([port])]]);
  const r = await runDedupe(lastNav, navPorts, 1, 'https://xhs.com/explore/AAA');
  assert.equal(r.updated, true);
  assert.equal(r.sent, 1);
  assert.equal(sink.length, 1);
  assert.equal(sink[0].type, 'NAVIGATED');
  assert.equal(sink[0].tabId, 1);
  assert.equal(sink[0].url, 'https://xhs.com/explore/AAA');
});

test('nav broadcast: same URL twice is deduped (no second send)', async () => {
  const sink = [];
  const port = makePort('A', sink);
  const lastNav = new Map();
  const navPorts = new Map([[1, new Set([port])]]);
  const r1 = await runDedupe(lastNav, navPorts, 1, 'https://xhs.com/explore/AAA');
  // The function returns a *new* map; we have to feed it back as the
  // starting state for the second call, exactly as the production code
  // does (it mutates module-scope lastNavBroadcast in place).
  const lastNav2 = new Map(r1.lastNavMap);
  const r2 = await runDedupe(lastNav2, navPorts, 1, 'https://xhs.com/explore/AAA');
  assert.equal(r2.updated, false, 'should be deduped');
  assert.equal(r2.sent, 0);
  assert.equal(sink.length, 1, 'only one notification total');
});

test('nav broadcast: different URLs both fire (SPA note-to-note)', async () => {
  const sink = [];
  const port = makePort('A', sink);
  let lastNav = new Map();
  const navPorts = new Map([[1, new Set([port])]]);
  const r1 = await runDedupe(lastNav, navPorts, 1, 'https://xhs.com/explore/AAA');
  lastNav = new Map(r1.lastNavMap);
  const r2 = await runDedupe(lastNav, navPorts, 1, 'https://xhs.com/explore/BBB');
  lastNav = new Map(r2.lastNavMap);
  const r3 = await runDedupe(lastNav, navPorts, 1, 'https://xhs.com/explore/CCC');
  assert.equal(sink.length, 3);
  assert.match(sink[0].url, /AAA/);
  assert.match(sink[1].url, /BBB/);
  assert.match(sink[2].url, /CCC/);
});

test('nav broadcast: no listeners means updated=true but sent=0', async () => {
  const lastNav = new Map();
  const navPorts = new Map(); // empty
  const r = await runDedupe(lastNav, navPorts, 1, 'https://xhs.com/explore/AAA');
  assert.equal(r.updated, true, 'state still updates so subsequent navs are deduped');
  assert.equal(r.sent, 0, 'no ports to send to');
});

test('nav broadcast: invalid tabId or empty URL is a no-op', async () => {
  const sink = [];
  const port = makePort('A', sink);
  const lastNav = new Map();
  const navPorts = new Map([[1, new Set([port])]]);
  const r1 = await runDedupe(lastNav, navPorts, null, 'https://x.com');
  assert.equal(r1.updated, false);
  const r2 = await runDedupe(lastNav, navPorts, 1, '');
  assert.equal(r2.updated, false);
  assert.equal(sink.length, 0);
});

test('nav broadcast: fan-out to multiple ports on the same tab', async () => {
  const a = []; const b = [];
  const pa = makePort('A', a);
  const pb = makePort('B', b);
  const navPorts = new Map([[1, new Set([pa, pb])]]);
  const r = await runDedupe(new Map(), navPorts, 1, 'https://x.com');
  assert.equal(r.sent, 2);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test('nav broadcast: different tabs are independent', async () => {
  const s1 = []; const s2 = [];
  const p1 = makePort('A', s1);
  const p2 = makePort('B', s2);
  const navPorts = new Map([
    [1, new Set([p1])],
    [2, new Set([p2])]
  ]);
  let lastNav = new Map();
  const r1 = await runDedupe(lastNav, navPorts, 1, 'https://x.com/A');
  lastNav = new Map(r1.lastNavMap);
  const r2 = await runDedupe(lastNav, navPorts, 2, 'https://x.com/B');
  lastNav = new Map(r2.lastNavMap);
  // Dedup should be per-tab
  const r3 = await runDedupe(lastNav, navPorts, 1, 'https://x.com/A');
  assert.equal(s1.length, 1, 'tab 1 deduped');
  assert.equal(s2.length, 1, 'tab 2 got its own msg');
});
