// test/outline-rail.test.mjs — 对话大纲侧栏（lib/sidepanel/outline-rail.js）：
// 按「轮」分组 ticks（用户消息 + 其后的回复 = 一个 tick）、<4 轮隐藏、点击滚到
// 该轮并闪高亮、MutationObserver 自愈重建、hover 预览。jsdom 无布局引擎，
// 滚动跟随只断言不崩溃与 last-turn 兜底。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/sidepanel.html' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!dom.window.Element.prototype.scrollIntoView) {
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() { this._scrolled = (this._scrolled || 0) + 1; };
}

globalThis.chrome = { i18n: { getMessage: (key) => ({ outlineAria: '对话大纲', outlineEmpty: '（空消息）' }[key] || '') } };

const { initOutlineRail, _resetOutlineRail } = await import('../lib/sidepanel/outline-rail.js');

function freshMessages() {
  document.body.innerHTML = '';
  const el = document.createElement('main');
  el.className = 'messages';
  document.body.appendChild(el);
  return el;
}

function msg(el, kind, text) {
  el.className = `msg ${kind}`;
  if (kind === 'user') el.dataset.raw = text;
  else el.textContent = text;
  return el;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

test('少于 4 轮：rail 不显示', async () => {
  _resetOutlineRail();
  const el = freshMessages();
  el.appendChild(msg(document.createElement('div'), 'user', '问题一'));
  el.appendChild(msg(document.createElement('div'), 'assistant', '回答一'));
  initOutlineRail({ messagesEl: el });
  await flush();
  const rail = el.querySelector('.outline-rail');
  assert.ok(rail, 'rail 节点存在');
  assert.ok(!rail.classList.contains('visible'), '不足 4 轮不显示');
});

test('≥4 轮显示：用户消息开轮，其后的回复/系统卡并入同轮', async () => {
  _resetOutlineRail();
  const el = freshMessages();
  el.appendChild(msg(document.createElement('div'), 'user', '第一个问题'));
  el.appendChild(msg(document.createElement('div'), 'assistant', '回答'));
  el.appendChild(msg(document.createElement('div'), 'system', 'attach 卡'));
  el.appendChild(msg(document.createElement('div'), 'user', '第二个问题'));
  el.appendChild(msg(document.createElement('div'), 'assistant', '回答'));
  el.appendChild(msg(document.createElement('div'), 'user', '第三个问题'));
  el.appendChild(msg(document.createElement('div'), 'assistant', '回答'));
  el.appendChild(msg(document.createElement('div'), 'user', '第四个问题'));
  el.appendChild(msg(document.createElement('div'), 'assistant', '回答'));
  initOutlineRail({ messagesEl: el });
  await flush();
  const rail = el.querySelector('.outline-rail');
  assert.ok(rail.classList.contains('visible'), '满 4 轮显示');
  const ticks = rail.querySelectorAll('.tick');
  assert.equal(ticks.length, 4, '4 轮 = 4 个 tick（回复与系统卡并入当前轮）');
  assert.equal(ticks[0].title, '第一个问题', '预览取用户消息原文');
});

test('点击 tick：滚到该轮开头并加闪烁高亮', async () => {
  _resetOutlineRail();
  const el = freshMessages();
  for (let i = 1; i <= 4; i++) {
    el.appendChild(msg(document.createElement('div'), 'user', `问题${i}`));
    el.appendChild(msg(document.createElement('div'), 'assistant', `回答${i}`));
  }
  initOutlineRail({ messagesEl: el });
  await flush();
  const tick2 = el.querySelectorAll('.outline-rail .tick')[1];
  tick2.click();
  const target = [...el.querySelectorAll('.msg.user')][1];
  assert.ok(target._scrolled >= 1, 'scrollIntoView 已调用');
  assert.ok(target.classList.contains('outline-flash'), '闪烁高亮已加');
  await new Promise((r) => setTimeout(r, 1700));
  assert.ok(!target.classList.contains('outline-flash'), '闪烁定时移除');
});

test('MutationObserver 自愈：renderHistory 清空重灌后 ticks 重建', async () => {
  _resetOutlineRail();
  const el = freshMessages();
  for (let i = 1; i <= 4; i++) {
    el.appendChild(msg(document.createElement('div'), 'user', `问题${i}`));
    el.appendChild(msg(document.createElement('div'), 'assistant', `回答${i}`));
  }
  initOutlineRail({ messagesEl: el });
  await flush();
  assert.equal(el.querySelectorAll('.outline-rail .tick').length, 4);
  // 会话切换：清空 + 换一批消息（rail 节点被 innerHTML 清掉也要自愈）
  el.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    el.appendChild(msg(document.createElement('div'), 'user', `新问题${i}`));
    el.appendChild(msg(document.createElement('div'), 'assistant', `新回答${i}`));
  }
  await flush();
  const rail = el.querySelector('.outline-rail');
  assert.ok(rail && rail.isConnected, 'rail 被重建且仍在 DOM');
  assert.equal(rail.querySelectorAll('.tick').length, 5, '新会话 5 轮 = 5 ticks');
});

test('滚动跟随：默认高亮最后一轮（jsdom 无布局，兜底路径不崩溃）', async () => {
  _resetOutlineRail();
  const el = freshMessages();
  for (let i = 1; i <= 4; i++) {
    el.appendChild(msg(document.createElement('div'), 'user', `问题${i}`));
    el.appendChild(msg(document.createElement('div'), 'assistant', `回答${i}`));
  }
  initOutlineRail({ messagesEl: el });
  await flush();
  el.scrollTop = 500;
  el.dispatchEvent(new window.Event('scroll'));
  await flush();
  const ticks = el.querySelectorAll('.outline-rail .tick');
  assert.ok([...ticks].every((t) => t.classList.contains('active') === (t === ticks[ticks.length - 1])),
    'jsdom 零布局下兜底高亮最后一轮');
});

test('hover tick：预览卡显示该轮用户消息（截断到 180 字符）', async () => {
  _resetOutlineRail();
  const el = freshMessages();
  const long = '很长的问题'.repeat(60);
  for (let i = 1; i <= 4; i++) {
    el.appendChild(msg(document.createElement('div'), 'user', i === 1 ? long : `问题${i}`));
    el.appendChild(msg(document.createElement('div'), 'assistant', `回答${i}`));
  }
  initOutlineRail({ messagesEl: el });
  await flush();
  const preview = el.querySelector('.outline-rail-preview');
  assert.equal(preview.style.display, 'none', '默认隐藏');
  el.querySelectorAll('.outline-rail .tick')[0]
    .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(preview.style.display, 'block', 'hover 显示');
  assert.ok(preview.textContent.startsWith('很长的问题'), '预览为用户消息原文');
  assert.ok(preview.textContent.length <= 181, '截断到 180 字符 + 省略号');
  el.querySelector('.outline-rail-strip')
    .dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
  assert.equal(preview.style.display, 'none', '离开隐藏');
});
