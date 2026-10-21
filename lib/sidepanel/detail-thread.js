// lib/sidepanel/detail-thread.js — "select text in an assistant reply → scoped
// follow-up" side conversation, extracted verbatim from sidepanel.js
// (Phase 3 of the modularization refactor).
//
// UI name: 追问 / Follow up (i18n keys detailThreadLabel / detailThreadPlaceholder).
// The INTERNAL name stays "detail thread" / the `browsa-subchat` port / subId —
// only the user-facing wording changed.
//
// Persistence (2026-10-20 user report): the card used to be pure DOM, so
// closing the side panel (Chrome tears the panel document down) discarded an
// open card. The card's display/wire state is now snapshotted to
// chrome.storage.session (lib/sidepanel/detail-thread-store.js) and restored
// by restoreDetailThreads() after renderHistory() paints the messages. Still
// NOT main history / saved sessions: running out of the browser session drops
// it, closing the card deletes it, and new-chat / clear / session-switch
// clears it. Context sent to the LLM stays deliberately narrow (the selected
// excerpt + the full reply it came from), not the whole main conversation.
//
// Self-contained: no sidepanel.js-owned mutable state is needed (subMessages/
// liveAiEl/etc. are all local to a single openDetailThread() call), so this
// module wires its own top-level mouseup/scroll listeners on import instead
// of needing an initDetailThread() call from sidepanel.js.

import { ICONS } from './icons.js';
import { escM, sendMessage, _findCard, _insertCard, showToast, isImeComposing } from './ui-utils.js';
import { createInputHistory } from './composer-state.js';
import { t as _t } from '../i18n.js';
import { ingestImageFiles, pastedImageFiles, renderImageStrip } from './image-drop.js';
import { createTurnChrome, buildUsageChip, insertUsageChip } from './turn-chrome.js';
import {
  renderSafe, finishBubble,
  makeStreamRenderer, renderMathInPlainText, disposeRenderInstancesIn
} from './render.js';
import { selectionTextWithMath } from './math-copy.js';
import {
  hashText, loadDetailThreads, saveDetailThread, deleteDetailThread, clearDetailThreadStore
} from './detail-thread-store.js';

const messagesEl = () => document.getElementById('messages');

// The card's OWN ↑/↓ recall scope, deliberately separate from the main
// composer's (user direction 2026-09-21): ↑ in a card recalls previous 追问
// questions, never main-chat sends. All cards share this one scope.
const cardHistory = createInputHistory({ storageKey: 'subchatInputHistory' });
// Pull the persisted list in at import — fire-and-forget; the storage read
// resolves long before a user can open a card and press ↑.
cardHistory.loadInputHistory();

let selectionAskBtn = null;
// The selection the ask-button currently represents. Captured on EVERY mouseup
// and re-read on mousedown: the button element is created once and reused, so a
// closure over the first selection silently anchored/highlighted the FIRST
// passage on every later use (2026-10-21 user report: "the selection highlight
// disappeared").
let pendingSelection = null; // { bubbleEl, range, text }

export function hideSelectionAskBtn() {
  if (selectionAskBtn) { selectionAskBtn.remove(); selectionAskBtn = null; }
}

/**
 * Pick the anchor the detail-thread card sits under: the `li` the selection
 * ends in when it ends inside a list (a card opened on item 2 of a 10-item
 * list must land under item 2, not under the whole list — 2026-09-28 user
 * report), else the nearest top-level block (direct child of `bubbleEl` —
 * the paragraph/heading/fence the selection ends in), else the bubble itself.
 * A plain `div` between `li`s renders fine and the list counter counts only
 * `li`s (numbering unaffected), so `li` is the ONLY sub-block anchor —
 * inserting into a `blockquote`/`td` would put the card inside the
 * quote/table instead of after it.
 */
export function findBlockAnchor(node, bubbleEl) {
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const li = node?.closest?.('li');
  if (li && bubbleEl && bubbleEl.contains(li)) return li;
  while (node && node !== bubbleEl && node.parentElement !== bubbleEl) {
    node = node.parentElement;
  }
  return (node && node !== bubbleEl) ? node : bubbleEl;
}

// ─── Anchor addressing (persistence only) ──────────────────────────────────
// Render history re-creates every bubble from storage; the card's anchor must
// be re-found inside the fresh DOM. A child-index path (bubble → … → anchor) is
// NOT sufficient on its own: renderHistory paints a SYNC render
// (renderStreamingSafe) first and upgrades to the full render later, and the
// two disagree structurally whenever the reply has a <think> block (two plain
// paragraphs in the sync render, one <details> in the full render). A path
// saved against one render then resolves to the wrong element — or past the end,
// which used to drop the card at the end of the whole reply (2026-10-21 user
// report). The anchor's TEXT survives that drift, so text is the primary
// address and the index path is the fallback.
function anchorPathFrom(bubbleEl, anchorEl) {
  if (!bubbleEl || !anchorEl || anchorEl === bubbleEl) return [];
  const path = [];
  let node = anchorEl;
  while (node && node !== bubbleEl) {
    const parent = node.parentElement;
    if (!parent) return [];
    path.push([...parent.children].indexOf(node));
    node = parent;
  }
  return node === bubbleEl ? path.reverse() : [];
}

function resolveAnchorPath(bubbleEl, path) {
  if (!bubbleEl || !Array.isArray(path) || path.length === 0) return bubbleEl;
  let node = bubbleEl;
  for (const i of path) {
    if (!Number.isInteger(i) || i < 0) return null;
    node = node.children?.[i];
    if (!node) return null;
  }
  return node;
}

const ANCHOR_TEXT_CAP = 200;
const normAnchorText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Stable text identity of an anchor block (normalized, capped). */
function anchorTextOf(el) {
  const root = el === messagesEl() ? null : el;
  return root ? normAnchorText(root.textContent).slice(0, ANCHOR_TEXT_CAP) : '';
}

// The only elements a card can be anchored under (mirrors findBlockAnchor):
// top-level blocks and list items. Cards nested in the bubble are skipped —
// their own content must never become a match target.
function anchorCandidates(bubbleEl) {
  const out = [];
  for (const child of bubbleEl.children) {
    if (child.classList?.contains('detail-thread-card')) continue;
    out.push(child);
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      for (const li of child.children) if (li.tagName === 'LI') out.push(li);
    }
  }
  return out;
}

