// test/lib-stream-incremental.test.mjs — pins the blockwise incremental
// streaming render (render.js's findStreamingBlockBoundary +
// createStreamingTarget wired into makeStreamRenderer). The old path
// re-parsed the ENTIRE accumulated text every reveal frame (O(n²) over a
// stream); these tests prove the replacement commits completed blocks once,
// re-parses only the open tail per frame, and still ends DONE with the same
// final renderSafe output.
//
// FEEDING CONTRACT (mirrors production): renderStream(delta) receives the
// NEW SUFFIX per call — sidepanel.js passes m.delta, never the accumulated
// text. Feeding cumulative strings here would concatenate them into
// fullAccum exactly like production would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.location = dom.window.location;
globalThis.DOMParser = dom.window.DOMParser;
// jsdom doesn't implement requestAnimationFrame — makeStreamRenderer's
// tick-batching needs one that actually fires asynchronously with a real
// timestamp (markstream-core does timestamp arithmetic).
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { findStreamingBlockBoundary, makeStreamRenderer, renderStreamingSafe, setThoughtAutoCollapse } =
  await import('../lib/sidepanel/render.js');
const marked = (await import('../lib/vendor/marked.bundle.js')).default;

// The pacer reveals at its own cadence (~30fps commits, catch-up capped by
// maxCharsPerSecond) — tests wait on visible conditions instead of counting
// timers. Timeout is generous: in this environment the effective reveal rate
// is ~150 chars/s.
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeoutMs = 15000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(): condition not met in time');
    await tick(15);
  }
};

test('findStreamingBlockBoundary: commits at blank lines between paragraphs', () => {
  const text = 'first para\n\nsecond para\n\nthird para partial';
  // Everything through the blank line after "second para" is commitable.
  const b = findStreamingBlockBoundary(text, 0);
  assert.equal(text.slice(0, b), 'first para\n\nsecond para\n');
  assert.ok(b < text.length, 'partial paragraph stays in the tail');
});

test('findStreamingBlockBoundary: never splits inside an unclosed fence', () => {
  const text = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;';
  const b = findStreamingBlockBoundary(text, 0);
  // "intro" is complete; everything from the blank run before the fence
  // opener is tail (the tail starts with the boundary's newline).
  assert.equal(text.slice(0, b), 'intro\n');
  assert.ok(text.slice(b).trimStart().startsWith('```js'));
});

test('findStreamingBlockBoundary: resumes committing after a fence closes', () => {
  const text = '```js\ncode()\n```\n\nafter the fence\n\nmore';
  const b = findStreamingBlockBoundary(text, 0);
  assert.ok(text.slice(0, b).includes('after the fence'), 'block after the closed fence commits');
  assert.ok(text.slice(b).includes('more'), 'trailing partial paragraph stays in the tail');
});

test('findStreamingBlockBoundary: blank line between two list items is NOT a split point (loose list)', () => {
  const text = '- item one\n\n- item two\n\nplain paragraph';
  const b = findStreamingBlockBoundary(text, 0);
  // The blank line between the items is rejected (loose-list continuation),
  // so the whole list commits as one chunk right before the paragraph.
  assert.equal(text.slice(0, b), '- item one\n\n- item two\n');
});

test('findStreamingBlockBoundary: list followed by a paragraph does split (after the list)', () => {
  const text = '- a\n- b\n\npara';
  const b = findStreamingBlockBoundary(text, 0);
  assert.equal(text.slice(0, b), '- a\n- b\n');
});

test('findStreamingBlockBoundary: no boundary without blank lines or content', () => {
  assert.equal(findStreamingBlockBoundary('no blank lines at all', 0), 0);
  // A leading blank run may commit (the chunk parses to nothing visible) but
  // never beyond it.
  assert.ok(findStreamingBlockBoundary('\n\npara', 0) <= 2);
});

