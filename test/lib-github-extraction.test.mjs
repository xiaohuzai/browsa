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

// ── tryGithubRepoExtraction (2026-10-07, repo metadata + raw README) ────────

import { githubRepoTarget, formatGithubRepoText, tryGithubRepoExtraction } from '../lib/page-extractor.js';

test('github repo URL: target accepts root and /tree/, rejects every other section', () => {
  assert.deepEqual(githubRepoTarget('https://github.com/volcengine/OpenViking'), { owner: 'volcengine', name: 'OpenViking', canonicalUrl: 'https://github.com/volcengine/OpenViking' });
  assert.deepEqual(githubRepoTarget('https://github.com/volcengine/OpenViking/'), { owner: 'volcengine', name: 'OpenViking', canonicalUrl: 'https://github.com/volcengine/OpenViking' });
  assert.deepEqual(githubRepoTarget('https://github.com/o/n/tree/main/lib'), { owner: 'o', name: 'n', canonicalUrl: 'https://github.com/o/n' });
  assert.equal(githubRepoTarget('https://github.com/o/n/blob/main/README.md'), null, '/blob/ has its own fast path');
  assert.equal(githubRepoTarget('https://github.com/o/n/issues'), null);
  assert.equal(githubRepoTarget('https://github.com/o'), null);
  assert.equal(githubRepoTarget('https://example.com/o/n'), null);
  assert.equal(githubRepoTarget('not a url'), null);
});

test('github repo URL: formatGithubRepoText builds metadata + README and reports capping', () => {
  const out = formatGithubRepoText({
    fullName: 'volcengine/OpenViking', description: 'An agent runtime.', homepage: 'https://example.com',
    language: 'TypeScript', licenseSpdx: 'MIT', stars: 12734, forks: 56, topics: ['ai', 'agents'],
  }, '# README body\n', 1_000_000);
  assert.ok(out.text.startsWith('# volcengine/OpenViking\n\n'));
  assert.ok(out.text.includes('**Description**: An agent runtime.'));
  assert.ok(out.text.includes('Language: TypeScript · License: MIT'));
  assert.ok(out.text.includes('Stars: 12,734'));
  assert.ok(out.text.includes('**Topics**: ai, agents'));
  assert.ok(out.text.includes('## README\n\n# README body'));
  assert.equal(out.wasCapped, false);

  const capped = formatGithubRepoText({ fullName: 'o/n' }, 'x'.repeat(300), 100);
  assert.equal(capped.wasCapped, true);
  assert.ok(capped.text.length < 300, 'README capped to textCap');

  // Either input missing → null (caller falls through to the generic cascade).
  assert.equal(formatGithubRepoText(null, '# r', 1000), null);
  assert.equal(formatGithubRepoText({ fullName: 'o/n' }, '   ', 1000), null);
});

function mockRepoFetch({ repoBody, repoStatus = 200, readmeBody, readmeStatus = 200 }) {
  const calls = [];
  return {
    calls,
    fn: async (url, opts) => {
      calls.push({ url, opts });
      const isRepo = url.endsWith('/readme') === false;
      const status = isRepo ? repoStatus : readmeStatus;
      const body = isRepo ? repoBody : readmeBody;
      if (status !== 200) return { ok: false, status, headers: { get: () => '' }, json: async () => null, text: async () => '' };
      return {
        ok: true,
        headers: { get: () => (isRepo ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8') },
        json: async () => JSON.parse(body),
        text: async () => body,
      };
    },
  };
}

test('github repo: fetches repo API + raw README, both credentials omitted', async () => {
  const mock = mockRepoFetch({
    repoBody: JSON.stringify({ full_name: 'volcengine/OpenViking', description: 'An agent runtime.', homepage: '', language: 'TypeScript', license: { spdx_id: 'MIT' }, stargazers_count: 5, forks_count: 1, topics: ['ai'] }),
    readmeBody: '# OpenViking\n\nbody\n',
  });
  const out = await withFetch(mock.fn, () => tryGithubRepoExtraction(
    { url: 'https://github.com/volcengine/OpenViking/tree/main' },
    { url: 'https://github.com/volcengine/OpenViking/tree/main', title: 't' },
    1_000_000
  ));
  assert.equal(out.mode, 'github-repo');
  assert.equal(out.articleTitle, 'volcengine/OpenViking');
  assert.ok(out.text.includes('# volcengine/OpenViking'));
  assert.ok(out.text.includes('## README'));
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].url, 'https://api.github.com/repos/volcengine/OpenViking');
  assert.equal(mock.calls[1].url, 'https://api.github.com/repos/volcengine/OpenViking/readme');
  assert.equal(mock.calls[0].opts.credentials, 'omit', 'api.github.com sends no ACA-Credentials — include would be blocked');
  assert.equal(mock.calls[1].opts.credentials, 'omit');
  assert.equal(mock.calls[1].opts.headers.Accept, 'application/vnd.github.raw', 'README rides the raw media type — no filename probing');
  assert.equal(out.truncated.wasCapped, false);
});

test('github repo: any failure returns null (generic cascade keeps the logged-in DOM)', async () => {
  const tab = { url: 'https://github.com/o/n' };
  const meta = { url: tab.url, title: 't' };
  // Repo API rate-limited (403 — the real unauthenticated ceiling).
  assert.equal(await withFetch(mockRepoFetch({ repoBody: '{}', repoStatus: 403, readmeBody: 'x' }).fn, () => tryGithubRepoExtraction(tab, meta, 1000)), null);
  // README endpoint failed.
  assert.equal(await withFetch(mockRepoFetch({ repoBody: '{"full_name":"o/n"}', readmeStatus: 404, readmeBody: '' }).fn, () => tryGithubRepoExtraction(tab, meta, 1000)), null);
  // Network throw.
  assert.equal(await withFetch(async () => { throw new Error('offline'); }, () => tryGithubRepoExtraction(tab, meta, 1000)), null);
  // Binary README (null byte in first 4KB).
  assert.equal(await withFetch(mockRepoFetch({ repoBody: '{"full_name":"o/n"}', readmeBody: 'PK\x00\x03\x04 rest' }).fn, () => tryGithubRepoExtraction(tab, meta, 1000)), null);
  // Non-repo URL never fetches.
  let calls = 0;
  await withFetch(async (url) => { calls += 1; throw new Error('should not fetch'); }, () => tryGithubRepoExtraction({ url: 'https://github.com/o/n/blob/main/x.md' }, meta, 1000));
  assert.equal(calls, 0);
});
