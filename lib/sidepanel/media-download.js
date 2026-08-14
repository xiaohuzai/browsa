// lib/sidepanel/media-download.js
//
// Media download for video pages (bilibili / youtube). When the current tab is
// a video page, a small ⬇ button appears next to the page meta in the composer
// footer; clicking it opens a popover listing the page's downloadable streams
// (audio first, video below - muxed first, dash video labelled "no audio
// track"). Downloading runs through background's DOWNLOAD_MEDIA: primarily
// chrome.downloads.download({saveAs:true}) with a session DNR rule injecting
// the B站 Referer (the browser's downloader carries the site cookies + shows
// the save dialog + streams to disk), with a page-world fetch+blob+<a
// download> fallback. The browser's own download bar shows progress; the
// panel just flips the button to "已开始下载" / 已取消 / 重试.
//
// Follows the sidepanel module convention: no imports of sidepanel.js back;
// the one piece of sidepanel.js-owned mutable state (currentTabId) is passed
// in via initMediaDownload({ getTabId }).

import { sendMessage, showToast } from './ui-utils.js';

export function initMediaDownload({ getTabId }) {
  const btn = document.getElementById('mediadl');
  const panel = document.getElementById('media-panel');
  if (!btn || !panel) return { refresh: () => {} };

  // The primary download path is chrome.downloads.download({saveAs}) in the
  // background (with a page-world fetch+blob+<a download> fallback), so the
  // button is "✓ 已开始下载" the moment the download starts; the browser's own
  // download bar owns progress/completion from there. There is deliberately no
  // progress bar or chrome.downloads tracking in the panel: earlier attempts
  // broke repeatedly (MV3 SW sleeps kill SW listeners; a fresh saveAs download
  // transiently reports 'interrupted' which a watcher mistook for failure).

  // Show/hide the ⬇ entry based on whether the current tab is a video page.
  // Called from sidepanel.js on tab switches / NAVIGATED events.
  async function refresh() {
    const tabId = getTabId();
    if (tabId == null) { btn.hidden = true; return; }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab?.url || '';
    const isVideoPage = /bilibili\.com\/video\//.test(url) || /youtube\.com\/watch/.test(url);
    btn.hidden = !isVideoPage;
    if (!isVideoPage) panel.hidden = true;
  }

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!panel.hidden) { panel.hidden = true; return; }
    const tabId = getTabId();
    if (tabId == null) return;
    await openPanel(tabId);
  });

  // Click outside the popover closes it.
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) panel.hidden = true;
  });

  async function openPanel(tabId) {
    panel.innerHTML = '<div class="media-empty">读取媒体流…</div>';
    panel.hidden = false;
    const res = await sendMessage({ type: 'GET_MEDIA_STREAMS', tabId });
    if (!res?.ok) {
      panel.innerHTML = `<div class="media-error">无法获取媒体流：${escM(res?.error || '未知错误')}</div>`;
      return;
    }
    // background returns plain { streams, url, debug } -> wrapped by the
    // onMessage listener as { ok:true, data:{streams,url,debug} }.
    const { streams, url, debug } = res.data || {};
    const list = Array.isArray(streams) ? streams : [];
    if (!list.length) {
      // No streams found - if the background attached a diagnostic string
      // (it probes window.__playinfo__ / ytInitialPlayerResponse shape when the
      // stream list is empty), surface it so we can see WHY nothing was found
      // (absent global, not-logged-in code:-101, structural change, etc.).
      let html = '<div class="media-empty">未检测到可下载的媒体流</div>';
      if (debug) html += `<div class="media-debug">${escM(debug)}</div>`;
      panel.innerHTML = html;
      return;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    renderPanel(list, url || '', tab?.title || '');
  }

  function renderPanel(streams, pageUrl, title) {
    const platform = /bilibili/.test(pageUrl) ? 'BILIBILI' : 'YOUTUBE';
    // Audio first (download audio is the primary intent); video below with
    // muxed (audio+video together) at the top, dash video (video-only) after.
    const audio = streams.filter(s => s.type === 'audio')
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const muxed = streams.filter(s => s.type === 'muxed');
    const video = streams.filter(s => s.type === 'video');

    const items = [];  // { stream, html }
    items.push({
      html: `<div class="media-head"><span class="media-title">${escM(title || '视频')}</span><span class="media-platform">${platform}</span></div>`
    });
    if (audio.length) {
      items.push({ html: '<div class="media-section">音频</div>' });
      for (const s of audio) items.push({ stream: s, html: streamItemHtml(s) });
    }
    if (muxed.length || video.length) {
      items.push({ html: '<div class="media-section">视频</div>' });
      for (const s of muxed) items.push({ stream: s, html: streamItemHtml(s) });
      for (const s of video) items.push({ stream: s, html: streamItemHtml(s, true) });
    }
    panel.innerHTML = items.map(i => i.html).join('');

    let idx = 0;
    panel.querySelectorAll('.media-item').forEach((el) => {
      while (idx < items.length && !items[idx].stream) idx++;
      const stream = items[idx]?.stream;
      idx++;
      if (!stream) return;
      el.querySelector('.media-dl').addEventListener('click', () => startDownload(el, stream, title));
    });
  }

  function streamItemHtml(s, noAudio) {
    const label = noAudio
      ? `<span class="media-label">${escM(s.label)}<span class="media-note"> · 无音轨</span></span>`
      : `<span class="media-label">${escM(s.label)}</span>`;
    return `<div class="media-item${noAudio ? ' no-audio' : ''}">${label}<button class="media-dl">下载</button></div>`;
  }

  async function startDownload(itemEl, stream, title) {
    const tabId = getTabId();
    if (tabId == null) return;
    const dlBtn = itemEl.querySelector('.media-dl');
    dlBtn.disabled = true;
    dlBtn.textContent = '下载中…';
    const filename = title || stream.label || 'media';
    const res = await sendMessage({ type: 'DOWNLOAD_MEDIA', tabId, stream, filename });
    const data = res?.data || {};
    if (res?.ok) {
      if (data.userCanceled) {
        dlBtn.textContent = '已取消';
        dlBtn.disabled = false;
      } else {
        // Page-world download: the file is handed to the browser's downloader, so
        // "已开始下载"; the browser's download bar carries progress. Real
        // failures came out of DOWNLOAD_MEDIA already (else-branch below).
        dlBtn.textContent = '✓ 已开始下载';
      }
    } else {
      dlBtn.textContent = '重试';
      dlBtn.disabled = false;
      showToast(`下载失败：${res?.error || '未知错误'}`);
    }
  }

  return { refresh };
}

function escM(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
