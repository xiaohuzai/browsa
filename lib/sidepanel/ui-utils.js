// lib/sidepanel/ui-utils.js — small DOM/UI primitives shared across sidepanel.js and
// the feature modules it imports (render.js, sessions-ui.js, etc.). Leaf
// module: imports only lib/i18n.js (itself dependency-free), so nothing can
// form a circular dependency through this one.

import { t as toastT } from '../i18n.js';

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

// ─── Choice-card primitives ──────────────────────────────────────────────────
// The ASR mode card (attach-orchestrator) and the provider-switch card
// (sidepanel.js) had byte-identical copies of this two-line button builder —
// one place so a style/markup change can't land on one card only.
// `onPick` fires after the owning card is removed (both callers' contract).
export function buildModeButton(card, main, sub, { className = 'asr-mode-btn', onPick } = {}) {
  const b = document.createElement('button');
  b.className = className;
  b.type = 'button';
  const m1 = document.createElement('span');
  m1.className = 'asr-mode-main';
  m1.textContent = main;
  const m2 = document.createElement('span');
  m2.className = 'asr-mode-sub';
  m2.textContent = sub;
  b.appendChild(m1);
  b.appendChild(m2);
  b.addEventListener('click', () => { card.remove(); onPick?.(); });
  return b;
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
    // Error toasts: Copy + Dismiss, no auto-dismiss. Labels come from the
    // shared i18n dictionary (English fallbacks keep the jsdom pins stable).
    const copyBtn = document.createElement('button');
    copyBtn.className = 'toast-copy';
    copyBtn.textContent = toastT('toastCopy', 'Copy');
    copyBtn.addEventListener('click', () => _copyText(full).catch(() => {}));
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'toast-x';
    dismissBtn.textContent = toastT('toastDismiss', 'Dismiss');
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

// ─── Panel modal (native <dialog>) ────────────────────────────────────────────
let _confirmSeq = 0;

/**
 * Panel modal on a native <dialog> (top layer). The platform owns the modal
 * contract — focus containment, background inertness, Esc (cancel → close),
 * focus return — so no caller hand-rolls role/aria-modal, a Tab trap, inert
 * toggling or an Esc listener (2026-11-11 deepening: the confirm box used to
 * rebuild all of that by hand while the ctx/prompt inspectors shipped with
 * none of it). Callers own only content, buttons and dismissal values.
 *
 * opts: body (HTMLElement, textContent-built — nothing takes an HTML string),
 * labelledBy/describedBy (ids inside body), role (alertdialog for destructive
 * confirms — native dialog supplies the rest), onCancel (value delivered on
 * Esc / scrim click), onKey(e, close) (optional keydown hook; Enter semantics
 * live there, IME-gated via isImeComposing). Card sizing belongs to the body's
 * own class (.confirm-modal / .ctx-inspector-modal / .prompt-inspector-modal).
 *
 * Returns { dialog, close, result }: result resolves exactly once; close(value)
 * is the single exit path. jsdom has no showModal/close — the open-attribute
 * fallback (crop/lightbox precedent) keeps the path testable; Esc + scrim are
 * wired only on that fallback, since the real top layer provides both and
 * double-handling would resolve twice.
 */
export function openPanelDialog({ body, labelledBy, describedBy, role = '', onCancel = false, onKey = null } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'panel-modal';
  if (labelledBy) dialog.setAttribute('aria-labelledby', labelledBy);
  if (describedBy) dialog.setAttribute('aria-describedby', describedBy);
  if (role) dialog.setAttribute('role', role);
  if (body) dialog.appendChild(body);
  const invoker = document.activeElement;
  document.body.appendChild(dialog);

  let settled = false;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  function close(value = onCancel) {
    if (settled) return;
    settled = true;
    resolveResult(value);
    try { dialog.close?.(); } catch (_) { /* jsdom: no close() */ }
    dialog.remove();
    if (invoker?.isConnected) invoker.focus?.();
  }

  const native = typeof dialog.showModal === 'function';
  if (native) {
    dialog.showModal();
    dialog.addEventListener('close', () => close(onCancel));
  } else {
    dialog.setAttribute('open', '');
  }
  // .panel-modal is a full-viewport flex wrapper (the card is its child), so
  // a click targeting the dialog itself is by definition a scrim click —
  // no rect math needed, and inner scrollers never retarget to the dialog.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(onCancel); });
  dialog.addEventListener('keydown', (e) => {
    if (!native && e.key === 'Escape') { e.preventDefault(); close(onCancel); return; }
    onKey?.(e, close);
  });
  return { dialog, close, result };
}

/**
 * Modal confirm. Resolves true on confirm, false on cancel / Esc / scrim.
 *
 * danger (delete/clear callers) focuses .confirm-cancel by default: Enter on a
 * default-focused OK button destroys data on reflex. Non-danger keeps the
 * original default focus on confirm. Enter defers to a focused button's own
 * activation (so Enter on a focused Cancel cancels instead of confirming),
 * and confirms anywhere else — the original behavior.
 */
export function showConfirmDialog({ title = '', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  const uid = ++_confirmSeq;
  const box = document.createElement('div');
  box.className = 'confirm-modal' + (danger ? ' danger' : '');
  box.innerHTML = `
    <div class="confirm-title" id="confirm-title-${uid}">${escM(title)}</div>
    <div class="confirm-msg" id="confirm-msg-${uid}">${escM(message)}</div>
    <div class="confirm-btns">
      <button class="confirm-cancel">${escM(cancelLabel)}</button>
      <button class="confirm-ok${danger ? ' danger' : ''}">${escM(confirmLabel)}</button>
    </div>`;
  const okBtn = box.querySelector('.confirm-ok');
  const cancelBtn = box.querySelector('.confirm-cancel');
  const defaultBtn = danger ? cancelBtn : okBtn;
  const { dialog, close, result } = openPanelDialog({
    body: box,
    labelledBy: `confirm-title-${uid}`,
    describedBy: `confirm-msg-${uid}`,
    role: 'alertdialog',
    onCancel: false,
    onKey: (e, closeWith) => {
      // Enter defers to a focused dialog button's own activation — handling
      // it here too would resolve true BEFORE the button's click, so Enter
      // on the focused Cancel would still destroy.
      if (e.key === 'Enter' && !isImeComposing(e) && !e.target?.closest?.('.confirm-btns button')) {
        e.preventDefault();
        closeWith(true);
      }
    },
  });
  cancelBtn.addEventListener('click', () => close(false));
  okBtn.addEventListener('click', () => close(true));
  // Clicking non-button content (title/message text) must not drop focus —
  // a following Enter would then bypass the button semantics and confirm
  // outright. Text selection is unaffected (click fires after selection).
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog && !e.target.closest('button')) defaultBtn.focus();
  });
  defaultBtn.focus();
  return result;
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
/* Arrow-key traversal for drawer list rows (2026-10-17 a11y pass). The rows
   keep their natural tab stops; this adds ↑/↓ as a jump — keyboard users no
   longer tab through every row of a long session list. Wrap-around at both
   ends; inputs inside a row (inline rename) keep their caret movement. */
const _arrowNavBound = new WeakSet();
export function initArrowNav(container, rowSelector) {
  if (!container || _arrowNavBound.has(container)) return;
  _arrowNavBound.add(container);
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.target.closest?.('input, textarea')) return;
    const rows = [...container.querySelectorAll(rowSelector)];
    if (!rows.length) return;
    e.preventDefault();
    const idx = rows.indexOf(document.activeElement);
    let next;
    if (idx === -1) next = rows[0];
    else if (e.key === 'ArrowDown') next = rows[idx + 1] || rows[0];
    else next = rows[idx - 1] || rows[rows.length - 1];
    next?.focus();
  });
}

export function scheduleIdle(fn, timeoutMs = 15000) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: timeoutMs });
  else setTimeout(fn, 500);
}