test('findStreamingBlockBoundary: 1-3 space INDENTED fence is recognized (09-22 [ \\\\t] typo regression)', () => {
  // The opener regex shipped with a double backslash — [ \\t] in a regex
  // literal matches BACKSLASH or letter t, not space/tab. Indented fences
  // therefore fell out of fence-awareness mid-stream and their blank lines
  // committed as block boundaries; column-0 fences were unaffected, which is
  // why it survived unnoticed (DONE's full render healed everything anyway).
  const text = 'intro\n\n  ```js\n  const a = 1;\n\n  const b = 2;';
  const b = findStreamingBlockBoundary(text, 0);
  assert.equal(text.slice(0, b), 'intro\n', 'with the typo, the blank line INSIDE the indented fence committed mid-fence');
});

test('findStreamingBlockBoundary: indented loose list keeps its blank-line cohesion', () => {
  const text = 'para\n\n  - item one\n\n  - item two\n\ntail';
  const b = findStreamingBlockBoundary(text, 0);
  assert.equal(text.slice(0, b), 'para\n\n  - item one\n\n  - item two\n',
    'indented list continuation lines must reject the split (loose-list lookahead)');
});

test('findStreamingBlockBoundary: trailing blank run at EOF is commitable', () => {
  const text = 'para one\n\npara two\n\n';
  const b = findStreamingBlockBoundary(text, 0);
  assert.equal(text.slice(0, b), 'para one\n\npara two\n');
});

