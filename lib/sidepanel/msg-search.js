// lib/sidepanel/msg-search.js — in-conversation text search (Ctrl+F), extracted
// verbatim from sidepanel.js (Phase 3 of the modularization refactor).
// Self-contained: only touches its own module state and the #messages DOM.

import { $ } from './ui-utils.js';

const messagesEl = () => document.getElementById('messages');

let _searchMatches = [];
let _searchIdx = -1;

export function initMsgSearch() {
  const bar = $('msg-search-bar');
  const input = $('msg-search-input');
  if (!bar || !input) return;

  input.addEventListener('input', () => doMsgSearch(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) prevSearchMatch(); else nextSearchMatch();
    }
    if (e.key === 'Escape') closeMsgSearch();
  });
  $('msg-search-prev')?.addEventListener('click', prevSearchMatch);
  $('msg-search-next')?.addEventListener('click', nextSearchMatch);
  $('msg-search-close')?.addEventListener('click', closeMsgSearch);
}

export function openMsgSearch() {
  const bar = $('msg-search-bar');
  if (!bar) return;
  bar.hidden = false;
  $('msg-search-input')?.focus();
}

export function closeMsgSearch() {
  const bar = $('msg-search-bar');
  if (!bar) return;
  bar.hidden = true;
  clearSearchHighlights();
  _searchMatches = [];
  _searchIdx = -1;
  const input = $('msg-search-input');
  if (input) input.value = '';
  if ($('msg-search-count')) $('msg-search-count').textContent = '';
}

function doMsgSearch(query) {
  clearSearchHighlights();
  _searchMatches = [];
  _searchIdx = -1;
  const countEl = $('msg-search-count');
  if (!query.trim()) { if (countEl) countEl.textContent = ''; return; }

  const q = query.toLowerCase();
  // Walk text nodes in messages, wrap matches in <mark>
  const walk = document.createTreeWalker(messagesEl(), NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('.msg-actions, .token-usage, .think-block summary'))
        return NodeFilter.FILTER_REJECT;
      return node.textContent.toLowerCase().includes(q)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });

  const marks = [];
  let node;
  while ((node = walk.nextNode())) {
    const text = node.textContent;
    const lower = text.toLowerCase();
    let pos = 0;
    const frag = document.createDocumentFragment();
    let idx;
    while ((idx = lower.indexOf(q, pos)) !== -1) {
      if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      marks.push(mark);
      pos = idx + q.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }
  _searchMatches = marks;
  if (countEl) countEl.textContent = marks.length ? `1 / ${marks.length}` : 'No results';
  if (marks.length) { _searchIdx = 0; highlightSearchMatch(0); }
}

function highlightSearchMatch(i) {
  _searchMatches.forEach((m, idx) => m.classList.toggle('search-highlight-active', idx === i));
  if (_searchMatches[i]) {
    _searchMatches[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
    const countEl = $('msg-search-count');
    if (countEl) countEl.textContent = `${i + 1} / ${_searchMatches.length}`;
  }
}

function nextSearchMatch() {
  if (!_searchMatches.length) return;
  _searchIdx = (_searchIdx + 1) % _searchMatches.length;
  highlightSearchMatch(_searchIdx);
}

function prevSearchMatch() {
  if (!_searchMatches.length) return;
  _searchIdx = (_searchIdx - 1 + _searchMatches.length) % _searchMatches.length;
  highlightSearchMatch(_searchIdx);
}

function clearSearchHighlights() {
  // Unwrap all <mark class="search-highlight"> back to plain text
  for (const mark of messagesEl().querySelectorAll('mark.search-highlight')) {
    mark.replaceWith(document.createTextNode(mark.textContent));
  }
  // Merge adjacent text nodes left by replaceWith
  messagesEl().normalize();
}
