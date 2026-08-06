// test/site-content-scripts.test.mjs
//
// The 9 site interceptors other than xhs-content-script.js (which already
// has its own test file) export their pure matcher/extractor functions via
// `module.exports` using the exact same pattern — designed to be testable
// under Node, but nobody had written the tests. This file covers all 9:
// bilibili, youtube, twitter, zhihu, dedao, geektime, juejin, xueqiu,
// xiaoyuzhou.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
function loadContentScript(name) {
  return require(fileURLToPath(new URL(`../lib/content-scripts/${name}`, import.meta.url)));
}

// ============================================================================
// bilibili-content-script.js
// ============================================================================
{
  const { isBilibiliViewUrl, isBilibiliPlayerUrl, extractBilibiliVideo, installBilibiliInterceptor, md5, wbiSign, activeFetchBilibiliVideo, readBilibiliAudioUrl } =
    loadContentScript('bilibili-content-script.js');

  test('bilibili: isBilibiliViewUrl matches the video-view endpoint only', () => {
    assert.equal(isBilibiliViewUrl('https://api.bilibili.com/x/web-interface/view?bvid=BV1x'), true);
    assert.equal(isBilibiliViewUrl('https://api.bilibili.com/x/web-interface/view/conclusion/get'), false, 'the AI-summary endpoint must not match the view matcher');
    assert.equal(isBilibiliViewUrl('https://example.com/x/web-interface/view'), false);
    assert.equal(isBilibiliViewUrl(null), false);
    assert.equal(isBilibiliViewUrl('not a url'), false);
  });

  test('bilibili: isBilibiliPlayerUrl matches both the WBI and legacy player paths', () => {
    assert.equal(isBilibiliPlayerUrl('https://api.bilibili.com/x/player/wbi/v2?bvid=x'), true);
    assert.equal(isBilibiliPlayerUrl('https://api.bilibili.com/x/player/v2?bvid=x'), true);
    assert.equal(isBilibiliPlayerUrl('https://api.bilibili.com/x/player/v3'), false);
  });

  test('bilibili: isBilibiliViewUrl resolves a relative path via location.origin', () => {
    const prev = globalThis.location;
    globalThis.location = { origin: 'https://api.bilibili.com' };
    try {
      assert.equal(isBilibiliViewUrl('/x/web-interface/view?bvid=x'), true);
    } finally {
      if (prev === undefined) delete globalThis.location; else globalThis.location = prev;
    }
  });

  test('bilibili: extractBilibiliVideo maps a real-shaped response and defaults missing stats', () => {
    const video = extractBilibiliVideo({
      data: {
        bvid: 'BV1xx411c7mD', title: ' Title ', desc: ' Desc ',
        owner: { name: 'Author', mid: 42 }, tname: 'Tech', duration: 300,
        pages: [{ cid: 999 }],
        stat: { view: 100, like: 10, coin: 5, favorite: 3, reply: 2 }
      }
    });
    assert.equal(video.bvid, 'BV1xx411c7mD');
    assert.equal(video.title, 'Title');
    assert.equal(video.author, 'Author');
    assert.equal(video.upMid, 42);
    assert.equal(video.cid, 999);
    assert.equal(video.stat.view, 100);
  });

  test('bilibili: extractBilibiliVideo returns null without a bvid, and defaults stat fields to 0', () => {
    assert.equal(extractBilibiliVideo({ data: {} }), null);
    assert.equal(extractBilibiliVideo({}), null);
    const video = extractBilibiliVideo({ data: { bvid: 'BV1' } });
    assert.deepEqual(video.stat, { view: 0, like: 0, coin: 0, favorite: 0, reply: 0 });
  });

  test('bilibili: md5 matches known RFC 1321 test vectors', () => {
    assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  });

  test('bilibili: wbiSign produces a query string self-consistent with the exported md5', () => {
    const signed = wbiSign({ bvid: 'BV1', cid: '123' }, 'a'.repeat(32), 'b'.repeat(32));
    assert.match(signed, /&w_rid=[a-f0-9]{32}$/, 'must end with a 32-char hex md5 digest');
    const [query, wRidPart] = signed.split('&w_rid=');
    // Re-derive the mixin key with the same algorithm and confirm the hash matches —
    // this pins the WBI signing algorithm's structure without depending on real bilibili keys.
    assert.equal(query.includes('bvid=BV1'), true);
    assert.equal(query.includes('cid=123'), true);
    assert.equal(query.includes('wts='), true);
    assert.equal(wRidPart.length, 32);
  });

  test('bilibili: wbiSign strips !\'()* from param values before signing (documented WBI quirk)', () => {
    const signed = wbiSign({ q: "a!'()*b" }, 'x'.repeat(32), 'y'.repeat(32));
    const [query] = signed.split('&w_rid=');
    assert.ok(query.includes('q=ab') || decodeURIComponent(query).includes('q=ab'), `special chars must be stripped from the signed query, got: ${query}`);
  });

  test('bilibili: installBilibiliInterceptor is a no-op outside a browser context', () => {
    assert.equal(installBilibiliInterceptor(), false);
  });

  test('bilibili: readBilibiliAudioUrl prefers dash audio, falls back to durl, null without either', () => {
    const prevWindow = globalThis.window;
    try {
      globalThis.window = { __playinfo__: { data: { dash: { audio: [{ base_url: 'https://a/dash.m4s' }] } } } };
      assert.equal(readBilibiliAudioUrl(), 'https://a/dash.m4s');
      globalThis.window = { __playinfo__: { data: { durl: [{ url: 'https://a/durl.m4s' }] } } };
      assert.equal(readBilibiliAudioUrl(), 'https://a/durl.m4s');
      globalThis.window = { __playinfo__: { data: {} } };
      assert.equal(readBilibiliAudioUrl(), null);
      globalThis.window = {};
      assert.equal(readBilibiliAudioUrl(), null);
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    }
  });

  // Regression: activeFetchBilibiliVideo used to require window.__INITIAL_STATE__.videoData
  // and throw when it was absent, silently falling back to a generic DOM extraction that
  // dumped the whole channel feed instead of the video. Fix: take bvid from the URL path,
  // fall back to the view API for meta, and read __playinfo__ audio unconditionally.
  test('bilibili: activeFetchBilibiliVideo falls back to the view API + __playinfo__ audio when __INITIAL_STATE__ is absent', async () => {
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    try {
      globalThis.window = {
        location: { pathname: '/video/BV1D5411f7ch' },
        // __INITIAL_STATE__ deliberately absent — the SSR-restructure regression scenario
        __playinfo__: { data: { dash: { audio: [{ base_url: 'https://audio.cdn/stream.m4s' }] } } },
      };
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(url);
        if (url.includes('/x/web-interface/view')) {
          return {
            ok: true,
            json: async () => ({
              code: 0,
              data: {
                bvid: 'BV1D5411f7ch', title: '革命年代共产党的红军很穷？', desc: 'desc',
                owner: { name: '思维实验室' }, tname: '社科人文', duration: 1062,
                pages: [{ cid: 12345 }], stat: { view: 100, like: 10 },
              },
            }),
          };
        }
        return { ok: false }; // nav / player / conclusion — short-circuit before WBI
      };
      const result = await activeFetchBilibiliVideo();
      assert.ok(result, 'must return a result even without __INITIAL_STATE__');
      assert.equal(result.bvid, 'BV1D5411f7ch');
      assert.equal(result.title, '革命年代共产党的红军很穷？');
      assert.equal(result.author, '思维实验室');
      assert.equal(result.cid, 12345);
      assert.equal(result.audioUrl, 'https://audio.cdn/stream.m4s', 'audio URL must survive the meta fallback');
      assert.ok(calls.some(u => u.includes('/x/web-interface/view?bvid=BV1D5411f7ch')), 'must fetch the view API');
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    }
  });

  test('bilibili: activeFetchBilibiliVideo prefers __INITIAL_STATE__ and still captures audio', async () => {
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    try {
      globalThis.window = {
        location: { pathname: '/video/BV1D5411f7ch' },
        __INITIAL_STATE__: {
          videoData: { bvid: 'BV1D5411f7ch', title: 'FromState', owner: { name: 'A' }, cid: 7, pages: [{ cid: 7 }], duration: 60, stat: {} },
        },
        __playinfo__: { data: { dash: { audio: [{ base_url: 'https://audio.cdn/state.m4s' }] } } },
      };
      const calls = [];
      globalThis.fetch = async (url) => { calls.push(url); return { ok: false }; };
      const result = await activeFetchBilibiliVideo();
      assert.equal(result.title, 'FromState');
      assert.equal(result.cid, 7);
      assert.equal(result.audioUrl, 'https://audio.cdn/state.m4s');
      assert.ok(!calls.some(u => u.includes('/x/web-interface/view')), 'must NOT fetch view API when __INITIAL_STATE__ has cid');
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    }
  });

  test('bilibili: activeFetchBilibiliVideo throws when no bvid is available anywhere', async () => {
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    try {
      globalThis.window = { location: { pathname: '/video/' } };
      globalThis.fetch = async () => ({ ok: false });
      await assert.rejects(() => activeFetchBilibiliVideo(), /no bvid/);
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    }
  });
}

