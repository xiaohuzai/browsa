// Video-page URL identity, shared by background.js (SEEK_VIDEO /
// GET_VIDEO_TIME tab revalidation) and sidepanel.js (live-tab resolution).
// Pure string comparison — no platform API, no network: anti-bot signing
// (YouTube wbi / bilibili w_rid) lives on API requests, not page URLs, so
// URL identity is immune to it. The v param (YouTube) and the BV path segment
// (bilibili) are permanent content ids; tracking/playback params
// (spm_id_from / vd_source / t / list) are deliberately ignored.

// True when `tabUrl` is still the same video page as the stamped source URL:
// same origin + path, and the same `v` query param when either side has one
// (YouTube watch URLs differ only there; Bilibili identity is in the path).
export function videoUrlMatches(tabUrl, sourceUrl) {
  if (!tabUrl || !sourceUrl) return false;
  try {
    const a = new URL(tabUrl), b = new URL(sourceUrl);
    if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
    const va = a.searchParams.get('v'), vb = b.searchParams.get('v');
    if (va || vb) return va === vb;
    return true;
  } catch (_) {
    return false;
  }
}

// Given candidate tab ids in priority order and an async id→url lookup,
// return the first id whose tab still shows `sourceUrl` (null when none
// does — caller decides the fallback, e.g. open the URL in a new tab).
export async function resolveMatchingTabId(candIds, getUrl, sourceUrl) {
  if (!sourceUrl) return null;
  const tried = new Set();
  for (const id of candIds) {
    if (id == null || tried.has(id)) continue;
    tried.add(id);
    let url = null;
    try { url = await getUrl(id); } catch (_) {} // tab gone
    if (videoUrlMatches(url, sourceUrl)) return id;
  }
  return null;
}
