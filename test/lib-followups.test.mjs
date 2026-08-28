// test/lib-followups.test.mjs — queued follow-ups dock: enqueue/remove/take
// lifecycle, cap behavior, and the rendered chips (label count, preview,
// remove button, click-to-send-now).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const sentNow = [];
const F = await import('../lib/sidepanel/followups.js');

function mount() {
  document.body.innerHTML = `<div class="composer"><textarea></textarea></div>`;
  F.initFollowups({ mountEl: document.querySelector('.composer'), sendNow: (t) => sentNow.push(t) });
}

beforeEach(() => {
  sentNow.length = 0;
  mount();
});

test('enqueue renders a labeled chip with a remove button; the dock is visible', () => {
  assert.equal(F.enqueueFollowup('帮我翻译这段话'), true);
  const dock = document.querySelector('.followups-dock');
  assert.ok(dock && !dock.hidden);
  assert.match(dock.querySelector('.followups-label').textContent, /1/);
  const item = dock.querySelector('.followup-item');
  assert.match(item.querySelector('.followup-text').textContent, /帮我翻译这段话/);
  assert.ok(item.querySelector('.followup-remove'));
});

test('removeFollowup drops only that chip and hides the empty dock', () => {
  F.enqueueFollowup('first');
  F.enqueueFollowup('second');
  document.querySelectorAll('.followup-remove')[0]
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const items = [...document.querySelectorAll('.followup-text')].map(b => b.textContent);
  assert.deepEqual(items, ['second']);
  F.removeFollowup(F.getQueuedFollowups()[0].id);
  assert.equal(document.querySelector('.followups-dock').hidden, true);
  assert.equal(F.hasQueuedFollowups(), false);
});

test('takeFirstFollowup returns FIFO order for drain-on-stream-end', () => {
  F.enqueueFollowup('one');
  F.enqueueFollowup('two');
  assert.equal(F.takeFirstFollowup(), 'one');
  assert.equal(F.takeFirstFollowup(), 'two');
  assert.equal(F.takeFirstFollowup(), null);
});

test('clicking a chip sends it now via the injected sendNow callback', () => {
  F.enqueueFollowup('send me');
  document.querySelector('.followup-text')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.deepEqual(sentNow, ['send me']);
  assert.equal(F.hasQueuedFollowups(), false);
});

test('empty text and overflow beyond the cap are rejected with the queue intact', () => {
  assert.equal(F.enqueueFollowup('   '), false);
  for (let i = 0; i < 5; i++) assert.equal(F.enqueueFollowup(`m${i}`), true);
  assert.equal(F.enqueueFollowup('extra'), false);
  assert.deepEqual(F.getQueuedFollowups().map(f => f.text), ['m0', 'm1', 'm2', 'm3', 'm4']);
});
