// test/render-contract-lockstep.test.mjs — LOCKSTEP tests for the render
// contract's non-JS surfaces. Every renderer bug of the 2026-09-29/30 field
// reports lived in a layer the unit tests couldn't see: CSS rules (bubble
// collapse, resize affordances) and PROMPT text (hint clauses). These tests
// pin those surfaces so the next renderer/upgrade cannot silently regress
// them. Each pin cites the field report that paid for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'sidepanel.css'), 'utf8');
const renderJs = readFileSync(join(ROOT, 'lib', 'sidepanel', 'render.js'), 'utf8');
const promptJs = readFileSync(join(ROOT, 'lib', 'prompt-assembly.js'), 'utf8');
const sidepanelJs = readFileSync(join(ROOT, 'sidepanel.js'), 'utf8');
const optionsJs = readFileSync(join(ROOT, 'options.js'), 'utf8');
const storageJs = readFileSync(join(ROOT, 'lib', 'storage.js'), 'utf8');
const fontChoicesJs = readFileSync(join(ROOT, 'lib', 'font-choices.js'), 'utf8');

// ─── 1. bubble widening (field report: bare ```pdb fence → 185px Mol* sliver)
// Live-render blocks are percentage-sized with no intrinsic width; a reply
// that is ONLY a fence collapses the fit-content bubble. The renderer stamps
// `.has-live-diagram` on the bubble when it swaps in a wrapper (2026-10-17 —
// it used to be six `:has()` rules, which forced ancestor re-matching on every
// streamed mutation).

const WRAPPER_CLASSES = {
  mermaid: 'mermaid-diagram',
  echarts: 'echarts-diagram',
  markmap: 'markmap-diagram',
  smiles: 'smiles-block',
  pdb: 'pdb-block',
  dot: 'dot-diagram',
};

test('lockstep: every live-render renderer widens its bubble', () => {
  // The class map itself must stay honest: each wrapper className must still
  // be assigned somewhere in render.js (renames trip this).
  for (const [fence, cls] of Object.entries(WRAPPER_CLASSES)) {
    assert.ok(
      renderJs.includes(`'${cls}'`) || renderJs.includes(`"${cls}"`),
      `wrapper class "${cls}" (fence ${fence}) no longer assigned in render.js — update WRAPPER_CLASSES here`,
    );
  }
  const stamps = (renderJs.match(/markBubbleWide\(wrapper\)/g) || []).length;
  assert.equal(stamps, Object.keys(WRAPPER_CLASSES).length,
    'every one of the six renderers must call markBubbleWide(wrapper) — a missing one collapses its viewer into a sliver (2026-09-30 field report)');
  assert.doesNotMatch(css, /\.msg\.assistant:has\(/,
    'bubble widening must not go back to :has() — streaming re-matches it on the ancestor every frame');
});

test('lockstep: the widening rule actually sets a definite width (not just max-width)', () => {
  const block = css.match(/\.msg\.assistant\.has-live-diagram\s*\{[^}]*\}/);
  assert.ok(block, 'the .has-live-diagram widening block is gone');
  assert.match(block[0], /width:\s*100%/, 'must set width:100% — max-width alone cannot widen a fit-content bubble');
});

// ─── 2. drag-resize affordances (user request: "这些图都可以调整渲染的大小")
// pdb → height (Mol* follows via RO→requestResize); smiles → width (SVG
// viewBox scaling); echarts → both (chart.resize via existing RO). mermaid/
// dot/markmap already ship zoom controls.

test('lockstep: pdb viewer is height-resizable and echarts/smiles are resizable', () => {
  const pdb = css.match(/\.pdb-viewer \{[^}]*\}/);
  assert.ok(pdb, '.pdb-viewer rule gone');
  assert.match(pdb[0], /resize:\s*vertical/, 'pdb viewer must offer height resize');
  assert.match(pdb[0], /min-height/, 'resize needs a floor');
  const smiles = css.match(/\.smiles-block \{[^}]*\}/);
  assert.ok(smiles, '.smiles-block rule gone');
  assert.match(smiles[0], /resize:\s*horizontal/, 'smiles block must offer width resize');
  const svgRule = css.match(/\.smiles-block svg\.smiles-svg \{[^}]*\}/);
  assert.match(svgRule[0], /width:\s*100%/, 'smiles svg must fill the resizable wrapper to scale with it');
  const ech = css.match(/\.echarts-diagram \{[^}]*\}/);
  assert.ok(ech, '.echarts-diagram rule gone');
  assert.match(ech[0], /resize:\s*both/, 'echarts must offer width+height resize');
  assert.match(ech[0], /overflow:\s*hidden/, 'CSS resize requires non-visible overflow');
});

