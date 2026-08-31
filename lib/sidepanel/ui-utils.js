// lib/sidepanel/ui-utils.js — small DOM/UI primitives shared across sidepanel.js and
// the feature modules it imports (render.js, sessions-ui.js, etc.). Leaf
// module: no imports from other browsa lib/ files, so nothing can form a
// circular dependency through this one.

export const $ = (id) => document.getElementById(id);

// Wraps chrome.runtime.sendMessage in a Promise. When there's no receiver
// (e.g. service worker restarting), chrome.runtime.lastError is set instead
// of throwing — resolve with a structured error rather than rejecting.
export function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message, code: 'NoReceiver' });
      } else {
        resolve(res || { ok: false, error: 'no response', code: 'NoResponse' });
      }
    });
  });
}

export function escM(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Clipboard write with execCommand fallback (works in non-secure contexts too).
export function _fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return Promise.resolve();
  } catch (e) { return Promise.reject(e); }
}
export function _copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => _fallbackCopy(text));
  }
  return _fallbackCopy(text);
}

// ─── Toasts ─────────────────────────────────────────────────────────────────
let _toastContainer = null;
export function showToast(msg, type) {
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.className = 'toast-container';
    document.body.appendChild(_toastContainer);
  }
  if (!type) {
    const low = String(msg).toLowerCase();
    if (/fail|error|denied|invalid|❌/.test(low)) type = 'error';
    else if (/warn|⚠/.test(low)) type = 'warn';
    else if (/cleared|copied|switched|saved|✓/.test(low)) type = 'success';
    else type = 'info';
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  // Toast 是通知不是日志查看器：超长报错（方舟原始 JSON 等）截断显示。不截断的
  // 话 Request id 这种无空格长 token 会把行尾按钮顶出 360px 容器/视口——2026-08-28
  // 实测 401 报错 toast"关不掉"的根因（Dismiss 按钮其实一直都在，只是够不着）。
  // 完整内容仍可 Copy（error toast 的 Copy 复制全文，不带省略号）。
  const full = String(msg);
  const MAX_DISPLAY = 500;
  const msgEl = document.createElement('span');
  msgEl.textContent = full.length > MAX_DISPLAY ? full.slice(0, MAX_DISPLAY) + '…' : full;
  toast.appendChild(msgEl);

  // dismiss：移除 toast 并回收 document 级监听。error toast 没有自动消失，
  // 「点击 toast 外任意处」就是它的第二个关闭出口（用户要求）。
  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    document.removeEventListener('click', onDocClick, true);
    toast.remove();
  }
  const onDocClick = (e) => {
    if (!toast.contains(e.target)) dismiss();
  };
  // 延后一拍再挂 outside-click：toast 往往由当前这次 click 触发，立刻挂会在同
  // 一次事件派发里误判成"点了外面"。
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);

  if (type === 'error') {
    // Error toasts: Copy + Dismiss, no auto-dismiss
    const copyBtn = document.createElement('button');
    copyBtn.className = 'toast-copy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => _copyText(full).catch(() => {}));
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'toast-x';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => dismiss());
    toast.appendChild(copyBtn);
    toast.appendChild(dismissBtn);
  } else {
    const x = document.createElement('button');
    x.className = 'toast-x';
    x.textContent = '×';
    x.addEventListener('click', () => dismiss());
    toast.appendChild(x);
    // Auto-dismiss, paused on hover
    const duration = type === 'success' ? 2000 : 3500;
    let timer = setTimeout(() => dismiss(), duration);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => { timer = setTimeout(() => dismiss(), duration); });
  }
  _toastContainer.appendChild(toast);
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────
export function showConfirmDialog({ title = '', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const modal = document.createElement('div');
    modal.className = 'confirm-modal' + (danger ? ' danger' : '');
    modal.innerHTML = `
      <div class="confirm-title">${escM(title)}</div>
      <div class="confirm-msg">${escM(message)}</div>
      <div class="confirm-btns">
        <button class="confirm-cancel">${escM(cancelLabel)}</button>
        <button class="confirm-ok${danger ? ' danger' : ''}">${escM(confirmLabel)}</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    function done(v) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    }
    function onKey(e) {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    }
    modal.querySelector('.confirm-cancel').addEventListener('click', () => done(false));
    modal.querySelector('.confirm-ok').addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey);
    modal.querySelector('.confirm-ok').focus();
  });
}

// ─── Card positioning helpers ────────────────────────────────────────────────
// Shared by approval/clarify cards (sidepanel.js) and the detail-thread card
// (detail-thread.js) — both insert a small floating card right after an
// assistant bubble. Tool-progress lives before the bubble now (grouped with
// thinking), so it no longer needs special-casing here.

/** Find a named card (approval/clarify/detail-thread) in the next few siblings of bubbleEl. */
export function _findCard(bubbleEl, cls) {
  let el = bubbleEl?.nextElementSibling;
  for (let i = 0; i < 4 && el; i++, el = el.nextElementSibling) {
    if (el.classList.contains(cls)) return el;
  }
  return null;
}

/** Insert a card directly after bubbleEl. Tool-progress now lives before
 * the bubble (grouped with thinking), so nothing else occupies this slot. */
export function _insertCard(bubbleEl, card) {
  bubbleEl?.insertAdjacentElement('afterend', card);
}
