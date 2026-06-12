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
    const u = new URL(url);
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

// ---- Side-effect code -------------------------------------------------------

function installYouTubeInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
  if (window.__browsaYouTubeInterceptorInstalled) return true;
  window.__browsaYouTubeInterceptorInstalled = true;

  async function handlePlayerResponse(data) {
    const meta = extractVideoMeta(data);
    if (!meta) return;
    const transcript = await fetchTranscript(meta.captionTracks);
    const video = {
      videoId: meta.videoId,
      title: meta.title,
      author: meta.author,
      lengthSeconds: meta.lengthSeconds,
      shortDescription: meta.shortDescription,
      transcript,
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
  module.exports = { isYouTubePlayerUrl, extractVideoMeta, fetchTranscript, installYouTubeInterceptor };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installYouTubeInterceptor();
}
