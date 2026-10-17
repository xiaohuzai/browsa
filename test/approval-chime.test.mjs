// test/approval-chime.test.mjs — the Web Audio approval cue (2026-10-17).
// jsdom has no AudioContext, which is exactly the degradation path the module
// must survive silently — so the execution half runs against a stub context
// and the no-AudioContext half asserts the silence, and a source pin keeps
// the turn-chrome wiring from drifting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { playApprovalChime, maybePlayApprovalChime, _resetChimeForTests } from '../lib/sidepanel/approval-chime.js';

function makeStubCtx() {
  const calls = { osc: [], gains: [], connect: 0, started: false, stopped: false };
  const gain = {
    gain: {
      setValueAtTime: (...a) => calls.gains.push(['set', ...a]),
      exponentialRampToValueAtTime: (...a) => calls.gains.push(['ramp', ...a]),
    },
    connect() { calls.connect++; return undefined; },
  };
  const osc = {
    type: '', frequency: { value: 0 },
    connect(dest) { calls.connect++; calls.osc.push(this); },
    start(t) { calls.started = t; },
    stop(t) { calls.stopped = t; },
  };
  const ctx = {
    state: 'running',
    currentTime: 0,
    destination: 'dest',
    createOscillator: () => osc,
    createGain: () => gain,
    resume: () => Promise.resolve(),
  };
  return { ctx, calls };
}

test('playApprovalChime: one triangle blip at 520Hz with the 150ms envelope', () => {
  const { ctx, calls } = makeStubCtx();
  playApprovalChime({ AudioContext: function () { return ctx; } });
  assert.equal(calls.osc.length, 1);
  assert.equal(calls.osc[0].type, 'triangle');
  assert.equal(calls.osc[0].frequency.value, 520);
  // envelope: set near-zero → 0.25 in 10ms → back to inaudible at 150ms; stop at 160ms
  assert.deepEqual(calls.gains[0], ['set', 0.0001, 0]);
  assert.deepEqual(calls.gains[1], ['ramp', 0.25, 0.01]);
  assert.deepEqual(calls.gains[2], ['ramp', 0.0001, 0.15]);
  assert.equal(calls.stopped, 0.16);
  assert.ok(calls.connect >= 2, 'osc→gain→destination chain must be wired');
});

test('playApprovalChime: no AudioContext (jsdom) stays silent, never throws', () => {
  assert.doesNotThrow(() => playApprovalChime({}));
  assert.doesNotThrow(() => playApprovalChime({ AudioContext: undefined }));
  assert.doesNotThrow(() => playApprovalChime({ AudioContext: function () { throw new Error('boom'); } }));
});

test('maybePlayApprovalChime: default ON, explicit false mutes, storage errors stay silent', async () => {
  _resetChimeForTests();
  let plays = 0;
  const win = { AudioContext: function () { plays++; return makeStubCtx().ctx; } };
  // undefined setting → default ON
  await maybePlayApprovalChime({ get: async () => ({}) }, win);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(plays, 1);
  // explicit false → muted
  await maybePlayApprovalChime({ get: async () => ({ approvalChime: false }) }, win);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(plays, 1);
  // storage rejection → silent, no throw (void fire-and-forget: flush microtasks)
  maybePlayApprovalChime({ get: async () => { throw new Error('no storage'); } }, win);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(plays, 1);
});

test('source pins: turn-chrome fires the chime on approval cards; options page has the toggle + i18n', async () => {
  const tc = await readFile(new URL('../lib/sidepanel/turn-chrome.js', import.meta.url), 'utf8');
  assert.match(tc, /import \{ maybePlayApprovalChime \} from '\.\/approval-chime\.js';/);
  const fnMatch = tc.match(/function showApprovalCard\(bubbleEl, data, reqKey\) \{([\s\S]*?)\n  \}/);
  assert.ok(fnMatch, 'showApprovalCard must exist');
  assert.match(fnMatch[1], /maybePlayApprovalChime\(\{ get: storageGet \}\);/, 'approval card must fire the chime');

  const opts = await readFile(new URL('../options.html', import.meta.url), 'utf8');
  assert.match(opts, /id="approvalChime"/);
  assert.match(opts, /data-i18n="approvalChimeLabel"/);

  const ojs = await readFile(new URL('../options.js', import.meta.url), 'utf8');
  assert.match(ojs, /approvalChime: !!e\.target\.checked/);
  assert.match(ojs, /cfg\.approvalChime !== false/, 'undefined setting must default the checkbox ON');

  for (const loc of ['en', 'zh_CN']) {
    const dict = JSON.parse(await readFile(new URL(`../_locales/${loc}/messages.json`, import.meta.url), 'utf8'));
    assert.ok(dict.approvalChimeLabel?.message, `${loc} locale must carry approvalChimeLabel`);
  }
});
