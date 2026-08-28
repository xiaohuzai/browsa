// test/lib-transcript-drawer.test.mjs — 字幕抽屉：[mm:ss] 行解析、播放跟随
// 高亮、手动滚动暂停 + 回位 pill、连续失败收摊、搜索循环、记一笔（−3s）。
//
// The module keeps drawer state at module level, so each test loads a FRESH
// instance via a unique import specifier (?round=N) and rebuilds the drawer
// DOM around it — same pattern as lib-composer-state.test.mjs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
// jsdom has no layout engine — give scrollIntoView a no-op.
dom.window.Element.prototype.scrollIntoView = function () {};
globalThis.Element = dom.window.Element;

const RAW = [
  '## 视频信息',
  '标题：测试视频',
  '',
  '## 字幕',
  '',
  '[00:01] 大家好欢迎观看',
  '[00:05] [说话人1] 今天讲三个要点',
  '[00:12] 第一个要点是关于字幕的',
  '[1:00:05] 一小时后的一行',
].join('\n');

const VS = { platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1x', tabId: 42 };

let round = 0;
async function freshModule() {
  return await import(`../lib/sidepanel/transcript-drawer.js?round=${++round}`);
}

function mountDom({ withTabId = true } = {}) {
  const vs = withTabId ? VS : { ...VS, tabId: null };
  document.body.innerHTML = `
    <button id="transcript-btn" hidden></button>
    <div id="transcript-drawer" class="transcript-drawer" hidden role="dialog">
      <div class="transcript-drawer-header">
        <span id="transcript-drawer-title">Transcript</span>
        <button id="transcript-note"></button>
        <button id="transcript-close"></button>
      </div>
      <div class="transcript-search-row">
        <input id="transcript-search" type="search" />
        <button id="transcript-search-prev">↑</button>
        <button id="transcript-search-next">↓</button>
        <span id="transcript-search-count"></span>
      </div>
      <div id="transcript-list" class="transcript-list" tabindex="0"></div>
      <button id="transcript-follow" class="transcript-follow-pill" hidden>Jump to playback</button>
    </div>`;
  return vs;
}

let sent;
let T;

// openTranscriptDrawer() fires its positioning tick fire-and-forget; flush
// the event loop so the async tick completes before assertions. Without this
// the tick's seq would look superseded by later manual ticks.
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(async () => {
  sent = [];
  T = await freshModule();
});

// openTranscriptDrawer() leaves a 500ms poll interval behind when the source
// has a tabId — without this hook node --test never drains the event loop.
afterEach(() => {
  T?.closeTranscriptDrawer();
  T?.__TRANSCRIPT_TESTING__?.reset();
});

function init(vs, times = []) {
  // times: queued GET_VIDEO_TIME handler returns, drained FIFO; falls back to
  // {ok:false}. The stub wraps them in the REAL background envelope
  // ({ ok, data }) — tick() must read res.data.{ok,time}, and a stub that
  // returned the handler payload bare is exactly how the v0.32.1
  // "always jumps to the first line" regression slipped past these tests.
  T.__TRANSCRIPT_TESTING__.reset();
  T.initTranscriptDrawer({
    sendMessage: async (msg) => {
      sent.push(msg);
      return { ok: true, data: times.length ? times.shift() : { ok: false } };
    },
    onSeek: () => {},
    onNote: () => {},
    getSource: async () => ({ raw: RAW, videoSrc: vs }),
  });
}

test('parseTranscriptLines: timestamps, h:mm:ss, speaker labels, skips non-lines', async () => {
  T = await freshModule();
  const lines = T.parseTranscriptLines(RAW);
  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map((l) => l.s), [1, 5, 12, 3605],
  );
  assert.equal(lines[1].label, '说话人1');
  assert.equal(lines[1].text, '今天讲三个要点');
  assert.equal(lines[0].label, '');
  // formatTs mirrors the .browsa-ts chip display
  assert.equal(T.formatTs(1), '0:01');
  assert.equal(T.formatTs(3605), '1:00:05');
});

