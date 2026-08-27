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
  html = html.replace('</head>', `${SEED_BLOCK}\n</head>`);
  return writeFile(join(here, outName), html);
}

await makePreview(await readFile(join(root, 'sidepanel.html'), 'utf8'), 'sidepanel.preview.html');
await makePreview(await readFile(join(root, 'options.html'), 'utf8'), 'options.preview.html');
console.log('preview pages regenerated');
