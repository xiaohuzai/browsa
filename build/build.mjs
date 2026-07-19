#!/usr/bin/env node
// build/build.mjs — bundle third-party vendor libraries for the browsa
// extension. Outputs:
//   lib/vendor/{name}.iife.js   (for page-world eval via chrome.scripting)
//   lib/vendor/{name}.bundle.js (ESM for direct import from sidepanel.js)
//
// Source: lib/_src/ (for Readability, fetched from GitHub) OR
//         node_modules/ (for npm packages — turndown, marked, dompurify)
// We bundle to (a) minify, (b) convert UMD/ESM into a single shape we
// control, (c) get tree-shaking for free.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LIB = join(ROOT, 'lib');
const VENDOR = join(LIB, 'vendor');
const SRC = join(LIB, '_src');
const DEPS = join(__dirname, '_deps'); // gitignored, contains node_modules for build

await fs.mkdir(VENDOR, { recursive: true });
await fs.mkdir(SRC, { recursive: true });

// Vendors with their build format. `cjsToIife: true` produces
//   var X = (function() { ... return module.exports; })();
// that page-world eval can `(0, eval)('X')` to retrieve. `esmBundle: true`
// produces a single minified ESM file that sidepanel can `import` from.
const VENDORS = [
  {
    name: 'Readability',
    srcEntry:  'Readability.js',           // in lib/_src/
    srcDir:    SRC,
    cjsToIife: true,
    iifeName:  'Readability'
  },
  {
    name: 'Turndown',
    srcEntry:  'turndown/lib/turndown.cjs.js',  // in build/_deps/node_modules/
    srcDir:    join(DEPS, 'node_modules'),
    cjsToIife: true,
    iifeName:  'TurndownService',
    define:    { 'process.browser': 'true' }   // skip node-only paths
  },
  {
    name: 'TurndownPluginGfm',
    srcEntry:  'turndown-plugin-gfm/lib/turndown-plugin-gfm.cjs.js',  // in build/_deps/node_modules/
    srcDir:    join(DEPS, 'node_modules'),
    cjsToIife: true,
    iifeName:  'TurndownPluginGfm'
  },
  {
    name: 'marked',
    srcEntry:  'marked/lib/marked.cjs',
    srcDir:    join(DEPS, 'node_modules'),
    esmBundle: true,
    outName:   'marked'
  },
  {
    name: 'DOMPurify',
    srcEntry:  'dompurify/dist/purify.cjs.js',
    srcDir:    join(DEPS, 'node_modules'),
    esmBundle: true,
    outName:   'purify'
  },
  {
    name: 'mermaid',
    srcEntry:  'mermaid/dist/mermaid.esm.min.mjs',
    srcDir:    join(ROOT, 'node_modules'),
    esmBundle: true,
    outName:   'mermaid'
  },
  {
    name: 'highlight',
    srcEntry:  'highlight.js/lib/common.js',  // core + ~40 common languages
    srcDir:    join(ROOT, 'node_modules'),
    esmBundle: true,
    outName:   'highlight'
  },
  {
    name: 'katex',
    srcEntry:  'katex/dist/katex.mjs',
    srcDir:    join(ROOT, 'node_modules'),
    esmBundle: true,
    outName:   'katex'
  },
  {
    name: 'echarts',
    srcEntry:  'echarts/dist/echarts.esm.min.js',
    srcDir:    join(ROOT, 'node_modules'),
    esmBundle: true,
    outName:   'echarts'
  },
  {
    name: 'markmap-lib',
    srcEntry:  'markmap-lib/dist/index.mjs',
    srcDir:    join(ROOT, 'node_modules'),
    esmBundle: true,
    outName:   'markmap-lib'
  },
  {
    name: 'markmap-view',
    srcEntry:  'markmap-view/dist/index.js',
    srcDir:    join(ROOT, 'node_modules'),
    esmBundle: true,
    outName:   'markmap-view'
  },
  {
    // pdf.js spawns its own Worker at RUNTIME by URL (new Worker(workerSrc)),
    // not a static import esbuild can inline -- so pdf.mjs and pdf.worker.mjs
    // must be bundled as two independent entries, not merged into one file.
    name: 'pdf',
    srcEntry:  'build/pdf.mjs',
    srcDir:    join(ROOT, 'node_modules/pdfjs-dist'),
    esmBundle: true,
    outName:   'pdf'
  },
  {
    name: 'pdf-worker',
    srcEntry:  'build/pdf.worker.mjs',
    srcDir:    join(ROOT, 'node_modules/pdfjs-dist'),
    esmBundle: true,
    outName:   'pdf.worker'
  },
  {
    name: 'markstream-core',
    srcEntry:  'markstream-core/dist/index.js',
    srcDir:    join(DEPS, 'node_modules'),
    esmBundle: true,
    outName:   'markstream-core'
  },
  {
    name: 'stream-markdown-parser',
    srcEntry:  'stream-markdown-parser/dist/index.js',
    srcDir:    join(DEPS, 'node_modules'),
    esmBundle: true,
    outName:   'stream-markdown-parser'
  }
];

async function bundleAsCJS(vendor) {
  // First: bundle the full dep graph into a single CommonJS file (no var wrap)
  const cjsOut = join(SRC, vendor.name + '.cjs.js');
  const cfg = {
    entryPoints: [join(vendor.srcDir, vendor.srcEntry)],
    bundle: true,
    format: 'cjs',
    target: 'es2020',
    minify: false,
    outfile: cjsOut,
    logLevel: 'warning',
    platform: 'browser'
  };
  if (vendor.define) cfg.define = vendor.define;
  await build(cfg);
  // Then: wrap as IIFE capturing module.exports
  const cjs = await fs.readFile(cjsOut, 'utf8');
  const iifeOut = join(VENDOR, vendor.name + '.iife.js');
  const wrap =
    `var ${vendor.iifeName} = (function() {\n` +
    `  var module = { exports: {} };\n` +
    `  var exports = module.exports;\n` +
    cjs +
    `  return module.exports;\n` +
    `})();\n`;
  await fs.writeFile(iifeOut, wrap);
  await fs.unlink(cjsOut).catch(() => {});
  const size = (await fs.stat(iifeOut)).size;
  console.log(`  ✓ lib/vendor/${vendor.name}.iife.js (${size.toLocaleString()} bytes)`);
}

async function bundleAsESM(vendor) {
  const outName = vendor.outName || vendor.name.toLowerCase();
  const outFile = join(VENDOR, `${outName}.bundle.js`);
  await build({
    entryPoints: [join(vendor.srcDir, vendor.srcEntry)],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    minify: true,
    outfile: outFile,
    logLevel: 'warning',
    platform: 'browser'
  });
  const size = (await fs.stat(outFile)).size;
  console.log(`  ✓ lib/vendor/${outName}.bundle.js (${size.toLocaleString()} bytes)`);
}

console.log('browsa: building vendor bundles...');
for (const v of VENDORS) {
  const srcPath = join(v.srcDir, v.srcEntry);
  if (!existsSync(srcPath)) {
    console.log(`  ⚠ skipping ${v.name} (source not found: ${srcPath})`);
    continue;
  }
  if (v.cjsToIife) await bundleAsCJS(v);
  if (v.esmBundle) await bundleAsESM(v);
}
console.log('done.');
