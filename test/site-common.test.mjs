// test/site-common.test.mjs
//
// Behavior tests for the shared MAIN-world helpers in site-common.js, loaded
// through its CommonJS export (the same implementation the browser gets via
// the manifest-ordered injection). These cover the consolidated fetcher and
// walker end-to-end with stubbed page primitives; the zhihu/geektime source
// pins live in test/site-twin-lockstep.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const siteCommon = require('../lib/content-scripts/site-common.js');

test('site-common exports the shared helper surface', () => {
  for (const name of ['relayToHost', 'pageImgUrl', 'htmlToArticleText', 'fetchImagesAsJpegDataUrls']) {
    assert.equal(typeof siteCommon[name], 'function', `${name} must be exported`);
  }
});

test('pageImgUrl prefers data-actualsrc, then data-original, then src; skips data:/blob:', () => {
  const attr = (attrs) => (name) => (name in attrs ? attrs[name] : null);
  assert.equal(siteCommon.pageImgUrl({ getAttribute: attr({ src: 'https://p/a.jpg', 'data-actualsrc': 'https://p/full.jpg' }) }), 'https://p/full.jpg');
  assert.equal(siteCommon.pageImgUrl({ getAttribute: attr({ src: 'https://p/a.jpg', 'data-original': 'https://p/orig.jpg' }) }), 'https://p/orig.jpg');
  assert.equal(siteCommon.pageImgUrl({ getAttribute: attr({ 'data-actualsrc': 'data:image/svg+xml;base64,PHN2Zy8+', src: 'https://p/bare.jpg' }) }), 'https://p/bare.jpg', 'data: placeholder never qualifies');
  assert.equal(siteCommon.pageImgUrl({ getAttribute: attr({ src: 'blob:https://zhihu.com/x' }) }), '', 'blob: only → no URL');
  assert.equal(siteCommon.pageImgUrl({ getAttribute: () => null }), '');
});

test('htmlToArticleText keeps figures in place as markdown image syntax', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const prevDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const out = siteCommon.htmlToArticleText('<p>前文</p><img src="https://picx.zhimg.com/v2-a.jpg" alt="示意图"><p>后文</p>', siteCommon.pageImgUrl);
    assert.match(out, /前文/);
    assert.match(out, /!\[示意图\]\(https:\/\/picx\.zhimg\.com\/v2-a\.jpg\)/);
    assert.match(out, /后文/);
    // Block tags keep paragraphs apart; alt text that would break markdown is sanitized.
    assert.equal(siteCommon.htmlToArticleText('<p>a</p><p>b</p>', siteCommon.pageImgUrl), 'a\n\nb');
    assert.match(siteCommon.htmlToArticleText('<img alt="a[b](c)" src="https://p/z.jpg">', siteCommon.pageImgUrl), /!\[a b c\]/);
    // PICTURE resolves to its inner img; NOSCRIPT twins are not walked twice.
    const pic = siteCommon.htmlToArticleText('<picture><img src="https://p/in.jpg" alt="i"></picture>', siteCommon.pageImgUrl);
    assert.match(pic, /!\[i\]\(https:\/\/p\/in\.jpg\)/);
    const twin = siteCommon.htmlToArticleText('<img src="https://p/one.jpg" alt="o"><noscript><img src="https://p/one.jpg" alt="o"></noscript>', siteCommon.pageImgUrl);
    assert.equal(twin.match(/!\[o\]/g).length, 1, 'noscript twin must not duplicate the figure');
    // document undefined → '' (Node guard, no DOM loaded)
    globalThis.document = undefined;
    assert.equal(siteCommon.htmlToArticleText('<p>x</p>', siteCommon.pageImgUrl), '');
  } finally {
    globalThis.document = prevDocument;
  }
});

// ---- fetchImagesAsJpegDataUrls: stubbed page primitives ---------------------

