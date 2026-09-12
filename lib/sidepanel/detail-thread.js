// lib/sidepanel/detail-thread.js — "select text in an assistant reply → scoped
// follow-up" side conversation, extracted verbatim from sidepanel.js
// (Phase 3 of the modularization refactor).
//
// UI name: 追问 / Follow up (i18n keys detailThreadLabel / detailThreadPlaceholder).
// The INTERNAL name stays "detail thread" / the `browsa-subchat` port / subId —
// only the user-facing wording changed.
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
import { escM, sendMessage, _findCard, _insertCard, showToast } from './ui-utils.js';
import { t as _t } from '../i18n.js';
import {
  renderSafe, renderMermaid, renderEcharts, renderMarkmap,
  addCodeCopyButtons, decorateLinks, makeStreamRenderer
} from './render.js';

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
  // overflow:hidden that `resize` itself requires). Named handlers so the
  // close button can remove them — anonymous window listeners here leaked one
  // mousemove/mouseup pair per opened-and-closed detail thread, each closing
  // over its detached card.
  let resizing = false, resizeStartY = 0, resizeStartHeight = 0;
  const onResizeMove = (e) => {
    if (!resizing) return;
    const next = resizeStartHeight + (e.clientY - resizeStartY);
    card.style.height = Math.max(140, Math.min(next, window.innerHeight * 0.8)) + 'px';
  };
  const onResizeEnd = () => { resizing = false; };
  resizeHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    resizing = true;
    resizeStartY = e.clientY;
    resizeStartHeight = card.getBoundingClientRect().height;
    e.preventDefault();
  });
  window.addEventListener('mousemove', onResizeMove);
  window.addEventListener('mouseup', onResizeEnd);

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

  // Post-render pipeline shared by finalize() and stopTurn() — the same steps
  // the main chat's DONE handler runs, scoped to this card's bubble.
  // (decorateLinks/linkify/addThinkCopyButtons are the stream renderer's own
  // isDone steps; only the heavy per-feature passes live here.)
  function postRender(el) {
    addCodeCopyButtons(el);
    renderMermaid(el);
    renderEcharts(el);
    renderMarkmap(el);
  }

  function appendDelta(delta) {
    if (!liveAiEl || !renderStream) return;
    rawAccum += delta;
    renderStream(delta, false);
  }

  // ─── Agent process surfacing (tool progress / approval / clarify) ─────────
  // Same UX as the main panel (sidepanel.js showToolProgress / showApprovalCard /
  // showClarifyCard), scoped to this card: a faint pre-bubble progress line and
  // interactive cards below the streaming bubble. Without this, an agent turn
  // (Hermes runs / opencode / bridge) that runs tools before answering sat in
  // total silence — no sign of work, and approval-gated tools stalled forever
  // (no card to answer them with). Chunks: SUBCHAT_TOOL_PROGRESS / _APPROVAL /
  // _CLARIFY; replies relay via SUBCHAT_APPROVAL_RESPOND / SUBCHAT_CLARIFY_RESPOND
  // (subId-keyed twins of the main chat's tabId-keyed APPROVAL/CLARIFY_RESPOND).

  // Keep in lockstep with sidepanel.js classifyToolTier (not imported: it's a
  // sidepanel-private and this module must not import sidepanel.js).
  function classifyToolTier(text) {
    const t = String(text).toLowerCase();
    if (/think|reason|analyz|consid/.test(t))           return { tier: 'thinking',  icon: ICONS.think };
    if (/search|fetch|web|http|url/.test(t))            return { tier: 'searching', icon: ICONS.search };
    if (/read|open|load|file|path/.test(t))             return { tier: 'reading',   icon: ICONS.book };
    if (/write|edit|creat|sav|updat/.test(t))           return { tier: 'writing',   icon: ICONS.edit };
    if (/run|exec|bash|shell|cmd|command/.test(t))      return { tier: 'running',   icon: ICONS.terminal };
    return { tier: '', icon: ICONS.gear };
  }

  function showToolProgress(text) {
    if (!liveAiEl) return;
    // Same pre-bubble slot the main panel uses (and the same element the
    // stream renderer's live think block inserts before) — process indicators
    // group above the answer, never below.
    let el = liveAiEl.previousElementSibling;
    if (!el || !el.classList.contains('tool-progress')) {
      el = document.createElement('div');
      el.className = 'tool-progress';
      liveAiEl.parentNode.insertBefore(el, liveAiEl);
    }
    const { tier, icon } = classifyToolTier(text);
    el.dataset.tier = tier;
    el.innerHTML = `<span class="tp-icon">${icon}</span><span class="tp-text">${escM(text)}</span>`;
  }

  function showApprovalCard(data) {
    if (!liveAiEl) return;
    removeAgentCards();
    const card = document.createElement('div');
    card.className = 'approval-card';
    const tool = escM(data.tool || data.function_name || 'unknown');
    const cmd  = data.command ? `<div class="approval-cmd"><code>${escM(data.command)}</code></div>` : '';
    const desc = data.description ? `<div class="approval-desc">${escM(data.description)}</div>` : '';
    const riskRaw = String(data.risk_level || 'high').toLowerCase();
    const risk = ['high', 'medium', 'low'].includes(riskRaw) ? riskRaw : 'high';
    const choices = Array.isArray(data.choices) && data.choices.length ? data.choices : ['once', 'deny'];
    const btnLabels = {
      once: _t('approvalAllowOnce', 'Allow once'),
      session: _t('approvalAllowSession', 'Allow for session'),
      always: _t('approvalAlwaysAllow', 'Always allow'),
      deny: _t('approvalDeny', 'Deny'),
    };
    const btns = choices.map(c => {
      const label = btnLabels[c] || c;
      const cls   = c === 'deny' ? 'approval-btn-deny' : 'approval-btn-allow';
      return `<button class="approval-btn ${cls}" data-choice="${escM(c)}">${escM(label)}</button>`;
    }).join('');
    card.innerHTML =
      `<div class="approval-header">` +
        `<span class="approval-icon">⚠️</span>` +
        `<span class="approval-title">${escM(_t('approvalRequired', 'Approval required:'))} <strong>${tool}</strong></span>` +
        `<span class="approval-risk approval-risk-${escM(risk)}">${escM(risk)}</span>` +
      `</div>` +
      cmd + desc +
      `<div class="approval-actions">${btns}</div>`;
    card.setAttribute('role', 'alert');
    card.setAttribute('aria-label', `${_t('approvalRequired', 'Approval required:')} ${data.tool || data.function_name || ''}`.trim());
    // subId pinned at render time — the relay is keyed by subId, so no
    // currentTabId-style staleness applies here (the card dies with the turn).
    card.dataset.subId = subId;
    card.querySelectorAll('.approval-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await sendMessage({ type: 'SUBCHAT_APPROVAL_RESPOND', subId, choice: btn.dataset.choice }).catch(() => null);
        if (!res?.data?.ok) showToast(_t('approvalSendFailed', '审批发送失败'), 'error');
        card.remove();
      });
    });
    liveAiEl.insertAdjacentElement('afterend', card);
    setTimeout(() => card.querySelector('.approval-btn')?.focus(), 50);
  }

  function showClarifyCard(data) {
    if (!liveAiEl) return;
    removeAgentCards();
    const card = document.createElement('div');
    card.className = 'clarify-card';
    const questionText = data.question || data.text || _t('clarifyDefault', 'Please clarify:');
    const question = escM(questionText);
    const inputLabel = _t('clarifyPlaceholder', 'Your response…');
    card.innerHTML =
      `<div class="clarify-question">${question}</div>` +
      `<div class="clarify-input-row">` +
        `<input type="text" class="clarify-input" aria-label="${escM(inputLabel)}" placeholder="${escM(inputLabel)}" />` +
        `<button class="clarify-submit">${escM(_t('clarifySend', 'Send'))}</button>` +
      `</div>`;
    card.setAttribute('role', 'alert');
    card.setAttribute('aria-label', questionText);
    card.dataset.subId = subId;
    const input  = card.querySelector('.clarify-input');
    const submit = card.querySelector('.clarify-submit');
    const respond = async () => {
      const response = input.value.trim();
      if (!response) return;
      const res = await sendMessage({ type: 'SUBCHAT_CLARIFY_RESPOND', subId, response }).catch(() => null);
      if (!res?.data?.ok) showToast(_t('replySendFailed', '回复发送失败'), 'error');
      card.remove();
    };
    submit.addEventListener('click', respond);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) respond(); });
    liveAiEl.insertAdjacentElement('afterend', card);
    setTimeout(() => input.focus(), 50);
  }

  function addProviderChip(el, label) {
    if (!label || el.querySelector('.msg-provider')) return;
    const chip = document.createElement('span');
    chip.className = 'msg-provider';
    chip.textContent = label;
    el.insertBefore(chip, el.firstChild);
  }

  // Remove this turn's agent cards (dedupe before re-show; turn-end teardown).
  // Scoped to this card's messagesWrap + subId — multiple detail-thread cards
  // can coexist, and main-panel cards must never be touched from here.
  function removeAgentCards() {
    messagesWrap.querySelectorAll(`.approval-card[data-sub-id="${subId}"], .clarify-card[data-sub-id="${subId}"]`)
      .forEach((c) => c.remove());
  }

  // Turn-end cleanup shared by finalize/stop/fail: the pre-bubble progress
  // line has no meaning once the turn settles, and an unanswered approval /
  // clarification card would orphan (its pending entry is already gone
  // server-side at this point). Takes the bubble element because both
  // finalize() and stopTurn() null the liveAiEl slot before cleanup.
  function clearTurnChrome(el) {
    el?.previousElementSibling?.classList.contains('tool-progress') &&
      el.previousElementSibling.remove();
    removeAgentCards();
  }

  async function finalize(providerLabel) {
    const el = liveAiEl;
    const finalRaw = rawAccum; // snapshot before state is reset below
    liveAiEl = null;
    if (!el) return;
    clearTurnChrome(el);
    const rs = renderStream;
    renderStream = null;
    if (rs) {
      // isDone branch: pacer drained to the exact final text, live think block
      // swapped for the final renderSafe one, .done added, onDone → postRender.
      await rs(finalRaw, true);
    } else {
      el.classList.add('done');
    }
    addProviderChip(el, providerLabel);
    subMessages.push({ role: 'assistant', content: finalRaw });
    inFlight = false;
    stopTurnPort();
    setBusy(false);
    input.focus();
  }

  // Stop mid-turn (■ button): abort the background stream but KEEP the card
  // and whatever already streamed — main-chat Esc semantics, scoped to this
  // thread. Partial text finalizes in place (so user/assistant alternation in
  // subMessages stays intact and the user can follow up); a turn with no text
  // at all cleans up like fail() does.
  async function stopTurn() {
    if (!inFlight) return;
    sendMessage({ type: 'SUBCHAT_ABORT', subId });
    const el = liveAiEl;
    const partial = rawAccum;
    liveAiEl = null;
    clearTurnChrome(el);
    const rs = renderStream;
    renderStream = null;
    if (rs) rs.destroy(); // stop pacer/rAF + remove any live think block
    if (el) {
      if (partial.trim()) {
        el.innerHTML = await renderSafe(partial);
        el.classList.add('done');
        el.dataset.raw = partial;
        decorateLinks(el);
        postRender(el);
        subMessages.push({ role: 'assistant', content: partial });
      } else {
        el.remove();
        if (subMessages.length && subMessages[subMessages.length - 1].role === 'user') {
          subMessages.pop();
        }
      }
    }
    inFlight = false;
    stopTurnPort();
    setBusy(false);
  }

  function fail(message) {
    if (renderStream) { renderStream.destroy(); renderStream = null; }
    clearTurnChrome(liveAiEl);
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
    liveAiEl = null; rawAccum = '';
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
      rawAccum = '';
      // The MAIN chat's stream renderer, not a private accumulate loop — this
      // is what gives the card the same live "Thinking…" collapsible for
      // reasoning models (llm-client inlines <thinking> blocks into the delta
      // stream for every apiStyle), the same paced reveal, and a .destroy()
      // the stop button can use for clean mid-stream teardown.
      renderStream = makeStreamRenderer(liveAiEl, {
        onTick: () => { messagesWrap.scrollTop = messagesWrap.scrollHeight; },
        onDone: (el) => postRender(el),
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
        else if (m.type === 'SUBCHAT_TOOL_PROGRESS') showToolProgress(m.text);
        else if (m.type === 'SUBCHAT_APPROVAL') showApprovalCard(m.data);
        else if (m.type === 'SUBCHAT_CLARIFY') showClarifyCard(m.data);
        else if (m.type === 'SUBCHAT_DONE') { if (m.truncated) showToast(_t('detailThreadTruncated', '追问回复已达模型输出上限，可回复「继续」续写'), 'info'); finalize(m.providerLabel); }
        else if (m.type === 'SUBCHAT_ERROR') fail(m.message);
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
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  closeBtn.addEventListener('click', () => {
    if (inFlight) {
      sendMessage({ type: 'SUBCHAT_ABORT', subId });
      inFlight = false;
    }
    if (renderStream) { renderStream.destroy(); renderStream = null; }
    clearTurnChrome(liveAiEl);
    stopTurnPort();
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeEnd);
    card.remove();
  });
  setBusy(false);

  _insertCard(anchorEl, card);
  setTimeout(() => input.focus(), 50);
}
