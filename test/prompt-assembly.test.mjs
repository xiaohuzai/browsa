// test/prompt-assembly.test.mjs — the two-tier capability hints split
// (2026-10-20 user report: a casual "hi" carried the entire render contract).
// ALWAYS rides every turn; RENDER (the render-contract details) is appended
// only when triggered — see the block comment in lib/prompt-assembly.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_HINTS, CAPABILITY_HINTS_ALWAYS_ENTRIES, CAPABILITY_HINTS_ALWAYS,
  RENDER_CONTRACT_HINTS, renderHintsTriggered,
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
  assert.equal(renderHintsTriggered({ userText: '', history: [] }), false);
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