test('lockstep: renderPdb wires a ResizeObserver to molstar requestResize', () => {
  // 2026-09-30 批C：RO 改走共享的 _observeResize（同一注册表 + 每元素
  // disposer），定向 dispose（删气泡时的 disposeRenderInstancesIn）由此覆盖
  // pdb viewer。契约不变：molstar 不观察自己的容器，RO 必须驱动
  // canvas3d.requestResize；全局清扫仍走 _chartObservers。
  assert.match(renderJs, /_observeResize\(viewerEl,[\s\S]{0,140}requestResize/, 'the pdb RO must drive canvas3d.requestResize (molstar does not observe its own container)');
  assert.match(renderJs, /_chartObservers\.add\(ro\)/, 'observers must ride _chartObservers so renderHistory disposes them');
});

// ─── 3. prompt-side contract clauses (each paid for by a field report)

test('lockstep: the dot hint keeps its two field-earned bans', () => {
  assert.match(promptJs, /label nodes ONLY as ID \[label=/, 'hint must teach the only valid node-label form (field report: Node["text"] is invalid Graphviz)');
  assert.match(promptJs, /ID\["text"\] is INVALID Graphviz/, 'hint must ban the mermaid-style form explicitly');
  assert.match(promptJs, /ALWAYS set fillcolor AND a contrasting fontcolor/, 'hint must pair filled nodes with a contrasting font (field report: black fill + black font)');
  assert.match(promptJs, /fontcolor="white"/, 'hint must name the concrete fix');
});

test('lockstep: the smiles hint keeps the validity clause (RDKit rejects bad SMILES)', () => {
  assert.match(promptJs, /must be chemically valid/, 'hint must teach valences/rings matter');
  assert.match(promptJs, /invalid structures are NOT drawn/, 'hint must state the rejection behavior');
});

test('lockstep: user-pasted images are lightbox-zoomable (2026-10-01 拍板, closing the unpinned b37fea0 exclusion)', () => {
  const sidepanelJs = readFileSync(join(ROOT, 'sidepanel.js'), 'utf8');
  // The lightbox delegate must not exclude .msg-images — the old exclusion
  // (uncommented, untested) left user screenshots stuck at 180×140 with a
  // dead click. If you ever need to exclude a strip again, pin the reason here.
  assert.doesNotMatch(sidepanelJs, /!img\.closest\('\.msg-images'\)/, 'no .msg-images exclusion in the lightbox delegate');
  assert.match(css, /\.msg-image\s*\{[^}]*cursor:\s*zoom-in/, 'thumbnails carry a clickable affordance');
});


// ─── 3. think body 限高内滚 + 宽内容收口（2026-10-07 用户报告）──────────────
// 思考过长把会话撑长 → .think-body 限高内滚（静态/流式共用）；4 空格缩进行被
// marked 判成代码块后 white-space:pre 原样横穿块边框 → .think-body pre 强制
// 换行 + 宽度收口。流式贴底跟随在 makeStreamRenderer（render.js），无布局
// 环境（jsdom）下是 no-op。
test('lockstep: think body is height-capped, internally scrollable, and its pre is contained', () => {
  const body = css.match(/\.think-body\s*\{[^}]*\}/);
  assert.ok(body, '.think-body block is gone');
  assert.match(body[0], /max-height:\s*min\(60vh,\s*480px\)/, 'lost the height cap — long thinking stretches the whole conversation again');
  assert.match(body[0], /overflow-y:\s*auto/, 'lost the internal scrollbar');
  const pre = css.match(/\.think-body pre\s*\{[^}]*\}/);
  assert.ok(pre, '.think-body pre containment rule is gone');
  assert.match(pre[0], /white-space:\s*pre-wrap/, 'pre must wrap — indented pseudo-code overflowed the block border');
  assert.match(pre[0], /max-width:\s*100%/, 'pre must be width-contained');
});

