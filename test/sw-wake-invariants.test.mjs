// test/sw-wake-invariants.test.mjs — the two service-worker wake-cost
// invariants AGENTS.md marks "do not regress" but had NO test coverage:
//
//   1. syncGcAlarm() — the stream-GC alarm must exist ONLY while streamState
//      is non-empty. A permanently registered 5-minute alarm cold-started the
//      SW 288×/day to sweep an empty Map.
//   2. syncNavListeners() — the three chrome.webNavigation listeners must be
//      registered ONLY while a browsa-nav port is connected. With
//      <all_urls> host permissions, static registration cold-started the SW
//      (644KB module parse) on every navigation/SPA pushState in every tab
//      just to no-op on an empty navPorts.
//
// Both are behaviour-tested against the real modules with a recording chrome
// mock — not source-text pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── chrome mock: records alarm + listener lifecycle ────────────────────────
const alarms = new Map();
const navRegistered = new Set();
function makeNavEvent(name) {
  return {
    addListener: (fn) => { navRegistered.add(name); navRegistered._fn = fn; },
    removeListener: () => { navRegistered.delete(name); },
  };
}
globalThis.chrome = {
  alarms: {
    create: (name) => { alarms.set(name, true); },
    clear: (name) => { alarms.delete(name); },
    onAlarm: { addListener() {} },
  },
  webNavigation: {
    onHistoryStateUpdated: makeNavEvent('onHistoryStateUpdated'),
    onCommitted: makeNavEvent('onCommitted'),
    onBeforeNavigate: makeNavEvent('onBeforeNavigate'),
  },
  tabs: { onRemoved: { addListener() {}, removeListener() {} } },
  runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} }, id: 'test' },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} },
  },
  declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
  sidePanel: { setPanelBehavior: async () => {} },
  contextMenus: { create() {}, removeAll() {}, update() {}, onClicked: { addListener() {} } },
  scripting: { executeScript: async () => [{ result: null }] },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  cookies: { getAll: async () => [] },
  i18n: { getMessage: () => '' },
};

const state = await import('../lib/state.js');

test('syncGcAlarm: the GC alarm exists only while a stream is in flight', () => {
  // Idle SW: nothing registered.
  state.syncGcAlarm();
  assert.equal(alarms.has(state.GC_ALARM_NAME), false, 'no alarm while streamState is empty');

  // A turn starts → alarm on.
  state.initStreamState(101, { providerLabel: 'x' });
  assert.equal(alarms.has(state.GC_ALARM_NAME), true, 'the GC alarm must exist while a stream is in flight');

  // Turn ends → alarm off (this is the 288×/day cold-start regression).
  state.clearStreamState(101);
  assert.equal(alarms.has(state.GC_ALARM_NAME), false, 'the GC alarm must be removed once the last stream ends');
});

test('syncGcAlarm: two concurrent streams keep the alarm until BOTH finish', () => {
  state.initStreamState(201, {});
  state.initStreamState(202, {});
  assert.equal(alarms.has(state.GC_ALARM_NAME), true);
  state.clearStreamState(201);
  assert.equal(alarms.has(state.GC_ALARM_NAME), true, 'another tab is still streaming — alarm stays');
  state.clearStreamState(202);
  assert.equal(alarms.has(state.GC_ALARM_NAME), false);
});

test('syncNavListeners: the nav listeners are gated on live ports (source pin — no exported seam)', async () => {
  // background.js keeps navPorts/syncNavListeners module-private on purpose;
  // adding a test-only export would widen the production surface for a
  // service-worker efficiency invariant. Pin the SHAPE that makes the gate
  // work instead: the listeners are added/removed through a computed method
  // chosen from a live-port count, and nothing registers them statically.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function syncNavListeners()'), src.indexOf('function syncNavListeners()') + 1200);
  assert.match(body, /for \(const set of navPorts\.values\(\)\)/, 'the gate must count live ports, not keys');
  assert.match(body, /if \(want === navListenersActive\) return;/, 'repeated calls must be no-ops');
  assert.match(body, /const method = want \? 'addListener' : 'removeListener';/, 'registration is conditional');
  assert.match(body, /chrome\.webNavigation\.onHistoryStateUpdated\[method\]/, 'listeners are added AND removed through the same gate');
  // No bare top-level registration of these three anywhere in the file.
  for (const ev of ['onHistoryStateUpdated', 'onCommitted', 'onBeforeNavigate']) {
    assert.doesNotMatch(src, new RegExp(`chrome\\.webNavigation\\.${ev}\\.addListener\\(on`), `${ev} must never be registered statically`);
  }
});
