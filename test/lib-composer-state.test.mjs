// test/lib-composer-state.test.mjs — ↑/↓ input-history navigation (eligibility,
// draft restore, consecutive dedupe) and draft persistence across panel reopen.
//
// The module keeps its recall list/draft in module-level state, so each test
// loads a FRESH instance via a unique import specifier (?round=N) — Node ESM
// treats each unique specifier as its own module instantiation.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;

let stored = {};
Object.defineProperty(globalThis, 'chrome', {
  value: {
    storage: {
      local: {
        get: async (key) => ({ [key]: stored[key] }),
        set: async (obj) => { stored = { ...stored, ...obj }; },
      },
    },
  },
  writable: true,
  configurable: true,
});

let round = 0;
async function freshModule() {
  return await import(`../lib/sidepanel/composer-state.js?round=${++round}`);
}

function makeInput(value = '') {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  el.value = value;
  return el;
}

function setCaret(el, pos) {
  el.selectionStart = pos;
  el.selectionEnd = pos;
}

// Synthetic keydown whose .target points at the input (jsdom doesn't wire it).
function keydown(el, key, opts = {}) {
  const e = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  Object.defineProperty(e, 'target', { value: el });
  return e;
}

beforeEach(() => {
  stored = {};
  document.body.innerHTML = '';
});

test('ArrowUp recalls the last sent message when the composer is empty', async () => {
  const cs = await freshModule();
  cs.pushInputHistory('first question');
  cs.pushInputHistory('second question');

  const input = makeInput('');
  const handled = cs.handleHistoryNav(keydown(input, 'ArrowUp'));
  assert.equal(handled, true);
  assert.equal(input.value, 'second question');
});

test('second ArrowUp walks back; ArrowDown returns forward; past-the-end restores the saved draft', async () => {
  const cs = await freshModule();
  cs.pushInputHistory('q1');
  cs.pushInputHistory('q2');
  const text = 'draft in progress';
  const input = makeInput(text);
  setCaret(input, text.length); // caret at end ⇒ eligible

  assert.equal(cs.handleHistoryNav(keydown(input, 'ArrowUp')), true);
  assert.equal(input.value, 'q2');
  setCaret(input, input.value.length); // module set the value; place caret like a real browser would
  assert.equal(cs.handleHistoryNav(keydown(input, 'ArrowUp')), true);
  assert.equal(input.value, 'q1');
  setCaret(input, input.value.length);
  assert.equal(cs.handleHistoryNav(keydown(input, 'ArrowDown')), true);
  assert.equal(input.value, 'q2');
  setCaret(input, input.value.length);
  assert.equal(cs.handleHistoryNav(keydown(input, 'ArrowDown')), true);
  assert.equal(input.value, 'draft in progress');
});

test('mid-text arrows are left alone (normal caret movement)', async () => {
  const cs = await freshModule();
  cs.pushInputHistory('hello');
  const input = makeInput('abc def');
  setCaret(input, 3);
  assert.equal(cs.handleHistoryNav(keydown(input, 'ArrowUp')), false);
});

test('navigation is blocked when the caller vetoes (slash panel open); empty history is a no-op', async () => {
  const cs = await freshModule();
  const input = makeInput('text');
  setCaret(input, 4);
  cs.pushInputHistory('hello');
  assert.equal(cs.handleHistoryNav(keydown(input, 'ArrowUp'), () => true), false, 'vetoed');

  const fresh = await freshModule();
  const empty = makeInput('');
  assert.equal(fresh.handleHistoryNav(keydown(empty, 'ArrowUp')), false, 'no history yet');
});

test('consecutive duplicate sends collapse in the recall list', async () => {
  const cs = await freshModule();
  const input = makeInput();
  cs.attachDraftPersistence(input);
  cs.pushInputHistory('same');
  cs.pushInputHistory('same');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(stored.composerState.history, ['same']);
});

test('draft survives persist→restore roundtrip and never overwrites typed text', async () => {
  const cs = await freshModule();
  const input = makeInput();
  cs.attachDraftPersistence(input);
  input.value = 'unsent thought';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500)); // debounce 400ms

  // New panel session: fresh module instance reading the same storage.
  const cs2 = await freshModule();
  const reopened = makeInput();
  await cs2.restoreComposerState(reopened);
  assert.equal(reopened.value, 'unsent thought');

  const busy = makeInput('already typing');
  await cs2.restoreComposerState(busy);
  assert.equal(busy.value, 'already typing');
});

