// lib/sidepanel/detail-thread.js — "select text in an assistant reply → scoped
// follow-up" side conversation, extracted verbatim from sidepanel.js
// (Phase 3 of the modularization refactor).
//
// UI name: 追问 / Follow up (i18n keys detailThreadLabel / detailThreadPlaceholder).
// The INTERNAL name stays "detail thread" / the `browsa-subchat` port / subId —
// only the user-facing wording changed.
//
// Ephemeral by design: closing the card discards everything in it — the
// conversation itself is never written to chrome.storage or the main history
// array. (The one persisted scrap is the card input's ↑ recall list, under
// its own storage key and separate from the main composer's — see
// cardHistory below.) Context sent to the LLM is deliberately narrow (the
// selected excerpt + the full reply it came from), not the whole main
// conversation — this is a focused side question, not a branch of the main
// thread.
//
// Self-contained: no sidepanel.js-owned mutable state is needed (subMessages/
// liveAiEl/etc. are all local to a single openDetailThread() call), so this
// module wires its own top-level mouseup/scroll listeners on import instead
// of needing an initDetailThread() call from sidepanel.js.

import { ICONS } from './icons.js';
import { escM, sendMessage, _findCard, _insertCard, showToast, isImeComposing } from './ui-utils.js';
import { createInputHistory } from './composer-state.js';
import { t as _t } from '../i18n.js';
import { createTurnChrome, buildUsageChip, insertUsageChip } from './turn-chrome.js';
import {
  renderSafe, finishBubble,
  makeStreamRenderer
} from './render.js';

const messagesEl = () => document.getElementById('messages');

// The card's OWN ↑/↓ recall scope, deliberately separate from the main
// composer's (user direction 2026-09-21): ↑ in a card recalls previous 追问
// questions, never main-chat sends. All cards share this one scope — cards
// are ephemeral (closed = discarded), so a fresh card starting from an empty
// list would make ↑ useless there.
const cardHistory = createInputHistory({ storageKey: 'subchatInputHistory' });
// Pull the persisted list in at import — fire-and-forget; the storage read
// resolves long before a user can open a card and press ↑.
cardHistory.loadInputHistory();

let selectionAskBtn = null;

export function hideSelectionAskBtn() {
  if (selectionAskBtn) { selectionAskBtn.remove(); selectionAskBtn = null; }
}

/**
 * Walk up from `node` to the nearest ancestor that is a direct (top-level)
 * child of `bubbleEl` — i.e. the specific paragraph/list/heading/etc. block
 * the selection ends in, not the whole reply. Used so the detail-thread
 * card gets inserted right after the selected part, not after the entire
 * (possibly much longer) reply.
 */
function findBlockAnchor(node, bubbleEl) {
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  while (node && node !== bubbleEl && node.parentElement !== bubbleEl) {
    node = node.parentElement;
  }
  return (node && node !== bubbleEl) ? node : bubbleEl;
}

function handleAssistantTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSelectionAskBtn(); return; }
  let node = sel.anchorNode;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const bubbleEl = node?.closest?.('.msg.assistant');
  if (!bubbleEl || !messagesEl().contains(bubbleEl)) { hideSelectionAskBtn(); return; }

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) { hideSelectionAskBtn(); return; }

  if (!selectionAskBtn) {
    selectionAskBtn = document.createElement('button');
    selectionAskBtn.className = 'selection-ask-btn';
    selectionAskBtn.innerHTML = `${ICONS.chat}<span>${escM(_t('detailThreadLabel', '追问'))}</span>`;
    // mousedown (not click): fires before the browser clears the selection
    // on the subsequent click, so window.getSelection() below is still valid.
    selectionAskBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const text = sel.toString().trim();
      // Anchor on the selection's END (reading-order last point) so the
      // card appears right after what was selected, not before it.
      const anchorEl = findBlockAnchor(range.endContainer, bubbleEl);
      hideSelectionAskBtn();
      openDetailThread(bubbleEl, text, anchorEl);
    });
    document.body.appendChild(selectionAskBtn);
  }
  selectionAskBtn.style.top = (rect.bottom + 6) + 'px';
  selectionAskBtn.style.left = rect.left + 'px';
}

messagesEl().addEventListener('mouseup', () => setTimeout(handleAssistantTextSelection, 0));
messagesEl().addEventListener('scroll', hideSelectionAskBtn);
document.addEventListener('mousedown', (e) => {
  if (selectionAskBtn && e.target !== selectionAskBtn) hideSelectionAskBtn();
});

