// lib/sidepanel/composer-state.js — two small composer conveniences borrowed
// from Cherry Studio's composer:
//
// 1. Draft persistence — the unsent text survives side-panel reopen
//    (Chrome tears the panel DOM down aggressively on tab switches), stored
//    under one chrome.storage.local key alongside the input-history list.
// 2. Input history navigation — ↑/↓ walks the last N sent messages while the
//    caret sits at the boundary/empty/all-selected, exactly like a shell.
//    Leaving navigation restores the pre-navigation draft verbatim.
//
// The module-level exports below are the MAIN composer's scope. Other input
// surfaces get their OWN scope via createInputHistory() — detail-thread cards
// keep a separate recall list from the main chat, so ↑ in a card recalls
// previous follow-up questions, never main-composer sends.

const KEY = 'composerState';
const HISTORY_MAX = 20;

function _storage() {
  try {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
  } catch (_) {
    return null;
  }
}

/**
 * One recall scope: a sent-messages list + per-input walk state + its own
 * persistence. Scopes are fully independent (list, walk positions, storage
 * row) — create one per input surface so histories never bleed across.
 *
 * In-progress walk state is PER-INPUT (a WeakMap keyed by the input element,
 * holding `{idx, savedDraft}`): an armed walk must never leak its position or
 * pre-nav draft into another input, and a closed card's stale walk dies with
 * its detached element.
 *
 * `persistPayload` lets a scope carry extra fields in its storage row — the
 * main composer's row is `{draft, history}` (draft persistence rides along).
 */
export function createInputHistory({ storageKey = null, persistPayload = null } = {}) {
  let hist = [];
  const nav = new WeakMap();
  let timer = null;

  function persist(immediate = false) {
    const store = _storage();
    if (!store || !storageKey) return;
    const write = () => store
      .set({ [storageKey]: persistPayload ? persistPayload(hist) : { history: hist } })
      .catch(() => {});
    clearTimeout(timer);
    if (immediate) write(); else timer = setTimeout(write, 400);
  }

  /** Record a sent message for ↑ recall. Consecutive duplicates collapse. */
  function pushInputHistory(text) {
    const t = String(text || '');
    if (!t.trim()) return;
    if (hist[hist.length - 1] === t) return;
    hist.push(t);
    if (hist.length > HISTORY_MAX) hist = hist.slice(-HISTORY_MAX);
    persist();
  }

  /**
   * Try to consume an ArrowUp/ArrowDown keydown for history navigation.
   * Returns true when the event was handled (caller must preventDefault).
   * `isBlocked()` lets the caller veto (slash autocomplete open, IME composing…).
   */
  function handleHistoryNav(e, isBlocked = () => false) {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.shiftKey || e.ctrlKey || e.metaKey) return false;
    // keyCode 229: the process-key code some IME drivers report on every
    // keydown while composing — same belt-and-braces as ui-utils's
    // isImeComposing (kept inline; this module stays dependency-free).
    if (isBlocked() || e.isComposing || e.keyCode === 229 || !hist.length) return false;

    const v = e.target.value ?? '';
    const sel = { s: e.target.selectionStart, e: e.target.selectionEnd };
    const allSelected = v !== '' && sel.s === 0 && sel.e === v.length;
    const atEnd = sel.s === v.length && sel.e === v.length;
    const atStart = sel.s === 0 && sel.e === 0;
    if (!(v === '' || allSelected || atEnd || atStart)) return false;

    const st = nav.get(e.target);
    if (e.key === 'ArrowUp') {
      if (!st) nav.set(e.target, { idx: hist.length - 1, savedDraft: v });
      else if (st.idx > 0) st.idx--;
      e.target.value = hist[nav.get(e.target).idx];
    } else { // ArrowDown
      if (!st) return false; // not navigating — leave ↓ alone
      st.idx++;
      if (st.idx >= hist.length) {
        _exitNav(e.target);
      } else {
        e.target.value = hist[st.idx];
      }
    }
    // Caret to the end so continued typing appends naturally.
    const len = e.target.value.length;
    try { e.target.setSelectionRange(len, len); } catch (_) {}
    return true;
  }

  function _exitNav(target) {
    target.value = nav.get(target).savedDraft;
    nav.delete(target);
  }

  function resetHistoryNav(target) {
    if (target && nav.has(target)) _exitNav(target);
  }

  /**
   * Pull the persisted list back in (panel init). Returns the raw storage row
   * so callers with extra fields (the main composer's draft) can read those too.
   */
  async function loadInputHistory() {
    const store = _storage();
    if (!store || !storageKey) return null;
    let state = null;
    try {
      const got = await store.get(storageKey);
      state = got?.[storageKey];
    } catch (_) {
      return null;
    }
    if (state && Array.isArray(state.history)) {
      // Trust only strings; re-cap defensively (older writes may differ).
      hist = state.history.filter((t) => typeof t === 'string').slice(-HISTORY_MAX);
    }
    return state;
  }

  return { pushInputHistory, handleHistoryNav, resetHistoryNav, loadInputHistory, persist };
}

// ─── Main composer scope (the module-level exports sidepanel.js imports) ─────

let _lastText = '';

const main = createInputHistory({
  storageKey: KEY,
  // One row carries the draft + the recall list, as it always has.
  persistPayload: (hist) => ({ draft: _lastText, history: hist }),
});

export const pushInputHistory = main.pushInputHistory;
export const handleHistoryNav = main.handleHistoryNav;
export const resetHistoryNav = main.resetHistoryNav;

/** Start watching the composer input; debounce-persists its value. */
export function attachDraftPersistence(inputEl) {
  inputEl.addEventListener('input', () => {
    _lastText = inputEl.value;
    main.resetHistoryNav(inputEl); // typing cancels any active ↑ recall
    main.persist();
  });
}

/** Restore the persisted draft + history before the user starts typing. */
export async function restoreComposerState(inputEl) {
  const state = await main.loadInputHistory();
  if (!state) return;
  const draft = typeof state.draft === 'string' ? state.draft : '';
  if (draft && !inputEl.value) {
    inputEl.value = draft;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Clear the persisted draft (successful send). Keeps the recall history. */
export function clearPersistedDraft() {
  _lastText = '';
  main.persist(true);
}
