// test/lib-llm-models.test.mjs — listModels（cherry-studio 同款的模型自动检测）：
// OpenAI/Anthropic 双协议端点与鉴权头、版本感知拼接、响应形状兼容（data[].id /
// models[] / 裸数组 / 字符串）、去重排序截断、永不抛错（失败返回 {ok:false}）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listModels } from '../lib/llm-client.js';

test('chat 风格：base 无版本段 → /v1/models + Bearer，data[].id 去重排序', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }, { id: 'gpt-4o' }] }),
      };
    };
    const out = await listModels({ baseUrl: 'https://api.example.com', apiKey: 'sk-1' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.models, ['gpt-3.5-turbo', 'gpt-4o'], '排序 + 去重');
    assert.equal(calls[0].url, 'https://api.example.com/v1/models');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('版本感知拼接：base 自带 /v1（方舟 /api/v3 同理）不重复加版本段', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) };
    };
    await listModels({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' });
    assert.equal(calls[0], 'https://api.example.com/v1/models');
    await listModels({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'k' });
    assert.equal(calls[1], 'https://ark.cn-beijing.volces.com/api/v3/models');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('anthropic 风格：x-api-key + anthropic-version 头（Bearer 兼容网关保留）', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Sonnet' }] }) };
    };
    const out = await listModels({ baseUrl: 'https://api.anthropic.com', apiKey: 'ak-1', apiStyle: 'anthropic' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.models, ['claude-sonnet-4-5']);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models');
    assert.equal(calls[0].headers['x-api-key'], 'ak-1');
    assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(calls[0].headers.Authorization, 'Bearer ak-1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('响应形状兼容：裸数组 / models[] / name 字段 / 字符串项', async () => {
  const realFetch = globalThis.fetch;
  const cases = [
    { body: ['m-b', 'm-a'], expect: ['m-a', 'm-b'] },
    { body: { models: [{ name: 'n-2' }, { name: 'n-1' }] }, expect: ['n-1', 'n-2'] },
    { body: { data: [{ id: ' x1 ' }, 'x2', { id: 'x1' }] }, expect: ['x1', 'x2'], trim: true },
  ];
  try {
    for (const c of cases) {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => c.body });
      const out = await listModels({ baseUrl: 'https://api.example.com', apiKey: 'k' });
      assert.equal(out.ok, true);
      assert.deepEqual(out.models, c.expect);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('截断 200 上限；空列表 / 非 JSON 也返回 {ok:false} 不抛错', async () => {
  const realFetch = globalThis.fetch;
  try {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `m-${String(i).padStart(3, '0')}` }));
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: many }) });
    const capped = await listModels({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    assert.equal(capped.models.length, 200);
    assert.equal(capped.models[0], 'm-000');

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ objects: [] }) });
    const empty = await listModels({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /没有模型列表/);

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    const bad = await listModels({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    assert.equal(bad.ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('失败路径：缺 baseUrl / 非 OK 状态码 / 网络异常 → {ok:false, error}', async () => {
  const realFetch = globalThis.fetch;
  try {
    const noBase = await listModels({ apiKey: 'k' });
    assert.equal(noBase.ok, false);
    assert.match(noBase.error, /Base URL/);

    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}' });
    const unauthorized = await listModels({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    assert.equal(unauthorized.ok, false);
    assert.match(unauthorized.error, /HTTP 401/);
    assert.match(unauthorized.error, /bad key/);

    globalThis.fetch = async () => { throw new Error('boom'); };
    const net = await listModels({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    assert.equal(net.ok, false);
    assert.match(net.error, /Network error: boom/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
