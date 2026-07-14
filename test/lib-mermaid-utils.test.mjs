// test/lib-mermaid-utils.test.mjs — execution tests for
// lib/sidepanel/mermaid-utils.js, ported near-verbatim from markstream-vue's
// src/utils/diagramHeight.ts and src/utils/mermaidSequenceSemicolons.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMermaidDiagramKind, estimateMermaidPreviewHeight, clampMermaidPreviewHeight,
  escapeSequenceTextSemicolons, renderMermaidWithRetry
} from '../lib/sidepanel/mermaid-utils.js';

test('getMermaidDiagramKind identifies the diagram type from the first meaningful line', () => {
  assert.equal(getMermaidDiagramKind('sequenceDiagram\nA->>B: hi'), 'sequencediagram');
  assert.equal(getMermaidDiagramKind('%% a comment\nflowchart TD\nA-->B'), 'flowchart');
  assert.equal(getMermaidDiagramKind('gantt\ntitle x'), 'gantt');
  assert.equal(getMermaidDiagramKind(''), '');
});

test('estimateMermaidPreviewHeight grows with line count and varies by diagram kind', () => {
  const short = estimateMermaidPreviewHeight('sequenceDiagram\nA->>B: hi');
  const long = estimateMermaidPreviewHeight('sequenceDiagram\n' + 'A->>B: hi\n'.repeat(20));
  assert.ok(long > short, 'more lines must estimate a taller preview');
  const gantt = estimateMermaidPreviewHeight('gantt\ntitle x');
  const flowchart = estimateMermaidPreviewHeight('flowchart TD\ntitle x');
  assert.notEqual(gantt, flowchart, 'different diagram kinds should not collapse to the same estimate');
});

test('clampMermaidPreviewHeight bounds to [min, max]', () => {
  assert.equal(clampMermaidPreviewHeight(10, 60, 500), 60);
  assert.equal(clampMermaidPreviewHeight(9999, 60, 500), 500);
  assert.equal(clampMermaidPreviewHeight(200, 60, 500), 200);
});

// ─── Sequence-diagram semicolon escaping ────────────────────────────────────
// Mirrors markstream-vue's own regression case: a bare `;` inside sequence
// message/Note text (e.g. embedded SQL) breaks mermaid's parser because `;`
// is a statement terminator there.

test('escapeSequenceTextSemicolons escapes a semicolon inside sequence message text', () => {
  const code = 'sequenceDiagram\nA->>B: BEGIN; SELECT * FROM t FOR UPDATE';
  const escaped = escapeSequenceTextSemicolons(code);
  assert.match(escaped, /BEGIN#59; SELECT/, 'the semicolon in dialogue text must be escaped to an entity');
});

test('escapeSequenceTextSemicolons leaves a real mermaid statement-separator semicolon untouched', () => {
  const code = 'sequenceDiagram\nA->>B: hi; activate B';
  const escaped = escapeSequenceTextSemicolons(code);
  assert.equal(escaped, code, 'a semicolon that starts a new mermaid statement must not be escaped');
});

test('escapeSequenceTextSemicolons is a no-op for non-sequence diagrams', () => {
  const code = 'flowchart TD\nA[Start; here] --> B';
  assert.equal(escapeSequenceTextSemicolons(code), code);
});

test('escapeSequenceTextSemicolons is idempotent (already-escaped entities are not double-escaped)', () => {
  const code = 'sequenceDiagram\nA->>B: BEGIN; SELECT * FROM t';
  const once = escapeSequenceTextSemicolons(code);
  const twice = escapeSequenceTextSemicolons(once);
  assert.equal(once, twice);
});

// ─── renderMermaidWithRetry ──────────────────────────────────────────────────

test('renderMermaidWithRetry succeeds on the first attempt without retrying', async () => {
  let calls = 0;
  const fakeM = { render: async (id, source) => { calls++; return { svg: `<svg>${source}</svg>` }; } };
  const { svg } = await renderMermaidWithRetry(fakeM, 'id1', 'sequenceDiagram\nA->>B: hi', {});
  assert.equal(calls, 1);
  assert.match(svg, /A->>B: hi/);
});

test('renderMermaidWithRetry retries once with semicolons escaped after a parse failure', async () => {
  const attempts = [];
  const fakeM = {
    render: async (id, source) => {
      attempts.push(source);
      if (attempts.length === 1) throw new Error('Parse error on line 2');
      return { svg: `<svg>${source}</svg>` };
    }
  };
  const source = 'sequenceDiagram\nA->>B: BEGIN; SELECT * FROM t';
  const { svg } = await renderMermaidWithRetry(fakeM, 'id1', source, {});
  assert.equal(attempts.length, 2, 'must retry exactly once');
  assert.match(attempts[1], /BEGIN#59; SELECT/, 'the retry must use the escaped source');
  assert.match(svg, /BEGIN#59; SELECT/);
});

test('renderMermaidWithRetry rethrows the original error when escaping would not change anything', async () => {
  const fakeM = { render: async () => { throw new Error('Parse error: totally unrelated'); } };
  await assert.rejects(
    () => renderMermaidWithRetry(fakeM, 'id1', 'flowchart TD\nA-->B', {}),
    /totally unrelated/
  );
});
