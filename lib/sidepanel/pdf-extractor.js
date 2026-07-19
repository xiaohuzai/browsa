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
