// lib/sidepanel/transcript-drawer.js — 字幕抽屉（移植自 youtube-digest 的核心交互）。
//
// browsa 的视频附件上下文（PAGE_CONTEXT 前缀）从不渲染成气泡，所以字幕此前只
// 存在于喂给模型的文本里。这个抽屉把历史里带 videoSrc 戳的用户附件条目中的
// [mm:ss] 行渲染成可点击列表，并补上 youtube-digest 的两件招牌交互：
//   1. 播放跟随 — 500ms 轮询视频当前位置（GET_VIDEO_TIME，与 SEEK_VIDEO 同一条
//      MAIN-world 取元素路径），高亮「正在说到」的行并自动滚动跟随；手动滚动
//      暂停跟随，浮出「回到播放位置」pill。
//   2. 记一笔 — 捕获当前播放行（−3s 反应偏移：用户听到内容后才按按钮）为带
//      时间戳的草稿，时间戳在发出的消息里依旧可点击。
// 行点击 seek 走 sidepanel 注入的 onSeek（SEEK_VIDEO + 失效回退开 URL?t=），
// 搜索沿用会话内搜索的「全部行可见 + mark 标记 + 计数循环」语义。

import { $ } from './ui-utils.js';

const POLL_MS = 500;
const MAX_CONSECUTIVE_FAILS = 4;   // tab 关掉/导航走了之后安静收摊的容忍度
const MANUAL_SCROLL_GRACE_MS = 1200;

function _msg(key, fallback) {
  return (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
}

let _deps = { sendMessage: null, onSeek: null, onNote: null, getSource: null };
let _listEl = null;
let _searchInput = null;
let _countEl = null;
let _pill = null;

let _source = null;            // { videoSrc: {platform,url,tabId}|null, lines: [{s,label,text}] }
let _rows = [];                // 与 _source.lines 平行的行元素
let _pollTimer = null;
let _tickSeq = 0;              // 串行化异步 tick：慢响应不得覆盖新响应
let _lastKnownTime = null;
let _activeIdx = -1;
let _followEnabled = true;
let _consecutiveFails = 0;
let _lastAutoScrollAt = 0;
let _searchQuery = '';
let _searchMatches = [];       // 命中搜索的行下标
let _searchIdx = -1;

// ─── 纯函数 ────────────────────────────────────────────────────────────────────

// 行首 [mm:ss] / [h:mm:ss]（附件管道已把区间/小数归一化成单一起始时刻）；
// 时间戳后可带 [说话人N] 标签。标题、元信息等非字幕行全部跳过。
// 分钟位放宽到 3 位数：原生字幕（B站/YouTube 内容脚本）用总分钟制，
// ≥100 分钟的视频会输出 [105:30] 这种 h:mm:ss 摆不下的形态。
const _LINE_RE = /^\s*\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]\s*(.+)$/;
const _LABEL_RE = /^\[(说话人\s*\d+|S\d+|Speaker\s*\d+)\]\s*/i;

export function parseTranscriptLines(raw) {
  const lines = [];
  if (typeof raw !== 'string') return lines;
  for (const line of raw.split('\n')) {
    const m = _LINE_RE.exec(line);
    if (!m) continue;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const s = (h * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10);
    let text = m[4];
    let label = '';
    const lm = _LABEL_RE.exec(text);
    if (lm) { label = lm[1]; text = text.slice(lm[0].length); }
    lines.push({ s, label, text });
  }
  return lines;
}

// 与 .browsa-ts 的展示一致：不带方括号的 m:ss / h:mm:ss。
export function formatTs(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

// 记一笔的目标行：youtube-digest 的 −3s 反应偏移——取 t−3s 所在（或之前最近的）
// 行；t 之前没有任何行时回退第一行。
export function pickNoteLine(lines, seconds) {
  if (!Array.isArray(lines) || lines.length === 0 || seconds == null) return null;
  const t = seconds - 3;
  let pick = null;
  for (const line of lines) {
    if (line.s <= t) pick = line;
    else break;
  }
  return pick || lines[0];
}

// ─── 初始化与生命周期 ──────────────────────────────────────────────────────────

export function initTranscriptDrawer(deps) {
  _deps = { ..._deps, ...deps };
  _listEl = $('transcript-list');
  _searchInput = $('transcript-search');
  _countEl = $('transcript-search-count');
  _pill = $('transcript-follow');
  if (!_listEl) return;

  $('transcript-close')?.addEventListener('click', closeTranscriptDrawer);
  $('transcript-note')?.addEventListener('click', _noteAtCurrent);
  $('transcript-search-prev')?.addEventListener('click', () => _moveSearch(-1));
  $('transcript-search-next')?.addEventListener('click', () => _moveSearch(1));
  _searchInput?.addEventListener('input', () => { _searchQuery = _searchInput.value; _applySearch(); });
  _searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _moveSearch(e.shiftKey ? -1 : 1);
    }
    if (e.key === 'Escape') {
      _searchQuery = '';
      if (_searchInput) _searchInput.value = '';
      _applySearch();
    }
  });
  _pill?.addEventListener('click', () => {
    _followEnabled = true;
    _pill.hidden = true;
    _jumpToActive(false);
  });

  _listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.ts-row');
    if (!row || !_source) return;
    // 有存活选区时不 seek（划词松手不该触发跳转）。
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return;
    _deps.onSeek?.(Number(row.dataset.s) || 0, _source.videoSrc);
  });

  // 手动滚动 = 用户要自己看别处：暂停跟随，浮出回位 pill。程序滚动的
  // scrollIntoView 也会触发 scroll 事件，用时间戳门槛区分两种来源。
  _listEl.addEventListener('scroll', () => {
    if (Date.now() - _lastAutoScrollAt < MANUAL_SCROLL_GRACE_MS) return;
    if (_activeIdx < 0) return;
    if (_followEnabled) {
      _followEnabled = false;
      if (_pill) _pill.hidden = false;
    }
  }, { passive: true });
}

