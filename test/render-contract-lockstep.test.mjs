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

// ─── 1. bubble widening (field report: bare ```pdb fence → 185px Mol* sliver)
// Live-render blocks are percentage-sized with no intrinsic width; a reply
// that is ONLY a fence collapses the fit-content bubble. Every live-render
// wrapper class MUST be covered by a .msg.assistant:has(...) widening rule.

const WRAPPER_CLASSES = {
  mermaid: 'mermaid-diagram',
  echarts: 'echarts-diagram',
  markmap: 'markmap-diagram',
  smiles: 'smiles-block',
  pdb: 'pdb-block',
  dot: 'dot-diagram',
};

test('lockstep: every live-render wrapper class is widened by a :has bubble rule', () => {
  // The class map itself must stay honest: each wrapper className must still
  // be assigned somewhere in render.js (renames trip this).
  for (const [fence, cls] of Object.entries(WRAPPER_CLASSES)) {
    assert.ok(
      renderJs.includes(`'${cls}'`) || renderJs.includes(`"${cls}"`),
      `wrapper class "${cls}" (fence ${fence}) no longer assigned in render.js — update WRAPPER_CLASSES here`,
    );
    assert.ok(
      css.includes(`.msg.assistant:has(.${cls})`),
      `sidepanel.css lost the bubble-widening rule for .${cls} — a reply that is only a \`\`\`${fence} fence will collapse the viewer into a sliver (2026-09-30 field report)`,
    );
  }
});

test('lockstep: the widening rule actually sets a definite width (not just max-width)', () => {
  const block = css.match(/\.msg\.assistant:has\(\.pdb-block\)[^{]*\{[^}]*\}/);
  assert.ok(block, 'the :has widening block is gone');
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

