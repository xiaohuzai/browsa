// dev-preview/gen.mjs — generate standalone preview pages from the real
// sidepanel.html / options.html (rewrites asset paths one level up and
// injects the chrome shim). Rerun after editing the source HTML:
//   node dev-preview/gen.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const SEED_BLOCK = `
  <script src="seed.js"></script>
  <script src="chrome-shim.js"></script>`;

function makePreview(srcHtml, outName) {
  let html = String(srcHtml);
  // Point every root-relative asset back one directory level.
  html = html.replaceAll(/(src|href)="(?!https?:|\/\/|#|\.\.)([^"]+)"/g, (_, attr, path) => `${attr}="../${path}"`);
  // Enforce the REAL extension-page CSP on the preview (2026-09-30 lesson: a
  // plain-http preview allows eval, so molstar/RDKit passed "zero CSP
  // violations" there and died in the real extension). With this meta every
  // preview run renders under `script-src 'self' 'wasm-unsafe-eval'` — any
  // vendor eval surface now throws VISIBLY in the environment we actually
  // look at. Workers (katex/pdf/office) are same-origin files, still allowed
  // via script-src 'self'.
  html = html.replace(/<head>/i, `<head>\n  <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval'; object-src 'self'">`);
  html = html.replace('</head>', `${SEED_BLOCK}\n</head>`);
  return writeFile(join(here, outName), html);
}

await makePreview(await readFile(join(root, 'sidepanel.html'), 'utf8'), 'sidepanel.preview.html');
await makePreview(await readFile(join(root, 'options.html'), 'utf8'), 'options.preview.html');
console.log('preview pages regenerated');
