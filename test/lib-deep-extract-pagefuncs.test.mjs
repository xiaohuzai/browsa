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
    // location.origin: detectIncompleteness 的同源 pin（2026-10-01）会读它——
    // 沙盒哲学：函数摸到的全局必须在这里声明。
    location: { href: url, origin: new URL(url).origin },
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

// 2026-11-03 安全审计：labuladong「清除阅读历史」侧栏按钮事故的回归属于此。
// interactiveSnapshot 必须把 aside/complementary/search 里的控件排除（不编号喂
// brain）；clickIndexed 的破坏性词表必须与 preExtractCleanup 同步（清除/清空/重置
// 等），即使控件被直接编号也 veto。
test('interactiveSnapshot: aside/complementary/search controls are excluded from the brain feed', async () => {
  const fn = await loadSiblingFn('interactiveSnapshot');
  const { dom, ctx } = makeCtx(`<body>
    <aside><button aria-expanded="false">清除阅读历史</button></aside>
    <div role="complementary"><button>重置偏好</button></div>
    <div role="search"><button>退出登录</button></div>
    <button aria-expanded="false">加载更多评论</button></body>`);
  const out = await vm.runInContext(`${fn}\ninteractiveSnapshot({ maxChars: 5000 })`, ctx);
  assert.equal(out.count, 1, 'only the article load-more is listed; chrome-region controls excluded');
  assert.ok(out.items.some((l) => l.includes('加载更多评论')));
  assert.ok(!out.text.includes('清除阅读历史'));
  assert.ok(!out.text.includes('重置偏好'));
  assert.ok(!out.text.includes('退出登录'));
  dom.window.close();
});

test('clickIndexed: destructive 清除/重置/注销 verbs are vetoed even when directly indexed', async () => {
  const click = await loadSiblingFn('clickIndexed');
  for (const label of ['清除阅读历史', '清空缓存', '重置设置', '注销账户', '退出登录', 'clear history', 'reset preferences', 'log out']) {
    const { dom, ctx } = makeCtx(`<body><button data-browsa-ix="0">${label}</button></body>`);
    let clickedFlag = false;
    dom.window.document.querySelector('button').onclick = () => { clickedFlag = true; };
    const out = await vm.runInContext(`${click}\n(async () => clickIndexed({ index: 0, settleMs: 50 }))()`, ctx);
    assert.equal(out.vetoed, true, `must veto: ${label}`);
    assert.equal(out.clicked, false, `must not click: ${label}`);
    assert.equal(clickedFlag, false, `onclick must not fire: ${label}`);
    dom.window.close();
  }
});

// 2026-11-03 第二批审计（content-1）：否决谓词读的标签面必须不窄于枚举面。
// interactiveSnapshot 用 aria-label 编号 icon-only 控件，clickIndexed 若只查
// textContent，aria-label="删除账户" 的空文字按钮就被真实点击（带用户 Cookie）。
test('clickIndexed: icon-only destructive controls are vetoed via aria-label / title / input value', async () => {
  const click = await loadSiblingFn('clickIndexed');
  const fixtures = [
    '<button aria-label="删除账户" data-browsa-ix="0"><svg></svg></button>',
    '<button title="Delete account" data-browsa-ix="0"><svg></svg></button>',
    '<input type="button" value="清除阅读历史" data-browsa-ix="0">',
  ];
  for (const html of fixtures) {
    const { dom, ctx } = makeCtx(`<body>${html}</body>`);
    let clickedFlag = false;
    dom.window.document.querySelector('[data-browsa-ix]').onclick = () => { clickedFlag = true; };
    const out = await vm.runInContext(`${click}\n(async () => clickIndexed({ index: 0, settleMs: 50 }))()`, ctx);
    assert.equal(out.vetoed, true, `must veto: ${html}`);
    assert.equal(out.clicked, false, `must not click: ${html}`);
    assert.equal(clickedFlag, false, `onclick must not fire: ${html}`);
    dom.window.close();
  }
});

test('clickIndexed: benign aria-label-only expander is still clicked (veto must not over-kill)', async () => {
  const click = await loadSiblingFn('clickIndexed');
  const { dom, ctx } = makeCtx('<body><button aria-label="展开剩余段落" aria-expanded="false" data-browsa-ix="0"><svg></svg></button></body>');
  let clickedFlag = false;
  dom.window.document.querySelector('button').onclick = () => { clickedFlag = true; };
  const out = await vm.runInContext(`${click}\n(async () => clickIndexed({ index: 0, settleMs: 50 }))()`, ctx);
  assert.equal(out.vetoed, false);
  assert.equal(out.clicked, true);
  assert.equal(clickedFlag, true);
  dom.window.close();
});

