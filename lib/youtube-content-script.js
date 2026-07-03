// lib/youtube-content-script.js
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
    shortDescription: (details.shortDescription || '').slice(0, 600).trim(),
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

  try {
    // fmt=json3 returns structured JSON instead of XML — easier to parse.
    const res = await fetch(track.baseUrl + '&fmt=json3');
    if (!res.ok) return null;
    const data = await res.json();
    const events = data.events || [];
    const lines = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const t = Math.floor((ev.tStartMs || 0) / 1000);
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
      if (text) lines.push(`[${mm}:${ss}] ${text}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (_) {
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
  const videoId = new URLSearchParams(window.location.search).get('v');
  if (!videoId) return null;

  // --- Stage 1: metadata from server-rendered initial response ---
  const pi = window.ytInitialPlayerResponse;
  const details = pi?.videoDetails;
  if (!details?.videoId) return null;

  const richMeta = readYouTubeRichMeta();
  const chapters = extractYouTubeChapters();

  const base = {
    videoId: details.videoId,
    title: (details.title || '').trim(),
    author: (details.author || '').trim(),
    lengthSeconds: parseInt(details.lengthSeconds || '0', 10),
    shortDescription: (details.shortDescription || '').slice(0, 600).trim(),
    chapters: chapters?.length > 1 ? chapters : null,
    ...richMeta,
    rawAt: Date.now()
  };

  // --- Stage 2: transcript from performance resource entries ---
  // YouTube pre-fetches timedtext when the player loads; those URLs have
  // valid PO tokens baked in. We grab the most recent json3 entry.
  let transcript = null;
  try {
    const entries = performance.getEntriesByType('resource');
    const timedtext = entries
      .filter(e => e.name.includes('/api/timedtext') && e.name.includes('fmt=json3'))
      .map(e => e.name);
    for (let i = timedtext.length - 1; i >= 0; i--) {
      const res = await fetch(timedtext[i]);
      if (!res.ok) continue;
      const data = await res.json();
      const lines = [];
      for (const ev of (data.events || [])) {
        if (!ev.segs) continue;
        const t = Math.floor((ev.tStartMs || 0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
        if (text) lines.push(`[${mm}:${ss}] ${text}`);
      }
      if (lines.length > 0) { transcript = lines.join('\n'); break; }
    }
  } catch (_) {}

  if (transcript) return { ...base, transcript };

  // --- Stage 3: fresh player API POST for new caption URLs ---
  // ytcfg.get() is YouTube's official accessor; ytcfg.data_ is the raw store.
  const getCfg = (k) => window.ytcfg?.get?.(k) ?? window.ytcfg?.data_?.[k];
  const context = getCfg('INNERTUBE_CONTEXT');
  const apiKey  = getCfg('INNERTUBE_API_KEY') || '';
  if (context) {
    try {
      const url = '/youtubei/v1/player' + (apiKey ? `?key=${apiKey}` : '');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ context, videoId, racyCheckOk: false, contentCheckOk: false })
      });
      if (res.ok) {
        const playerData = await res.json();
        const meta = extractVideoMeta(playerData);
        if (meta?.captionTracks?.length) {
          transcript = await fetchTranscript(meta.captionTracks);
        }
      }
    } catch (_) {}
  }

  return { ...base, transcript };
}

// ---- Side-effect code -------------------------------------------------------

function installYouTubeInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
  if (window.__browsaYouTubeInterceptorInstalled) return true;
  window.__browsaYouTubeInterceptorInstalled = true;

  async function handlePlayerResponse(data) {
    const meta = extractVideoMeta(data);
    if (!meta) return;
    const richMeta  = readYouTubeRichMeta();
    const chapters  = extractYouTubeChapters();
    const transcript = await fetchTranscript(meta.captionTracks);
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

  // Wrap fetch to intercept /youtubei/v1/player
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
      return nativeSend.apply(this, arguments);
    };
  }

  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isYouTubePlayerUrl, extractVideoMeta, fetchTranscript, readYouTubeRichMeta, extractYouTubeChapters, activeYouTubeFetch, installYouTubeInterceptor };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installYouTubeInterceptor();
}
