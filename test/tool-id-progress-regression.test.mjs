import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorageArea } from './helpers/chrome-mock.mjs';
import { sseHttpResponse } from './helpers/sse-fixtures.mjs';

const local = makeStorageArea({}, { clone: true });
const session = makeStorageArea({}, { clone: true });
globalThis.chrome = {
  storage: { local, session, onChanged: { addListener() {} } },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  runtime: { onMessage: { addListener() {} }, sendMessage() {} },
};
const { handleChat } = await import('../lib/handlers/chat-handler.js');
const { prepareHistoryForModel } = await import('../lib/message-builder.js');

async function runBridge(events, tabId) {
  local._reset();
  session._reset();
  await local.set({
    providers: { br: { isBridge: true, alias: 'agent', baseUrl: 'http://127.0.0.1:3948' } },
    activeProvider: 'br',
  });
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith('/turns')
    ? sseHttpResponse([...events, { type: 'done', full: 'The task has finished.' }].map(e => `data: ${JSON.stringify(e)}\n\n`))
    : new Response('{}');
  try {
    await handleChat({ tabId, userText: 'inspect and update files' }, '', '');
    return (await local.get('history')).history.findLast(entry => entry.role === 'assistant');
  } finally {
    globalThis.fetch = original;
  }
}

const event = (id, name, detail, status) => ({ type: 'tool', id, name, detail, status });

test('a sparse ACP update gains its later tool kind and title in the saved and model-facing step', async () => {
  const saved = await runBridge([
    event('tc1', 'tool', 'tc1', 'started'),
    event('tc1', 'execute', 'npm test (failed)', 'failed'),
  ], 101);
  assert.equal(saved.steps.length, 1);
  assert.deepEqual([saved.steps[0].name, saved.steps[0].target, saved.steps[0].ok], ['execute', 'npm test (failed)', false]);
  const content = prepareHistoryForModel([saved])[0].content;
  assert.match(content, /execute: npm test \(failed\) ✗/);
  assert.doesNotMatch(content, /tool: tc1/);
});

test('a real title update retains both the earlier and the latest description', async () => {
  const saved = await runBridge([
    event('call-a', 'read', 'Reading source A', 'started'),
    { type: 'note', text: 'Processing another result.' },
    event('call-a', 'read', 'Processed source B', 'completed'),
  ], 102);
  const tool = saved.steps.find(step => step.k === 'tool');
  assert.deepEqual([tool.name, tool.ok], ['read', true]);
  assert.match(tool.target, /Reading source A/);
  assert.match(tool.target, /Processed source B/);
  assert.match(prepareHistoryForModel([saved])[0].content, /Processed source B/);
});

test('a generic terminal title does not erase the earlier file or command', async () => {
  const saved = await runBridge([
    event('read-1', 'read', 'Read src/config.js', 'started'),
    event('read-1', 'read', 'Read complete', 'completed'),
  ], 112);
  assert.equal(saved.steps.length, 1);
  assert.equal(saved.steps[0].ok, true);
  const text = prepareHistoryForModel([saved])[0].content;
  assert.match(text, /Read src\/config\.js/);
  assert.match(text, /Read complete/);
});

test('repeated title changes keep the first and latest descriptions within the step limit', async () => {
  const saved = await runBridge([
    event('multi', 'read', `src/original.js ${'a'.repeat(190)}`, 'started'),
    event('multi', 'read', 'intermediate status', 'started'),
    event('multi', 'read', `final status ${'z'.repeat(190)}`, 'completed'),
    event('multi', 'read', `final status ${'z'.repeat(190)}`, 'completed'),
  ], 113);
  assert.equal(saved.steps.length, 1);
  const target = saved.steps[0].target;
  assert.ok(target.length <= 200);
  assert.match(target, /src\/original\.js/);
  assert.match(target, /final status/);
  assert.doesNotMatch(target, /intermediate status/);
});

test('long related paths retain both distinct file names in the bounded handoff', async () => {
  const dir = `${'/x'.repeat(65)}/`;
  const saved = await runBridge([
    event('files', 'read', `${dir}old-config.js`, 'started'),
    event('files', 'read', `${dir}new-config.js`, 'completed'),
  ], 114);
  const target = saved.steps[0].target;
  assert.ok(target.length <= 200);
  assert.match(target, /old-config\.js/);
  assert.match(target, /new-config\.js/);
});

