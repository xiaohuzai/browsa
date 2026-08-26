// lib/feishu-extractor.js — Feishu / Lark document extraction.
//
// Feishu (飞书 / Lark) document pages are Slate-based rich-text editors that
// virtual-scroll: only blocks near the viewport are materialized as DOM
// nodes, distant blocks collapse into empty `.bear-virtual-renderUnit-placeholder`s,
// and tables can span several virtual "pages". The generic Readability →
// Turndown pipeline flattens tables into a jumble of cell texts and silently
// misses any lazy-rendered content (see the feishu-doc-crawler research:
// conventional crawlers get "empty tables, missing sections, broken structure").
//
// Design — mirroring how lark-cli's `docs +fetch` renders feishu's block model
// (text / heading / list / code / quote / callout / table …) to clean output:
//   1. Identify feishu block roots by their DOM signatures:
//      `data-block-type` (modern editor) and `.docx-*` classes (classic/embed
//      renderer), plus structural tags (<table>, <h1-6>, <ul>, <ol>, <pre>…).
//   2. Scroll the feishu virtual container stepwise (bounded) so lazy-rendered
//      blocks materialize, collecting each block's Markdown at every step.
//      Block identity is `data-block-id` (or a DOM-path fallback), so tables
//      that materialize row-by-row across steps keep their longest render.
//   3. Render each block to Markdown — crucially preserving <table> structure
//      (row/column alignment) that textContent/innerText would destroy.
//
// Fail-open: if the page isn't feishu, or extraction yields too little, the
// caller falls through to the generic pipeline.
//
// extractFeishuInPageWorld runs in the page's MAIN world via
// chrome.scripting.executeScript's `func:` form, so it is fully self-contained
// (all helpers nested) per the countImages MAIN-world lesson from
// page-extractor.js — executeScript serializes ONLY the passed function body.
// The service-worker-side coordinator (tryFeishuExtraction) and the URL guard
// (isFeishuDocUrl) run in the normal extension context.

const FEISHU_HOST_RE = /(^|\.)(feishu\.cn|larksuite\.com)$/i;
const FEISHU_DOC_PATH_RE = /\/(docx|wiki)\//;

/**
 * Cheap URL guard used by extractActiveTab to decide whether to attempt the
 * feishu fast path at all. Kept loose (host + docx/wiki path); the in-page
 * extractor does the authoritative DOM-signature check.
 */
export function isFeishuDocUrl(url) {
  try {
    const u = new URL(url);
    if (!FEISHU_HOST_RE.test(u.hostname)) return false;
    return FEISHU_DOC_PATH_RE.test(u.pathname);
  } catch (_) {
    return false;
  }
}

/**
 * Runs in the tab's MAIN world. Scans the feishu document block DOM, scrolls
 * the virtual container to materialize lazy blocks, and renders clean
 * Markdown (tables preserved). Returns { text, articleTitle, ... } or
 * { error } so the caller can fall through to the generic pipeline.
 */