// ─── 4. 图形文字跟正文一致（2026-10-14 用户报告：mermaid 文字字体字号与正文不同）
// 四个 SVG 渲染器的文字此前各带一套字体（mermaid trebuchet+18px、echarts
// sans-serif 12px、markmap vendor 300 16px/20px、graphviz Times 衬线）。render.js
// 的兜底字面量必须与 sidepanel.css 的正文排版互相钉死——任何一侧单独改字体，
// 另一侧静默漂移。
test('lockstep: render.js font fallbacks mirror sidepanel.css body/bubble typography', () => {
  const bodyBlock = css.match(/^body \{([^}]*)\}/m);
  assert.ok(bodyBlock, 'the plain body block is gone from sidepanel.css');
  const cssStack = (bodyBlock[1].match(/font-family:\s*([^;]+);/) || [])[1];
  assert.ok(cssStack, 'body font-family is gone');
  const jsStack = renderJs.match(/_FONT_STACK_FALLBACK = '([^']+)'/);
  assert.ok(jsStack, 'render.js lost _FONT_STACK_FALLBACK — diagram text no longer follows the body font');
  assert.equal(
    jsStack[1].replace(/\s+/g, ' ').trim(),
    cssStack.replace(/\s+/g, ' ').trim(),
    'render.js font fallback and sidepanel.css body font-family drifted apart — keep them identical',
  );
  const rootDefault = (css.match(/--msg-font-size:\s*([\d.]+)px/) || [])[1];
  assert.ok(rootDefault, 'the :root --msg-font-size default is gone');
  const jsSize = renderJs.match(/_FONT_SIZE_FALLBACK = ([\d.]+)/);
  assert.ok(jsSize, 'render.js lost _FONT_SIZE_FALLBACK');
  assert.equal(jsSize[1], rootDefault, 'fallback bubble font size must equal the :root --msg-font-size default');
});

test('lockstep: markmap text follows the bubble font via the vendor --markmap-font variable', () => {
  // markmap-view 注入 .markmap{font:var(--markmap-font)}，vendor 默认是
  // 300 16px/20px sans-serif。覆盖规则丢了 → 思维导图文字回到 vendor 默认。
  const rule = css.match(/\.markmap-diagram \.markmap\s*\{[^}]*\}/);
  assert.ok(rule, 'the .markmap-diagram .markmap font override is gone');
  assert.match(rule[0], /--markmap-font:[^;]*var\(--msg-font-size/, 'override must track the bubble font-size variable');
  assert.match(rule[0], /--markmap-font:[^;]*var\(--msg-font-family/, 'override must track the bubble font-family variable (「正文字体」设置跟手)');
});

test('lockstep: echarts gets a panel-typography default textStyle under the model option', () => {
  // 模型 option 之下的全局默认（两次 setOption 合并，模型自带 textStyle 仍胜）。
  assert.match(
    renderJs,
    /setOption\(\{\s*textStyle:\s*\{\s*fontFamily:\s*panelFontFamily\(\),\s*fontSize:\s*bubbleFontSize\(\)\s*\}\s*\}\)/,
    'the echarts default-textStyle setOption is gone — chart text fell back to echarts sans-serif 12px',
  );
});

// ─── 5. 「正文字体」设置接线（2026-10-14，补齐只有字号没有字体族的半边）──────
// 设置页选择 → storage.fontFamily → sidepanel applyFontFamily 写
// --msg-font-family → .msg 气泡消费 + render.js 图形跟手。任何一环脱落：
// 要么设置不生效，要么图形跟不上新字体（2026-10-14 图形一致性失效）。
test('lockstep: the message-font-family setting is wired end to end', () => {
  // CSS 侧：:root 默认 = body 同款栈（与 render.js 兜底字面量互钉）；两个气泡
  // 选择器都消费变量。
  const rootBlock = css.match(/:root\s*\{[^}]*\}/);
  assert.ok(rootBlock, 'the typography :root block is gone');
  const cssVar = (rootBlock[0].match(/--msg-font-family:\s*([^;]+);/) || [])[1];
  assert.ok(cssVar, ':root lost --msg-font-family');
  const jsStack = renderJs.match(/_FONT_STACK_FALLBACK = '([^']+)'/);
  assert.ok(jsStack, 'render.js lost _FONT_STACK_FALLBACK');
  assert.equal(
    cssVar.replace(/\s+/g, ' ').trim(),
    jsStack[1].replace(/\s+/g, ' ').trim(),
    ':root --msg-font-family default and render.js fallback drifted — keep them identical',
  );
  // .msg.assistant 有两条规则（布局块 + 排版块）——任一条消费变量即算覆盖。
  for (const sel of ['.msg.user', '.msg.assistant']) {
    const re = new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{[^}]*\\}', 'g');
    const blocks = css.match(re) || [];
    assert.ok(blocks.length, `${sel} block is gone`);
    assert.ok(
      blocks.some((b) => /font-family:\s*var\(--msg-font-family\)/.test(b)),
      `${sel} must consume --msg-font-family (the message font setting would not reach bubbles)`,
    );
  }
  // render.js 侧：图形字体先读变量（设置跟手），读不到再落 body/兜底。
  assert.match(renderJs, /getPropertyValue\('--msg-font-family'\)/,
    'panelFontFamily must read --msg-font-family first or the font setting will not reach diagrams');
  // 接线三环：options 存取、sidepanel 应用、storage 合同。
  // 2026-10-16 设置页改即存：fontFamily 由 change 监听经 saveChatPref(patch)
  // 持久化（不再有显式保存按钮的 saveChatPrefs 整包写）。
  assert.match(optionsJs, /\$\('fontFamily'\)\?\.addEventListener\('change', \(e\) => saveChatPref\(\{ fontFamily: e\.target\.value \|\| 'system' \}\)\)/,
    'options must persist fontFamily on change via saveChatPref (auto-save)');
  assert.match(sidepanelJs, /function applyFontFamily/, 'sidepanel lost the applier');
  assert.match(sidepanelJs, /changes\.fontFamily\) applyFontFamily/,
    'sidepanel must live-track fontFamily storage changes');
  assert.match(storageJs, /'fontSize', 'fontFamily', 'sendShortcut'/,
    'fontFamily must ride GET_ALL_KEYS or the panel never sees the setting at init');
  // 候选表：三档齐全，'system' 刻意 stack:null（移除内联 var 让 :root 兜底）。
  for (const key of ['system', 'serif', 'mono']) {
    assert.ok(fontChoicesJs.includes(`key: '${key}'`), `font-choices lost the '${key}' option`);
  }
});

