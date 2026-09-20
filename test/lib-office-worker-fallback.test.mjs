// test/lib-office-worker-fallback.test.mjs — contract test for
// lib/sidepanel/office-extractor.js's failure paths: when the Worker can't
// be constructed (no Worker global / construction throws — the case in this
// Node test env, and the browser case where worker-src or the glue import
// fails), convertOfficeViaWorker must resolve null (not throw) and
// extractOfficeContent must throw a plain Error (attach-orchestrator's
// fail-open to the placeholder depends on that shape).
//
// Separate FILE, not a separate test() in a shared file: the module-level
// `worker`/`workerFailed` singletons persist across test cases within one
// process — only a separate file gets a fresh singleton (same pdf
// worker-client gotcha).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome mock — only runtime.getURL is touched (ensureWorker).
Object.defineProperty(globalThis, 'chrome', {
  value: { runtime: { getURL: (p) => 'chrome-extension://fake/' + p } },
  writable: true,
  configurable: true,
});
// No `Worker` global defined → `new Worker(...)` throws ReferenceError inside
// ensureWorker's try/catch → sticky workerFailed → null results forever.

const { convertOfficeViaWorker, extractOfficeContent } = await import('../lib/sidepanel/office-extractor.js');

test('convertOfficeViaWorker resolves null when the worker cannot start', async () => {
  const res = await convertOfficeViaWorker(new Uint8Array([1, 2, 3]), 'x.docx');
  assert.equal(res, null);
});

test('extractOfficeContent throws a plain Error on null worker result (fail-open contract)', async () => {
  await assert.rejects(
    extractOfficeContent('aGk=', 'x.docx'),
    /office conversion unavailable/
  );
});
