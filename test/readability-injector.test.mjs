// test/readability-injector.test.mjs — regression tests for the page-world
// library injection in lib/readability-injector.js.
//
// Why this exists: a real attach bug on pi.dev — reader mode errored in the
// real browser and auto mode silently fell through to the DOM-tree dump.
// Root cause: ensureReadabilityInjected's injected func did
//   window.Readability = rGlobal.Readability || rGlobal.default;
// but the vendored Readability.iife.js exports the constructor DIRECTLY
// (`module.exports = Readability`, no `.Readability`/`.default` wrapper), so
// both properties were undefined and the assignment CLOBBERED the correctly
// eval'd constructor with undefined. extractInPageWorld then saw
// `typeof Readability === 'undefined'` and returned an error.
//
// The pre-existing jsdom tests never caught this because they load the bundle
// into a vm context and read `ctx.Readability` directly — bypassing the
// `window.X = <resolution>` line where the clobbering happens. These tests
// replicate the EXACT injected-func resolution chain (var → eval-global →
// window.X assignment) against the REAL vendored bundles in a vm context that
// mirrors a browser MAIN world (window === global object), and assert that the
// resolved `window.X` is a constructor after injection — the property
// extractInPageWorld actually checks.
//
// node:vm is the same facility the rest of the suite uses to run the MAIN-world
// bundles; nothing here touches a real browser or filesystem beyond reading the
// vendored bundles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Mirrors a page MAIN world: window === the global object, so `var X = ...`
// at indirect-eval scope creates window.X exactly as in a real browser.
function makeMainWorldContext() {
  const sandbox = { console };
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

/**
 * Replicate ensureReadabilityInjected's injected func for one bundle:
 *   (0, eval)(src);                      // var X lands on the global object
 *   window.X = <assignmentExpr>;         // the resolution line under test
 * Returns { beforeAssignment, afterAssignment } = typeof of the global.
 */
function runInjection(src, globalName, assignmentExpr) {
  const ctx = makeMainWorldContext();
  vm.runInContext(`(0, eval)(${JSON.stringify(src)});`, ctx);
  const beforeAssignment = vm.runInContext(`typeof ${globalName}`, ctx);
  vm.runInContext(`window.${globalName} = ${assignmentExpr};`, ctx);
  const afterAssignment = vm.runInContext(`typeof ${globalName}`, ctx);
  return { beforeAssignment, afterAssignment };
}

const READABILITY_RESOLUTION =
  `(0, eval)('Readability').Readability || (0, eval)('Readability').default || (0, eval)('Readability')`;
const TURNDOWN_RESOLUTION =
  `(0, eval)('TurndownService').TurndownService || (0, eval)('TurndownService').default || (0, eval)('TurndownService')`;
const GFM_RESOLUTION =
  `(0, eval)('TurndownPluginGfm')`;

test('Readability bundle resolves to a constructor after the injection assignment (regression: window.Readability was clobbered to undefined, breaking reader mode)', async () => {
  const src = await readFile(join(ROOT, 'lib/vendor/Readability.iife.js'), 'utf8');
  const { beforeAssignment, afterAssignment } = runInjection(src, 'Readability', READABILITY_RESOLUTION);
  assert.equal(beforeAssignment, 'function', 'eval must define the global Readability constructor');
  assert.equal(afterAssignment, 'function',
    'window.Readability must be a function AFTER the resolution assignment — the bundle exports the constructor directly, ' +
    'so the `.Readability || .default` chain alone resolves to undefined and clobbers it');
});

test('Turndown bundle resolves to a constructor after the injection assignment', async () => {
  const src = await readFile(join(ROOT, 'lib/vendor/Turndown.iife.js'), 'utf8');
  const { afterAssignment } = runInjection(src, 'TurndownService', TURNDOWN_RESOLUTION);
  assert.equal(afterAssignment, 'function', 'window.TurndownService must be a function after assignment');
});

test('the old (buggy) Readability resolution without the bare-constructor fallback clobbers window.Readability to undefined', async () => {
  const src = await readFile(join(ROOT, 'lib/vendor/Readability.iife.js'), 'utf8');
  // The pre-fix expression: rGlobal.Readability || rGlobal.default (no || rGlobal).
  const { afterAssignment } = runInjection(src, 'Readability',
    `(0, eval)('Readability').Readability || (0, eval)('Readability').default`);
  assert.equal(afterAssignment, 'undefined',
    'the buggy resolution must be demonstrated: without the || rGlobal fallback the assignment yields undefined');
});

test('extractInPageWorld sees a function Readability when the injection resolution is applied (end-to-end guard)', async () => {
  // Load the vendored bundles into a MAIN-world-like context, then run the
  // full extraction pipeline (as runGenericExtraction would) and assert it
  // does NOT return the "not loaded" error. This guards the whole chain:
  // injection resolution → typeof check in extractInPageWorld.
  const src = await readFile(join(ROOT, 'lib/page-extractor.js'), 'utf8');
  const rSrc = await readFile(join(ROOT, 'lib/vendor/Readability.iife.js'), 'utf8');
  const tSrc = await readFile(join(ROOT, 'lib/vendor/Turndown.iife.js'), 'utf8');
  const gfmSrc = await readFile(join(ROOT, 'lib/vendor/TurndownPluginGfm.iife.js'), 'utf8');

  // Extract extractInPageWorld's body via the same brace-matching the suite uses.
  const m = src.match(new RegExp(`function extractInPageWorld\\s*\\([^)]*\\)`));
  const headerEnd = m.index + m[0].length;
  let i = headerEnd;
  while (i < src.length && /\s/.test(src[i])) i++;
  const start = m.index;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fnBody = src.slice(start, i + 1);

  // A minimal article-like document so Readability can extract something.
  const { JSDOM } = await import('jsdom');
  const jsdom = new JSDOM(`<!doctype html><html><body>
    <main><h1>Title</h1><p>${'A long enough paragraph of real content. '.repeat(40)}</p></main>
  </body></html>`, { url: 'https://example.com/' });
  const win = jsdom.window;
  // jsdom has no layout engine; production's CSS-hidden check uses
  // (offsetWidth===0 && offsetHeight===0), which jsdom always reports as 0 --
  // mock non-zero so content isn't marked hidden (same as the suite does).
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 20 });

  const ctx = vm.createContext({
    document: win.document, window: win, Node: win.Node, NodeFilter: win.NodeFilter,
    DOMParser: win.DOMParser, console
  });
  // Apply the injection resolution exactly as ensureReadabilityInjected does.
  vm.runInContext(`(0, eval)(${JSON.stringify(rSrc)});`, ctx);
  vm.runInContext(`window.Readability = (0, eval)('Readability').Readability || (0, eval)('Readability').default || (0, eval)('Readability');`, ctx);
  vm.runInContext(`(0, eval)(${JSON.stringify(tSrc)});`, ctx);
  vm.runInContext(`window.TurndownService = (0, eval)('TurndownService').TurndownService || (0, eval)('TurndownService').default || (0, eval)('TurndownService');`, ctx);
  vm.runInContext(`(0, eval)(${JSON.stringify(gfmSrc)});`, ctx);
  vm.runInContext(`window.TurndownPluginGfm = (0, eval)('TurndownPluginGfm');`, ctx);

  const res = vm.runInContext(`${fnBody}\nextractInPageWorld({ mode: 'reader', htmlCap: 100000 });`, ctx);
  assert.ok(!res.error, `reader must not return a "not loaded" error after correct injection, got: ${res.error}`);
  assert.ok((res.text || '').length >= 100, 'reader must produce real markdown text');
  assert.match(res.text, /Title/, 'reader output should contain the article heading');
});