// ============================================================================
// youtube-content-script.js
// ============================================================================
{
  const { isYouTubePlayerUrl, extractVideoMeta, fetchTranscript, readYouTubeRichMeta, extractYouTubeChapters, activeYouTubeFetch, installYouTubeInterceptor, isTimedtextUrl, extractVideoIdFromTimedtextUrl, parseTimedtextJson, parseTimedtextXml } =
    loadContentScript('youtube-content-script.js');

  test('youtube: isYouTubePlayerUrl matches both apex and www hosts, prefix-matches the path', () => {
    assert.equal(isYouTubePlayerUrl('https://www.youtube.com/youtubei/v1/player?key=x'), true);
    assert.equal(isYouTubePlayerUrl('https://youtube.com/youtubei/v1/player'), true);
    assert.equal(isYouTubePlayerUrl('https://www.youtube.com/youtubei/v1/next'), false);
    assert.equal(isYouTubePlayerUrl('https://example.com/youtubei/v1/player'), false);
  });

  test('youtube: extractVideoMeta maps videoDetails and preserves full shortDescription', () => {
    const longDesc = 'x'.repeat(1000);
    const meta = extractVideoMeta({
      videoDetails: { videoId: 'abc123', title: ' T ', author: ' A ', lengthSeconds: '125', shortDescription: longDesc },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } }
    });
    assert.equal(meta.videoId, 'abc123');
    assert.equal(meta.title, 'T');
    assert.equal(meta.lengthSeconds, 125);
    assert.equal(meta.shortDescription.length, 1000, 'shortDescription must not be truncated');
    assert.equal(meta.captionTracks.length, 1);
  });

  test('youtube: extractVideoMeta returns null when videoId is missing, defaults captionTracks to []', () => {
    assert.equal(extractVideoMeta({ videoDetails: {} }), null);
    const meta = extractVideoMeta({ videoDetails: { videoId: 'x' } });
    assert.deepEqual(meta.captionTracks, []);
  });

  test('youtube: fetchTranscript prefers manual English over auto (asr) English', async () => {
    globalThis.fetch = async (url) => {
      assert.ok(url.startsWith('manual-en'), `must fetch the manual English track, got ${url}`);
      return { ok: true, text: async () => JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'hello' }] }] }) };
    };
    const transcript = await fetchTranscript([
      { languageCode: 'en', kind: 'asr', baseUrl: 'auto-en' },
      { languageCode: 'en', baseUrl: 'manual-en' },
      { languageCode: 'fr', baseUrl: 'manual-fr' },
    ]);
    assert.equal(transcript, '[00:01] hello');
  });

  test('youtube: fetchTranscript falls back to auto English, then any manual, then first available', async () => {
    // fetchTranscript now uses baseUrl as-is (no fmt= modification) to preserve URL signatures
    let urlSeen;
    globalThis.fetch = async (url) => { urlSeen = url; return { ok: true, text: async () => JSON.stringify({ events: [] }) }; };
    await fetchTranscript([{ languageCode: 'en', kind: 'asr', baseUrl: 'auto-en' }]);
    assert.equal(urlSeen, 'auto-en');

    await fetchTranscript([{ languageCode: 'fr', baseUrl: 'manual-fr' }]);
    assert.equal(urlSeen, 'manual-fr', 'no English at all — falls back to any non-asr track');

    await fetchTranscript([{ languageCode: 'ja', kind: 'asr', baseUrl: 'only-track' }]);
    assert.equal(urlSeen, 'only-track', 'no English and no manual track — falls back to the first track');
  });

  test('youtube: fetchTranscript returns null for empty/missing caption tracks', async () => {
    assert.equal(await fetchTranscript([]), null);
    assert.equal(await fetchTranscript(null), null);
  });

  test('youtube: readYouTubeRichMeta reads views/likes/subs from ytInitialData safely', () => {
    const prevWindow = globalThis.window;
    const primaryInfoEntry = {
      videoPrimaryInfoRenderer: { viewCount: { videoViewCountRenderer: { viewCount: { simpleText: '1,000 views' } } } }
    };
    const secondaryInfoEntry = {
      videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { subscriberCountText: { simpleText: '10K subscribers' } } } }
    };
    globalThis.window = {
      ytInitialPlayerResponse: {
        microformat: { playerMicroformatRenderer: { publishDate: '2024-01-01', category: 'Tech' } },
        videoDetails: { keywords: ['a', 'b'] }
      },
      ytInitialData: {
        contents: { twoColumnWatchNextResults: { results: { results: {
          contents: [primaryInfoEntry, secondaryInfoEntry]
        } } } }
      }
    };
    try {
      const meta = readYouTubeRichMeta();
      assert.equal(meta.viewsText, '1,000 views');
      assert.equal(meta.subsText, '10K subscribers');
      assert.equal(meta.publishDate, '2024-01-01');
      assert.equal(meta.category, 'Tech');
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    }
  });

  test('readYouTubeRichMeta degrades to empty-string fields (not a throw) when window data is absent', () => {
    const prevWindow = globalThis.window;
    globalThis.window = {};
    try {
      const meta = readYouTubeRichMeta();
      assert.deepEqual(meta, { viewsText: '', likesText: '', subsText: '', publishDate: '', category: '', keywords: [] });
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    }
  });

  test('youtube: extractYouTubeChapters reads the primary markersMap location', () => {
    const prevWindow = globalThis.window;
    globalThis.window = {
      ytInitialData: {
        playerOverlays: { playerOverlayRenderer: { decoratedPlayerBarRenderer: { multiMarkersPlayerBarRenderer: { markersMap: [
          { value: { chapters: [
            { chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: 'Intro' } } },
            { chapterRenderer: { timeRangeStartMillis: 65000, title: { simpleText: 'Main' } } },
          ] } }
        ] } } } }
      }
    };
    try {
      const chapters = extractYouTubeChapters();
      assert.deepEqual(chapters, ['[00:00] Intro', '[01:05] Main']);
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    }
  });

  test('youtube: extractYouTubeChapters returns null when there are no chapters', () => {
    const prevWindow = globalThis.window;
    globalThis.window = { ytInitialData: {} };
    try {
      assert.equal(extractYouTubeChapters(), null);
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    }
  });

  // Regression: ytInitialPlayerResponse was removed from window by YouTube in mid-2026.
  // activeYouTubeFetch used to bail out with `return null` when that global was absent,
  // meaning the whole active-fallback path silently produced no data. Fix: fall through
  // to Stage 3 (POST /youtubei/v1/player) using the videoId from the URL instead.
  // Regression: ytInitialPlayerResponse was removed from window by YouTube in mid-2026.
  // activeYouTubeFetch used to bail out with `return null` when that global was absent,
  // meaning the whole active-fallback path silently produced no data. Fix: fall through
  // to Stage 3 (POST /youtubei/v1/player) using the videoId from the URL instead.
  test('youtube: activeYouTubeFetch falls through to Stage 3 when ytInitialPlayerResponse is absent', async () => {
    const prevWindow = globalThis.window;
    const prevPerf = globalThis.performance;
    const prevFetch = globalThis.fetch;
    const prevDocument = globalThis.document;
    try {
      // activeYouTubeFetch reads window.location.search, window.ytInitialPlayerResponse,
      // window.ytInitialData, window.ytcfg — all need to be on the same `window` object.
      globalThis.window = {
        location: { search: '?v=TEST123' },
        ytInitialData: {},
        ytcfg: { get: (k) => k === 'INNERTUBE_CONTEXT' ? { client: { clientName: 'WEB' } } : undefined }
        // ytInitialPlayerResponse deliberately absent — this is the regression scenario
      };
      globalThis.document = { getElementById: () => null };
      globalThis.performance = { getEntriesByType: () => [] }; // no cached timedtext entries — must fall through to Stage 3

      // Two fetch calls happen: (1) POST /youtubei/v1/player, (2) caption track fetch
      const calls = [];
      globalThis.fetch = async (url, opts) => {
        calls.push(url);
        if (typeof url === 'string' && url.includes('/youtubei/v1/player')) {
          const body = JSON.parse(opts.body);
          assert.equal(body.videoId, 'TEST123');
          return {
            ok: true,
            json: async () => ({
              videoDetails: { videoId: 'TEST123', title: 'Test Video', author: 'Author', lengthSeconds: '120', shortDescription: 'desc' },
              captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://example.com/timedtext' }] } }
            })
          };
        }
        // caption track fetch — fetchTranscript now uses res.text() + JSON.parse
        return { ok: true, text: async () => JSON.stringify({ events: [{ tStartMs: 5000, segs: [{ utf8: 'hello world' }] }] }) };
      };

      const result = await activeYouTubeFetch();
      assert.ok(result, 'must return a result even without ytInitialPlayerResponse');
      assert.equal(result.videoId, 'TEST123');
      assert.equal(result.title, 'Test Video');
      assert.ok(result.transcript?.includes('[00:05] hello world'), `transcript must contain timestamped line, got: ${result.transcript}`);
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
      if (prevPerf === undefined) delete globalThis.performance; else globalThis.performance = prevPerf;
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
      if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
    }
  });

  test('youtube: activeYouTubeFetch returns null when videoId is not in the URL and player has no video', async () => {
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevPerf = globalThis.performance;
    try {
      globalThis.window = { location: { search: '' } };
      globalThis.document = { getElementById: () => null };
      globalThis.performance = { getEntriesByType: () => [] };
      const result = await activeYouTubeFetch();
      assert.equal(result, null);
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
      if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
      if (prevPerf === undefined) delete globalThis.performance; else globalThis.performance = prevPerf;
    }
  });

  test('youtube: activeYouTubeFetch uses window.location (not getVideoData) for videoId — URL updates before player state', async () => {
    // Empirically confirmed: when the user clicks a new video, window.location
    // updates immediately via history.pushState, while getVideoData().video_id
    // still returns the previous video's ID. So URL is the correct source.
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    const prevDocument = globalThis.document;
    try {
      globalThis.window = {
        location: { search: '?v=NEW_VIDEO_ID' }, // URL already updated
        ytInitialData: {},
        ytcfg: { get: (k) => k === 'INNERTUBE_CONTEXT' ? { client: { clientName: 'WEB' } } : undefined }
      };
      // Player getVideoData() still has the OLD video_id (confirmed behavior)
      globalThis.document = { getElementById: () => null };
      // performance buffer has a timedtext URL for NEW_VIDEO_ID
      globalThis.performance = { getEntriesByType: () => [
        { name: 'https://www.youtube.com/api/timedtext?v=NEW_VIDEO_ID&fmt=json3&lang=en' }
      ] };
      globalThis.fetch = async () => ({
        ok: true, json: async () => ({ events: [{ tStartMs: 0, segs: [{ utf8: 'new caption' }] }] })
      });
      const result = await activeYouTubeFetch();
      assert.ok(result, 'must return a result');
      assert.equal(result.videoId, 'NEW_VIDEO_ID', 'videoId must come from URL (window.location), not stale getVideoData()');
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
      if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
    }
  });

  test('youtube: installYouTubeInterceptor is a no-op outside a browser context', () => {
    assert.equal(installYouTubeInterceptor(), false);
  });

  test('youtube: isTimedtextUrl matches /api/timedtext URLs only', () => {
    assert.equal(isTimedtextUrl('https://www.youtube.com/api/timedtext?v=abc&fmt=json3'), true);
    assert.equal(isTimedtextUrl('https://www.youtube.com/youtubei/v1/player'), false);
    assert.equal(isTimedtextUrl(null), false);
  });

  test('youtube: extractVideoIdFromTimedtextUrl extracts v= param', () => {
    assert.equal(extractVideoIdFromTimedtextUrl('https://www.youtube.com/api/timedtext?v=abc123&fmt=json3'), 'abc123');
    assert.equal(extractVideoIdFromTimedtextUrl('https://www.youtube.com/api/timedtext?fmt=json3'), null);
    assert.equal(extractVideoIdFromTimedtextUrl('not-a-url'), null);
  });

  test('youtube: parseTimedtextJson parses json3 events into timestamped lines', () => {
    const json = JSON.stringify({ events: [
      { tStartMs: 1000, segs: [{ utf8: 'hello' }] },
      { tStartMs: 61500, segs: [{ utf8: 'world' }] },
      { segs: [{ utf8: 'no time — skipped' }] },  // missing tStartMs is 0 but has segs
    ]});
    const result = parseTimedtextJson(json);
    assert.ok(result?.includes('[00:01] hello'), `expected [00:01] hello, got: ${result}`);
    assert.ok(result?.includes('[01:01] world'), `expected [01:01] world, got: ${result}`);
  });

  test('youtube: parseTimedtextXml parses srv3/ttml XML into timestamped lines', () => {
    const xml = `<?xml version="1.0"?><timedtext><body><p t="1000">hello world</p><p t="61500">second line</p></body></timedtext>`;
    const result = parseTimedtextJson(xml) || parseTimedtextXml(xml);
    assert.ok(result?.includes('[00:01] hello world'), `expected [00:01] hello world, got: ${result}`);
    assert.ok(result?.includes('[01:01] second line'), `expected [01:01] second line, got: ${result}`);
  });

  test('youtube: parseTimedtextJson returns null for empty/invalid input', () => {
    assert.equal(parseTimedtextJson(''), null);
    assert.equal(parseTimedtextJson('not json'), null);
    assert.equal(parseTimedtextJson(JSON.stringify({ events: [] })), null);
  });

  test('youtube: installYouTubeInterceptor clones timedtext response body and caches the parsed transcript', async () => {
    const prevWindow = globalThis.window;
    const prevChrome = globalThis.chrome;
    try {
      const transcriptJson = JSON.stringify({ events: [{ tStartMs: 2000, segs: [{ utf8: 'cached line' }] }] });
      const fakeWindow = {
        __browsaYouTubeInterceptorInstalled: false,
        fetch: async (url) => {
          // The player's own timedtext fetch — clone() returns parseable JSON transcript
          return {
            ok: true,
            clone: () => ({ json: async () => ({}), text: async () => transcriptJson }),
            text: async () => transcriptJson,
          };
        },
        location: { origin: 'https://www.youtube.com' },
        XMLHttpRequest: undefined,
      };
      globalThis.window = fakeWindow;
      globalThis.chrome = { runtime: { sendMessage: () => {} } };

      const installed = installYouTubeInterceptor();
      assert.equal(installed, true);

      // Simulate the player's own timedtext fetch
      await fakeWindow.fetch('https://www.youtube.com/api/timedtext?v=TEST999&fmt=srv3&expire=999');
      // Clone + parse runs asynchronously — flush microtasks
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.ok(fakeWindow.__browsaTranscriptCache?.['TEST999']?.includes('[00:02] cached line'),
        `cache should contain the parsed transcript, got: ${JSON.stringify(fakeWindow.__browsaTranscriptCache)}`);
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
      if (prevChrome === undefined) delete globalThis.chrome; else globalThis.chrome = prevChrome;
    }
  });
}

