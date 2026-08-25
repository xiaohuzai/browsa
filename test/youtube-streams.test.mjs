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

test('fetchFreshYouTubeStreams: POSTs /youtubei/v1/player (ANDROID) and returns fresh audio streams + videoDurationSec', async () => {
  const { fetchFreshYouTubeStreams } = require(fileURLToPath(
    new URL('../lib/content-scripts/youtube-content-script.js', import.meta.url)
  ));
  const calls = [];
  const prevFetch = globalThis.fetch;
  const prevWin = globalThis.window;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        videoDetails: { videoId: 'abc', lengthSeconds: '420' },
        streamingData: {
          adaptiveFormats: [
            { itag: 140, url: 'https://rr.googlevideo.com/videoplayback?pot=aa', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, audioQuality: 'AUDIO_QUALITY_MEDIUM' },
            { itag: 139, url: 'https://rr.googlevideo.com/videoplayback?pot=bb', mimeType: 'audio/webm; codecs="opus"', bitrate: 50000 },
            { itag: 137, url: 'https://rr.googlevideo.com/videoplayback?pot=cc', mimeType: 'video/mp4; codecs="avc1"', bitrate: 3000000 }, // non-audio → skipped
            { itag: 251, signatureCipher: 's=...', mimeType: 'audio/webm' } // no url → skipped
          ]
        }
      })
    };
  };
  globalThis.window = {
    ytcfg: {
      get: (k) => k === 'INNERTUBE_API_KEY' ? 'AIza-test' : (k === 'INNERTUBE_CONTEXT' ? { client: { hl: 'en' } } : undefined),
      data_: {},
    }
  };
  try {
    const res = await fetchFreshYouTubeStreams('abc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/youtubei/v1/player?key=AIza-test');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'include');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.videoId, 'abc');
    assert.equal(body.context.client.clientName, 'ANDROID');
    assert.equal(body.context.client.clientVersion, '20.10.38');
    assert.equal(body.context.client.hl, 'en');
    assert.equal(res.videoDurationSec, 420, 'must return the video true length for truncated-stream detection');
    assert.equal(res.streams.length, 2, 'only audio adaptive formats with a bare url are returned');
    assert.equal(res.streams[0].url, 'https://rr.googlevideo.com/videoplayback?pot=aa');
    assert.equal(res.streams[0].codecs, 'mp4a.40.2');
    assert.equal(res.streams[0].id, 140);
    assert.equal(res.streams[1].codecs, 'opus');
    assert.equal(res.streams[1].bandwidth, 50000);
  } finally {
    if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
});

test('fetchFreshYouTubeStreams: non-ok player response / no streamingData -> empty streams, still returns lengthSeconds', async () => {
  const { fetchFreshYouTubeStreams } = require(fileURLToPath(
    new URL('../lib/content-scripts/youtube-content-script.js', import.meta.url)
  ));
  const prevFetch = globalThis.fetch;
  const prevWin = globalThis.window;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ videoDetails: { lengthSeconds: '300' } }) });
  globalThis.window = { ytcfg: { get: () => undefined, data_: {} } };
  try {
    const res = await fetchFreshYouTubeStreams('abc');
    assert.equal(res.streams.length, 0);
    assert.equal(res.videoDurationSec, 300);
  } finally {
    if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
  const prevFetch2 = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    const res = await fetchFreshYouTubeStreams('abc');
    assert.equal(res.streams.length, 0);
    assert.equal(res.videoDurationSec, 0);
  } finally {
    if (prevFetch2 === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch2;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
});

test('fetchFreshYouTubeStreams: never throws on missing ytcfg / fetch failure / no videoId', async () => {
  const { fetchFreshYouTubeStreams } = require(fileURLToPath(
    new URL('../lib/content-scripts/youtube-content-script.js', import.meta.url)
  ));
  const prevFetch = globalThis.fetch;
  const prevWin = globalThis.window;
  globalThis.fetch = async () => { throw new Error('network down'); };
  globalThis.window = {};
  try {
    assert.deepEqual(await fetchFreshYouTubeStreams('abc'), { streams: [], videoDurationSec: 0 });
    assert.deepEqual(await fetchFreshYouTubeStreams(''), { streams: [], videoDurationSec: 0 });
  } finally {
    if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
});

test('readPlayerAudioStreams: extracts pot-bearing audio URLs from the real player response', () => {
  const { readPlayerAudioStreams } = require(fileURLToPath(
    new URL('../lib/content-scripts/youtube-content-script.js', import.meta.url)
  ));
  const streams = readPlayerAudioStreams({
    streamingData: {
      adaptiveFormats: [
        { itag: 140, url: 'https://rr.googlevideo.com/videoplayback?pot=realpot&sig=x', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, audioQuality: 'AUDIO_QUALITY_MEDIUM' },
        { itag: 251, url: 'https://rr.googlevideo.com/videoplayback?pot=realpot2', mimeType: 'audio/webm; codecs="opus"', bitrate: 90000 },
        { itag: 137, url: 'https://rr.googlevideo.com/videoplayback?pot=vid', mimeType: 'video/mp4; codecs="avc1"', bitrate: 3000000 }, // non-audio → skipped
        { itag: 251, signatureCipher: 's=...', mimeType: 'audio/webm' } // no url → skipped
      ]
    }
  });
  assert.equal(streams.length, 2, 'only audio adaptive formats with a bare url are returned');
  assert.equal(streams[0].url, 'https://rr.googlevideo.com/videoplayback?pot=realpot&sig=x');
  assert.equal(streams[0].hasPot, true, 'must flag the pot in the URL');
  assert.equal(streams[0].codecs, 'mp4a.40.2');
  assert.equal(streams[0].id, 140);
  assert.equal(streams[1].hasPot, true);
});

test('readPlayerAudioStreams: hasPot false for pot-less URLs, empty for garbage input', () => {
  const { readPlayerAudioStreams } = require(fileURLToPath(
    new URL('../lib/content-scripts/youtube-content-script.js', import.meta.url)
  ));
  const streams = readPlayerAudioStreams({
    streamingData: {
      adaptiveFormats: [
        { itag: 140, url: 'https://rr.googlevideo.com/videoplayback?c=ANDROID&sig=x', mimeType: 'audio/mp4' } // no pot
      ]
    }
  });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].hasPot, false, 'ANDROID-style pot-less URLs must NOT be flagged as pot');
  assert.deepEqual(readPlayerAudioStreams(null), []);
  assert.deepEqual(readPlayerAudioStreams({}), []);
  assert.deepEqual(readPlayerAudioStreams({ streamingData: {} }), []);
});