test('parseTranscriptLines handles native 3-digit total-minute stamps ([105:30])', async () => {
  // B站/YouTube 原生字幕用总分钟制——≥100 分钟视频输出 [105:30]，h:mm:ss
  // 摆不下；0.33.0 之前 _LINE_RE 不认这种行，长视频字幕在 99:59 被截断。
  T = await freshModule();
  const lines = T.parseTranscriptLines('[99:59] before the cut\n[105:30] after the cut');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].s, 105 * 60 + 30);
});

test('pickNoteLine applies the −3s reaction offset with first-line fallback', async () => {
  T = await freshModule();
  const lines = T.parseTranscriptLines(RAW);
  // t=7 → t−3=4 → the [00:01] line is the last one at/before
  assert.equal(T.pickNoteLine(lines, 7).s, 1);
  // t=15 → t−3=12 → exactly the [00:12] line
  assert.equal(T.pickNoteLine(lines, 15).s, 12);
  // t=2 → t−3=−1 → nothing before → fallback to first line
  assert.equal(T.pickNoteLine(lines, 2).s, 1);
  assert.equal(T.pickNoteLine(lines, null), null);
});

test('refresh reveals the topbar button and open renders rows + starts polling', async () => {
  const vs = mountDom();
  init(vs);
  await T.refreshTranscriptSource();
  assert.equal(document.getElementById('transcript-btn').hidden, false);
  T.openTranscriptDrawer();
  assert.equal(document.getElementById('transcript-drawer').hidden, false);
  assert.equal(T.__TRANSCRIPT_TESTING__.state().rowCount, 4);
  // open fires one positioning tick by itself
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'GET_VIDEO_TIME');
  assert.equal(sent[0].tabId, 42);
  await T.tick();
  assert.equal(sent.length, 2);
  assert.equal(T.__TRANSCRIPT_TESTING__.state().polling, true);
});

test('tick highlights the row the video is at and moves as time advances', async () => {
  const vs = mountDom();
  init(vs, [{ ok: true, time: 6 }, { ok: true, time: 13 }]);
  T.__TRANSCRIPT_TESTING__.setSource(RAW, vs);
  T.openTranscriptDrawer();
  const rows = () => [...document.querySelectorAll('.ts-row')];

  await flush(); // let open's positioning tick (time:6) land
  // the 0:05 row is live
  assert.equal(T.__TRANSCRIPT_TESTING__.state().activeIdx, 1);
  assert.ok(rows()[1].classList.contains('active'));
  assert.ok(!rows()[0].classList.contains('active'));

  await T.tick(); // consumes time:13
  assert.equal(T.__TRANSCRIPT_TESTING__.state().activeIdx, 2); // 0:12 <= 13s
  assert.ok(rows()[2].classList.contains('active'));
  assert.ok(!rows()[1].classList.contains('active'));
  assert.equal(T.__TRANSCRIPT_TESTING__.state().lastTime, 13);
});

test('manual scroll pauses follow and shows the pill; pill click re-enables', async () => {
  const vs = mountDom();
  init(vs, [{ ok: true, time: 6 }]);
  T.__TRANSCRIPT_TESTING__.setSource(RAW, vs);
  T.openTranscriptDrawer(); // its positioning tick consumes time:6, highlights row 1
  await flush();
  assert.equal(T.__TRANSCRIPT_TESTING__.state().follow, true);
  assert.equal(T.__TRANSCRIPT_TESTING__.state().pillHidden, true);

  // Programmatic smooth-scroll stamps the guard; pretend it's long past.
  T.__TRANSCRIPT_TESTING__.forceScrollIdle();
  document.getElementById('transcript-list')
    .dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  assert.equal(T.__TRANSCRIPT_TESTING__.state().follow, false);
  assert.equal(T.__TRANSCRIPT_TESTING__.state().pillHidden, false);

  document.getElementById('transcript-follow')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(T.__TRANSCRIPT_TESTING__.state().follow, true);
  assert.equal(T.__TRANSCRIPT_TESTING__.state().pillHidden, true);
});