test('clearPersistedDraft empties the draft but keeps the recall history', async () => {
  const cs = await freshModule();
  const input = makeInput();
  cs.attachDraftPersistence(input);
  cs.pushInputHistory('remembered q');
  input.value = 'about to send';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));

  cs.clearPersistedDraft();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(stored.composerState.draft, '');
  assert.deepEqual(stored.composerState.history, ['remembered q']);
});

test('recall state is per-input: walks never leak between two inputs of one scope', async () => {
  // Within one scope the recall list is shared by every input wired to it,
  // but an in-progress walk must stay bound to the input that started it —
  // otherwise ↑ in one input resumes the other's position and ↓-past-the-end
  // writes the other's saved draft here.
  const cs = await freshModule();
  cs.pushInputHistory('q1');
  cs.pushInputHistory('q2');
  const a = makeInput('draft-a');
  setCaret(a, 'draft-a'.length);
  const b = makeInput('');

  assert.equal(cs.handleHistoryNav(keydown(a, 'ArrowUp')), true);
  assert.equal(a.value, 'q2', 'a starts its walk at the newest');
  assert.equal(cs.handleHistoryNav(keydown(a, 'ArrowUp')), true);
  assert.equal(a.value, 'q1', 'a walks back');

  // b's first ↑ starts a FRESH walk at the newest instead of continuing a's
  assert.equal(cs.handleHistoryNav(keydown(b, 'ArrowUp')), true);
  assert.equal(b.value, 'q2');
  assert.equal(cs.handleHistoryNav(keydown(b, 'ArrowUp')), true);
  assert.equal(b.value, 'q1', 'b walks back on its own');

  // a, still mid-walk at q1 while b is armed at q1 too, walks forward
  // independently — each input owns its own position
  setCaret(a, a.value.length);
  assert.equal(cs.handleHistoryNav(keydown(a, 'ArrowDown')), true);
  assert.equal(a.value, 'q2');
  setCaret(a, a.value.length);
  assert.equal(cs.handleHistoryNav(keydown(a, 'ArrowDown')), true);
  assert.equal(a.value, 'draft-a', "past-the-end restores a's own draft, not b's");

  // resetHistoryNav from the WRONG input is a no-op: b (armed at q1) keeps
  // its walk — ↑ stays put at the oldest entry instead of restarting at q2.
  cs.resetHistoryNav(a);
  assert.equal(cs.handleHistoryNav(keydown(b, 'ArrowUp')), true);
  assert.equal(b.value, 'q1', 'b is still armed — walk survives a foreign reset');
  // …and b's own reset ends it, restoring b's pre-nav draft (empty).
  cs.resetHistoryNav(b);
  assert.equal(b.value, '');
});

test('createInputHistory scopes are independent: separate lists and separate storage rows', async () => {
  const cs = await freshModule();
  cs.pushInputHistory('main q');
  const sub = cs.createInputHistory({ storageKey: 'subInputHistory' });
  sub.pushInputHistory('sub q');

  const mainInput = makeInput('');
  assert.equal(cs.handleHistoryNav(keydown(mainInput, 'ArrowUp')), true);
  assert.equal(mainInput.value, 'main q', 'the main scope recalls only its own sends');

  const subInput = makeInput('');
  assert.equal(sub.handleHistoryNav(keydown(subInput, 'ArrowUp')), true);
  assert.equal(subInput.value, 'sub q', 'the card scope recalls only its own sends');

  await new Promise(r => setTimeout(r, 500)); // debounce 400ms
  assert.deepEqual(stored.composerState.history, ['main q'], 'main pushes stay in the composerState row');
  assert.deepEqual(stored.subInputHistory, { history: ['sub q'] },
    'the card scope persists under its own key, history only — no draft field');
});

test('a card-scope list persists and restores across a panel reopen', async () => {
  const cs = await freshModule();
  const a = cs.createInputHistory({ storageKey: 'cardHist' });
  a.pushInputHistory('earlier follow-up');
  await new Promise(r => setTimeout(r, 500)); // debounce 400ms

  // "Reopened panel": a brand-new scope instance over the same key.
  const b = cs.createInputHistory({ storageKey: 'cardHist' });
  await b.loadInputHistory();
  const input = makeInput('');
  assert.equal(b.handleHistoryNav(keydown(input, 'ArrowUp')), true);
  assert.equal(input.value, 'earlier follow-up');
});