test('a clipped appended Windows path keeps its escaped suffix valid and its file name visible', async () => {
  const first = 'C:\\Users\\yan\\' + 'a'.repeat(33);
  const latest = first + '\\foldername'.repeat(12) + '\\target "v1".js';
  const saved = await runBridge([
    event('windows-path', 'read', first, 'started'),
    event('windows-path', 'read', latest, 'completed'),
  ], 120);
  const target = saved.steps[0].target;
  const marker = ' →[+';
  assert.ok(target.length <= 200);
  assert.match(target, /target/);
  assert.ok(target.startsWith(first + marker));
  const suffix = JSON.parse(target.slice(target.indexOf(marker) + marker.length, -1));
  assert.match(suffix, /target "v1"\.js/);
});

test('a clipped Windows path retains the start of a long file name', async () => {
  const first = 'C:\\work\\' + 'a'.repeat(6);
  for (const dirs of [12, 14]) {
    const latest = first + '\\folder'.repeat(dirs) + '\\critical-file-' + 'z'.repeat(66) + '.js';
    const saved = await runBridge([
      event('windows-file', 'read', first, 'started'),
      event('windows-file', 'read', latest, 'completed'),
    ], 140 + dirs);
    const text = prepareHistoryForModel([saved])[0].content;
    assert.match(text, /critical-file-/);
  }
});

test('truncating combined Unicode titles never cuts a surrogate pair in half', async () => {
  const first = '/Users/yan/work/' + 'x'.repeat(32) + '🧭' + 'y'.repeat(98) + '/old.js';
  const latest = '/Users/yan/work/' + 'z'.repeat(130) + '/new.js';
  const saved = await runBridge([
    event('unicode', 'read', first, 'started'),
    event('unicode', 'read', latest, 'completed'),
  ], 121);
  const target = saved.steps[0].target;
  assert.ok(target.length <= 200);
  assert.doesNotMatch(target, /\p{Surrogate}/u);
  assert.doesNotMatch(new TextDecoder().decode(new TextEncoder().encode(target)), /\uFFFD/);
  assert.match(target, /old\.js/);
  assert.match(target, /new\.js/);
});

test('combined-title truncation retains the tail boundary without splitting Unicode', async () => {
  const latest = 'B'.repeat(160);
  const first = 'A'.repeat(111) + '!' + 'Z'.repeat(48);
  const saved = await runBridge([
    event('tail', 'read', first, 'started'),
    event('tail', 'read', latest, 'completed'),
  ], 124);
  assert.match(saved.steps[0].target, /…!Z/);

  const unicode = 'A'.repeat(110) + '😀' + 'Z'.repeat(48);
  const savedUnicode = await runBridge([
    event('tail-unicode', 'read', unicode, 'started'),
    event('tail-unicode', 'read', latest, 'completed'),
  ], 125);
  assert.ok(savedUnicode.steps[0].target.length <= 200);
  assert.doesNotMatch(savedUnicode.steps[0].target, /\p{Surrogate}/u);
});

test('an overlong incoming Unicode title remains well formed after the initial step limit', async () => {
  for (const [first, tabId] of [['good.js', 122], ['x'.repeat(199), 123]]) {
    const later = 'x'.repeat(199) + '😀z';
    const saved = await runBridge([
      event('unicode-boundary', 'read', first, 'started'),
      event('unicode-boundary', 'read', later, 'completed'),
    ], tabId);
    const target = saved.steps[0].target;
    assert.doesNotMatch(target, /\p{Surrogate}/u);
    assert.doesNotMatch(new TextDecoder().decode(new TextEncoder().encode(target)), /\uFFFD/);
    const marker = ' →[+';
    const at = target.indexOf(marker);
    if (at >= 0) assert.doesNotMatch(JSON.parse(target.slice(at + marker.length, -1)), /\p{Surrogate}/u);
  }
});

