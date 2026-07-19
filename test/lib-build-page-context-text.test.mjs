// test/lib-build-page-context-text.test.mjs — coverage for
// lib/page-extractor.js's buildPageContextText(), specifically the
// changedSinceLastAttach note added for local change detection (see
// lib/handlers/attach-change-tracker.js). No chrome mock needed --
// buildPageContextText is a pure string builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPageContextText } from '../lib/page-extractor.js';

test('buildPageContextText: no change note when changedSinceLastAttach is absent', () => {
  const out = buildPageContextText({
    meta: { url: 'https://example.com', title: 'Example' },
    mode: 'reader',
    text: 'hello world'
  });
  assert.doesNotMatch(out, /changed since it was last attached/);
});

test('buildPageContextText: includes a change note when changedSinceLastAttach is set', () => {
  const out = buildPageContextText({
    meta: { url: 'https://example.com', title: 'Example' },
    mode: 'reader',
    text: 'hello world',
    changedSinceLastAttach: { changed: true, previousAttachedAt: Date.now() - 60_000, previousLength: 42 }
  });
  assert.match(out, /changed since it was last attached/);
});

test('buildPageContextText: existing Mode/fallback line is unaffected when no change note applies', () => {
  const out = buildPageContextText({
    meta: { url: 'https://example.com', title: 'Example' },
    mode: 'full',
    text: 'hello world',
    fallback: true
  });
  assert.match(out, /Mode: full \(fallback to full\)\n---/);
});
