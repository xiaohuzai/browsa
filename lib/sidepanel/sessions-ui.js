// lib/sidepanel/sessions-ui.js — sessions drawer (list/rename/export/delete/load),
// extracted verbatim from sidepanel.js (Phase 3 of the modularization
// refactor).
//
// A few functions here (loadSession) need to reach back into sidepanel.js-
// owned state (the active stream controller, renderHistory, the pending
// image-attachment strip) — those are injected once via initSessionsUI()
// from sidepanel.js's init(), rather than imported back from sidepanel.js
// (which would create a module cycle).

import { PAGE_CONTEXT_PREFIX } from '../constants.js';
import { ICONS } from './icons.js';
import { $, escM, showToast, showConfirmDialog, sendMessage } from './ui-utils.js';

let _deps = { cancelActiveStream: () => {}, renderHistory: async () => {}, scrollToBottom: () => {}, clearPendingImages: () => {} };
export function initSessionsUI(deps) {
  _deps = { ..._deps, ...deps };
}

function relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Lazily resolved so we're guaranteed the DOM is ready when first used.
export function getSessionsDrawer() { return document.getElementById('sessions-drawer'); }

let _sessionsBackdrop = null;
function getOrCreateBackdrop() {
  if (!_sessionsBackdrop) {
    _sessionsBackdrop = document.createElement('div');
    _sessionsBackdrop.className = 'sessions-backdrop';
    _sessionsBackdrop.addEventListener('click', closeSessionsDrawer);
    document.body.appendChild(_sessionsBackdrop);
  }
  return _sessionsBackdrop;
}

let _sessionsFilter = '';
let _renameClickTimer = null; // debounce: distinguish single-click-load from double-click-rename
let _sessionsRenderGen = 0;   // generation counter: cancel stale concurrent renders
let _searchDebounceTimer = null;

export function openSessionsDrawer() {
  const el = getSessionsDrawer();
  if (!el) return;
  el.hidden = false;
  getOrCreateBackdrop().classList.add('active');
  // Reset search filter and clear the input each time drawer opens
  _sessionsFilter = '';
  const searchEl = el.querySelector('.sessions-search');
  if (searchEl) searchEl.value = '';
  renderSessionsList();
}

export function onSessionSearch(e) {
  _sessionsFilter = e.target.value;
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(renderSessionsList, 200);
}

export function closeSessionsDrawer() {
  const el = getSessionsDrawer();
  if (el) el.hidden = true;
  if (_sessionsBackdrop) _sessionsBackdrop.classList.remove('active');
  clearTimeout(_renameClickTimer);   // cancel any pending single-click load
  _renameClickTimer = null;
  clearTimeout(_searchDebounceTimer); // cancel pending search render on close
  _searchDebounceTimer = null;
}

// Localized string with EN fallback (chrome.i18n is absent in jsdom tests).
function _msg(key, fallback) {
  return (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
}

// Time buckets for the unfiltered list. Boundaries are local midnights so
// "today"/"yesterday" mean what the user means, not UTC windows.
function bucketOf(ts) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  if (ts >= t0) return 'today';
  if (ts >= t0 - 86_400_000) return 'yesterday';
  if (ts >= t0 - 6 * 86_400_000) return 'week';
  return 'earlier';
}

const TIME_BUCKETS = [
  { id: 'today', labelKey: 'sessionsToday', fallback: 'Today' },
  { id: 'yesterday', labelKey: 'sessionsYesterday', fallback: 'Yesterday' },
  { id: 'week', labelKey: 'sessionsWeek', fallback: 'This week' },
  { id: 'earlier', labelKey: 'sessionsEarlier', fallback: 'Earlier' },
];

