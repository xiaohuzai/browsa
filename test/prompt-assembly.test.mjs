// test/prompt-assembly.test.mjs — the effective system prompt contract.
//
// 2026-10-20: the two-tier / per-family gate shipped and was reverted the same
// day — a casual turn dropped from 8.0K to 1.6K and lost the visual routing
// guidance, and the model stopped drawing unless explicitly asked. The full
// CAPABILITY_HINTS rides every turn again, plus positive rich-Markdown and
// proactive-figure rules (see lib/prompt-assembly.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  CAPABILITY_HINTS, CAPABILITY_HINTS_ENTRIES, SHARED_RENDER_RULES,
  buildEffectiveSystemPrompt, effectiveSystemPromptSections,
} from '../lib/prompt-assembly.js';

// Markers live inside each family's text so a regression shows up as a
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
  rich: 'rich Markdown rather than a plain-text wall',
  proactive: 'Visualize proactively, not only when explicitly asked',
  sourceFigure: 'cite those figures with the SAME [图N] markers',
};

test('every turn carries the full contract — no per-family gating', () => {
  for (const [id, marker] of Object.entries(MARKERS)) {
    assert.ok(CAPABILITY_HINTS.includes(marker), `the ${id} contract must ride every turn`);
  }
});

test('the removed negative drawing rule must not come back', () => {
  assert.ok(!CAPABILITY_HINTS.includes('Err on the side of NOT drawing'));
  assert.ok(!CAPABILITY_HINTS.includes('at most one diagram per reply'));
});

test('rich Markdown is the default presentation contract', () => {
  assert.match(CAPABILITY_HINTS, /## \/ ### headings/);
  assert.match(CAPABILITY_HINTS, /\*\*bold\*\* for key terms/);
  assert.match(CAPABILITY_HINTS, /Markdown tables/);
  assert.match(CAPABILITY_HINTS, /blockquotes/);
  assert.match(CAPABILITY_HINTS, /fenced code blocks with a language tag/);
});

test('supplied document figures win over drawing a new one', () => {
  // 2026-10-21 user report: with proactive drawing in the prompt the model
  // started re-drawing attached documents' figures instead of citing [图N].
  assert.match(CAPABILITY_HINTS, /cite those figures with the SAME \[图N\] markers/);
  assert.match(CAPABILITY_HINTS, /add a generated fenced figure only when the source has no usable figure/);
});

test('the source no longer exports the per-family selector', async () => {
  const src = await fs.readFile(new URL('../lib/prompt-assembly.js', import.meta.url), 'utf8');
  assert.ok(!/RENDER_HINT_GROUPS|buildRenderHints|CAPABILITY_HINTS_ALWAYS/.test(src),
    'family gating was reverted — do not reintroduce it without a new user decision');
});

test('chat and agent channels share every channel-neutral entry verbatim', () => {
  for (const entry of CAPABILITY_HINTS_ENTRIES) {
    if (entry === CAPABILITY_HINTS_ENTRIES.find((e) => e.includes('never create HTML files'))) continue;
    assert.ok(SHARED_RENDER_RULES.includes(entry), 'the agent channel must reuse the shared entry');
  }
  assert.ok(!SHARED_RENDER_RULES.includes('never create HTML files'),
    'the chat-only file clause must not reach tool-bearing agents');
});

test('buildEffectiveSystemPrompt assembles base + language + hints + choice protocol', () => {
  const out = buildEffectiveSystemPrompt(
    { systemPrompt: 'BASE', replyLanguage: 'zh' },
    { capabilityHints: CAPABILITY_HINTS, choiceRequestHint: 'CHOICE' },
  );
  assert.ok(out.startsWith('BASE\n\n请始终用中文回答。'));
  assert.ok(out.includes(CAPABILITY_HINTS));
  assert.ok(out.endsWith('CHOICE'));
});

test('the /prompt inspector lists exactly the blocks that are sent', () => {
  const sections = effectiveSystemPromptSections(
    { systemPrompt: 'BASE', replyLanguage: 'zh' },
    { capabilityHints: CAPABILITY_HINTS, choiceRequestHint: 'CHOICE' },
  );
  assert.deepEqual(sections.map((s) => s.label), [
    'Base system prompt',
    'Language instruction',
    'Capability hints',
    'Choice request protocol',
  ]);
  assert.equal(sections[2].text, CAPABILITY_HINTS);
});
