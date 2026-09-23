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

// Escape for HTML *text and attribute* positions. Must escape quotes: this is
// used inside `data-choice="${escM(c)}"` / `class="…-${escM(x)}"` on the
// approval card, where `c`/`x` come from the provider/agent — a `"` would break
// out of the attribute and inject markup from the privileged extension origin.
export function escM(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

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
    // Toasts are inserted notifications — expose the container as a polite
    // live region so screen readers announce them as they appear (role=status
    // carries the implicit polite live region; both are written out).
    _toastContainer.setAttribute('role', 'status');
    _toastContainer.setAttribute('aria-live', 'polite');
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
let _confirmSeq = 0;

/**
 * Modal confirm. Resolves true on confirm, false on cancel / Esc / scrim click.
 *
 * Semantic dialog behavior (2026-09-23 a11y pass): .confirm-overlay is a
 * hand-rolled div modal, so the native <dialog> contract is supplied
 * explicitly — role="alertdialog" + aria-modal="true" (named by the title,
 * described by the message), a Tab focus trap keeping focus inside the box,
 * Esc = cancel, and every other <body> child marked `inert` while open.
 * Native <dialog> (the crop/lightbox precedent) would get these for free but
 * needs its own CSS reset — sidepanel.css's `dialog.crop-modal` block
 * exists precisely because UA `dialog`/`dialog:modal` rules (fit-content
 * sizing, `max-width: calc(100% - 6px - 2em)`, margin:auto, border) outrank
 * the `.confirm-*` class rules — and sidepanel.css is outside this change's
 * file boundary, so the DOM/class/API shape stays exactly as it was and the
 * behavior is layered on top of it.
 *
 * danger (delete/clear callers) focuses .confirm-cancel by default: Enter on a
 * default-focused OK button destroys data on reflex. Non-danger keeps the
 * original default focus on confirm. Enter defers to a focused button's own
 * activation (so Enter on a focused Cancel cancels instead of confirming),
 * and confirms anywhere else — the original behavior.
 */
export function showConfirmDialog({ title = '', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const uid = ++_confirmSeq;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const modal = document.createElement('div');
    modal.className = 'confirm-modal' + (danger ? ' danger' : '');
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <div class="confirm-title" id="confirm-title-${uid}">${escM(title)}</div>
      <div class="confirm-msg" id="confirm-msg-${uid}">${escM(message)}</div>
      <div class="confirm-btns">
        <button class="confirm-cancel">${escM(cancelLabel)}</button>
        <button class="confirm-ok${danger ? ' danger' : ''}">${escM(confirmLabel)}</button>
      </div>`;
    modal.setAttribute('aria-labelledby', `confirm-title-${uid}`);
    modal.setAttribute('aria-describedby', `confirm-msg-${uid}`);
    overlay.appendChild(modal);
    // Background inert while the dialog is open (attribute form — jsdom has no
    // inert property to assign, and the attribute is what Chrome honors).
    const inerted = [...document.body.children].filter((el) => el !== overlay);
    inerted.forEach((el) => el.setAttribute('inert', ''));
    document.body.appendChild(overlay);
    const okBtn = modal.querySelector('.confirm-ok');
    const cancelBtn = modal.querySelector('.confirm-cancel');
    // danger (delete/clear) defaults focus to Cancel; non-danger keeps the
    // original behavior (the confirm button).
    const defaultBtn = danger ? cancelBtn : okBtn;
    function done(v) {
      inerted.forEach((el) => el.removeAttribute('inert'));
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    }
    function trapTab(e) {
      // Simple focus trap: Tab/Shift+Tab cycle inside the dialog, never past it.
      const focusables = [cancelBtn, okBtn];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (!modal.contains(active) || active === first) { e.preventDefault(); last.focus(); }
      } else if (!modal.contains(active) || active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Tab') trapTab(e);
      // Enter defers to a focused dialog button's own activation (the click
      // handlers below) — handling it here too would resolve true BEFORE the
      // button's click, so Enter on the focused Cancel would still destroy.
      else if (e.key === 'Enter' && !isImeComposing(e) && !e.target?.closest?.('.confirm-btns button')) done(true);
    }
    cancelBtn.addEventListener('click', () => done(false));
    okBtn.addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false);
      // Clicking non-button content (title/message text) must not drop focus to
      // <body> — a following Enter would then bypass the button semantics and
      // confirm outright. Text selection is unaffected (click fires after the
      // selection is complete).
      else if (!e.target.closest('button')) defaultBtn.focus();
    });
    document.addEventListener('keydown', onKey);
    defaultBtn.focus();
  });
}

// ─── IME guard ───────────────────────────────────────────────────────────────

/**
 * True when this keydown belongs to an IME session: `isComposing` is the
 * spec signal, `keyCode === 229` the process-key code some IME drivers put
 * on every keydown while composing. Enter that CONFIRMS a candidate must
 * never be mistaken for a submit — every Enter-submits gate should read
 * `!isImeComposing(e)`, not a bare `!e.isComposing`.
 */
export function isImeComposing(e) {
  return e.isComposing === true || e.keyCode === 229;
}

// ─── Motion preference ─────────────────────────────────────────────────────────

/**
 * `behavior` for scrollIntoView / scrollTo: `'smooth'` unless the user asked
 * for reduced motion. The CSS `prefers-reduced-motion` media query cannot see
 * the JS `behavior` argument — smooth programmatic scrolling must be
 * downgraded here or it animates regardless of the OS setting. jsdom has no
 * matchMedia at all (verified: `window.matchMedia is not a function`), so the
 * guard degrades to `'smooth'` there instead of throwing.
 */
export function smoothOrAuto() {
  if (typeof window.matchMedia !== 'function') return 'smooth';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
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

/** Run fn when the main thread goes idle (at the latest after timeoutMs).
 * Falls back to a short setTimeout where requestIdleCallback doesn't exist
 * (jsdom tests). Home of the speculative vendor warm-ups so their multi-MB
 * parse never competes with an active stream or the panel-open path. */
export function scheduleIdle(fn, timeoutMs = 15000) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: timeoutMs });
  else setTimeout(fn, 500);
}
