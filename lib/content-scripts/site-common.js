// lib/content-scripts/site-common.js — the MAIN-world helpers shared by every
// site interceptor, injected as a SEPARATE content script immediately before
// each site script (same world, same document → globals are visible).
//
// Ten site scripts each carried a byte-identical `relayToHost` (post the
// structured payload to the ISOLATED relay via postMessage). One change to the
// wire shape had to be repeated ten times — the exact drift class that already
// killed this channel once during the v0.19.1 MAIN-world migration. The local
// copies are gone; manifest ordering (asserted by
// test/site-content-scripts.test.mjs) is what guarantees the global exists.
//
// Trust boundary is unchanged: the payload still crosses the page world, so
// the ISOLATED relay continues to treat it as page-controlled input.
(function () {
  if (window.__browsaRelayToHost) return;
  window.__browsaRelayToHost = function relayToHost(msg) {
    try {
      window.postMessage({ __browsaRelay: true, message: msg }, window.location.origin);
    } catch (_) { /* page navigated mid-post — nothing to deliver */ }
  };
})();
