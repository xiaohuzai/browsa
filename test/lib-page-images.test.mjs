// test/lib-page-images.test.mjs — 页面配图 [图N] 内联：collectMarkdownImages 的
// 候选采集（绝对化/去重/跳过 data:）、inlinePageImages 的原位改写（成功编锚、
// 失败保留原文、上限封顶、同 URL 只锚首次）、尺寸过滤与无解码环境 fail-open。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectMarkdownImages,
  blobToJpegDataURL,
  inlinePageImages,
  refererGateForImageUrls,
  isBlockedPageImageUrl,
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
    headers: { get: (k) => (k === 'content-type' ? (spec.type || 'image/jpeg') : null) },
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

test('inlinePageImages: 无信息量 alt（微信「图片」）不进锚点', async () => {
  const restore = installDecodeStub();
  try {
    const md = '正文\n\n![图片](https://cdn.example.com/wx1.png)\n\n后续';
    const res = await inlinePageImages(md, {
      baseUrl: BASE,
      fetchImpl: imgFetch({ 'https://cdn.example.com/wx1.png': { w: 640 } }),
    });
    assert.match(res.text, /\[图1\]/, '锚点保留');
    assert.doesNotMatch(res.text, /\[图1\] 图片/, '通用 alt「图片」不带入锚点');
  } finally {
    restore();
  }
});

