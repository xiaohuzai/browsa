// test/lib-asr-qwen-upload.test.mjs — 千问临时文件上传链路（纯单测，mock fetch）：
// Base URL 规整、getPolicy 请求形态、OSS POST 表单顺序（file 必须最后一个域）、
// oss:// 引用拼法、失败路径 fail-open 返回 {ok:false}。见 attach-asr-qwen.js 头注。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeQwenBaseUrl, qwenUploadOrigin, qwenVideoFps, uploadBlobToQwen,
} from '../lib/handlers/attach-asr-qwen.js';

const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const POLICY = {
  data: {
    policy: 'POLICY-STRING',
    signature: 'SIGNATURE',
    upload_dir: 'dashscope-instant/uploads/abc123',
    upload_host: 'https://dashscope-file.oss-cn-beijing.aliyuncs.com',
    oss_access_key_id: 'OSS-AK',
    x_oss_object_acl: 'private',
    x_oss_forbid_overwrite: 'true',
    expire_in_seconds: 300,
    max_file_size_mb: 1024,
  },
};

test('normalizeQwenBaseUrl: 域名/compatible-mode 变体/尾部 chat 路径都规整到兼容端点', () => {
  assert.equal(normalizeQwenBaseUrl(''), BASE);
  assert.equal(normalizeQwenBaseUrl(null), BASE);
  assert.equal(normalizeQwenBaseUrl('https://dashscope.aliyuncs.com'), BASE);
  assert.equal(normalizeQwenBaseUrl('https://dashscope.aliyuncs.com/'), BASE);
  assert.equal(normalizeQwenBaseUrl('https://dashscope.aliyuncs.com/compatible-mode'), BASE);
  assert.equal(normalizeQwenBaseUrl(BASE), BASE);
  assert.equal(normalizeQwenBaseUrl(BASE + '/'), BASE);
  assert.equal(normalizeQwenBaseUrl(BASE + '/chat/completions'), BASE, '贴了完整 chat 路径也能纠正');
  assert.equal(
    normalizeQwenBaseUrl('https://dashscope-intl.aliyuncs.com'),
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    '国际站同域拼接',
  );
});

test('qwenUploadOrigin: chat base 的同域 /api/v1（上传与任务接口）', () => {
  assert.equal(qwenUploadOrigin(BASE), 'https://dashscope.aliyuncs.com/api/v1');
  assert.equal(qwenUploadOrigin('https://dashscope-intl.aliyuncs.com'), 'https://dashscope-intl.aliyuncs.com/api/v1');
});

test('qwenVideoFps: 短视频 2 上限、长视频 0.1 下限、随时长单调递减', () => {
  assert.equal(qwenVideoFps(0), 2);
  assert.equal(qwenVideoFps(4), 2, '4 秒 → 512/4=128 → 夹到 2');
  const fps10min = qwenVideoFps(600);
  assert.ok(fps10min > 0.8 && fps10min <= 0.86, `10 分钟约 0.85fps，实际 ${fps10min}`);
  assert.equal(qwenVideoFps(7200), 0.1, '2 小时 → 0.1 下限');
  assert.ok(qwenVideoFps(600) > qwenVideoFps(1200), '视频越长 fps 越低');
});

test('uploadBlobToQwen: getPolicy 带消费模型 → OSS POST 表单顺序（file 最后）→ oss:// 引用', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/uploads?action=getPolicy')) {
        return { ok: true, status: 200, json: async () => POLICY };
      }
      return { ok: true, status: 200, text: async () => '' };
    };
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const out = await uploadBlobToQwen({
      blob, filename: 'browsa-bili-BV1-audio.wav', apiKey: 'sk-test',
      baseUrl: BASE, model: 'qwen3.5-omni-flash',
    });
    assert.equal(out.ok, true);
    assert.equal(out.bytes, 3);
    assert.equal(
      out.fileId,
      'oss://dashscope-instant/uploads/abc123/browsa-bili-BV1-audio.wav',
      'oss:// + key（upload_dir/filename）',
    );
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].url,
      'https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.5-omni-flash',
      'getPolicy 与【消费方模型】绑定',
    );
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
    assert.equal(calls[1].url, POLICY.data.upload_host);
    const fd = calls[1].init.body;
    const names = [...fd.keys()];
    assert.deepEqual(names, [
      'OSSAccessKeyId', 'Signature', 'policy', 'key',
      'x-oss-object-acl', 'x-oss-forbid-overwrite', 'success_action_status', 'file',
    ], '官方文档字段顺序，file 必须最后一个');
    assert.equal(fd.get('OSSAccessKeyId'), 'OSS-AK');
    assert.equal(fd.get('policy'), 'POLICY-STRING');
    assert.equal(fd.get('key'), 'dashscope-instant/uploads/abc123/browsa-bili-BV1-audio.wav');
    assert.equal(fd.get('success_action_status'), '200');
    assert.equal(fd.get('file').name, 'browsa-bili-BV1-audio.wav');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('uploadBlobToQwen: getPolicy 支持扁平返回形态（无 data 包裹）', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('getPolicy')) {
        return { ok: true, status: 200, json: async () => ({ ...POLICY.data }) };
      }
      return { ok: true, status: 200, text: async () => '' };
    };
    const out = await uploadBlobToQwen({
      blob: new Blob(['x']), filename: 'a.wav', apiKey: 'sk', baseUrl: BASE, model: 'm',
    });
    assert.equal(out.ok, true);
    assert.equal(out.fileId, 'oss://dashscope-instant/uploads/abc123/a.wav');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('uploadBlobToQwen 失败路径：缺参 / getPolicy 失败 / OSS 非 2xx 都返回 {ok:false,error}', async () => {
  assert.equal((await uploadBlobToQwen({})).ok, false, 'no blob');
  assert.match((await uploadBlobToQwen({ blob: new Blob(['x']) })).error, /no apiKey/);
  assert.match(
    (await uploadBlobToQwen({ blob: new Blob(['x']), apiKey: 'sk' })).error,
    /no model/,
    '临时文件与模型绑定，缺 model 直接拒绝',
  );

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('getPolicy')) {
        return { ok: false, status: 401, json: async () => ({ code: 'InvalidApiKey', message: 'bad key' }) };
      }
      return { ok: true, status: 200, text: async () => '' };
    };
    const bad = await uploadBlobToQwen({
      blob: new Blob(['x']), filename: 'a.wav', apiKey: 'sk', baseUrl: BASE, model: 'm',
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /getPolicy HTTP 401/);
    assert.match(bad.error, /InvalidApiKey/, '错误体透出，排障不用猜');

    globalThis.fetch = async (url) => {
      if (String(url).includes('getPolicy')) {
        return { ok: true, status: 200, json: async () => POLICY };
      }
      return { ok: false, status: 403, text: async () => '' };
    };
    const denied = await uploadBlobToQwen({
      blob: new Blob(['x']), filename: 'a.wav', apiKey: 'sk', baseUrl: BASE, model: 'm',
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /OSS upload HTTP 403/);

    globalThis.fetch = async () => { throw new Error('net down'); };
    const net = await uploadBlobToQwen({
      blob: new Blob(['x']), filename: 'a.wav', apiKey: 'sk', baseUrl: BASE, model: 'm',
    });
    assert.equal(net.ok, false);
    assert.match(net.error, /net down/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
