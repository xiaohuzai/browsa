// lib/sidepanel/detail-thread.js — "select text in an assistant reply → scoped
// follow-up" side conversation, extracted verbatim from sidepanel.js
// (Phase 3 of the modularization refactor).
//
// Ephemeral by design: closing the card discards everything in it — nothing
// here is written to chrome.storage or the main history array. Context sent
// to the LLM is deliberately narrow (the selected excerpt + the full reply
// it came from), not the whole main conversation — this is a focused side
// question, not a branch of the main thread.
//
// Self-contained: no sidepanel.js-owned mutable state is needed (subMessages/
// liveAiEl/etc. are all local to a single openDetailThread() call), so this
// module wires its own top-level mouseup/scroll listeners on import instead
// of needing an initDetailThread() call from sidepanel.js.

import { ICONS } from './icons.js';
import { escM, sendMessage, _findCard, _insertCard } from './ui-utils.js';
import {
  renderSafe, renderStreamingSafe, renderMermaid, renderEcharts, renderMarkmap,
  addCodeCopyButtons, decorateLinks
} from './render.js';
import { createRevealPacer } from './reveal-pacer.js';

const messagesEl = () => document.getElementById('messages');

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
    selectionAskBtn.innerHTML = `${ICONS.chat}<span>细聊</span>`;
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
    `<button class="detail-thread-close" title="Close">${ICONS.close}</button>` +
    `<div class="detail-thread-quote">${escM(quotedText)}</div>` +
    `<div class="detail-thread-messages"></div>` +
    `<div class="detail-thread-input-row">` +
      `<input type="text" class="detail-thread-input" placeholder="针对这段细聊…" />` +
      `<button class="detail-thread-send">发送</button>` +
    `</div>` +
    `<div class="detail-thread-resize-handle" title="拖拽调整高度">⋯</div>`;

  const messagesWrap = card.querySelector('.detail-thread-messages');
  const input = card.querySelector('.detail-thread-input');
  const sendBtnEl = card.querySelector('.detail-thread-send');
  const closeBtn = card.querySelector('.detail-thread-close');
  const resizeHandle = card.querySelector('.detail-thread-resize-handle');

  // Custom drag-to-resize: native CSS `resize` exists but its grip is easy
  // to miss (gets visually clipped by the card's border-radius + the
  // overflow:hidden that `resize` itself requires). Mirrors the exact
  // pattern already proven to work for Mermaid pan-drag elsewhere in this
  // file (persistent flag + listeners bound once on window, not
  // dynamically added/removed per-gesture, not Pointer Events).
  let resizing = false, resizeStartY = 0, resizeStartHeight = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    resizing = true;
    resizeStartY = e.clientY;
    resizeStartHeight = card.getBoundingClientRect().height;
    console.log('[resize] mousedown, startHeight=', resizeStartHeight);
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const next = resizeStartHeight + (e.clientY - resizeStartY);
    const applied = Math.max(140, Math.min(next, window.innerHeight * 0.8));
    card.style.height = applied + 'px';
    console.log('[resize] mousemove, next=', next, 'applied=', applied,
      'card.style.height=', card.style.height,
      'actual rendered height=', card.getBoundingClientRect().height);
  });
  window.addEventListener('mouseup', () => {
    resizing = false;
  });

  let subMessages = []; // sent to the LLM only — never touches storage/history
  let liveAiEl = null;
  let liveAiText = '';   // paced display text — what's actually rendered so far
  let rawAccum = '';     // the true full accumulated text, updated synchronously
                         // on every delta (independent of pacer backlog) — the
                         // pacer only controls *when* liveAiText catches up to
                         // this, so finalize() must use rawAccum, never
                         // liveAiText, or a still-draining backlog would get
                         // silently dropped from the final rendered reply.
  let pacer = null;          // paces SUBCHAT_CHUNK reveal, one per send() turn
  let turnPort = null;      // this turn's dedicated browsa-subchat port
  let swPingInterval = null;
  let inFlight = false;     // true from send() until finalize()/fail()

  function setBusy(busy) {
    input.disabled = busy;
    sendBtnEl.disabled = busy;
  }

  function stopTurnPort() {
    if (swPingInterval) { clearInterval(swPingInterval); swPingInterval = null; }
    if (turnPort) { try { turnPort.disconnect(); } catch (_) {} turnPort = null; }
  }

  function appendDelta(delta) {
    if (!liveAiEl || !pacer) return;
    rawAccum += delta;
    // Paced (markstream-core) instead of rendering every raw delta as it
    // arrives — smooths out bursty chunks. onReveal below does exactly what
    // this function used to do directly, just fed from the paced slice.
    pacer.enqueue(delta);
  }

  async function finalize() {
    pacer?.destroy(); pacer = null;
    const el = liveAiEl;
    const finalRaw = rawAccum; // snapshot before state is reset below
    if (el) {
      // Same post-render pipeline as the main chat's DONE handler
      // (renderSafe -> link decoration -> code copy/highlight -> Mermaid/ECharts),
      // just scoped to this card's AI bubble instead of the whole panel.
      el.innerHTML = await renderSafe(finalRaw);
      el.classList.add('done'); // stops the .msg.assistant::after blinking cursor
      decorateLinks(el);
      addCodeCopyButtons(el);
      renderMermaid(el);
      renderEcharts(el);
      renderMarkmap(el);
    }
    subMessages.push({ role: 'assistant', content: finalRaw });
    liveAiEl = null; liveAiText = ''; rawAccum = '';
    inFlight = false;
    stopTurnPort();
    setBusy(false);
    input.focus();
  }

  function fail(message) {
    pacer?.destroy(); pacer = null;
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
    liveAiEl = null; liveAiText = ''; rawAccum = '';
    inFlight = false;
    stopTurnPort();
    setBusy(false);
  }

  async function send() {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    setBusy(true);
    inFlight = true;

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
      liveAiText = ''; rawAccum = '';
      pacer = createRevealPacer((revealedDelta) => {
        if (!liveAiEl) return;
        liveAiText += revealedDelta;
        liveAiEl.innerHTML = renderStreamingSafe(liveAiText);
        messagesWrap.scrollTop = messagesWrap.scrollHeight;
      });
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
      console.log('[subchat]', subId, 'connecting port');
      turnPort = chrome.runtime.connect({ name: 'browsa-subchat' });
      turnPort.onMessage.addListener((m) => console.log('[subchat]', subId, 'port message', m));
      turnPort.onDisconnect.addListener(() => console.log('[subchat]', subId, 'port disconnected', chrome.runtime.lastError));
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
      console.log('[subchat]', subId, 'HELLO_ACK received before sending?', ackOk);

      turnPort.onMessage.addListener((m) => {
        if (m.type === 'SUBCHAT_CHUNK') appendDelta(m.delta);
        else if (m.type === 'SUBCHAT_DONE') finalize();
        else if (m.type === 'SUBCHAT_ERROR') fail(m.message);
      });

      console.log('[subchat]', subId, 'sending SUBCHAT', subMessages);
      const res = await sendMessage({ type: 'SUBCHAT', subId, messages: subMessages });
      console.log('[subchat]', subId, 'SUBCHAT response', res);
      if (!res?.ok) fail(res?.error || 'Failed to start');
    } catch (e) {
      console.error('[subchat]', subId, 'send() threw', e);
      fail(e?.message || String(e));
    }
  }

  sendBtnEl.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  closeBtn.addEventListener('click', () => {
    if (inFlight) {
      sendMessage({ type: 'SUBCHAT_ABORT', subId });
      inFlight = false;
    }
    pacer?.destroy(); pacer = null;
    stopTurnPort();
    card.remove();
  });

  _insertCard(anchorEl, card);
  setTimeout(() => input.focus(), 50);
}