test('clickIndexed: label fields are space-joined — no fake danger word across field boundaries', async () => {
  const click = await loadSiblingFn('clickIndexed');
  // text 尾 're' + label 头 'move' 直接拼接会拼出 remove；空格连接不会。
  const { dom, ctx } = makeCtx('<body><button aria-label="move to next section" data-browsa-ix="0">re</button></body>');
  const out = await vm.runInContext(`${click}\n(async () => clickIndexed({ index: 0, settleMs: 50 }))()`, ctx);
  assert.equal(out.vetoed, false, 're + move across fields must not fabricate "remove"');
  assert.equal(out.clicked, true);
  dom.window.close();
});

// 行为级 lockstep：同一个 aria-only 破坏性 fixture 分别喂两个注入函数——
// clickIndexed 必须 veto，preExtractCleanup 必须不点（expandedCount 0）。
test('lockstep(behavior): the same aria-only destructive fixture is refused by BOTH clickIndexed and preExtractCleanup', async () => {
  const html = '<body><main><button aria-expanded="false" aria-label="清除阅读历史"><svg></svg></button></main></body>';
  const click = await loadSiblingFn('clickIndexed');
  const snapshot = await loadSiblingFn('interactiveSnapshot');
  const cleanup = await loadSiblingFn('preExtractCleanup');

  const { dom: dom1, ctx: ctx1 } = makeCtx(html);
  let clicked1 = false;
  dom1.window.document.querySelector('button').onclick = () => { clicked1 = true; };
  const out = await vm.runInContext(`${snapshot}\n${click}\n(async () => { interactiveSnapshot(); return clickIndexed({ index: 0, settleMs: 50 }); })()`, ctx1);
  assert.equal(out.vetoed, true);
  assert.equal(out.clicked, false);
  assert.equal(clicked1, false);
  dom1.window.close();

  const { dom: dom2, ctx: ctx2 } = makeCtx(html);
  ctx2.window = { scrollY: 0, innerHeight: 800, scrollTo: () => {} };
  let clicked2 = false;
  dom2.window.document.querySelector('button').onclick = () => { clicked2 = true; };
  const actions = await vm.runInContext(`${cleanup}\npreExtractCleanup()`, ctx2);
  assert.equal(actions.expandedCount, 0, 'safeClick must veto the aria-only destructive control');
  assert.equal(clicked2, false, 'onclick must not fire');
  dom2.window.close();
});

// 2026-11-03 第二批审计（content-3）：策略数据的唯一 owner 是模块常量
// CLICK_SAFETY_ARGS，经 executeScript args 下发（ADR-0009 禁共享兄弟函数，
// 不禁传数据；RegExp 不可序列化，传 source/flags 字符串）。四个注入函数
// 保留同值内嵌兜底（漏传 args 行为不变），本测试钉兜底 === 常量。
test('lockstep: click-safety policy has ONE owner — embedded fallbacks === module constants', async () => {
  const src = await readFile(EXTRACTOR, 'utf8');
  const dangerConst = src.match(/const CLICK_DANGER_RE = (\/.*\/i);/);
  const selectorConst = src.match(/const CHROME_EXCLUDE_SELECTOR = '([^']*)';/);
  assert.ok(dangerConst, 'module-level CLICK_DANGER_RE must exist (the single owner)');
  assert.ok(selectorConst, 'module-level CHROME_EXCLUDE_SELECTOR must exist');
  assert.equal(selectorConst[1], 'nav, header, footer, aside, [role="navigation"], [role="menubar"], [role="complementary"], [role="search"]',
    'chrome exclusion must include aside/complementary/search');
  assert.match(src, /export const CLICK_SAFETY_ARGS = \{\s*dangerSource: CLICK_DANGER_RE\.source,\s*dangerFlags: CLICK_DANGER_RE\.flags,\s*chromeSelector: CHROME_EXCLUDE_SELECTOR,?\s*\};/,
    'CLICK_SAFETY_ARGS must be derived from the constants, not a second hand-written copy');
  // 危险词兜底：preExtractCleanup / clickIndexed 各一份，必须与常量逐字一致
  //（漂移曾真实发生——labuladong 事故；兜底降级为漏传 args 时的保险）。
  for (const fnName of ['preExtractCleanup', 'clickIndexed']) {
    const body = await loadSiblingFn(fnName);
    const literals = [...body.matchAll(/: (\/delete\|remove[^;]*\/i);/g)].map((m) => m[1]);
    assert.equal(literals.length, 1, `${fnName} must keep exactly one embedded danger fallback`);
    assert.equal(literals[0], dangerConst[1], `${fnName} fallback must equal CLICK_DANGER_RE (drift re-opens the labuladong hole)`);
    assert.match(body, /new RegExp\(dangerSource, dangerFlags \|\| 'i'\)/, `${fnName} must rebuild the regex from args`);
  }
  // chrome 选择器兜底：三个消费者各一份，必须与常量逐字一致。
  for (const fnName of ['preExtractCleanup', 'detectIncompleteness', 'interactiveSnapshot']) {
    const body = await loadSiblingFn(fnName);
    const sels = [...body.matchAll(/chromeSelector \|\| '([^']*)'/g)].map((m) => m[1]);
    assert.equal(sels.length, 1, `${fnName} must keep exactly one embedded chrome-fallback`);
    assert.equal(sels[0], selectorConst[1], `${fnName} chrome fallback must equal CHROME_EXCLUDE_SELECTOR`);
  }
  // 否决标签并集表达式两处逐字一致（content-1 的标签面）。
  const unions = [...src.matchAll(/\[el\.textContent, el\.getAttribute\('aria-label'\), el\.getAttribute\('title'\), el\.value\]\s*\.map\(\(s\) => \(s \|\| ''\)\.trim\(\)\)\.filter\(Boolean\)\.join\(' '\)/g)];
  assert.equal(unions.length, 2, 'safeClick and clickIndexed must carry the identical space-joined label union');
});

