// lib/arxiv.js — arXiv paper metadata enrichment for PDF attachments.
//
// An attached arXiv PDF carries only what the file itself holds, and arXiv's
// PDF Info dictionary is usually just the filename — the model never sees
// authors, categories, version history, or the official abstract. The arXiv
// Atom API (export.arxiv.org/api/query?id_list=…) returns all of that for an
// ID extracted from any arXiv URL shape, so the sidepanel fetches it once per
// attach and bakes it into the context header. Everything here is
// best-effort: any failure (non-arXiv URL, network, parse) resolves null and
// the caller attaches without the block.

// arXiv identifier: new style (2401.12345, optional v2 suffix) and old style
// (cs/0301012, math.GT/0603001 — archive/ or subject-class prefix).
const ARXIV_ID = String.raw`(\d{4}\.\d{4,5})(v\d+)?`;
const ARXIV_OLD_ID = String.raw`([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?`;

/**
 * Extract an arXiv paper ID from any arXiv URL shape:
 * /abs/2401.12345, /pdf/2401.12345v2 (with or without .pdf), /html/2401.12345,
 * old-style /abs/cs/0301012. Returns { id, version } or null. Version kept
 * separately — the API answers without it (latest), and the version a PDF was
 * fetched at is surfaced as its own note.
 */
export function arxivIdFromUrl(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (!/(^|\.)arxiv\.org$/.test(u.hostname)) return null;
  const m = new RegExp(String.raw`/(?:abs|pdf|html|format)/` + ARXIV_ID, 'i').exec(u.pathname)
        || new RegExp(String.raw`/(?:abs|pdf|html|format)/` + ARXIV_OLD_ID, 'i').exec(u.pathname);
  if (!m) return null;
  return { id: m[1] + (m[2] || ''), version: m[2] || null };
}

/** Strip the Atom namespace prefix that arXiv puts on every element. */
function localName(el) {
  return el.tagName ? el.tagName.replace(/^.*:/, '') : '';
}

function collapse(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function textOf(el) {
  // Accepts a DOM element (textContent) or a regex-captured string (the
  // no-DOMParser fallback path).
  return collapse(typeof el === 'string' ? el : el?.textContent);
}

/**
 * Parse the arXiv Atom query response into a flat meta object. Uses DOMParser
 * when present (extension pages) and falls back to a conservative regex scan
 * (Node tests, where DOMParser doesn't exist). Returns null on anything that
 * doesn't look like an entry — the caller attaches without metadata.
 */
export function parseArxivAtomXml(xml) {
  if (typeof xml !== 'string' || !xml.includes('<entry')) return null;
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.querySelector('parsererror')) return null;
      const entry = doc.getElementsByTagName('entry')[0];
      if (!entry) return null;
      const child = (name) => {
        for (const el of entry.getElementsByTagName('*')) {
          if (localName(el) === name && el.parentElement === entry) return textOf(el);
        }
        return '';
      };
      return {
        id: child('id'),
        title: child('title'),
        abstract: child('summary'),
        authors: [...entry.getElementsByTagName('author')]
          .filter((a) => a.parentElement === entry)
          .map((a) => textOf(a.getElementsByTagName('name')[0] || a))
          .filter(Boolean),
        primaryCategory: (entry.getElementsByTagName('arxiv:primary_category')[0] || {})
          .getAttribute?.('term') || '',
        categories: [...entry.getElementsByTagName('category')]
          .map((c) => c.getAttribute('term')).filter(Boolean),
        published: child('published'),
        updated: child('updated'),
        doi: child('doi'),
        journal: child('journal_ref'),
        comment: child('comment')
      };
    } catch (_) { /* fall through to the regex scan */ }
  }
  // Regex fallback: first entry only; tags are namespace-prefixed or not,
  // so match the bare local name at a word boundary.
  const pick = (tag) => {
    const m = new RegExp(String.raw`<(?:[\w.-]+:)?${tag}[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?${tag}>`).exec(xml);
    return m ? textOf(m[1]) : '';
  };
  const entryXml = /<entry[\s\S]*?<\/entry>/.exec(xml)?.[0] || xml;
  const epick = (tag) => {
    const m = new RegExp(String.raw`<(?:[\w.-]+:)?${tag}[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?${tag}>`).exec(entryXml);
    return m ? textOf(m[1]) : '';
  };
  const authors = [...entryXml.matchAll(/<(?:[\w.-]+:)?author[^>]*>[\s\S]*?<(?:[\w.-]+:)?name[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?name>/g)]
    .map((m) => textOf(m[1]));
  return {
    id: epick('id'),
    title: epick('title'),
    abstract: epick('summary'),
    authors,
    primaryCategory: /arxiv:primary_category[^>]*term="([^"]+)"/.exec(entryXml)?.[1] || '',
    categories: [...entryXml.matchAll(/<(?:[\w.-]+:)?category[^>]*term="([^"]+)"/g)].map((m) => m[1]),
    published: epick('published'),
    updated: epick('updated'),
    doi: epick('doi'),
    journal: epick('journal_ref'),
    comment: epick('comment')
  };
}

/** Human-facing header lines: "Authors: …" / "Categories: …" etc. Pure. */
export function formatArxivMeta(meta, urlVersion) {
  if (!meta || !meta.title) return '';
  // Atom's <id> is a full abs URL (http://arxiv.org/abs/2401.12345v2) —
  // display the bare paper ID (version kept when the API resolved one).
  const bareId = String(meta.id || '').replace(/^.*\/(abs|pdf)\//, '');
  const lines = [`arXiv: ${bareId}`.trimEnd()];
  if (meta.authors?.length) {
    const names = meta.authors.slice(0, 8).join(', ') + (meta.authors.length > 8 ? ', et al.' : '');
    lines.push(`Authors: ${names}`);
  }
  if (meta.primaryCategory || (meta.categories && meta.categories.length)) {
    lines.push(`Categories: ${[...new Set([meta.primaryCategory, ...(meta.categories || [])])].filter(Boolean).join(', ')}`);
  }
  if (meta.published) lines.push(`Published: ${meta.published.slice(0, 10)}`);
  if (urlVersion && meta.updated) lines.push(`Attached version: ${urlVersion} (latest: ${meta.updated.slice(0, 10)})`);
  if (meta.doi) lines.push(`DOI: ${meta.doi}`);
  if (meta.journal) lines.push(`Journal: ${meta.journal}`);
  if (meta.comment) lines.push(`Comments: ${meta.comment}`);
  return lines.join('\n');
}

/**
 * Fetch official metadata for an arXiv URL via the Atom API. Resolves null
 * for non-arXiv URLs, fetch failures, timeouts, and unparseable responses —
 * callers treat null as "attach without enrichment". fetchImpl is injectable
 * for tests; defaults to the extension-context global fetch
 * (host_permissions <all_urls> covers export.arxiv.org).
 */
export async function fetchArxivMeta(url, { timeoutMs = 6000, fetchImpl = fetch } = {}) {
  const parsed = arxivIdFromUrl(url);
  if (!parsed) return null;
  // Bare ID without the version: the API resolves latest either way, and the
  // URL's own version (if any) is reported separately in the header.
  const bareId = parsed.id.replace(/v\d+$/, '');
  const api = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bareId)}&max_results=1`;
  try {
    const res = await fetchImpl(api, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const meta = parseArxivAtomXml(await res.text());
    return meta && meta.title ? meta : null;
  } catch (_) {
    return null;
  }
}
