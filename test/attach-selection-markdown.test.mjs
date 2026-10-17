// test/attach-selection-markdown.test.mjs — 选区附加 HTML→Markdown 转换段的接线
// 测试（2026-10-11 全库链路审计：这是附加家族里唯一没有 handle() 级覆盖的链）。
//
// 链条：content script 的 SELECTION_CACHE {text, html} → background selectionCache
// → ATTACH_PAGE mode:'selected' → 页面 MAIN world Turndown（selectionHtmlToMarkdown-
// InPage）→ md 长度 sanity 门 → ctx.text 重写 + format:'markdown'（上下文头
// "Mode: selected | markdown"）。转换段的 format 戳曾是零消费的 selectedFormat
// （2026-10-11 审计修复），本文件把「戳必须落到上下文头」一起钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorageArea } from './helpers/chrome-mock.mjs';

const localArea = makeStorageArea({
  activeProvider: 'compatible',
  providers: {
    compatible: { type: 'llm', baseUrl: 'http://localhost:9999', apiKey: '', model: 'test-model' },
  },
});
const sessionArea = makeStorageArea();

// MAIN world 转换函数（selectionHtmlToMarkdownInPage）的桩返回值；null = 桩不被调用。
let mdResult = null;

const chromeMock = {
  runtime: {
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: () => {},
    connect: () => null,
    getURL: (p) => p,
    lastError: undefined
  },
  tabs: {
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    query: async () => [{ id: 1, url: 'https://example.com/a', title: 'Article' }],
    get: async (tabId) => ({ id: tabId, url: 'https://example.com/a', title: 'Article', favIconUrl: '' }),
  },
  sidePanel: { setOptions: () => {}, setPanelBehavior: async () => {} },
  webNavigation: {
    onHistoryStateUpdated: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
    onBeforeNavigate: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (opts) => {
      if (opts.files) return [{ result: null }]; // ensureReadabilityInjected 注入
      return [{ result: mdResult }];
    },
  },
  storage: {
    onChanged: { addListener: () => {} },
    local: localArea,
    session: sessionArea,
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});

const bg = await import('../background.js');
const { handle } = bg;

const PLAIN = '这是选区的纯文本。价格 8 元。';
const HTML = '<h2>价格表</h2><table><tr><td>项目</td><td>价格</td></tr><tr><td>门票</td><td>8 元</td></tr></table><ul><li>含保险</li></ul>';
const MD = '## 价格表\n\n| 项目 | 价格 |\n| --- | --- |\n| 门票 | 8 元 |\n\n- 含保险';

test('selected attach with cached HTML: Turndown markdown replaces plain text and the header says markdown', async () => {
  mdResult = MD;
  await handle({ type: 'SELECTION_CACHE', text: PLAIN, html: HTML }, { tab: { id: 21 } });
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 21, mode: 'selected' }, { tab: { id: 21 } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.format, 'markdown', 'format 戳必须落到 ctx（旧 selectedFormat 零消费）');

  const { history } = await localArea.get('history');
  const entry = history[history.length - 1];
  assert.equal(typeof entry.content, 'string');
  assert.match(entry.content, /Mode: selected \| markdown/, '上下文头标注结构化 Markdown');
  assert.match(entry.content, /\| 项目 \| 价格 \|/, '表格结构进上下文（纯文本全丢的那类信息）');
  assert.match(entry.content, /- 含保险/, '列表结构进上下文');
});

test('selected attach, conversion degraded (md far shorter than plain text): plain text stands, no markdown header', async () => {
  mdResult = '太短'; // sanity 门：md.length < plain.length * 0.5 → 转换失真，保持纯文本
  await handle({ type: 'SELECTION_CACHE', text: PLAIN, html: HTML }, { tab: { id: 22 } });
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 22, mode: 'selected' }, { tab: { id: 22 } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.format, undefined, '失真转换不得盖 markdown 戳');

  const { history } = await localArea.get('history');
  const entry = history[history.length - 1];
  assert.match(entry.content, /这是选区的纯文本/, '纯文本原文入库');
  assert.doesNotMatch(entry.content, /Mode: selected \| markdown/);
});

test('selected attach without cached HTML (msg.text fallback): plain path unchanged', async () => {
  mdResult = null; // 不得被消费
  const res = await handle({ type: 'ATTACH_PAGE', tabId: 23, mode: 'selected', text: '右键菜单直送的选区文本' }, { tab: { id: 23 } });
  assert.equal(res.ok, true);
  assert.equal(res.ctx.format, undefined);

  const { history } = await localArea.get('history');
  const entry = history[history.length - 1];
  assert.match(entry.content, /右键菜单直送的选区文本/);
  assert.doesNotMatch(entry.content, /Mode: selected \| markdown/);
});
