// test/lib-math-copy.test.mjs — 选中公式复制 → LaTeX 源码 的决策/变换逻辑。
// jsdom 没有 innerText / 布局，serializeNode 会走 textContent 兜底（仅测试路径）；
// 真实 innerText 行为由 /tmp/pwshot 的 Playwright 探针在真 Chrome 里验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main id="messages"></main></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const {
  texSourceOf, formatTex, replaceMathWithTex,
  expandRangeToFormulas, stripCopyChrome, serializeNode,
  buildMathCopyPayload, initMathCopy, addMathCopyButtons, selectionTextWithMath,
} = await import('../lib/sidepanel/math-copy.js');

const doc = dom.window.document;
const messagesEl = doc.getElementById('messages');

// KaTeX output:'mathml' 的真实输出形状（display 与 inline 两种）
const katexHtml = (tex, display) =>
  `<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}><semantics><mrow><mi>X</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span>`;
const katexErrorHtml = '<span class="katex-error" title="ParseError">\\frac{a}{</span>';

function mount(html) {
  messagesEl.innerHTML = `<div class="msg assistant done"><div class="md">${html}</div></div>`;
  return messagesEl.querySelector('.msg.assistant');
}

test('texSourceOf/formatTex：display 与 inline 的判定与定界符', () => {
  const disp = doc.createElement('div');
  disp.innerHTML = katexHtml('A+B', true);
  assert.deepEqual(formatTex(texSourceOf(disp.querySelector('.katex'))), '$$A+B$$');

  const inline = doc.createElement('div');
  inline.innerHTML = katexHtml('Q', false);
  assert.deepEqual(formatTex(texSourceOf(inline.querySelector('.katex'))), '$Q$');

  // katex-error 没有 <math>/<annotation> → null（原样保留，其文本本就是源码）
  const err = doc.createElement('div');
  err.innerHTML = katexErrorHtml;
  assert.equal(texSourceOf(err.querySelector('.katex-error')), null);
});

test('replaceMathWithTex：把公式换成 LaTeX 文本节点并返回数量', () => {
  const bubble = mount(`<p>前文 ${katexHtml('Q', false)} 后文</p><p>${katexHtml('A+B', true)}</p>`);
  assert.equal(replaceMathWithTex(bubble), 2);
  assert.equal(bubble.querySelector('math'), null);
  assert.match(bubble.textContent, /前文 \$Q\$ 后文/);
  assert.match(bubble.textContent, /\$\$A\+B\$\$/);
  // annotation 不会被带进正文
  assert.equal(bubble.textContent.includes('encoding'), false);
});

test('expandRangeToFormulas：部分覆盖的公式吸附为完整包含', () => {
  const bubble = mount(`<p id="a">alpha</p><p id="b">${katexHtml('A+B', true)}</p><p id="c">omega</p>`);
  const range = doc.createRange();
  // 从公式内部的 <mi>X</mi> 文本起，到后一段落中——吸附后应包含整个公式
  range.setStart(bubble.querySelector('mi').firstChild, 0);
  range.setEndAfter(bubble.querySelector('#c').firstChild);
  expandRangeToFormulas(range, [...bubble.querySelectorAll('.katex')]);
  const frag = range.cloneContents();
  assert.equal(frag.querySelectorAll('math').length, 1);
  // 吸附后替换得到的是完整公式，不是半个
  assert.equal(replaceMathWithTex(frag), 1);
  assert.ok(frag.textContent.includes('$$A+B$$'));
  assert.ok(frag.textContent.includes('omega'), '公式之后的选中文本保留');

  // 从公式之前的段落拖到公式内部：前文保留，公式补全
  const range2 = doc.createRange();
  range2.setStart(bubble.querySelector('#a').firstChild, 0);
  range2.setEnd(bubble.querySelector('mi').firstChild, 1);
  expandRangeToFormulas(range2, [...bubble.querySelectorAll('.katex')]);
  const frag2 = range2.cloneContents();
  replaceMathWithTex(frag2);
  assert.ok(frag2.textContent.includes('alpha'));
  assert.ok(frag2.textContent.includes('$$A+B$$'));
});

test('expandRangeToFormulas：不相交时选区一字不动', () => {
  const bubble = mount(`<p id="a">alpha</p><p id="b">${katexHtml('A+B', true)}</p>`);
  const range = doc.createRange();
  range.selectNodeContents(bubble.querySelector('#a'));
  const before = range.cloneContents().textContent;
  expandRangeToFormulas(range, [...bubble.querySelectorAll('.katex')]);
  assert.equal(range.cloneContents().textContent, before);
});

