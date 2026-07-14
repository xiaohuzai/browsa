// test/lib-multiselect.test.mjs — execution tests for lib/multiselect.js,
// extracted from sidepanel.js in the Phase 3 modularization refactor.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;

const sentMessages = [];
globalThis.chrome = {
  runtime: {
    sendMessage: (msg, cb) => {
      sentMessages.push(msg);
      cb({ ok: true });
    },
    lastError: undefined,
  },
};

const {
  initMultiselect, isInMultiSelectMode, enterMultiSelect, exitMultiSelect,
  deleteSelectedMessages
} = await import('../lib/sidepanel/multiselect.js');

let decrements = 0;
initMultiselect({ decrementNextHistoryIdx: () => { decrements++; } });

function setupDom() {
  sentMessages.length = 0;
  decrements = 0;
  document.body.innerHTML = `
    <div id="messages">
      <div class="msg user" data-hidx="0">hi</div>
      <div class="msg assistant" data-hidx="1">hello</div>
      <div class="msg user" data-hidx="2">how are you</div>
    </div>
    <div id="multiselect-bar" hidden></div>
    <button id="multiselect-toggle"></button>
    <span id="multiselect-count"></span>
    <button id="multiselect-delete"></button>`;
}

beforeEach(() => setupDom());

test('isInMultiSelectMode starts false', () => {
  assert.equal(isInMultiSelectMode(), false);
});

test('enterMultiSelect shows the bar, marks the toggle active, and adds a checkbox to every dated message', () => {
  enterMultiSelect();
  assert.equal(isInMultiSelectMode(), true);
  assert.equal(document.getElementById('multiselect-bar').hidden, false);
  assert.ok(document.getElementById('multiselect-toggle').classList.contains('active'));
  assert.equal(document.querySelectorAll('.msg-select-cb').length, 3);
  assert.equal(document.getElementById('multiselect-count').textContent, '0 selected');
  assert.equal(document.getElementById('multiselect-delete').disabled, true);
});

test('enterMultiSelect is idempotent — does not add a second checkbox to an already-checked bubble', () => {
  enterMultiSelect();
  enterMultiSelect();
  assert.equal(document.querySelectorAll('.msg-select-cb').length, 3);
});

test('checking a checkbox updates the selected count and enables the delete button', () => {
  enterMultiSelect();
  const cb = document.querySelector('.msg[data-hidx="1"] .msg-select-cb');
  cb.checked = true;
  cb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(document.getElementById('multiselect-count').textContent, '1 selected');
  assert.equal(document.getElementById('multiselect-delete').disabled, false);
});

test('exitMultiSelect hides the bar, un-marks the toggle, and removes all checkboxes', () => {
  enterMultiSelect();
  exitMultiSelect();
  assert.equal(isInMultiSelectMode(), false);
  assert.equal(document.getElementById('multiselect-bar').hidden, true);
  assert.equal(document.getElementById('multiselect-toggle').classList.contains('active'), false);
  assert.equal(document.querySelectorAll('.msg-select-cb').length, 0);
});

test('deleteSelectedMessages: no-op when nothing is checked', async () => {
  enterMultiSelect();
  await deleteSelectedMessages();
  assert.equal(sentMessages.length, 0);
  assert.equal(document.querySelectorAll('.msg').length, 3, 'nothing should be removed');
});

test('deleteSelectedMessages: deletes checked messages highest-index-first, shifts remaining data-hidx, and calls decrementNextHistoryIdx once per deletion', async () => {
  enterMultiSelect();
  // Select hidx=0 and hidx=2 (skip the middle one).
  document.querySelector('.msg[data-hidx="0"] .msg-select-cb').checked = true;
  document.querySelector('.msg[data-hidx="2"] .msg-select-cb').checked = true;

  await deleteSelectedMessages();

  // Deletes highest index first: 2, then 0.
  assert.deepEqual(sentMessages, [
    { type: 'REMOVE_HISTORY_ENTRY_BY_INDEX', index: 2 },
    { type: 'REMOVE_HISTORY_ENTRY_BY_INDEX', index: 0 },
  ]);
  assert.equal(decrements, 2);

  // Only the untouched middle message (originally hidx=1) survives.
  const remaining = [...document.querySelectorAll('.msg')];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].textContent, 'hello');

  // Multiselect mode must be exited automatically after deletion.
  assert.equal(isInMultiSelectMode(), false);
});

test('deleteSelectedMessages: shifts data-hidx of surviving bubbles above a deleted index', async () => {
  // Add a 4th message so there's something above index 1 to observe shifting.
  document.getElementById('messages').insertAdjacentHTML('beforeend', '<div class="msg assistant" data-hidx="3">last</div>');
  enterMultiSelect();
  document.querySelector('.msg[data-hidx="1"] .msg-select-cb').checked = true;

  await deleteSelectedMessages();

  // The bubble that was hidx=3 must shift down to hidx=2 (index 1 was removed).
  const last = [...document.querySelectorAll('.msg')].find(el => el.textContent === 'last');
  assert.equal(last.dataset.hidx, '2');
});
