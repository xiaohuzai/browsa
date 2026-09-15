import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../docs/', import.meta.url));
const origin = 'https://xiaohuzai.github.io';

for (const [relative, language, canonical] of [
  ['index.html', 'zh-CN', `${origin}/browsa/`],
  ['en/index.html', 'en', `${origin}/browsa/en/`],
]) {
  test(`homepage structure and local links: ${language}`, () => {
    const file = resolve(root, relative);
    const dom = new JSDOM(readFileSync(file, 'utf8'));
    const document = dom.window.document;
    try {
      assert.equal(document.documentElement.lang, language);
      assert.equal(document.querySelectorAll('h1').length, 1);
      assert.equal(document.querySelector('link[rel="canonical"]').href, canonical);
      assert.equal(document.querySelector('meta[property="og:url"]').content, canonical);
      assert.equal(document.querySelector('link[hreflang="zh-CN"]').href, `${origin}/browsa/`);
      assert.equal(document.querySelector('link[hreflang="en"]').href, `${origin}/browsa/en/`);
      assert.equal(document.querySelectorAll('link[href*="fonts.googleapis.com"]').length, 0);
      const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
      assert.equal(new Set(ids).size, ids.length, 'IDs must be unique');
      assert.equal(document.querySelectorAll('.scn-tabs input:checked').length, 1);
      assert.equal(document.querySelector('.scn-tabs input:checked').id, 'scn-article');
      for (const scene of ['article', 'video', 'pdf']) {
        assert.ok(document.querySelector(`#scn-${scene}`).closest('label'));
        assert.ok(document.querySelector(`.window.w-${scene}`));
      }
      assert.equal(document.querySelectorAll('.install-option').length, 2);
      assert.ok(document.querySelector('.install-option.recommended a[href*="chromewebstore.google.com"]'));
      assert.ok(document.querySelector('.install-option a[href*="github.com"]'));
      assert.ok(document.querySelector('.install-next a[href="guide/quickstart.html"]'));
      for (const element of document.querySelectorAll('[href], [src]')) {
        const value = element.getAttribute('href') ?? element.getAttribute('src');
        if (/^(?:[a-z]+:|\/\/)/i.test(value)) continue;
        const [pathname, fragment] = value.split('#');
        let target = pathname ? resolve(dirname(file), pathname.split('?')[0]) : file;
        assert.ok(existsSync(target), `Missing local target: ${value}`);
        if (statSync(target).isDirectory()) target = resolve(target, 'index.html');
        assert.ok(existsSync(target), `Missing directory index: ${value}`);
        if (fragment && extname(target) === '.html') {
          const linked = target === file ? dom : new JSDOM(readFileSync(target, 'utf8'));
          try {
            assert.ok(linked.window.document.getElementById(decodeURIComponent(fragment)), `Missing anchor: ${value}`);
          } finally {
            if (linked !== dom) linked.window.close();
          }
        }
      }
    } finally {
      dom.window.close();
    }
  });
}