test('stripCopyChrome：去掉面板交互件，保留模型输出的 details/summary', () => {
  const bubble = mount(`
    <div class="msg-actions"><button>复制</button></div>
    <span class="msg-time">12:00</span>
    <span class="token-usage">123 tokens</span>
    <pre><code>code</code><button class="code-copy-btn">复制</button></pre>
    <details class="think-block"><summary>思考过程</summary><div>thinking</div></details>
    <details><summary>模型自产的标题</summary><div>模型内容</div></details>`);
  stripCopyChrome(bubble);
  assert.equal(bubble.querySelector('.msg-actions'), null);
  assert.equal(bubble.querySelector('.msg-time'), null);
  assert.equal(bubble.querySelector('.token-usage'), null);
  assert.equal(bubble.querySelector('.code-copy-btn'), null);
  assert.equal(bulletSummaryText(bubble, '.think-block'), null, '面板自己的 summary 去掉');
  assert.equal(bulletSummaryText(bubble, 'details:not(.think-block)'), '模型自产的标题', '模型输出的 summary 保留');
  assert.ok(bubble.textContent.includes('模型内容'));
});

function bulletSummaryText(root, sel) {
  return root.querySelector(`${sel} summary`)?.textContent ?? null;
}

test('serializeNode：公式已换成 LaTeX、结构保留（jsdom 走 textContent 兜底）', () => {
  const bubble = mount(`<p>前文 ${katexHtml('Q', false)}</p><pre><code>x\ny</code></pre>`);
  replaceMathWithTex(bubble);
  stripCopyChrome(bubble);
  const { text } = serializeNode(bubble, doc);
  assert.ok(text.includes('$Q$'));
  assert.ok(text.includes('x\ny'), '代码块内部换行保留');
});

test('buildMathCopyPayload：选区含公式 → 接管；纯文本选区 → null', () => {
  const bubble = mount(`<p id="a">alpha ${katexHtml('Q', false)} omega</p>`);
  const sel = dom.window.getSelection();

  sel.removeAllRanges();
  const r1 = doc.createRange();
  r1.selectNodeContents(bubble.querySelector('#a'));
  sel.addRange(r1);
  const payload = buildMathCopyPayload(messagesEl);
  assert.ok(payload, '含公式应接管');
  assert.ok(payload.text.includes('$Q$'), `text 应含 LaTeX：${payload.text}`);
  assert.ok(payload.text.includes('alpha') && payload.text.includes('omega'));
  assert.ok(payload.html.includes('$Q$'));
  assert.ok(!payload.html.includes('<math'), 'html 里不该再残留 MathML');

  sel.removeAllRanges();
  const r2 = doc.createRange();
  r2.selectNodeContents(messagesEl.querySelector('.md'));
  // 纯文本：换一个没有公式的气泡
  mount('<p>没有公式的一段话</p>');
  r2.selectNodeContents(messagesEl.querySelector('.md'));
  sel.addRange(r2);
  assert.equal(buildMathCopyPayload(messagesEl), null, '无公式不接管');

  // 折叠选区不接管
  sel.removeAllRanges();
  const r3 = doc.createRange();
  r3.setStart(messagesEl.querySelector('p'), 0);
  r3.collapse(true);
  sel.addRange(r3);
  assert.equal(buildMathCopyPayload(messagesEl), null);
});

test('buildMathCopyPayload：选区完全在公式内部 → 吸附为整个公式', () => {
  const bubble = mount(`<p id="a">alpha</p><p id="b">${katexHtml('A+B', true)}</p>`);
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  const r = doc.createRange();
  r.setStart(bubble.querySelector('mi').firstChild, 0);
  r.setEnd(bubble.querySelector('mi').firstChild, 1);
  sel.addRange(r);
  const payload = buildMathCopyPayload(messagesEl);
  assert.ok(payload, '公式内部的选区也要接管');
  assert.match(payload.text, /\$\$A\+B\$\$/);
  assert.ok(!payload.text.includes('alpha'), '只吸附公式，不带进无关段落');
});

test('initMathCopy：copy 事件写入双 flavor 并 preventDefault；无公式放行', () => {
  const bubble = mount(`<p id="a">alpha ${katexHtml('Q', false)} omega</p>`);
  initMathCopy({ messagesEl });
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  const r = doc.createRange();
  r.selectNodeContents(bubble.querySelector('#a'));
  sel.addRange(r);

  const captured = {};
  const ev = new dom.window.Event('copy', { bubbles: true, cancelable: true });
  ev.clipboardData = { setData: (t, v) => { captured[t] = v; } };
  messagesEl.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.match(captured['text/plain'], /\$Q\$/);
  assert.match(captured['text/html'], /\$Q\$/);

  // 无公式选区：不 preventDefault、不写剪贴板
  mount('<p>plain only</p>');
  sel.removeAllRanges();
  const r2 = doc.createRange();
  r2.selectNodeContents(messagesEl.querySelector('p'));
  sel.addRange(r2);
  const ev2 = new dom.window.Event('copy', { bubbles: true, cancelable: true });
  const calls = [];
  ev2.clipboardData = { setData: (...a) => calls.push(a) };
  messagesEl.dispatchEvent(ev2);
  assert.equal(ev2.defaultPrevented, false);
  assert.equal(calls.length, 0);
});