function findAnchorByText(bubbleEl, text) {
  const want = normAnchorText(text);
  if (!bubbleEl || !want) return null;
  const cands = anchorCandidates(bubbleEl);
  const texts = cands.map((c) => normAnchorText(c.textContent));
  const exact = texts.indexOf(want);
  if (exact >= 0) return cands[exact];
  // The saved copy is the anchor block's text capped at 200 chars, so a long
  // block matches by prefix; a saved selection quote is a fragment of the
  // block and matches by inclusion (shortest containing block wins).
  const starts = texts.findIndex((t) => t.startsWith(want));
  if (starts >= 0) return cands[starts];
  let best = -1;
  for (let i = 0; i < texts.length; i++) {
    if (!texts[i].includes(want)) continue;
    if (best < 0 || texts[i].length < texts[best].length) best = i;
  }
  return best >= 0 ? cands[best] : null;
}

/**
 * Resolve an anchor from its saved identity. The text wins over the index
 * path; the path is still trusted when its element's text agrees (fast path)
 * and remains the fallback for records written before anchorText existed or
 * when a formula makes the two renders' text incomparable.
 */
function resolveAnchorFor(bubbleEl, path, text) {
  if (!bubbleEl) return null;
  const byPath = resolveAnchorPath(bubbleEl, path);
  const want = normAnchorText(text);
  if (!want) return byPath;
  if (byPath && byPath !== bubbleEl) {
    const have = normAnchorText(byPath.textContent);
    if (have === want || have.startsWith(want) || have.includes(want)) return byPath;
  }
  return findAnchorByText(bubbleEl, want) || byPath;
}

// Exported for sidepanel.js's render paths: replacing a bubble's innerHTML
// destroys cards nested in it, so the caller captures each card's anchor
// path, renders, then re-inserts the card after the fresh DOM.
export { anchorPathFrom, resolveAnchorPath };

/** Capture cards nested inside `el` with the anchor path + text they sit under. */
export function captureDetailCardsIn(el) {
  if (!el?.querySelectorAll) return [];
  return [...el.querySelectorAll('.detail-thread-card')].map((card) => {
    let anchor = card.previousElementSibling;
    while (anchor && anchor.classList?.contains('detail-thread-card')) {
      anchor = anchor.previousElementSibling;
    }
    // Cards anchored to the bubble itself are siblings and are not captured
    // here; only a nested card carries a text identity worth matching.
    const anchorEl = anchor && anchor !== el ? anchor : null;
    return { card, path: anchorPathFrom(el, anchorEl || el), text: anchorTextOf(anchorEl) };
  });
}

/** Re-insert captured cards into the freshly rendered `el`. */
export function reinsertDetailCards(el, captured) {
  if (!el || !Array.isArray(captured) || captured.length === 0) return;
  const tails = new Map(); // path -> last card re-inserted for ordering
  for (const { card, path, text } of captured) {
    const key = (path || []).join('/');
    const anchor = resolveAnchorFor(el, path, text) || el;
    _insertCard(tails.get(key) || anchor, card);
    tails.set(key, card);
  }
}

/**
 * Cards that had to be placed after the bubble (the sync render lacked their
 * anchor block) carry `data-anchor-path`; once the full render exists, move
 * them under the real paragraph/list item.
 */
export function moveSiblingDetailCards(el) {
  if (!el) return;
  const cards = [];
  let sib = el.nextElementSibling;
  while (sib && sib.classList?.contains('detail-thread-card')) {
    cards.push(sib);
    sib = sib.nextElementSibling;
  }
  if (cards.length === 0) return;
  const tails = new Map();
  for (const card of cards) {
    let path = [];
    try { path = JSON.parse(card.dataset.anchorPath || '[]'); } catch (_) {}
    const text = card.dataset.anchorText || '';
    if ((!Array.isArray(path) || path.length === 0) && !text) continue;
    const anchor = resolveAnchorFor(el, path, text);
    if (!anchor || anchor === el) continue;
    const key = (path || []).join('/');
    _insertCard(tails.get(key) || anchor, card);
    tails.set(key, card);
  }
}

function hostRawOf(el) {
  return el?.dataset?.raw || el?.innerText || '';
}

function hostMatches(el, rec) {
  // Check both the raw Markdown and the rendered text: a card opened while the
  // host reply was still streaming fingerprinted innerText (dataset.raw only
  // exists once the main turn finishes), and the final bubble's raw Markdown
  // would never prefix-match that.
  const candidates = [el?.dataset?.raw, el?.innerText].filter(
    (t) => typeof t === 'string' && t.length > 0
  );
  for (const text of candidates) {
    if (rec.hostHash && hashText(text) === rec.hostHash) return true;
    // Streaming-growth fallback: the finished text starts with the partial one.
    if (rec.hostPrefix && text.length >= 40 && text.startsWith(rec.hostPrefix)) return true;
  }
  return false;
}

function findHostBubble(rec) {
  const bubbles = [...messagesEl().children].filter(
    (el) => el.classList?.contains('msg') && el.classList?.contains('assistant')
  );
  const hidx = Number.isInteger(rec.hidx) ? rec.hidx : null;
  if (hidx !== null) {
    const byIdx = bubbles.find((el) => Number(el.dataset.hidx) === hidx);
    if (byIdx && hostMatches(byIdx, rec)) return byIdx;
  }
  const exact = bubbles.find((el) => rec.hostHash
    && [el.dataset.raw, el.innerText].some((t) => typeof t === 'string' && t && hashText(t) === rec.hostHash));
  if (exact) return exact;
  if (hidx !== null) {
    const byIdx = bubbles.find((el) => Number(el.dataset.hidx) === hidx);
    if (byIdx && hostMatches(byIdx, rec)) return byIdx;
    // A card opened MID-STREAM persisted a fingerprint of the partial reply,
    // and the finished reply's innerText/raw need not start with it (a think
    // block's summary label is the common divergence). The storage index is
    // still the reply's identity; accept it only when the saved selection text
    // is actually present, so a truncated/regenerated entry can't steal a card.
    if (byIdx && recordTextLivesIn(byIdx, rec)) return byIdx;
  }
  return null;
}

