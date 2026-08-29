// test/lib-page-images.test.mjs — 页面配图 [图N] 内联：collectMarkdownImages 的
// 候选采集（绝对化/去重/跳过 data:）、inlinePageImages 的原位改写（成功编锚、
// 失败保留原文、上限封顶、同 URL 只锚首次）、尺寸过滤与无解码环境 fail-open。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectMarkdownImages,
  blobToJpegDataURL,
  inlinePageImages,
} from '../lib/page-images.js';

const BASE = 'https://example.com/post/a';

/** 装上解码环境 stub（Node 无 createImageBitmap/OffscreenCanvas），返回恢复函数。 */
function installDecodeStub({ minW = 0 } = {}) {
  const real = {
    createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  };
  globalThis.createImageBitmap = async (blob) => {
    const w = blob._w || 0;
    if (w < minW) throw new Error('decode fail');
    return { width: w, height: blob._h || 600, close() {} };
  };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { fillRect() {}, drawImage() {} }; }
    async convertToBlob() { return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }); }
  };
  return () => {
    if (real.createImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = real.createImageBitmap;
    if (real.OffscreenCanvas === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = real.OffscreenCanvas;
  };
}

const imgFetch = (map) => async (url) => {
  const spec = map[url];
  if (!spec) return { ok: false, status: 404 };
  return {
    ok: true,
    blob: async () => ({ size: spec.size || 1000, type: spec.type || 'image/jpeg', _w: spec.w, _h: spec.h || 500 }),
  };
};

test('collectMarkdownImages: 相对 URL 绝对化、去重、跳过 data:/非 http', () => {
  const md = [
    '前言',
    '![题图](/img/cover.png)',
    '![重复](https://example.com/img/cover.png)',   // 同一 URL（绝对化后）去重
    '![内联 data](data:image/png;base64,AAA)',        // 跳过
    '![带标题](https://cdn.example.com/x.webp "title")',
    '![协议外](javascript:void(0))',
  ].join('\n');
  const out = collectMarkdownImages(md, BASE);
  assert.deepEqual(out.map((c) => c.url), [
    'https://example.com/img/cover.png',
    'https://cdn.example.com/x.webp',
  ]);
  assert.equal(out[0].alt, '题图');
  assert.deepEqual(collectMarkdownImages('无图正文', BASE), []);
});

test('inlinePageImages: 成功图原位编 [图N] 锚点，失败图保留 Markdown 原样', async () => {
  const restore = installDecodeStub();
  try {
    const md = [
      '开头',
      '![图表一](https://cdn.example.com/1.png)',
      '中间这段不会下载成功：',
      '![死链](https://cdn.example.com/dead.png)',
      '结尾前的最后一张：',
      '![示意图](https://cdn.example.com/3.png)',
    ].join('\n');
    const res = await inlinePageImages(md, {
      baseUrl: BASE,
      fetchImpl: imgFetch({
        'https://cdn.example.com/1.png': { w: 900 },
        'https://cdn.example.com/3.png': { w: 500 },
      }),
    });
    assert.equal(res.figures.length, 2);
    assert.match(res.figures[0].url, /^data:image\/jpeg;base64,/);
    assert.match(res.text, /\[图1\] 图表一/, '第一张成功图按文档序编 1');
    assert.doesNotMatch(res.text, /\[图2\] 死链/, '失败的图不占编号');
    assert.match(res.text, /!\[死链\]\(https:\/\/cdn\.example\.com\/dead\.png\)/, '失败图保留原 Markdown');
    assert.match(res.text, /\[图2\] 示意图/, '第二张成功图顺延编 2');
  } finally {
    restore();
  }
});

test('inlinePageImages: 小于最小尺寸的图（图标/头像）整体跳过', async () => {
  const restore = installDecodeStub();
  try {
    const md = '正文\n\n![小图标](https://cdn.example.com/icon.png)\n\n后续';
    const res = await inlinePageImages(md, {
      baseUrl: BASE,
      fetchImpl: imgFetch({ 'https://cdn.example.com/icon.png': { w: 64, h: 64 } }),
    });
    assert.deepEqual(res.figures, []);
    assert.match(res.text, /!\[小图标\]/, '尺寸不足 → 原文保留');
  } finally {
    restore();
  }
});

test('inlinePageImages: 同一 URL 多次出现只锚定首次；上限 8 张封顶', async () => {
  const restore = installDecodeStub();
  try {
    const dup = '![复用](https://cdn.example.com/same.png)\n中间\n![复用](https://cdn.example.com/same.png)';
    const r1 = await inlinePageImages(dup, {
      baseUrl: BASE,
      fetchImpl: imgFetch({ 'https://cdn.example.com/same.png': { w: 800 } }),
    });
    assert.equal(r1.figures.length, 1);
    assert.equal(r1.text.split('[图1]').length - 1, 1, '第二次出现保留 Markdown');
    // 上限：10 张全部可下载 → 只锚 8 张
    const many = Array.from({ length: 10 }, (_, i) => `![图${i}](https://cdn.example.com/${i}.png)`).join('\n');
    const map = {};
    for (let i = 0; i < 10; i++) map[`https://cdn.example.com/${i}.png`] = { w: 800 };
    const r2 = await inlinePageImages(many, { baseUrl: BASE, fetchImpl: imgFetch(map) });
    assert.equal(r2.figures.length, 8);
    assert.doesNotMatch(r2.text, /(?<!!)\[图9\]/, '编号只到 8');
    assert.match(r2.text, /!\[图8\]/, '第 9 张起保留原 Markdown');
  } finally {
    restore();
  }
});

test('inlinePageImages: 无解码环境（非 SW）fail-open 返回原文', async () => {
  const restore = installDecodeStub();
  restore(); // 先恢复即删除 stub → 模拟无 createImageBitmap
  const md = '![一张图](https://cdn.example.com/1.png)';
  const res = await inlinePageImages(md, {
    baseUrl: BASE,
    fetchImpl: imgFetch({ 'https://cdn.example.com/1.png': { w: 800 } }),
  });
  assert.deepEqual(res.figures, []);
  assert.equal(res.text, md);
});

test('blobToJpegDataURL: 拒绝损坏/不支持格式（SVG），成功时输出 JPEG dataURL', async () => {
  const restore = installDecodeStub({ minW: 100 });
  try {
    assert.equal(await blobToJpegDataURL({ _w: 50 }), null, '解码失败 → null');
    const url = await blobToJpegDataURL({ _w: 640, _h: 400 });
    assert.match(url, /^data:image\/jpeg;base64,/);
    // 超宽图压到 768：canvas 宽度即输出宽度（stub 记录构造参数）
    let sawW = 0;
    const realOffscreen = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class extends realOffscreen {
      constructor(w, h) { super(w, h); sawW = w; }
    };
    await blobToJpegDataURL({ _w: 2000, _h: 1000 });
    assert.equal(sawW, 768);
  } finally {
    restore();
  }
});