// ─── 5. Mermaid 宿主责任（2026-10-19，借 pele 的 limit/host-policy 模型）
// 四条不变量，任何一条被改掉都会静默削弱不可信图源的处理：
// ① 上限显式 pin 且 %%{init}%% 不能覆盖（secure 列表）；
// ② securityLevel:'loose' 允许 HTML 标签（随后被 sanitize 压平成文本），
//    我们永不调用 mermaid 的 bindFunctions（否则模型可绑 click 回调）；
// ③ sanitize 之后还有一道链接/图片协议白名单；
// ④ 方向切换与宽度重排都在（重排只在宽度变化 ≥40px 时防抖触发）。
test('lockstep: mermaid host responsibilities (limits, no click binding, link policy, direction, reflow)', () => {
  assert.match(renderJs, /securityLevel:\s*'loose'/);
  assert.match(renderJs, /maxTextSize:\s*MERMAID_MAX_TEXT_SIZE/,
    'maxTextSize must be pinned to the named constant (mermaid default drift would loosen it silently)');
  assert.match(renderJs, /maxEdges:\s*MERMAID_MAX_EDGES/);
  assert.match(renderJs, /secure:\s*\[[^\]]*'securityLevel'[^\]]*'maxEdges'/,
    '%%{init}%% directives must not be able to override the security/limit keys');
  // mermaid 的 secure 是整表替换默认值：默认五项 + CSS/布局相关键都要在。
  for (const key of ['suppressErrorRendering', 'themeCSS', 'themeVariables', 'fontFamily', 'fontSize']) {
    assert.ok(renderJs.includes(`'${key}'`), `secure must include ${key}`);
  }
  // front matter 的 config: 不走 directive 消毒器——必须在进 mermaid 前剥掉。
  assert.match(renderJs, /const safeSource = stripFrontMatterConfig\(source\);/);
  // $$…$$ math must become Unicode BEFORE sanitizeMermaidSvg flattens label
  // HTML to text (KaTeX output would otherwise degrade to "dk").
  assert.match(renderJs, /const mathSafeSource = mermaidMathToText\(safeSource\);/,
    'mermaid label math must be converted to Unicode before rendering');
  assert.match(renderJs, /renderMermaidWithRetry\(m, id, mathSafeSource, host\)/);
  // 只禁止「调用」；注释里出现这个名字是解释上述不变量。
  assert.doesNotMatch(renderJs, /\.bindFunctions\s*\(/,
    'never bind mermaid click callbacks — securityLevel:loose would let model output register handlers');
  assert.match(renderJs, /export function enforceSafeDiagramLinks/);
  assert.match(renderJs, /MERMAID_LINK_SCHEMES\s*=\s*new Set\(\['http:', 'https:', 'mailto:', 'tel:'\]\)/);
  assert.match(renderJs, /MERMAID_IMAGE_SCHEMES\s*=\s*new Set\(\['http:', 'https:'\]\)/);
  assert.match(renderJs, /toggleMermaidDirection\(state\.source, state\.horizontalDirection\)/);
  assert.match(renderJs, /_ensureMermaidReflowObserver/);
  assert.match(renderJs, /Math\.abs\(width - _mermaidReflowWidth\) < 40/, 'reflow must ignore sub-40px width jitter');
  assert.match(renderJs, /state\.busy = true;[\s\S]{0,400}?if \(changed\) _commitMermaidSvg/,
    're-renders must be transactional (commit only after a successful render+sanitize)');
});

