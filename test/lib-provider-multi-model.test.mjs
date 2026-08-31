// test/lib-provider-multi-model.test.mjs — 多模型 provider 的解析纯函数：
// providerModelList（models 全量列表优先，回退单个 model 字段，去空去重保序）与
// resolveChatModel（主页下拉选中的 activeModel 优先，越界/缺失回退 provider.model）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { providerModelList, resolveChatModel } from '../lib/handlers/provider-resolver.js';

test('providerModelList: models 全量列表优先，缺失/为空回退 model 字段', () => {
  assert.deepEqual(providerModelList({ models: ['a', 'b'], model: 'a' }), ['a', 'b']);
  assert.deepEqual(providerModelList({ model: 'only' }), ['only'], '老配置无 models 字段');
  assert.deepEqual(providerModelList({ models: [], model: 'fallback' }), ['fallback'], 'models 空数组 → 回退');
  assert.deepEqual(providerModelList({}), [], '全空 → 空列表');
  assert.deepEqual(providerModelList(undefined), [], '防御 undefined');
});

test('providerModelList: 去空、去重、保序', () => {
  assert.deepEqual(
    providerModelList({ models: ['b', ' a ', 'b', '', 'c'] }),
    ['b', 'a', 'c'],
    'trim + 去空 + 去重 + 保持首次出现顺序',
  );
});

test('resolveChatModel: 下拉选中的 activeModel 属于该 provider 时优先', () => {
  const provider = { model: 'glm-a', models: ['glm-a', 'glm-b'] };
  assert.equal(resolveChatModel(provider, { activeModel: 'glm-b' }), 'glm-b');
  assert.equal(resolveChatModel(provider, { activeModel: '' }), 'glm-a', '未指定 → 卡上第一个');
  assert.equal(resolveChatModel(provider, {}), 'glm-a', '无 activeModel 字段（老配置）');
  assert.equal(resolveChatModel(provider, undefined), 'glm-a', '防御 all 缺失');
});

test('resolveChatModel: activeModel 不属于该 provider → 回退（防跨网关串模型）', () => {
  const provider = { model: 'ark-model', models: ['ark-model', 'ark-other'] };
  assert.equal(
    resolveChatModel(provider, { activeModel: 'glm-5.3-flash' }),
    'ark-model',
    '残留的旧 provider 模型 ID 绝不发给另一个网关',
  );
});

test('resolveChatModel: Agent 卡（Hermes，无模型字段）返回空串', () => {
  assert.equal(resolveChatModel({ model: '' }, { activeModel: '' }), '');
  assert.equal(resolveChatModel({ model: '', models: [] }, { activeModel: 'x' }), '');
});
