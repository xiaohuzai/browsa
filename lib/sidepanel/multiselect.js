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
  if (_deps.tryLock && !_deps.tryLock()) return; // 与单条删除互斥，防平移交错

  // Collect indices sorted descending — delete highest first to avoid shift
  const indices = checked
    .map(cb => parseInt(cb.closest('[data-hidx]')?.dataset.hidx, 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => b - a);

  let failed = 0;
  try {
    for (const idx of indices) {
      const res = await sendMessage({ type: 'REMOVE_HISTORY_ENTRY_BY_INDEX', index: idx }).catch(() => null);
      // 真判据在 envelope 的 data.ok——超界时 storage 静默 ok:false。失败的那
      // 条不能平移/递减，否则其后每一项的删除都错位。
      if (!res?.data?.ok) {
        failed++;
        // 当场给失败的气泡打标：后续成功删除会把它的 data-hidx 平移掉，
        // 最后按索引找会失手。
        messagesEl().querySelector(`[data-hidx="${idx}"]`)?.setAttribute('data-delete-failed', '1');
        continue;
      }
      // Shift data-hidx on remaining bubbles above this index
      for (const el of messagesEl().querySelectorAll('[data-hidx]')) {
        const bidx = parseInt(el.dataset.hidx, 10);
        if (bidx > idx) el.dataset.hidx = bidx - 1;
      }
      _deps.decrementNextHistoryIdx();
    }
  } finally {
    _deps.releaseLock?.();
  }

  // Remove DOM elements — but keep the bubble of any FAILED deletion on
  // screen: its storage entry still exists and would resurface on reload.
  checked.forEach(cb => {
    const el = cb.closest('.msg');
    if (!el) return;
    if (el.hasAttribute('data-delete-failed')) { cb.remove(); return; }
    el.remove();
  });
  exitMultiSelect();
  if (failed > 0) {
    showToast(`已删除 ${indices.length - failed} 条，${failed} 条失败（索引已重校准）`, 'error');
    _deps.reconcile?.();
  } else {
    showToast(`Deleted ${indices.length} message${indices.length > 1 ? 's' : ''}`, 'success');
  }
}
