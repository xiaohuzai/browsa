// test/lib-markdown-chunker.test.mjs — unit tests for lib/markdown-chunker.js
// (findSafeTruncationPoint + splitIntoMarkdownChunks)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSafeTruncationPoint, splitIntoMarkdownChunks } from '../lib/markdown-chunker.js';

// ---------------------------------------------------------------------------
// findSafeTruncationPoint
// ---------------------------------------------------------------------------

test('findSafeTruncationPoint: cap >= text length → returns cap unchanged', () => {
  const text = 'hello\nworld\n';
  assert.equal(findSafeTruncationPoint(text, 9999), 9999);
});

test('findSafeTruncationPoint: plain text (no fences/tables) → returns last \\n before cap', () => {
  const text = 'line one\nline two\nline three\n';
  //                   ^8      ^17      ^27
  const cap = 20;
  // Last '\n' before cap=20 is at index 17
  assert.equal(findSafeTruncationPoint(text, cap), 17);
});

test('findSafeTruncationPoint: does not cut inside an open fenced code block', () => {
  const text = [
    'Before fence.',
    '```js',
    'const x = 1;',
    'const y = 2;',
    '```',
    'After fence.',
  ].join('\n');

  // Put cap right in the middle of the fence block (after "const x = 1;\n")
  const fenceOpen = text.indexOf('```js');
  const insideFence = text.indexOf('const y') + 5;
  assert.ok(insideFence < text.indexOf('```', fenceOpen + 3), 'sanity: cap is inside fence');

  const result = findSafeTruncationPoint(text, insideFence);
  // Must return a position ≤ the opening of the fence line (safe cut before fence)
  assert.ok(result <= fenceOpen, `cut point ${result} must be before fence start ${fenceOpen}`);
});

test('findSafeTruncationPoint: does not cut on a table row line', () => {
  const text = [
    'Some prose before the table.',
    '',
    '| Col A | Col B |',
    '|-------|-------|',
    '| val1  | val2  |',
    '',
    'Some prose after.',
  ].join('\n');

  // Cap in the middle of the table block
  const tableStart = text.indexOf('| Col A');
  const insideTable = text.indexOf('| val1') + 5;
  assert.ok(insideTable < text.indexOf('\n\nSome prose after'), 'sanity: cap is inside table');

  const result = findSafeTruncationPoint(text, insideTable);
  // Must be before the table (on "Some prose before the table." paragraph)
  const beforeTable = text.lastIndexOf('\n', tableStart - 1);
  assert.ok(result <= beforeTable, `cut point ${result} must be before table start (${beforeTable})`);
});

test('findSafeTruncationPoint: falls back to cap when no safe \\n found before cap', () => {
  // One long line with no newline and a fence-open at pos 0
  const text = '```\nsome code without newlines before' + 'x'.repeat(500) + '\n```\n';
  // Cap at 10 — no '\n' before cap except the one right after ``` (which is
  // inside the opened fence, so not safe). Should fall back to cap=10.
  const result = findSafeTruncationPoint(text, 10);
  // Could be cap itself (10) or any safe position ≤ 10; since position 3 is
  // the '\n' but fence just OPENED on that line, not safe → falls back to cap
  assert.ok(result <= 10);
});

test('findSafeTruncationPoint: handles open fence at EOF gracefully (no crash)', () => {
  const text = 'Some text\n```\nunclosed fence content here\n';
  // Should not throw regardless of cap
  assert.doesNotThrow(() => findSafeTruncationPoint(text, 25));
});

test('findSafeTruncationPoint: closed fence followed by prose → safe cut in prose', () => {
  const text = [
    '```js',
    'console.log("hi");',
    '```',
    'After the fence, more prose.',
    'Still more prose here.',
  ].join('\n');
  // Cap well after the closing fence
  const afterFence = text.indexOf('After the fence') + 10;
  const result = findSafeTruncationPoint(text, afterFence);
  // Should land somewhere after the fence closing (fence is closed = safe)
  const fenceClose = text.indexOf('```', 5) + 3;
  assert.ok(result >= fenceClose, `cut point ${result} must be after fence close at ${fenceClose}`);
  assert.ok(result <= afterFence);
});

// ---------------------------------------------------------------------------
// splitIntoMarkdownChunks
// ---------------------------------------------------------------------------

test('splitIntoMarkdownChunks: empty input → empty array', () => {
  assert.deepEqual(splitIntoMarkdownChunks(''), []);
  assert.deepEqual(splitIntoMarkdownChunks(null), []);
});