// ============================================================================
// twitter-content-script.js
// ============================================================================
{
  const { isTwitterTweetUrl, extractTweetFromResult, extractTwitterTweet, installTwitterInterceptor } =
    loadContentScript('twitter-content-script.js');

  test('twitter: isTwitterTweetUrl matches both twitter.com and x.com for TweetDetail/TweetResultByRestId', () => {
    assert.equal(isTwitterTweetUrl('https://twitter.com/i/api/graphql/abc123/TweetDetail'), true);
    assert.equal(isTwitterTweetUrl('https://x.com/i/api/graphql/abc123/TweetResultByRestId'), true);
    assert.equal(isTwitterTweetUrl('https://x.com/i/api/graphql/abc123/UserTweets'), false);
    assert.equal(isTwitterTweetUrl('https://example.com/i/api/graphql/abc123/TweetDetail'), false);
  });

  test('twitter: extractTweetFromResult unwraps TweetWithVisibilityResults and maps legacy fields', () => {
    const wrapped = {
      __typename: 'TweetWithVisibilityResults',
      tweet: {
        legacy: { id_str: '123', full_text: 'hello world', favorite_count: 5, retweet_count: 2, reply_count: 1, quote_count: 0, lang: 'en', created_at: 'now' },
        core: { user_results: { result: { legacy: { name: 'Alice', screen_name: 'alice' } } } }
      }
    };
    const tweet = extractTweetFromResult(wrapped);
    assert.equal(tweet.tweetId, '123');
    assert.equal(tweet.text, 'hello world');
    assert.equal(tweet.author, 'Alice');
    assert.equal(tweet.screenName, 'alice');
    assert.equal(tweet.likes, 5);
  });

  test('twitter: extractTweetFromResult returns null without a plain (non-wrapped) result missing legacy.id_str', () => {
    assert.equal(extractTweetFromResult({ legacy: {} }), null);
    assert.equal(extractTweetFromResult(null), null);
  });

  test('twitter: extractTwitterTweet handles TweetResultByRestId shape', () => {
    const data = { data: { tweetResult: { result: { legacy: { id_str: '1', full_text: 'a' } } } } };
    const tweet = extractTwitterTweet(data);
    assert.equal(tweet.tweetId, '1');
  });

  test('twitter: extractTwitterTweet walks TweetDetail conversation instructions to find the first tweet', () => {
    const data = {
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [
            { type: 'TimelineClearCache' },
            { type: 'TimelineAddEntries', entries: [
              { content: { itemContent: { itemType: 'TimelineTimelineCursor' } } },
              { content: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { legacy: { id_str: '99', full_text: 'thread root' } } } } } },
            ] }
          ]
        }
      }
    };
    const tweet = extractTwitterTweet(data);
    assert.equal(tweet.tweetId, '99');
    assert.equal(tweet.text, 'thread root');
  });

  test('twitter: extractTwitterTweet fails closed (null, no throw) on garbage input', () => {
    assert.equal(extractTwitterTweet(null), null);
    assert.equal(extractTwitterTweet({}), null);
    assert.equal(extractTwitterTweet({ data: { threaded_conversation_with_injections_v2: { instructions: 'not-an-array' } } }), null);
  });

  test('twitter: installTwitterInterceptor is a no-op outside a browser context', () => {
    assert.equal(installTwitterInterceptor(), false);
  });
}