test('inlinePageImages: budgetChars 注入的落选图收敛为 [图片]，失败图仍保留 URL', async () => {
  const restore = installDecodeStub();
  try {
    const fetchMap = {};
    const lines = ['开头'];
    for (let i = 1; i <= 3; i++) {
      fetchMap[`https://cdn.example.com/${i}.png`] = { w: 640 };
      lines.push(`![图${i}](https://cdn.example.com/${i}.png)`);
    }
    lines.push('![死链](https://cdn.example.com/dead.png)');
    lines.push('结尾');
    // budgetChars 只容前两张（stub 每张 dataURL 恰 27 字符；注入小预算验证体量
    // 上限路径——张数路径在上方 18 张测试里）。
    const res = await inlinePageImages(lines.join('\n'), {
      baseUrl: BASE,
      fetchImpl: imgFetch(fetchMap),
      budgetChars: 60,
    });
    assert.equal(res.figures.length, 2, '预算内两张');
    assert.match(res.text, /\[图2\] 图2/, '前两张按文档序编号');
    assert.doesNotMatch(res.text, /\[图3\]/, '第 3 张不占编号');
    assert.match(res.text, /\[图片\]/, '预算落选的成功图原位收敛为 [图片]');
    assert.doesNotMatch(res.text, /3\.png/, '落选图的 URL 不残留');
    assert.match(res.text, /!\[死链\]\(https:\/\/cdn\.example\.com\/dead\.png\)/, '失败图仍保留 URL（模型可引用）');
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
    // 上限：20 张全部可下载 → 只锚 MAX_IMAGES 张（与站点字节图共用常数，18）
    const many = Array.from({ length: 20 }, (_, i) => `![图${i}](https://cdn.example.com/${i}.png)`).join('\n');
    const map = {};
    for (let i = 0; i < 20; i++) map[`https://cdn.example.com/${i}.png`] = { w: 800 };
    const r2 = await inlinePageImages(many, { baseUrl: BASE, fetchImpl: imgFetch(map) });
    assert.equal(r2.figures.length, 18);
    assert.doesNotMatch(r2.text, /(?<!!)\[图19\]/, '编号只到 18');
    assert.match(r2.text, /(?:^|\n)\[图片\](?:\n|$)/, '第 19 张起收敛为 [图片]（URL 不残留）');
    assert.doesNotMatch(r2.text, /18\.png/, '落选图的 URL 不残留');

    // 体量预算：budgetChars 注入（与站点字节图共用上限常数的默认值）——
    // 第二张放不下时落选收敛为 [图片]，与张数上限同一行为。
    const two = ['![甲](https://cdn.example.com/a.png)', '![乙](https://cdn.example.com/b.png)'].join('\n');
    const r3 = await inlinePageImages(two, {
      baseUrl: BASE,
      fetchImpl: imgFetch({ 'https://cdn.example.com/a.png': { w: 800 }, 'https://cdn.example.com/b.png': { w: 800 } }),
      budgetChars: 40, // 每张 dataURL 恰 27 字符——只容第一张
    });
    assert.equal(r3.figures.length, 1, '预算只容下第一张');
    assert.match(r3.text, /\[图片\]/, '第二张收敛为 [图片]');
    assert.doesNotMatch(r3.text, /b\.png/, '预算落选图 URL 不残留');
    assert.doesNotMatch(r3.text, /\[图2\]/, '不产生第二编号');
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

// --------------- Referer 门禁图床表（2026-10-15 zhimg 回归修复）--------------

test('refererGateForImageUrls: zhimg 各子域命中知乎门，非门域与垃圾输入返回 null', () => {
  const gate = refererGateForImageUrls([
    'https://example.com/no-hit.jpg',
    'https://picx.zhimg.com/v2-abc_r.jpg?source=1',
  ]);
  assert.deepEqual(gate, { hostRe: gate.hostRe, urlFilter: 'zhimg', referer: 'https://www.zhihu.com/' });
  assert.ok(gate.hostRe.test('pic1.zhimg.com'), 'pic1..pic4 子域都要命中');
  assert.ok(gate.hostRe.test('zhimg.com'), '裸域也要命中');
  assert.equal(refererGateForImageUrls(['https://picx.zhimg.com.evil.example/a.jpg']), null, '后缀伪装不是子域');
  assert.equal(refererGateForImageUrls(['https://evilzhimg.com/a.jpg']), null, '无点边界的前缀拼接不命中');
  assert.equal(refererGateForImageUrls(['https://sns-webpic-qc.xhscdn.com/a.jpg']), null);
  assert.equal(refererGateForImageUrls([]), null);
  assert.equal(refererGateForImageUrls(null), null);
});

// --------------- SSRF 门禁（2026-10-23，借鉴 usememos/web-clipper）--------------

test('isBlockedPageImageUrl: 私网/loopback/metadata/单标签/IPv6 内部段整类拦，公网放行', () => {
  const blocked = [
    'http://localhost:3000/img.png',
    'http://localhost/img.png',
    'https://sub.localhost/a.jpg',
    'http://127.0.0.1/x.png',
    'http://127.1.2.3/x.png',
    'http://10.1.2.3/x.png',
    'http://192.168.1.1/x.png',
    'http://172.16.0.9/x.png',
    'http://172.31.255.1/x.png',
    'http://100.64.0.1/x.png',                        // CGNAT
    'http://169.254.169.254/latest/meta-data/',       // 云 metadata
    'http://0.0.0.0/x.png',
    'http://224.0.0.1/x.png',                          // 组播
    'http://240.0.0.1/x.png',                          // 保留段
    'http://metadata.google.internal/computeMetadata/',
    'https://metadata.google.internal/x',
    'https://nas.internal/x.jpg',
    'https://box.lan/a.png',
    'https://printer.local/x',
    'https://myserver.corp/x',
    'https://host.localdomain/x',
    'https://intranet/x.jpg',                          // 单标签主机名
    'http://[::1]/x.png',
    'http://[::]/x.png',
    'http://[fd00::1]/x.png',                          // 唯一本地 fc00::/7
    'http://[fe80::1]/x.png',                          // 链路本地
    'http://[::ffff:10.0.0.1]/x.png',                  // IPv4-mapped（点分写法）
    'http://[::ffff:a00:1]/x.png',                     // IPv4-mapped（十六进制写法）
    'https://user:pass@example.com/x.png',             // URL 内嵌凭据
    'ftp://example.com/x.png',
    'javascript:void(0)',
    'not a url at all',
    '',
  ];
  for (const url of blocked) {
    assert.equal(isBlockedPageImageUrl(url), true, `must block: ${url}`);
  }
  const allowed = [
    'https://cdn.example.com/a.jpg',
    'http://cdn.example.com/a.jpg',                    // http 公网仍可下载（附加像素无凭据传输）
    'https://93.184.216.34/img.png',                   // 公网 IP 字面量
    'https://pic1.zhimg.com/v2-abc_r.jpg',
    'http://[2606:4700::6810:85e5]/x.png',             // 公网 IPv6
  ];
  for (const url of allowed) {
    assert.equal(isBlockedPageImageUrl(url), false, `must allow: ${url}`);
  }
});

test('inlinePageImages: 黑名单 URL 绝不发 fetch，正文保留 ![alt](url)（fail-open）', async () => {
  const restore = installDecodeStub();
  try {
    const fetched = [];
    const fetchImpl = async (url, init) => {
      fetched.push({ url: String(url), init });
      return imgFetch({ 'https://cdn.example.com/ok.png': { w: 600 } })(url);
    };
    const md = [
      '开头',
      '![内网](http://169.254.169.254/latest/meta-data/)',
      '![本机](http://127.0.0.1:8080/admin.png)',
      '![正常](https://cdn.example.com/ok.png)',
    ].join('\n');
    const res = await inlinePageImages(md, { baseUrl: BASE, fetchImpl });
    // 只有公网那张真正发起了请求
    assert.deepEqual(fetched.map((f) => f.url), ['https://cdn.example.com/ok.png']);
    // 被拦的图按下载失败处理：保留原文，模型仍看得到 URL
    assert.ok(res.text.includes('![内网](http://169.254.169.254/latest/meta-data/)'));
    assert.ok(res.text.includes('![本机](http://127.0.0.1:8080/admin.png)'));
    assert.ok(res.text.includes('[图1]'));
    assert.equal(res.figures.length, 1);
    // 请求带上 SSRF 配套的 fetch 选项
    assert.equal(fetched[0].init.redirect, 'error');
    assert.equal(fetched[0].init.credentials, 'omit');
    assert.equal(fetched[0].init.referrerPolicy, 'no-referrer');
  } finally {
    restore();
  }
});

test('inlinePageImages: 非 image content-type 在读 body 前就放弃', async () => {
  const restore = installDecodeStub();
  try {
    let bodyRead = false;
    const fetchImpl = async () => ({
      ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) },
      // body 若被读就会走到这里——预检查必须在它之前拦住
      blob: async () => { bodyRead = true; return { size: 10, type: 'text/html' }; },
    });
    const res = await inlinePageImages('![伪装成图的网页](https://cdn.example.com/a.png)', { baseUrl: BASE, fetchImpl });
    assert.equal(bodyRead, false, 'non-image content-type must bail before reading the body');
    assert.ok(res.text.includes('![伪装成图的网页]'), 'degrades to the original markdown');
    assert.equal(res.figures.length, 0);
  } finally {
    restore();
  }
});

test('inlinePageImages: 流式下载超上限立即 cancel，不整读进内存', async () => {
  const restore = installDecodeStub();
  try {
    let cancelled = false;
    const CHUNK_OVER = 9 * 1024 * 1024; // 只谎报 byteLength，不真分配内存
    const fetchImpl = async () => ({
      ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'image/jpeg' : null) },
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: { byteLength: CHUNK_OVER } }),
          cancel: async () => { cancelled = true; },
        }),
      },
    });
    const res = await inlinePageImages('![超大图](https://cdn.example.com/huge.png)', { baseUrl: BASE, fetchImpl });
    assert.equal(cancelled, true, 'oversized stream must be cancelled mid-read');
    assert.equal(res.figures.length, 0);
    assert.ok(res.text.includes('![超大图]'));
  } finally {
    restore();
  }
});

test('inlinePageImages: 302 被禁（redirect:error）时按下载失败降级，不抛出', async () => {
  const restore = installDecodeStub();
  try {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch (redirect)'); };
    const res = await inlinePageImages('![跳转图](https://cdn.example.com/r.png)', { baseUrl: BASE, fetchImpl });
    assert.equal(res.figures.length, 0);
    assert.ok(res.text.includes('![跳转图](https://cdn.example.com/r.png)'));
  } finally {
    restore();
  }
});
