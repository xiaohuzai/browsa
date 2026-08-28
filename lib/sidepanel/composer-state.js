// lib/sidepanel/composer-state.js — two small composer conveniences borrowed
// from Cherry Studio's composer:
//
// 1. Draft persistence — the unsent text survives side-panel reopen
//    (Chrome tears the panel DOM down aggressively on tab switches), stored
//    under one chrome.storage.local key alongside the input-history list.
// 2. Input history navigation — ↑/↓ walks the last N sent messages while the
//    caret sits at the boundary/empty/all-selected, exactly like a shell.
//    Leaving navigation restores the pre-navigation draft verbatim.

const KEY = 'composerState';
const HISTORY_MAX = 20;
let _hist = [];
let _navIdx = -1;          // -1 = not navigating
let _savedDraft = '';      // composer text captured when navigation started

function _storage() {
  try {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
  } catch (_) {
    return null;
  }
}

/** Record a sent message for ↑ recall. Consecutive duplicates collapse. */
export function pushInputHistory(text) {
  const t = String(text || '');
  if (!t.trim()) return;
  if (_hist[_hist.length - 1] === t) return;
  _hist.push(t);
  if (_hist.length > HISTORY_MAX) _hist = _hist.slice(-HISTORY_MAX);
  _persist();
}

/**
 * Try to consume an ArrowUp/ArrowDown keydown for history navigation.
 * Returns true when the event was handled (caller must preventDefault).
 * `isBlocked()` lets the caller veto (slash autocomplete open, IME composing…).
 */
export function handleHistoryNav(e, isBlocked = () => false) {
  if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.shiftKey || e.ctrlKey || e.metaKey) return false;
  if (isBlocked() || e.isComposing || !_hist.length) return false;

  const v = e.target.value ?? '';
  const sel = { s: e.target.selectionStart, e: e.target.selectionEnd };
  const allSelected = v !== '' && sel.s === 0 && sel.e === v.length;
  const atEnd = sel.s === v.length && sel.e === v.length;
  const atStart = sel.s === 0 && sel.e === 0;
  if (!(v === '' || allSelected || atEnd || atStart)) return false;

  if (e.key === 'ArrowUp') {
    if (_navIdx === -1) {
      _savedDraft = v;
      _navIdx = _hist.length - 1;
    } else if (_navIdx > 0) {
      _navIdx--;
    }
    e.target.value = _hist[_navIdx];
  } else { // ArrowDown
    if (_navIdx === -1) return false; // not navigating — leave ↓ alone
    _navIdx++;
    if (_navIdx >= _hist.length) {
      _exitNav(e.target);
    } else {
      e.target.value = _hist[_navIdx];
    }
  }
  // Caret to the end so continued typing appends naturally.
  const len = e.target.value.length;
  try { e.target.setSelectionRange(len, len); } catch (_) {}
  return true;
}

function _exitNav(target) {
  _navIdx = -1;
  target.value = _savedDraft;
}

export function resetHistoryNav(target) {
  if (_navIdx !== -1 && target) _exitNav(target);
}

// ─── Draft persistence ────────────────────────────────────────────────────────

let _saveTimer = null;

function _persist(immediate = false) {
  const store = _storage();
  if (!store) return;
  const write = () => store.set({ [KEY]: { draft: _lastText, history: _hist } }).catch(() => {});
  clearTimeout(_saveTimer);
  if (immediate) write();
  else _saveTimer = setTimeout(write, 400);
}

let _lastText = '';

/** Start watching the composer input; debounce-persists its value. */
export function attachDraftPersistence(inputEl) {
  inputEl.addEventListener('input', () => {
    _lastText = inputEl.value;
    resetHistoryNav(inputEl); // typing cancels any active ↑ recall
    _persist();
  });
}

/** Restore the persisted draft + history before the user starts typing. */
export async function restoreComposerState(inputEl) {
  const store = _storage();
  if (!store) return;
  let state = null;
  try {
    const got = await store.get(KEY);
    state = got?.[KEY];
  } catch (_) {
    return;
  }
  if (!state) return;
  if (Array.isArray(state.history)) {
    // Trust only strings; re-cap defensively (older writes may differ).
    _hist = state.history.filter((t) => typeof t === 'string').slice(-HISTORY_MAX);
  }
  const draft = typeof state.draft === 'string' ? state.draft : '';
  if (draft && !inputEl.value) {
    inputEl.value = draft;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Clear the persisted draft (successful send). Keeps the recall history. */
export function clearPersistedDraft() {
  _lastText = '';
  _persist(true);
}
