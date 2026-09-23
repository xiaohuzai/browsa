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
import { escM, showToast, sendMessage, isImeComposing, _insertCard } from './ui-utils.js';
import { t as _t, tSub } from '../i18n.js';

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
      waitEl.innerHTML =
        `<span class="tp-icon">${ICONS.gear}</span>` +
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
  summary.innerHTML = `${ICONS.gear} ${events.length} step${events.length > 1 ? 's' : ''}`;
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
// Small chip below the finalized bubble. Handles both usage vocabularies:
// OpenAI {prompt_tokens, completion_tokens} and Hermes runs {input_tokens,
// output_tokens}. `startedAtMs` is EXPLICIT (first-chunk timestamp owned by the
// caller) — the two surfaces used to each reach for their own timer source
// (a module global vs a closure var), which is how the drift started.
//
// buildUsageChip/insertUsageChip are separate so a caller can snapshot the
// t/s + duration BEFORE an async final render and still insert after it (the
// detail-thread finalize() contract: timing = first chunk → DONE arrival).
export function buildUsageChip(usage, startedAtMs) {
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? null;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? null;
  if (prompt == null && completion == null) return null;
  const durationMs = startedAtMs ? Date.now() - startedAtMs : 0;
  const tps = (durationMs > 200 && completion > 0)
    ? Math.round(completion / (durationMs / 1000)) : 0;
  const durationSec = durationMs > 0 ? (durationMs / 1000).toFixed(1) : null;
  const chip = document.createElement('div');
  chip.className = 'token-usage';
  const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const parts = [];
  if (prompt != null) parts.push(`↑ ${fmtK(prompt)}`);
  if (completion != null) parts.push(`↓ ${fmtK(completion)}`);
  if (tps > 0) parts.push(`${tps} t/s`);
  if (durationSec) parts.push(`${durationSec}s`);
  chip.textContent = parts.join(' · ');
  chip.title = `Prompt: ${prompt ?? '?'} · Completion: ${completion ?? '?'}` +
               (usage.total_tokens ? ` · Total: ${usage.total_tokens}` : '') +
               (tps ? ` · ${tps} tok/s` : '') +
               (durationMs ? ` · ${(durationMs / 1000).toFixed(2)}s` : '');
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
export function showTokenUsage(bubbleEl, usage, startedAtMs) {
  const chip = buildUsageChip(usage, startedAtMs);
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

  // Remove this surface's agent cards (dedupe before re-show; turn-end
  // teardown). Scoped to `scope` + the key attribute so multiple surfaces
  // coexist safely.
  function removeAgentCards() {
    const root = scope || document;
    root.querySelectorAll(`.approval-card[${dataAttr}], .clarify-card[${dataAttr}]`)
      .forEach((c) => c.remove());
  }

  /**
   * Show an approval request card below the streaming bubble — the agent has
   * paused and needs the user to allow/deny a dangerous action. The relay key is
   * pinned at RENDER time (the background keyed the pending entry by it; reading
   * a live tab id at click time mis-targets after a tab switch and orphans the
   * pending approval).
   */
  function showApprovalCard(bubbleEl, data) {
    if (!bubbleEl) return;
    wait.stop();
    removeAgentCards();
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
    card.querySelectorAll('.approval-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await sendMessage({ type: relay.approval, [key.field]: keyParse(card.dataset[key.field]), choice: btn.dataset.choice }).catch(() => null);
        // Failures carry the reason (converged 2026-09-23 C8 — the detail-thread
        // copy used to swallow it behind a bare "审批发送失败").
        if (!res?.data?.ok) showToast(tSub('approvalSendFailed', '审批发送失败：$1', res?.data?.error || res?.error || _t('bgStateLost', '后台状态已丢失')), 'error');
        card.remove();
      });
    });
    _insertCard(bubbleEl, card);
    // Move keyboard focus to the first action so the blocked prompt is operable
    // without a mouse.
    setTimeout(() => card.querySelector('.approval-btn')?.focus(), 50);
  }

  /** Show an agent clarification question card below the streaming bubble. */
  function showClarifyCard(bubbleEl, data) {
    if (!bubbleEl) return;
    wait.stop();
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
    card.dataset[key.field] = String(key.get?.() ?? '');
    const input  = card.querySelector('.clarify-input');
    const submit = card.querySelector('.clarify-submit');
    const respond = async () => {
      const response = input.value.trim();
      if (!response) return;
      const res = await sendMessage({ type: relay.clarify, [key.field]: keyParse(card.dataset[key.field]), response }).catch(() => null);
      if (!res?.data?.ok) showToast(tSub('replySendFailed', '回复发送失败：$1', res?.data?.error || res?.error || _t('bgStateLost', '后台状态已丢失')), 'error');
      card.remove();
    };
    submit.addEventListener('click', respond);
    // isImeComposing: Enter that confirms an IME candidate is NOT a submit.
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !isImeComposing(e)) respond(); });
    _insertCard(bubbleEl, card);
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
