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
  },
  {
    // Graphviz compiled to WASM — the dist JS carries the .wasm base64-inlined
    // (single self-contained file, instantiates via WebAssembly.instantiate,
    // covered by the existing 'wasm-unsafe-eval' CSP). Model emits ```dot
    // (Graphviz DOT), render.js's renderDot renders it to SVG. Primary
    // architecture-diagram path since 2026-09-28, replacing the hand-rolled
    // ```nn renderer: a custom JSON spec has zero model training prior, while
    // DOT is what torchview/torchviz export — models know it cold.
    name: 'viz',
    srcEntry:  '@viz-js/viz/dist/viz.js',
    srcDir:    join(ROOT, 'node_modules'),
    esmBundle: true,
    outName:   'viz'
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

// Pre-built vendor artifacts that esbuild must not touch: a .wasm binary
// can't be bundled, and pdf-inspector-wasm's JS glue (wasm-bindgen --target
// web output) is already a clean, dependency-free ESM file. Copied as-is.
const RAW_COPIES = [
  {
    srcDir:  join(ROOT, 'node_modules/@firecrawl/pdf-inspector-wasm'),
    files:   ['pdf_inspector_wasm_bg.wasm', 'pdf_inspector_wasm.js']
  },
  {
    // Interactive 3D protein viewer (replaced 3Dmol.js, 2026-09-29, user call:
    // "业内都用 Mol*" — Mol* is what RCSB PDB / PDBe / AlphaFold DB embed, and
    // it natively ships the info layer 3Dmol lacked: hover residue tooltips,
    // sequence strip, pLDDT confidence coloring via the built-in
    // ma-quality-assessment extension). The model emits ```pdb and render.js's
    // renderPdb drives molstar.Viewer.create (WebGL). The dist is a prebuilt
    // IIFE assigning the `molstar` global — RAW copy + classic <script> load
    // in getMolstar(); molstar.css ships beside it and is injected as a <link>
    // by the same loader. Bundle contains NO worker spawns; its only wasm
    // (h264-mp4-encoder, base64-inlined) serves snapshot video export, which
    // browsa never invokes — dormant under the existing 'wasm-unsafe-eval' CSP.
    srcDir:  join(ROOT, 'node_modules/molstar/build/viewer'),
    files:   ['molstar.js', 'molstar.css']
  },
  {
    // Office-document → Markdown conversion (docx/pptx/xlsx/odt/rtf/epub/…):
    // docling.rs compiled to WASM — the /web target is dependency-free ESM
    // glue (wasm-bindgen, references only globalThis — verified: zero
    // document/window touches) plus the raw .wasm binary. Loaded by
    // lib/sidepanel/office-inspector.worker.js (type:'module' worker),
    // exactly like the pdf-inspector pair above; esbuild must NOT bundle
    // either file. convert() is sync/CPU-bound — Worker offload mirrors
    // katex/pdf precedents.
    srcDir:  join(ROOT, 'node_modules/docling.rs-wasm/web'),
    files:   ['docling_wasm_bg.wasm', 'docling_wasm.js']
  },
  {
    // Chemistry rendering engine (replaced smiles-drawer, 2026-09-29, user
    // call: adopt the industry heavyweight). RDKit is the pharma-standard
    // cheminformatics toolkit; the MinimalLib WASM build draws molecules AND
    // reactions (get_mol/get_rxn → get_svg, viewBox included), VALIDATES
    // model-emitted SMILES (get_mol returns null for chemically impossible
    // input — the anti-hallucination win smiles-drawer had no answer for) and
    // computes descriptors (MW/logP/TPSA/HBD/HBA property line). The glue is
    // an emscripten MODULARIZE script defining the global initRDKitModule —
    // RAW copy + classic <script> load in getRDKit(); the .wasm is fetched
    // relative to the script URL, so the pair must sit side by side. The
    // 7.3MB wasm is the biggest vendor, lazy-loaded only when a ```smiles
    // fence has been seen (fence-gated preload like pdf/molstar).
    srcDir:  join(ROOT, 'node_modules/@rdkit/rdkit/dist'),
    files:   ['RDKit_minimal.js', 'RDKit_minimal.wasm']
  }
];

// MV3 CSP patches (2026-09-30 field report): the extension page CSP
// (script-src 'self' 'wasm-unsafe-eval') blocks `new Function`. Emscripten
// embind glues evaluate invoker factories through the Function constructor, so
// both molstar.js and RDKit_minimal.js need non-eval equivalents. Regexes
// anchor on STABLE string literals / emscripten-source-level identifiers (not
// webpack-minified names) wherever possible, and every patch REFUSES the build
// loudly if its pattern stops matching after a vendor upgrade.
function patchMolstar(src) {
  // Site 1 — embind createNamedFunction (fires at h264 embind init): the
  // eval'd body is just `function NAME() { "use strict"; return
  // body.apply(this, arguments); }`; the computed property gives .name ===
  // NAME without eval.
  const before1 = (src.match(/new Function/g) || []).length;
  const re1 = /new Function\("body","return function "\+(\w+)\+`[^`]*`\)\((\w+)\)/g;
  src = src.replace(re1, (_m, nameVar, bodyVar) => `{[${nameVar}]:function(){return ${bodyVar}.apply(this,arguments)}}[${nameVar}]`);
  // Site 2 — dynCall wrapper factory (only exercised by snapshot VIDEO export,
  // never browsa; patched for defense).
  const re2 = /new Function\("dynCall","rawFunction",\w+\+`[^`]*`\)\((\w+),(\w+)\)/g;
  src = src.replace(re2, (_m, dynCallVar, rawFnVar) => `function(${dynCallVar},${rawFnVar}){return function(){return ${dynCallVar}(${rawFnVar},arguments)}}(${dynCallVar},${rawFnVar})`);
  if ((src.match(/new Function/g) || []).length !== 0 || before1 !== 2) {
    throw new Error(`molstar.js patch failed: expected 2 new Function sites, found ${before1}, left ${(src.match(/new Function/g) || []).length} — update patterns for the new molstar build`);
  }
  // Site 3 — embind craftInvokerFunction builds an invoker through
  // `new_(Function, [params..., body])` (Function.apply — an eval the two
  // regexes above can't see). It only fires while the h264 module's embind
  // classes register, and the h264 wrapper module initializes EAGERLY at
  // bundle evaluation (a webpack module does `i=req(m)()` right away). browsa
  // never invokes the h264 encoder (snapshot VIDEO export), so the ROOT fix is
  // making that module LAZY: no eager init → no embind registration → no
  // site-3 eval (and no data:-URL wasm fetch, which MV3 also blocks). The
  // module's only consumer is its `s` getter, which already awaits readiness.
  const eager = /let (\w+)=(\w+)\.n\((\w+)\)\(\)\(\),(\w+)=new Promise\((\w+)=>\{\1\.then\(\(\)=>\{\5\(\)\}\)\}\),/;
  const m3 = src.match(eager);
  if (!m3) throw new Error('molstar.js patch failed: eager h264 init pattern not found — update the lazy-init patch for the new molstar build');
  const [, h264Var, reqVar, modVar, readyVar] = m3;
  src = src.replace(eager, `let ${h264Var},${readyVar}=null,`);
  const yieldStmt = `yield ${readyVar};`;
  if ((src.split(yieldStmt).length - 1) !== 1) throw new Error(`molstar.js patch failed: expected exactly one "${yieldStmt}" in the h264 getter`);
  src = src.replace(yieldStmt, `if(!${h264Var}){${h264Var}=${reqVar}.n(${modVar})()}yield new Promise(${readyVar}=>{${h264Var}.then(()=>{${readyVar}()})});`);
  return src;
}

function patchRdkit(src) {
  // RDKit MUST run (```smiles), so its createJsInvoker gets a semantics-
  // preserving non-eval replacement: same wired-arg order (fn, [thisWired,]
  // argWired...), same arity check, both destructor strategies (stack vs
  // per-arg), same return conversion. argCount/needsDestructorStack/
  // isClassMethodFunc/returns are createJsInvoker's own closures; the
  // trailing ...wires are toArg0Wire..toArgNWire then per-arg destructors, in
  // exactly the order args1 pushes them. Verified in Node against the real
  // wasm chemistry API (test/lib-rdkit-render.test.mjs).
  const marker = 'return new Function(args1,invokerFnBody)';
  if ((src.split(marker).length - 1) !== 1) {
    throw new Error('RDKit_minimal.js patch failed: createJsInvoker eval site not found — update the patch for the new RDKit build');
  }
  return src.replace(marker, `return function(humanName,throwBindingError,invoker,fn,runDestructors,fromRetWire,toClassParamWire,...wires){
var toArgWireFns=wires.slice(0,argCount),dtorFns=needsDestructorStack?null:wires.slice(argCount);
return function(){
if(arguments.length!==argCount)throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+argCount+" args!");
var destructors=[],dtorStack=needsDestructorStack?destructors:null,wiredArgs=[];
if(isClassMethodFunc)wiredArgs.push(toClassParamWire(dtorStack,this));
for(var i=0;i<argCount;++i)wiredArgs.push(toArgWireFns[i](dtorStack,arguments[i]));
var rv=invoker.apply(null,[fn].concat(wiredArgs));
if(needsDestructorStack)runDestructors(destructors);
else for(var i=0;i<wiredArgs.length;++i){var d=dtorFns[i];if(d)d(wiredArgs[i]);}
if(returns){var ret=fromRetWire(rv);return ret}
}}`);
}

async function copyRaw({ srcDir, files }) {
  for (const file of files) {
    const srcPath = join(srcDir, file);
    if (!existsSync(srcPath)) {
      console.log(`  ⚠ skipping ${file} (source not found: ${srcPath})`);
      continue;
    }
    const outPath = join(VENDOR, file);
    if (file === 'molstar.js' || file === 'RDKit_minimal.js') {
      let src = await fs.readFile(srcPath, 'utf8');
      src = file === 'molstar.js' ? patchMolstar(src) : patchRdkit(src);
      await fs.writeFile(outPath, src);
      console.log(`  ✓ lib/vendor/${file} (${src.length.toLocaleString()} bytes, CSP-patched)`);
      continue;
    }
    await fs.copyFile(srcPath, outPath);
    const size = (await fs.stat(outPath)).size;
    console.log(`  ✓ lib/vendor/${file} (${size.toLocaleString()} bytes)`);
  }
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
for (const r of RAW_COPIES) await copyRaw(r);
console.log('done.');
