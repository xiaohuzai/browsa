// lib/attach-modes.js — the single home for the attach-mode taxonomy and its
// capability matrix (2026-09-20 deepening pass, candidate #7 of the
// architecture review). Before this table, "which ctx.mode values get deep
// extraction / site instructions / image inlining" was answered by five
// separate inline .includes([...]) lists in background.js's ATTACH_PAGE case,
// and the deferred-storage handoff keys (mode + payload field + confirm
// message) were re-stated independently in background.js and
// attach-orchestrator.js — every new attach mode (see #144's office join)
// had to join all of them by hand. Same table-driven-dispatch pattern as
// background.js's SITE_MESSAGE_MAP. Pure data + tiny predicates, no chrome
// deps — importable from the service worker, the side panel, and tests.

// Per-mode capabilities. Absent key = false. Modes that never reach the
// storage tail (the *-pending handoffs) and pure URL placeholders don't need
// capability rows unless a check names them (e.g. the change-tracker skip
// list, which must keep covering the placeholder modes).
export const ATTACH_MODE_CAPS = {
  reader:       { deepExtract: true, siteInstructions: true, inlineImages: true },
  dom:          { deepExtract: true, siteInstructions: true },
  full:         { deepExtract: true, siteInstructions: true },
  auto:         { deepExtract: true, siteInstructions: true, inlineImages: true },
  jina:         { inlineImages: true },
  // selected is a partial excerpt (quick actions shouldn't pull in site
  // instructions); dom/full are tree text (no Markdown image syntax); jina is
  // a third-party proxy whose pages still carry inline images.
  selected:     { skipChangeTracking: true },
  screenshot:   { skipChangeTracking: true, deferred: { field: 'imageDataUrl', confirm: 'ATTACH_SCREENSHOT_CONFIRM' } },
  // Fixed placeholders, not real content — change detection would always
  // fire (or never mean anything) on them.
  'pdf-url':    { skipChangeTracking: true },
  'office-url': { skipChangeTracking: true },
  youtube:      { video: true },
  bilibili:     { video: true },
  // Deferred-storage handoffs: bytes fetched in-tab, history write deferred
  // until the sidepanel's conversion pipeline confirms via `confirm`.
  'pdf-pending':    { deferred: { field: 'pdfBase64', confirm: 'ATTACH_PDF_CONFIRM' } },
  'office-pending': { deferred: { field: 'officeBase64', confirm: 'ATTACH_OFFICE_CONFIRM' } },
  // asr-pending is deliberately NOT a table row: its handoff decision is
  // behavioral (needs all.asr settings + noTranscript/subtitleSource, see
  // background.js's ATTACH_PAGE case), not a pure mode capability.
};

export function modeCaps(mode) {
  return ATTACH_MODE_CAPS[mode] || {};
}

// The deferred-storage handoffs, in dispatch order (screenshot first, matching
// the original if-chain). `field` is the ctx payload whose presence gates the
// handoff. Consumed by background.js's ATTACH_PAGE early-returns and
// attach-orchestrator.js's mode dispatch — one list so a new deferred mode is
// one row here instead of two hand-synced if-statements in two files.
export const DEFERRED_HANDOFFS = [
  { mode: 'screenshot', field: 'imageDataUrl', confirm: 'ATTACH_SCREENSHOT_CONFIRM' },
  { mode: 'pdf-pending', field: 'pdfBase64', confirm: 'ATTACH_PDF_CONFIRM' },
  { mode: 'office-pending', field: 'officeBase64', confirm: 'ATTACH_OFFICE_CONFIRM' },
];
