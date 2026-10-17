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

// ─── Seven-language parity (2026-10-17) ─────────────────────────────────────
// The root page and /en/ used to declare only their own two hreflang links
// while the five translated pages declared all seven — search engines ignore
// a non-reciprocal hreflang cluster.
const LANGS = [
  ['index.html', 'zh-CN', `${origin}/browsa/`],
  ['en/index.html', 'en', `${origin}/browsa/en/`],
  ['ja/index.html', 'ja', `${origin}/browsa/ja/`],
  ['ko/index.html', 'ko', `${origin}/browsa/ko/`],
  ['es/index.html', 'es', `${origin}/browsa/es/`],
  ['pt-br/index.html', 'pt-BR', `${origin}/browsa/pt-br/`],
  ['ru/index.html', 'ru', `${origin}/browsa/ru/`],
];

const EXPECTED_HREFLANG = {
  'zh-CN': `${origin}/browsa/`,
  en: `${origin}/browsa/en/`,
  ja: `${origin}/browsa/ja/`,
  ko: `${origin}/browsa/ko/`,
  es: `${origin}/browsa/es/`,
  'pt-BR': `${origin}/browsa/pt-br/`,
  ru: `${origin}/browsa/ru/`,
};

for (const [relative, language, canonical] of LANGS) {
  test(`hreflang cluster is reciprocal and complete: ${language}`, () => {
    const dom = new JSDOM(readFileSync(resolve(root, relative), 'utf8'));
    const document = dom.window.document;
    try {
      assert.equal(document.documentElement.lang, language);
      assert.equal(document.querySelector('link[rel="canonical"]').href, canonical);
      const declared = new Map(
        [...document.querySelectorAll('link[rel="alternate"][hreflang]')]
          .map((el) => [el.getAttribute('hreflang'), el.getAttribute('href')])
      );
      for (const [lang, href] of Object.entries(EXPECTED_HREFLANG)) {
        assert.equal(declared.get(lang), href, `hreflang="${lang}" must point at ${href}`);
      }
      assert.equal(declared.get('x-default'), `${origin}/browsa/`, 'an x-default entry must exist');
      assert.equal(document.querySelectorAll('h1').length, 1, 'exactly one <h1> per landing page');
      for (const element of document.querySelectorAll('[href], [src]')) {
        const value = element.getAttribute('href') ?? element.getAttribute('src');
        if (/^(?:[a-z]+:|\/\/|#)/i.test(value)) continue;
        const [pathname, fragment] = value.split('#');
        let target = pathname ? resolve(root, relative, '..', pathname.split('?')[0]) : resolve(root, relative);
        assert.ok(existsSync(target), `Missing local target: ${value}`);
        if (statSync(target).isDirectory()) target = resolve(target, 'index.html');
        assert.ok(existsSync(target), `Missing directory index: ${value}`);
        if (fragment && extname(target) === '.html') {
          assert.ok(new JSDOM(readFileSync(target, 'utf8')).window.document.getElementById(decodeURIComponent(fragment)),
            `Missing anchor: ${value}`);
        }
      }
    } finally {
      dom.window.close();
    }
  });
}

// ─── Site asset hygiene (2026-10-17) ────────────────────────────────────────
// docs/assets had grown to 295MB because unreferenced media accumulated
// silently (the promo masters alone were ~120MB). Nothing caught it, so this
// makes an unreferenced site asset a red build.
test('every file under docs/assets is referenced somewhere', async () => {
  const { readdirSync } = await import('node:fs');
  const { join, basename } = await import('node:path');
  const assetsRoot = resolve(root, 'assets');

  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  })(assetsRoot);

  const corpus = [];
  const repoRoot = resolve(root, '..');
  for (const name of readdirSync(repoRoot)) {
    if (/^README.*\.md$/.test(name) || name === 'AGENTS.md') corpus.push(readFileSync(join(repoRoot, name), 'utf8'));
  }
  (function collectDocs(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === 'assets') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collectDocs(full);
      else if (/\.(html|md)$/.test(entry)) corpus.push(readFileSync(full, 'utf8'));
    }
  })(root);
  const haystack = corpus.join('\n');

  const orphans = files.map((f) => basename(f)).filter((name) => !haystack.includes(name));
  assert.deepEqual(orphans, [],
    `unreferenced files under docs/assets waste the Pages upload and repo size: ${orphans.join(', ')}`);
});

// ─── README seven-language structural parity (2026-10-17) ───────────────────
// README.{ja,ko,es,pt-BR,ru} are AI first-pass snapshots that lag by design,
// but structural drift (a dropped section, an unclosed table row, a mangled
// language switcher) is not "lag" — it silently breaks the page. en/zh stay
// per-PR authoritative; this only guards the five snapshots' shape.
const README_LOCALES = ['README.md', 'README.en.md', 'README.ja.md', 'README.ko.md', 'README.es.md', 'README.pt-BR.md', 'README.ru.md'];

test('all seven READMEs carry the same section count and a language switcher', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const repoRoot = resolve(root, '..');
  const shapes = README_LOCALES.map((name) => {
    const text = readFileSync(join(repoRoot, name), 'utf8');
    return {
      name,
      h2: (text.match(/^## /gm) || []).length,
      tables: (text.match(/^\|/gm) || []).length,
      // The switcher is an <a>/<strong> line near the top; each file bolds its
      // OWN language. Match the link structure rather than one language.
      switching: /README\.(en|ja|ko|es|pt-BR|ru)\.md/.test(text) && /<strong>/.test(text),
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  });
  const base = shapes[0];
  for (const s of shapes.slice(1)) {
    assert.equal(s.h2, base.h2, `${s.name}: ${s.h2} sections vs ${base.h2} in ${base.name}`);
  }
  for (const s of shapes) {
    assert.ok(s.switching, `${s.name} lost its language switcher line`);
    assert.ok(s.bytes > 20_000, `${s.name} looks truncated (${s.bytes} bytes)`);
  }
});
