// test/youtube-streams.test.mjs
// Tests for readYouTubeStreams - extracts downloadable audio/video/muxed stream
// URLs from window.ytInitialPlayerResponse.streamingData.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readYouTubeStreams } = require(fileURLToPath(
  new URL('../lib/content-scripts/youtube-content-script.js', import.meta.url)
));

function withPlayer(playerResponse, fn) {
  const prev = globalThis.window;
  try {
    globalThis.window = playerResponse === null ? {} : { ytInitialPlayerResponse: playerResponse };
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
}

test('readYouTubeStreams: extracts muxed formats + adaptive audio/video', () => {
  const streams = withPlayer({
    streamingData: {
      formats: [
        { itag: 18, url: 'https://cdn/muxed.mp4', mimeType: 'video/mp4', qualityLabel: '360p', quality: 'small' }
      ],
      adaptiveFormats: [
        { itag: 140, url: 'https://cdn/audio.m4a', mimeType: 'audio/mp4', bitrate: 128000, audioQuality: 'AUDIO_QUALITY_LOW' },
        { itag: 137, url: 'https://cdn/video.mp4', mimeType: 'video/mp4', width: 1920, height: 1080, qualityLabel: '1080p' }
      ]
    }
  }, () => readYouTubeStreams());
  assert.equal(streams.length, 3);
  assert.equal(streams[0].type, 'muxed');
  assert.equal(streams[0].label, '360p');
  assert.equal(streams[0].hasAudio, true);
  assert.equal(streams[0].hasVideo, true);
  assert.equal(streams[1].type, 'audio');
  assert.equal(streams[1].label, 'low');
  assert.equal(streams[1].hasVideo, false);
  assert.equal(streams[2].type, 'video');
  assert.equal(streams[2].label, '1080p');
  assert.equal(streams[2].hasAudio, false);
});

test('readYouTubeStreams: skips signatureCipher-only streams (no url)', () => {
  const streams = withPlayer({
    streamingData: {
      formats: [
        { itag: 18, url: 'https://cdn/ok.mp4', mimeType: 'video/mp4', qualityLabel: '360p' },
        { itag: 22, signatureCipher: 'sig=...', mimeType: 'video/mp4', qualityLabel: '720p' }  // skipped
      ],
      adaptiveFormats: []
    }
  }, () => readYouTubeStreams());
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn/ok.mp4');
});

test('readYouTubeStreams: audio bitrate label fallback when no audioQuality', () => {
  const streams = withPlayer({
    streamingData: { formats: [], adaptiveFormats: [
      { url: 'https://cdn/a.m4a', mimeType: 'audio/mp4', bitrate: 160000 }
    ]}
  }, () => readYouTubeStreams());
  assert.equal(streams[0].label, '160 kbps');
});

test('readYouTubeStreams: video dimension label fallback when no qualityLabel', () => {
  const streams = withPlayer({
    streamingData: { formats: [], adaptiveFormats: [
      { url: 'https://cdn/v.mp4', mimeType: 'video/mp4', width: 1280, height: 720 }
    ]}
  }, () => readYouTubeStreams());
  assert.equal(streams[0].label, '1280x720');
});

test('readYouTubeStreams: empty when no streamingData', () => {
  assert.deepEqual(withPlayer({}, () => readYouTubeStreams()), []);
});

test('readYouTubeStreams: empty when no ytInitialPlayerResponse', () => {
  const prev = globalThis.window;
  try {
    globalThis.window = {};
    assert.deepEqual(readYouTubeStreams(), []);
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
});

test('readYouTubeStreams: never throws on garbage input', () => {
  const prev = globalThis.window;
  try {
    globalThis.window = { ytInitialPlayerResponse: 'garbage' };
    assert.deepEqual(readYouTubeStreams(), []);
    globalThis.window = { ytInitialPlayerResponse: { streamingData: 'wrong' } };
    assert.deepEqual(readYouTubeStreams(), []);
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
});