// ─── 6. Mermaid 缩放 / 字体重排 / 宽度（2026-10-19 第二批，pele zoom+mount）──
test('lockstep: mermaid zoom has keyboard/pointer/a11y, font changes re-render, sequence wraps', () => {
  // 缩放范围 0.2–4（用户拍板：静止也要能缩小；<1 露出图外留白属预期）。
  assert.match(renderJs, /const _MM_ZOOM_MIN = 0\.2/);
  assert.match(renderJs, /const _MM_FIT = 1/, 'pan/arrow gates key off the fit scale, not the zoom floor');
  // 方向档位：纵向（TD）布局用宽松间距，防 edge label 挤节点。
  // `layout` is a TOP-LEVEL MermaidConfig key — putting it inside `flowchart`
  // is silently ignored by the bundled renderer (verified against mermaid 12).
  assert.match(renderJs, /^\s*layout: 'dagre',$/m,
    'mermaid 12 must stay on dagre (top-level) or the narrow-panel spacing is ignored');
  assert.match(renderJs, /flowchart: vertical \? \{ nodeSpacing: 50, rankSpacing: 60 \} : \{ nodeSpacing: 30, rankSpacing: 40 \}/,
    'the narrow-panel spacing values must stay in the flowchart block');
  assert.match(renderJs, /initMermaidTheme\(m, dirHit && !dirHit\.horizontal \? 'vertical' : 'horizontal'\)/);
  assert.match(renderJs, /export function computeAnchoredZoom/);
  assert.match(renderJs, /tabIndex = 0/);
  assert.match(renderJs, /mermaidZoomHint/);
  assert.match(renderJs, /addEventListener\('keydown'/);
  assert.match(renderJs, /addEventListener\('dblclick'/);
  assert.match(renderJs, /addEventListener\('pointerdown'/);
  assert.doesNotMatch(renderJs, /_mermaidDrag/,
    'drag must use pointer capture on the element, not a module-level window listener');
  assert.match(css, /\.mermaid-btn:disabled/, 'zoom buttons need a disabled state at the bounds');
  // 字体/字号设置变更必须重排已渲染的图（mermaid 布局按字体宽度算）。
  assert.match(renderJs, /export function refreshMermaidDiagrams/);
  assert.match(renderJs, /initMermaidTheme\(state\.m, dirHit && !dirHit\.horizontal \? 'vertical' : 'horizontal'\)/,
    're-renders must re-initialize mermaid so a font/direction change actually reaches the layout');
  // 输入短路：宽度/主题都没变的图不付一次完整渲染。
  assert.match(renderJs, /width === state\.width && mermaidThemeKey === state\.themeKey/);
  // 字体刷新先可见后空闲；旧批次由 generation 取消。
  assert.match(renderJs, /_mermaidRefreshGen/);
  assert.match(renderJs, /requestIdleCallback/);
  // OS 主题热切换时已渲染的图也重排（pele mount().refresh() 的宿主责任）。
  assert.match(renderJs, /matchMedia\('\(prefers-color-scheme: dark\)'\)[\s\S]{0,220}?addEventListener\?\.\('change', \(\) => refreshMermaidDiagrams\(\)\)/);
  assert.match(sidepanelJs, /refreshMermaidDiagrams\(\)/,
    'applyFontSize/applyFontFamily must refresh existing diagrams');
  // 时序图长消息在窄侧栏折行。
  assert.match(renderJs, /sequence:\s*\{\s*wrap:\s*true\s*\}/);
  // 布局宽度必须扣掉 padding（pele room()）。
  assert.match(renderJs, /function _contentWidth/);
});

test('hidden controls cannot be un-hidden by an author display rule', () => {
  // The UA's `[hidden] { display:none }` loses to any author display rule
  // (.iconbtn { display:flex } kept the no-video transcript button painted and
  // clickable). One global !important rule closes the class of bugs; per-
  // selector copies are exactly how the leak survived before.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/,
    'sidepanel.css must hide [hidden] with !important');
});

test('toasts never paint above the confirmation modal', () => {
  const z = (sel) => {
    const m = css.match(new RegExp(sel + '\\s*\\{[^}]*?z-index:\\s*(\\d+)'));
    assert.ok(m, `${sel} must declare a numeric z-index`);
    return Number(m[1]);
  };
  assert.ok(z('\\.toast-container') < z('\\.confirm-overlay'),
    'a toast must not cover the dialog the user is answering');
});