test('incremental streaming: mid-stream DOM matches a whole-text parse, and total parse volume is O(text), not O(text × ticks)', async () => {
  // 8 paragraphs streamed in ~100 suffix deltas. The old whole-text-per-frame
  // path re-parses the accumulated document every reveal frame; the
  // incremental path parses each completed block once + a small tail.
  const paras = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} with **bold ${i}** and some filler text to give it length.`);
  const full = paras.join('\n\n');

  let parseCalls = 0, parsedChars = 0;
  const origParse = marked.parse;
  marked.parse = (s, ...a) => { parseCalls++; parsedChars += s.length; return origParse.call(marked, s, ...a); };
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const render = makeStreamRenderer(el, {});
    // Feed suffix deltas (production shape), waiting past the pacer's start
    // delay so reveal frames actually run. Split AFTER each space so the
    // whitespace stays attached to the preceding token (suffixes must lose
    // no characters).
    const tokens = full.split(/(?<= )/);
    let fed = 0;
    for (const t of tokens) {
      render(t, false);
      fed += t.length;
      if (fed > 40) { await tick(); fed = 0; } // batch a few deltas per pacer frame
    }
    // Wait for the LAST paragraph (an early one matches too soon).
    await until(() => el.textContent.replace(/\s+/g, ' ').includes('Paragraph 7 with bold 7 and some filler text to give it length.'), 30000);

    const midText = el.textContent.replace(/\s+/g, ' ').trim();
    const expectText = renderStreamingSafe(full).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.equal(midText, expectText, 'mid-stream visible text must equal a whole-text streaming parse');
    assert.equal(el.querySelectorAll('p').length, 8, 'all 8 paragraphs present as separate blocks');
    // The invariant: total parsed chars stays on the order of the document,
    // not document × frames. 8 paragraphs ≈ 560 chars; the old path at
    // ~30fps for this stream would parse tens of KB.
    assert.ok(parsedChars < 560 + 400 * 120,
      `total parsed chars ${parsedChars} must be ~O(document), not O(document × frames)`);
    assert.ok(parseCalls < 300, `parse calls ${parseCalls} must be per-block+per-tail, never whole-document`);

    // DONE carries the full final text (production: the DONE chunk's `full`),
    // replacing the incremental DOM with the definitive renderSafe output.
    render(full, true);
    await tick();
    assert.equal(el.dataset.raw, full, 'DONE stamps the raw markdown');
    assert.ok(el.classList.contains('done'), 'DONE marks the bubble done');
    el.remove();
  } finally {
    marked.parse = origParse;
  }
});

test('incremental streaming: a committed prefix is never re-parsed when later text grows', async () => {
  // Stream paragraph 1 fully, let it commit, then stream a LONG second
  // paragraph: paragraph 1 must never be re-parsed again.
  const p1 = 'First paragraph is already complete.';
  const p2 = 'Second paragraph streams in slowly. ' + 'more words here '.repeat(20);
  const full = `${p1}\n\n${p2}`;

  let p1Parses = 0;
  const origParse = marked.parse;
  marked.parse = (s, ...a) => { if (s.includes('already complete')) p1Parses++; return origParse.call(marked, s, ...a); };
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const render = makeStreamRenderer(el, {});
    render(p1, false);
    await until(() => el.textContent.includes('already complete'));
    render('\n\n', false);
    await tick(); await tick(); // the blank line lets the boundary commit p1
    const p1ParsesAtCommit = p1Parses;
    assert.ok(p1ParsesAtCommit >= 1, 'paragraph 1 got parsed (as tail, then as commit chunk)');

    // Stream p2 in suffix chunks.
    const tokens = p2.match(/\S+\s*/g) || [];
    for (const t of tokens) {
      render(t, false);
      await tick(10);
    }
    await until(() => el.textContent.includes('more words here more words here'), 20000);
    assert.equal(p1Parses, p1ParsesAtCommit,
      'committed paragraph 1 must never be re-parsed while paragraph 2 streams');
    assert.ok(!el.textContent.includes('already complete. already complete.'), 'no duplicated content');
    // Teardown: this test ends MID-STREAM with a large reveal backlog — an
    // undestroyed pacer keeps revealing (and parsing) into the detached el
    // during LATER tests, polluting their parse counters (same hygiene rule
    // as the detail-thread port-teardown gotcha).
    render.destroy();
    el.remove();
  } finally {
    marked.parse = origParse;
  }
});

test('incremental streaming: live think block renders, freezes after close, and DONE replaces everything', async () => {
  let thinkParses = 0;
  const origParse = marked.parse;
  marked.parse = (s, ...a) => { if (s.includes('Reasoning about')) thinkParses++; return origParse.call(marked, s, ...a); };
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const render = makeStreamRenderer(el, {});
    const thinkText = 'Reasoning about the problem. ' + 'step; '.repeat(30);
    render(`<thinking>`, false);
    // Stream the think body in suffix chunks so reveal catches up.
    const chunks = thinkText.match(/\S+\s*/g) || [];
    for (const c of chunks) { render(c, false); await tick(5); }
    await until(() => document.querySelector('.live-think .think-body')?.textContent.includes('Reasoning'), 20000);
    assert.ok(document.querySelector('.live-think .think-body'), 'live think block appeared');

    // Close the think tag, let the reveal pass it, then stream the answer:
    // from the moment the answer text is visible, the think text is frozen
    // and must never be re-parsed (the freeze short-circuit skips all work).
    render(`</thinking>\n\nFinal answer`, false);
    // Sample the freeze point only after the reveal has fully passed the
    // close tag: the last think chars visible AND the answer showing.
    const thinkBodyEl = () => document.querySelector('.live-think .think-body');
    await until(() => el.textContent.includes('Final answer')
      && (thinkBodyEl()?.textContent.length || 0) >= thinkText.length - 1, 30000);
    const thinkParsesFrozen = thinkParses;
    for (let i = 0; i < 6; i++) {
      render(` word ${i}`, false);
      await tick(30);
    }
    assert.equal(thinkParses, thinkParsesFrozen,
      'frozen think text must not be re-parsed while the answer streams');

    // DONE carries the FULL final text (production shape), replacing the
    // incremental DOM with the definitive renderSafe output.
    const finalText = `<thinking>${thinkText}</thinking>\n\nFinal answer word 0 word 1 word 2 word 3 word 4 word 5 done.`;
    render(finalText, true);
    await tick();
    assert.equal(document.querySelector('.live-think'), null, 'DONE removes the live think block');
    assert.ok(el.textContent.includes('Final answer'), 'DONE renders the final answer');
    assert.equal(el.dataset.raw, finalText, 'DONE stamps the raw markdown');
    el.remove();
  } finally {
    marked.parse = origParse;
  }
});

test('incremental streaming: destroy() mid-stream leaves the revealed text in place', async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const render = makeStreamRenderer(el, {});
  render('partial text without done', false);
  await until(() => el.textContent.includes('partial text'));
  render.destroy();
  assert.ok(el.textContent.includes('partial text'), 'destroy does not wipe already-revealed text (caller re-renders)');
  el.remove();
});

// ─── 开放围栏快路径（2026-09-30 批C）──────────────────────────────────────────
// 围栏是唯一无界的 tail 块：块级提交期间 committed 钉死在围栏开头，旧实现每帧
// 把整个围栏重新过 marked+DOMPurify（300 行代码块 ≈ 300KB/s 重解析）——块级
// 增量化要消灭的 O(n²) 恰好在「流式代码块」这个核心场景复活。快路径把开放
// 围栏 tail 直接 paint 成 <pre><code>（textContent 构造上免疫 XSS），每帧
// 成本降为一次字符串赋值；DONE 的全量 renderSafe 仍是最终权威。

test('open-fence tail: painted directly as pre>code with ZERO marked.parse calls per delta', async () => {
  let parseCalls = 0;
  const origParse = marked.parse;
  marked.parse = (s, ...a) => { parseCalls++; return origParse.call(marked, s, ...a); };
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const render = makeStreamRenderer(el, {});
    render('intro para\n\n', false);
    await until(() => el.querySelector('p'), 30000);
    // intro 已提交；从这里开始的每一个 delta 都是围栏内容——快路径必须 0 parse。
    render('```js\n', false);
    // Baseline AFTER the opener is revealed and the fast path is live: the
    // 1-2 char transition states ('`', '``', trailing '\\n') legitimately
    // take the normal path — the invariant that matters is the UNBOUNDED
    // fence BODY streaming with zero re-parse.
    await until(() => el.querySelector('pre code'), 30000);
    await tick(60);
    const baseline = parseCalls;
    const lines = ['const a = 1;\n', 'const b = <script>alert(1)</script>;\n', 'if (a < b) { go(); }\n', 'const s = "x`y";\n', 'end();\n'];
    for (const l of lines) {
      render(l, false);
      await tick(60);
    }
    await until(() => el.querySelector('pre code') && el.querySelector('pre code').textContent.includes('end();'), 30000);
    assert.equal(parseCalls, baseline, 'every reveal frame while the open fence BODY streams must skip marked.parse entirely');
    const code = el.querySelector('pre code');
    assert.equal(code.className, 'language-js', 'info string becomes the language class (marked convention)');
    assert.ok(code.textContent.includes('const a = 1;'), 'body line 1 present verbatim');
    assert.ok(code.textContent.includes('<script>alert(1)</script>'), 'raw text via textContent — inert by construction, never parsed as HTML');
    assert.equal(el.querySelectorAll('script').length, 0, 'no script element may exist');
    // 可见文本与整段 renderStreamingSafe 一致（尾随空白除外）
    const whole = renderStreamingSafe('intro para\n\n```js\n' + lines.join(''));
    const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.equal(strip(el.innerHTML), strip(whole), 'mid-stream text equals a whole-text streaming parse');
    render.destroy(); // ends mid-stream — never leave a pacer revealing into later tests
    el.remove();
  } finally {
    marked.parse = origParse;
  }
});

