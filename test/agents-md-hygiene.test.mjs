// test/agents-md-hygiene.test.mjs — the AGENTS.md family is loaded into agent
// sessions, so its size is a fixed tax on every task. The 2026-10-17 audit
// found the single root file at ~365KB (≈90K tokens); the 2026-10-24
// restructure (agents.md spec: nested files, nearest-wins) moved subsystem
// depth into four nested files and distilled the root into a global index —
// a session now pays root + at most the one subsystem file it works in.
//
// This test holds the line per file: none may grow past its current budget,
// and new paragraphs must stay under the wall-of-prose limit. Tightening a
// budget (after moving narrative into the wiki) is welcome; raising one needs
// a deliberate decision, not an accidental long paragraph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// (path, budget bytes) — budgets are the post-2026-10-24 restructure sizes.
// Root stays small by design (global index only); subsystem files carry the
// subsystem depth and should trend DOWN as narratives move to the wiki.
const FILES = [
  ['AGENTS.md', 14_000],
  ['lib/handlers/AGENTS.md', 191_000],
  ['lib/sidepanel/AGENTS.md', 89_000],
  ['lib/content-scripts/AGENTS.md', 26_000],
  ['test/AGENTS.md', 3_000],
];
// A single line this long cannot be reviewed in a diff and suggests prose that
// belongs in the wiki with a one-line pointer here.
const MAX_LINE_CHARS = 4_000;

test('every AGENTS.md file stays within its budget', async () => {
  for (const [path, budget] of FILES) {
    const src = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const bytes = Buffer.byteLength(src, 'utf8');
    assert.ok(bytes <= budget,
      `${path} is ${bytes} bytes (budget ${budget}). Move mechanism/narrative into the wiki ` +
      `(Architecture / Rendering-Pipeline / Providers-and-Agents / ASR-and-Video-Analysis) ` +
      `and keep only the ruling line here.`);
  }
});

test('the root file maps the nested AGENTS.md files (progressive disclosure)', async () => {
  const src = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  for (const nested of FILES.map(([p]) => p).filter((p) => p !== 'AGENTS.md')) {
    assert.ok(src.includes(nested),
      `root AGENTS.md must point at ${nested} — the subsystem map is how agents find the layered files`);
  }
});

test('no single AGENTS.md line is an unreviewable wall of prose', async () => {
  for (const [path] of FILES) {
    const src = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const offenders = src.split('\n')
      .map((line, i) => ({ n: i + 1, len: line.length }))
      .filter((l) => l.len > MAX_LINE_CHARS);
    assert.deepEqual(offenders, [],
      `${path}: wrap or move these lines (max ${MAX_LINE_CHARS} chars): ` +
      offenders.map((o) => `line ${o.n} (${o.len})`).join(', '));
  }
});
