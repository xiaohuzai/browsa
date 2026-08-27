// test/lib-error-classifier.test.mjs — classifyErrorText() maps real-world
// provider/background error strings to friendly i18n keys; unmatched text
// stays unclassified (null) so the UI never invents a headline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyErrorText } from '../lib/sidepanel/error-classifier.js';

test('classifies auth failures (status code or wording)', () => {
  assert.equal(classifyErrorText('HTTP 401 Unauthorized').key, 'errAuth');
  assert.equal(classifyErrorText('Error: Incorrect API key provided').key, 'errAuth');
  assert.equal(classifyErrorText('403 Forbidden for url ...').key, 'errAuth');
});

test('classifies rate limiting / quota', () => {
  assert.equal(classifyErrorText('429 Too Many Requests').key, 'errRateLimit');
  assert.equal(classifyErrorText('insufficient_quota: you exceeded your quota').key, 'errRateLimit');
});

test('classifies unknown/decommissioned model ids', () => {
  assert.equal(classifyErrorText("The model 'gpt-9x' does not exist").key, 'errModel');
  assert.equal(classifyErrorText('model_not_found: no such model on this account').key, 'errModel');
});

test('classifies timeouts, network failures, and 5xx', () => {
  assert.equal(classifyErrorText('Request timed out after 30000ms').key, 'errTimeout');
  assert.equal(classifyErrorText('TypeError: Failed to fetch').key, 'errNetwork');
  assert.equal(classifyErrorText('getaddrinfo ENOTFOUND api.example.com').key, 'errNetwork');
  assert.equal(classifyErrorText('HTTP 502 Bad Gateway from upstream').key, 'errServer');
});

test('order matters: a 401 wrapped in server prose is still auth', () => {
  assert.equal(classifyErrorText('Internal proxy says 401 before upstream call').key, 'errAuth');
});

test('unmatched text returns null — the UI then renders the raw string alone', () => {
  assert.equal(classifyErrorText('没有获取到选中文字，请重新选择'), null);
  assert.equal(classifyErrorText(''), null);
  assert.equal(classifyErrorText(null), null);
});