test('closing the fence hands the block back to the normal commit path (parse resumes, paragraph after fence commits)', async () => {
  let parseCalls = 0;
  const origParse = marked.parse;
  marked.parse = (s, ...a) => { parseCalls++; return origParse.call(marked, s, ...a); };
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const render = makeStreamRenderer(el, {});
    render('```py\nprint(1)\n', false);
    await tick(60);
    const duringFence = parseCalls;
    render('```\n\nafter the fence\n', false);
    await until(() => el.textContent.includes('after the fence'), 30000);
    assert.ok(parseCalls > duringFence, 'the closed fence + following paragraph commit through marked');
    assert.ok(el.querySelector('pre code'), 'the code block is in the committed DOM');
    const p = [...el.querySelectorAll('p')].find((p) => p.textContent.includes('after the fence'));
    assert.ok(p, 'the paragraph after the fence renders as its own block');
    // DONE: full renderSafe replaces everything with the definitive render.
    await render('```py\nprint(1)\n```\n\nafter the fence\n', true);
    await tick(20);
    assert.ok(el.classList.contains('done'));
    assert.ok(el.querySelector('pre code'));
    el.remove();
  } finally {
    marked.parse = origParse;
  }
});

// ── Live think collapse policy (2026-10-07) ────────────────────────────────
// splitThink used to write thinkEl.open=false on EVERY rescan of an already-
// closed tag — i.e. every delta frame after the first close tag — so a user
// expand was snapped back within one frame. The policy now is: auto-collapse
// is edge-triggered (once per completed block, only while unpinned + setting
// on), a summary click pins the user's choice for the turn, and DONE carries
// a pin into the static think-blocks.

