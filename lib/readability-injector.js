// lib/readability-injector.js - injects the vendored Readability/Turndown/
// Turndown-GFM bundles into a tab's MAIN world before reader-mode extraction.
// Extracted out of page-extractor.js (along the same responsibility-split line
// as lib/site-synthesizers.js and lib/message-builder.js): this runs in the
// normal extension (service worker) context, NOT the page's MAIN world, so it
// has no "must be self-contained for chrome.scripting.executeScript"
// constraint. page-extractor.js keeps the MAIN-world extraction functions;
// library injection is a separate concern that belongs here.
//
// Module-level source cache: the service worker stays alive across multiple
// tabs/injections, so we fetch each bundle at most once per service-worker
// lifetime instead of hitting the extension's file system on every new tab.
// Both files are ~90KB; caching them shaves a disk-read round-trip on every
// reader-mode extraction after the first.
let _readabilitySrcCache = null;
let _turndownSrcCache = null;
let _turndownGfmSrcCache = null;

async function getVendorSrc(name, cacheRef) {
  if (cacheRef.value) return cacheRef.value;
  const src = await fetch(chrome.runtime.getURL(`lib/vendor/${name}`)).then((r) => r.text());
  cacheRef.value = src;
  return src;
}

/**
 * Inject Readability.js, Turndown.js, and the Turndown GFM plugin into the
 * page's MAIN world. Idempotent - checks `window.Readability`,
 * `window.TurndownService`, and `window.TurndownPluginGfm` first.
 * Readability/Turndown are bundled as ESM and patched with `export` lines; we
 * strip the exports before injecting as classic scripts via `(0, eval)(src)`.
 * The GFM plugin is treated as optional best-effort "garnish" - unlike
 * Readability/Turndown (required for extraction to work at all), a failure to
 * load it must not break `ensureReadabilityInjected`'s overall promise;
 * `extractInPageWorld` just renders plain (non-GFM) Markdown if it's absent.
 * Library sources are cached in service-worker memory after the first fetch.
 */
export async function ensureReadabilityInjected(tabId) {
  // Quick check: are they already there?
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

  // Inject only the libraries that are missing. Sources are loaded from the
  // module-level cache (populated on first use) to avoid redundant disk reads.
  // The vendored IIFE bundles are evaluated in the page's MAIN world via
  // indirect eval; they self-assign to a script-level `var Readability` /
  // `var TurndownService`, so the constructor lives on the eval's global
  // object. We pluck it off and bind it to window.
  const rdCacheRef = { get value() { return _readabilitySrcCache; }, set value(v) { _readabilitySrcCache = v; } };
  const tdCacheRef = { get value() { return _turndownSrcCache; }, set value(v) { _turndownSrcCache = v; } };
  const gfmCacheRef = { get value() { return _turndownGfmSrcCache; }, set value(v) { _turndownGfmSrcCache = v; } };
  try {
    const [readabilitySrc, turndownSrc, turndownGfmSrc] = await Promise.all([
      needReadability ? getVendorSrc('Readability.iife.js', rdCacheRef) : null,
      needTurndown ? getVendorSrc('Turndown.iife.js', tdCacheRef) : null,
      // Best-effort: the GFM plugin is a nice-to-have, so a fetch failure
      // here must not abort Readability/Turndown injection.
      needTurndownGfm ? getVendorSrc('TurndownPluginGfm.iife.js', gfmCacheRef).catch(() => null) : null
    ]);

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (rdSrc, tdSrc, gfmSrc) => {
        if (rdSrc) {
          // eslint-disable-next-line no-eval
          (0, eval)(rdSrc);
          const rGlobal = (0, eval)('Readability');
          // The bundle assigns `var Readability = ...` at script scope, which
          // lands on the indirect-eval's global object (not the IIFE local),
          // and its CJS entry does `module.exports = Readability` directly (the
          // constructor itself, no .Readability/.default wrapper) -- so the old
          // `rGlobal.Readability || rGlobal.default` chain silently resolved to
          // undefined against this bundle, clobbering the correct constructor
          // that the `var` already set, and extractInPageWorld then saw
          // typeof Readability === 'undefined' and errored (auto mode fell
          // through to DOM-tree -- the pi.dev attach bug). Falling back to
          // rGlobal itself keeps both wrapper and bare-constructor shapes
          // working, exactly like the Turndown branch below.
          window.Readability = rGlobal.Readability || rGlobal.default || rGlobal;
        }
        if (tdSrc) {
          // eslint-disable-next-line no-eval
          (0, eval)(tdSrc);
          // The bundle assigns `var TurndownService = ...` at script scope, which
          // lands on the indirect-eval's global object (not the IIFE local).
          const tGlobal = (0, eval)('TurndownService');
          // turndown's CJS entry does `module.exports = TurndownService` directly
          // (the constructor itself, no .TurndownService/.default wrapper) as of
          // 7.2.4 - a real regression found while rebuilding this bundle for the
          // GFM plugin: the old `tGlobal.TurndownService || tGlobal.default` chain
          // silently resolved to undefined against a freshly-built bundle. Falling
          // back to tGlobal itself keeps both shapes working.
          window.TurndownService = tGlobal.TurndownService || tGlobal.default || tGlobal;
        }
        if (gfmSrc) {
          // Optional - swallow any eval failure so a broken/stale GFM bundle
          // never takes down the required Readability/Turndown injection.
          try {
            // eslint-disable-next-line no-eval
            (0, eval)(gfmSrc);
            window.TurndownPluginGfm = (0, eval)('TurndownPluginGfm');
          } catch (_) { /* GFM tables/strikethrough/tasklists just won't render */ }
        }
      },
      args: [readabilitySrc, turndownSrc, turndownGfmSrc],
      world: 'MAIN'
    });
    const injected = [needReadability && 'Readability', needTurndown && 'Turndown', needTurndownGfm && turndownGfmSrc && 'TurndownPluginGfm'].filter(Boolean);
    return { injected: true, libraries: injected };
  } catch (e) {
    console.warn('browsa: page library injection failed', e);
    return { injected: false, error: 'inject libs: ' + e.message };
  }
}