export function isOpenTranscriptDrawer() {
  const d = $('transcript-drawer');
  return !!d && !d.hidden;
}

// 重新扫描历史：更新顶栏按钮可见性；抽屉开着就重渲染并续上轮询。
// 在 renderHistory、ATTACH 成功、删除消息之后调用（fire-and-forget）。
export async function refreshTranscriptSource() {
  let src = null;
  try { src = await _deps.getSource?.(); } catch (_) {}
  _source = src && typeof src.raw === 'string' && parseTranscriptLines(src.raw).length > 0
    ? { videoSrc: src.videoSrc || null, lines: parseTranscriptLines(src.raw) }
    : null;
  const btn = $('transcript-btn');
  if (btn) btn.hidden = !_source;
  if (isOpenTranscriptDrawer()) {
    _followEnabled = true;
    if (_pill) _pill.hidden = true;
    _renderRows();
    _startPoll();
    tick();
  } else {
    _stopPoll();
  }
}

export function openTranscriptDrawer() {
  const d = $('transcript-drawer');
  if (!d || !_source) return;
  d.hidden = false;
  _renderRows();
  _followEnabled = true;
  if (_pill) _pill.hidden = true;
  if (_searchInput) { _searchInput.value = ''; }
  _searchQuery = '';
  _applySearch();
  _startPoll();
  tick();
}

export function closeTranscriptDrawer() {
  const d = $('transcript-drawer');
  if (!d || d.hidden) return;
  d.hidden = true;
  _stopPoll();
}

// ─── 渲染与搜索 ────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _rowBodyHtml(line) {
  return (line.label ? `<span class="ts-row-label">${_esc(line.label)}</span>` : '')
    + _renderSearchHtml(line.text);
}

// 字面大小写不敏感高亮；全部行保持可见（浏览上下文在），循环跳转交给计数。
function _renderSearchHtml(text) {
  const q = _searchQuery.trim();
  if (!q) return _esc(text);
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let out = '';
  let i = 0;
  while (i <= text.length) {
    const hit = lower.indexOf(ql, i);
    if (hit < 0) { out += _esc(text.slice(i)); break; }
    out += _esc(text.slice(i, hit)) + '<mark>' + _esc(text.slice(hit, hit + q.length)) + '</mark>';
    i = hit + q.length;
  }
  return out;
}

function _renderRows() {
  _listEl.innerHTML = '';
  _rows = [];
  _activeIdx = -1;
  if (!_source) return;
  const frag = document.createDocumentFragment();
  _source.lines.forEach((line, i) => {
    const row = document.createElement('div');
    row.className = 'ts-row';
    row.dataset.s = String(line.s);
    row.dataset.idx = String(i);
    const t = document.createElement('span');
    t.className = 'ts-row-time';
    t.textContent = formatTs(line.s);
    const body = document.createElement('span');
    body.className = 'ts-row-text';
    body.innerHTML = _rowBodyHtml(line);
    row.appendChild(t);
    row.appendChild(body);
    frag.appendChild(row);
    _rows.push(row);
  });
  _listEl.appendChild(frag);
}

function _applySearch() {
  _searchMatches = [];
  _searchIdx = -1;
  _rows.forEach((row, i) => {
    row.classList.remove('search-current');
    const line = _source?.lines[i];
    if (!line) return;
    const body = row.querySelector('.ts-row-text');
    if (body) body.innerHTML = _rowBodyHtml(line);
    if (_searchQuery.trim() && body?.querySelector('mark')) _searchMatches.push(i);
  });
  if (_countEl) {
    _countEl.textContent = _searchQuery.trim() ? String(_searchMatches.length) : '';
  }
}

