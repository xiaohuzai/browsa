// test/lib-provider-display.test.mjs — the shared provider/agent naming
// scheme (lib/provider-display.js): the sidebar dropdown and the reply-source
// stamp MUST produce identical labels for the same selection, so both consume
// this module. Pure, no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerDisplayName, providerEntrySuffix, providerEntryLabel, BRIDGE_DISPLAY_NAME, BRIDGE_CARD_LABEL } from '../lib/provider-display.js';

test('providerDisplayName — alias wins, fixed agents fall back, LLM N and capitalization', () => {
  assert.equal(providerDisplayName('llm-1', { alias: '方舟 Coding' }), '方舟 Coding');
  assert.equal(providerDisplayName('hermes', {}), 'Hermes Agent');
  assert.equal(providerDisplayName('llm-3', {}), 'LLM 3');
  assert.equal(providerDisplayName('bridge', {}), BRIDGE_DISPLAY_NAME, 'bridge 用共享的固定短名');
  assert.equal(
    providerDisplayName('bridge', { alias: BRIDGE_CARD_LABEL }),
    BRIDGE_DISPLAY_NAME,
    'bridge 的存储别名是设置卡上的长标签，下拉/回复芯片仍用短名（唯一忽略别名的卡）'
  );
  assert.equal(providerDisplayName('llm-1', { alias: '   ' }), 'LLM 1', 'whitespace-only alias falls back');
});

test('providerEntrySuffix — LLM model id, bridge alias (fallback host:port), agent bare', () => {
  assert.equal(providerEntrySuffix({ type: 'llm' }, 'glm-5.3-flash'), 'glm-5.3-flash');
  assert.equal(
    providerEntrySuffix({ type: 'agent', isBridge: true, bridgeAgents: { 'http://127.0.0.1:3949': 'claude' } }, 'http://127.0.0.1:3949'),
    'claude'
  );
  assert.equal(
    providerEntrySuffix({ type: 'agent', isBridge: true }, 'https://192.168.1.5:3948'),
    '192.168.1.5:3948',
    'never-pinged endpoint falls back to host:port'
  );
  assert.equal(providerEntrySuffix({ type: 'agent', isHermes: true }, ''), '', 'single-session agents have no suffix');
  assert.equal(providerEntrySuffix({ type: 'llm' }, ''), '', 'no model → no suffix');
});

test('providerEntryLabel — dropdown and reply stamp produce the SAME string', () => {
  const ark = { type: 'llm', alias: '方舟 Coding' };
  assert.equal(providerEntryLabel('llm-1', ark, 'glm-5.3-flash'), '方舟 Coding · glm-5.3-flash');
  const bridge = { type: 'agent', isBridge: true, alias: 'Agent Bridge', bridgeAgents: { 'http://127.0.0.1:3948': 'codex' } };
  assert.equal(providerEntryLabel('bridge', bridge, 'http://127.0.0.1:3948'), 'Agent Bridge · codex');
  assert.equal(providerEntryLabel('hermes', { type: 'agent', isHermes: true }, ''), 'Hermes Agent');
  assert.equal(providerEntryLabel('opencode', { type: 'agent', isOpencode: true, alias: 'OpenCode Agent' }, ''), 'OpenCode Agent');
});
