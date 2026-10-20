// test/prompt-assembly.test.mjs — the two-tier capability hints split
// (2026-10-20 user report: a casual "hi" carried the entire render contract)
// and the per-family second tier (2026-10-20 follow-up after a model switch:
// one 6.3K block still dragged chemistry/protein/article contracts into a
// single chart request). ALWAYS rides every turn; the matching RENDER family
// is appended only when triggered — see lib/prompt-assembly.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_HINTS, CAPABILITY_HINTS_ALWAYS_ENTRIES, CAPABILITY_HINTS_ALWAYS,
  RENDER_CONTRACT_HINTS, RENDER_HINT_GROUPS, buildRenderHints, renderHintsTriggered,
} from '../lib/prompt-assembly.js';

test('two-tier split: ALWAYS entries ride the full pool, RENDER is exactly the complement', () => {
  for (const entry of CAPABILITY_HINTS_ALWAYS_ENTRIES) {
    assert.ok(CAPABILITY_HINTS.includes(entry), 'every ALWAYS entry must be in the full pool');
    assert.ok(!RENDER_CONTRACT_HINTS.includes(entry), 'no ALWAYS entry may leak into the RENDER group');
  }
  assert.ok(RENDER_CONTRACT_HINTS.includes('sankey-beta'), 'the mermaid type menu belongs to the render contract');
  assert.ok(CAPABILITY_HINTS.length > CAPABILITY_HINTS_ALWAYS.length + RENDER_CONTRACT_HINTS.length,
    'full pool must be strictly larger than both groups combined (join boundaries)');
});

test('renderHintsTriggered: casual text does not trigger', () => {
  assert.equal(renderHintsTriggered({ userText: 'hi' }), false);
  assert.equal(renderHintsTriggered({ userText: '谢谢！' }), false);
  assert.equal(renderHintsTriggered({ userText: 'write a paragraph about this' }), false, 'paragraph must not false-positive on \\bgraph');
  assert.equal(renderHintsTriggered({ userText: '' }), false);
  assert.equal(renderHintsTriggered({ history: [] }), false);
});

test('renderHintsTriggered: drawing/chemistry/article keywords trigger', () => {
  assert.equal(renderHintsTriggered({ userText: '画一个 TCP 状态机' }), true);
  assert.equal(renderHintsTriggered({ userText: '对比这两个数据库，画个 ER 图' }), true);
  assert.equal(renderHintsTriggered({ userText: 'visualize this dataset as a chart' }), true);
  assert.equal(renderHintsTriggered({ userText: 'draw the transformer architecture' }), true);
  assert.equal(renderHintsTriggered({ userText: '阿司匹林的分子结构' }), true);
  assert.equal(renderHintsTriggered({ userText: '把这份材料整理成文章' }), true);
});

test('renderHintsTriggered: a fence anywhere in history keeps the contract on (hysteresis)', () => {
  assert.equal(renderHintsTriggered({
    history: ['前面的回答\n\n```mermaid\ngraph TD\nA-->B\n```'],
    userText: '继续',
  }), true);
  assert.equal(renderHintsTriggered({
    history: ['```echarts\n{"series":[]}\n```'],
    userText: '还有吗',
  }), true);
});

// ─── Per-family selection (second tier) ─────────────────────────────────────
// Markers are chosen inside each family's text so a leak shows up as a
// positive assertion failure, not a silent size difference.
const MARKERS = {
  routing: 'sankey-beta',
  mermaid: 'always quote node labels',
  echarts: '"xAxis"',
  markmap: 'plain Markdown outline',
  smiles: 'chemically valid',
  pdb: 'RCSB Protein Data Bank',
  dot: 'fillcolor',
  article: 'machine-writing tells',
};

test('per-family: every family has at least one entry and no family is empty', () => {
  assert.ok(RENDER_HINT_GROUPS.length >= 7, 'expected the routing/mermaid/echarts/markmap/smiles/pdb/dot/article families');
  for (const g of RENDER_HINT_GROUPS) {
    assert.ok(g.entries.length > 0, `family ${g.id} must carry at least one entry`);
    for (const e of g.entries) {
      assert.ok(RENDER_CONTRACT_HINTS.includes(e), `family ${g.id} entry must belong to the render contract`);
    }
  }
});

