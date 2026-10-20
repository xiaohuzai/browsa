// lib/sidepanel/turn-chrome.js — the "turn chrome" DOM shared by the main chat
// (sidepanel.js) and detail-thread cards (detail-thread.js): everything that
// surrounds a streaming assistant bubble DURING a turn and is torn down when it
// settles — the 思考中… Ns wait indicator, the pre-bubble .tool-progress line,
// the folded .tool-history list, the token-usage chip, and the approval /
// clarification cards.
//
// This used to be ~250 lines of near-isomorphic private code in each file, held
// together by "keep in lockstep" comments — and it had ALREADY drifted (2026-09-23
// C8): detail-thread's approval-failure toast swallowed the reason while
// sidepanel's carried it, and only sidepanel's usage chip de-duplicated / took
// charge of its timer. Both drifts are converged HERE (the reason-carrying toast
// form and the de-duplicating chip with an explicit timer start); the only real
// per-surface differences left are the relay message names and the relay key,
// both parameters of createTurnChrome().
//
// createTurnChrome(cfg) — one instance per surface (the main chat holds one for
// the whole panel; every openDetailThread() card creates its own):
//   cfg.key   = { field, get, parse? } — the relay key PINNED on each card at
//               render time and sent back on respond: { field:'tabId',
//               get: () => currentTabId, parse: Number } for the main chat
//               (re-reading currentTabId at click time would mis-target after a
//               tab switch), { field:'subId', get: () => subId } for a card.
//   cfg.relay = { approval, clarify }  — runtime message names per surface
//               (APPROVAL_RESPOND / CLARIFY_RESPOND vs the SUBCHAT_* twins).
//   cfg.scope = Element (optional)     — root for agent-card lookups. A detail
//               thread passes its own .detail-thread-messages so its cards can
//               never collide with another card's or the main panel's.
//
// The config-free pieces (tool progress, tool-history fold, usage chip, provider
// chip) are exported as plain functions too — createTurnChrome() just bundles
// them with the instance state (wait indicator + card relay) so each call site
// keeps a ~10-30 line assembly.

import { ICONS } from './icons.js';
import { classifyToolTier } from './tool-tier.js';
import { escM, showToast, sendMessage, isImeComposing } from './ui-utils.js';
import { t as _t, tSub } from '../i18n.js';
import { get as storageGet } from '../storage.js';
import { maybePlayApprovalChime } from './approval-chime.js';
import { usageChipModel } from '../usage.js';

// ─── Wait indicator (first-token latency) ─────────────────────────────────────
// Between send and the first CHUNK / TOOL_PROGRESS / APPROVAL / CLARIFY the
// background pushes NOTHING — Hermes runs / long prefills sit silent for the
// whole window — so a 1s tick renders elapsed time in the same pre-bubble slot
// .tool-progress uses; the first real event stops it and hands the slot over.
// Per-instance state (a card and the main panel can stream at the same time),
// and the tick SELF-STOPS when its bubble detaches (renderHistory's innerHTML=''
// paths bypass every explicit teardown) instead of spinning forever (B7).

