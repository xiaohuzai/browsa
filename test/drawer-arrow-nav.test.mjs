// test/drawer-arrow-nav.test.mjs — drawer ↑/↓ row traversal (2026-10-17 a11y
// pass). initArrowNav is plain DOM: functional tests in jsdom + source pins
// that BOTH drawers actually wired it (the wiring floor: a helper nobody calls
// must go red).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initArrowNav } from '../lib/sidepanel/ui-utils.js';

function makeList() {
  const dom = new JSDOM('<div id="list"><button class="row">a</button><button class="row">b</button><button class="row">c</button></div>');
  // initArrowNav reads the realm-global `document` (like the rest of ui-utils)
  globalThis.document = dom.window.document;
  const list = dom.window.document.getElementById('list');
  const rows = [...list.querySelectorAll('.row')];
  return { dom, list, rows };
}

test('ArrowDown/ArrowUp move row focus with wrap-around', () => {
  const { dom, list, rows } = makeList();
  initArrowNav(list, '.row');
  const doc = dom.window.document;
  const press = (key) => list.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  // from nowhere → first row
  press('ArrowDown');
  assert.equal(doc.activeElement, rows[0]);
  press('ArrowDown');
  assert.equal(doc.activeElement, rows[1]);
  // wrap past the end
  press('ArrowDown'); press('ArrowDown');
  assert.equal(doc.activeElement, rows[0]);
  // wrap backwards
  press('ArrowUp');
  assert.equal(doc.activeElement, rows[rows.length - 1]);
  // other keys untouched
  press('ArrowLeft');
  assert.equal(doc.activeElement, rows[rows.length - 1]);
});

test('arrow keys inside a row\'s input keep their caret behavior', () => {
  const { dom, list } = makeList();
  list.querySelector('.row').innerHTML = '<input id="rename">';
  initArrowNav(list, '.row');
  const input = dom.window.document.getElementById('rename');
  input.focus();
  // dispatch FROM the input — real keydowns originate there and bubble up
  const ev = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, 'input caret movement must not be hijacked');
});

test('wiring: both drawers call initArrowNav on their row selectors', async () => {
  const sessions = await readFile(new URL('../lib/sidepanel/sessions-ui.js', import.meta.url), 'utf8');
  assert.match(sessions, /initArrowNav\(listEl, '\.session-item'\)/);
  const transcript = await readFile(new URL('../lib/sidepanel/transcript-drawer.js', import.meta.url), 'utf8');
  assert.match(transcript, /initArrowNav\(_listEl, '\.ts-row'\)/);
});