function recordTextLivesIn(bubbleEl, rec) {
  const wanted = normAnchorText(rec.anchorText)
    || normAnchorText(rec.highlightRange?.text)
    || normAnchorText(rec.quotedText);
  if (!wanted) return false;
  const hay = normAnchorText(bubbleEl.dataset.raw || bubbleEl.innerText || '')
    + ' ' + normAnchorText(bubbleEl.textContent || '');
  return hay.includes(wanted.slice(0, 200));
}

// Live cards, keyed by subId. Only used for pagehide flushing and for the
// new-chat/clear/session-switch teardown.
const activeCards = new Map();
// Bumped by clearDetailThreads(). A restore that started before the clear
// must not resurrect the records it already read (user can hit "new chat"
// while the very first restore is still rendering).
let threadsEpoch = 0;

function flushActiveCards() {
  for (const entry of activeCards.values()) {
    try { entry.flush(); } catch (_) {}
  }
}

window.addEventListener('pagehide', () => {
  flushActiveCards();
  for (const entry of activeCards.values()) {
    try { entry.unload?.(); } catch (_) {}
  }
});
// Chrome does not reliably fire pagehide for a torn-down side panel. Flush
// whenever the page is hidden too, so a mid-stream close keeps the latest
// streamed text (the 1s-throttled writes alone lose up to a second of it).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushActiveCards();
});
window.addEventListener('unload', flushActiveCards);

// ─── The quoted selection, highlighted in the host reply (2026-10-21) ─────
// CSS Custom Highlight API: ranges never touch the host DOM, so the highlight
// survives innerHTML rebuilds by re-creating the range from stored TEXT OFFSETS
// (a DOM Range itself dies with the nodes it points at). One shared highlight
// holds one range per open card; plain `::highlight(detail-thread-quote)` CSS
// paints it in --gold (the margin-annotation color, same family as the quote
// rail). No CSS.highlights (jsdom) = silently no highlight.
const HIGHLIGHT_NAME = 'detail-thread-quote';
let quoteHighlight = null;
const highlightRanges = new Map(); // subId -> Range

function getQuoteHighlight() {
  try {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return null;
    if (!quoteHighlight) {
      quoteHighlight = new Highlight();
      CSS.highlights.set(HIGHLIGHT_NAME, quoteHighlight);
    }
    return quoteHighlight;
  } catch (_) {
    return null;
  }
}

function removeCardHighlight(subId) {
  const range = highlightRanges.get(subId);
  if (range && quoteHighlight) { try { quoteHighlight.delete(range); } catch (_) {} }
  highlightRanges.delete(subId);
}

function textOffsetOfPoint(root, container, offset) {
  try {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(container, offset);
    return r.toString().length;
  } catch (_) {
    return null;
  }
}