test('consecutive failures stop the poll quietly and clear the highlight', async () => {
  const vs = mountDom();
  init(vs); // every GET_VIDEO_TIME fails (tab gone)
  T.__TRANSCRIPT_TESTING__.setSource(RAW, vs);
  T.openTranscriptDrawer(); // open's positioning tick = failure #1
  await flush();
  await T.tick();
  await T.tick();
  assert.equal(T.__TRANSCRIPT_TESTING__.state().polling, true); // still within tolerance
  await T.tick(); // 4th consecutive failure
  assert.equal(T.__TRANSCRIPT_TESTING__.state().polling, false);
  assert.equal(T.__TRANSCRIPT_TESTING__.state().activeIdx, -1);
  assert.equal(sent.length, 4); // no more calls after giving up
});

test('row click hands the timestamp to onSeek; live selection suppresses seek', async () => {
  const vs = mountDom();
  const seeks = [];
  T.__TRANSCRIPT_TESTING__.reset();
  T.initTranscriptDrawer({
    sendMessage: async () => ({ ok: true, data: { ok: false } }),
    onSeek: (s, v) => seeks.push([s, v]),
    onNote: () => {},
    getSource: async () => ({ raw: RAW, videoSrc: vs }),
  });
  T.__TRANSCRIPT_TESTING__.setSource(RAW, vs);
  T.openTranscriptDrawer();
  const row = document.querySelectorAll('.ts-row')[2];
  row.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.deepEqual(seeks, [[12, vs]]);

  // Simulate an open text selection (mouseup after a drag): no seek.
  const orig = dom.window.getSelection;
  dom.window.getSelection = () => ({ isCollapsed: false });
  try {
    row.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    assert.equal(seeks.length, 1);
  } finally {
    dom.window.getSelection = orig;
  }
});

test('search marks matches, counts them, and cycles with wraparound', async () => {
  const vs = mountDom();
  init(vs);
  T.__TRANSCRIPT_TESTING__.setSource(RAW, vs);
  T.openTranscriptDrawer();
  const input = document.getElementById('transcript-search');
  // 「一」命中两行共三处（「第一个要点」一处、「一小时后的一行」两处）
  input.value = '一';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const st = T.__TRANSCRIPT_TESTING__.state();
  assert.equal(st.matchCount, 2);
  assert.equal(document.querySelectorAll('.ts-row-text mark').length, 3);

  document.getElementById('transcript-search-next')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(T.__TRANSCRIPT_TESTING__.state().searchIdx, 0);
  assert.ok(document.querySelectorAll('.ts-row')[2].classList.contains('search-current'));

  document.getElementById('transcript-search-next')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(T.__TRANSCRIPT_TESTING__.state().searchIdx, 1);
  // one more → wraps to 0
  document.getElementById('transcript-search-next')
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.equal(T.__TRANSCRIPT_TESTING__.state().searchIdx, 0);

  input.value = '';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(document.querySelectorAll('.ts-row-text mark').length, 0);
  assert.equal(T.__TRANSCRIPT_TESTING__.state().matchCount, 0);
});

test('no tabId: rows stay clickable but polling never starts', async () => {
  const vs = mountDom({ withTabId: false });
  init(vs);
  T.__TRANSCRIPT_TESTING__.setSource(RAW, vs);
  T.openTranscriptDrawer();
  await T.tick();
  assert.equal(T.__TRANSCRIPT_TESTING__.state().polling, false);
  assert.equal(sent.length, 0);
  assert.equal(T.__TRANSCRIPT_TESTING__.state().rowCount, 4);
});

test('empty source hides the topbar button and open becomes a no-op', async () => {
  mountDom();
  T.__TRANSCRIPT_TESTING__.reset();
  T.initTranscriptDrawer({
    sendMessage: async () => ({ ok: false }),
    onSeek: () => {},
    onNote: () => {},
    getSource: async () => null,
  });
  await T.refreshTranscriptSource();
  assert.equal(document.getElementById('transcript-btn').hidden, true);
  T.openTranscriptDrawer();
  assert.equal(document.getElementById('transcript-drawer').hidden, true);
});
