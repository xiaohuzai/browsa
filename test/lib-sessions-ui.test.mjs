// test/lib-sessions-ui.test.mjs — execution tests for lib/sessions-ui.js,
// extracted from sidepanel.js in the Phase 3 modularization refactor.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;

const sentMessages = [];
// Server-side session store backing the fake GET_SESSIONS — mirrors
// lib/storage.js's contract: query filters name OR content, pinned first.
let storageHistory = [{ role: 'user', content: 'hi' }];
let serverSessions = [
  // Append-ordered like real chrome.storage: OLDEST first; GET_SESSIONS
  // reverses to newest-first for display.
  { id: 's2', name: 'Second session', createdAt: Date.now() - 3_600_000 },
  { id: 's1', name: 'First session', createdAt: Date.now() - 60_000 },
];
// Generic chrome.storage.local KV backing store (activeSessionId 等 history
// 之外的键)；history 走上面的 storageHistory 变量，测试用例直接改写它。
let localStore = {};
let loadSessionOk = true; // B5 用例用：模拟 LOAD_SESSION 未命中（内层 ok:false）
let saveSessionFails = false; // 空-origin 用例：模拟 SAVE_SESSION 没能保存（无 data.session）
let failedMessageType = '';
let noReceiverMessageType = '';
let deferredSessionsResponse = null;
let deferredRenameResponse = null;
globalThis.chrome = {
  runtime: {
    sendMessage: (msg, cb) => {
      sentMessages.push(msg);
      if (msg.type === failedMessageType) {
        return cb({ ok: false, error: 'Storage write failed', code: 'Error', hint: '' });
      }
      if (msg.type === noReceiverMessageType) {
        chrome.runtime.lastError = { message: 'Receiving end does not exist' };
        cb(undefined);
        chrome.runtime.lastError = undefined;
        return;
      }
      if (msg.type === 'GET_SESSIONS') {
        if (deferredSessionsResponse) { deferredSessionsResponse(cb); return; }
        const q = String(msg.q || '').trim().toLowerCase();
        let list = [...serverSessions].reverse();
        if (q) {
          list = list.filter(s =>
            s.name.toLowerCase().includes(q) ||
            (s.history || []).some(m => typeof m?.content === 'string' && m.content.toLowerCase().includes(q)));
        }
        return cb({ ok: true, data: { sessions: list } });
      }
      if (msg.type === 'RENAME_SESSION' && deferredRenameResponse) {
        deferredRenameResponse(cb); return;
      }
      if (msg.type === 'GET_SESSION_FULL') {
        const s = serverSessions.find(s => s.id === msg.id);
        return cb({ data: { session: s ? { ...s, history: storageHistory } : null } });
      }
      if (msg.type === 'SAVE_SESSION') {
        // 真实 handler 形状：成功回 data.session（带 id——原地写回时即传入的
        // id），失败无 data。loadSession 的 savedId 从这里取。
        if (saveSessionFails) return cb({ ok: true });
        return cb({ ok: true, data: { session: { id: msg.id || 'saved-new', name: 'Saved' } } });
      }
      if (msg.type === 'REASSIGN_STREAM_SESSION') {
        // 真实 background 契约（2026-09-30 批A）：空 origin 拒绝转后台。
        return cb({ ok: true, data: { reassigned: !!msg.sessionId } });
      }
      if (msg.type === 'LOAD_SESSION') {
        // 真实 envelope：外层 ok 恒 true，判据在内层 data.ok（B5 修复后的唯一读法）。
        return cb({ ok: true, data: { ok: loadSessionOk, len: loadSessionOk ? 2 : -1 } });
      }
      cb({ ok: true, data: { ok: true } });
    },
    lastError: undefined,
  },
  storage: {
    local: {
      get: async (keys) => {
        const wanted = keys == null ? Object.keys(localStore) : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of wanted) out[k] = k === 'history' ? storageHistory : localStore[k];
        return out;
      },
      set: async (obj) => { Object.assign(localStore, obj); },
    },
  },
};

const {
  initSessionsUI, getSessionsDrawer, openSessionsDrawer, closeSessionsDrawer,
  onSessionSearch, clearAllSessions, loadSession, renderSessionsList
} = await import('../lib/sidepanel/sessions-ui.js');

