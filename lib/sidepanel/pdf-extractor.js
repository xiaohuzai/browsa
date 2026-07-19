// lib/sidepanel/pdf-extractor.js — client-side PDF text extraction via
// pdf.js, run here (not background.js) because pdf.js's getDocument() needs
// a real `window` (its worker-init code touches window.location) which the
// service worker doesn't have but this extension page does — same reasoning
// already established for lib/sidepanel/katex-worker-client.js's Worker.
//
// Ported idea from auditing firecrawl's PDF text extraction (server-side
// pdf-parse there); this is the from-scratch client-side equivalent, run
// entirely inside the extension with no backend.

let pdfLib = null;

async function getPdfLib() {
  if (pdfLib) return pdfLib;
  const mod = await import('../vendor/pdf.bundle.js');
  mod.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/vendor/pdf.worker.bundle.js');
  pdfLib = mod;
  return pdfLib;
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const DEFAULT_MAX_CHARS = 500_000;
const DEFAULT_MAX_PAGES = 300;

/**
 * Extract text from a base64-encoded PDF. Returns
 * {text, numPages, pagesRead, wasCapped}. Throws on any pdf.js failure
 * (corrupt/encrypted/unsupported PDF) — callers must catch and fall back to
 * the placeholder text; this function makes no attempt to degrade gracefully
 * itself, since sidepanel.js's caller already has an established fallback.
 */
export async function extractPdfText(base64, { maxChars = DEFAULT_MAX_CHARS, maxPages = DEFAULT_MAX_PAGES } = {}) {
  const lib = await getPdfLib();
  const doc = await lib.getDocument({ data: base64ToUint8Array(base64) }).promise;
  const numPages = doc.numPages;
  const pagesRead = Math.min(numPages, maxPages);
  const parts = [];
  let total = 0;
  for (let i = 1; i <= pagesRead; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(' ');
    parts.push(pageText);
    total += pageText.length;
    if (total > maxChars) break;
  }
  let text = parts.join('\n\n');
  const wasCapped = text.length > maxChars || pagesRead < numPages;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars ...]`;
  }
  return { text, numPages, pagesRead, wasCapped };
}

// A wasm result is only "usable" if it actually contains readable text —
// pdf-inspector's own pdfType classification is the signal plain pdf.js
// text-join has no equivalent of: a page genuinely classified 'Scanned' (no
// text layer at all) would otherwise silently send near-empty content to the
// model instead of falling through to a more useful fallback. Empirically
// (see test/lib-pdf-inspector-wasm.test.mjs), `pagesNeedingOcr` fires as a
// conservative low-confidence signal even on short-but-legitimately-extracted
// pages — it is NOT a reliable "extraction failed" signal on its own, so the
// gate deliberately does not key off it, only off the definitive pdfType and
// a genuinely-empty markdown result.
function isUsableWasmResult(result) {
  if (!result || typeof result.markdown !== 'string') return false;
  if (result.markdown.trim().length === 0) return false;
  if (result.pdfType === 'Scanned') return false;
  return true;
}

function isEmptyText(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}

/**
 * Primary PDF extraction path: pdf-inspector-wasm (full layout/table/heading
 * reconstruction, running in a Worker — see pdf-inspector-worker-client.js),
 * falling back to the plain-text pdf.js join (extractPdfText above) when the
 * worker is unavailable/times out or its result fails the usability check.
 * Never throws — the pdf.js fallback path is awaited directly, and only its
 * own failure propagates (matching extractPdfText's existing throw contract,
 * so sidepanel.js's caller needs no new catch logic).
 */
export async function extractPdfContent(base64, opts = {}) {
  const { maxChars = DEFAULT_MAX_CHARS } = opts;
  const bytes = base64ToUint8Array(base64);

  try {
    const { processPdfViaWorker } = await import('./pdf-inspector-worker-client.js');
    const response = await processPdfViaWorker(bytes, { profile: 'fidelity' });
    if (response?.ok && isUsableWasmResult(response.result)) {
      const r = response.result;
      let text = r.markdown;
      const wasCapped = text.length > maxChars;
      if (wasCapped) text = text.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars ...]`;
      return {
        text,
        numPages: r.pageCount,
        pagesRead: r.pageCount,
        wasCapped,
        viaWasm: true,
        pdfType: r.pdfType,
        confidence: r.confidence,
        pagesNeedingOcr: r.pagesNeedingOcr || []
      };
    }
  } catch (e) {
    console.warn('browsa: pdf-inspector-wasm extraction failed, falling back to pdf.js', e);
  }

  const legacy = await extractPdfText(base64, opts);
  // pdf.js doesn't throw on a page with no text layer -- it just joins an
  // empty string per page. Unlike a Mixed-type document (some real pages,
  // some scanned; partial text is still strictly useful and must NOT be
  // rejected here), a wholly-scanned PDF's legacy text comes back entirely
  // empty with no exception to trigger sidepanel.js's existing placeholder
  // fallback. Throwing here closes that gap using the same throw-based
  // contract extractPdfText's own docstring already establishes.
  if (isEmptyText(legacy.text)) {
    throw new Error('pdf.js extraction produced no text (likely a scanned/image-only PDF)');
  }
  return { ...legacy, viaWasm: false };
}
