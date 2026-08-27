// lib/sidepanel/followups.js — queued follow-up messages while a stream is
// active (Cherry Studio's QueuedFollowupsDock pattern).
//
// Today pressing Enter mid-stream starts a SECOND parallel send — the chunk
// router keys streams by tabId, so the two replies fight over one port and
// corrupt each other's history indices. Instead, onSend() hands mid-stream
// input here: messages stack as removable chips above the composer and the
// caller drains them one-by-one once the stream goes idle.

const MAX_QUEUED = 5;
let _opts = { mountEl: null, sendNow: () => {}, maxLen: 120 };
let _dock = null;
let _list = []; // { id, text }
let _nextId = 1;

function _msg(key, fallback) {
  return (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
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
}

export function getQueuedFollowups() {
  return [..._list];
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
  return true;
}

export function removeFollowup(id) {
  _list = _list.filter((f) => f.id !== id);
  renderFollowups();
}

/** Pop the oldest queued message for sending now (drain-on-stream-end). */
export function takeFirstFollowup() {
  const first = _list.shift();
  renderFollowups();
  return first ? first.text : null;
}

export function clearFollowups() {
  if (!_list.length) return;
  _list = [];
  renderFollowups();
}

export function renderFollowups() {
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
      _opts.sendNow(f.text);
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
