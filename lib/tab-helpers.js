// lib/tab-helpers.js — small tab/capture utilities shared by the extractor
// and the PDF/office attach pipelines.
//
// Extracted from lib/page-extractor.js (2026-10-17) to break the cycle that
// would otherwise appear when the fallback pipelines moved out: they need
// isPdfDocument, while page-extractor's cascade needs the pipelines. These
// four have no dependency on extraction state, so they are the natural seam.

/** The active tab in the last-focused window. */
export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/** Cheap check for whether a tab is currently rendering a PDF, for sites that omit ".pdf" from the URL. */
export async function isPdfDocument(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType === 'application/pdf',
      world: 'MAIN'
    });
    return !!res?.result;
  } catch (_) {
    return false;
  }
}

/** HEAD-check whether a URL serves a PDF — last-resort fallback when the in-page check misses. */
export async function checkContentTypeIsPdf(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return (resp.headers.get('content-type') || '').toLowerCase().includes('application/pdf');
  } catch (_) {
    return false;
  }
}

/** Screenshot the visible area of a tab as a JPEG data URL. */
export async function captureVisibleTab(tabId) {
  // chrome.tabs.captureVisibleTab requires <all_urls> or activeTab + scripting.
  // activeTab grants temporary host permission when user invokes the extension
  // (e.g. clicks the action button). Since this is called from a user gesture
  // (clicking "send"), activeTab should be sufficient.
  const tab = await chrome.tabs.get(tabId);
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
}