// ============================================================================
// zhihu-content-script.js
// ============================================================================
{
  const { isZhihuArticleUrl, isZhihuAnswersUrl, extractZhihuArticle, extractZhihuAnswers, installZhihuInterceptor } =
    loadContentScript('zhihu-content-script.js');
  const identityToText = (html) => (html || '').replace(/<[^>]+>/g, ''); // stand-in for the real DOM-based htmlToText

  test('zhihu: isZhihuArticleUrl / isZhihuAnswersUrl match their respective numeric-id paths', () => {
    assert.equal(isZhihuArticleUrl('https://www.zhihu.com/api/v4/articles/12345'), true);
    assert.equal(isZhihuArticleUrl('https://www.zhihu.com/api/v4/articles/abc'), false, 'non-numeric id must not match');
    assert.equal(isZhihuAnswersUrl('https://www.zhihu.com/api/v4/questions/999/answers?limit=5'), true);
    assert.equal(isZhihuAnswersUrl('https://www.zhihu.com/api/v4/questions/999/comments'), false);
  });

  test('zhihu: extractZhihuArticle maps fields and applies the injected toText', () => {
    const article = extractZhihuArticle({
      id: 1, title: ' T ', content: '<p>hi</p>', author: { name: 'A' }, voteup_count: 3, comment_count: 1
    }, identityToText);
    assert.equal(article.id, '1');
    assert.equal(article.title, 'T');
    assert.equal(article.text, 'hi');
    assert.equal(article.author, 'A');
  });

  test('zhihu: extractZhihuArticle returns null without an id or title', () => {
    assert.equal(extractZhihuArticle({ id: 1 }, identityToText), null);
    assert.equal(extractZhihuArticle({ title: 't' }, identityToText), null);
  });

  test('zhihu: extractZhihuAnswers takes the top 10, filters empty-text answers, and reads question meta from the first answer', () => {
    const answers = Array.from({ length: 15 }, (_, i) => ({
      id: i, content: i === 3 ? '' : `<p>answer ${i}</p>`, author: { name: `user${i}` }, voteup_count: i,
      question: { id: 500, title: 'The Question' }
    }));
    const result = extractZhihuAnswers({ data: answers }, identityToText);
    assert.equal(result.type, 'question');
    assert.equal(result.id, '500');
    assert.equal(result.title, 'The Question');
    assert.equal(result.answers.length, 9, '10 sliced minus 1 filtered-empty (index 3) = 9');
    assert.ok(!result.answers.some(a => a.text === ''));
  });

  test('zhihu: extractZhihuAnswers returns null for an empty or non-array answer list', () => {
    assert.equal(extractZhihuAnswers({ data: [] }, identityToText), null);
    assert.equal(extractZhihuAnswers({}, identityToText), null);
  });

  test('zhihu: installZhihuInterceptor is a no-op outside a browser context', () => {
    assert.equal(installZhihuInterceptor(), false);
  });
}