/**
 * Open (or focus, if already open) an inline "detail thread" card right
 * after the specific block (paragraph/list/heading/etc.) the selection
 * ended in — not after the whole (possibly much longer) reply — scoped to
 * a quoted excerpt from that reply. anchorEl defaults to bubbleEl itself
 * if the caller doesn't have a more specific block element.
 */
export function openDetailThread(bubbleEl, quotedText, anchorEl) {
  anchorEl = anchorEl || bubbleEl;
  const existing = _findCard(anchorEl, 'detail-thread-card');
  if (existing) {
    existing.querySelector('.detail-thread-input')?.focus();
    return;
  }

  const subId = 'sub-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const anchorRaw = bubbleEl.dataset.raw || bubbleEl.innerText || '';

  const card = document.createElement('div');
  card.className = 'detail-thread-card';
  card.innerHTML =
    `<button class="detail-thread-close" title="${escM(_t('closeLabel', 'Close'))}">${ICONS.close}</button>` +
    `<div class="detail-thread-quote">${escM(quotedText)}</div>` +
    `<div class="detail-thread-messages"></div>` +
    `<div class="detail-thread-input-row">` +
      `<input type="text" class="detail-thread-input" aria-label="${escM(_t('detailThreadPlaceholder', '就这段追问…'))}" placeholder="${escM(_t('detailThreadPlaceholder', '就这段追问…'))}" />` +
      `<button class="detail-thread-send">${escM(_t('detailThreadSend', '发送'))}</button>` +
    `</div>` +
    `<div class="detail-thread-resize-handle" title="${escM(_t('detailThreadResize', '拖拽调整高度'))}">⋯</div>`;

  const messagesWrap = card.querySelector('.detail-thread-messages');
  const input = card.querySelector('.detail-thread-input');
  const sendBtnEl = card.querySelector('.detail-thread-send');
  const closeBtn = card.querySelector('.detail-thread-close');
  const resizeHandle = card.querySelector('.detail-thread-resize-handle');

  // Custom drag-to-resize: native CSS `resize` exists but its grip is easy
  // to miss (gets visually clipped by the card's border-radius + the
  // overflow:hidden that `resize` itself requires). The window listeners
  // exist ONLY for the duration of an active drag (added on handle
  // mousedown, removed on mouseup): listeners added once at card creation
  // leak every time a card is destroyed WITHOUT its close handler —
  // renderHistory/newSession/clearChatHistory wipe messagesEl.innerHTML
  // directly — each leaked pair retaining its detached card subtree.
  let resizeStartY = 0, resizeStartHeight = 0;
  const onResizeMove = (e) => {
    const next = resizeStartHeight + (e.clientY - resizeStartY);
    card.style.height = Math.max(140, Math.min(next, window.innerHeight * 0.8)) + 'px';
  };
  const onResizeEnd = () => {
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeEnd);
  };
  resizeHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    resizeStartY = e.clientY;
    resizeStartHeight = card.getBoundingClientRect().height;
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', onResizeEnd);
    e.preventDefault();
  });

  // 拖拽手势的键盘替代（U4）：handle 可聚焦，↑/↓ 每次 20px 调高（同裁剪
  // canvas 的方向键先例），role=separator 语义化。
  resizeHandle.tabIndex = 0;
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-orientation', 'horizontal');
  resizeHandle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = card.getBoundingClientRect().height;
    const next = cur + (e.key === 'ArrowDown' ? 20 : -20);
    card.style.height = Math.max(140, Math.min(next, window.innerHeight * 0.8)) + 'px';
  });

  let subMessages = []; // sent to the LLM only — never touches storage/history
  let liveAiEl = null;
  let rawAccum = '';     // the true full accumulated text, updated synchronously
                         // on every delta. Rendering is delegated to the MAIN
                         // chat's makeStreamRenderer (live <thinking> block,
                         // paced reveal); its isDone branch renders the caller's
                         // exact final text, so finalize() always passes
                         // rawAccum — never any intermediate display state.
  let renderStream = null;   // this turn's makeStreamRenderer closure
  let turnPort = null;      // this turn's dedicated browsa-subchat port
  let swPingInterval = null;
  let inFlight = false;     // true from send() until finalize()/fail()/stopTurn()
  let toolEvents = [];      // TOOL_PROGRESS texts, folded into the final bubble's
                            // tool-history on DONE (main-panel parity; abort discards)
  let firstChunkAt = 0;     // first CHUNK arrival — tokens/sec + duration for the usage chip

  // ─── Turn chrome (shared with the main panel — lib/sidepanel/turn-chrome.js) ─
  // The wait indicator / tool-progress line / tool-history fold / usage chip /
  // approval + clarify cards live in ONE module shared with sidepanel.js (they
  // used to be private near-copies of each other). The only per-surface
  // differences are parameterized here: the SUBCHAT_* relay twins and the
  // subId key (vs the main chat's tabId). scope pins card lookups to THIS
  // card's message list so coexisting cards never touch each other's.
  const turnChrome = createTurnChrome({
    key: { field: 'subId', get: () => subId },
    relay: { approval: 'SUBCHAT_APPROVAL_RESPOND', clarify: 'SUBCHAT_CLARIFY_RESPOND' },
    scope: messagesWrap,
  });

  function setBusy(busy) {
    input.disabled = busy;
    // The send button never disables: mid-turn it IS the stop button (same
    // swap as the main composer's send/stop), so a long turn can always be
    // cut short without discarding the whole thread (the only abort path
    // before was closing the card, which throws everything away).
    sendBtnEl.classList.toggle('is-stopping', busy);
    sendBtnEl.innerHTML = busy ? ICONS.stop : escM(_t('detailThreadSend', '发送'));
    sendBtnEl.title = busy ? _t('detailThreadStop', '停止') : '';
    sendBtnEl.setAttribute('aria-label', busy ? _t('detailThreadStop', '停止') : _t('detailThreadSend', '发送'));
  }

  function stopTurnPort() {
    if (swPingInterval) { clearInterval(swPingInterval); swPingInterval = null; }
    if (turnPort) { try { turnPort.disconnect(); } catch (_) {} turnPort = null; }
  }

  function appendDelta(delta) {
    turnChrome.stopWait();
    if (!liveAiEl || !renderStream) return;
    if (!firstChunkAt) firstChunkAt = Date.now();
    rawAccum += delta;
    renderStream(delta, false);
  }

  // ─── Agent process surfacing (tool progress / approval / clarify) ─────────
  // The DOM for these (a faint pre-bubble progress line, the interactive
  // approval/clarify cards below the streaming bubble) lives in turn-chrome.js
  // — same UX as the main panel. Without it an agent turn (Hermes runs /
  // opencode / bridge) that runs tools before answering sat in total silence,
  // and approval-gated tools stalled forever (no card to answer them with).
  // Chunks: SUBCHAT_TOOL_PROGRESS / _APPROVAL / _CLARIFY; replies relay via the
  // SUBCHAT_* twins (wired into turnChrome above).
  function onToolProgress(text) {
    if (!liveAiEl) return;
    turnChrome.showToolProgress(liveAiEl, text);
    toolEvents.push(text);
  }

  async function finalize(providerLabel, usage) {
    const el = liveAiEl;
    const finalRaw = rawAccum; // snapshot before state is reset below
    liveAiEl = null;
    if (!el) return;
    turnChrome.clearTurnChrome(el);
    // t/s + duration snapshot BEFORE the async final render (timing = first
    // chunk → DONE arrival, same as the main panel's state.startedAt math).
    const usageChip = buildUsageChip(usage, firstChunkAt);
    const rs = renderStream;
    renderStream = null;
    try {
      if (rs) {
      // isDone branch: pacer drained to the exact final text, live think block
      // swapped for the final renderSafe one, .done added, finishBubble 收尾装饰。
        await rs(finalRaw, true);
      } else {
        el.classList.add('done');
      }
      if (toolEvents.length) {
        turnChrome.renderToolHistory(el, toolEvents);
        toolEvents = [];
      }
      if (usageChip) insertUsageChip(el, usageChip);
      turnChrome.addProviderChip(el, providerLabel);
    } catch (e) {
      // 终渲抛错（vendor 消毒/渲染链异常）不再向上炸：气泡保留已绘制状态。
      console.error('[subchat]', subId, 'final render failed', e);
      el.classList.add('done');
    } finally {
      // 收尾必须无条件执行（B6）：此前 await 终渲一抛错就跳过全部清理，
      // inFlight 卡 true、端口/keepalive 不断、按钮停在停止态。
      subMessages.push({ role: 'assistant', content: finalRaw });
      toolEvents = []; firstChunkAt = 0;
      inFlight = false;
      stopTurnPort();
      setBusy(false);
      input.focus();
    }
  }

  // Stop mid-turn (■ button): abort the background stream but KEEP the card
  // and whatever already streamed — main-chat Esc semantics, scoped to this
  // thread. Partial text finalizes in place (so user/assistant alternation in
  // subMessages stays intact and the user can follow up); a turn with no text
  // at all cleans up like fail() does.
  async function stopTurn(opts = {}) {
    if (!inFlight) return;
    // 端口已死（onDisconnect 自愈路径）时 ABORT 发不出去也没有意义，跳过。
    if (!opts.aborted) sendMessage({ type: 'SUBCHAT_ABORT', subId });
    const el = liveAiEl;
    const partial = rawAccum;
    liveAiEl = null;
    turnChrome.clearTurnChrome(el);
    const rs = renderStream;
    renderStream = null;
    if (rs) rs.destroy(); // stop pacer/rAF + remove any live think block
    try {
      if (el) {
        if (partial.trim()) {
          el.innerHTML = await renderSafe(partial);
          el.classList.add('done');
          el.dataset.raw = partial;
          finishBubble(el); // C3 单一收尾——此前缺 linkifyTimestamps，■ 中止回复时间戳不可点
          subMessages.push({ role: 'assistant', content: partial });
        } else {
          el.remove();
          if (subMessages.length && subMessages[subMessages.length - 1].role === 'user') {
            subMessages.pop();
          }
        }
      }
    } catch (e) {
      // 中止收尾的终渲抛错同样不能跳过清理（B6）。
      console.error('[subchat]', subId, 'stop render failed', e);
    } finally {
      toolEvents = []; firstChunkAt = 0;
      inFlight = false;
      stopTurnPort();
      setBusy(false);
    }
  }

  function fail(message) {
    if (renderStream) { renderStream.destroy(); renderStream = null; }
    turnChrome.clearTurnChrome(liveAiEl);
    if (liveAiEl) {
      liveAiEl.classList.add('done', 'subchat-error'); // stop the blinking cursor too
      liveAiEl.textContent = '⚠ ' + (message || 'Request failed');
    }
    // Undo the user turn send() optimistically pushed — it never got an
    // assistant reply, so leaving it in would break the user/assistant
    // alternation subMessages relies on. Without this, retrying after a
    // failure sends two consecutive "user" messages (the failed wrapped
    // first-turn content, then the retry's raw question) with no reply in
    // between, which most chat APIs reject or mishandle.
    if (subMessages.length && subMessages[subMessages.length - 1].role === 'user') {
      subMessages.pop();
    }
    liveAiEl = null; rawAccum = ''; toolEvents = []; firstChunkAt = 0;
    inFlight = false;
    stopTurnPort();
    setBusy(false);
  }

  async function send() {
    const q = input.value.trim();
    if (!q) return;
    cardHistory.pushInputHistory(q); // card-scope ↑ recall list
    setBusy(true);
    inFlight = true;
    // 复位召回态再清空，同主 composer 的 onSend：resetHistoryNav 会把召回前
    // 的草稿写回 value，顺序反了草稿就会顶掉刚清空的输入框。
    cardHistory.resetHistoryNav(input);
    input.value = '';

    try {
      // Reuse the main chat's own .msg.user/.msg.assistant classes directly
      // (not a parallel copy) so bubble styling never drifts out of sync —
      // any future change to the main chat's message look applies here too.
      const userEl = document.createElement('div');
      userEl.className = 'msg user';
      userEl.textContent = q;
      messagesWrap.appendChild(userEl);

      liveAiEl = document.createElement('div');
      liveAiEl.className = 'msg assistant'; // .done added in finalize()/fail()
      messagesWrap.appendChild(liveAiEl);
      rawAccum = '';
      toolEvents = [];
      firstChunkAt = 0;
      // The MAIN chat's stream renderer, not a private accumulate loop — this
      // is what gives the card the same live "Thinking…" collapsible for
      // reasoning models (llm-client inlines <thinking> blocks into the delta
      // stream for every apiStyle), the same paced reveal, and a .destroy()
      // the stop button can use for clean mid-stream teardown.
      renderStream = makeStreamRenderer(liveAiEl, {
        onTick: () => { messagesWrap.scrollTop = messagesWrap.scrollHeight; },
      });
      turnChrome.startWait(() => liveAiEl);
      messagesWrap.scrollTop = messagesWrap.scrollHeight;

      if (subMessages.length === 0) {
        // First turn: give the model the full reply (for grounding) plus the
        // specific excerpt the user is asking about, using the same "> "
        // blockquote convention as the existing ↩ Quote-to-main-input action.
        const quoted = quotedText.split('\n').map(l => '> ' + l).join('\n');
        subMessages.push({
          role: 'user',
          content:
            'The user has a follow-up question about part of your previous reply below.\n\n' +
            '--- Full previous reply ---\n' + anchorRaw + '\n--- End of previous reply ---\n\n' +
            'The user is specifically asking about this part:\n' + quoted + '\n\n' +
            'User\'s question: ' + q,
        });
      } else {
        subMessages.push({ role: 'user', content: q });
      }

      // Open a FRESH port for this turn and wait for its HELLO_ACK before
      // sending SUBCHAT — mirrors onSend()'s browsa-chat handshake exactly.
      // A persistent port connected once at panel-init sounds appealing but
      // has a real race: if the SW went idle while the user was reading
      // before opening this card, sendMessage({type:'SUBCHAT'}) wakes the SW
      // almost immediately, while a stale/reconnecting port can still be
      // mid-reconnect — the first deltas would silently go nowhere.
      turnPort = chrome.runtime.connect({ name: 'browsa-subchat' });
      swPingInterval = setInterval(() => {
        try { turnPort.postMessage({ type: 'SW_PING' }); } catch (_) {}
      }, 20_000);

      const ackOk = await new Promise((resolve) => {
        const ackTimeout = setTimeout(() => resolve(false), 500); // safety net
        turnPort.onMessage.addListener(function once(m) {
          if (m.type === 'SUBCHAT_HELLO_ACK') {
            clearTimeout(ackTimeout);
            turnPort.onMessage.removeListener(once);
            resolve(true);
          }
        });
        turnPort.postMessage({ type: 'SUBCHAT_HELLO', subId });
      });
      void ackOk; // handshake awaited (deltas below rely on it); result itself unused

      turnPort.onMessage.addListener((m) => {
        if (m.type === 'SUBCHAT_CHUNK') appendDelta(m.delta);
        else if (m.type === 'SUBCHAT_TOOL_PROGRESS') onToolProgress(m.text);
        else if (m.type === 'SUBCHAT_APPROVAL') turnChrome.showApprovalCard(liveAiEl, m.data);
        else if (m.type === 'SUBCHAT_CLARIFY') turnChrome.showClarifyCard(liveAiEl, m.data);
        else if (m.type === 'SUBCHAT_DONE') { if (m.truncated) showToast(_t('detailThreadTruncated', '追问回复已达模型输出上限，可回复「继续」续写'), 'info'); finalize(m.providerLabel, m.usage).catch(() => {}); }
        else if (m.type === 'SUBCHAT_ERROR') fail(m.message);
      });

      // 端口意外死亡（SW 被回收/崩溃）：DONE/ERROR 永远不会落地，必须就地按
      // stopTurn 语义收尾（保留已流式文本），否则 inFlight 卡死、SW_PING 每 20s
      // 打死端口、waitTimer 永久空转（B7）。正常收尾（stopTurnPort 自己 disconnect）
      // 时 inFlight 已复位，这里直接退出。
      turnPort.onDisconnect.addListener(() => {
        if (!inFlight) return;
        stopTurn({ aborted: true }).catch(() => {});
      });

      const res = await sendMessage({ type: 'SUBCHAT', subId, messages: subMessages });
      if (!res?.ok) fail(res?.error || 'Failed to start');
    } catch (e) {
      console.error('[subchat]', subId, 'send() threw', e);
      fail(e?.message || String(e));
    }
  }

  sendBtnEl.addEventListener('click', () => {
    // Mid-turn the same button is ■ Stop (setBusy swaps it) — abort without
    // discarding the thread, the main composer's send/stop swap.
    if (inFlight) { stopTurn(); return; }
    send();
  });
  // ↑/↓ history recall from the card's own scope (追问 questions only — the
  // main composer's list is a different scope and never shows up here).
  // handleHistoryNav is IME-safe internally; the card has no slash panel, so
  // no veto is needed. The input listener is typing-cancels-nav — the same
  // job attachDraftPersistence does for the main composer, minus draft
  // persistence (this card is ephemeral by design).
  input.addEventListener('keydown', (e) => {
    if (cardHistory.handleHistoryNav(e)) { e.preventDefault(); return; }
    // isImeComposing: the Enter that confirms an IME candidate is NOT a send
    // (the card input was the one surface missing this — Enter-to-commit
    // fired the half-typed question, user-reported 2026-09-21).
    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => cardHistory.resetHistoryNav(input));
  closeBtn.addEventListener('click', () => {
    if (inFlight) {
      sendMessage({ type: 'SUBCHAT_ABORT', subId });
      inFlight = false;
    }
    if (renderStream) { renderStream.destroy(); renderStream = null; }
    turnChrome.clearTurnChrome(liveAiEl);
    stopTurnPort();
    onResizeEnd(); // no-op unless mid-drag — the window listeners are drag-scoped
    card.remove();
  });
  setBusy(false);

  _insertCard(anchorEl, card);
  setTimeout(() => input.focus(), 50);
}
