// test/vendor-csp-audit.test.mjs — static CSP-surface audit over lib/vendor.
// MV3 extension pages run `script-src 'self' 'wasm-unsafe-eval'`: the Function
// constructor and eval are ILLEGAL there. Field report 2026-09-30: molstar's
// h264 module eagerly initializes through embind's eval-based class factories,
// and the whole bundle died on the real extension while every stub/jsdom test
// (and even a real-browser run on a plain-http dev-preview page) stayed green —
// none of those environments ENFORCE the extension CSP. This audit closes the
// cheapest gap: no vendor may GAIN an eval surface. Counts are pinned per file
// (documented exceptions below); a bump means a vendor upgrade or swap
// introduced code that will throw EvalError inside the extension — stop and
// either patch (see build.mjs patchMolstar/patchRdkit) or verify the site is
// unreachable and pin the new count here with a comment.
//
// Documented exceptions (do not raise without a comment):
// - RDKit_minimal.js = 1: __emval_get_method_caller's factory. Unreachable
//   from MinimalLib (pure embind, no emval method calls); createJsInvoker and
//   createNamedFunction are patched to non-eval in build.mjs.
// - echarts.bundle.js = 1: pre-existing single site, dormant on browsa's
//   chart paths (charts render in the real extension, field-verified).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'vendor');

// Strings whose presence creates an eval surface under MV3 CSP.
function countEvalSites(source) {
  return {
    newFunction: source.split('new Function').length - 1,
    bareEval: (source.match(/[^A-Za-z0-9_.]eval\(/g) || []).length,
  };
}

const PINNED = {
  'molstar.js': { newFunction: 0, bareEval: 0 },
  'RDKit_minimal.js': { newFunction: 1, bareEval: 0 },
  'echarts.bundle.js': { newFunction: 1, bareEval: 0 },
};

test('vendor CSP audit: no vendor exceeds its pinned eval surface', () => {
  const failures = [];
  for (const file of readdirSync(VENDOR).filter((f) => f.endsWith('.js'))) {
    const counts = countEvalSites(readFileSync(join(VENDOR, file), 'utf8'));
    const pin = PINNED[file] ?? { newFunction: 0, bareEval: 0 };
    for (const kind of ['newFunction', 'bareEval']) {
      if (counts[kind] > pin[kind]) {
        failures.push(`${file}: ${kind} ${counts[kind]} > pinned ${pin[kind]}`);
      }
    }
  }
  assert.deepEqual(failures, [], `eval surface grew beyond the CSP pins — this code will throw EvalError inside the extension (script-src 'self' 'wasm-unsafe-eval'):\n  ${failures.join('\n  ')}`);
});

test('vendor CSP audit: the pinned exceptions still exist (pins never silently stale)', () => {
  // If a pinned exception's site disappears (vendor upgrade rewrote it), the
  // pin must be re-derivated — this keeps the exception list honest.
  for (const [file, pin] of Object.entries(PINNED)) {
    const counts = countEvalSites(readFileSync(join(VENDOR, file), 'utf8'));
    assert.equal(counts.newFunction, pin.newFunction, `${file}: new Function count changed (${counts.newFunction} vs pinned ${pin.newFunction}) — re-derive the pin and update the exception comment`);
  }
});