const clickSummary = (details) =>
  details.querySelector('summary').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true, cancelable: true }));

test('live think: user expand survives streaming deltas and the close edge (pin beats auto)', async () => {
  setThoughtAutoCollapse(true);
  const el = document.createElement('div');
  document.body.appendChild(el);
  try {
    const render = makeStreamRenderer(el, {});
    render('<thinking>abc ', false);
    await until(() => document.querySelector('.live-think'), 30000);
    const think = document.querySelector('.live-think');
    assert.equal(think.open, false, 'auto-collapse default starts the live block closed');
    clickSummary(think);
    assert.equal(think.open, true, 'summary click expands (and pins) the block');
    // Close tag + answer deltas: the pre-2026-10-07 code re-collapsed here on
    // every revealed frame, so this expand could never survive.
    render('def</thinking>\n\nAnswer ', false);
    await until(() => el.textContent.includes('Answer'), 30000);
    assert.equal(think.open, true, 'expand survives the close edge while pinned');
    render('more', false);
    await until(() => el.textContent.includes('more'), 30000);
    assert.equal(think.open, true, 'expand survives further answer deltas');
    // DONE: the pin crosses the live→static phase boundary.
    await render('<thinking>abc def</thinking>\n\nAnswer more', true);
    await until(() => el.classList.contains('done'), 30000);
    assert.equal(document.querySelector('.live-think'), null, 'DONE removes the live block');
    const staticThink = el.querySelector('details.think-block');
    assert.ok(staticThink, 'static think block rendered');
    assert.equal(staticThink.open, true, 'DONE inherits the pinned open state');
  } finally {
    setThoughtAutoCollapse(true);
    el.remove();
  }
});

test('live think: thoughtAutoCollapse=false never auto-collapses mid-stream; pinned collapse inherits into DONE', async () => {
  setThoughtAutoCollapse(false);
  const el = document.createElement('div');
  document.body.appendChild(el);
  try {
    const render = makeStreamRenderer(el, {});
    render('<thinking>abc ', false);
    await until(() => document.querySelector('.live-think'), 30000);
    const think = document.querySelector('.live-think');
    assert.equal(think.open, true, 'setting off starts the live block open');
    // Old unconditional close-tag collapse fired even with the setting off.
    render('def</thinking>\n\nAnswer ', false);
    await until(() => el.textContent.includes('Answer'), 30000);
    assert.equal(think.open, true, 'setting off: close edge must not collapse');
    // User collapses it deliberately; the pin must hold through DONE.
    clickSummary(think);
    assert.equal(think.open, false, 'summary click collapses (and pins)');
    render('more', false);
    await until(() => el.textContent.includes('more'), 30000);
    assert.equal(think.open, false, 'pinned collapse survives further deltas');
    await render('<thinking>abc def</thinking>\n\nAnswer more', true);
    await until(() => el.classList.contains('done'), 30000);
    const staticThink = el.querySelector('details.think-block');
    assert.ok(staticThink, 'static think block rendered');
    assert.equal(staticThink.open, false, 'DONE inherits the pinned collapsed state');
  } finally {
    setThoughtAutoCollapse(true); // other tests in this file assume the default
    el.remove();
  }
});
