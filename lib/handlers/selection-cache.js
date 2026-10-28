// lib/handlers/selection-cache.js — the tabId → last-selection store (from
// selectionchange), one Map shared by the selectionchange listener, the
// SELECTION_CACHE/SELECTION_ACTION cases, the tab purge listeners and the
// ATTACH_PAGE 'selected' mode. Extracted from background.js (2026-10-28,
// ub-mode 体检 #6): the module-level Map used to live in the router file,
// which locked the attach handler — its second consumer — inside background.js.
// Consumers import this same instance; every call site stays `selectionCache.*`.
export const selectionCache = new Map();