const deps = {
  renderHistoryCalled: 0,
  scrollForced: null,
  imagesCleared: false,
  streaming: false,
  stoppedWatching: false,
  cancelledDrop: false,
  resumed: false,
  agentSessionInfo: null,
};
initSessionsUI({
  isStreaming: () => deps.streaming,
  stopWatchingStream: () => { deps.stoppedWatching = true; },
  cancelStreamDrop: () => { deps.cancelledDrop = true; },
  getTabId: () => 7,
  resumeInFlight: () => { deps.resumed = true; },
  renderHistory: async () => { deps.renderHistoryCalled++; },
  scrollToBottom: (force) => { deps.scrollForced = force; },
  clearPendingImages: () => { deps.imagesCleared = true; },
  getAgentSessionInfo: async () => deps.agentSessionInfo,
});

function setupDom() {
  closeSessionsDrawer();
  const toastContainer = document.querySelector('.toast-container');
  toastContainer?.replaceChildren();
  sentMessages.length = 0;
  deps.renderHistoryCalled = 0; deps.scrollForced = null; deps.imagesCleared = false;
  deps.streaming = false; deps.stoppedWatching = false; deps.cancelledDrop = false; deps.resumed = false;
  deps.agentSessionInfo = null;
  localStore = {}; // 归属指针等 local 键随用例复位
  loadSessionOk = true;
  saveSessionFails = false;
  failedMessageType = '';
  noReceiverMessageType = '';
  deferredSessionsResponse = null;
  deferredRenameResponse = null;
  initSessionsUI({ getAgentSessionInfo: async () => deps.agentSessionInfo });
  serverSessions = [
    { id: 's2', name: 'Second session', createdAt: Date.now() - 3_600_000 },
    { id: 's1', name: 'First session', createdAt: Date.now() - 60_000 },
  ];
  document.body.innerHTML = `
    <div id="sessions-drawer" hidden>
      <input class="sessions-search" />
      <div id="agent-session-line" class="agent-session-line" hidden></div>
      <div id="sessions-list"></div>
    </div>`;
  // The real toast utility owns a lazily created container across calls.
  // Preserve that DOM node across fixtures instead of leaving it detached.
  if (toastContainer) document.body.appendChild(toastContainer);
}
beforeEach(() => setupDom());

