// test/lib-tool-tier.test.mjs — classifyToolTier is the single home of the tool
// progress regex table (it replaced two verbatim copies kept in sync by comment).
// The ORDER of the rules is the behavior: a line can match several patterns, and
// the first match wins. The 2026-11-03 audit found only 'searching' pinned, so a
// reordering that silently re-tiered every tool chip would have stayed green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolTier } from '../lib/sidepanel/tool-tier.js';

const CASES = [
  ['Thinking about the request', 'thinking'],
  ['Analyze the page', 'thinking'],
  ['Fetching https://example.com/api', 'searching'],
  ['web_search: quantum docs', 'searching'],
  ['Reading /etc/hosts', 'reading'],
  ['Opening file notes.md', 'reading'],
  ['Write result.json', 'writing'],
  ['Updating the draft', 'writing'],
  ['Running bash -lc "npm test"', 'running'],
  ['Executing shell command', 'running'],
];

test('classifyToolTier: one row per rule, exact tier names', () => {
  for (const [text, tier] of CASES) {
    assert.equal(classifyToolTier(text).tier, tier, `"${text}" should classify as ${tier}`);
  }
});

test('classifyToolTier: matches the FIRST rule, so the table order is the behavior', () => {
  // "search the web and then write a file" hits searching before writing;
  // "read the file before running it" hits reading before running.
  assert.equal(classifyToolTier('search the web, then write a file').tier, 'searching');
  assert.equal(classifyToolTier('read the file, then run it').tier, 'reading');
  assert.equal(classifyToolTier('think, then search, then write').tier, 'thinking');
});

test('classifyToolTier: gerunds and British spellings fall through (documented limit)', () => {
  // The table matches verb STEMS, so "Writing …"/"Analysing …" would classify as
  // the empty tier (gear). Pinned so a future "improvement" to the regexes has to
  // make a deliberate decision about these spellings instead of silently changing
  // what every tool chip shows.
  assert.equal(classifyToolTier('Writing result.json').tier, '');
  assert.equal(classifyToolTier('Analysing the page').tier, '');
});

test('classifyToolTier: unknown lines degrade to the empty tier with the gear icon', () => {
  const unknown = classifyToolTier('Zzz');
  assert.equal(unknown.tier, '', 'no match → empty tier');
  assert.ok(unknown.icon, 'a fallback icon is required so the chip never renders blank');
});

test('classifyToolTier: non-string input does not throw (progress lines arrive from agents)', () => {
  assert.equal(classifyToolTier(undefined).tier, '');
  assert.equal(classifyToolTier(null).tier, '');
  assert.equal(classifyToolTier(42).tier, '');
});