export async function renderSessionsList() {
  const listEl = $('sessions-list');
  if (!listEl) return;
  const gen = ++_sessionsRenderGen;
  listEl.innerHTML = '';
  // Search runs server-side (GET_SESSIONS q): names AND message content,
  // pinned-first ordering included. The drawer never sees full histories.
  const q = _sessionsFilter.trim();
  const res = await sendMessage({ type: 'GET_SESSIONS', q });
  // Bail out if a newer call has already started (prevents duplicate items from concurrent renders)
  if (_sessionsRenderGen !== gen) return;
  const sessions = res?.data?.sessions || [];

  if (!sessions.length) {
    listEl.innerHTML = `<div class="sessions-empty">${q ? _msg('sessionsNoMatch', 'No sessions match your search.') : `${_msg('sessionsEmpty', 'No saved sessions yet.')}<br>${_msg('sessionsEmptyHint', 'Start a new session to archive this conversation.')}`}</div>`;
    return;
  }

  // With an active search, bucket headers are noise — show one flat result
  // list. Without, pinned sessions float above the time buckets.
  const searching = q.length > 0;
  let groups;
  if (searching) {
    groups = [{ label: '', items: sessions }];
  } else {
    groups = [{ label: _msg('pinnedGroupLabel', 'Pinned'), items: sessions.filter(s => s.pinned) }];
    const rest = sessions.filter(s => !s.pinned);
    for (const b of TIME_BUCKETS) {
      groups.push({ label: _msg(b.labelKey, b.fallback), items: rest.filter(s => bucketOf(s.createdAt) === b.id) });
    }
  }

  for (const g of groups) {
    if (!g.items.length) continue;
    if (g.label && groups.length > 1) {
      const head = document.createElement('div');
      head.className = 'sessions-group-label';
      head.textContent = g.label;
      listEl.appendChild(head);
    }
    for (const s of g.items) listEl.appendChild(createSessionRow(s));
  }
}

/** Build one session row (pin/export/delete + dblclick-rename + click-load). */
function createSessionRow(s) {
  const item = document.createElement('div');
  item.className = 'session-item' + (s.pinned ? ' pinned' : '');
  const relTime = relativeTime(s.createdAt);
  const absTime = new Date(s.createdAt).toLocaleString();

  item.innerHTML = `
      <div class="session-item-body">
        <div class="session-item-name" title="Double-click to rename">${escM(s.name)}</div>
        <div class="session-item-date" title="${escM(absTime)}">${relTime}${s.contentMatch ? `<span class="session-content-hit" title="${escM(_msg('contentMatchHint', 'matched in message content'))}"></span>` : ''}</div>
      </div>
      <div class="session-item-actions">
        <button class="session-pin-btn${s.pinned ? ' active' : ''}" title="${s.pinned ? escM(_msg('unpinSession', 'Unpin')) : escM(_msg('pinSession', 'Pin'))}" data-id="${s.id}">${ICONS.pin}</button>
        <button class="session-export-btn" title="Export as Markdown" data-id="${s.id}">⬇</button>
        ${s.pinned ? '' : `<button class="session-del-btn" title="${escM(_msg('deleteSession', 'Delete session'))}" data-id="${s.id}">${ICONS.trash}</button>`}
      </div>`;

  // Click body → load session; double-click name → rename.
  // A double-click fires two click events before dblclick — debounce
  // the click so we can cancel it when dblclick arrives.
  const nameEl = item.querySelector('.session-item-name');
  item.querySelector('.session-item-body').addEventListener('click', (e) => {
    if (e.target.closest('.session-item-name')) {
      clearTimeout(_renameClickTimer);
      _renameClickTimer = setTimeout(() => loadSession(s.id, s.name), 220);
    } else {
      // Clear any pending name-click timer so we don't double-load
      clearTimeout(_renameClickTimer);
      _renameClickTimer = null;
      loadSession(s.id, s.name);
    }
  });
  nameEl.addEventListener('dblclick', (e) => {
    clearTimeout(_renameClickTimer); // cancel the pending single-click load
    e.stopPropagation();
    startSessionRename(nameEl, s.id);
  });

  // Pin / unpin — toggles immediately, no confirm (reversible by design).
  item.querySelector('.session-pin-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    await sendMessage({ type: 'PIN_SESSION', id: s.id, pinned: !s.pinned });
    renderSessionsList();
  });

  // Export button
  item.querySelector('.session-export-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    await exportSession(s.id, s.name);
  });

  // Delete — two-step arm instead of a confirm dialog: first click turns the
  // row's delete into red for 2s ("sure?" state), a second click commits.
  // Ctrl/Cmd+click skips the arming step like Cherry Studio does. Pinned
  // rows simply have no delete button (see innerHTML above).
  const delBtn = item.querySelector('.session-del-btn');
  if (delBtn) {
    let armed = false;
    let disarmTimer = null;
    const disarm = () => {
      armed = false;
      clearTimeout(disarmTimer);
      disarmTimer = null;
      delBtn.classList.remove('armed');
      delBtn.title = _msg('deleteSession', 'Delete session');
    };
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(e.ctrlKey || e.metaKey) && !armed) {
        armed = true;
        delBtn.classList.add('armed');
        delBtn.title = _msg('deleteArmedHint', 'Click again to delete');
        disarmTimer = setTimeout(disarm, 2000);
        return;
      }
      clearTimeout(disarmTimer);
      const ok = true; // already confirmed by the two-step arm
      if (!ok) return;
      await sendMessage({ type: 'DELETE_SESSION', id: s.id });
      showToast('Session deleted', 'success');
      renderSessionsList();
    });
  }
  return item;
}