async function extractFeishuInPageWorld({ htmlCap }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // Collapse whitespace but keep a single space; feishu leaves join without
  // spaces (each `[data-string]` leaf is one inline run).
  const inlineText = (s) => (s || '').replace(/[ \t\r\n]+/g, ' ').trim();

  // Authoritative text carrier in feishu's slate DOM is `[data-string="true"]`
  // leaves. Fall back to textContent when none are present.
  function leafText(el) {
    if (!el) return '';
    let out = '';
    try {
      const leaves = el.querySelectorAll && el.querySelectorAll('[data-string="true"]');
      if (leaves && leaves.length) {
        for (const leaf of leaves) out += leaf.textContent || '';
        return inlineText(out);
      }
    } catch (_) { /* ignore */ }
    return inlineText(el.textContent || '');
  }

  // Cell text: a cell can hold several slate zones (e.g. a paragraph plus a
  // nested list), so collect ALL zones in DOM order. Multi-line cells are kept
  // as `<br>` (markdown table cells can't hold raw newlines). Escapes pipes so
  // a literal `|` in a cell can't break the markdown column layout.
  function cellText(td) {
    let text = '';
    try {
      const zones = td.querySelectorAll && td.querySelectorAll('[data-slate-editor], [data-zone-container], .docx-text-block');
      if (zones && zones.length) {
        for (const z of zones) {
          const t = leafText(z);
          if (t) text += (text ? '\n' : '') + t;
        }
      } else {
        text = leafText(td);
      }
    } catch (_) {
      text = leafText(td);
    }
    return text.replace(/\n/g, '<br>').replace(/\|/g, '\\|');
  }

  // A "block signature" identifies feishu content blocks in either DOM form.
  // Returns a canonical type string, or null for non-block elements.
  function signature(el) {
    if (!el || !el.getAttribute) return null;
    const bt = el.getAttribute('data-block-type') || '';
    if (bt) {
      const b = bt.toLowerCase();
      if (b === 'heading') return 'heading1';
      if (/^heading[1-9]$/.test(b)) return b; // heading1..heading9
      if (b === 'table' || b === 'table_cell') return 'table';
      if (b === 'divider') return 'divider';
      if (b === 'code') return 'code';
      if (b === 'quote') return 'quote';
      if (b === 'callout') return 'callout';
      if (b === 'bullet' || b === 'bullet_list') return 'bullet';
      if (b === 'ordered' || b === 'ordered_list' || b === 'numbered' || b === 'number_list') return 'ordered';
      if (b === 'todo' || b === 'task') return 'bullet';
      if (b === 'media' || b === 'file' || b === 'image' || b === 'attachment') return 'media';
      return 'text'; // text, embed, etc. — render as paragraph
    }
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls.includes('docx-table-block')) return 'table';
    if (cls.includes('docx-text-block') || cls.includes('docx-paragraph')) return 'text';
    if (cls.includes('docx-code-block')) return 'code';
    if (cls.includes('docx-quote-block')) return 'quote';
    if (cls.includes('docx-callout-block')) return 'callout';
    if (cls.includes('docx-divider')) return 'divider';
    if (cls.includes('docx-bullet-block')) return 'bullet';
    if (cls.includes('docx-list-block')) return 'ordered';
    if (cls.includes('docx-heading')) {
      const m = cls.match(/docx-heading(\d)/);
      return 'heading' + (m ? m[1] : '1');
    }
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'table') return 'table';
    if (/^h[1-6]$/.test(tag)) return tag;
    if (tag === 'ul') return 'bullet';
    if (tag === 'ol') return 'ordered';
    if (tag === 'pre' || tag === 'code') return 'code';
    if (tag === 'blockquote') return 'quote';
    if (tag === 'hr') return 'divider';
    return null;
  }

  function domPathKey(el, root) {
    const parts = [];
    let node = el;
    while (node && node !== root && node !== document.body && node !== document.documentElement) {
      let idx = 0;
      let sib = node.previousElementSibling;
      while (sib) { idx++; sib = sib.previousElementSibling; }
      parts.unshift((node.tagName || 'x').toLowerCase() + '[' + idx + ']');
      node = node.parentNode;
    }
    return parts.join('/');
  }

  // Top-level block roots: elements with a signature that are NOT nested
  // inside another block root (table cells / nested zones are handled by
  // their table / parent block renderer).
  function collectTopLevelBlocks(rootDoc) {
    const blocks = [];
    const all = [];
    try {
      const walker = rootDoc.createTreeWalker(rootDoc.body || rootDoc, 1 /* ELEMENT */);
      while (walker.nextNode()) all.push(walker.currentNode);
    } catch (_) {
      const q = rootDoc.querySelectorAll && rootDoc.querySelectorAll('*');
      if (q) for (const el of q) all.push(el);
    }
    for (const el of all) {
      if (!signature(el)) continue;
      // Is el nested inside another block root (excluding itself)?
      let parent = el.parentNode;
      let nested = false;
      while (parent && parent.nodeType === 1 && parent !== (rootDoc.body || rootDoc)) {
        if (signature(parent) && parent !== el) { nested = true; break; }
        parent = parent.parentNode;
      }
      if (!nested) blocks.push(el);
    }
    return blocks;
  }

  function headingLevel(type) {
    const m = String(type).match(/(\d)/);
    const n = m ? parseInt(m[1], 10) : 1;
    return Math.min(6, Math.max(1, n));
  }

  function renderTable(tbl) {
    const rows = [];
    try {
      // Modern editor uses semantic <tr>/<td>; some builds render div-based
      // rows/cells with data-block-type markers. Support both.
      const trs = tbl.querySelectorAll('tr').length
        ? tbl.querySelectorAll('tr')
        : tbl.querySelectorAll('[data-block-type="table_row"]');
      for (const tr of trs) {
        const cellEls = tr.querySelectorAll('td, th').length
          ? tr.querySelectorAll('td, th')
          : tr.querySelectorAll('[data-block-type="table_cell"]');
        const cells = [];
        for (const td of cellEls) cells.push(cellText(td));
        if (cells.some((c) => c)) rows.push(cells);
      }
    } catch (_) { /* malformed table */ }
    if (!rows.length) return '';
    const cols = Math.max.apply(null, rows.map((r) => r.length));
    const pad = (r) => {
      const out = r.slice(0, cols);
      while (out.length < cols) out.push('');
      return out;
    };
    // Feishu tables virtually always have a header row (first <tr>); treat it
    // as the markdown header + separator.
    const header = pad(rows[0]);
    const lines = [];
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
    for (let i = 1; i < rows.length; i++) {
      lines.push('| ' + pad(rows[i]).join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  function renderBlock(el) {
    const type = signature(el);
    if (!type) return '';
    const tag = (el.tagName || '').toLowerCase();
    if (type === 'table') return renderTable(el);
    if (type === 'divider' || tag === 'hr') return '---';
    if (type === 'media') {
      const img = el.querySelector && el.querySelector('img[src], img[data-src], a[href]');
      if (img) {
        const src = img.getAttribute && (img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('href') || '');
        const alt = norm(img.getAttribute && img.getAttribute('alt'));
        return src && src.startsWith('http') ? `![${alt || '图片'}](${src})` : (alt ? `[图片] ${alt}` : '[图片]');
      }
      return '[媒体]';
    }
    if (type === 'code') {
      const t = (el.textContent || '').replace(/\s+$/, '');
      return '```\n' + t + '\n```';
    }
    const text = leafText(el);
    if (!text) return '';
    // Direct block-like children (classic renderer nests `.docx-bullet-block`
    // items inside a `.docx-list-block`, quote items inside `.docx-quote-block`).
    const kids = [];
    try {
      if (el.children) {
        for (const c of el.children) {
          if (signature(c) || (c.tagName || '').toLowerCase() === 'li') kids.push(c);
        }
      }
    } catch (_) { /* ignore */ }
    if (type === 'quote' || type === 'callout') {
      if (kids.length) {
        return kids.map((k) => renderBlock(k)).join('\n').split('\n').map((l) => '> ' + l).join('\n');
      }
      return text.split('\n').map((l) => '> ' + l).join('\n');
    }
    if (type === 'bullet' || type === 'ordered') {
      if (kids.length) {
        // Decide each item's prefix from ITS OWN signature: a `.docx-list-block`
        // container may hold bullet items, ordered items, or a mix.
        let n = 1;
        return kids.map((k) => {
          const kt = signature(k) || '';
          if (kt === 'ordered' || kt === 'ordered_list' || kt === 'numbered' || kt === 'number_list') {
            return (n++) + '. ' + norm(leafText(k));
          }
          return '- ' + norm(leafText(k));
        }).join('\n');
      }
      return (type === 'ordered' ? '1. ' : '- ') + text;
    }
    if (/^heading/.test(type) || /^h[1-6]$/.test(type)) {
      return '#'.repeat(headingLevel(type)) + ' ' + text;
    }
    return text;
  }

  // Locate the feishu virtual-scroll container (if any) so we can materialize
  // lazy blocks. Feishu names its content scroller with `bear-web-x-*`; fall
  // back to the first real scrollable element holding blocks, else nothing.
  function findScroller() {
    try {
      const candidates = document.querySelectorAll('[class*="bear-web-x-"], [class*="bear-render"], [class*="docx-"]');
      for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight + 50) return el;
      }
    } catch (_) { /* ignore */ }
    try {
      const q = document.querySelectorAll('[data-block-type]');
      const holders = new Set();
      for (const el of q) {
        let p = el.parentNode;
        while (p && p.nodeType === 1 && p !== document.body) {
          if (p.scrollHeight > p.clientHeight + 50) { holders.add(p); break; }
          p = p.parentNode;
        }
      }
      for (const h of holders) return h;
    } catch (_) { /* ignore */ }
    return null;
  }

  // ---- Phase 1: materialize lazy blocks by scrolling ----
  // Collect each block's markdown at every scroll step, keyed by a stable id.
  // Text blocks are atomic (one render suffices); tables materialize row-by-row
  // across steps, so we keep the longest render for each key.
  const scroller = findScroller();
  let via = 'direct';
  const collected = new Map(); // key -> { order, md }
  let order = 0;
  const snapshot = () => {
    const docs = [document];
    try {
      for (const frame of document.querySelectorAll('iframe')) {
        const d = frame.contentDocument;
        if (d && d.body) docs.push(d);
      }
    } catch (_) { /* cross-origin — expected */ }
    for (const doc of docs) {
      for (const el of collectTopLevelBlocks(doc)) {
        const id = el.getAttribute && (el.getAttribute('data-block-id') || el.getAttribute('data-record-id'));
        const key = id || domPathKey(el, doc);
        const md = renderBlock(el);
        if (!md || !md.trim()) continue;
        const prev = collected.get(key);
        if (!prev) {
          collected.set(key, { order: order++, md });
        } else if (md.length > prev.md.length) {
          prev.md = md; // tables: keep the most-complete render
        }
      }
    }
  };

  snapshot();
  if (scroller) {
    via = 'scroll';
    const vh = Math.max(scroller.clientHeight, 600);
    let prevTop = -1;
    let stall = 0;
    for (let i = 0; i < 30; i++) {
      scroller.scrollTop += vh;
      await sleep(80);
      snapshot();
      if (scroller.scrollTop === prevTop) {
        stall++;
        if (stall >= 2) break; // reached bottom (no more content)
      } else {
        stall = 0;
        prevTop = scroller.scrollTop;
      }
      if (scroller.scrollTop + vh >= scroller.scrollHeight) break;
    }
    // Return to the top so the user isn't left mid-document.
    scroller.scrollTop = 0;
    await sleep(120);
  }

  // ---- Phase 2: assemble in DOM-ish order ----
  const parts = Array.from(collected.values())
    .sort((a, b) => a.order - b.order)
    .map((v) => v.md);
  let markdown = parts.join('\n\n');

  const stripZeroWidth = (s) => (s || '')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  markdown = stripZeroWidth(markdown).trim();

  if (!markdown || markdown.length < 30) {
    return {
      error: 'feishu: no block content found (' + (collected.size || 0) + ' blocks, ' + (markdown || '').length + ' chars)',
      collected: collected.size || 0
    };
  }

  const wasCapped = markdown.length > htmlCap;
  if (wasCapped) markdown = markdown.slice(0, htmlCap) + '\n\n[... truncated ...]';

  return {
    text: markdown,
    articleTitle: document.title || '',
    rawTextLength: markdown.length,
    wasCapped,
    feishuBlocks: collected.size,
    feishuTables: parts.filter((p) => p.startsWith('| ')).length,
    feishuVia: via
  };
}

