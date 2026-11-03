// test/background-handler.test.mjs
// Integration test for background.js's handle() dispatch.
// This catches bugs like "parameter name mismatch" that pure-function
// tests cannot see.
//
// We mock `chrome.*` APIs BEFORE importing background.js so that the
// module-level listener registrations don't crash. The mock is minimal:
// no-op addListener(), sensible defaults for query/get, and a spy for
// storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --------------- chrome mock -------------------------------------------------
const storageData = {
  contextMode: 'reader',
  maxTextChars: 100_000,
  activeProvider: 'hermes',
  providers: {
    hermes: { baseUrl: 'http://localhost:8642', apiKey: 'sk-test', model: 'test' }
  },
  historyByTab: {}
};

const contextMenuTitles = new Map();
let installedListener;
const storageChangeListeners = [];
const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: fn => { installedListener = fn; } },
    sendMessage: () => {},
    connect: () => null,
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://www.xiaohongshu.com/explore/abc', title: 'Test Note' }],
    get: async () => ({ id: 1, url: 'https://www.xiaohongshu.com/explore/abc', title: 'Test Note' }),
  },
  sidePanel: {
    setOptions: () => {},
    setPanelBehavior: async () => {},
  },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async () => [{ result: { text: '# Mock page\n\nMock content.', articleTitle: 'Mock', wasCapped: false, rawTextLength: 30 } }],
  },
  storage: {
    onChanged: { addListener: fn => storageChangeListeners.push(fn) },
    local: { get: async keys => Object.fromEntries([].concat(keys).map(k => [k, storageData[k]])) },
    // We don't mock the real chrome.storage.sync/local; the storage module
    // has its own inline mocks. If a test reaches real storage.* calls,
    // we rely on the storage module's defaults.
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: () => {} },
  },
  contextMenus: {
    create: opts => { contextMenuTitles.set(opts.id, opts.title); },
    update: async (id, opts) => { contextMenuTitles.set(id, opts.title); },
    removeAll: async () => { contextMenuTitles.clear(); },
    onClicked: { addListener: () => {} },
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

// --------------- import ------------------------------------------------------
// Dynamic import so the mock is in place before background.js evaluates.
const bg = await import('../background.js');
const { handle } = bg;

// --------------- tests -------------------------------------------------------
test('handle returns the stored config on GET_CONFIG', async () => {
  // Real dispatch, real storage read: the old version only asserted that
  // `handle` was a function (its own TODO admitted it), so deleting the
  // GET_CONFIG branch kept it green.
  const res = await handle({ type: 'GET_CONFIG' }, {});
  assert.equal(res.activeProvider, 'hermes', 'GET_CONFIG must return the stored active provider');
  assert.equal(res.providers.hermes.baseUrl, 'http://localhost:8642', 'the provider table must ride along');
  assert.equal(res.contextMode, 'reader', 'other settings survive the round-trip');
});

test('handle tolerates a missing sender on the sender-reading cases (v0.19.0 regression)', async () => {
  // History: v0.19.0 shipped a "sender is not defined" crash because the
  // parameter was renamed while the body still referenced it. The old version of
  // this test claimed to guard that, but it only grepped case labels and parameter
  // names, so an undeclared `sender` still passed. Driving the real cases with
  // sender === undefined fails with ReferenceError if the bug ever comes back.
  const selectionAction = await handle({ type: 'SELECTION_ACTION', action: 'chat', text: 'x' }, undefined);
  assert.deepEqual(selectionAction, { ok: false }, 'no sender tab → benign refusal, not a crash');

  const selectionCache = await handle({ type: 'SELECTION_CACHE', text: 'hello' }, undefined);
  assert.deepEqual(selectionCache, { ok: true }, 'a sender-less selection cache write is a no-op, not a crash');

  const xhs = await handle({ type: 'XHS_XHR_NOTE', note: { title: 'n' } }, undefined);
  assert.deepEqual(xhs, { ok: true }, 'sender-less site pushes are dropped politely');
});

// --------------- XHS_XHR_NOTE tabId regression --------------------------------
// The content script never sends a tabId on XHS_XHR_NOTE — only `note`.
// A previous version read `msg.tabId` (always undefined) instead of
// `sender.tab.id`, so pushXhsNote() silently no-op'd and the cache was
// never populated. This pins the fix: tabId must come from `sender`.
test('XHS_XHR_NOTE derives tabId from sender.tab.id, not msg.tabId', async () => {
  const note = { noteId: 'n1', title: 'test note' };

  // Content script never sets msg.tabId — verify the handler still works.
  const putRes = await handle({ type: 'XHS_XHR_NOTE', note }, { tab: { id: 7 } });
  assert.equal(putRes.ok, true);

  const getRes = await handle({ type: 'GET_XHS_NOTE', tabId: 7 }, { tab: { id: 7 } });
  assert.deepEqual(getRes.note, note, 'note pushed via sender.tab.id=7 must be retrievable for tab 7');

  // A client-supplied msg.tabId for a DIFFERENT tab must be ignored — the
  // note must land under the sender's real tab, not an attacker-chosen one.
  const spoofRes = await handle({ type: 'XHS_XHR_NOTE', tabId: 999, note: { noteId: 'spoofed' } }, { tab: { id: 8 } });
  assert.equal(spoofRes.ok, true);
  const tab999 = await handle({ type: 'GET_XHS_NOTE', tabId: 999 }, { tab: { id: 999 } });
  assert.equal(tab999.note, null, 'msg.tabId must not be trusted — note must not appear under the spoofed tabId');
  const tab8 = await handle({ type: 'GET_XHS_NOTE', tabId: 8 }, { tab: { id: 8 } });
  assert.equal(tab8.note.noteId, 'spoofed', 'note must land under the real sender tab instead');
});

// ─── SEEK_VIDEO: in-place video seek dispatch ───────────────────────────────
// Verifies the [mm:ss] click handler's backend: it must call
// chrome.scripting.executeScript with the target tabId + seconds arg and
// relay the injected function's {ok} result back to the side panel.

test('SEEK_VIDEO calls executeScript on the target tab and relays {ok:true}', async () => {
  let called = null;
  globalThis.chrome.scripting.executeScript = async (opts) => {
    called = opts;
    return [{ result: { ok: true } }];
  };
  const res = await handle({ type: 'SEEK_VIDEO', tabId: 42, seconds: 83 }, { tab: { id: 42 } });
  assert.equal(res.ok, true);
  assert.ok(called, 'executeScript was invoked');
  assert.deepEqual(called.target, { tabId: 42 }, 'targets the requested tab');
  assert.deepEqual(called.args, [83], 'passes seconds as a number arg');
  assert.equal(called.world, 'MAIN', 'runs in MAIN world so YouTube seekTo is reachable');
  assert.equal(typeof called.func, 'function', 'injects a seek function');
});

test('SEEK_VIDEO relays {ok:false} when the page has no <video>', async () => {
  globalThis.chrome.scripting.executeScript = async () => [{ result: { ok: false } }];
  const res = await handle({ type: 'SEEK_VIDEO', tabId: 7, seconds: 5 }, { tab: { id: 7 } });
  assert.equal(res.ok, false);
});

test('SEEK_VIDEO returns {ok:false} without tabId', async () => {
  globalThis.chrome.scripting.executeScript = async () => [{ result: { ok: true } }];
  const res = await handle({ type: 'SEEK_VIDEO', seconds: 5 }, { tab: { id: 7 } });
  assert.equal(res.ok, false);
});

test('SEEK_VIDEO swallows executeScript errors as {ok:false} (tab closed/gone)', async () => {
  globalThis.chrome.scripting.executeScript = async () => { throw new Error('No tab with id 99'); };
  const res = await handle({ type: 'SEEK_VIDEO', tabId: 99, seconds: 5 }, { tab: { id: 99 } });
  assert.equal(res.ok, false);
});


test('context menu titles follow the saved UI language and live changes across seven languages', async () => {
  const { readFile } = await import('node:fs/promises');
  const dirs = { en: 'en', zh: 'zh_CN', ja: 'ja', ko: 'ko', es: 'es', pt: 'pt_BR', ru: 'ru' };
  const dictionaries = {};
  for (const dir of Object.values(dirs)) dictionaries[dir] = JSON.parse(await readFile(new URL(`../_locales/${dir}/messages.json`, import.meta.url), 'utf8'));
  const oldFetch = globalThis.fetch;
  const oldI18n = chrome.i18n;
  chrome.i18n = { getMessage: key => dictionaries.en[key]?.message || '' };
  globalThis.fetch = async url => ({ json: async () => dictionaries[String(url).split('/').at(-2)] });
  const flush = () => new Promise(r => setTimeout(r, 0));
  try {
    storageData.uiLang = 'ja';
    await installedListener({ reason: 'test' });
    await flush();
    assert.equal(contextMenuTitles.get('browsa-explain'), dictionaries.ja.toolbarExplain.message);
    for (const [lang, dir] of Object.entries(dirs)) {
      storageData.uiLang = lang;
      for (const fn of storageChangeListeners) fn({ uiLang: { newValue: lang } }, 'local');
      await flush();
      assert.equal(contextMenuTitles.get('browsa-ask'), dictionaries[dir].toolbarAsk.message);
      assert.equal(contextMenuTitles.get('browsa-translate'), dictionaries[dir].toolbarTranslate.message);
    }
    storageData.uiLang = 'auto';
    for (const fn of storageChangeListeners) fn({ uiLang: { newValue: 'auto' } }, 'local');
    await flush();
    assert.equal(contextMenuTitles.get('browsa-explain'), dictionaries.en.toolbarExplain.message);
  } finally { globalThis.fetch = oldFetch; chrome.i18n = oldI18n; delete storageData.uiLang; }
});

test('menu language updates all actions with Chrome 116 callback-only contextMenus APIs', async () => {
  const { readFile } = await import('node:fs/promises');
  const dict = JSON.parse(await readFile(new URL('../_locales/ko/messages.json', import.meta.url), 'utf8'));
  const update = chrome.contextMenus.update, removeAll = chrome.contextMenus.removeAll, oldFetch = globalThis.fetch;
  chrome.contextMenus.update = (id, opts, cb) => { setTimeout(() => { contextMenuTitles.set(id, opts.title); cb?.(); }, 0); };
  chrome.contextMenus.removeAll = cb => { setTimeout(() => { contextMenuTitles.clear(); cb?.(); }, 0); };
  globalThis.fetch = async () => ({ json: async () => dict });
  storageData.uiLang = 'ko';
  try {
    installedListener({ reason: 'test' });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(contextMenuTitles.get('browsa'), 'browsa');
    assert.equal(contextMenuTitles.get('browsa-summarize'), dict.toolbarSummarize.message);
    contextMenuTitles.clear();
    for (const fn of storageChangeListeners) fn({ uiLang: { newValue: 'ko' } }, 'local');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(contextMenuTitles.get('browsa-summarize'), dict.toolbarSummarize.message);
  } finally { chrome.contextMenus.update = update; chrome.contextMenus.removeAll = removeAll; globalThis.fetch = oldFetch; delete storageData.uiLang; }
});

// ── CONTENT_SETTINGS_GET（2026-10-23，storage TRUSTED_CONTEXTS 配套）──────────
// selection-toolbar 的两个设置项改为消息获取；缺省值语义必须和旧的
// chrome.storage 读取一致：undefined → 启用（!== false），uiLang 缺失 → null。
test('handle CONTENT_SETTINGS_GET returns the two content-script settings with defaults', async () => {
  storageData.showSelectionToolbar = false;
  storageData.uiLang = 'zh';
  const res = await handle({ type: 'CONTENT_SETTINGS_GET' }, {});
  assert.deepEqual(res, { showSelectionToolbar: false, uiLang: 'zh' });

  delete storageData.showSelectionToolbar;
  delete storageData.uiLang;
  const res2 = await handle({ type: 'CONTENT_SETTINGS_GET' }, {});
  assert.deepEqual(res2, { showSelectionToolbar: true, uiLang: null });
});