function selectionOffsetsIn(root, range) {
  if (!root || !range) return null;
  try {
    if (typeof range.intersectsNode === 'function' && !range.intersectsNode(root)) return null;
  } catch (_) { return null; }
  const start = root.contains(range.startContainer)
    ? textOffsetOfPoint(root, range.startContainer, range.startOffset) : 0;
  const end = root.contains(range.endContainer)
    ? textOffsetOfPoint(root, range.endContainer, range.endOffset) : (root.textContent || '').length;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function rangeFromOffsets(root, spec) {
  const start = Number(spec?.start);
  const end = Number(spec?.end);
  if (!root || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0, node;
  while ((node = walker.nextNode())) {
    const len = node.data.length;
    if (startNode === null && start >= pos && start <= pos + len) {
      startNode = node; startOffset = Math.min(len, start - pos);
    }
    if (endNode === null && end >= pos && end <= pos + len) {
      endNode = node; endOffset = Math.min(len, end - pos);
    }
    if (startNode && endNode) break;
    pos += len;
  }
  if (!startNode || !endNode) return null;
  try {
    const r = document.createRange();
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    return r;
  } catch (_) {
    return null;
  }
}

function applyCardHighlight(subId, bubbleEl, spec, quoteText) {
  const h = getQuoteHighlight();
  if (!h) return;
  removeCardHighlight(subId);
  if (!bubbleEl || !bubbleEl.isConnected || !spec) return;
  // `spec.text` is the RENDERED selection captured at creation time.
  // `quoteText` is what the card/model sees, which for a selection containing
  // KaTeX is the LaTeX source ($x=2$), not the text painted in the bubble
  // (MathML + HTML copies of "x=2"). Validating rendered offsets against the
  // LaTeX source rejected a perfectly good range and the reply lost its
  // highlight (2026-10-21 user report). Prefer the rendered fingerprint;
  // fall back to the quote for records written before it was stored.
  const renderedText = typeof spec.text === 'string' ? spec.text : '';
  const expected = String(renderedText || quoteText || '').replace(/\s+/g, ' ').trim();
  let range = rangeFromOffsets(bubbleEl, spec);
  // Text offsets are measured on RENDERED text, and chrome around the content
  // (provider chip, timestamps) can differ between the live bubble and the
  // rebuilt one. If the offsets now land on a different passage, fall back to
  // locating the selection text itself.
  if (range && expected) {
    const got = range.toString().replace(/\s+/g, ' ').trim();
    if (got && got !== expected && !expected.includes(got) && !got.includes(expected)) {
      range = null;
    }
  }
  if (!range && expected) {
    const content = bubbleEl.textContent || '';
    let at = content.indexOf(expected);
    let len = expected.length;
    if (at < 0) {
      const raw = String(renderedText || quoteText || '');
      at = content.indexOf(raw);
      len = raw.length;
    }
    if (at >= 0) range = rangeFromOffsets(bubbleEl, { start: at, end: at + len });
  }
  if (!range) return;
  try {
    h.add(range);
    highlightRanges.set(subId, range);
  } catch (_) { /* highlight is decoration — never break the card */ }
}

/** Rebuild the quote highlights against a freshly rendered host bubble. */
export function refreshDetailHighlights(bubbleEl) {
  for (const entry of activeCards.values()) {
    if (bubbleEl && entry.host !== bubbleEl) continue;
    try { entry.rehighlight?.(); } catch (_) {}
  }
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

  // 公式感知提取（2026-09-26 用户报告）：选区碰到 .katex 时吸附为整体并取
  // LaTeX（$…$/$$…$$）——sel.toString() 拿到的是 MathML 逐记号换行的碎片；
  // 没碰到公式时逐字等于 toString()。这条文本同时是引用块显示源和模型上下文。
  // Captured here (while the selection is definitely alive) rather than in the
  // button handler, which runs later and must not depend on a stale closure.
  const quoteText = (selectionTextWithMath(sel) ?? sel.toString()).trim();
  pendingSelection = { bubbleEl, range: range.cloneRange(), text: quoteText };

  if (!selectionAskBtn) {
    selectionAskBtn = document.createElement('button');
    selectionAskBtn.className = 'selection-ask-btn';
    selectionAskBtn.innerHTML = `${ICONS.chat}<span>${escM(_t('detailThreadLabel', '追问'))}</span>`;
    // mousedown (not click): fires before the browser clears the selection
    // on the subsequent click. The text/range come from pendingSelection,
    // refreshed on every mouseup — never from this closure's creation time.
    selectionAskBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pending = pendingSelection;
      if (!pending || !pending.bubbleEl?.isConnected) { hideSelectionAskBtn(); return; }
      // Anchor on the selection's END (reading-order last point) so the
      // card appears right after what was selected, not before it.
      const anchorEl = findBlockAnchor(pending.range.endContainer, pending.bubbleEl);
      // Persist the selection as text offsets in the host reply so the same
      // passage can be highlighted again after a panel reopen. The rendered
      // text rides along as the fingerprint used to verify those offsets — it
      // differs from the quote when the selection contains a formula
      // (quote = LaTeX source, bubble = rendered MathML/HTML).
      const offsets = selectionOffsetsIn(pending.bubbleEl, pending.range);
      const highlightRange = offsets
        ? { ...offsets, text: pending.range.toString().slice(0, 600) }
        : null;
      hideSelectionAskBtn();
      openDetailThread(pending.bubbleEl, pending.text, anchorEl, highlightRange);
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

// Card height resize: drag the bottom handle, or focus it and use Up/Down
// (20px steps). Extracted from openDetailThread (2026-10-17) — it needs only
// the card element, so it is self-contained.
//
// Native CSS `resize` exists but its grip is easy to miss (clipped by the
// card's border-radius + the overflow:hidden that `resize` itself requires).
// The window listeners exist ONLY for the duration of an active drag (added on
// handle mousedown, removed on mouseup): listeners added once at card creation
// leak every time a card is destroyed WITHOUT its close handler —
// renderHistory/newSession/clearChatHistory wipe messagesEl.innerHTML
// directly — each leaked pair retaining its detached card subtree.
const CARD_MIN_HEIGHT = 140;

function wireCardResize(card, handle, onResize) {
  const clampTo = (h) => Math.max(CARD_MIN_HEIGHT, Math.min(h, window.innerHeight * 0.8));
  let startY = 0, startHeight = 0;
  const onMove = (e) => { card.style.height = clampTo(startHeight + (e.clientY - startY)) + 'px'; };
  const onEnd = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onEnd);
    onResize?.();
  };
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    startY = e.clientY;
    startHeight = card.getBoundingClientRect().height;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    e.preventDefault();
  });
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = card.getBoundingClientRect().height;
    card.style.height = clampTo(cur + (e.key === 'ArrowDown' ? 20 : -20)) + 'px';
    onResize?.();
  });
  // Detach any drag-scoped window listeners when the card is closed mid-drag.
  return { dispose: onEnd };
}

/**
 * Open (or focus, if already open) an inline "detail thread" card right
 * after the specific block (paragraph/list/heading/etc.) the selection
 * ended in — not after the whole (possibly much longer) reply — scoped to
 * a quoted excerpt from that reply. anchorEl defaults to bubbleEl itself
 * if the caller doesn't have a more specific block element.
 */
export function openDetailThread(bubbleEl, quotedText, anchorEl, highlightRange) {
  anchorEl = anchorEl || bubbleEl;
  const existing = _findCard(anchorEl, 'detail-thread-card');
  if (existing) {
    existing.querySelector('.detail-thread-input')?.focus();
    return;
  }

  const hostRaw = hostRawOf(bubbleEl);
  const hidxAttr = bubbleEl?.dataset?.hidx;
  const thread = {
    subId: 'sub-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    hidx: hidxAttr == null || hidxAttr === '' || !Number.isFinite(Number(hidxAttr))
      ? null : Number(hidxAttr),
    hostHash: hashText(hostRaw),
    hostLength: hostRaw.length,
    hostPrefix: hostRaw.slice(0, 160),
    anchorPath: anchorPathFrom(bubbleEl, anchorEl),
    anchorText: anchorEl !== bubbleEl ? anchorTextOf(anchorEl) : '',
    quotedText,
    highlightRange: highlightRange && Number.isFinite(highlightRange.start)
      && Number.isFinite(highlightRange.end) && highlightRange.end > highlightRange.start
      ? {
        start: highlightRange.start,
        end: highlightRange.end,
        ...(typeof highlightRange.text === 'string' && highlightRange.text
          ? { text: highlightRange.text.slice(0, 600) } : {}),
      } : null,
    videoSrc: bubbleEl?.dataset?.videoSrc || '',
    collapsed: false,
    messages: [],
    wireMessages: [],
    streamingText: '',
    inFlight: false,
    draft: '',
    height: null,
    updatedAt: Date.now(),
  };
  mountDetailThread({ bubbleEl, anchorEl, thread, restoring: false });
}

/**
 * Build/attach one card. `thread` is the stored record shape (see
 * openDetailThread); when `restoring` is true it carries messages/wire
 * history/draft/height and must not steal focus. Returns a promise that
 * settles after restored messages have been re-rendered.
 */
