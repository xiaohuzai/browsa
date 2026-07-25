// lib/content-scripts/youtube-content-script.js
//
// Injected into youtube.com pages at document_start (MAIN world).
// Intercepts POST /youtubei/v1/player which YouTube's SPA calls both on initial
// page load and on every video-to-video navigation (pushState). The response
// contains full video metadata + caption track URLs. We fetch the caption XML
// (in MAIN world so YouTube's auth cookies are sent automatically), convert
// it to timestamped plain text, and send everything to the background cache.
//
// Why intercept the API instead of reading ytInitialPlayerResponse?
//   - ytInitialPlayerResponse is set before DOMContentLoaded on the first load
//     and is available for document_start scripts, but it doesn't update during
//     SPA navigation. Intercepting the fetch covers BOTH the initial load AND
//     every subsequent video-to-video navigation.

// Pure: is this the YouTube player API endpoint?
function isYouTubePlayerUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') &&
           u.pathname.startsWith('/youtubei/v1/player');
  } catch (_) { return false; }
}

// Pure: extract video summary from the player API response.
function extractVideoMeta(data) {
  const details = data?.videoDetails;
  if (!details?.videoId) return null;
  return {
    videoId: details.videoId,
    title: (details.title || '').trim(),
    author: (details.author || '').trim(),
    lengthSeconds: parseInt(details.lengthSeconds || '0', 10),
    shortDescription: (details.shortDescription || '').trim(),
    captionTracks: data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
  };
}

// Fetch the caption track XML/JSON3 and convert to timestamped plain text.
// Runs in MAIN world → auth cookies are sent automatically.
async function fetchTranscript(captionTracks) {
  if (!captionTracks || captionTracks.length === 0) return null;

  // Prefer: manual English → auto English → manual any → first available
  const track =
    captionTracks.find((t) => t.languageCode?.startsWith('en') && t.kind !== 'asr') ||
    captionTracks.find((t) => t.languageCode?.startsWith('en')) ||
    captionTracks.find((t) => t.kind !== 'asr') ||
    captionTracks[0];

  if (!track?.baseUrl) return null;
  console.log(`browsa: fetchTranscript baseUrl=${track.baseUrl.slice(0, 120)}`);

  try {
    // Use the baseUrl as-is — modifying fmt= breaks the URL signature and returns
    // 200 + empty body. The response can be json3 or srv3/ttml (XML); both parsers
    // are tried in order. parseTimedtextJson and parseTimedtextXml are defined below
    // in the side-effect section — this function is only called after script load,
    // so TDZ is not an issue (var hoisting, or called at runtime after declarations).
    const res = await fetch(track.baseUrl);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    const lines = parseTimedtextJson(text) || parseTimedtextXml(text);
    console.log(`browsa: fetchTranscript lines=${lines?.length || 0} url=${track.baseUrl.slice(0,60)}`);
    return lines || null;
  } catch (e) {
    console.log('browsa: fetchTranscript error:', e?.message);
    return null;
  }
}

