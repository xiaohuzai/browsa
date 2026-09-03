// test/sanitize-url.test.mjs — URL credential redaction for prompt-facing
// page context (lib/sanitize-url.js). Verified behaviors:
//   - sensitive query params are masked, non-sensitive ones untouched
//   - userinfo (user:pass@host) is dropped
//   - credential-bearing fragments (#access_token=…) are dropped
//   - clean URLs are returned byte-identical (no URL round-trip rewriting)
//   - redactTextUrls masks every embedded URL without eating markdown syntax
//   - fetching paths are NOT covered by this layer by design (scope note)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrlCredentials, redactTextUrls } from '../lib/sanitize-url.js';
import { buildPageContextText } from '../lib/message-builder.js';

test('masks sensitive query parameter values, keeps the names', () => {
  assert.equal(
    redactUrlCredentials('https://example.com/p?token=SECRET123&id=42'),
    'https://example.com/p?token=%E2%80%A6&id=42'
  );
});

test('recognizes the common credential parameter family', () => {
  const cases = [
    ['access_token', 'https://x.com/?access_token=abc'],
    ['api_key', 'https://x.com/?api_key=abc'],
    ['apikey', 'https://x.com/?apikey=abc'],
    ['session_id', 'https://x.com/?session_id=abc'],
    ['signature', 'https://x.com/?signature=abc'],
    ['client_secret', 'https://x.com/?client_secret=abc'],
    ['password', 'https://x.com/?password=abc'],
    ['auth', 'https://x.com/?auth=abc'],
  ];
  for (const [name, url] of cases) {
    const out = redactUrlCredentials(url);
    assert.match(out, new RegExp(`${name}=%E2%80%A6`), `${name} must be masked`);
    assert.ok(!out.includes('abc'), `the value of ${name} must not survive`);
  }
});

test('leaves non-sensitive parameters untouched', () => {
  assert.equal(
    redactUrlCredentials('https://x.com/search?q=browsa&page=2&sort=votes&code=PRISM2026'),
    'https://x.com/search?q=browsa&page=2&sort=votes&code=PRISM2026'
  );
});

test('drops userinfo and credential-bearing hash fragments', () => {
  assert.equal(redactUrlCredentials('https://user:p%40ss@example.com/page'), 'https://example.com/page');
  assert.equal(
    redactUrlCredentials('https://app.example.com/oauth#access_token=XYZ&state=ok'),
    'https://app.example.com/oauth'
  );
});

test('clean URLs are returned byte-identical — no URL round-trip rewriting', () => {
  // new URL().toString() may reorder/percent-encode; a no-op redaction must
  // hand back the exact original string so context text stays stable.
  const clean = 'https://example.com/docs/getting-started?tab=readme#intro';
  assert.equal(redactUrlCredentials(clean), clean);
});

test('non-http(s) strings pass through untouched', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(redactUrlCredentials(dataUrl), dataUrl);
  assert.equal(redactUrlCredentials(''), '');
  assert.equal(redactUrlCredentials(null), '');
  assert.equal(redactUrlCredentials(undefined), '');
  assert.equal(redactUrlCredentials('not a url'), 'not a url');
});

test('redactTextUrls masks every embedded URL without eating surrounding syntax', () => {
  const md = 'See [the docs](https://x.com/doc?token=T&page=1) and bare https://y.com/?sig=S tail.';
  const out = redactTextUrls(md);
  assert.ok(out.includes('(https://x.com/doc?token=%E2%80%A6&page=1)'), 'markdown link target must be masked, parens kept');
  assert.ok(out.includes('https://y.com/?sig=%E2%80%A6 tail.'), 'bare URL masked with trailing text intact');
  assert.ok(!out.includes('SECRET123') && !out.includes('=T') && !out.includes('=S'), 'no secret values survive');
});

test('redactTextUrls passes URL-free text through unchanged', () => {
  assert.equal(redactTextUrls('no links here\nnone at all'), 'no links here\nnone at all');
  assert.equal(redactTextUrls(null), '');
});

test('buildPageContextText redacts the header URL and body links', () => {
  const ctx = {
    meta: { url: 'https://site.example/article?session_id=S1', title: 'T' },
    mode: 'full',
    text: 'ref: [1] https://cdn.example/x?Expires=1&token=K',
    format: null,
    fallback: null,
    changedSinceLastAttach: null,
  };
  const out = buildPageContextText(ctx);
  assert.ok(out.includes('URL: https://site.example/article?session_id=%E2%80%A6'));
  assert.ok(out.includes('https://cdn.example/x?Expires=1&token=%E2%80%A6'));
  assert.ok(!out.includes('S1') && !out.includes('K'));
});