function mountDetailThread({ bubbleEl, anchorEl, thread, restoring, insertAfterEl, autoCollapse }) {
  const subId = thread.subId;
  const quotedText = typeof thread.quotedText === 'string' ? thread.quotedText : '';
  const anchorRaw = hostRawOf(bubbleEl);
  // 视频上下文（2026-10-07 用户报告）：宿主气泡带 videoSrc 盖章时，卡内 AI
  // 气泡继承同一盖章——卡内生成的时间戳由此走主聊天同一条链（linkifyTimestamps
  // 的 .msg videoSrc 门控 → onTimestampClick → seekVideo），可点击跳转视频。
  // 宿主无盖章（非视频会话）则不盖，卡内时间戳维持纯文本（误报越少越好）。
  const hostVideoSrc = thread.videoSrc || bubbleEl?.dataset?.videoSrc || '';

  const card = document.createElement('div');
  card.className = 'detail-thread-card';
  card.dataset.subId = subId;
  card.dataset.anchorPath = JSON.stringify(Array.isArray(thread.anchorPath) ? thread.anchorPath : []);
  // Independent of the index path: the anchor block's text survives the
  // sync→full render structural drift (think blocks), see resolveAnchorFor.
  // Records written before anchorText existed get it from the anchor we just
  // resolved, so the next upgrade's reinsertion can use the same address.
  card.dataset.anchorText = (typeof thread.anchorText === 'string' && thread.anchorText)
    || (bubbleEl && anchorEl && anchorEl !== bubbleEl ? anchorTextOf(anchorEl) : '');
  card.innerHTML =
    `<button class="detail-thread-fold" title="${escM(_t('detailThreadCollapse', '折叠追问卡'))}" aria-label="${escM(_t('detailThreadCollapse', '折叠追问卡'))}" aria-expanded="true">${ICONS.chevron}</button>` +
    `<button class="detail-thread-close" title="${escM(_t('closeLabel', 'Close'))}">${ICONS.close}</button>` +
    `<div class="detail-thread-quote">${escM(quotedText)}</div>` +
    `<div class="detail-thread-messages"></div>` +
    `<div class="detail-thread-imgs"></div>` +
    `<div class="detail-thread-input-row">` +
      // textarea（2026-09-23 用户报告：单行 input 永不换行，长文只横向滚动）——
      // 换行 + 自动增高同主 composer 的 #input 约定；Enter 发送 / Shift+Enter
      // 换行（textarea 原生）语义不变。
      `<textarea class="detail-thread-input" rows="1" aria-label="${escM(_t('detailThreadPlaceholder', '就这段追问…'))}" placeholder="${escM(_t('detailThreadPlaceholder', '就这段追问…'))}"></textarea>` +
      `<button class="detail-thread-send">${escM(_t('detailThreadSend', '发送'))}</button>` +
    `</div>` +
    `<div class="detail-thread-resize-handle" title="${escM(_t('detailThreadResize', '拖拽调整高度'))}">⋯</div>`;

  const messagesWrap = card.querySelector('.detail-thread-messages');
  const quoteEl = card.querySelector('.detail-thread-quote');
  // 引用文本里 selectionTextWithMath 写入的 $…$/$$…$$ 异步补渲染成 KaTeX；
  // worker/同步路径任一失败时 renderMathInPlainText 内部回落源码形态，纯文本兜底。
  renderMathInPlainText(quoteEl);
  const input = card.querySelector('.detail-thread-input');
  const sendBtnEl = card.querySelector('.detail-thread-send');
  const closeBtn = card.querySelector('.detail-thread-close');
  const foldBtn = card.querySelector('.detail-thread-fold');
  const resizeHandle = card.querySelector('.detail-thread-resize-handle');
  const imgsStrip = card.querySelector('.detail-thread-imgs');

  // Restored height/draft (a card persists until the user closes it).
  if (thread.height) {
    const h = parseFloat(thread.height);
    if (Number.isFinite(h)) {
      card.style.height = Math.max(CARD_MIN_HEIGHT, Math.min(h, window.innerHeight * 0.8)) + 'px';
    }
  }
  let savedHeight = card.style.height || '';
  // Reopening the SIDE PANEL folds restored cards down to their quote by
  // default (user direction 2026-10-21): the main reply + highlight stay in
  // view instead of every saved card expanding over it. A same-document
  // renderHistory restore keeps the state the card had on screen.
  let collapsed = restoring ? (autoCollapse === true || thread.collapsed === true) : false;
  if (typeof thread.draft === 'string' && thread.draft) input.value = thread.draft;

  // ─── Persisted state ──────────────────────────────────────────────────────
  // `subMessages` is the wire transcript (first turn wrapped with the quoted
  // excerpt + full previous reply); `displayMessages` is what the card shows
  // (the user's actual question, not the wrapper). They diverge on failures
  // (fail() pops the unanswered user turn from the wire but leaves its bubble
  // on screen), so both are stored rather than reconstructed from each other.
  let subMessages = Array.isArray(thread.wireMessages)
    ? thread.wireMessages.map((m) => ({ ...m })) : [];
  const displayMessages = Array.isArray(thread.messages)
    ? thread.messages.map((m) => ({ ...m })) : [];
  let saveTimer = null;

  function snapshot() {
    const rawNow = bubbleEl?.dataset?.raw;
    if (typeof rawNow === 'string' && rawNow) {
      // The host bubble may have finished streaming since the card opened —
      // keep the record's anchor fingerprint current.
      thread.hostHash = hashText(rawNow);
      thread.hostLength = rawNow.length;
      thread.hostPrefix = rawNow.slice(0, 160);
    }
    if (bubbleEl?.isConnected && card.isConnected) {
      const anchorNow = anchorEl?.isConnected && bubbleEl.contains(anchorEl)
        ? anchorEl
        : (card.parentElement === bubbleEl && card.previousElementSibling
          && !card.previousElementSibling.classList?.contains('detail-thread-card')
          ? card.previousElementSibling
          : null);
      if (anchorNow) {
        // Restore can fall back to the bubble when the sync render's text does
        // not match yet; that must not erase a real anchor — the text/path
        // saved earlier is exactly what lets the next open place the card
        // correctly (2026-10-21 user report: a restored card drifted to the
        // end of the reply).
        if (anchorNow !== bubbleEl || !Array.isArray(thread.anchorPath) || thread.anchorPath.length === 0) {
          thread.anchorPath = anchorPathFrom(bubbleEl, anchorNow);
        }
        if (anchorNow !== bubbleEl) thread.anchorText = anchorTextOf(anchorNow);
      }
    }
    card.dataset.anchorPath = JSON.stringify(thread.anchorPath || []);
    card.dataset.anchorText = thread.anchorText || '';
    // Pasted-image data URLs are deliberately NOT persisted: one card can
    // carry up to the shared 8MB image budget, and chrome.storage.session is
    // a 10MB bucket shared by every open card — overshooting it would fail
    // the whole write and lose the conversation too. The restored user bubble
    // keeps its "(image)" text; the live session keeps the thumbnails.
    thread.messages = displayMessages.map((m) => {
      const saved = { role: m.role, content: m.content };
      if (m.error) saved.error = true;
      if (m.providerLabel) saved.providerLabel = m.providerLabel;
      if (m.usage) saved.usage = m.usage;
      if (m.usageScope) saved.usageScope = m.usageScope;
      if (m.durationMs) saved.durationMs = m.durationMs;
      return saved;
    });
    thread.wireMessages = subMessages.map((m) => ({ ...m }));
    thread.draft = input.value;
    thread.inFlight = inFlight;
    thread.streamingText = inFlight ? rawAccum : '';
    thread.height = (collapsed ? savedHeight : card.style.height) || null;
    thread.collapsed = collapsed;
    thread.updatedAt = Date.now();
    return { ...thread };
  }
  function persistNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { saveDetailThread(snapshot()); } catch (_) { /* persistence is fail-open */ }
  }
  function persistSoon(ms = 600) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { saveDetailThread(snapshot()); } catch (_) { /* persistence is fail-open */ }
    }, ms);
  }

  // Fold the card down to its quote; the X still closes (and aborts a turn).
  function setCollapsed(next, { persist = true } = {}) {
    collapsed = !!next;
    card.classList.toggle('collapsed', collapsed);
    foldBtn.title = collapsed ? _t('detailThreadExpand', '展开追问卡') : _t('detailThreadCollapse', '折叠追问卡');
    foldBtn.setAttribute('aria-label', foldBtn.title);
    foldBtn.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) {
      if (card.style.height) savedHeight = card.style.height;
      card.style.height = '';
    } else if (savedHeight) {
      card.style.height = savedHeight;
    }
    if (persist) persistNow();
  }

  // ─── Image attach (paste) — parity with the main composer ─────────────────
  // Same per-turn budgets (lib/image-budget.js), enforced at attach time so
  // every thumbnail the user sees actually ships. Images ride the SUBCHAT
  // message's `images` field — the SAME convention as CHAT — and
  // subchat-handler forwards them per provider (squilla deliberately drops
  // them: its gateway contract keeps pasted images browsa-side).
  // Ingest/strip pipeline = the SHARED lib/sidepanel/image-drop.js (2026-09-30
  // 批D：此前这里是主 composer 的近逐字私有副本，且已漂移过一次——同一个拒绝
  // 这边 showToast、那边 compact appendError。notify 回调保留这个表面差异，
  // 其余单源)。
  const cardImages = [];    // { dataUrl, name } — attached for this turn
  function refreshCardImages() {
    renderImageStrip(imgsStrip, cardImages, (i) => { cardImages.splice(i, 1); refreshCardImages(); });
  }
  async function addCardFiles(fileList) {
    await ingestImageFiles(fileList, cardImages, (text) => showToast(text, 'error'));
    refreshCardImages();
  }
  input.addEventListener('paste', async (e) => {
    const imageItems = pastedImageFiles(e);
    if (imageItems.length > 0) {
      e.preventDefault(); // don't paste file name text
      await addCardFiles(imageItems);
    }
  });

  // Custom drag-to-resize: native CSS `resize` exists but its grip is easy
  // to miss (gets visually clipped by the card's border-radius and the
  // overflow:hidden that `resize` itself requires). The window listeners
  // exist ONLY for the duration of an active drag (added on handle
  // mousedown, removed on mouseup): listeners added once at card creation
  // leak every time a card is destroyed WITHOUT its close handler —
  // renderHistory/newSession/clearChatHistory wipe messagesEl.innerHTML
  // directly — each leaked pair retaining its detached card subtree.
  const cardResize = wireCardResize(card, resizeHandle, () => {
    savedHeight = card.style.height;
    persistSoon(250);
  });

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
  let firstChunkAt = 0;     // first CHUNK arrival — generation window for the usage chip

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
    const first = !firstChunkAt;
    if (!firstChunkAt) firstChunkAt = Date.now();
    rawAccum += delta;
    renderStream(delta, false);
    // The side panel can be torn down without pagehide firing, so the first
    // chunk lands immediately and the rest stays within 400ms of the stream —
    // otherwise closing the panel within the old 1s window lost every chunk.
    if (first) persistNow(); else persistSoon(400);
  }

  // ─── Restored bubbles ─────────────────────────────────────────────────────
  function appendUserDisplay(m) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.dataset.raw = m.content || '';
    const span = document.createElement('span');
    span.className = 'msg-text';
    span.textContent = m.content || '(image)'; // same plain-text rendering as send()
    el.appendChild(span);
    messagesWrap.appendChild(el);
  }

  async function appendAssistantDisplay(m) {
    const content = typeof m.content === 'string' ? m.content : '';
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.dataset.raw = content;
    if (hostVideoSrc) el.dataset.videoSrc = hostVideoSrc;
    if (m.error) {
      el.textContent = '⚠ ' + content; // mirror fail()'s live error bubble
    } else {
      try {
        el.innerHTML = await renderSafe(content);
      } catch (e) {
        console.error('[subchat]', subId, 'restore render failed', e);
        el.textContent = content;
      }
    }
    el.classList.add('done');
    if (m.error) el.classList.add('subchat-error');
    finishBubble(el);
    if (m.providerLabel) turnChrome.addProviderChip(el, m.providerLabel);
    if (m.usage) {
      const chip = buildUsageChip(m.usage, m.usageScope, Number(m.durationMs) || 0);
      if (chip) insertUsageChip(el, chip);
    }
    messagesWrap.appendChild(el);
    return el;
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

  async function finalize(providerLabel, usage, fullOverride, usageScope) {
    const el = liveAiEl;
    // DONE.full (squilla: retroactively fold-applied / reset-corrected text)
    // is authoritative over the streamed chunks when the channel provides it —
    // the live bubble showed the un-corrected text, the final render and the
    // next turn's transcript must not.
    const finalRaw = (typeof fullOverride === 'string' && fullOverride) ? fullOverride : rawAccum; // snapshot before state is reset below
    liveAiEl = null;
    if (!el) return;
    turnChrome.clearTurnChrome(el);
    // Provider numbers + (turn-scoped only) decode rate over the generation
    // window. Computed BEFORE the async final render.
    const durationMs = firstChunkAt ? Math.max(0, Date.now() - firstChunkAt) : 0;
    const usageChip = buildUsageChip(usage, usageScope, durationMs);
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
      const saved = { role: 'assistant', content: finalRaw };
      if (providerLabel) saved.providerLabel = providerLabel;
      if (usage) { saved.usage = usage; saved.usageScope = usageScope; saved.durationMs = durationMs; }
      displayMessages.push(saved);
      toolEvents = []; firstChunkAt = 0;
      inFlight = false;
      stopTurnPort();
      setBusy(false);
      persistNow();
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
          displayMessages.push({ role: 'assistant', content: partial });
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
      persistNow();
    }
  }

  function fail(message) {
    if (renderStream) { renderStream.destroy(); renderStream = null; }
    turnChrome.clearTurnChrome(liveAiEl);
    if (liveAiEl) {
      liveAiEl.classList.add('done', 'subchat-error'); // stop the blinking cursor too
      liveAiEl.textContent = '⚠ ' + (message || 'Request failed');
      displayMessages.push({ role: 'assistant', content: message || 'Request failed', error: true });
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
    persistNow();
  }

  async function send() {
    const q = input.value.trim();
    if (!q && !cardImages.length) return;
    const dataUrls = cardImages.map((i) => i.dataUrl);
    if (q) cardHistory.pushInputHistory(q); // card-scope ↑ recall list（纯图轮不进召回）
    setBusy(true);
    inFlight = true;
    // 复位召回态再清空，同主 composer 的 onSend：resetHistoryNav 会把召回前
    // 的草稿写回 value，顺序反了草稿就会顶掉刚清空的输入框。
    cardHistory.resetHistoryNav(input);
    input.value = '';
    persistSoon(0);
    // 主 composer 同款时序：捕获 URL 后立即清空缩略条（LLM 回复要等几秒）。
    cardImages.length = 0;
    refreshCardImages();

    try {
      // Reuse the main chat's own .msg.user/.msg.assistant classes directly
      // (not a parallel copy) so bubble styling never drifts out of sync —
      // any future change to the main chat's message look applies here too.
      const userEl = document.createElement('div');
      userEl.className = 'msg user';
      userEl.textContent = q || '(image)';
      if (dataUrls.length) {
        const strip = document.createElement('div');
        strip.className = 'msg-images';
        for (const u of dataUrls) {
          const img = document.createElement('img');
          img.src = u;
          strip.appendChild(img);
        }
        userEl.appendChild(strip);
      }
      messagesWrap.appendChild(userEl);

      const savedUser = { role: 'user', content: q || '(image)' };
      if (dataUrls.length) savedUser.images = dataUrls;
      displayMessages.push(savedUser);

      liveAiEl = document.createElement('div');
      liveAiEl.className = 'msg assistant'; // .done added in finalize()/fail()
      if (hostVideoSrc) liveAiEl.dataset.videoSrc = hostVideoSrc;
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
            'User\'s question: ' + (q || '(see the attached image)'),
        });
      } else {
        subMessages.push({ role: 'user', content: q || '(image)' });
      }
      persistNow();

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
        else if (m.type === 'SUBCHAT_APPROVAL') turnChrome.showApprovalCard(liveAiEl, m.data, m.reqKey);
        else if (m.type === 'SUBCHAT_CLARIFY') turnChrome.showClarifyCard(liveAiEl, m.data, m.reqKey);
        else if (m.type === 'SUBCHAT_DONE') { if (m.truncated) showToast(_t('detailThreadTruncated', '追问回复已达模型输出上限，可回复「继续」续写'), 'info'); finalize(m.providerLabel, m.usage, m.full, m.usageScope).catch(() => {}); }
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

      const res = await sendMessage({ type: 'SUBCHAT', subId, messages: subMessages, images: dataUrls.length ? dataUrls : undefined });
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
  // persistence (this card's draft IS persisted with the card now).
  input.addEventListener('keydown', (e) => {
    if (cardHistory.handleHistoryNav(e)) { e.preventDefault(); return; }
    // isImeComposing: the Enter that confirms an IME candidate is NOT a send
    // (the card input was the one surface missing this — Enter-to-commit
    // fired the half-typed question, user-reported 2026-09-21).
    // Shift+Enter falls through untouched — the textarea inserts a newline
    // natively (multiline input since 2026-09-23, same Enter/Shift+Enter
    // split as the main composer's default shortcut).
    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    cardHistory.resetHistoryNav(input, { restoreDraft: false });
    persistSoon(400);
  });

  function closeCard() {
    if (inFlight) {
      sendMessage({ type: 'SUBCHAT_ABORT', subId });
      inFlight = false;
    }
    if (renderStream) { renderStream.destroy(); renderStream = null; }
    turnChrome.clearTurnChrome(liveAiEl);
    stopTurnPort();
    cardResize.dispose(); // no-op unless mid-drag — window listeners are drag-scoped
    // 卡片里的活图表（追问回复可以带 mermaid/echarts/pdb…）随卡收起——
    // 定向 dispose，否则 WebGL context/ResizeObserver 泄漏到下次 renderHistory。
    disposeRenderInstancesIn(card);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    activeCards.delete(subId);
    removeCardHighlight(subId);
    deleteDetailThread(subId);
    card.remove();
  }
  foldBtn.addEventListener('click', () => setCollapsed(!collapsed));
  closeBtn.addEventListener('click', closeCard);
  setBusy(false);

  const rendered = restoring
    ? (async () => {
      for (const m of displayMessages) {
        if (m?.role === 'user') appendUserDisplay(m);
        else if (m?.role === 'assistant') await appendAssistantDisplay(m);
      }
      // The panel was closed mid-turn: the background run has no port to
      // deliver DONE to, so salvage the persisted partial text as a finished
      // reply (same semantics as ■ stop) and cancel the orphaned run.
      if (thread.inFlight) {
        sendMessage({ type: 'SUBCHAT_ABORT', subId });
        const partial = typeof thread.streamingText === 'string' ? thread.streamingText : '';
        if (partial.trim()) {
          const m = { role: 'assistant', content: partial };
          displayMessages.push(m);
          if (!subMessages.length || subMessages[subMessages.length - 1].role !== 'assistant') {
            subMessages.push({ role: 'assistant', content: partial });
          }
          await appendAssistantDisplay(m);
        } else if (subMessages.length && subMessages[subMessages.length - 1].role === 'user') {
          subMessages.pop();
        }
        inFlight = false;
        rawAccum = '';
        setBusy(false);
        persistNow();
      }
      messagesWrap.scrollTop = messagesWrap.scrollHeight;
    })()
    : Promise.resolve();

  if (bubbleEl) _insertCard(insertAfterEl || anchorEl, card);
  else messagesEl().appendChild(card); // host reply gone — keep the thread visible
  // pagehide: the document is being destroyed, so stop the keep-alive timer /
  // port / pacer (Chrome tears them down anyway; in tests this is what keeps
  // a simulated teardown from leaking a 20s SW_PING interval).
  const unload = () => {
    stopTurnPort();
    if (renderStream) { renderStream.destroy(); renderStream = null; }
  };
  const rehighlight = () => applyCardHighlight(subId, bubbleEl, thread.highlightRange, thread.quotedText);
  activeCards.set(subId, {
    flush: persistNow, close: closeCard, unload, host: bubbleEl || null, rehighlight,
  });
  setCollapsed(collapsed, { persist: false });
  rehighlight();
  if (!restoring) {
    persistNow();
    setTimeout(() => input.focus(), 50);
  }
  return rendered;
}