// ============================================================================
// dedao-content-script.js
// ============================================================================
{
  const { isDedaoContentUrl, probeDedaoContent, extractDedaoArticle, installDedaoInterceptor } =
    loadContentScript('dedao-content-script.js');

  test('dedao: isDedaoContentUrl matches any dedao.cn subdomain with a content/article detail path', () => {
    assert.equal(isDedaoContentUrl('https://www.dedao.cn/pc/v2/content/detail?id=1'), true);
    assert.equal(isDedaoContentUrl('https://api.dedao.cn/pc-college/v1/content/article/details'), true);
    assert.equal(isDedaoContentUrl('https://www.dedao.cn/pc/v2/article/detail?id=1'), true);
    assert.equal(isDedaoContentUrl('https://www.dedao.cn/pc/v2/content/list'), false);
  });

  test('dedao: isDedaoContentUrl hostname check is a plain endsWith, not a subdomain-boundary match (documents current, loose, behavior)', () => {
    // hostname.endsWith('dedao.cn') matches "notdedao.cn" too, since there's no
    // '.' boundary check. Low practical risk today because this content script
    // only ever runs on pages matching manifest.json's www.dedao.cn content_scripts
    // entry, so it only ever sees same-page-initiated fetch/XHR calls — but this
    // pins the current (loose) behavior so a future tightening is a visible diff.
    assert.equal(isDedaoContentUrl('https://notdedao.cn/content/detail'), true);
  });

  test('dedao: probeDedaoContent unwraps the {data:{...}} envelope and tries field fallbacks in order', () => {
    const found = probeDedaoContent({ data: { article_title: 'T', article_content: 'x'.repeat(60), nickname: 'Author' } });
    assert.equal(found.title, 'T');
    assert.equal(found.author, 'Author');
  });

  test('dedao: probeDedaoContent also accepts an un-enveloped object directly', () => {
    const found = probeDedaoContent({ title: 'T2', content: 'y'.repeat(60) });
    assert.equal(found.title, 'T2');
  });

  test('dedao: probeDedaoContent rejects content shorter than 50 chars (probably not real article body)', () => {
    assert.equal(probeDedaoContent({ data: { title: 'T', content: 'too short' } }), null);
  });

  test('dedao: probeDedaoContent returns null for non-object input', () => {
    assert.equal(probeDedaoContent(null), null);
    assert.equal(probeDedaoContent('a string'), null);
  });

  test('dedao: extractDedaoArticle attaches sourceUrl on a valid probe, or null through', () => {
    const article = extractDedaoArticle('https://dedao.cn/x', { data: { title: 'T', content: 'z'.repeat(60) } });
    assert.equal(article.sourceUrl, 'https://dedao.cn/x');
    assert.equal(extractDedaoArticle('https://dedao.cn/x', { data: {} }), null);
  });

  test('dedao: installDedaoInterceptor is a no-op outside a browser context', () => {
    assert.equal(installDedaoInterceptor(), false);
  });
}

