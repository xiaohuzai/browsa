// test/agents-md-hygiene.test.mjs — AGENTS.md is loaded into EVERY agent
// session's context, so its size is a fixed tax on every task. The 2026-10-17
// audit found it at ~365KB (≈90K tokens) with 238 single-line paragraphs over
// 500 characters — unreadable in a diff and expensive to load. This test holds
// the line: the file may not grow past its current budget, and new paragraphs
// must be wrapped rather than appended as one giant line.
//
// Tightening the budget (after moving narrative into the wiki) is welcome;
// raising it needs a deliberate decision, not an accidental long paragraph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');

// Current size after the 2026-10-17 compaction pass, with headroom for the
// next few ruling cards. Move narrative to the wiki instead of raising this.
const MAX_BYTES = 370_000;
// A single line this long cannot be reviewed in a diff and suggests prose that
// belongs in the wiki with a one-line pointer here.
const MAX_LINE_CHARS = 4_000;

test('AGENTS.md stays within its context budget', () => {
  const bytes = Buffer.byteLength(src, 'utf8');
  assert.ok(bytes <= MAX_BYTES,
    `AGENTS.md is ${bytes} bytes (budget ${MAX_BYTES}). Move mechanism/narrative into the wiki ` +
    `(Architecture / Rendering-Pipeline / Providers-and-Agents / ASR-and-Video-Analysis) and keep only the ruling card here.`);
});

test('no single AGENTS.md line is an unreviewable wall of prose', () => {
  const offenders = src.split('\n')
    .map((line, i) => ({ n: i + 1, len: line.length }))
    .filter((l) => l.len > MAX_LINE_CHARS);
  assert.deepEqual(offenders, [],
    `wrap or move these lines (max ${MAX_LINE_CHARS} chars): ` +
    offenders.map((o) => `line ${o.n} (${o.len})`).join(', '));
});