function createWaitIndicator() {
  let timer = null;
  let waitEl = null;
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    waitEl?.remove();
    waitEl = null;
  }
  function start(getEl) {
    stop();
    const t0 = Date.now();
    const render = () => {
      const bubble = getEl?.();
      if (!bubble || !bubble.isConnected) {
        // 气泡脱挂（renderHistory 整树重建等 innerHTML='' 路径绕过显式清理）：
        // 自停而不是每秒空转到永远（B7）。
        stop();
        return;
      }
      if (!waitEl || !waitEl.isConnected) {
        waitEl = document.createElement('div');
        waitEl.className = 'wait-indicator';
        bubble.parentNode.insertBefore(waitEl, bubble);
      }
      // Three-dot wave (sidepanel.css .wait-dots) instead of the old gear icon:
      // the dots ARE the live signal, so the line-level tool-pulse animation is
      // disabled for .wait-indicator and the text stops flickering with it.
      waitEl.innerHTML =
        `<span class="wait-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
        `<span class="tp-text">${escM(tSub('waitThinking', '思考中… $1s', Math.round((Date.now() - t0) / 1000)))}</span>`;
    };
    render();
    timer = setInterval(render, 1000);
  }
  return { start, stop };
}

// ─── Tool progress line ───────────────────────────────────────────────────────
// Positioned BEFORE the bubble (grouped with the live-think box, which uses the
// same insertBefore pattern in render.js's ensureThinkEl()) so "process"
// indicators (thinking, tool calls) sit together above the final answer instead
// of thinking above and tool-progress below. Whichever of {thinkEl, tool-progress}
// was most recently created/updated ends up closest to the bubble — not a full
// arrival-order timeline, but a reasonable approximation without redesigning
// the streaming DOM structure (tool-progress events have no position info the
// way <thinking> tags carry their own position in the reply markdown).
export function showToolProgress(bubbleEl, text, tierOverride) {
  if (!bubbleEl) return null;
  let el = bubbleEl.previousElementSibling;
  if (!el || !el.classList.contains('tool-progress')) {
    el = document.createElement('div');
    el.className = 'tool-progress';
    bubbleEl.parentNode.insertBefore(el, bubbleEl);
  }
  const { tier, icon } = tierOverride ? { tier: tierOverride, icon: ICONS.gear } : classifyToolTier(text);
  el.dataset.tier = tier;
  el.innerHTML = `<span class="tp-icon">${icon}</span><span class="tp-text">${escM(text)}</span>`;
  return el;
}

/** Remove the tool progress indicator once the reply is done. */
export function clearToolProgress(bubbleEl) {
  const el = bubbleEl?.previousElementSibling;
  if (el?.classList.contains('tool-progress')) el.remove();
}

// ─── Tool history fold ────────────────────────────────────────────────────────
// Fold the turn's tool events into a collapsed "N steps" list above the final
// bubble. Runs on DONE only: the abort paths don't fold (an aborted turn's
// events never became part of the reply).
export function renderToolHistory(bubbleEl, events) {
  if (!bubbleEl || !events.length) return;
  const details = document.createElement('details');
  details.className = 'tool-history';
  const summary = document.createElement('summary');
  // fallback 复刻旧的单复数渲染（约定：fallback=源文案逐字一致，jsdom 测试钉依赖）
  summary.innerHTML = `${ICONS.gear} ${tSub('toolHistorySteps', events.length > 1 ? '$1 steps' : '$1 step', events.length)}`;
  details.appendChild(summary);
  const ul = document.createElement('ul');
  for (const ev of events) {
    const li = document.createElement('li');
    // Re-use the same icon classification as showToolProgress
    const { icon } = classifyToolTier(ev);
    li.innerHTML = `${icon} ${escM(ev)}`;
    ul.appendChild(li);
  }
  details.appendChild(ul);
  bubbleEl.insertAdjacentElement('beforebegin', details);
}

// ─── Token usage chip ─────────────────────────────────────────────────────────
// Small chip below the finalized bubble. Provider vocabularies are normalized
// in lib/usage.js (OpenAI/DeepSeek/Responses/Anthropic/Hermes/OpenSquilla/
// opencode/agent-bridge); when the channel reports cached prompt tokens the
// chip adds `cache NN.N%` and the tooltip carries the absolute cached/write
// counts. Token/cache numbers come from the provider; the decode rate (t/s) is
// shown ONLY for turn-scoped usage, over a client-measured first-token → DONE
// window. Session-scoped channels (Hermes/OpenSquilla) never show a rate.
export function buildUsageChip(usage, scope, durationMs) {
  const model = usageChipModel(usage, scope, durationMs);
  if (!model) return null;
  const chip = document.createElement('div');
  chip.className = 'token-usage';
  chip.textContent = model.text;
  chip.title = model.title;
  return chip;
}

/** Insert the chip below the bubble, de-duplicating any existing one first
 * (a repeated DONE on the same bubble must not stack chips). */
export function insertUsageChip(bubbleEl, chip) {
  if (!bubbleEl || !chip) return;
  bubbleEl.nextElementSibling?.classList.contains('token-usage') &&
    bubbleEl.nextElementSibling.remove();
  bubbleEl.insertAdjacentElement('afterend', chip);
}

/** Build + insert in one step (main-chat DONE path). Returns the chip or null. */
export function showTokenUsage(bubbleEl, usage, scope, durationMs) {
  const chip = buildUsageChip(usage, scope, durationMs);
  if (!chip) return null;
  insertUsageChip(bubbleEl, chip);
  return chip;
}

// ─── Reply-source chip ────────────────────────────────────────────────────────
// Names the provider/agent that produced this reply (lib/provider-display.js
// label), using the SAME text the sidebar dropdown shows. Sits at the TOP-LEFT
// of the bubble like a sender label (a footer at the bottom-right read as
// metadata and surprised users) — so it is PREPENDED, and must survive the
// async renderSafe upgrade (it wipes innerHTML) — same re-add discipline as
// .msg-actions. Idempotent.
export function addProviderChip(el, label) {
  if (!label || el.querySelector('.msg-provider')) return;
  const chip = document.createElement('span');
  chip.className = 'msg-provider';
  chip.textContent = label;
  el.insertBefore(chip, el.firstChild);
}

// ─── Per-surface bundle ───────────────────────────────────────────────────────
export function createTurnChrome({ key, relay, scope }) {
  const wait = createWaitIndicator();
  // `data-tabId`-style dataset keys map to `data-tab-id` attributes; the
  // presence filter (value-agnostic) below keys on the ATTRIBUTE NAME, which is
  // what isolates the surfaces: main-chat cards carry data-tab-id, a detail
  // thread's carry data-sub-id, and neither may ever remove the other's.
  const dataAttr = 'data-' + String(key.field).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  const keyParse = key.parse || ((v) => v);

  // Remove this surface's agent cards (turn-end teardown). Scoped to `scope`
  // + the key attribute so multiple surfaces coexist safely. NOT called when a
  // new card shows — concurrent requests stack (2026-10-15); each card is
  // deduped by its own reqKey instead.
  function removeAgentCards() {
    agentCards().forEach((c) => c.remove());
  }

  // This surface's agent cards in document order (insertion order, oldest
  // first). Scoped to `scope` + the key attribute.
  function agentCards() {
    const root = scope || document;
    return [...root.querySelectorAll(`.approval-card[${dataAttr}], .clarify-card[${dataAttr}]`)];
  }

  // Insert after the LAST existing agent card so stacked cards keep
  // chronological order (request order); plain _insertCard would slot each
  // new card between the bubble and the previous ones, reversing them.
  function insertAgentCard(bubbleEl, card) {
    const cards = agentCards();
    (cards.length ? cards[cards.length - 1] : bubbleEl)?.insertAdjacentElement('afterend', card);
  }

  /**
   * Show an approval request card below the streaming bubble — the agent has
   * paused and needs the user to allow/deny a dangerous action. The relay key is
   * pinned at RENDER time (the background keyed the pending entry by it; reading
   * a live tab id at click time mis-targets after a tab switch and orphans the
   * pending approval). `reqKey` is the pending entry's own map key — the click
   * relays through it so concurrently stacked cards each answer their OWN
   * request; a re-show of the same reqKey is a no-op (dedupe).
   */
  function showApprovalCard(bubbleEl, data, reqKey) {
    if (!bubbleEl) return;
    wait.stop();
    const root = scope || document;
    if (reqKey && root.querySelector(`.approval-card[${dataAttr}][data-req-key="${reqKey}"]`)) return;
    const card = document.createElement('div');
    card.className = 'approval-card';
    const tool = escM(data.tool || data.function_name || 'unknown');
    const cmd  = data.command ? `<div class="approval-cmd"><code>${escM(data.command)}</code></div>` : '';
    const desc = data.description ? `<div class="approval-desc">${escM(data.description)}</div>` : '';
    // Clamp to a known set: this value lands in a class name, so an agent-chosen
    // string with spaces/quotes would otherwise inject extra classes or markup.
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
    // Announce the blocked prompt to assistive tech (it's inserted after the
    // bubble with no role) and give the buttons an accessible name context.
    card.setAttribute('role', 'alert');
    card.setAttribute('aria-label', `${_t('approvalRequired', 'Approval required:')} ${data.tool || data.function_name || ''}`.trim());
    card.dataset[key.field] = String(key.get?.() ?? '');
    card.dataset.reqKey = String(reqKey ?? '');
    card.querySelectorAll('.approval-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await sendMessage({ type: relay.approval, [key.field]: keyParse(card.dataset[key.field]), reqKey: card.dataset.reqKey, choice: btn.dataset.choice }).catch(() => null);
        // Failures carry the reason (converged 2026-09-23 C8 — the detail-thread
        // copy used to swallow it behind a bare "审批发送失败"). The card STAYS
        // on failure so the user can retry; the background likewise keeps the
        // pending entry until a successful relay.
        if (!res?.data?.ok) {
          showToast(tSub('approvalSendFailed', '审批发送失败：$1', res?.data?.error || res?.error || _t('bgStateLost', '扩展后台已重置，请重试')), 'error');
          return;
        }
        card.remove();
      });
    });
    insertAgentCard(bubbleEl, card);
    // Attention-recall chime (2026-10-17): an approval blocks the agent and
    // waits for the user, who may be on another tab. Fire-and-forget; reads
    // the approvalChime setting itself and degrades to silence on any failure.
    maybePlayApprovalChime({ get: storageGet });
    // Move keyboard focus to the first action so the blocked prompt is operable
    // without a mouse.
    setTimeout(() => card.querySelector('.approval-btn')?.focus(), 50);
  }

  /** Show an agent clarification question card below the streaming bubble.
   * reqKey semantics mirror showApprovalCard (stacking + per-card routing). */
  function showClarifyCard(bubbleEl, data, reqKey) {
    if (!bubbleEl) return;
    wait.stop();
    const root = scope || document;
    if (reqKey && root.querySelector(`.clarify-card[${dataAttr}][data-req-key="${reqKey}"]`)) return;
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
    card.dataset[key.field] = String(key.get?.() ?? '');
    card.dataset.reqKey = String(reqKey ?? '');
    const input  = card.querySelector('.clarify-input');
    const submit = card.querySelector('.clarify-submit');
    const respond = async () => {
      const response = input.value.trim();
      if (!response) return;
      const res = await sendMessage({ type: relay.clarify, [key.field]: keyParse(card.dataset[key.field]), reqKey: card.dataset.reqKey, response }).catch(() => null);
      if (!res?.data?.ok) {
        showToast(tSub('replySendFailed', '回复发送失败：$1', res?.data?.error || res?.error || _t('bgStateLost', '扩展后台已重置，请重试')), 'error');
        return;
      }
      card.remove();
    };
    submit.addEventListener('click', respond);
    // isImeComposing: Enter that confirms an IME candidate is NOT a submit.
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !isImeComposing(e)) respond(); });
    insertAgentCard(bubbleEl, card);
    setTimeout(() => input.focus(), 50);
  }

  // Turn-end cleanup shared by finalize/stop/fail: the pre-bubble progress line
  // has no meaning once the turn settles, and an unanswered approval /
  // clarification card would orphan (its pending entry is already gone
  // server-side at this point). Takes the bubble element because callers null
  // their live-bubble slot before cleanup.
  function clearTurnChrome(bubbleEl) {
    wait.stop();
    clearToolProgress(bubbleEl);
    removeAgentCards();
  }

  return {
    startWait: wait.start,
    stopWait: wait.stop,
    showToolProgress: (bubbleEl, text, tierOverride) => {
      wait.stop(); // the first real event hands the pre-bubble slot over
      return showToolProgress(bubbleEl, text, tierOverride);
    },
    clearToolProgress,
    renderToolHistory,
    showTokenUsage,
    addProviderChip,
    showApprovalCard,
    showClarifyCard,
    removeAgentCards,
    clearTurnChrome,
  };
}
