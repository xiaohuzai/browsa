// test/lib-github-extraction.test.mjs - coverage for the GitHub /blob/ raw
// fast-path in lib/page-extractor.js (tryGithubExtraction). The function
// only uses `new URL` + global `fetch`, so no chrome/jsdom mock is needed --
// we stub global.fetch per test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryGithubExtraction } from '../lib/page-extractor.js';

const META = { url: '', title: 'OpenViking/bot/README.md at main · volcengine/OpenViking · GitHub' };

function withFetch(mockFn, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = orig; });
}

// Build a fetch mock that returns a Response-like object for a given URL.
function mockReturning({ status = 200, ct = 'text/plain; charset=utf-8', body = '' }) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (status === 200) {
      return {
        ok: true,
        headers: { get: (k) => k.toLowerCase() === 'content-type' ? ct : null },
        text: async () => body
      };
    }
    return { ok: false, status, headers: { get: () => ct }, text: async () => '' };
  };
  fn.calls = calls;
  return fn;
}

test('github blob URL: rewrites to raw.githubusercontent.com and returns source', async () => {
  const mock = mockReturning({ body: '# VikingBot\n\nThe multi-channel AI agent.\n' });
  const tab = { url: 'https://github.com/volcengine/OpenViking/blob/main/bot/README.md' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.deepEqual(out.mode, 'github-raw');
  assert.deepEqual(out.text, '# VikingBot\n\nThe multi-channel AI agent.\n');
  assert.deepEqual(out.articleTitle, META.title);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].url, 'https://raw.githubusercontent.com/volcengine/OpenViking/main/bot/README.md');
  // credentials must be 'omit' (raw sends no Access-Control-Allow-Credentials)
  assert.deepEqual(mock.calls[0].opts, { credentials: 'omit' });
  assert.deepEqual(out.truncated, { rawTextLength: 41, textLength: 41, wasCapped: false, textCap: 1_000_000 });
});

test('www.github.com host is also accepted', async () => {
  const mock = mockReturning({ body: 'hello' });
  const tab = { url: 'https://www.github.com/owner/repo/blob/main/file.txt' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out.mode, 'github-raw');
  assert.equal(mock.calls[0].url, 'https://raw.githubusercontent.com/owner/repo/main/file.txt');
});

test('non-github host returns null and does not fetch', async () => {
  let called = false;
  const mock = () => { called = true; return Promise.resolve({ ok: true, headers: { get: () => 'text/plain' }, text: async () => 'x' }); };
  const tab = { url: 'https://gitlab.com/owner/repo/blob/main/README.md' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out, null);
  assert.equal(called, false);
});

test('non-blob GitHub path (/tree/) returns null and does not fetch', async () => {
  let called = false;
  const mock = () => { called = true; return Promise.resolve({ ok: true, headers: { get: () => 'text/plain' }, text: async () => 'x' }); };
  const tab = { url: 'https://github.com/volcengine/OpenViking/tree/main/bot' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out, null);
  assert.equal(called, false);
});

test('404 (private repo / missing file) returns null -> caller falls through', async () => {
  const mock = mockReturning({ status: 404 });
  const tab = { url: 'https://github.com/owner/repo/blob/main/missing.md' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out, null);
});

test('binary content-type (image/png) returns null -> falls through', async () => {
  const mock = mockReturning({ ct: 'image/png', body: '\x89PNG\r\n\x1a\n' });
  const tab = { url: 'https://github.com/owner/repo/blob/main/logo.png' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out, null);
});

test('PDF content-type returns null (though tryPdfExtraction usually catches these first)', async () => {
  const mock = mockReturning({ ct: 'application/pdf', body: '%PDF-1.4' });
  const tab = { url: 'https://github.com/owner/repo/blob/main/doc.pdf' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out, null);
});

test('null byte in first 4KB (binary disguised as text) returns null', async () => {
  const mock = mockReturning({ ct: 'text/plain', body: 'text\x00binary\x00data' });
  const tab = { url: 'https://github.com/owner/repo/blob/main/weird.txt' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out, null);
});

test('null byte AFTER 4KB is allowed (legit text can contain one far in)', async () => {
  const body = 'a'.repeat(4000) + '\x00' + 'b'.repeat(10);
  const mock = mockReturning({ ct: 'text/plain', body });
  const tab = { url: 'https://github.com/owner/repo/blob/main/big.txt' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out.mode, 'github-raw');
  assert.equal(out.text, body);
});

test('network throw returns null (fail-open)', async () => {
  const mock = async () => { throw new Error('network down'); };
  const tab = { url: 'https://github.com/owner/repo/blob/main/README.md' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out, null);
});

test('textCap truncation sets wasCapped and slices', async () => {
  const body = 'x'.repeat(1000);
  const mock = mockReturning({ ct: 'text/plain', body });
  const tab = { url: 'https://github.com/owner/repo/blob/main/big.md' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 100));
  assert.equal(out.mode, 'github-raw');
  assert.equal(out.text.length, 100);
  assert.equal(out.truncated.rawTextLength, 1000);
  assert.equal(out.truncated.wasCapped, true);
  assert.equal(out.truncated.textCap, 100);
});

test('ref with slash (feature/branch) is passed through to raw URL', async () => {
  const mock = mockReturning({ body: 'diff' });
  const tab = { url: 'https://github.com/owner/repo/blob/feature/my-branch/src/index.js' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out.mode, 'github-raw');
  assert.equal(mock.calls[0].url, 'https://raw.githubusercontent.com/owner/repo/feature/my-branch/src/index.js');
});

test('empty body returns null', async () => {
  const mock = mockReturning({ ct: 'text/plain', body: '' });
  const tab = { url: 'https://github.com/owner/repo/blob/main/empty.txt' };
  const out = await withFetch(mock, () => tryGithubExtraction(tab, META, 1_000_000));
  assert.equal(out, null);
});
