// test/bilibili-streams.test.mjs
// Tests for readBilibiliMediaStreams - extracts downloadable audio/video/muxed
// stream URLs from window.__playinfo__. Used by the ASR pending-context builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readBilibiliMediaStreams } = require(fileURLToPath(
  new URL('../lib/content-scripts/bilibili-content-script.js', import.meta.url)
));

function withPlayinfo(playinfoData, fn) {
  const prev = globalThis.window;
  try {
    globalThis.window = playinfoData === null ? {} : { __playinfo__: { data: playinfoData } };
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
}

test('readBilibiliMediaStreams: extracts dash audio + video, audio hasAudio true, video false', () => {
  const streams = withPlayinfo({
    dash: {
      audio: [
        { bandwidth: 192000, base_url: 'https://cdn/audio192.m4s' },
        { bandwidth: 320000, baseUrl: 'https://cdn/audio320.m4s' },
      ],
      video: [
        { width: 1920, height: 1080, bandwidth: 2000000, base_url: 'https://cdn/v1080.m4s' },
      ],
    }
  }, () => readBilibiliMediaStreams());
  assert.equal(streams.length, 3);
  // audio first
  assert.equal(streams[0].type, 'audio');
  assert.equal(streams[0].label, '192 kbps');
  assert.equal(streams[0].url, 'https://cdn/audio192.m4s');
  assert.equal(streams[0].hasAudio, true);
  // baseUrl fallback for the second audio
  assert.equal(streams[1].url, 'https://cdn/audio320.m4s');
  assert.equal(streams[1].label, '320 kbps');
  // dash video has no audio track
  assert.equal(streams[2].type, 'video');
  assert.equal(streams[2].label, '1920x1080');
  assert.equal(streams[2].hasAudio, false);
});

test('readBilibiliMediaStreams: extracts durl as muxed (hasAudio true)', () => {
  const streams = withPlayinfo({
    durl: [{ url: 'https://cdn/muxed.mp4', size: 12345 }]
  }, () => readBilibiliMediaStreams());
  assert.equal(streams.length, 1);
  assert.equal(streams[0].type, 'muxed');
  assert.equal(streams[0].url, 'https://cdn/muxed.mp4');
  assert.equal(streams[0].hasAudio, true);
});

test('readBilibiliMediaStreams: dash + durl both present -> all listed', () => {
  const streams = withPlayinfo({
    dash: { audio: [{ bandwidth: 96000, base_url: 'https://cdn/a.m4s' }] },
    durl: [{ url: 'https://cdn/muxed.mp4' }]
  }, () => readBilibiliMediaStreams());
  assert.equal(streams.length, 2);
  assert.ok(streams.some(s => s.type === 'audio'));
  assert.ok(streams.some(s => s.type === 'muxed'));
});

test('readBilibiliMediaStreams: empty array when no __playinfo__', () => {
  const prev = globalThis.window;
  try {
    globalThis.window = {};
    assert.deepEqual(readBilibiliMediaStreams(), []);
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
});

test('readBilibiliMediaStreams: returns [] when __playinfo__ has no .data', () => {
  const prev = globalThis.window;
  try {
    globalThis.window = { __playinfo__: {} };
    assert.deepEqual(readBilibiliMediaStreams(), []);
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
});

test('readBilibiliMediaStreams: skips entries without a url', () => {
  const streams = withPlayinfo({
    dash: {
      audio: [
        { bandwidth: 192000 },  // no url - skipped
        { bandwidth: 320000, base_url: 'https://cdn/ok.m4s' },
      ],
      video: [{ width: 1280, height: 720 }],  // no url - skipped
    }
  }, () => readBilibiliMediaStreams());
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn/ok.m4s');
});

test('readBilibiliMediaStreams: video label falls back to id when no dimensions', () => {
  const streams = withPlayinfo({
    dash: { video: [{ id: 80, bandwidth: 500000, base_url: 'https://cdn/v.m4s' }] }
  }, () => readBilibiliMediaStreams());
  assert.equal(streams[0].label, 'video 80');
  assert.equal(streams[0].hasAudio, false);
});

test('readBilibiliMediaStreams: never throws on garbage input', () => {
  const prev = globalThis.window;
  try {
    globalThis.window = { __playinfo__: 'not an object' };
    assert.deepEqual(readBilibiliMediaStreams(), []);
    globalThis.window = { __playinfo__: { data: 'wrong' } };
    assert.deepEqual(readBilibiliMediaStreams(), []);
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
});