function withPageStubs({ okUrls = [], imageOk = true, canvasOk = true, dataUrl = 'data:image/jpeg;base64,QUFB' }, fn) {
  const prev = {
    fetch: globalThis.fetch,
    Image: globalThis.Image,
    document: globalThis.document,
    createObjectURL: globalThis.URL.createObjectURL,
    revokeObjectURL: globalThis.URL.revokeObjectURL,
  };
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    if (!okUrls.includes(url)) throw new TypeError('network down');
    return { ok: true, blob: async () => ({}) };
  };
  globalThis.URL.createObjectURL = () => 'obj:stub';
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.Image = class {
    set src(v) { this._src = v; queueMicrotask(() => { if (imageOk) this.onload && this.onload(); else this.onerror && this.onerror(); }); }
    get width() { return 2048; }
    get height() { return 1024; }
  };
  globalThis.document = {
    createElement: (tag) => ({
      width: 0,
      height: 0,
      getContext: () => (canvasOk ? { drawImage() {} } : null),
      toDataURL: () => { if (!dataUrl) throw new Error('encode failed'); return dataUrl; },
    }),
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = prev.fetch;
      globalThis.Image = prev.Image;
      globalThis.document = prev.document;
      if (prev.createObjectURL === undefined) delete globalThis.URL.createObjectURL; else globalThis.URL.createObjectURL = prev.createObjectURL;
      if (prev.revokeObjectURL === undefined) delete globalThis.URL.revokeObjectURL; else globalThis.URL.revokeObjectURL = prev.revokeObjectURL;
    })
    .then(() => fetched);
}

test('fetchImagesAsJpegDataUrls compresses fetched photos to JPEG data URLs, in order, capped', async () => {
  let fetched;
  const urls = ['https://p/1.jpg', 'https://p/2.jpg', 'https://p/3.jpg'];
  await withPageStubs({ okUrls: urls }, async () => {
    const out = await siteCommon.fetchImagesAsJpegDataUrls(urls, 2);
    assert.deepEqual(out, ['data:image/jpeg;base64,QUFB', 'data:image/jpeg;base64,QUFB'], 'cap=2 keeps the first two, order preserved');
  }).then((f) => { fetched = f; });
  assert.deepEqual(fetched, ['https://p/1.jpg', 'https://p/2.jpg'], 'only cap URLs are fetched');
});

test('fetchImagesAsJpegDataUrls drops failures individually and fail-opens the rest', async () => {
  const urls = ['https://p/dead.jpg', 'https://p/live.jpg'];
  await withPageStubs({ okUrls: ['https://p/live.jpg'] }, async () => {
    const out = await siteCommon.fetchImagesAsJpegDataUrls(urls, 4);
    assert.deepEqual(out, ['data:image/jpeg;base64,QUFB'], 'dead CDN entry dropped, live one survives');
  });
});

test('fetchImagesAsJpegDataUrls fail-opens when the page cannot encode (no canvas / image error)', async () => {
  await withPageStubs({ okUrls: ['https://p/1.jpg'], canvasOk: false }, async () => {
    assert.deepEqual(await siteCommon.fetchImagesAsJpegDataUrls(['https://p/1.jpg'], 4), [], 'getContext null → dropped');
  });
  await withPageStubs({ okUrls: ['https://p/1.jpg'], imageOk: false }, async () => {
    assert.deepEqual(await siteCommon.fetchImagesAsJpegDataUrls(['https://p/1.jpg'], 4), [], 'image onerror → dropped');
  });
  await withPageStubs({ okUrls: ['https://p/1.jpg'], dataUrl: '' }, async () => {
    assert.deepEqual(await siteCommon.fetchImagesAsJpegDataUrls(['https://p/1.jpg'], 4), [], 'toDataURL throw → dropped');
  });
});

test('fetchImagesAsJpegDataUrls returns [] outside a browser context', async () => {
  const prevImage = globalThis.Image;
  delete globalThis.Image;
  try {
    assert.deepEqual(await siteCommon.fetchImagesAsJpegDataUrls(['https://p/1.jpg'], 4), [], 'no Image → env guard');
  } finally {
    globalThis.Image = prevImage;
  }
  assert.deepEqual(await siteCommon.fetchImagesAsJpegDataUrls([], 4), [], 'empty input → []');
  assert.deepEqual(await siteCommon.fetchImagesAsJpegDataUrls('not-a-list', 4), [], 'non-list → []');
});
