// lib/handlers/media-downloader.js
//
// Small shared helpers for the media-download feature. The message handlers
// themselves live in media-handler.js (GET_MEDIA_STREAMS: chrome.scripting
// MAIN-world stream-list reads; DOWNLOAD_MEDIA: primary chrome.downloads.
// download with a session declarativeNetRequest rule injecting the B站
// Referer, fallback: page-world fetch+blob+<a download>). Everything here is
// pure (no chrome/DOM deps), so it's unit-testable.

/** Map a MIME type to a file extension for the download filename
 *  ('' when unknown - caller falls back to a type-based default). */
export function extFromMime(mime) {
  if (!mime) return '';
  const m = String(mime).split(';')[0].toLowerCase();
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('aac')) return 'aac';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mp4') || m.includes('quicktime')) return 'mp4';
  return '';
}