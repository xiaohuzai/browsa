// test/lib-dom-similarity.test.mjs -- unit tests for lib/dom-similarity.js
// (pure string/descriptor similarity utilities, no DOM dependency).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, stringRatio, scoreDescriptors } from '../lib/dom-similarity.js';

test('cleanText strips zero-width characters', () => {
  const withZwsp = 'hello' + String.fromCharCode(0x200b) + 'world';
  assert.equal(cleanText(withZwsp), 'helloworld');
});

test("cleanText strips control characters but keeps \\n and \\t", () => {
  const withControl = "a" + String.fromCharCode(0x0001) + "b\tc\nd" + String.fromCharCode(0x007f) + "e";
  const cleaned = cleanText(withControl);
  assert.equal(cleaned, "ab c\nde");
  assert.equal(cleaned.includes(String.fromCharCode(0x0001)), false);
  assert.equal(cleaned.includes(String.fromCharCode(0x007f)), false);
});

test('cleanText collapses runs of spaces/tabs and excess blank lines', () => {
  assert.equal(cleanText('a    b'), 'a b');
  assert.equal(cleanText('a\n\n\n\nb'), 'a\n\nb');
});

test('cleanText trims leading/trailing whitespace', () => {
  assert.equal(cleanText('   hi   '), 'hi');
});

test('cleanText passes through non-string values unchanged', () => {
  assert.equal(cleanText(null), null);
  assert.equal(cleanText(42), 42);
  assert.equal(cleanText(undefined), undefined);
});

test('stringRatio returns 1 for identical strings, 0 for one empty', () => {
  assert.equal(stringRatio('hello', 'hello'), 1);
  assert.equal(stringRatio('hello', ''), 0);
  assert.equal(stringRatio('', ''), 1);
});

test('stringRatio is symmetric and scores similar strings higher than dissimilar ones', () => {
  const close = stringRatio('the quick brown fox', 'the quick brown fx');
  const far = stringRatio('the quick brown fox', 'completely unrelated text');
  assert.ok(close > far, `expected close (${close}) > far (${far})`);
  assert.equal(stringRatio('abc', 'xyz'), stringRatio('xyz', 'abc'));
});

test('stringRatio handles null/undefined inputs gracefully', () => {
  assert.equal(stringRatio(null, undefined), 1);
  assert.equal(stringRatio('a', null), 0);
});

test('scoreDescriptors returns 0 when tags differ', () => {
  const a = { tag: 'div', classes: ['card'], id: '', text: 'hello', depth: 3, parentTag: 'ul' };
  const b = { tag: 'span', classes: ['card'], id: '', text: 'hello', depth: 3, parentTag: 'ul' };
  assert.equal(scoreDescriptors(a, b), 0);
});

test('scoreDescriptors returns 0 for null/undefined descriptors', () => {
  assert.equal(scoreDescriptors(null, {}), 0);
  assert.equal(scoreDescriptors({}, undefined), 0);
});

test('scoreDescriptors scores an identical descriptor as 1', () => {
  const a = { tag: 'li', classes: ['item', 'card'], id: 'x1', attrs: { 'data-id': '5' }, text: 'Product A', depth: 4, parentTag: 'ul' };
  const score = scoreDescriptors(a, { ...a });
  assert.ok(Math.abs(score - 1) < 1e-9, `expected ~1, got ${score}`);
});

test('scoreDescriptors ranks a near-identical sibling higher than an unrelated element', () => {
  const sample = { tag: 'li', classes: ['item', 'card'], id: '', attrs: { 'data-id': '1' }, text: 'Product A - $10', depth: 4, parentTag: 'ul' };
  const sibling = { tag: 'li', classes: ['item', 'card'], id: '', attrs: { 'data-id': '2' }, text: 'Product B - $12', depth: 4, parentTag: 'ul' };
  const unrelated = { tag: 'li', classes: ['footer-link'], id: '', attrs: {}, text: 'Contact us', depth: 8, parentTag: 'nav' };

  const siblingScore = scoreDescriptors(sample, sibling);
  const unrelatedScore = scoreDescriptors(sample, unrelated);
  assert.ok(siblingScore > unrelatedScore, `expected sibling (${siblingScore}) > unrelated (${unrelatedScore})`);
});

test('scoreDescriptors falls back to a neutral depth ratio when depth is missing', () => {
  const a = { tag: 'p', classes: [], id: '', text: 'x' };
  const b = { tag: 'p', classes: [], id: '', text: 'x' };
  const score = scoreDescriptors(a, b);
  assert.ok(score > 0 && score <= 1);
});