test('per-family: a chart ask carries echarts (and routing) but not chemistry/protein/article', () => {
  const out = buildRenderHints({ userText: '画个柱状图对比一下' });
  assert.ok(out.includes(MARKERS.echarts), 'chart ask must carry the ECharts contract');
  assert.ok(out.includes(MARKERS.routing), 'an explicit drawing ask must carry the type/routing menu');
  assert.ok(!out.includes(MARKERS.smiles), 'no chemistry contract on a chart ask');
  assert.ok(!out.includes(MARKERS.pdb), 'no protein contract on a chart ask');
  assert.ok(!out.includes(MARKERS.article), 'no article-style contract on a chart ask');
  assert.ok(out.length < RENDER_CONTRACT_HINTS.length, 'a single family must be strictly smaller than the old monolith');
});

test('per-family: a molecule ask carries only the SMILES contract', () => {
  const out = buildRenderHints({ userText: '阿司匹林的分子结构' });
  assert.ok(out.includes(MARKERS.smiles));
  assert.ok(!out.includes(MARKERS.routing), 'no diagram routing menu for a chemistry ask');
  assert.ok(!out.includes(MARKERS.pdb), 'a molecule is not a protein');
  assert.ok(!out.includes(MARKERS.article));
});

test('per-family: a protein ask carries only the PDB contract', () => {
  const out = buildRenderHints({ userText: 'render the protein 1UBQ' });
  assert.ok(out.includes(MARKERS.pdb));
  assert.ok(!out.includes(MARKERS.smiles));
  assert.ok(!out.includes(MARKERS.routing));
});

test('per-family: an article-polish ask does not drag in any diagram contract', () => {
  const out = buildRenderHints({ userText: '把这份材料整理成文章' });
  assert.ok(out.includes(MARKERS.article));
  for (const id of ['routing', 'mermaid', 'echarts', 'markmap', 'smiles', 'pdb', 'dot']) {
    assert.ok(!out.includes(MARKERS[id]), `article ask must not carry the ${id} contract`);
  }
});

test('per-family: a neural-network figure ask carries dot, not the mermaid/chemistry families', () => {
  const out = buildRenderHints({ userText: 'draw the transformer architecture' });
  assert.ok(out.includes(MARKERS.dot));
  assert.ok(out.includes(MARKERS.routing), '"draw" is an explicit figure ask — routing rides so the type choice is informed');
  assert.ok(!out.includes(MARKERS.mermaid));
  assert.ok(!out.includes(MARKERS.smiles));
  assert.ok(!out.includes(MARKERS.pdb));
});

test('per-family: history hysteresis is per family, not global', () => {
  const out = buildRenderHints({
    history: ['上一次回答\n```echarts\n{"series":[]}\n```'],
    userText: '继续',
  });
  assert.ok(out.includes(MARKERS.echarts), 'the drawn family stays on');
  assert.ok(!out.includes(MARKERS.mermaid), 'a different family must not be dragged in by hysteresis');
  assert.ok(!out.includes(MARKERS.smiles));
  assert.ok(!out.includes(MARKERS.article));
  assert.ok(out.indexOf(MARKERS.routing) < out.indexOf(MARKERS.echarts),
    'the routing menu is pinned first once any render fence exists');
});

test('per-family: adding a new family later is pure tail append (prefix cache stays valid)', () => {
  const history = ['上一次回答\n```echarts\n{"series":[]}\n```'];
  const before = buildRenderHints({ history, userText: '继续' });
  const after = buildRenderHints({ history, userText: '再画个流程图' });
  assert.ok(after.length > before.length);
  assert.ok(after.startsWith(before), 'a newly triggered family must only append — earlier bytes must not shift');
});

test('per-family: activation order follows first appearance (append-only prefix growth)', () => {
  const mermaidFirst = buildRenderHints({
    history: ['```mermaid\ngraph TD\nA-->B\n```', '```echarts\n{"series":[]}\n```'],
  });
  assert.ok(mermaidFirst.indexOf(MARKERS.mermaid) < mermaidFirst.indexOf(MARKERS.echarts),
    'families must be emitted in first-appearance order so new activations append at the tail');
  const echartsFirst = buildRenderHints({
    history: ['```echarts\n{"series":[]}\n```', '```mermaid\ngraph TD\nA-->B\n```'],
  });
  assert.ok(echartsFirst.indexOf(MARKERS.echarts) < echartsFirst.indexOf(MARKERS.mermaid));
});

test('per-family: narrow triggers avoid the known false positives', () => {
  assert.equal(buildRenderHints({ userText: '这篇文章讲了什么？' }), '', 'reading an article is not writing one');
  assert.equal(buildRenderHints({ userText: '我试图理解这个概念' }), '', '"试图" must not trigger the drawing menu');
  assert.equal(buildRenderHints({ userText: 'what is the dot product' }), '', '"dot product" is not Graphviz');
  assert.equal(buildRenderHints({ userText: 'charter schools' }), '', '"charter" must not trigger the chart family');
});