/**
 * Re-attach persisted cards after renderHistory() has rebuilt the message
 * list. Safe to call repeatedly: cards already in the DOM are skipped, and a
 * record whose host reply can no longer be found is kept as a card at the end
 * of the conversation (its quoted excerpt still identifies what it was about)
 * rather than silently dropped.
 */
export async function restoreDetailThreads() {
  const epoch = threadsEpoch;
  const root = messagesEl();
  // A fresh panel document (no live cards yet) auto-folds restored cards; a
  // renderHistory while the panel is alive keeps each card's current state.
  const freshPanel = activeCards.size === 0;
  // A renderHistory() while the panel is alive wipes the card DOM but leaves
  // this module's closures (and any SW_PING interval/render pacer) running.
  // Flush their latest state, stop the timers, and let the persisted record
  // below recreate the card.
  for (const [id, entry] of [...activeCards]) {
    if (root.querySelector(`.detail-thread-card[data-sub-id="${CSS.escape(id)}"]`)) continue;
    try { entry.flush(); } catch (_) {}
    try { entry.unload?.(); } catch (_) {}
    activeCards.delete(id);
  }
  const records = await loadDetailThreads();
  if (epoch !== threadsEpoch) return;
  if (!Array.isArray(records) || records.length === 0) return;
  const mounted = new Set(
    [...root.querySelectorAll('.detail-thread-card')].map((c) => c.dataset.subId).filter(Boolean)
  );
  const tails = new Map(); // logical anchor -> last card inserted after it
  const jobs = [];
  for (const rec of records) {
    if (epoch !== threadsEpoch) return;
    if (!rec || typeof rec.subId !== 'string' || mounted.has(rec.subId)) continue;
    const bubbleEl = findHostBubble(rec);
    let anchorEl = bubbleEl;
    let insertAfterEl = null;
    if (bubbleEl) {
      // The saved block text is the reliable address when the sync render's
      // structure differs from the render the path was recorded against
      // (think blocks are the common case). The selection quote is the
      // fallback locator for records written before anchorText existed.
      const savedText = normAnchorText(rec.anchorText)
        || normAnchorText(rec.highlightRange?.text)
        || normAnchorText(rec.quotedText);
      anchorEl = resolveAnchorFor(bubbleEl, rec.anchorPath, savedText) || bubbleEl;
      insertAfterEl = tails.get(anchorEl) || anchorEl;
    }
    const job = mountDetailThread({
      bubbleEl: bubbleEl || null,
      anchorEl: bubbleEl ? anchorEl : root,
      thread: rec,
      restoring: true,
      insertAfterEl: bubbleEl ? insertAfterEl : null,
      autoCollapse: freshPanel,
    });
    if (bubbleEl) {
      // mount inserted synchronously; resolve the new tail for any record
      // sharing this anchor.
      const card = root.querySelector(`.detail-thread-card[data-sub-id="${CSS.escape(rec.subId)}"]`);
      if (card) tails.set(anchorEl, card);
    }
    jobs.push(job);
  }
  await Promise.allSettled(jobs);
}