test('wiring: all 7 injection sites pass CLICK_SAFETY_ARGS', async () => {
  const src = await readFile(EXTRACTOR, 'utf8');
  const agentic = await readFile(join(ROOT, 'lib/agentic-extract.js'), 'utf8');
  // page-extractor.js: preExtractCleanup（runGenericExtraction）+ detectIncompleteness（probe）
  for (const fn of ['preExtractCleanup', 'detectIncompleteness']) {
    const hits = [...src.matchAll(new RegExp(`func: ${fn},\\s*args: \\[CLICK_SAFETY_ARGS\\]`, 'g'))];
    assert.equal(hits.length, 1, `page-extractor.js must inject ${fn} with args: [CLICK_SAFETY_ARGS]`);
  }
  // agentic-extract.js: 2 处 preExtractCleanup 直注 + 3 处 inject() 包装
  assert.match(agentic, /import \{[\s\S]*?CLICK_SAFETY_ARGS[\s\S]*?\} from '\.\/page-extractor\.js'/);
  const cleanupHits = [...agentic.matchAll(/func: preExtractCleanup, args: \[CLICK_SAFETY_ARGS\]/g)];
  assert.equal(cleanupHits.length, 2, 'both preExtractCleanup injections (interactive copy + page walker) must pass the policy');
  assert.match(agentic, /inject\(tabId, interactiveSnapshot, \{ \.\.\.CLICK_SAFETY_ARGS, maxChars:/);
  assert.match(agentic, /inject\(tabId, clickIndexed, \{ \.\.\.CLICK_SAFETY_ARGS, index:/);
  assert.match(agentic, /inject\(tab\.id, detectIncompleteness, \{ \.\.\.CLICK_SAFETY_ARGS \}\)/);
});

test('policy args: dangerSource/chromeSelector ride executeScript args and are honored (string→RegExp rebuild)', async () => {
  const click = await loadSiblingFn('clickIndexed');
  const { dom, ctx } = makeCtx('<body><button data-browsa-ix="0">banana</button></body>');
  // 自定义词表经 args 下发必须生效（证明 new RegExp(source, flags) 重建路径活着）…
  const vetoed = await vm.runInContext(`${click}\n(async () => clickIndexed({ index: 0, settleMs: 50, dangerSource: 'banana', dangerFlags: 'i' }))()`, ctx);
  assert.equal(vetoed.vetoed, true);
  // …而不传 args 时兜底词表不认识 banana（正常点击）。
  const plain = await vm.runInContext(`${click}\n(async () => clickIndexed({ index: 0, settleMs: 50 }))()`, ctx);
  assert.equal(plain.vetoed, false);
  assert.equal(plain.clicked, true);
  dom.window.close();

  // chromeSelector 同理：把 main 划为 chrome 后，其中的展开控件不再被点。
  const cleanup = await loadSiblingFn('preExtractCleanup');
  const { dom: dom2, ctx: ctx2 } = makeCtx('<body><main><button aria-expanded="false">展开</button></main></body>');
  ctx2.window = { scrollY: 0, innerHeight: 800, scrollTo: () => {} };
  const actions = await vm.runInContext(`${cleanup}\npreExtractCleanup({ chromeSelector: 'main' })`, ctx2);
  assert.equal(actions.expandedCount, 0, 'the args-supplied chrome selector must be honored');
  dom2.window.close();
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