test('direct rename action edits without loading and can be used again after cancel', async () => {
  await renderSessionsList();
  const row = document.querySelector('.session-item');
  const rename = row.querySelector('.session-rename-btn');
  assert.ok(rename, 'rename must be discoverable without a double-click');
  rename.click();
  assert.equal(row.querySelector('.session-rename-input')?.value, 'First session');
  assert.equal(sentMessages.some(m => m.type === 'LOAD_SESSION'), false);
  rename.click();
  assert.equal(row.querySelectorAll('.session-rename-input').length, 1);
  row.querySelector('.session-rename-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  document.querySelector('.session-rename-btn').click();
  assert.equal(document.querySelector('.session-rename-input')?.value, 'First session');
});

for (const succeeds of [true, false]) {
  test(`pending rename cannot reopen an editable done input and unlocks after ${succeeds ? 'success' : 'failure'}`, async () => {
    await renderSessionsList();
    const row = document.querySelector('.session-item');
    const button = row.querySelector('.session-rename-btn');
    button.click();
    const input = row.querySelector('.session-rename-input');
    input.value = 'First edit';
    let reply;
    deferredRenameResponse = cb => { reply = cb; };
    button.focus(); // Tab from the input starts the blur save.
    button.click(); // Keyboard activation must not revive the committed editor.
    assert.ok(reply, 'blur must start the save');
    assert.equal(input.disabled, true, 'saving input must not accept edits that cannot be saved');
    assert.equal(button.disabled, true, 'cannot reopen this row until its save completes');
    assert.notEqual(document.activeElement, input);
    failedMessageType = 'GET_SESSIONS'; // Keep this row to check completion locally.
    reply(succeeds ? { ok: true } : { ok: false, error: 'Storage write failed' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(row.querySelector('.session-rename-input'), null);
    assert.equal(button.disabled, false);
    button.click();
    assert.equal(row.querySelector('.session-rename-input')?.value, succeeds ? 'First edit' : 'First session');
    row.querySelector('.session-rename-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));
  });
}

test('a refresh started by rename blur cannot remove a newly opened editor', async () => {
  await renderSessionsList();
  const buttons = [...document.querySelectorAll('.session-rename-btn')];
  buttons[0].focus(); buttons[0].click();
  buttons[1].focus(); buttons[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('.session-rename-input')?.value, 'Second session');
  assert.equal(document.activeElement, document.querySelector('.session-rename-input'));
});

test('a changed-name blur cannot replace an editor opened on another row', async () => {
  await renderSessionsList();
  const buttons = [...document.querySelectorAll('.session-rename-btn')];
  buttons[0].focus(); buttons[0].click();
  document.querySelector('.session-rename-input').value = 'Renamed first';
  buttons[1].focus(); buttons[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('.session-rename-input')?.value, 'Second session');
  assert.equal(document.activeElement, document.querySelector('.session-rename-input'));
});

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

test('renderSessionsList forwards the search query to GET_SESSIONS (server-side filter)', async () => {
  onSessionSearch({ target: { value: 'second' } });
  await new Promise((r) => setTimeout(r, 250)); // debounced 200ms
  const items = document.querySelectorAll('.session-item');
  assert.equal(items.length, 1);
  assert.match(items[0].querySelector('.session-item-name').textContent, /Second session/);
  assert.ok(sentMessages.some(m => m.type === 'GET_SESSIONS' && m.q === 'second'),
    'the raw query must reach the background (it filters names AND content there)');
});

test('renderSessionsList shows an empty state when the server-side search finds nothing', async () => {
  onSessionSearch({ target: { value: 'no-such-session-xyz' } });
  await new Promise((r) => setTimeout(r, 250));
  assert.match(document.getElementById('sessions-list').textContent, /No sessions match/);
});

test('delete is a two-step arm: first click arms, second click deletes without any confirm dialog', async () => {
  openSessionsDrawer(); // also resets the search filter left over from a previous test
  await new Promise((r) => setTimeout(r, 10));
  const delBtn = document.querySelector('.session-item .session-del-btn');

  // First plain click: arms only — no DELETE_SESSION yet.
  delBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.ok(delBtn.classList.contains('armed'), 'armed state must be visible');
  assert.ok(!sentMessages.some(m => m.type === 'DELETE_SESSION'), 'arming must not delete');

  // Second click while armed (no Ctrl): commits — no confirm dialog involved.
  delBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sentMessages.some(m => m.type === 'DELETE_SESSION' && m.id === 's1'));
});

test('Ctrl+click on delete skips arming and deletes immediately', async () => {
  openSessionsDrawer();
  await new Promise((r) => setTimeout(r, 10));
  const delBtn = document.querySelector('.session-item .session-del-btn');
  delBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sentMessages.some(m => m.type === 'DELETE_SESSION' && m.id === 's1'));
});

test('pinned sessions get their own group, hide the delete button, and toggle via PIN_SESSION', async () => {
  serverSessions.find(s => s.id === 's1').pinned = true; // s1 pinned
  openSessionsDrawer();
  await new Promise((r) => setTimeout(r, 10));

  // Pinned band first, then the time buckets.
  const labels = [...document.querySelectorAll('.sessions-group-label')].map(l => l.textContent);
  assert.equal(labels[0], 'Pinned');

  const pinnedItem = document.querySelector('.session-item.pinned');
  assert.ok(pinnedItem, 's1 must render as pinned');
  assert.ok(!pinnedItem.querySelector('.session-del-btn'), 'pinned rows must not offer delete');
  assert.ok(pinnedItem.querySelector('.session-pin-btn.active'), 'pin button shows active state');
  assert.ok(!serverSessions.find(s => s.id === 's2').pinned);

  // Unpin via the pin button → PIN_SESSION with flipped flag.
  pinnedItem.querySelector('.session-pin-btn').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sentMessages.some(m => m.type === 'PIN_SESSION' && m.id === 's1' && m.pinned === false));
});

test('unfiltered list groups by time buckets (Today for the fresh session)', async () => {
  openSessionsDrawer();
  await new Promise((r) => setTimeout(r, 10));
  const labels = [...document.querySelectorAll('.sessions-group-label')].map(l => l.textContent);
  assert.deepEqual(labels.filter(t => /^(Today|Yesterday|This week|Earlier|Pinned)$/.test(t)).length > 0, true,
    'at least one bucket label must appear');
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

// A failed background envelope must stop each mutation's success branch.
// These exercise the real row handlers, confirm dialog, and toast utility.
for (const type of ['PIN_SESSION', 'DELETE_SESSION', 'RENAME_SESSION', 'CLEAR_ALL_SESSIONS']) {
  test(`${type} surfaces a storage failure without claiming success`, async () => {
    openSessionsDrawer();
    await new Promise(resolve => setImmediate(resolve));
    failedMessageType = type;
    if (type === 'CLEAR_ALL_SESSIONS') {
      const clearing = clearAllSessions();
      await autoConfirm(true);
      await clearing;
    } else {
      const item = document.querySelector('.session-item');
      if (type === 'PIN_SESSION') {
        item.querySelector('.session-pin-btn').click();
      } else if (type === 'DELETE_SESSION') {
        item.querySelector('.session-del-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
      } else {
        item.querySelector('.session-item-name').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
        const input = item.querySelector('.session-rename-input');
        input.value = 'Changed name';
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    const errorToast = document.querySelector('.toast-error');
    assert.ok(errorToast, 'a failed operation must have a visible error notification');
    assert.match(errorToast.textContent, /Storage write failed/);
    assert.equal(document.querySelector('.toast-success'), null, 'failed storage must never show a success toast');
    assert.equal(document.querySelectorAll('.session-item').length, 2, 'saved sessions must remain available');
    assert.equal(document.querySelector('.session-item-name').textContent, 'First session', 'failed rename must restore the previous name');
    assert.equal(document.querySelector('.session-pin-btn').classList.contains('active'), false, 'failed pin must remain unpinned');
  });
}

test('clearAllSessions surfaces a missing service worker instead of showing success', async () => {
  noReceiverMessageType = 'CLEAR_ALL_SESSIONS';
  const clearing = clearAllSessions();
  await autoConfirm(true);
  await clearing;
  assert.match(document.querySelector('.toast-error')?.textContent || '', /Receiving end does not exist/);
  assert.equal(document.querySelector('.toast-success'), null);
});

test('a failed sessions refresh preserves the visible list and reports the read error', async () => {
  openSessionsDrawer();
  await new Promise(resolve => setImmediate(resolve));
  const visibleNames = ['First session', 'Second session'];
  let reply;
  deferredSessionsResponse = cb => { reply = cb; };
  const refresh = renderSessionsList();
  await new Promise(resolve => setImmediate(resolve));
  const pendingNames = [...document.querySelectorAll('.session-item-name')].map(el => el.textContent);
  reply({ ok: false, error: 'Storage read failed', code: 'Error', hint: '' });
  await refresh;
  assert.match(document.querySelector('.toast-error')?.textContent || '', /Storage read failed/);
  assert.deepEqual(pendingNames, visibleNames, 'the previous list stays visible while its replacement is loading');
  assert.deepEqual([...document.querySelectorAll('.session-item-name')].map(el => el.textContent), visibleNames,
    'failed refresh must leave the previous sessions visible');
  assert.equal(document.querySelector('.sessions-empty'), null, 'a read error is not an empty session store');
});

for (const ending of ['cancel', 'unchanged commit']) {
  test(`${ending} exits session rename locally when the list refresh fails`, async () => {
    openSessionsDrawer();
    await new Promise(resolve => setImmediate(resolve));
    const body = document.querySelector('.session-item-body');
    body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    const input = body.querySelector('.session-rename-input');
    if (ending === 'cancel') input.value = 'Discarded draft';
    failedMessageType = 'GET_SESSIONS';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ending === 'cancel' ? 'Escape' : 'Enter', bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(body.querySelector('.session-rename-input'), null, 'ending the edit must remove its done input without relying on a refresh');
    assert.equal(body.querySelector('.session-item-name')?.textContent, 'First session');
    assert.equal(sentMessages.some(msg => msg.type === 'RENAME_SESSION'), false, 'cancel and no-op commits must not rename');
    body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    assert.equal(body.querySelector('.session-rename-input')?.value, 'First session', 'F2 must be able to begin a new edit');
  });
}

test('successful session rename exits the editor and uses the saved name when its refresh fails', async () => {
  openSessionsDrawer();
  await new Promise(resolve => setImmediate(resolve));
  const body = document.querySelector('.session-item-body');
  body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  const input = body.querySelector('.session-rename-input');
  input.value = 'Saved new name';
  failedMessageType = 'GET_SESSIONS';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(body.querySelector('.session-rename-input'), null, 'successful save must exit the editor before refreshing');
  assert.equal(body.querySelector('.session-item-name')?.textContent, 'Saved new name');
  body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getSessionsDrawer().hidden, true, 'the retained row must still load the session');
  assert.match([...document.querySelectorAll('.toast-success')].map(el => el.textContent).join('\n'), /Loaded: "Saved new name"/,
    'retained row handlers must use the latest saved name when loading');
});

test('a stale agent-session lookup cannot erase a newer session list or overwrite its agent id', async () => {
  let resolveOldAgentInfo;
  let lookupCount = 0;
  initSessionsUI({
    getAgentSessionInfo: () => ++lookupCount === 1
      ? new Promise(resolve => { resolveOldAgentInfo = resolve; })
      : Promise.resolve({ id: 'new-agent-session' }),
  });
  const oldRender = renderSessionsList();
  await renderSessionsList();
  assert.equal(document.querySelectorAll('.session-item').length, 2);
  let resolveOldSessions;
  deferredSessionsResponse = cb => { resolveOldSessions = cb; };
  resolveOldAgentInfo({ id: 'old-agent-session' });
  await new Promise(resolve => setImmediate(resolve));
  // Always drain the old render, even when the assertion below fails.
  const names = [...document.querySelectorAll('.session-item-name')].map(el => el.textContent);
  const agentId = document.querySelector('.agent-session-id')?.title;
  resolveOldSessions?.({ ok: true, data: { sessions: [] } });
  await oldRender;
  assert.deepEqual(names, ['First session', 'Second session'], 'old lookup completion must not clear a newer list');
  assert.equal(agentId, 'new-agent-session', 'old lookup completion must not replace the current agent session');
});

test('loadSession keeps an in-flight reply running in the background, saves, loads, and clears pending images', async () => {
  // 2026-09-24：切换会话不再取消在途回复（旧行为把 thinking 烧几分钟的回复
  // 直接蒸发）——转后台 + 停止观看 + 把写入归属钉到来源会话。
  storageHistory = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];
  deps.streaming = true;
  await loadSession('s2', 'Second session');
  assert.equal(deps.stoppedWatching, true, 'the stream is detached (stop-watching), NOT cancelled');
  assert.ok(!sentMessages.some(m => m.type === 'STREAM_ABORT'), 'switching sessions must never abort the turn');
  const reassign = sentMessages.find(m => m.type === 'REASSIGN_STREAM_SESSION');
  assert.ok(reassign, 'the reply is re-pointed at its origin session (background routing)');
  assert.equal(reassign.tabId, 7);
  assert.ok(sentMessages.some(m => m.type === 'SAVE_SESSION'), 'must auto-save before switching since history has messages');
  assert.ok(sentMessages.some(m => m.type === 'LOAD_SESSION' && m.id === 's2'));
  assert.equal(deps.renderHistoryCalled, 1);
  assert.equal(deps.scrollForced, true);
  assert.equal(deps.imagesCleared, true);
  assert.equal(deps.resumed, true, 'reattach hooks run after the swap (switch-back resumes rendering)');
  assert.equal(getSessionsDrawer().hidden, true, 'drawer must close after loading');
});

test('loadSession cancels (does NOT background) an in-flight reply when its origin session could not be saved', async () => {
  // 空-origin 拒绝（2026-09-30 批A）：REASSIGN 转后台按 originSessionId 键控
  // 写回；SAVE_SESSION 失败且无归属指针 → savedId 为空 → 后台会拒绝接管
  //（reassigned:false），若仍旧 detach，DONE 将落回 live history——孤儿回复
  // 漏进刚切入的会话。宁可显式弃置（salvage 也会被 LOAD_SESSION 覆盖）。
  storageHistory = [{ role: 'user', content: 'hi' }];
  saveSessionFails = true;
  deps.streaming = true;
  await loadSession('s2', 'Second session');
  assert.equal(deps.cancelledDrop, true, 'the turn is cancelled (dropped), not detached');
  assert.equal(deps.stoppedWatching, false, 'stop-watching alone would leave the reply to leak into the loaded session');
  assert.ok(!sentMessages.some(m => m.type === 'REASSIGN_STREAM_SESSION'), 'no REASSIGN without an origin');
  assert.ok(sentMessages.some(m => m.type === 'LOAD_SESSION' && m.id === 's2'), 'the switch itself still proceeds');
});

test('loadSession does not SAVE_SESSION when there is no existing conversation to save', async () => {
  storageHistory = [];
  await loadSession('s1', 'First session');
  assert.ok(!sentMessages.some(m => m.type === 'SAVE_SESSION'));
});

// ─── 会话归属：切走已归属的对话必须原地写回，而不是 fork 新条目 ────────────────

test('loadSession writes back into the session the conversation belongs to and re-points the identity at the loaded one', async () => {
  // 模拟“s1 之前被加载过、之后没改过内容”的状态——这是 bug 的最纯复现：
  // 再点一次历史清单，旧行为会 fork 出一份 s1 副本。
  storageHistory = [{ role: 'user', content: 'from s1' }];
  localStore.activeSessionId = 's1';
  await loadSession('s2', 'Second session');
  const save = sentMessages.find(m => m.type === 'SAVE_SESSION');
  assert.ok(save, 'auto-save still runs');
  assert.equal(save.id, 's1', 'SAVE_SESSION must carry the active id → background writes back in place, no fork');
  assert.equal(localStore.activeSessionId, 's2', 'identity pointer must move to the loaded session');
});

test('loadSession with a fresh (untracked) conversation saves without an id — the first-archive safety net', async () => {
  storageHistory = [{ role: 'user', content: 'brand new talk' }];
  await loadSession('s2', 'Second session');
  const save = sentMessages.find(m => m.type === 'SAVE_SESSION');
  assert.ok(save, 'fresh conversation still gets archived before switching');
  assert.equal(save.id, undefined, 'no activeSessionId → plain create, background falls back to a new entry');
  assert.equal(localStore.activeSessionId, 's2', 'identity pointer lands on the loaded session');
});

test('loadSession surfaces a missing session instead of faking success (B5)', async () => {
  // LOAD_SESSION 未命中（内层 ok:false）必须报错、不重指身份、抽屉不关——
  // 此前混层 && 被外层 ok:true 短路，点开已删会话曾 toast Loaded 并挂错 activeSessionId。
  loadSessionOk = false;
  storageHistory = [{ role: 'user', content: 'in place' }];
  localStore.activeSessionId = 's1';
  sentMessages.length = 0;
  openSessionsDrawer();
  const renderedBefore = deps.renderHistoryCalled;
  await loadSession('gone', 'Ghost session');
  assert.equal(deps.renderHistoryCalled, renderedBefore, 'history must not re-render for a failed load');
  assert.equal(localStore.activeSessionId, 's1', 'identity pointer must not move');
  assert.equal(getSessionsDrawer().hidden, false, 'drawer must stay open so the user can pick another');
  loadSessionOk = true;
});

// ─── 跨入口接力：会话抽屉的「Agent 会话」行（2026-10-01） ──────────────────────

test('agent-session line: shows the current provider session id with a copy button when one exists', async () => {
  deps.agentSessionInfo = { id: 'abcd1234-5678-90ab-cdef-ghijklmnop', label: 'Hermes Agent' };
  await renderSessionsList();
  const line = document.getElementById('agent-session-line');
  assert.equal(line.hidden, false, 'the line must be visible when the active provider has an agent session');
  assert.ok(line.querySelector('.agent-session-id'), 'session id element rendered');
  assert.ok(line.querySelector('.agent-session-copy'), 'copy button rendered');
  assert.ok(line.querySelector('.agent-session-id').getAttribute('title').includes('abcd1234'), 'full id rides the title attribute');
});

test('agent-session line: hidden when there is no agent session (LLM provider / fresh install)', async () => {
  deps.agentSessionInfo = null;
  await renderSessionsList();
  const line = document.getElementById('agent-session-line');
  assert.equal(line.hidden, true, 'the line must hide when the active provider has no agent session');
  assert.equal(line.innerHTML, '');
});


test('loading a saved conversation refreshes the visible Agent ID before the drawer is closed', async () => {
  const { getAgentSessionInfo } = await import('../lib/storage.js');
  const oldSessionArea = chrome.storage.session;
  chrome.storage.session = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const key = 'bridgeSessionId_bridge__localhost_3948';
  const a = { contextId: 'A', ids: { [key]: 'thread-A' } };
  const b = { contextId: 'B', ids: { [key]: 'thread-B' } };
  localStore.agentSessionState = a;
  initSessionsUI({ getAgentSessionInfo: async () => getAgentSessionInfo('bridge', { isBridge: true, activeModel: 'http://localhost:3948' }) });
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'LOAD_SESSION') localStore.agentSessionState = msg.id === 's2' ? b : a;
    return send(msg, cb);
  };
  try {
    await renderSessionsList();
    const line = document.getElementById('agent-session-line');
    assert.equal(line.querySelector('.agent-session-id').title, 'thread-A');
    await loadSession('s2', 'B');
    assert.equal(line.querySelector('.agent-session-id').title, 'thread-B');
    await loadSession('s1', 'A');
    assert.equal(line.querySelector('.agent-session-id').title, 'thread-A');
  } finally {
    chrome.runtime.sendMessage = send;
    chrome.storage.session = oldSessionArea;
  }
});
