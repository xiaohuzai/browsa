// lib/sidepanel/followups.js — queued follow-up messages while a stream is
// active (Cherry Studio's QueuedFollowupsDock pattern).
//
// Today pressing Enter mid-stream starts a SECOND parallel send — the chunk
// router keys streams by tabId, so the two replies fight over one port and
// corrupt each other's history indices. Instead, onSend() hands mid-stream
// input here: messages stack as removable chips above the composer and the
// caller drains them one-by-one once the stream goes idle.

// 统一走共享 i18n（2026-10-01）：私有 chrome.i18n-only 副本绕过了应用内语言
// 覆盖字典（设置里显式选语言后这里仍显示浏览器语言）——transcript-drawer
// 同款迁移，_msg 保留为委托以少动调用点。
import { t } from '../i18n.js';

const MAX_QUEUED = 5;
const QUEUE_KEY = 'browsa.followupQueue.v1';
let _opts = { mountEl: null, sendNow: () => {}, maxLen: 120 };
let _dock = null;
let _list = []; // { id, text }
let _nextId = 1;
let _epoch = 0; // invalidates an async restore after a clear/switch

// A queued message is unsent text: closing the panel (which tears the whole
// document down) used to lose it while the composer draft had already been
// cleared. Keep the queue in chrome.storage.SESSION — it dies with the
// browser session, like the detail-thread store, and survives a panel reopen.
function _area() {
  try { return chrome?.storage?.session || null; } catch (_) { return null; }
}
function _persist() {
  const area = _area();
  if (!area || typeof area.set !== 'function') return;
  try { area.set({ [QUEUE_KEY]: { items: _list } }).catch(() => {}); } catch (_) {}
}
async function _restore(epoch) {
  const area = _area();
  if (!area || typeof area.get !== 'function') return;
  try {
    const got = await area.get(QUEUE_KEY);
    const saved = got?.[QUEUE_KEY];
    if (epoch !== _epoch || _list.length || !Array.isArray(saved?.items)) return;
    _list = saved.items
      .filter((f) => f && typeof f.text === 'string' && f.text.trim())
      .slice(0, MAX_QUEUED)
      .map((f) => ({ id: _nextId++, text: f.text.trim() }));
    if (_list.length) renderFollowups();
  } catch (_) { /* fail-open: no persistence is better than a broken dock */ }
}

function _msg(key, fallback) {
  return t(key, fallback);
}

function ensureDock() {
  if (_dock || !_opts.mountEl) return;
  _dock = document.createElement('div');
  _dock.className = 'followups-dock';
  _dock.hidden = true;
  _opts.mountEl.insertAdjacentElement('beforebegin', _dock);
}

export function initFollowups(opts) {
  _opts = { ..._opts, ...opts };
  _list = [];
  if (_dock) _dock.remove();
  _dock = null;
  _restore(++_epoch); // async, fail-open; renderFollowups() runs when items arrive
}

export function getQueuedFollowups() {
  return [..._list];
}

/** Drop the whole queue. A queued message belongs to the conversation it was
 * typed in; draining it into a newly loaded/new conversation was possible
 * because nothing cleared the queue on session switches. */
export function clearFollowups() {
  _epoch++; // a pending init restore must not resurrect the old conversation's queue
  _list = [];
  renderFollowups();
  _persist();
}

export function hasQueuedFollowups() {
  return _list.length > 0;
}

/** Queue `text`. Returns false when full or empty — caller falls back to a toast/no-op. */
export function enqueueFollowup(text) {
  const t = String(text || '').trim();
  if (!t || _list.length >= MAX_QUEUED) return false;
  _list.push({ id: _nextId++, text: t });
  renderFollowups();
  _persist();
  return true;
}

export function removeFollowup(id) {
  _list = _list.filter((f) => f.id !== id);
  renderFollowups();
  _persist();
}

/** Put a just-clicked chip back at the FRONT of the queue. The caller uses
 * this when a stream is still active (a second parallel send is unsafe): the
 * removed chip used to be re-enqueued at the tail by onSend, or silently
 * dropped when the queue was full. */
export function promoteFollowup(id, text) {
  const body = String(text || '').trim();
  if (!body) return false;
  _list = [{ id, text: body }, ..._list.filter((f) => f.id !== id)];
  renderFollowups();
  _persist();
  return true;
}

/** Pop the oldest queued message for sending now (drain-on-stream-end). */
export function takeFirstFollowup() {
  const first = _list.shift();
  renderFollowups();
  _persist();
  return first ? first.text : null;
}

function renderFollowups() {
  ensureDock();
  if (!_dock) return;
  _dock.innerHTML = '';
  _dock.hidden = _list.length === 0;

  const label = document.createElement('span');
  label.className = 'followups-label';
  label.textContent = `${_msg('queuedLabel', 'Queued')} · ${_list.length}`;
  _dock.appendChild(label);

  for (const f of _list) {
    const item = document.createElement('div');
    item.className = 'followup-item';
    const preview = f.text.length > _opts.maxLen ? f.text.slice(0, _opts.maxLen) + '…' : f.text;
    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'followup-text';
    body.textContent = preview.replace(/\s+/g, ' ');
    body.title = _msg('queuedSendNow', 'Send this one now');
    // A single line is enough in a ~400px panel: clamp, don't wrap.
    body.addEventListener('click', () => {
      removeFollowup(f.id);
      // The id lets the caller promote it back to the front when a stream is
      // still active instead of re-enqueueing at the tail.
      _opts.sendNow(f.text, f.id);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'followup-remove';
    del.textContent = '✕';
    del.title = _msg('queuedRemove', 'Remove from queue');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFollowup(f.id);
    });
    item.append(body, del);
    _dock.appendChild(item);
  }
}
