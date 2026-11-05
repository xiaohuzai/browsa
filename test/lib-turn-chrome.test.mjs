// test/lib-turn-chrome.test.mjs — the tool-progress line's placement contract.
//
// showToolProgress/clearToolProgress used to look only at the IMMEDIATE
// previous sibling. render.js's ensureThinkEl inserts the live-think block
// right before the bubble — i.e. BETWEEN an existing tool-progress line and
// the bubble. After TOOL_PROGRESS → think delta → DONE, clearTurnChrome ran
// before the final render removed the think block: previous sibling was the
// live-think, the progress line survived as an orphan above the finished
// bubble, and a second showToolProgress stacked a duplicate line
// (2026-11-05 audit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
globalThis.Node = dom.window.Node;

const { showToolProgress, clearToolProgress } = await import('../lib/sidepanel/turn-chrome.js');

function setup() {
  const root = document.getElementById('messages');
  root.innerHTML = '';
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant';
  root.appendChild(bubble);
  return { root, bubble };
}

function insertLiveThink(bubble) {
  const think = document.createElement('details');
  think.className = 'think-block live-think';
  bubble.parentNode.insertBefore(think, bubble);
  return think;
}

test('showToolProgress reuses the line even when a live-think block sits between it and the bubble', () => {
  const { root, bubble } = setup();
  showToolProgress(bubble, 'Reading file…');
  insertLiveThink(bubble); // think delta arrives AFTER the tool event
  showToolProgress(bubble, 'Running terminal…');
  assert.equal(root.querySelectorAll('.tool-progress').length, 1,
    'a live-think between the line and the bubble must not cause a stacked duplicate');
  assert.match(root.querySelector('.tool-progress').textContent, /Running terminal/,
    'the existing line is updated in place');
});

test('clearToolProgress removes the line past an intervening live-think block', () => {
  const { root, bubble } = setup();
  showToolProgress(bubble, 'Working…');
  insertLiveThink(bubble);
  clearToolProgress(bubble);
  assert.equal(root.querySelectorAll('.tool-progress').length, 0,
    'DONE/cancel must clear the progress line even with the think block in the way');
  assert.equal(root.querySelectorAll('.live-think').length, 1,
    'the think block itself is the renderer\'s to remove — clearToolProgress must not touch it');
});

test('clearToolProgress never reaches past another message bubble', () => {
  const { root, bubble } = setup();
  const older = document.createElement('div');
  older.className = 'msg assistant';
  root.insertBefore(older, bubble);
  const stray = document.createElement('div');
  stray.className = 'tool-progress';
  root.insertBefore(stray, older); // belongs to the OLDER bubble, not ours
  clearToolProgress(bubble);
  assert.equal(root.querySelectorAll('.tool-progress').length, 1,
    'another turn\'s progress line must survive');
});
