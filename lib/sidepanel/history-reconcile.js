// lib/sidepanel/history-reconcile.js — decide what a nextHistoryIdx drift
// means before acting on it (pure, unit-tested; the DOM/storage side lives
// in sidepanel.js's reconcileHistoryIdx()).
//
// drift = nextHistoryIdx - storage.length > 0 has TWO causes with opposite
// correct responses:
//   1. Auto-trim removed entries from the FRONT (60-entry / 300K caps) —
//      every visible bubble's hidx must shift DOWN by drift.
//   2. A tail append never happened (typical: resolveProvider threw before
//      the user turn was stored — chat-handler.js) — the counter is simply
//      too high; shifting the DOM would desync EVERY delete/edit/regenerate.
// The old code always assumed (1). We distinguish them by anchoring on the
// lowest-hidx visible bubble: if its exact raw content still sits at its own
// storage index, nothing was trimmed (case 2); if it sits `drift` earlier,
// it was a real front-trim (case 1). When neither matches (missing raw,
// non-string content), we reset the counter only — with the delete path now
// verifying data.ok, a missed shift degrades to no-op deletes instead of
// corrupting them.

export function planHistoryReconcile({ entries, nextHistoryIdx, anchorH, anchorRaw }) {
  const actualLen = Array.isArray(entries) ? entries.length : nextHistoryIdx;
  const drift = nextHistoryIdx - actualLen;
  if (drift <= 0) return { action: 'none' };

  const match = (idx) => {
    const e = Array.isArray(entries) ? entries[idx] : null;
    if (!e || typeof anchorRaw !== 'string' || !anchorRaw) return false;
    if (typeof e.content === 'string') return e.content === anchorRaw;
    if (Array.isArray(e.content)) {
      const t = e.content.find(p => p && p.type === 'text')?.text;
      return typeof t === 'string' && t === anchorRaw;
    }
    return false;
  };

  const atOwn = anchorH >= 0 && match(anchorH);
  const atTrimmed = anchorH - drift >= 0 && match(anchorH - drift);
  if (atTrimmed && !atOwn) return { action: 'shift', drift, actualLen };
  return { action: 'reset', actualLen };
}
