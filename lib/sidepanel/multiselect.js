// lib/sidepanel/multiselect.js — bulk-delete multiselect mode for the message list,
// extracted verbatim from sidepanel.js (Phase 3 of the modularization
// refactor).
//
// deleteSelectedMessages() needs to keep sidepanel.js's nextHistoryIdx
// mirror in sync (that counter is cross-cutting state touched by onSend,
// ATTACH_PAGE, single-message delete, etc. — it stays owned by
// sidepanel.js). Injected once via initMultiselect() rather than imported
// back from sidepanel.js, to avoid a module cycle.

import { $, showToast, sendMessage } from './ui-utils.js';

const messagesEl = () => document.getElementById('messages');

let isMultiSelectMode = false;
export function isInMultiSelectMode() { return isMultiSelectMode; }

let _deps = { decrementNextHistoryIdx: () => {} };
export function initMultiselect(deps) {
  _deps = { ..._deps, ...deps };
}

export function enterMultiSelect() {
  isMultiSelectMode = true;
  $('multiselect-bar').hidden = false;
  $('multiselect-toggle')?.classList.add('active');
  // Add checkboxes to every message bubble that has a data-hidx
  for (const msg of messagesEl().querySelectorAll('.msg[data-hidx]')) {
    if (msg.querySelector('.msg-select-cb')) continue;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'msg-select-cb';
    cb.addEventListener('change', updateMultiselectCount);
    msg.insertBefore(cb, msg.firstChild);
  }
  updateMultiselectCount();
}

export function exitMultiSelect() {
  isMultiSelectMode = false;
  $('multiselect-bar').hidden = true;
  $('multiselect-toggle')?.classList.remove('active');
  for (const cb of messagesEl().querySelectorAll('.msg-select-cb')) cb.remove();
}

function updateMultiselectCount() {
  const n = messagesEl().querySelectorAll('.msg-select-cb:checked').length;
  const el = $('multiselect-count');
  if (el) el.textContent = `${n} selected`;
  const delBtn = $('multiselect-delete');
  if (delBtn) delBtn.disabled = n === 0;
}

export async function deleteSelectedMessages() {
  const checked = [...messagesEl().querySelectorAll('.msg-select-cb:checked')];
  if (!checked.length) return;

  // Collect indices sorted descending — delete highest first to avoid shift
  const indices = checked
    .map(cb => parseInt(cb.closest('[data-hidx]')?.dataset.hidx, 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => b - a);

  for (const idx of indices) {
    await sendMessage({ type: 'REMOVE_HISTORY_ENTRY_BY_INDEX', index: idx }).catch(() => null);
    // Shift data-hidx on remaining bubbles above this index
    for (const el of messagesEl().querySelectorAll('[data-hidx]')) {
      const bidx = parseInt(el.dataset.hidx, 10);
      if (bidx > idx) el.dataset.hidx = bidx - 1;
    }
    _deps.decrementNextHistoryIdx();
  }

  // Remove DOM elements
  checked.forEach(cb => cb.closest('.msg')?.remove());
  exitMultiSelect();
  showToast(`Deleted ${indices.length} message${indices.length > 1 ? 's' : ''}`, 'success');
}