/**
 * Service-worker-side coordinator. Runs the in-page extractor for feishu doc
 * URLs and, on success, stamps `result` with the structured markdown. Returns
 * the result or null (fail-open to the generic cascade).
 */
export async function tryFeishuExtraction(tab, meta, textCap, result) {
  if (!isFeishuDocUrl(tab.url || '')) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractFeishuInPageWorld,
      args: [{ htmlCap: textCap }],
      world: 'MAIN'
    });
    const feishu = res?.result || {};
    if (feishu.error) {
      console.warn('browsa: feishu extractor:', feishu.error);
      return null;
    }
    const text = feishu.text || '';
    if (text.length < 30) {
      console.warn('browsa: feishu extractor too little content (' + text.length + ' chars), falling back');
      return null;
    }
    result.text = text;
    result.articleTitle = feishu.articleTitle || meta.title || '';
    result.autoMode = 'feishu';
    result.feishuSource = true;
    result.feishuVia = feishu.feishuVia || 'direct';
    result.feishuBlocks = feishu.feishuBlocks || 0;
    result.truncated = {
      rawTextLength: feishu.rawTextLength || text.length,
      textLength: text.length,
      wasCapped: !!feishu.wasCapped,
      textCap
    };
    console.log(`browsa: feishu extractor OK via=${result.feishuVia} blocks=${result.feishuBlocks} tables=${feishu.feishuTables || 0} chars=${text.length}`);
    return result;
  } catch (e) {
    console.warn('browsa: feishu extractor threw, falling back to generic', e);
    return null;
  }
}