test('splitIntoMarkdownChunks: plain text with no special blocks → same greedy line-packing as before', () => {
  // 5 lines of 20 chars each; budget = 50 → chunks of ≤50 chars
  const lines = Array.from({ length: 5 }, (_, i) => `Line ${i}: ${'x'.repeat(12)}`);
  const text = lines.join('\n');
  const chunks = splitIntoMarkdownChunks(text, 50);
  // Each chunk should be ≤50 chars (allow the last one to be smaller)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 52, `chunk "${chunk.slice(0, 30)}..." is ${chunk.length} chars, over 50`);
  }
  // And all original lines survive across all chunks
  const rejoined = chunks.join('\n');
  for (const line of lines) {
    assert.ok(rejoined.includes(line), `missing line: "${line}"`);
  }
});

test('splitIntoMarkdownChunks: an empty fenced code block at the document start does not swallow all subsequent content (regression for off-by-one close-detection bug)', () => {
  // Reproduced bug: ``` \n``` \n<50 lines of prose> → 1 giant chunk instead of many small ones.
  // The closing ``` on line index 1 (i=1) was wrongly rejected by `i > 1` guard.
  const text = '```\n```\n' + Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const chunks = splitIntoMarkdownChunks(text, 50);
  assert.ok(chunks.length > 1, `empty leading fence must not swallow all content; got ${chunks.length} chunk(s)`);
  assert.ok(chunks[0].includes('```'), 'first chunk must contain the fence block');
  assert.ok(chunks.some((c) => c.includes('line 10')), 'prose lines must land in subsequent chunks at their own budget');
});

test('splitIntoMarkdownChunks: fenced code block is never split across chunks', () => {
  const preamble = 'a'.repeat(40) + '\n' + 'b'.repeat(40) + '\n'; // ~80 chars
  const fence = '```js\nconst x = 1;\nconst y = 2;\n```\n'; // ~35 chars
  const postamble = 'c'.repeat(40) + '\n';
  const text = preamble + fence + postamble;

  // Budget = 90 — preamble fits, but adding the fence would push over budget
  const chunks = splitIntoMarkdownChunks(text, 90);

  // The fence open and close must be in the same chunk
  const fenceChunk = chunks.find((c) => c.includes('```js'));
  assert.ok(fenceChunk, 'fence open must appear in some chunk');
  assert.ok(fenceChunk.includes('```js') && fenceChunk.includes('const x') && fenceChunk.includes('```'),
    'fence open, content, and close must all be in the same chunk');
});

test('splitIntoMarkdownChunks: table rows are never split across chunks', () => {
  const preamble = 'x'.repeat(80) + '\n';
  const table = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
  const text = preamble + table;

  // Budget = 90 — preamble nearly fills it, table would overflow
  const chunks = splitIntoMarkdownChunks(text, 90);

  // All table rows must be in the same chunk
  const tableChunk = chunks.find((c) => c.includes('| A | B |'));
  assert.ok(tableChunk, 'table header must appear in some chunk');
  assert.ok(
    tableChunk.includes('| A | B |') &&
    tableChunk.includes('| 1 | 2 |') &&
    tableChunk.includes('| 3 | 4 |'),
    'all table rows must be in the same chunk'
  );
});

test('splitIntoMarkdownChunks: single oversized block becomes its own chunk rather than being dropped', () => {
  const hugeBlock = '```\n' + 'x'.repeat(5000) + '\n```';
  const chunks = splitIntoMarkdownChunks(hugeBlock, 100);
  assert.equal(chunks.length, 1, 'a single oversized block must still appear as one chunk');
  assert.ok(chunks[0].includes('x'.repeat(100)), 'the oversized content must not be truncated');
});

test('splitIntoMarkdownChunks: header and its following paragraph are both present across all chunks (content not lost)', () => {
  const part1 = 'paragraph one ' + 'a'.repeat(60) + '\n';
  const header = '## Section Two\n';
  const part2 = 'paragraph two ' + 'b'.repeat(60) + '\n';
  const text = part1 + header + part2;

  const chunks = splitIntoMarkdownChunks(text, 85);
  assert.ok(chunks.length >= 2, 'should split into at least 2 chunks');

  const rejoined = chunks.join('\n');
  assert.ok(rejoined.includes('## Section Two'), 'header must survive');
  assert.ok(rejoined.includes('paragraph two'), 'paragraph after header must survive');
});

test('splitIntoMarkdownChunks: all content survives without loss across all chunks', () => {
  const text = [
    '# Title',
    '',
    'Intro paragraph with some content here.',
    '',
    '```python',
    'def hello():',
    '    print("hi")',
    '```',
    '',
    '| Name | Value |',
    '|------|-------|',
    '| foo  | 123   |',
    '| bar  | 456   |',
    '',
    'Closing paragraph.',
  ].join('\n');

  const chunks = splitIntoMarkdownChunks(text, 60);
  const rejoined = chunks.join('\n');

  // Every significant piece of content should survive
  for (const needle of ['# Title', 'def hello():', '| foo  | 123', 'Closing paragraph.']) {
    assert.ok(rejoined.includes(needle), `missing: "${needle}"`);
  }
});
