// test/lib-sessions-ui.test.mjs — execution tests for lib/sessions-ui.js,
// extracted from sidepanel.js in the Phase 3 modularization refactor.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;

const SESSIONS = [
  { id: 's1', name: 'First session', createdAt: Date.now() - 60_000 },
  { id: 's2', name: 'Second session', createdAt: Date.now() - 3_600_000 },
];

const sentMessages = [];
let storageHistory = [{ role: 'user', content: 'hi' }];
globalThis.chrome = {
  runtime: {
    sendMessage: (msg, cb) => {
      sentMessages.push(msg);
      if (msg.type === 'GET_SESSIONS') return cb({ data: { sessions: SESSIONS } });
      if (msg.type === 'GET_SESSION_FULL') {
        const s = SESSIONS.find(s => s.id === msg.id);
        return cb({ data: { session: s ? { ...s, history: storageHistory } : null } });
      }
      if (msg.type === 'LOAD_SESSION') return cb({ ok: true });
      cb({ ok: true });
    },
    lastError: undefined,
  },
  storage: { local: { get: async () => ({ history: storageHistory }) } },
};

const {
  initSessionsUI, getSessionsDrawer, openSessionsDrawer, closeSessionsDrawer,
  onSessionSearch, clearAllSessions, loadSession
} = await import('../lib/sidepanel/sessions-ui.js');

const deps = {
  cancelled: false,
  renderHistoryCalled: 0,
  scrollForced: null,
  imagesCleared: false,
};
initSessionsUI({
  cancelActiveStream: () => { deps.cancelled = true; },
  renderHistory: async () => { deps.renderHistoryCalled++; },
  scrollToBottom: (force) => { deps.scrollForced = force; },
  clearPendingImages: () => { deps.imagesCleared = true; },
});

function setupDom() {
  sentMessages.length = 0;
  deps.cancelled = false; deps.renderHistoryCalled = 0; deps.scrollForced = null; deps.imagesCleared = false;
  document.body.innerHTML = `
    <div id="sessions-drawer" hidden>
      <input class="sessions-search" />
      <div id="sessions-list"></div>
    </div>`;
}
beforeEach(() => setupDom());

// Auto-confirm any showConfirmDialog that pops up (used by delete/clear-all),
// so tests exercising the "confirmed" path don't hang waiting for a click.
function autoConfirm(accept) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000; // give up instead of hanging the suite forever
    const check = () => {
      const modal = document.querySelector('.confirm-modal');
      if (modal) {
        modal.querySelector(accept ? '.confirm-ok' : '.confirm-cancel')
          .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error('autoConfirm: no .confirm-modal appeared within 1s'));
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

test('openSessionsDrawer un-hides the drawer and renders the session list', async () => {
  openSessionsDrawer();
  assert.equal(getSessionsDrawer().hidden, false);
  await new Promise((r) => setTimeout(r, 10)); // renderSessionsList is async
  const items = document.querySelectorAll('.session-item');
  assert.equal(items.length, 2);
  assert.match(items[0].querySelector('.session-item-name').textContent, /First session/);
});

test('closeSessionsDrawer hides the drawer', () => {
  openSessionsDrawer();
  closeSessionsDrawer();
  assert.equal(getSessionsDrawer().hidden, true);
});

test('renderSessionsList filters by the current search query', async () => {
  onSessionSearch({ target: { value: 'second' } });
  await new Promise((r) => setTimeout(r, 250)); // debounced 200ms
  const items = document.querySelectorAll('.session-item');
  assert.equal(items.length, 1);
  assert.match(items[0].querySelector('.session-item-name').textContent, /Second session/);
});

test('renderSessionsList shows an empty state when there are no saved sessions', async () => {
  onSessionSearch({ target: { value: 'no-such-session-xyz' } });
  await new Promise((r) => setTimeout(r, 250));
  assert.match(document.getElementById('sessions-list').textContent, /No sessions match/);
});

test('clicking a session delete button asks for confirmation, then sends DELETE_SESSION and refreshes the list', async () => {
  openSessionsDrawer(); // also resets the search filter left over from a previous test
  await new Promise((r) => setTimeout(r, 10));
  const delBtn = document.querySelector('.session-item .session-del-btn');
  const confirmed = autoConfirm(true);
  delBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await confirmed;
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sentMessages.some(m => m.type === 'DELETE_SESSION' && m.id === 's1'));
});

test('clearAllSessions is a no-op if the user cancels the confirmation', async () => {
  const p = clearAllSessions();
  const declined = autoConfirm(false);
  await declined;
  await p;
  assert.ok(!sentMessages.some(m => m.type === 'CLEAR_ALL_SESSIONS'));
});

test('clearAllSessions sends CLEAR_ALL_SESSIONS when confirmed', async () => {
  const p = clearAllSessions();
  const confirmed = autoConfirm(true);
  await confirmed;
  await p;
  assert.ok(sentMessages.some(m => m.type === 'CLEAR_ALL_SESSIONS'));
});

test('loadSession cancels the active stream, saves the current conversation, loads the target, and clears pending images', async () => {
  storageHistory = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];
  await loadSession('s2', 'Second session');
  assert.equal(deps.cancelled, true);
  assert.ok(sentMessages.some(m => m.type === 'SAVE_SESSION'), 'must auto-save before switching since history has messages');
  assert.ok(sentMessages.some(m => m.type === 'LOAD_SESSION' && m.id === 's2'));
  assert.equal(deps.renderHistoryCalled, 1);
  assert.equal(deps.scrollForced, true);
  assert.equal(deps.imagesCleared, true);
  assert.equal(getSessionsDrawer().hidden, true, 'drawer must close after loading');
});

test('loadSession does not SAVE_SESSION when there is no existing conversation to save', async () => {
  storageHistory = [];
  await loadSession('s1', 'First session');
  assert.ok(!sentMessages.some(m => m.type === 'SAVE_SESSION'));
});