/**
 * Drop every detail thread — DOM cards, persisted records, and any in-flight
 * background run. Called on new chat / clear history / session switch: a detail
 * thread belongs to the conversation it was opened in.
 */
export function clearDetailThreads() {
  threadsEpoch++;
  for (const entry of [...activeCards.values()]) {
    try { entry.close(); } catch (_) {}
  }
  activeCards.clear();
  return clearDetailThreadStore();
}

/**
 * Close the cards that live in or immediately after `node` — used by the
 * message-delete / regenerate / edit-resend paths, which remove bubbles from
 * the DOM directly. Without this the card's persisted record would outlive its
 * host reply and resurface as a floating card after the next renderHistory.
 */
export function closeDetailThreadsIn(node) {
  if (!node) return;
  const cards = [];
  if (node.classList?.contains('detail-thread-card')) cards.push(node);
  node.querySelectorAll?.('.detail-thread-card').forEach((c) => cards.push(c));
  // A card anchored to the bubble itself is the bubble's next sibling.
  let sib = node.nextElementSibling;
  while (sib && sib.classList?.contains('detail-thread-card')) {
    cards.push(sib);
    sib = sib.nextElementSibling;
  }
  for (const card of cards) {
    const entry = activeCards.get(card.dataset.subId);
    if (entry) entry.close();
    else card.remove();
  }
}