function _moveSearch(dir) {
  if (!_searchMatches.length) return;
  if (_followEnabled && _activeIdx >= 0) {
    // 搜索跳转和手动滚动一样是「用户在看别处」。
    _followEnabled = false;
    if (_pill) _pill.hidden = false;
  }
  _searchIdx = ((_searchIdx + dir) % _searchMatches.length + _searchMatches.length) % _searchMatches.length;
  _rows.forEach((row) => row.classList.remove('search-current'));
  const row = _rows[_searchMatches[_searchIdx]];
  row.classList.add('search-current');
  _lastAutoScrollAt = Date.now();
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (_countEl) _countEl.textContent = `${_searchIdx + 1}/${_searchMatches.length}`;
}

// ─── 播放跟随 ──────────────────────────────────────────────────────────────────

function _startPoll() {
  _stopPoll();
  _consecutiveFails = 0;
  if (!_source?.videoSrc?.tabId) return;
  _pollTimer = setInterval(() => { tick(); }, POLL_MS);
}

function _stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

export async function tick() {
  const tabId = _source?.videoSrc?.tabId;
  if (!isOpenTranscriptDrawer() || !tabId) return;
  const seq = ++_tickSeq;
  let res = null;
  try { res = await _deps.sendMessage({ type: 'GET_VIDEO_TIME', tabId, url: _source?.videoSrc?.url }); } catch (_) {}
  if (seq !== _tickSeq) return; // 已有更新的 tick，丢弃过期响应
  // background 把每个回包包成 { ok, data }：data 才是 handler 的返回值
  // （这里是 { ok, time, paused }，tab 无视频时 { ok: false }）。res.ok 只是
  // 外层「handler 没抛异常」的标志，真判据在 data.ok —— 读错层时间恒为 0，
  // 高亮和「回到播放位置」就会钉在第一行（v0.32.1 真实回归）。
  const d = res?.ok ? res.data : null;
  if (d?.ok) {
    _consecutiveFails = 0;
    _lastKnownTime = Math.floor(d.time || 0);
    _applyTime(_lastKnownTime);
  } else if (++_consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    // tab 关闭/导航走了：安静停止轮询、清掉高亮，行点击仍可走 URL 回退。
    _stopPoll();
    _clearActive();
  }
}

function _applyTime(t) {
  if (!_source) return;
  const lines = _source.lines;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].s <= t) idx = i;
    else break;
  }
  if (idx === _activeIdx) return;
  if (_activeIdx >= 0 && _rows[_activeIdx]) _rows[_activeIdx].classList.remove('active');
  _activeIdx = idx;
  if (idx < 0) return;
  const row = _rows[idx];
  if (!row) return;
  row.classList.add('active');
  if (_followEnabled && isOpenTranscriptDrawer()) {
    _lastAutoScrollAt = Date.now();
    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
  }
}

function _clearActive() {
  if (_activeIdx >= 0 && _rows[_activeIdx]) _rows[_activeIdx].classList.remove('active');
  _activeIdx = -1;
  _lastKnownTime = null;
}

function _jumpToActive(smooth = true) {
  if (_activeIdx < 0 || !_rows[_activeIdx]) return;
  _lastAutoScrollAt = Date.now();
  try { _rows[_activeIdx].scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' }); } catch (_) {}
}

// ─── 记一笔 ────────────────────────────────────────────────────────────────────

function _noteAtCurrent() {
  const line = pickNoteLine(_source?.lines, _lastKnownTime);
  if (!line || _lastKnownTime == null) {
    _deps.onNote?.(null, null);
    return;
  }
  _deps.onNote?.(_lastKnownTime, line);
}

// ─── 测试钩子（youtube-digest 的 __YTD_*_TESTING__ 模式）───────────────────────

export const __TRANSCRIPT_TESTING__ = {
  parseTranscriptLines,
  formatTs,
  pickNoteLine,
  openTranscriptDrawer,
  closeTranscriptDrawer,
  tick,
  setSource(raw, videoSrc) {
    _source = { videoSrc: videoSrc || null, lines: parseTranscriptLines(raw) };
  },
  state: () => ({
    activeIdx: _activeIdx,
    follow: _followEnabled,
    polling: _pollTimer !== null,
    lastTime: _lastKnownTime,
    matchCount: _searchMatches.length,
    searchIdx: _searchIdx,
    pillHidden: _pill ? _pill.hidden : null,
    rowCount: _rows.length,
  }),
  forceScrollIdle() { _lastAutoScrollAt = 0; },
  reset() {
    _stopPoll();
    _source = null;
    _rows = [];
    _activeIdx = -1;
    _lastKnownTime = null;
    _followEnabled = true;
    _consecutiveFails = 0;
    _lastAutoScrollAt = 0;
    _searchQuery = '';
    _searchMatches = [];
    _searchIdx = -1;
  },
};
