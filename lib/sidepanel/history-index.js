// lib/sidepanel/history-index.js — the single owner of the hidx mirror: the
// sidepanel-local counter that mirrors storage's history array length, stamped
// onto every message bubble as data-hidx so delete/undo/truncate flows can
// address storage by index (2026-09-20 deepening pass, architecture-review
// candidate #6). Before this module the counter lived in sidepanel.js and
// every mutation path (attach, delete, undo, truncate, retry-edit, clear,
// reconcile) hand-rolled its own counter op, and every deletion hand-rolled
// the same "shift all bubbles above the removed index" loop — the drift this
// class of code is prone to is exactly what history-reconcile.js was born to
// audit (it once bit for real: the followups corruption bug). Mutate the
// mirror ONLY through these functions.
//
// The flat storage array itself stays owned by storage.js (deliberate — see
// AGENTS.md); this is the DOM-side mirror protocol only. history-reconcile.js
// remains the pure drift planner; reconcileHistoryIdx() in sidepanel.js drives
// it with hidxCurrent() and writes back via hidxResetTo()/DOM shift.

const messagesEl = () => document.getElementById('messages');

let nextHistoryIdx = 0;

/** Stamp the next storage index onto a bubble and advance the counter. */
export function hidxAssign(el) {
  el.dataset.hidx = String(nextHistoryIdx);
  nextHistoryIdx++;
  return nextHistoryIdx - 1;
}

/** Advance the counter without a bubble (background-stored turns arriving in bulk). */
export function hidxBump(n = 1) {
  nextHistoryIdx += n;
}

/** Retreat the counter (single-entry delete/undo). Deliberately NOT floored
 * at 0: the counter is a mirror — clamping would mask an unpaired decrement,
 * and reconcileHistoryIdx() exists to catch and correct exactly that drift. */
export function hidxDecrement(n = 1) {
  nextHistoryIdx -= n;
}

/** Overwrite the counter (truncate/retry-rewind/clear/renderHistory resync). */
export function hidxResetTo(v) {
  nextHistoryIdx = v;
}

export function hidxCurrent() {
  return nextHistoryIdx;
}

/**
 * After a CONFIRMED removal of storage index `removedIdx`: shift every DOM
 * bubble above that slot down by one, then decrement the counter. Call ONLY
 * after the storage write is verified (envelope data.ok) — shifting on a
 * failed removal misaligns every subsequent index.
 */
export function hidxShiftAfter(removedIdx) {
  for (const el of messagesEl().querySelectorAll('[data-hidx]')) {
    const bidx = parseInt(el.dataset.hidx, 10);
    if (bidx > removedIdx) el.dataset.hidx = String(bidx - 1);
  }
  hidxDecrement();
}