test('a title that prefixes a different path remains separately identifiable', async () => {
  const saved = await runBridge([
    event('path', 'read', 'src/a', 'started'),
    event('path', 'read', 'src/ab', 'completed'),
  ], 115);
  assert.equal(saved.steps[0].target, 'src/a →[+"b"]');
});

test('a status-like suffix in an in-progress title can be part of a real file name', async () => {
  for (const [first, second, target, tabId] of [
    ['/tmp/report (failed)', '/tmp/report', '/tmp/report (failed) → /tmp/report', 116],
    ['/tmp/report', '/tmp/report (failed)', '/tmp/report →[+" (failed)"]', 117],
  ]) {
    const saved = await runBridge([
      event('status-file', 'read', first, 'started'),
      event('status-file', 'read', second, 'started'),
      event('status-file', 'read', second, 'completed'),
    ], tabId);
    assert.equal(saved.steps[0].target, target);
  }
});

test('a successful ACP title ending in exit text can be a different file name', async () => {
  const saved = await runBridge([
    event('exit-file', 'read', '/tmp/report', 'started'),
    event('exit-file', 'read', '/tmp/report (exit 1)', 'completed'),
  ], 118);
  assert.equal(saved.steps[0].target, '/tmp/report →[+" (exit 1)"]');
});

test('status suffix updates do not crowd earlier commands out of the handoff', async () => {
  const events = [];
  for (let i = 0; i < 14; i++) {
    const id = `command-${i}`;
    const title = `component-${String(i).padStart(2, '0')} ${'x'.repeat(42)}`;
    events.push(event(id, 'command', title, 'started'), event(id, 'command', `${title} (exit 0)`, 'completed'));
  }
  const saved = await runBridge(events, 119);
  const text = prepareHistoryForModel([saved])[0].content;
  assert.match(text, /component-00/);
  assert.match(text, /component-13/);
});

test('clipping a terminal status suffix does not erase a long original file name', async () => {
  let tabId = 130;
  for (const length of [191, 195, 200]) {
    const filename = 'critical-file.js';
    const title = `${'p'.repeat(length - filename.length)}${filename}`;
    for (const suffix of [' (failed)', ' (cancelled)', ' (exit 1)']) {
      const saved = await runBridge([
        event('long-path', 'read', title, 'started'),
        event('long-path', 'read', `${title}${suffix}`, 'failed'),
      ], tabId++);
      assert.equal(saved.steps.length, 1);
      assert.match(saved.steps[0].target, /critical-file\.js/);
    }
  }
});

test('an ID-only terminal update cannot replace an already informative tool title or name', async () => {
  for (const [detail, tabId] of [['tc1 (failed)', 103], ['tc1 (cancelled)', 107]]) {
    const saved = await runBridge([
      event('tc1', 'execute', 'npm test', 'started'),
      event('tc1', 'tool', detail, 'failed'),
    ], tabId);
    assert.equal(saved.steps.length, 1);
    assert.deepEqual([saved.steps[0].name, saved.steps[0].target, saved.steps[0].ok], ['execute', 'npm test', false]);
  }
});

test('an ID-only failure keeps its terminal detail after a progress update with no title', async () => {
  const saved = await runBridge([
    event('tc1', 'tool', 'tc1', 'started'),
    event('tc1', 'tool', '', 'started'),
    event('tc1', 'tool', 'tc1 (failed)', 'failed'),
  ], 108);
  assert.deepEqual(saved.steps.map(step => [step.target, step.ok]), [['tc1 (failed)', false]]);
  assert.match(prepareHistoryForModel([saved])[0].content, /tc1 \(failed\) ✗/);
});

test('ID placeholders with whitespace are classified before display text is normalized', async () => {
  const id = 'native\ncall';
  const saved = await runBridge([
    event(id, 'tool', '', 'started'),
    event(id, 'tool', id, 'started'),
    event(id, 'tool', `${id} (failed)`, 'failed'),
  ], 109);
  assert.deepEqual(saved.steps.map(step => [step.target, step.ok]), [['native call (failed)', false]]);
});

