// test/attach-asr-closure.test.mjs — regression guard for the YouTube ASR
// executeScript closure bug (countImages lesson).
//
// chrome.scripting.executeScript serializes the injected `func` via
// Function.prototype.toString() and re-evaluates it in the page realm — closure
// variables from the service worker are NOT available. The original YouTube ASR
// implementation captured `videoId` from the background closure inside the
// injected func, so in a REAL browser the page got `undefined` videoId, the
// fresh /player fetch returned no streams, and buildAsrPendingCtx silently fell
// through to the normal store path (user-visible bug: "优先 ASR 解析字幕" ignored,
// built-in transcript used).
//
// The string-matching mocks in attach-asr.test.mjs never execute the func, so
// they can't catch this class of bug. This file re-evaluates the ACTUAL injected
// func source (extracted from background.js) in a fresh `vm` context with ONLY a
// fake window — exactly what real Chrome does — and asserts the func is
// self-contained (parses videoId from window.location, no closure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Extract every injected `func: async () => { ... }` block that contains
// `__browsaFetchFreshYouTubeStreams` from background.js source, balancing
// braces. There are two: the ASR_FRESH_URLS self-heal path and the
// buildAsrPendingCtx attach path.
async function extractYouTubeInjectFuncs() {
  const src = await readFile(join(ROOT, 'background.js'), 'utf8');
  const marker = 'window.__browsaFetchFreshYouTubeStreams';
  const out = [];
  let searchFrom = 0;
  for (;;) {
    const idx = src.indexOf(marker, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + marker.length;
    const headerStart = src.lastIndexOf('func: async () =>', idx);
    assert.ok(headerStart > 0, `must find a func: async () => before marker at ${idx}`);
    const openBrace = src.indexOf('{', headerStart);
    let depth = 0;
    let i = openBrace;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.equal(depth, 0, 'func braces must balance');
    out.push({ body: src.slice(openBrace, i + 1), offset: headerStart });
  }
  assert.ok(out.length === 2, `must find exactly 2 __browsaFetchFreshYouTubeStreams funcs, found ${out.length}`);
  return out;
}

function runInFreshVm(funcSrc, fakeWindow) {
  // Re-evaluate in a fresh vm context with ONLY a fake window — no closure, no
  // test-file globals. This mirrors chrome.scripting.executeScript exactly.
  const ctx = vm.createContext({ window: fakeWindow, URLSearchParams, URL, console });
  return vm.runInContext(`(async () => ${funcSrc})`, ctx);
}

test('YouTube ASR injected funcs are self-contained — parse videoId from window.location, no closure dependency', async () => {
  const funcs = await extractYouTubeInjectFuncs();
  for (const { body } of funcs) {
    const fakeWindow = {
      location: { search: '?v=abc123XYZ' },
      __browsaFetchFreshYouTubeStreams: async (videoId) => {
        if (videoId !== 'abc123XYZ') return { streams: [], videoDurationSec: 0 };
        return {
          streams: [{ type: 'audio', url: 'https://rr.googlevideo.com/videoplayback?pot=aa', bandwidth: 128000, codecs: 'mp4a.40.2' }],
          videoDurationSec: 300,
        };
      },
    };
    const fn = runInFreshVm(body, fakeWindow);
    const res = await fn();
    // Both funcs must have called the fresh fetcher with the parsed videoId and
    // surfaced the streams. buildAsrPendingCtx returns { streams, videoDurationSec };
    // ASR_FRESH_URLS wraps in { ok: true, streams }. Accept either.
    const streams = res?.streams || res?.data?.streams;
    assert.ok(Array.isArray(streams), `func at offset ${body.length} must return streams (got ${JSON.stringify(res)})`);
    assert.equal(streams.length, 1, 'must get streams when window.location has the videoId');
    assert.equal(streams[0].url, 'https://rr.googlevideo.com/videoplayback?pot=aa');
  }
});

test('YouTube ASR injected funcs surface a clear error when window.location has no videoId', async () => {
  const funcs = await extractYouTubeInjectFuncs();
  for (const { body } of funcs) {
    const fakeWindow = {
      location: { search: '' }, // no v= param
      __browsaFetchFreshYouTubeStreams: async () => { throw new Error('should not be called'); },
    };
    const fn = runInFreshVm(body, fakeWindow);
    const res = await fn();
    // buildAsrPendingCtx returns { streams, asrExpiredError }; ASR_FRESH_URLS
    // returns { ok: false, error }. Accept either error signal.
    const err = res?.asrExpiredError || res?.error;
    assert.ok(err, `func must surface a clear error (got ${JSON.stringify(res)})`);
    assert.match(String(err), /videoId/i);
  }
});

test('the injected funcs must NOT reference a closure variable videoId (the countImages trap)', async () => {
  const funcs = await extractYouTubeInjectFuncs();
  for (const { body } of funcs) {
    assert.match(body, /window\.location\.search/, 'func must parse videoId from window.location');
    assert.match(body, /const vid =/, 'func must bind the parsed id to a local (not a closure var)');
    assert.doesNotMatch(body, /fn\(videoId\)|!videoId\b/, 'func must not reference a closure videoId');
  }
});

test('YouTube ASR injected func prefers captured pot audio streams over the ANDROID fetch', async () => {
  const funcs = await extractYouTubeInjectFuncs();
  // Both the buildAsrPendingCtx func (returns {streams}) and the ASR_FRESH_URLS
  // func (returns {ok, streams}) must prefer __browsaGetPlayerAudioStreams output.
  for (const { body } of funcs) {
    let freshCalled = false;
    const fakeWindow = {
      location: { search: '?v=abc123XYZ' },
      // Captured pot-bearing streams (from the real player response).
      __browsaGetPlayerAudioStreams: () => [
        { type: 'audio', url: 'https://rr.googlevideo.com/videoplayback?pot=CAPTURED', bandwidth: 128000, hasPot: true, codecs: 'mp4a.40.2', id: 140 },
        { type: 'audio', url: 'https://rr.googlevideo.com/videoplayback?pot=CAPTURED2', bandwidth: 70000, hasPot: true, codecs: 'opus', id: 251 },
      ],
      __browsaFetchFreshYouTubeStreams: async () => {
        freshCalled = true; // must NOT be called when pot capture exists
        return { streams: [{ type: 'audio', url: 'https://rr.googlevideo.com/videoplayback?c=ANDROID&sig=x' }], videoDurationSec: 300 };
      },
    };
    const ctx = vm.createContext({ window: fakeWindow, URLSearchParams, URL, console });
    const fn = vm.runInContext(`(async () => ${body})`, ctx);
    const res = await fn();
    const streams = res?.streams || res?.data?.streams;
    assert.ok(Array.isArray(streams), 'must return streams');
    assert.ok(streams.length > 0, 'must get the captured pot streams');
    assert.equal(streams[0].url, 'https://rr.googlevideo.com/videoplayback?pot=CAPTURED', 'must prefer the captured pot stream');
    assert.equal(freshCalled, false, 'must NOT fall back to the pot-less ANDROID fetch when pot capture exists');
  }
});

test('YouTube ASR injected func falls back to the ANDROID fetch when no pot capture exists', async () => {
  const funcs = await extractYouTubeInjectFuncs();
  for (const { body } of funcs) {
    const fakeWindow = {
      location: { search: '?v=abc123XYZ' },
      __browsaGetPlayerAudioStreams: () => [], // no pot capture
      __browsaFetchFreshYouTubeStreams: async () => ({
        streams: [{ type: 'audio', url: 'https://rr.googlevideo.com/videoplayback?c=ANDROID&sig=x', codecs: 'mp4a.40.2', id: 140 }],
        videoDurationSec: 300,
      }),
    };
    const ctx = vm.createContext({ window: fakeWindow, URLSearchParams, URL, console });
    const fn = vm.runInContext(`(async () => ${body})`, ctx);
    const res = await fn();
    const streams = res?.streams || res?.data?.streams;
    assert.ok(Array.isArray(streams) && streams.length > 0, 'must fall back to the ANDROID fetch result');
    assert.match(streams[0].url, /c=ANDROID/, 'fallback is the ANDROID pot-less fetch');
  }
});
