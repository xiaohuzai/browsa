// test/lib-asr-providers.test.mjs — ASR 服务商注册表与适配器接缝：
// 注册表元数据驱动 options 卡片 UI（下拉/占位符/提示/文档链接），
// ASR_ADAPTERS 决定协议分发；未知 id 一律回退 ark（老配置无 provider 字段）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASR_PROVIDERS, getAsrProvider } from '../lib/asr-providers.js';
import { asrAdapterFor, ASR_DEFAULTS, transcribeAudio, analyzeVideo } from '../lib/handlers/attach-asr.js';

test('注册表：ark 元数据齐全（UI 下拉/占位符/提示/文档链接全靠它驱动）', () => {
  const ark = ASR_PROVIDERS.ark;
  assert.ok(ark, 'ark 必须在注册表');
  assert.equal(ark.id, 'ark');
  assert.ok(ark.label);
  assert.match(ark.defaultBaseUrl, /api\/v3$/);
  assert.ok(ark.defaultModel);
  assert.ok(ark.apiKeyPlaceholder);
  assert.ok(ark.baseUrlTip, 'Base URL 的 ? 提示内容');
  assert.match(ark.baseUrlTip, /api\/v3/);
  assert.match(ark.docUrl, /^https:/);
  assert.ok(ark.docLabel);
});

test('getAsrProvider：未知 id 回退 ark（老配置无 provider 字段同样成立）', () => {
  assert.equal(getAsrProvider('nope'), ASR_PROVIDERS.ark);
  assert.equal(getAsrProvider(undefined), ASR_PROVIDERS.ark);
  assert.equal(getAsrProvider('ark'), ASR_PROVIDERS.ark);
});

test('asrAdapterFor：ark 适配器 = 本文件的 transcribeAudio/analyzeVideo；未知 id 回退 ark', () => {
  const ark = asrAdapterFor('ark');
  assert.equal(ark.transcribeAudio, transcribeAudio);
  assert.equal(ark.analyzeVideo, analyzeVideo);
  assert.equal(asrAdapterFor('nope'), asrAdapterFor('ark'), '未知 id 回退 ark');
});

test('ASR_DEFAULTS.provider 默认 ark（与 storage.js 的 asr DEFAULTS 同步）', () => {
  assert.equal(ASR_DEFAULTS.provider, 'ark');
});