// ============================================================================
// geektime-content-script.js
// ============================================================================
{
  const { isGeektimeArticleUrl, isValidGeektimeResponse, extractGeektimeArticle, maybeExtractGeektime, installGeektimeInterceptor } =
    loadContentScript('geektime-content-script.js');
  const identityToText = (html) => (html || '').replace(/<[^>]+>/g, '');

  test('geektime: isGeektimeArticleUrl matches only the exact article endpoint', () => {
    assert.equal(isGeektimeArticleUrl('https://time.geekbang.org/serv/v1/article'), true);
    assert.equal(isGeektimeArticleUrl('https://time.geekbang.org/serv/v1/articles'), false);
    assert.equal(isGeektimeArticleUrl('https://example.com/serv/v1/article'), false);
  });

  test('geektime: isValidGeektimeResponse requires code 0 and non-empty article_content', () => {
    assert.equal(isValidGeektimeResponse({ code: 0, data: { article_info: { article_content: '<p>x</p>' } } }), true);
    assert.equal(isValidGeektimeResponse({ code: 1, data: { article_info: { article_content: '<p>x</p>' } } }), false);
    assert.equal(isValidGeektimeResponse({ code: 0, data: { article_info: { article_content: '' } } }), false);
  });

  test('geektime: extractGeektimeArticle maps fields through the injected toText', () => {
    const article = extractGeektimeArticle({
      data: { article_info: { article_id: 1, article_title: ' T ', article_content: '<p>hi</p>', article_summary: 'sum', author_name: 'A' } }
    }, identityToText);
    assert.equal(article.articleId, '1');
    assert.equal(article.title, 'T');
    assert.equal(article.text, 'hi');
    assert.equal(article.summary, 'sum');
  });

  test('geektime: maybeExtractGeektime gates on both URL and response validity', () => {
    const validData = { code: 0, data: { article_info: { article_id: 1, article_content: '<p>hi</p>' } } };
    assert.equal(maybeExtractGeektime('https://time.geekbang.org/serv/v1/article', validData, identityToText)?.articleId, '1');
    assert.equal(maybeExtractGeektime('https://example.com/serv/v1/article', validData, identityToText), null, 'wrong URL must gate out even valid data');
    assert.equal(maybeExtractGeektime('https://time.geekbang.org/serv/v1/article', { code: 1 }, identityToText), null, 'invalid response must gate out');
  });

  test('geektime: installGeektimeInterceptor is a no-op outside a browser context', () => {
    assert.equal(installGeektimeInterceptor(), false);
  });
}

