// lib/readability-injector.js - injects the vendored Readability/Turndown/
// Turndown-GFM bundles into a tab's MAIN world before reader-mode extraction.
// Extracted out of page-extractor.js (along the same responsibility-split line
// as lib/site-synthesizers.js and lib/message-builder.js): this runs in the
// normal extension (service worker) context, NOT the page's MAIN world, so it
// has no "must be self-contained for chrome.scripting.executeScript"
// constraint. page-extractor.js keeps the MAIN-world extraction functions;
// library injection is a separate concern that belongs here.
//
// Injection mechanism (2026-10-17): chrome.scripting.executeScript with
// `files: [...]` in the MAIN world — NOT fetch + `(0, eval)(src)`.
//
// Why the change: indirect eval inside the injected function is subject to the
// PAGE's `script-src` policy. Sites with a strict CSP (GitHub and friends) do
// not allow `unsafe-eval`, so the eval threw, the injector reported failure,
// and reader/auto mode silently degraded to the DOM-tree dump while DOM-tree
// mode kept working (same page, different path — the hardest kind of bug to
// attribute). Injected FILES are exempt from page CSP, so the libraries now
// load everywhere. A second win: no 90KB×3 source strings crossing the
// extension↔page boundary per injection, and no module-level source cache in
// the service worker.
//
// The bundles are classic IIFE scripts (`var Readability = (function(){…})()`),
// so a top-level `var` in an injected classic script lands on window — the
// exact global extractInPageWorld probes (`typeof Readability`).

const VENDOR_FILES = {
  readability: 'lib/vendor/Readability.iife.js',
  turndown: 'lib/vendor/Turndown.iife.js',
  turndownGfm: 'lib/vendor/TurndownPluginGfm.iife.js',
};

/**
 * Inject Readability.js, Turndown.js, and the Turndown GFM plugin into the
 * page's MAIN world. Idempotent - probes `window.Readability`,
 * `window.TurndownService`, and `window.TurndownPluginGfm` first and injects
 * only the missing ones.
 *
 * The GFM plugin is optional garnish: unlike Readability/Turndown (required
 * for extraction at all), its failure must not break the overall call —
 * `extractInPageWorld` just renders plain (non-GFM) Markdown without it.
 */
export async function ensureReadabilityInjected(tabId) {
  let needReadability = true;
  let needTurndown = true;
  let needTurndownGfm = true;
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        readability: typeof Readability !== 'undefined',
        turndown: typeof TurndownService !== 'undefined',
        turndownGfm: typeof TurndownPluginGfm !== 'undefined'
      }),
      world: 'MAIN'
    });
    const r = probe?.result || {};
    if (r.readability && r.turndown && r.turndownGfm) return { injected: false, alreadyPresent: true };
    needReadability = !r.readability;
    needTurndown = !r.turndown;
    needTurndownGfm = !r.turndownGfm;
  } catch (_) {
    return { injected: false, error: 'probe failed' };
  }

  const required = [];
  if (needReadability) required.push(VENDOR_FILES.readability);
  if (needTurndown) required.push(VENDOR_FILES.turndown);
  const injected = [];
  try {
    if (required.length) {
      await chrome.scripting.executeScript({ target: { tabId }, files: required, world: 'MAIN' });
      if (needReadability) injected.push('Readability');
      if (needTurndown) injected.push('Turndown');
    }
    if (needTurndownGfm) {
      // Best-effort: a broken/stale GFM bundle must never take down the
      // required Readability/Turndown injection above.
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: [VENDOR_FILES.turndownGfm], world: 'MAIN' });
        injected.push('TurndownPluginGfm');
      } catch (_) { /* GFM tables/strikethrough/tasklists just won't render */ }
    }
    return { injected: true, libraries: injected };
  } catch (e) {
    console.warn('browsa: page library injection failed', e);
    return { injected: false, error: 'inject libs: ' + e.message };
  }
}