/** Inline rename: replaces name text with an input field. */
function startSessionRename(nameEl, sessionId) {
  const oldName = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.value = oldName;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false; // prevent double-commit (Enter fires blur on DOM removal)
  const commit = async () => {
    if (done) return;
    done = true;
    const newName = input.value.trim() || oldName;
    if (newName !== oldName) {
      await sendMessage({ type: 'RENAME_SESSION', id: sessionId, name: newName });
      showToast('Session renamed', 'success');
    }
    renderSessionsList();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renderSessionsList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit); // normal click-away: save
}

/** Export a saved session as a Markdown file. */
async function exportSession(id, name) {
  const res = await sendMessage({ type: 'GET_SESSION_FULL', id });
  const session = res?.data?.session;
  if (!session) { showToast('Could not load session', 'error'); return; }

  const slug = (name || 'session').replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-').slice(0, 40);
  const dateStr = new Date().toISOString().slice(0, 10);

  // Markdown export
  const history = session.history || [];
  const lines = [
    `# ${session.name}`,
    `*Exported: ${new Date().toLocaleString()}*`,
    ''
  ];
  for (const m of history) {
    if (m.role === 'user') {
      // Normalize content: extract text from array messages (image+text combos)
      let content;
      if (typeof m.content === 'string') {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        const textPart = m.content.find(p => p.type === 'text')?.text || '';
        const hasImage = m.content.some(p => p.type === 'image_url');
        content = textPart || (hasImage ? '*(image)*' : null);
      }
      if (!content) continue;
      if (content.startsWith(PAGE_CONTEXT_PREFIX)) {
        const urlLine = content.split('\n').find(l => l.startsWith('URL:')) || '';
        lines.push(`---\n\n*(page context${urlLine ? ' — ' + urlLine.slice(4).trim() : ''})*\n`);
        continue;
      }
      lines.push(`## User\n\n${content}\n`);
    } else if (m.role === 'assistant') {
      lines.push(`## Assistant\n\n${m.content}\n`);
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `browsa-${slug}-${dateStr}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Session exported', 'success');
}

/** Clear all saved sessions with confirmation. */
export async function clearAllSessions() {
  const ok = await showConfirmDialog({
    title: 'Clear all sessions',
    message: 'Delete all saved sessions? This cannot be undone.',
    confirmLabel: 'Clear all',
    danger: true
  });
  if (!ok) return;
  await sendMessage({ type: 'CLEAR_ALL_SESSIONS' });
  showToast('All sessions cleared', 'success');
  renderSessionsList();
}

export async function loadSession(id, name) {
  // Cancel any in-progress stream before switching sessions.
  _deps.cancelActiveStream();
  // Auto-save current conversation before switching
  const { history } = await chrome.storage.local.get('history');
  const hasMessages = Array.isArray(history) && history.some(m => m.role === 'user' || m.role === 'assistant');
  if (hasMessages) {
    await sendMessage({ type: 'SAVE_SESSION' });
  }
  const res = await sendMessage({ type: 'LOAD_SESSION', id });
  if (!res?.ok && !res?.data?.ok) { showToast('Failed to load session', 'error'); return; }
  await _deps.renderHistory();
  _deps.scrollToBottom(true);
  _deps.clearPendingImages();
  closeSessionsDrawer();
  showToast(`Loaded: "${name}"`, 'success');
}
