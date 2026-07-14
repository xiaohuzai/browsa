// test/lib-msg-search.test.mjs — execution tests for lib/msg-search.js,
// extracted from sidepanel.js in the Phase 3 modularization refactor.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
// jsdom doesn't implement scrollIntoView — highlightSearchMatch() calls it
// unconditionally, and an uncaught throw there would stop the rest of the
// function (including the match-count text update) from running.
dom.window.Element.prototype.scrollIntoView = () => {};

const { initMsgSearch, openMsgSearch, closeMsgSearch } = await import('../lib/sidepanel/msg-search.js');

function setupDom() {
  document.body.innerHTML = `
    <div id="messages">
      <div class="msg assistant">The quick brown fox jumps over the lazy fox.</div>
    </div>
    <div id="msg-search-bar" hidden>
      <input id="msg-search-input" />
      <span id="msg-search-count"></span>
      <button id="msg-search-prev"></button>
      <button id="msg-search-next"></button>
      <button id="msg-search-close"></button>
    </div>`;
  initMsgSearch();
}

beforeEach(() => setupDom());

function fireInput(value) {
  const input = document.getElementById('msg-search-input');
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

test('openMsgSearch un-hides the bar and focuses the input', () => {
  openMsgSearch();
  assert.equal(document.getElementById('msg-search-bar').hidden, false);
});

test('typing a query wraps every match in <mark class="search-highlight"> and updates the count', () => {
  openMsgSearch();
  fireInput('fox');
  const marks = document.querySelectorAll('mark.search-highlight');
  assert.equal(marks.length, 2, 'both occurrences of "fox" must be wrapped');
  assert.equal(document.getElementById('msg-search-count').textContent, '1 / 2');
  assert.ok(marks[0].classList.contains('search-highlight-active'), 'first match starts active');
});

test('typing a query with no matches shows "No results" and wraps nothing', () => {
  openMsgSearch();
  fireInput('giraffe');
  assert.equal(document.querySelectorAll('mark.search-highlight').length, 0);
  assert.equal(document.getElementById('msg-search-count').textContent, 'No results');
});

test('Enter cycles to the next match, Shift+Enter cycles to the previous', () => {
  openMsgSearch();
  fireInput('fox');
  const input = document.getElementById('msg-search-input');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(document.getElementById('msg-search-count').textContent, '2 / 2');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  assert.equal(document.getElementById('msg-search-count').textContent, '1 / 2');
});

test('closeMsgSearch hides the bar, clears the input, and unwraps all highlight marks', () => {
  openMsgSearch();
  fireInput('fox');
  closeMsgSearch();
  assert.equal(document.getElementById('msg-search-bar').hidden, true);
  assert.equal(document.getElementById('msg-search-input').value, '');
  assert.equal(document.querySelectorAll('mark.search-highlight').length, 0);
  // Text content must be preserved (not lost) after unwrapping.
  assert.match(document.getElementById('messages').textContent, /quick brown fox/);
});

test('Escape key inside the input closes the search bar', () => {
  openMsgSearch();
  const input = document.getElementById('msg-search-input');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.getElementById('msg-search-bar').hidden, true);
});

test('search skips text inside .msg-actions / .token-usage / think-block summary', () => {
  document.getElementById('messages').innerHTML +=
    '<div class="msg-actions">fox actions</div>' +
    '<div class="token-usage">fox tokens</div>' +
    '<details class="think-block"><summary>fox summary</summary></details>';
  openMsgSearch();
  fireInput('fox');
  // Only the original 2 matches in the assistant bubble should be found.
  assert.equal(document.querySelectorAll('mark.search-highlight').length, 2);
});