// Read rich metadata from window.ytInitialData + window.ytInitialPlayerResponse.
// These are embedded in the page HTML and available from MAIN world.
// All accesses are deeply optional-chained — YouTube's data structure changes
// without notice, so defensive parsing is essential.
function readYouTubeRichMeta() {
  try {
    const pi = window.ytInitialPlayerResponse;
    const id = window.ytInitialData;

    // Microformat: publishDate, category (from player response)
    const micro = pi?.microformat?.playerMicroformatRenderer;
    const publishDate = micro?.publishDate || micro?.uploadDate || '';
    const category    = micro?.category || '';
    const keywords    = (pi?.videoDetails?.keywords || []).slice(0, 15);

    // Primary info renderer: view count + likes
    const contents = id?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    const primaryInfo   = contents.find(c => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
    const secondaryInfo = contents.find(c => c.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;

    const viewsText = primaryInfo?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText?.trim() || '';

    // Likes live in a nested button structure that YouTube reshuffles often
    let likesText = '';
    try {
      const buttons = primaryInfo?.videoActions?.menuRenderer?.topLevelButtons || [];
      for (const btn of buttons) {
        // Modern segmented button
        const t = btn?.segmentedLikeDislikeButtonViewModel
          ?.likeButtonViewModel?.likeButtonViewModel
          ?.toggleButtonViewModel?.toggleButtonViewModel
          ?.defaultButtonViewModel?.buttonViewModel?.title || '';
        if (t && /[\d,KMB万亿]/.test(t)) { likesText = t.trim(); break; }
        // Legacy toggleButton
        const t2 = btn?.toggleButtonRenderer?.defaultText?.accessibility
          ?.accessibilityData?.label || '';
        if (t2 && /[\d,KMB万亿]/.test(t2)) { likesText = t2.trim(); break; }
      }
    } catch (_) {}

    // Subscriber count
    const subsText = (
      secondaryInfo?.owner?.videoOwnerRenderer?.subscriberCountText?.simpleText ||
      secondaryInfo?.owner?.videoOwnerRenderer?.subscriberCountText?.runs?.[0]?.text ||
      ''
    ).trim();

    return { viewsText, likesText, subsText, publishDate, category, keywords };
  } catch (_) {
    return {};
  }
}

// Extract chapter list from ytInitialData.
// Returns array of "[MM:SS] Chapter Title" strings, or null.
function extractYouTubeChapters() {
  try {
    const id = window.ytInitialData;

    // Primary location: multiMarkersPlayerBarRenderer.markersMap
    const markersMap = id?.playerOverlays
      ?.playerOverlayRenderer?.decoratedPlayerBarRenderer
      ?.multiMarkersPlayerBarRenderer?.markersMap;
    if (Array.isArray(markersMap)) {
      for (const marker of markersMap) {
        const chapters = marker?.value?.chapters;
        if (Array.isArray(chapters) && chapters.length > 1) {
          const lines = chapters.map(c => {
            const cr = c.chapterRenderer;
            const t = Math.floor((cr?.timeRangeStartMillis || 0) / 1000);
            const mm = String(Math.floor(t / 60)).padStart(2, '0');
            const ss = String(t % 60).padStart(2, '0');
            return `[${mm}:${ss}] ${(cr?.title?.simpleText || '').trim()}`;
          }).filter(l => l.length > 7);
          if (lines.length > 1) return lines;
        }
      }
    }

    // Fallback: engagementPanels macroMarkersListRenderer
    const panels = id?.engagementPanels || [];
    for (const panel of panels) {
      const items = panel?.engagementPanelSectionListRenderer
        ?.content?.macroMarkersListRenderer?.contents;
      if (Array.isArray(items) && items.length > 1) {
        const lines = items.map(item => {
          const r = item?.macroMarkersListItemRenderer;
          const timeDesc = r?.timeDescription?.simpleText || '';
          const title    = r?.title?.simpleText || '';
          return `${timeDesc} ${title}`.trim();
        }).filter(l => l.length > 3);
        if (lines.length > 1) return lines;
      }
    }
  } catch (_) {}
  return null;
}

// Active fallback: called via executeScript(world:'MAIN') when the passive
// interception cache is empty.
//
// Three-stage strategy:
//   1. Metadata from window.ytInitialPlayerResponse (always available, fast).
//   2. Transcript via performance resource entries — YouTube already fetched
//      the timedtext (with valid PO tokens) while loading the player; we
//      find those URLs and re-fetch them (OpenCLI technique).
//   3. If no performance entries, POST a fresh /youtubei/v1/player to get
//      new caption URLs with valid PO tokens.
// Returns metadata even when transcript is unavailable.
async function activeYouTubeFetch() {
  // Use window.location as the primary source for videoId — it updates via
  // history.pushState immediately when the user clicks a new video, making it
  // the most reliable indicator of what page we're actually on.
  // getVideoData().video_id lags behind the URL (confirmed empirically: URL
  // already showed the new video's ID while getVideoData() still returned the
  // previous one), so it is NOT used for videoId. The player element is still
  // used for caption tracks (Stage 2) since getOption('captions','tracklist')
  // reflects the currently-loaded video's tracks regardless of URL state.
  const playerEl = document.getElementById('movie_player');
  const videoId = new URLSearchParams(window.location.search).get('v');
  if (!videoId) return null;

  // --- Stage 1: metadata from server-rendered globals ---
  // Both ytInitialPlayerResponse and ytInitialData are stale after SPA
  // navigation — they still hold the previous video's data until the page
  // fully reloads. Guard against this by checking whether the videoId embedded
  // in ytInitialData matches the current URL's videoId before using any data
  // from these globals. Stage 3 (POST /youtubei/v1/player) is authoritative.
  const pi = window.ytInitialPlayerResponse;
  const details = pi?.videoDetails;

  // ytInitialData embeds the current page's videoId in the watch endpoint.
  // If it doesn't match window.location, these globals are stale — discard
  // chapters and richMeta to avoid mixing in the previous video's data.
  const idDataVideoId = window.ytInitialData?.currentVideoEndpoint?.watchEndpoint?.videoId
    || window.ytInitialData?.playerOverlays?.playerOverlayRenderer?.endScreen
      ?.watchNextEndScreenRenderer?.results?.[0]?.endScreenVideoRenderer?.videoId;
  const globalsAreFresh = !idDataVideoId || idDataVideoId === videoId;

  const richMeta = globalsAreFresh ? readYouTubeRichMeta() : {};
  const chapters = globalsAreFresh ? extractYouTubeChapters() : null;

  const base = {
    videoId,
    title: (details?.title || '').trim(),
    author: (details?.author || '').trim(),
    lengthSeconds: parseInt(details?.lengthSeconds || '0', 10),
    shortDescription: (details?.shortDescription || '').trim(),
    chapters: chapters?.length > 1 ? chapters : null,
    ...richMeta,
    rawAt: Date.now()
  };

  // --- Stage 2: transcript cache (captured at page-load when PO token was fresh) ---
  let transcript = (window.__browsaTranscriptCache || {})[videoId] || null;
  if (transcript) {
    console.log(`browsa: stage2 cache hit videoId=${videoId} len=${transcript.length}`);
  } else {
  // --- Stage 2b: performance buffer fast path ---
  // YouTube pre-fetches timedtext with valid PO tokens when the player loads.
  // Scope to current videoId to avoid picking up URLs from previous SPA navigations.
  try {
    const entries = performance.getEntriesByType('resource');
    const timedtext = entries
      .filter(e => e.name.includes('/api/timedtext') && e.name.includes(videoId))
      .map(e => e.name.includes('fmt=')
        ? e.name.replace(/([?&])fmt=[^&]*/, '$1fmt=json3')
        : e.name + '&fmt=json3');
    console.log(`browsa: stage2 candidates=${timedtext.length} videoId=${videoId}`);
    for (let i = timedtext.length - 1; i >= 0; i--) {
      const res = await fetch(timedtext[i]);
      if (!res.ok) continue;
      const text = await res.text();
      if (!text) continue;
      let data; try { data = JSON.parse(text); } catch (_) { continue; }
      const lines = [];
      for (const ev of (data.events || [])) {
        if (!ev.segs) continue;
        const t = Math.floor((ev.tStartMs || 0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        const txt = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
        if (txt) lines.push(`[${mm}:${ss}] ${txt}`);
      }
      if (lines.length > 0) { transcript = lines.join('\n'); break; }
    }
  } catch (e) { console.log('browsa: stage2b error:', e?.message); }
  } // end else (cache miss)
  console.log(`browsa: stage2 result transcript=${!!transcript}`);

  // --- Stage 3: /player (ANDROID) + /next (WEB) ---
  const getCfg = (k) => window.ytcfg?.get?.(k) ?? window.ytcfg?.data_?.[k];
  const baseContext = getCfg('INNERTUBE_CONTEXT') || {};
  const androidContext = {
    ...baseContext,
    client: { ...(baseContext.client || {}), clientName: 'ANDROID', clientVersion: '20.10.38' }
  };
  const apiKey = getCfg('INNERTUBE_API_KEY') || '';
  {
    try {
      const playerUrl = '/youtubei/v1/player' + (apiKey ? `?key=${apiKey}` : '');
      const nextUrl   = '/youtubei/v1/next'   + (apiKey ? `?key=${apiKey}` : '');
      const playerBody = { context: androidContext, videoId, racyCheckOk: false, contentCheckOk: false };
      const nextBody   = { context: baseContext,    videoId, racyCheckOk: false, contentCheckOk: false };

      // /player and /next are independent — neither's failure blocks the other.
      const [playerSettled, nextSettled] = await Promise.allSettled([
        fetch(playerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(playerBody) }),
        fetch(nextUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(nextBody) })
      ]);
      const playerRes = playerSettled.status === 'fulfilled' ? playerSettled.value : null;
      const nextRes   = nextSettled.status === 'fulfilled' ? nextSettled.value : null;

      // --- player response: captions + basic meta ---
      if (playerRes?.ok) {
        const playerData = await playerRes.json();
        const meta = extractVideoMeta(playerData);
        if (meta) {
          if (meta.title)             base.title = meta.title;
          if (meta.author)            base.author = meta.author;
          if (meta.lengthSeconds)     base.lengthSeconds = meta.lengthSeconds;
          if (meta.shortDescription)  base.shortDescription = (meta.shortDescription || '');
          if (meta.captionTracks?.length && !transcript) {
            transcript = await fetchTranscript(meta.captionTracks);
          }
        }
      }

      // --- next response: view count, likes, publish date, chapters, keywords ---
      if (nextRes?.ok) {
        const nextData = await nextRes.json();
        try {
          const contents = nextData?.contents?.singleColumnWatchNextResults?.results?.results?.contents
            || nextData?.contents?.twoColumnWatchNextResults?.results?.results?.contents
            || [];
          const primaryInfo   = contents.find(c => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
          const secondaryInfo = contents.find(c => c.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;

          // View count
          const viewsText = primaryInfo?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText?.trim()
            || primaryInfo?.viewCount?.videoViewCountRenderer?.viewCount?.runs?.map(r => r.text).join('').trim()
            || '';
          if (viewsText) base.viewsText = viewsText;

          // Likes (nested button structure that YouTube reshuffles frequently)
          let likesText = '';
          try {
            const buttons = primaryInfo?.videoActions?.menuRenderer?.topLevelButtons || [];
            for (const btn of buttons) {
              const t = btn?.segmentedLikeDislikeButtonViewModel
                ?.likeButtonViewModel?.likeButtonViewModel
                ?.toggleButtonViewModel?.toggleButtonViewModel
                ?.defaultButtonViewModel?.buttonViewModel?.title || '';
              if (t && /[\d,KMB万亿]/.test(t)) { likesText = t.trim(); break; }
              const t2 = btn?.toggleButtonRenderer?.defaultText?.accessibility?.accessibilityData?.label || '';
              if (t2 && /[\d,KMB万亿]/.test(t2)) { likesText = t2.trim(); break; }
            }
          } catch (_) {}
          if (likesText) base.likesText = likesText;

          // Subscriber count
          const subsText = (
            secondaryInfo?.owner?.videoOwnerRenderer?.subscriberCountText?.simpleText ||
            secondaryInfo?.owner?.videoOwnerRenderer?.subscriberCountText?.runs?.[0]?.text ||
            ''
          ).trim();
          if (subsText) base.subsText = subsText;

          // Publish date
          const publishDate = primaryInfo?.dateText?.simpleText?.trim() || '';
          if (publishDate) base.publishDate = publishDate;

          // Full description from secondaryInfo (always overwrite — /next is authoritative)
          const descRuns = secondaryInfo?.description?.runs;
          if (descRuns?.length) {
            base.shortDescription = descRuns.map(r => r.text || '').join('');
          }

          // Keywords from secondary info description
          const keywords = nextData?.engagementPanels
            ?.find(p => p?.engagementPanelSectionListRenderer?.panelIdentifier === 'structured-description')
            ?.engagementPanelSectionListRenderer?.content?.structuredDescriptionContentRenderer?.items
            ?.find(i => i?.videoDescriptionHeaderRenderer)
            ?.videoDescriptionHeaderRenderer?.hashtags?.map(h => h?.hashtagRenderer?.hashtag?.runs?.[0]?.text)
            ?.filter(Boolean) || [];
          if (keywords.length) base.keywords = keywords;

          // Chapters from engagement panels
          const chapterItems = nextData?.engagementPanels
            ?.find(p => p?.engagementPanelSectionListRenderer?.content?.macroMarkersListRenderer)
            ?.engagementPanelSectionListRenderer?.content?.macroMarkersListRenderer?.contents;
          if (Array.isArray(chapterItems) && chapterItems.length > 1) {
            const lines = chapterItems.map(item => {
              const r = item?.macroMarkersListItemRenderer;
              const timeDesc = r?.timeDescription?.simpleText || '';
              const title    = r?.title?.simpleText || '';
              return `${timeDesc} ${title}`.trim();
            }).filter(l => l.length > 3);
            if (lines.length > 1) base.chapters = lines;
          }
        } catch (_) {}
      }
    } catch (e) { console.log('browsa: stage3 error:', e?.message); }
  }
  console.log(`browsa: activeYouTubeFetch done transcript=${!!transcript}`);

  return { ...base, transcript };
}

// ---- Side-effect code -------------------------------------------------------

function isTimedtextUrl(url) {
  return typeof url === 'string' && url.includes('/api/timedtext');
}

function extractVideoIdFromTimedtextUrl(url) {
  try { return new URL(url).searchParams.get('v') || null; } catch (_) { return null; }
}

// Parses fmt=srv3/ttml XML timedtext response into "[mm:ss] text" lines.
function parseTimedtextXml(text) {
  if (!text) return null;
  try {
    const lines = [];
    const matches = text.matchAll(/<(?:p|text)[^>]*\bt(?:StartMs)?="(\d+)"[^>]*>([^<]*)<\/(?:p|text)>/g);
    for (const [, ms, content] of matches) {
      const t = Math.floor(Number(ms) / 1000);
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      const txt = content.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim();
      if (txt) lines.push(`[${mm}:${ss}] ${txt}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (_) { return null; }
}

// Parses fmt=json3 timedtext response text into "[mm:ss] text" lines.
function parseTimedtextJson(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    const lines = [];
    for (const ev of (data.events || [])) {
      if (!ev.segs) continue;
      const t = Math.floor((ev.tStartMs || 0) / 1000);
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      const txt = ev.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
      if (txt) lines.push(`[${mm}:${ss}] ${txt}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (_) { return null; }
}

function installYouTubeInterceptor() {
  if (typeof window === 'undefined') return false;
  if (window.__browsaYouTubeInterceptorInstalled) return true;
  window.__browsaYouTubeInterceptorInstalled = true;
  // Keyed by videoId — transcript captured at page-load time when PO token is fresh.
  // activeYouTubeFetch checks this before falling back to performance buffer / ANDROID POST.
  window.__browsaTranscriptCache = window.__browsaTranscriptCache || {};

  async function handlePlayerResponse(data) {
    const meta = extractVideoMeta(data);
    if (!meta) return;
    const richMeta  = readYouTubeRichMeta();
    const chapters  = extractYouTubeChapters();
    const transcript = await fetchTranscript(meta.captionTracks);
    console.log(`browsa: handlePlayerResponse videoId=${meta.videoId} captionTracks=${meta.captionTracks?.length} transcript=${!!transcript} transcriptLen=${transcript?.length || 0}`);
    // Cache transcript so activeYouTubeFetch can use it even after PO token expires
    if (transcript) window.__browsaTranscriptCache[meta.videoId] = transcript;
    const video = {
      videoId: meta.videoId,
      title: meta.title,
      author: meta.author,
      lengthSeconds: meta.lengthSeconds,
      shortDescription: meta.shortDescription,
      transcript,
      chapters: chapters?.length > 1 ? chapters : null,
      ...richMeta,
      rawAt: Date.now()
    };
    try {
      chrome.runtime.sendMessage({ type: 'YOUTUBE_DATA', video });
    } catch (_) {}
  }

  // Wrap fetch to intercept /youtubei/v1/player and /api/timedtext.
  // Note: YouTube loads the *current* video's captions via XHR (not fetch),
  // so the XHR wrapper below is the primary caption capture path. The fetch
  // wrapper here catches timedtext for recommended/sidebar videos that YouTube
  // pre-fetches via fetch — harmless to cache those too.
  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isYouTubePlayerUrl(url)) {
        p.then((r) => r.clone().json())
          .then((data) => handlePlayerResponse(data))
          .catch(() => {});
      }
      if (isTimedtextUrl(url)) {
        const vid = extractVideoIdFromTimedtextUrl(url);
        if (vid) {
          // Clone the response YouTube's player already got — this response carries
          // valid auth (cookies/headers sent by the browser) so its body is non-empty.
          // Re-fetching the same URL ourselves would miss any auth headers the browser
          // added automatically, returning empty body even with the same URL.
          p.then((r) => r.clone().text())
            .then((text) => {
              const lines = parseTimedtextJson(text) || parseTimedtextXml(text);
              console.log(`browsa: timedtext fetch intercept videoId=${vid} lines=${lines?.length || 0}`);
              if (lines) window.__browsaTranscriptCache[vid] = lines;
            })
            .catch((e) => console.log('browsa: timedtext fetch intercept error:', e?.message));
        }
      }
      return p;
    };
  }

  // Wrap XHR as fallback
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function (method, url) {
      this.__browsaUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function () {
      if (isYouTubePlayerUrl(this.__browsaUrl)) {
        this.addEventListener('load', function () {
          try { handlePlayerResponse(JSON.parse(this.responseText)); } catch (_) {}
        });
      }
      if (isTimedtextUrl(this.__browsaUrl)) {
        const vid = extractVideoIdFromTimedtextUrl(this.__browsaUrl);
        if (vid) {
          this.addEventListener('load', function () {
            const text = this.responseText || '';
            let lines = parseTimedtextJson(text);
            if (!lines) lines = parseTimedtextXml(text);
            console.log(`browsa: timedtext XHR intercept videoId=${vid} len=${text.length} lines=${lines?.length || 0}`);
            if (lines) window.__browsaTranscriptCache[vid] = lines;
          });
        }
      }
      return nativeSend.apply(this, arguments);
    };
  }

  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isYouTubePlayerUrl, extractVideoMeta, fetchTranscript, readYouTubeRichMeta, extractYouTubeChapters, activeYouTubeFetch, installYouTubeInterceptor, isTimedtextUrl, extractVideoIdFromTimedtextUrl, parseTimedtextJson, parseTimedtextXml };
}

// Listen for ISOLATED world trigger — allows the background to call
// activeYouTubeFetch() without MAIN world injection (which Trusted Types blocks).
if (typeof window !== 'undefined') {
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.data?.type !== '__BROWSA_TRIGGER_YT_FETCH__') return;
    const result = typeof activeYouTubeFetch === 'function' ? await activeYouTubeFetch() : null;
    window.postMessage({ type: '__BROWSA_YT_FETCH_RESULT__', result }, '*');
  });
}

if (typeof window !== 'undefined') {
  console.log(`browsa: script bottom chrome=${typeof chrome} chrome.runtime=${typeof chrome?.runtime}`);
  installYouTubeInterceptor();
}