test('initMathCopy：选区在输入框等 #messages 之外时不接管', () => {
  const ta = doc.createElement('textarea');
  ta.value = 'draft $x^2$';
  doc.body.appendChild(ta);
  ta.select();
  const ev = new dom.window.Event('copy', { bubbles: true, cancelable: true });
  const calls = [];
  ev.clipboardData = { setData: (...a) => calls.push(a) };
  doc.body.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false);
  ta.remove();
});

test('addMathCopyButtons：每个 .katex 一个复制按钮、幂等、跳过 katex-error', () => {
  const bubble = mount(`<p>${katexHtml('A+B', true)}</p><p>x ${katexHtml('Q', false)} y</p><p>${katexErrorHtml}</p>`);
  addMathCopyButtons(bubble);
  const bars = bubble.querySelectorAll('.katex .mermaid-toolbar');
  assert.equal(bars.length, 2, 'error 块不加按钮');
  assert.equal(bubble.querySelector('.katex-error .mermaid-toolbar'), null);
  const btns = [...bubble.querySelectorAll('.katex .mermaid-btn')];
  assert.ok(btns.every(b => b.title.includes('LaTeX')));
  // 幂等
  addMathCopyButtons(bubble);
  assert.equal(bubble.querySelectorAll('.katex .mermaid-toolbar').length, 2);
  // 选中复制不含按钮（chrome 剥离清单已含 .mermaid-toolbar）
  stripCopyChrome(bubble);
  assert.equal(bubble.querySelector('.mermaid-toolbar'), null);
});

test('addMathCopyButtons：点击把 LaTeX 源码写进剪贴板（display 带双定界符）', async () => {
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: (s) => { copied.push(s); return Promise.resolve(); } } },
    configurable: true, writable: true,
  });
  try { Object.defineProperty(dom.window, 'isSecureContext', { value: true, configurable: true }); } catch { /* jsdom 已有同名字段则忽略 */ }

  const bubble = mount(`<p>${katexHtml('A+B', true)}</p><p>${katexHtml('Q', false)}</p>`);
  addMathCopyButtons(bubble);
  const [dispBtn, inlineBtn] = bubble.querySelectorAll('.katex .mermaid-btn');
  dispBtn.click();
  inlineBtn.click();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(copied, ['$$A+B$$', '$Q$']);
});

// ─── selectionTextWithMath：追问卡引用文本的公式感知提取（2026-09-26）─────────
// sel.toString() 对公式拿到的是 MathML 逐记号换行的碎片；引用文本要把碰到的
// 公式吸附为整体并写成 LaTeX（$…$ / $$…$$），没碰到公式时逐字等于 toString()。

function fakeSel(range, str) {
  return { isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => str };
}

test('selectionTextWithMath：部分覆盖公式 → 吸附为整体并写成 LaTeX', () => {
  const bubble = mount(`<p>前文 ${katexHtml('Q', false)} 中 ${katexHtml('A+B', true)}</p>`);
  const p = bubble.querySelector('p');
  const range = doc.createRange();
  range.setStart(p.firstChild, 0); // 「前文 」文本节点开头
  const ann = p.querySelectorAll('math')[1].querySelector('annotation');
  range.setEnd(ann.firstChild, 1); // 终点拖进 display 公式内部
  const out = selectionTextWithMath(fakeSel(range, '前文 X X'));
  assert.match(out, /\$Q\$/, '行内公式写成 $…$');
  assert.match(out, /\$\$A\+B\$\$/, 'display 公式写成 $$…$$');
  assert.equal(out.includes('encoding'), false, '不带 MathML 碎片');
  assert.equal(out.includes('后文'), false, '终点吸附到公式末尾');
});

test('selectionTextWithMath：选区完全落在公式内部 → 给整个公式', () => {
  const bubble = mount(`<p>${katexHtml('A+B', true)}</p>`);
  const ann = bubble.querySelector('annotation');
  const range = doc.createRange();
  range.setStart(ann.firstChild, 0);
  range.setEnd(ann.firstChild, 2);
  const out = selectionTextWithMath(fakeSel(range, 'A+'));
  assert.equal(out.trim(), '$$A+B$$', '拖拽在公式内部起止是最常见手势，必须吸附到全身');
});

test('selectionTextWithMath：没碰到公式 → 逐字等于 toString()（旧行为不变）', () => {
  const bubble = mount('<p>普通文字没有公式</p>');
  const range = doc.createRange();
  range.selectNodeContents(bubble.querySelector('p'));
  const out = selectionTextWithMath(fakeSel(range, 'RAW\nTEXT'));
  assert.equal(out, 'RAW\nTEXT');
});

test('selectionTextWithMath：collapsed / 无 range / null → null（调用方自行回退）', () => {
  assert.equal(selectionTextWithMath(null), null);
  assert.equal(selectionTextWithMath({ isCollapsed: true, rangeCount: 0 }), null);
});