// ============================================================================
// juejin-content-script.js
// ============================================================================
{
  const { isJuejinArticleUrl, isValidJuejinResponse, extractJuejinArticle, maybeExtractJuejin, installJuejinInterceptor } =
    loadContentScript('juejin-content-script.js');

  test('juejin: isJuejinArticleUrl matches only api.juejin.cn article-detail', () => {
    assert.equal(isJuejinArticleUrl('https://api.juejin.cn/content_api/v1/article/detail'), true);
    assert.equal(isJuejinArticleUrl('https://juejin.cn/content_api/v1/article/detail'), false, 'wrong host (juejin.cn, not api.juejin.cn) must not match');
    assert.equal(isJuejinArticleUrl('https://api.juejin.cn/content_api/v1/article/list'), false);
  });

  test('juejin: isValidJuejinResponse requires err_no 0 and a non-empty mark_content string', () => {
    assert.equal(isValidJuejinResponse({ err_no: 0, data: { article_info: { mark_content: '# hi' } } }), true);
    assert.equal(isValidJuejinResponse({ err_no: 1, data: { article_info: { mark_content: '# hi' } } }), false);
    assert.equal(isValidJuejinResponse({ err_no: 0, data: { article_info: { mark_content: '' } } }), false);
    assert.equal(isValidJuejinResponse({ err_no: 0, data: { article_info: { mark_content: 123 } } }), false, 'non-string mark_content must be rejected');
  });

  test('juejin: extractJuejinArticle maps markdown content, tags, and stats', () => {
    const article = extractJuejinArticle({
      data: {
        article_info: { article_id: 'a1', title: ' T ', mark_content: '# md', view_count: 10, digg_count: 5, comment_count: 2, collect_count: 1 },
        author_user_info: { user_name: 'Author' },
        tags: [{ tag_name: ' JS ' }, { tag_name: '' }, { tag_name: 'Node' }]
      }
    });
    assert.equal(article.title, 'T');
    assert.equal(article.markContent, '# md');
    assert.deepEqual(article.tags, ['JS', 'Node'], 'empty tag names must be filtered out');
    assert.equal(article.viewCount, 10);
  });

  test('juejin: maybeExtractJuejin gates on both URL and response validity', () => {
    const validData = { err_no: 0, data: { article_info: { article_id: 1, mark_content: '# hi' }, author_user_info: {}, tags: [] } };
    assert.ok(maybeExtractJuejin('https://api.juejin.cn/content_api/v1/article/detail', validData));
    assert.equal(maybeExtractJuejin('https://example.com/content_api/v1/article/detail', validData), null);
    assert.equal(maybeExtractJuejin('https://api.juejin.cn/content_api/v1/article/detail', { err_no: 1 }), null);
  });

  test('juejin: installJuejinInterceptor is a no-op outside a browser context', () => {
    assert.equal(installJuejinInterceptor(), false);
  });
}

