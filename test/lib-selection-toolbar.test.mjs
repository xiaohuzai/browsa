// test/lib-selection-toolbar.test.mjs — real jsdom execution test of the
// content script lib/content-scripts/selection-toolbar.js (743 lines, previously
// with zero coverage anywhere in the suite).
//
// Why this matters: the script is a self-executing IIFE injected into every
// https page. A typo or a reference to a missing API would silently break the
// floating selection toolbar for ALL users, and nothing else in the suite would
// catch it. These tests load the real source into jsdom with a mocked chrome
// surface and assert its observable side effects.
//
// The toolbar UI lives in a CLOSED shadow root, so its internals are not
// inspectable — assertions target what the outside world can see: the injected
// host elements, the install guard, and the chrome.runtime messages the script
// sends. `window.getSelection()` rects are all-zero in jsdom, so the mouseup →
// show path cannot be exercised here; the selectionchange → cache path (which
// does not depend on layout) is covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../lib/content-scripts/selection-toolbar.js', import.meta.url), 'utf8');

function setup() {
  const dom = new JSDOM(
    '<!doctype html><html><body><p id="p">Hello brave new world of toolbars</p></body></html>',
    { url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const sent = [];
  let onChanged = null;
  const w = dom.window;
  w.chrome = {
    runtime: {
      getURL: (p) => 'chrome-extension://test/' + p,
      sendMessage: (m) => { sent.push(m); },
      connect: () => ({
        postMessage() {}, disconnect() {},
        onMessage: { addListener() {} }, onDisconnect: { addListener() {} },
      }),
      lastError: null,
    },
    storage: {
      local: { get: (k, cb) => { if (typeof cb === 'function') cb({}); }, set() {} },
      onChanged: { addListener: (fn) => { onChanged = fn; } },
    },
    i18n: { getMessage: () => '' },
  };
  // jsdom has no fetch; the script's async locale refresh calls it.
  w.fetch = async () => ({ json: async () => ({}) });
  return { dom, w, sent, getOnChanged: () => onChanged };
}

function selectAll(w, text) {
  const p = w.document.getElementById('p');
  const range = w.document.createRange();
  range.selectNodeContents(p);
  const sel = w.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  if (text != null) assert.equal(sel.toString(), text); // sanity: jsdom honored the range
}

test('selection toolbar: loads into an https page and injects its host elements exactly once', () => {
  const { dom, w } = setup();
  w.eval(SRC);
  assert.ok(w.document.getElementById('browsa-sel-host'), 'toolbar host must be injected into body');
  assert.ok(w.document.getElementById('browsa-sel-pop-host'), 'explain popover host must be injected');
  assert.equal(w.__browsaSelectionToolbarInstalled, true, 'install flag must be set');

  // Re-running the script (e.g. re-injection on SPA navigation) must be a no-op.
  w.eval(SRC);
  assert.equal(w.document.querySelectorAll('#browsa-sel-host').length, 1, 'must never inject a second toolbar host');
  assert.equal(w.document.querySelectorAll('#browsa-sel-pop-host').length, 1, 'must never inject a second popover host');
  dom.window.close();
});

test('selection toolbar: bails out when chrome.runtime is absent (non-extension context)', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.com/', runScripts: 'outside-only' });
  dom.window.eval(SRC); // no chrome global
  assert.equal(dom.window.document.getElementById('browsa-sel-host'), null, 'must not inject without chrome.runtime');
  dom.window.close();
});

test('selection toolbar: selectionchange caches the selected text to the background', () => {
  const { dom, w, sent } = setup();
  w.eval(SRC);
  sent.length = 0; // drop any load-time messages

  selectAll(w, 'Hello brave new world of toolbars');
  w.document.dispatchEvent(new w.Event('selectionchange'));

  const cache = sent.find((m) => m.type === 'SELECTION_CACHE');
  assert.ok(cache, 'a SELECTION_CACHE message must be sent on selectionchange');
  assert.equal(cache.text, 'Hello brave new world of toolbars');
  dom.window.close();
});

test('selection toolbar: selectionchange with an empty selection still sends an empty cache (clears the side panel)', () => {
  const { dom, w, sent } = setup();
  w.eval(SRC);
  w.getSelection().removeAllRanges();
  sent.length = 0;
  w.document.dispatchEvent(new w.Event('selectionchange'));
  const cache = sent.find((m) => m.type === 'SELECTION_CACHE');
  assert.ok(cache, 'must send a SELECTION_CACHE even when nothing is selected');
  assert.equal(cache.text, '');
  dom.window.close();
});

test('selection toolbar: registers a storage.onChanged listener; toggling the setting off does not throw', () => {
  const { dom, w, getOnChanged } = setup();
  w.eval(SRC);
  const onChanged = getOnChanged();
  assert.equal(typeof onChanged, 'function', 'must subscribe to storage changes for the live setting toggle');
  assert.doesNotThrow(() => onChanged({ showSelectionToolbar: { newValue: false } }, 'local'));
  // A mouseup while disabled must be a clean no-op (toolbar stays hidden).
  assert.doesNotThrow(() => w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true })));
  // Re-enabling likewise must not throw.
  assert.doesNotThrow(() => onChanged({ showSelectionToolbar: { newValue: true } }, 'local'));
  dom.window.close();
});

test('selection toolbar: mouseup/keydown/scroll/resize handlers are wired without throwing', () => {
  const { dom, w } = setup();
  w.eval(SRC);
  assert.doesNotThrow(() => {
    w.document.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    w.document.dispatchEvent(new w.Event('contextmenu'));
    w.document.dispatchEvent(new w.Event('scroll'));
    w.dispatchEvent(new w.Event('resize'));
  });
  dom.window.close();
});