test('a real title that normalizes to an ID is not replaced by an ID fallback', async () => {
  const saved = await runBridge([
    event('tc1', 'execute', '  tc1  ', 'started'),
    event('tc1', 'tool', 'tc1 (failed)', 'failed'),
  ], 111);
  assert.deepEqual(saved.steps.map(step => [step.name, step.target, step.ok]), [['execute', 'tc1', false]]);
});

test('an ID placeholder cannot overwrite a real title that happens to prefix the ID', async () => {
  const saved = await runBridge([
    event('tc1', 'execute', 'tc', 'started'),
    event('tc1', 'tool', 'tc1 (failed)', 'failed'),
  ], 105);
  assert.equal(saved.steps.length, 1);
  assert.deepEqual([saved.steps[0].name, saved.steps[0].target, saved.steps[0].ok], ['execute', 'tc', false]);
  assert.match(prepareHistoryForModel([saved])[0].content, /execute: tc ✗/);
});

test('a real title sharing an overlong ID prefix is not discarded as an ID placeholder', async () => {
  const prefix = 'x'.repeat(200);
  const id = `${prefix}-native-id`;
  const title = `${prefix}-actual-title`;
  const saved = await runBridge([
    event(id, 'read', 'Searching', 'started'),
    event(id, 'read', title, 'completed'),
  ], 106);
  assert.equal(saved.steps.length, 1);
  assert.match(saved.steps[0].target, /Searching/);
  assert.match(saved.steps[0].target, /x{50}/, 'compare raw values before display clipping');
});

test('a later informative terminal update replaces a clipped ID placeholder without losing failure', async () => {
  const id = `native-${'x'.repeat(240)}`;
  const saved = await runBridge([
    event(id, 'tool', id, 'started'),
    event(id, 'tool', `${id} (failed)`, 'failed'),
    event(id, 'execute', 'npm test (failed)', 'failed'),
  ], 104);
  assert.equal(saved.steps.length, 1);
  assert.deepEqual([saved.steps[0].name, saved.steps[0].target, saved.steps[0].ok], ['execute', 'npm test (failed)', false]);
});

for (const [count, addNote] of [[15, false], [49, true]]) {
  test(`a late failed tool remains in the bounded handoff after ${count} interleaved calls`, async () => {
    const events = [event('long', 'command', 'npm test', 'started')];
    for (let i = 0; i < count; i++) {
      const id = `read-${i}`;
      const title = `file-${i}-${'x'.repeat(120)}`;
      events.push(event(id, 'read', title, 'started'), event(id, 'read', title, 'completed'));
    }
    events.push(event('long', 'command', 'npm test (failed)', 'failed'));
    if (addNote) events.push({ type: 'note', text: 'Finishing the report.' });
    const saved = await runBridge(events, 110 + count);
    assert.ok(saved.steps.some(step => step.name === 'command' && step.target === 'npm test →[+" (failed)"]' && step.ok === false), 'the latest failure must survive the 50-step cap');
    const prepared = prepareHistoryForModel([saved]);
    assert.match(prepared[0].content, /command: npm test →\[\+" \(failed\)"\] ✗/, 'the recent failure must survive the 1200-character handoff cap');
    const continued = prepareHistoryForModel([saved, { role: 'user', content: 'continue' }]);
    assert.equal(continued[0].content, prepared[0].content, 'stored assistant history stays a stable prefix');
  });
}

test('a long-running identified call keeps its title across more than 50 other completed calls', async () => {
  const events = [event('long', 'execute', 'npm test', 'started')];
  for (let i = 0; i < 75; i++) {
    const id = `read-${i}`;
    const title = `file-${i}-${'x'.repeat(90)}`;
    events.push(event(id, 'read', title, 'started'), event(id, 'read', title, 'completed'));
  }
  // ACP is allowed to send a terminal update without repeating its title or
  // kind; the bridge then falls back to the native ID and generic tool name.
  events.push(event('long', 'tool', 'long (failed)', 'failed'));
  const saved = await runBridge(events, 199);
  assert.equal(saved.steps.length, 50);
  assert.ok(saved.steps.some(step => step.name === 'execute' && step.target === 'npm test' && step.ok === false));
  assert.match(prepareHistoryForModel([saved])[0].content, /execute: npm test ✗/);
});
