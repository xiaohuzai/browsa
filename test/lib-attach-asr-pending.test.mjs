// test/lib-attach-asr-pending.test.mjs — pure tests for pickAsrStreams(), the
// stream-selection rule extracted from buildAsrPendingCtx (ub-mode 体检 #8c).
// The selection tiers are the safety-critical part of the ASR handoff: a
// truncated stream used to produce 20 minutes of subtitles for a 100+ minute
// video (real user bug), and the lowest-bitrate stream is often HE-AAC which
// decodeAudioData rejects. Both rules now live in one pure function and are
// pinned here without any chrome.* / executeScript machinery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAsrStreams } from '../lib/handlers/attach-asr-pending.js';

const audio = (over = {}) => ({ type: 'audio', url: over.url || 'https://cdn/a', label: 'audio', bandwidth: over.bw || 0, duration: over.dur || 0, size: 0, codecs: over.codecs || '', id: over.id || 0 });

test('pickAsrStreams: codec priority beats raw bitrate — AAC-LC wins over lower-bandwidth HE-AAC', () => {
  const got = {
    videoDurationSec: 600,
    streams: [
      audio({ bw: 60_000, dur: 598, codecs: 'mp4a.40.5', url: 'https://cdn/he-aac' }), // HE-AAC, lowest bandwidth
      audio({ bw: 120_000, dur: 599, codecs: 'mp4a.40.2', url: 'https://cdn/aac-lc' }),
    ],
  };
  const { audio: picked, candidateAudios } = pickAsrStreams(got);
  assert.equal(picked.url, 'https://cdn/aac-lc', 'AAC-LC (mp4a.40.2) decodes reliably; HE-AAC is last resort');
  assert.equal(candidateAudios[0].url, 'https://cdn/aac-lc');
  assert.equal(candidateAudios[1].url, 'https://cdn/he-aac');
});

test('pickAsrStreams: a truncated stream is EXCLUDED while any better tier exists (tiers are exclusive, not a merge)', () => {
  const got = {
    videoDurationSec: 600, // floor = 540s
    streams: [
      audio({ bw: 30_000, dur: 300, codecs: 'mp4a.40.2', url: 'https://cdn/truncated' }), // 20min of a 100min video
      audio({ bw: 90_000, dur: 0, codecs: 'mp4a.40.2', url: 'https://cdn/unknown' }),     // metadata missing
    ],
  };
  const { audio: picked, candidateAudios } = pickAsrStreams(got);
  assert.equal(picked.url, 'https://cdn/unknown', 'unknown-duration tier outranks the truncated one');
  assert.deepEqual(candidateAudios.map((c) => c.url), ['https://cdn/unknown'],
    'ordered takes the WINNING TIER only — the truncated stream is not demoted into the tail');
});

test('pickAsrStreams: with no full/unknown streams the fallback tier hands over everything (截断流仍可重试)', () => {
  const got = {
    videoDurationSec: 600,
    streams: [
      audio({ bw: 30_000, dur: 300, codecs: 'mp4a.40.2', url: 'https://cdn/truncated' }),
      audio({ bw: 60_000, dur: 290, codecs: 'mp4a.40.5', url: 'https://cdn/truncated-he' }),
    ],
  };
  const { candidateAudios } = pickAsrStreams(got);
  assert.deepEqual(candidateAudios.map((c) => c.url), ['https://cdn/truncated', 'https://cdn/truncated-he'],
    '退回全部 tier: codec priority orders the survivors (AAC-LC first) — sidepanel 可换下一候选重试');
});

test('pickAsrStreams: full-length streams win outright even at higher bandwidth', () => {
  const got = {
    videoDurationSec: 600,
    streams: [
      audio({ bw: 64_000, dur: 300, codecs: 'mp4a.40.2', url: 'https://cdn/short' }),
      audio({ bw: 128_000, dur: 599, codecs: 'mp4a.40.2', url: 'https://cdn/full' }),
    ],
  };
  const { audio: picked } = pickAsrStreams(got);
  assert.equal(picked.url, 'https://cdn/full', '完整长度的流优先——截断流绝不因码率低被选中');
});

test('pickAsrStreams: SSR duration missing → DASH stream duration is the reference (resolveVideoDurationSec)', () => {
  const got = {
    videoDurationSec: 0,
    streams: [
      audio({ bw: 64_000, dur: 300, codecs: 'mp4a.40.2', url: 'https://cdn/short' }),
      audio({ bw: 128_000, dur: 1000, codecs: 'mp4a.40.2', url: 'https://cdn/full' }),
    ],
  };
  const { videoDurationSec, audio: picked } = pickAsrStreams(got);
  assert.equal(videoDurationSec, 1000, 'duration reference falls back to the longest stream');
  assert.equal(picked.url, 'https://cdn/full');
});

test('pickAsrStreams: video-only candidates sort bandwidth-desc with a normalized shape; muxed rides along', () => {
  const got = {
    videoDurationSec: 600,
    streams: [
      { type: 'video', url: 'https://cdn/v-lo', bandwidth: 500_000, duration: 600, size: 1, width: 854, height: 480, id: 2 },
      { type: 'video', url: 'https://cdn/v-hi', bandwidth: 2_000_000, duration: 600, size: 4, width: 1920, height: 1080, id: 1 },
      { type: 'muxed', url: 'https://cdn/dash-mp4', label: 'mp4', bandwidth: 1_200_000, duration: 600, size: 3 },
      audio({ bw: 64_000, dur: 599, codecs: 'mp4a.40.2' }),
    ],
  };
  const { videoCandidates, muxedStream } = pickAsrStreams(got);
  assert.deepEqual(videoCandidates.map((v) => v.url), ['https://cdn/v-hi', 'https://cdn/v-lo'], 'video candidates are bandwidth-descending');
  assert.equal(videoCandidates[0].height, 1080);
  assert.equal(muxedStream.url, 'https://cdn/dash-mp4');
  assert.equal(muxedStream.label, 'mp4');
});

test('pickAsrStreams: no usable audio → audio null, empty candidates; no muxed → null', () => {
  const out = pickAsrStreams({ videoDurationSec: 600, streams: [{ type: 'video', url: 'https://cdn/v', bandwidth: 1 }] });
  assert.equal(out.audio, null);
  assert.deepEqual(out.candidateAudios, []);
  assert.equal(out.muxedStream, null);
  // missing streams entirely must not throw
  const empty = pickAsrStreams({});
  assert.equal(empty.audio, null);
  assert.deepEqual(empty.videoCandidates, []);
});