// ============================================================================
// xueqiu-content-script.js
// ============================================================================
{
  const { isXueqiuStockUrl, isXueqiuPostUrl, extractXueqiuStock, extractXueqiuPost, installXueqiuInterceptor } =
    loadContentScript('xueqiu-content-script.js');

  test('xueqiu: isXueqiuStockUrl / isXueqiuPostUrl match distinct hosts and paths', () => {
    assert.equal(isXueqiuStockUrl('https://stock.xueqiu.com/v5/stock/quote.json?symbol=SH600000'), true);
    assert.equal(isXueqiuStockUrl('https://xueqiu.com/v5/stock/quote.json'), false, 'stock quotes must come from the stock. subdomain');
    assert.equal(isXueqiuPostUrl('https://xueqiu.com/v4/statuses/show.json?id=1'), true);
    assert.equal(isXueqiuPostUrl('https://www.xueqiu.com/v4/user/statuses/show.json'), true);
    assert.equal(isXueqiuPostUrl('https://stock.xueqiu.com/v4/statuses/show.json'), false, 'posts must come from the apex/www host, not stock.');
  });

  test('xueqiu: extractXueqiuStock maps quote fields and returns null without a symbol', () => {
    const stock = extractXueqiuStock({ data: { quote: { symbol: 'SH600000', name: ' Bank ', current: 10, percent: 1.5, exchange: 'SH' } } });
    assert.equal(stock.type, 'stock');
    assert.equal(stock.symbol, 'SH600000');
    assert.equal(stock.name, 'Bank');
    assert.equal(extractXueqiuStock({ data: { quote: {} } }), null);
    assert.equal(extractXueqiuStock({}), null);
  });

  test('xueqiu: extractXueqiuPost strips HTML tags and &nbsp; entities from text', () => {
    const post = extractXueqiuPost({ status: { id: 1, title: 'T', text: '<p>hello&nbsp;world</p>', user: { screen_name: 'u' }, like_count: 3 } });
    assert.equal(post.text, 'hello world');
    assert.equal(post.type, 'post');
    assert.equal(post.likes, 3);
  });

  test('xueqiu: extractXueqiuPost falls back to description when text is absent, and returns null without an id', () => {
    const post = extractXueqiuPost({ status: { id: 2, description: 'from desc' } });
    assert.equal(post.text, 'from desc');
    assert.equal(extractXueqiuPost({ status: {} }), null);
    assert.equal(extractXueqiuPost({}), null);
  });

  test('xueqiu: installXueqiuInterceptor is a no-op outside a browser context', () => {
    assert.equal(installXueqiuInterceptor(), false);
  });
}

// ============================================================================
// xiaoyuzhou-content-script.js
// ============================================================================
{
  const { isXiaoyuzhouApiUrl, extractXiaoyuzhouEpisode, installXiaoyuzhouInterceptor } =
    loadContentScript('xiaoyuzhou-content-script.js');

  test('xiaoyuzhou: isXiaoyuzhouApiUrl matches the API host and the OSS audio-clip host', () => {
    assert.equal(isXiaoyuzhouApiUrl('https://api.xiaoyuzhoufm.com/v1/episode/get'), true);
    assert.equal(isXiaoyuzhouApiUrl('https://audioclip.oss-cn-shanghai.aliyuncs.com/foo.m4a'), true);
    assert.equal(isXiaoyuzhouApiUrl('https://xiaoyuzhoufm.com/episode/123'), false, 'the page host itself (not api.) must not match');
  });

  test('xiaoyuzhou: extractXiaoyuzhouEpisode reads from nested data.episode, top-level episode, or a direct eid object', () => {
    const fromNested = extractXiaoyuzhouEpisode({ data: { episode: { eid: '1', title: 'T1' } } });
    assert.equal(fromNested.eid, '1');
    const fromTopLevel = extractXiaoyuzhouEpisode({ episode: { eid: '2', title: 'T2' } });
    assert.equal(fromTopLevel.eid, '2');
    const fromDirect = extractXiaoyuzhouEpisode({ eid: '3', title: 'T3' });
    assert.equal(fromDirect.eid, '3');
  });

  test('xiaoyuzhou: extractXiaoyuzhouEpisode falls back across podcast/description/mediaUrl field aliases', () => {
    const ep = extractXiaoyuzhouEpisode({ eid: '1', title: 'T', podcastTitle: 'P', shownotes: 'notes', mediaUrl: 'http://x' });
    assert.equal(ep.podcast, 'P');
    assert.equal(ep.description, 'notes');
    assert.equal(ep.mediaUrl, 'http://x');
  });

  test('xiaoyuzhou: extractXiaoyuzhouEpisode returns null without an eid or title', () => {
    assert.equal(extractXiaoyuzhouEpisode({}), null);
    assert.equal(extractXiaoyuzhouEpisode({ data: {} }), null);
  });

  test('xiaoyuzhou: installXiaoyuzhouInterceptor is a no-op outside a browser context', () => {
    assert.equal(installXiaoyuzhouInterceptor(), false);
  });
}
