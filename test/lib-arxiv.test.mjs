// test/lib-arxiv.test.mjs — pure-function coverage for lib/arxiv.js:
// URL→ID extraction across arXiv URL shapes, Atom XML parsing (DOMParser
// present and absent), header formatting, and the fetch wrapper's
// best-effort contract (non-arXiv URL resolves null without calling fetch).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html>');
globalThis.DOMParser = dom.window.DOMParser;

const {
  arxivIdFromUrl, parseArxivAtomXml, formatArxivMeta, fetchArxivMeta
} = await import('../lib/arxiv.js');

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: 2401.12345</title>
  <totalResults>1</totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-02-03T17:59:59Z</updated>
    <published>2024-01-22T18:14:32Z</published>
    <title>A Study of Attention Mechanisms in Large Models</title>
    <summary>We study attention. This is the abstract text.</summary>
    <author><name>Jane Doe</name></author>
    <author><name>John Smith</name></author>
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">12 pages, 3 figures</arxiv:comment>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">Nature 2024</arxiv:journal_ref>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1000/example</arxiv:doi>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.LG"/>
    <category term="cs.LG"/>
    <category term="cs.CL"/>
  </entry>
</feed>`;

test('arxivIdFromUrl: new-style IDs across /abs, /pdf (with and without .pdf), /html, and versions', () => {
  const cases = [
    ['https://arxiv.org/abs/2401.12345', { id: '2401.12345', version: null }],
    ['https://arxiv.org/pdf/2401.12345v2.pdf', { id: '2401.12345v2', version: 'v2' }],
    ['https://arxiv.org/pdf/2401.12345v2', { id: '2401.12345v2', version: 'v2' }],
    ['https://arxiv.org/html/2401.12345v3', { id: '2401.12345v3', version: 'v3' }],
    ['https://arxiv.org/format/2401.12345', { id: '2401.12345', version: null }],
    // 5-digit IDs (post-2024 numbering) and export host
    ['https://export.arxiv.org/pdf/2503.12345', { id: '2503.12345', version: null }],
  ];
  for (const [url, want] of cases) assert.deepEqual(arxivIdFromUrl(url), want, url);
});

test('arxivIdFromUrl: old-style IDs (archive/ and subject-class prefixes)', () => {
  assert.deepEqual(arxivIdFromUrl('https://arxiv.org/abs/cs/0301012'), { id: 'cs/0301012', version: null });
  assert.deepEqual(arxivIdFromUrl('https://arxiv.org/pdf/math.GT/0603001v1'), { id: 'math.GT/0603001v1', version: 'v1' });
});

test('arxivIdFromUrl: non-arXiv hosts, non-paper paths, garbage — all null', () => {
  assert.equal(arxivIdFromUrl('https://example.com/pdf/2401.12345'), null);
  assert.equal(arxivIdFromUrl('https://arxiv.org/abs/'), null);
  assert.equal(arxivIdFromUrl('https://arxiv.org/help'), null);
  assert.equal(arxivIdFromUrl('not a url'), null);
  assert.equal(arxivIdFromUrl(''), null);
  assert.equal(arxivIdFromUrl(null), null);
  // arxiv.org hosted but the ID is not a paper path
  assert.equal(arxivIdFromUrl('https://arxiv.org/list/cs/recent'), null);
});

test('parseArxivAtomXml: DOMParser path extracts authors/categories/dates/DOI/comment', () => {
  const m = parseArxivAtomXml(SAMPLE_ATOM);
  assert.ok(m, 'must parse');
  assert.equal(m.title, 'A Study of Attention Mechanisms in Large Models');
  assert.equal(m.abstract, 'We study attention. This is the abstract text.');
  assert.deepEqual(m.authors, ['Jane Doe', 'John Smith']);
  assert.equal(m.primaryCategory, 'cs.LG');
  assert.ok(m.categories.includes('cs.CL'));
  assert.equal(m.published.slice(0, 10), '2024-01-22');
  assert.equal(m.doi, '10.1000/example');
  assert.equal(m.journal, 'Nature 2024');
  assert.equal(m.comment, '12 pages, 3 figures');
  assert.match(m.id, /2401\.12345/);
});

test('parseArxivAtomXml: regex fallback path (no DOMParser) matches the DOMParser result', async () => {
  const saved = globalThis.DOMParser;
  delete globalThis.DOMParser;
  try {
    const m = parseArxivAtomXml(SAMPLE_ATOM);
    assert.ok(m, 'must parse without DOMParser');
    assert.equal(m.title, 'A Study of Attention Mechanisms in Large Models');
    assert.deepEqual(m.authors, ['Jane Doe', 'John Smith']);
    assert.equal(m.primaryCategory, 'cs.LG');
    assert.equal(m.doi, '10.1000/example');
    assert.equal(m.comment, '12 pages, 3 figures');
  } finally {
    globalThis.DOMParser = saved;
  }
});

test('parseArxivAtomXml: non-Atom garbage resolves null (caller attaches without metadata)', () => {
  assert.equal(parseArxivAtomXml(''), null);
  assert.equal(parseArxivAtomXml('<html><body>blocked</body></html>'), null);
  assert.equal(parseArxivAtomXml(null), null);
});

test('formatArxivMeta: header lines with author cap and version note; empty meta → empty string', () => {
  const m = parseArxivAtomXml(SAMPLE_ATOM);
  const header = formatArxivMeta(m, 'v2');
  assert.match(header, /^arXiv: 2401\.12345/);
  assert.match(header, /Authors: Jane Doe, John Smith/);
  assert.match(header, /Categories: cs\.LG, cs\.CL/);
  assert.match(header, /Published: 2024-01-22/);
  assert.match(header, /Attached version: v2/);
  assert.match(header, /DOI: 10\.1000\/example/);
  assert.match(header, /Comments: 12 pages, 3 figures/);
  // >8 authors collapses to "et al."
  const many = { ...m, authors: Array.from({ length: 11 }, (_, i) => `Author ${i + 1}`) };
  assert.match(formatArxivMeta(many), /et al\./);
  assert.equal(formatArxivMeta(null), '');
  assert.equal(formatArxivMeta({}), '');
});

test('fetchArxivMeta: resolves the parsed meta on a successful Atom response', async () => {
  let calledUrl = '';
  const meta = await fetchArxivMeta('https://arxiv.org/pdf/2401.12345v2', {
    fetchImpl: async (url) => {
      calledUrl = url;
      return { ok: true, text: async () => SAMPLE_ATOM };
    }
  });
  assert.ok(meta, 'meta must resolve');
  assert.match(calledUrl, /export\.arxiv\.org\/api\/query\?id_list=2401\.12345/);
  assert.match(calledUrl, /max_results=1/);
});

test('fetchArxivMeta: non-arXiv URL resolves null without touching fetch', async () => {
  let calls = 0;
  const meta = await fetchArxivMeta('https://example.com/paper.pdf', {
    fetchImpl: async () => { calls++; return { ok: true, text: async () => SAMPLE_ATOM }; }
  });
  assert.equal(meta, null);
  assert.equal(calls, 0);
});

test('fetchArxivMeta: HTTP error, bad payload, and network throw all resolve null (best-effort contract)', async () => {
  const ok200 = { ok: false, status: 503, text: async () => SAMPLE_ATOM };
  assert.equal(await fetchArxivMeta('https://arxiv.org/abs/2401.12345', { fetchImpl: async () => ok200 }), null);
  assert.equal(await fetchArxivMeta('https://arxiv.org/abs/2401.12345', {
    fetchImpl: async () => ({ ok: true, text: async () => 'garbage' })
  }), null);
  assert.equal(await fetchArxivMeta('https://arxiv.org/abs/2401.12345', {
    fetchImpl: async () => { throw new Error('network down'); }
  }), null);
});
