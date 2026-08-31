// lib/content-scripts/bilibili-content-script.js
//
// Injected into bilibili.com video pages at document_start (MAIN world).
// Intercepts:
//   1. GET api.bilibili.com/x/web-interface/view — video metadata (title, author, desc, stats)
//   2. GET api.bilibili.com/x/player/wbi/v2 — player config including CC subtitle URLs
//
// Fetches the CC subtitle JSON and converts to timestamped plain text,
// then sends the complete video context to the background cache.

function isBilibiliViewUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/view';
  } catch (_) { return false; }
}

function isBilibiliPlayerUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return u.hostname === 'api.bilibili.com' && (
      u.pathname === '/x/player/wbi/v2' || u.pathname === '/x/player/v2'
    );
  } catch (_) { return false; }
}

function extractBilibiliVideo(data) {
  const d = data?.data;
  if (!d?.bvid) return null;
  return {
    bvid: d.bvid,
    title: (d.title || '').trim(),
    desc: (d.desc || '').trim(),
    author: (d.owner?.name || '').trim(),
    upMid: d.owner?.mid || 0,   // needed for summary API
    tname: (d.tname || '').trim(),
    duration: d.duration || 0,
    cid: d.pages?.[0]?.cid || 0,
    stat: {
      view: d.stat?.view || 0,
      like: d.stat?.like || 0,
      coin: d.stat?.coin || 0,
      favorite: d.stat?.favorite || 0,
      reply: d.stat?.reply || 0,
    },
    rawAt: Date.now()
  };
}

// Pure: does this URL look like a B站 AI summary request?
function isBilibiliConclusionUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : undefined);
    return u.hostname === 'api.bilibili.com' &&
           u.pathname === '/x/web-interface/view/conclusion/get';
  } catch (_) { return false; }
}

// Parse B站 AI summary response into readable text.
// Returns null if summary not available for this video.
function extractBilibiliSummary(data) {
  const inner = data?.data;
  if (!inner || inner.code !== 0) return null; // code=0 means summary exists
  const result = inner.model_result;
  if (!result) return null;
  const parts = [];
  if (result.summary) parts.push(result.summary);
  if (Array.isArray(result.outline)) {
    for (const section of result.outline) {
      const t = section.timestamp || 0;
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      parts.push(`\n**[${mm}:${ss}] ${section.title || ''}**`);
      if (Array.isArray(section.part_outline)) {
        for (const point of section.part_outline) {
          const pt = point.timestamp || 0;
          const pm = String(Math.floor(pt / 60)).padStart(2, '0');
          const ps = String(pt % 60).padStart(2, '0');
          parts.push(`- [${pm}:${ps}] ${(point.content || '').trim()}`);
        }
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

// Read downloadable audio/video stream URLs from window.__playinfo__ (embedded
// in the page HTML by B站). Returns a self-describing list for the download UI.
// dash.video is video-only (no audio track) - labelled hasAudio:false so the UI
// can warn; durl is the older muxed format (audio+video together, hasAudio:true).
// Self-contained: only reads window.__playinfo__ (a page global), no sibling
// calls - safe for chrome.scripting.executeScript({world:'MAIN'}) injection
// (see the countImages lesson: an injected func can't call module-level siblings).
function readBilibiliMediaStreams() {
  try {
    // `.data || __playinfo__` flat fallback: the standard watch page nests the
    // payload under .data ({code, message, data:{dash,durl}}), but a few page
    // variants expose dash/durl directly on __playinfo__. Try both.
    const pi = window.__playinfo__?.data || window.__playinfo__;
    if (!pi) return [];
    const streams = [];
    // Dash audio: separate audio-only streams (preferred for "download audio").
    if (Array.isArray(pi.dash?.audio)) {
      for (const a of pi.dash.audio) {
        const url = a.base_url || a.baseUrl;
        if (url) streams.push({
          type: 'audio',
          label: Math.round((a.bandwidth || 0) / 1000) + ' kbps',
          url, bandwidth: a.bandwidth || 0, hasAudio: true,
          // playurl 每个流都带 duration（秒）和 size（字节）；用于 ASR 选流时
          // 校验流是否完整（截断/分片流会明显短于视频总时长）。codecs 用于
          // 区分编码——最低码率流常用 HE-AAC(mp4a.40.5)，decodeAudioData 可能
          // 解不了，选流时优先 AAC-LC(mp4a.40.2)。
          duration: a.duration || 0, size: a.size || 0,
          codecs: a.codecs || '', id: a.id || 0
        });
      }
    }
    // Dash video: video-only streams (no audio track). duration/size 用于视频
    // 解析模式的选流体积预估（bandwidth×duration 之外的精确值）与截断校验。
    if (Array.isArray(pi.dash?.video)) {
      for (const v of pi.dash.video) {
        const url = v.base_url || v.baseUrl;
        if (!url) continue;
        const label = (v.width && v.height) ? `${v.width}x${v.height}` : ('video ' + (v.id || ''));
        streams.push({
          type: 'video', label, url, bandwidth: v.bandwidth || 0, hasAudio: false,
          duration: v.duration || 0, size: v.size || 0,
          width: v.width || 0, height: v.height || 0, id: v.id || 0
        });
      }
    }
    // durl: older muxed format (single stream, audio+video together).
    if (Array.isArray(pi.durl) && pi.durl.length > 0) {
      const d = pi.durl[0];
      if (d.url) streams.push({ type: 'muxed', label: 'mp4', url: d.url, hasAudio: true });
    }
    return streams;
  } catch (_) { return []; }
}

// Actively re-request the playurl API to get a FRESH signed audio/video URL.
// The `window.__playinfo__` URLs baked into the page HTML carry a `deadline`
// signature that expires within hours - if the user attaches/downloads a page
// that loaded long ago, those cached URLs are already dead (B站 CDN returns
// 403). The page player re-requests playurl on each play but does NOT write
// the fresh URLs back to __playinfo__; cat-catch gets fresh URLs by
// webRequest-capturing those player requests. We do the equivalent actively:
// nav API for WBI keys -> sign bvid/cid -> playurl API -> return fresh streams.
// Module-level function (uses wbiSign/md5 as siblings) - safe because this file
// is injected whole via executeScript({files}), NOT as a bare func.
async function fetchFreshBilibiliStreams(bvid, cid) {
  // 任何一步失败都【抛出带原因的错误】而不是静默返回 []：调用方（buildAsrPendingCtx /
  // ASR_FRESH_URLS 的注入函数自带 try/catch）会把 message 透传到 asrExpiredError →
  // 用户 toast 上看到真实原因。返回空数组只代表「code=0 但确实没有流」这一种情况。
  //
  // 真实 bug 链（2026-08-29 用户实测）：1) __playinfo__ 无 bvid 字段（已修，URL path 读）；
  // 2) 本函数把响应顶层的 code 误判到 data.code 上 —— playurl 响应形如
  // {code:0, message, data:{dash,durl}}，data.code 恒为 undefined ≠ 0，【成功响应也永远
  // 返回 []】，自愈路径从未真正成功过，被「页面刚打开时缓存流尚未过期」长期掩盖。
  const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
  if (!navRes.ok) throw new Error('nav HTTP ' + navRes.status);
  const nav = await navRes.json().catch(() => null);
  const imgKey = (nav?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0];
  const subKey = (nav?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0];
  if (!imgKey || !subKey) throw new Error('nav 无 wbi_img keys (nav code=' + (nav?.code ?? '?') + ')');
  const qs = wbiSign({ bvid, cid: String(cid), fnval: '4048', fourk: '1' }, imgKey, subKey);
  const res = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${qs}`, { credentials: 'include' });
  if (!res.ok) throw new Error('playurl HTTP ' + res.status);
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0 || !json.data) {
    throw new Error('playurl code=' + (json?.code ?? '?') + (json?.message ? ': ' + json.message : ''));
  }
  const data = json.data;
  const streams = [];
    if (Array.isArray(data.dash?.audio)) {
      for (const a of data.dash.audio) {
        const url = a.baseUrl || a.base_url;
        if (url) streams.push({
          type: 'audio',
          label: Math.round((a.bandwidth || 0) / 1000) + ' kbps',
          url, bandwidth: a.bandwidth || 0, hasAudio: true,
          duration: a.duration || 0, size: a.size || 0,
          codecs: a.codecs || '', id: a.id || 0
        });
      }
    }
    if (Array.isArray(data.dash?.video)) {
      for (const v of data.dash.video) {
        const url = v.baseUrl || v.base_url;
        if (!url) continue;
        const label = (v.width && v.height) ? `${v.width}x${v.height}` : 'video';
        streams.push({
          type: 'video', label, url, bandwidth: v.bandwidth || 0, hasAudio: false,
          duration: v.duration || 0, size: v.size || 0,
          width: v.width || 0, height: v.height || 0, id: v.id || 0
        });
      }
    }
    if (Array.isArray(data.durl) && data.durl.length > 0 && data.durl[0].url) {
      streams.push({ type: 'muxed', label: 'mp4', url: data.durl[0].url, hasAudio: true });
    }
  return streams;
}

// Fetch CC subtitle JSON and convert to timestamped plain text.
async function fetchBilibiliSubtitle(subtitles) {
  if (!subtitles?.length) return null;
  // Prefer: AI Chinese > Chinese > English > first available
  const sub =
    subtitles.find(s => s.lan === 'ai-zh') ||
    subtitles.find(s => s.lan?.startsWith('zh')) ||
    subtitles.find(s => s.lan?.startsWith('en')) ||
    subtitles[0];
  if (!sub?.subtitle_url) return null;
  try {
    const url = sub.subtitle_url.startsWith('//') ? 'https:' + sub.subtitle_url : sub.subtitle_url;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const body = data.body || [];
    const lines = body.map(item => {
      const t = Math.floor(item.from || 0);
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      return `[${mm}:${ss}] ${(item.content || '').trim()}`;
    }).filter(l => l.length > 8);
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (_) {
    return null;
  }
}

function installBilibiliInterceptor() {
  if (typeof window === 'undefined') return false;
  if (typeof chrome === 'undefined' || !chrome.runtime) return false;
  if (window.__browsaBilibiliInterceptorInstalled) return true;
  window.__browsaBilibiliInterceptorInstalled = true;

  // Shared state — merge video meta from view API + subtitle from player API.
  // Either API can arrive first; we hold the other until both are ready.
  let videoMeta = null;
  let pendingSubtitles = null; // player API arrived before view API

  function safeSend(video) {
    try { chrome.runtime.sendMessage({ type: 'BILIBILI_VIDEO', video }); } catch (_) {}
  }

  async function handleViewResponse(data) {
    const meta = extractBilibiliVideo(data);
    if (!meta) return;
    videoMeta = meta;
    safeSend(meta); // Send immediately (transcript may follow)
    // If the player API already fired before us, process its subtitles now.
    if (pendingSubtitles) {
      const subs = pendingSubtitles;
      pendingSubtitles = null;
      const transcript = await fetchBilibiliSubtitle(subs);
      if (transcript) {
        videoMeta = Object.assign({}, videoMeta, { transcript });
        safeSend(videoMeta);
      }
    }
  }

  async function handleConclusionResponse(data) {
    const summary = extractBilibiliSummary(data);
    if (!summary || !videoMeta) return;
    videoMeta = Object.assign({}, videoMeta, { summary });
    safeSend(videoMeta);
  }

  async function handlePlayerResponse(data) {
    const subtitles = data?.data?.subtitle?.subtitles;
    if (!subtitles?.length) return;
    if (!videoMeta) {
      // View API hasn't arrived yet — hold subtitles until it does.
      pendingSubtitles = subtitles;
      return;
    }
    const transcript = await fetchBilibiliSubtitle(subtitles);
    if (transcript) {
      videoMeta = Object.assign({}, videoMeta, { transcript });
      safeSend(videoMeta); // Re-send with transcript
    }
  }

  // Wrap fetch
  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = function browsaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input?.url || '');
      const p = nativeFetch(input, init);
      if (isBilibiliViewUrl(url)) {
        p.then(r => r.clone().json()).then(handleViewResponse).catch(() => {});
      } else if (isBilibiliPlayerUrl(url)) {
        p.then(r => r.clone().json()).then(handlePlayerResponse).catch(() => {});
      } else if (isBilibiliConclusionUrl(url)) {
        p.then(r => r.clone().json()).then(handleConclusionResponse).catch(() => {});
      }
      return p;
    };
  }

  // Wrap XHR (fallback)
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function(method, url) {
      this.__browsaUrl = String(url || '');
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function() {
      if (isBilibiliViewUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try { handleViewResponse(JSON.parse(this.responseText)); } catch (_) {}
        });
      } else if (isBilibiliPlayerUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try { handlePlayerResponse(JSON.parse(this.responseText)); } catch (_) {}
        });
      } else if (isBilibiliConclusionUrl(this.__browsaUrl)) {
        this.addEventListener('load', function() {
          try { handleConclusionResponse(JSON.parse(this.responseText)); } catch (_) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  }

  return true;
}

// ---------------------------------------------------------------------------
// Active fallback: when passive interception missed the API calls (SW sleep,
// tab already open before extension install, etc.), the background can ask
// us to actively fetch video data from the page context — which has the
// user's login cookies and will auto-handle CORS/auth for free.
//
// WBI signing implemented here (pure JS MD5 + Bilibili permutation table)
// so we can call /x/player/wbi/v2 and get subtitle URLs.
// ---------------------------------------------------------------------------

// Pure JS MD5 (RFC 1321). No external dependencies.
function md5(str) {
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    return ((x >> 16) + (y >> 16) + (lsw >> 16)) << 16 | (lsw & 0xffff);
  }
  function rol(n, s) { return n << s | n >>> 32 - s; }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function ff(a,b,c,d,x,s,t){return cmn(b&c|~b&d,a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn(b&d|c&~d,a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t);}
  const s = unescape(encodeURIComponent(str));
  const blks = new Array(Math.ceil((s.length + 8) / 64) * 16).fill(0);
  for (let i = 0; i < s.length; i++) blks[i >> 2] |= s.charCodeAt(i) << i % 4 * 8;
  blks[s.length >> 2] |= 0x80 << s.length % 4 * 8;
  blks[blks.length - 2] = s.length * 8;
  let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for (let i = 0; i < blks.length; i += 16) {
    const [oa,ob,oc,od]=[a,b,c,d];
    a=ff(a,b,c,d,blks[i+0],7,-680876936);  d=ff(d,a,b,c,blks[i+1],12,-389564586);
    c=ff(c,d,a,b,blks[i+2],17,606105819);  b=ff(b,c,d,a,blks[i+3],22,-1044525330);
    a=ff(a,b,c,d,blks[i+4],7,-176418897);  d=ff(d,a,b,c,blks[i+5],12,1200080426);
    c=ff(c,d,a,b,blks[i+6],17,-1473231341);b=ff(b,c,d,a,blks[i+7],22,-45705983);
    a=ff(a,b,c,d,blks[i+8],7,1770035416);  d=ff(d,a,b,c,blks[i+9],12,-1958414417);
    c=ff(c,d,a,b,blks[i+10],17,-42063);    b=ff(b,c,d,a,blks[i+11],22,-1990404162);
    a=ff(a,b,c,d,blks[i+12],7,1804603682); d=ff(d,a,b,c,blks[i+13],12,-40341101);
    c=ff(c,d,a,b,blks[i+14],17,-1502002290);b=ff(b,c,d,a,blks[i+15],22,1236535329);
    a=gg(a,b,c,d,blks[i+1],5,-165796510);  d=gg(d,a,b,c,blks[i+6],9,-1069501632);
    c=gg(c,d,a,b,blks[i+11],14,643717713); b=gg(b,c,d,a,blks[i+0],20,-373897302);
    a=gg(a,b,c,d,blks[i+5],5,-701558691);  d=gg(d,a,b,c,blks[i+10],9,38016083);
    c=gg(c,d,a,b,blks[i+15],14,-660478335);b=gg(b,c,d,a,blks[i+4],20,-405537848);
    a=gg(a,b,c,d,blks[i+9],5,568446438);   d=gg(d,a,b,c,blks[i+14],9,-1019803690);
    c=gg(c,d,a,b,blks[i+3],14,-187363961); b=gg(b,c,d,a,blks[i+8],20,1163531501);
    a=gg(a,b,c,d,blks[i+13],5,-1444681467);d=gg(d,a,b,c,blks[i+2],9,-51403784);
    c=gg(c,d,a,b,blks[i+7],14,1735328473); b=gg(b,c,d,a,blks[i+12],20,-1926607734);
    a=hh(a,b,c,d,blks[i+5],4,-378558);     d=hh(d,a,b,c,blks[i+8],11,-2022574463);
    c=hh(c,d,a,b,blks[i+11],16,1839030562);b=hh(b,c,d,a,blks[i+14],23,-35309556);
    a=hh(a,b,c,d,blks[i+1],4,-1530992060); d=hh(d,a,b,c,blks[i+4],11,1272893353);
    c=hh(c,d,a,b,blks[i+7],16,-155497632); b=hh(b,c,d,a,blks[i+10],23,-1094730640);
    a=hh(a,b,c,d,blks[i+13],4,681279174);  d=hh(d,a,b,c,blks[i+0],11,-358537222);
    c=hh(c,d,a,b,blks[i+3],16,-722521979); b=hh(b,c,d,a,blks[i+6],23,76029189);
    a=hh(a,b,c,d,blks[i+9],4,-640364487);  d=hh(d,a,b,c,blks[i+12],11,-421815835);
    c=hh(c,d,a,b,blks[i+15],16,530742520); b=hh(b,c,d,a,blks[i+2],23,-995338651);
    a=ii(a,b,c,d,blks[i+0],6,-198630844);  d=ii(d,a,b,c,blks[i+7],10,1126891415);
    c=ii(c,d,a,b,blks[i+14],15,-1416354905);b=ii(b,c,d,a,blks[i+5],21,-57434055);
    a=ii(a,b,c,d,blks[i+12],6,1700485571); d=ii(d,a,b,c,blks[i+3],10,-1894986606);
    c=ii(c,d,a,b,blks[i+10],15,-1051523);  b=ii(b,c,d,a,blks[i+1],21,-2054922799);
    a=ii(a,b,c,d,blks[i+8],6,1873313359);  d=ii(d,a,b,c,blks[i+15],10,-30611744);
    c=ii(c,d,a,b,blks[i+6],15,-1560198380);b=ii(b,c,d,a,blks[i+13],21,1309151649);
    a=ii(a,b,c,d,blks[i+4],6,-145523070);  d=ii(d,a,b,c,blks[i+11],10,-1120210379);
    c=ii(c,d,a,b,blks[i+2],15,718787259);  b=ii(b,c,d,a,blks[i+9],21,-343485551);
    [a,b,c,d]=[safeAdd(a,oa),safeAdd(b,ob),safeAdd(c,oc),safeAdd(d,od)];
  }
  return [a,b,c,d].map(n=>{const h=(n<0?n+0x100000000:n).toString(16).padStart(8,'0');return h.match(/../g).reverse().join('');}).join('');
}

// Bilibili WBI signing. Keys come from /x/web-interface/nav.
// Use var (not const) so re-injection via executeScript files: doesn't throw
// "already declared" — const/let in module scope throw on re-declaration.
var WBI_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

function wbiSign(params, imgKey, subKey) {
  const raw = imgKey + subKey;
  const mixinKey = WBI_ENC_TAB.map(i => raw[i] || '').join('').slice(0, 32);
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts: String(wts) };
  const sorted = {};
  for (const k of Object.keys(all).sort()) sorted[k] = String(all[k]).replace(/[!'()*]/g, '');
  const query = new URLSearchParams(sorted).toString().replace(/\+/g, '%20');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

// Active fetch: called when background sends BILIBILI_FETCH_NOW.
// Reads window.__INITIAL_STATE__ for metadata, then calls WBI-signed
// player API to get subtitle URLs, then fetches subtitle JSON.
async function activeFetchBilibiliVideo() {
  // bvid from the URL path first — robust against B站's occasional restructuring
  // of the __INITIAL_STATE__ SSR global (the old code threw when it disappeared,
  // silently falling back to a generic DOM extraction that dumped the whole
  // channel feed instead of the video).
  const pathBvid = (window.location?.pathname || '').match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1] || '';
  const vd = window.__INITIAL_STATE__?.videoData;
  const bvid = pathBvid || vd?.bvid;
  if (!bvid) throw new Error('no bvid on page');

  // Video meta: prefer __INITIAL_STATE__.videoData; when it's absent or lacks a
  // cid (SSR restructure), fall back to the view API — the same endpoint the
  // passive interceptor watches, no WBI signing required, and its `data` shape
  // matches videoData field-for-field.
  let meta = vd;
  if (!meta || !meta.cid) {
    try {
      const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: 'include' });
      if (viewRes.ok) {
        const viewData = await viewRes.json();
        if (viewData?.code === 0 && viewData.data) meta = viewData.data;
      }
    } catch (_) {}
  }
  if (!meta) throw new Error('no video meta');

  const video = {
    bvid: meta.bvid || bvid,
    title: (meta.title || '').trim(),
    desc: (meta.desc || '').trim(),
    author: (meta.owner?.name || '').trim(),
    tname: (meta.tname || '').trim(),
    duration: meta.duration || 0,
    cid: meta.pages?.[0]?.cid || meta.cid || 0,
    stat: {
      view: meta.stat?.view || 0,
      like: meta.stat?.like || 0,
      coin: meta.stat?.coin || 0,
      favorite: meta.stat?.favorite || 0,
      reply: meta.stat?.reply || 0,
    },
    rawAt: Date.now()
  };

  if (!video.cid) return video;

  // Get WBI keys from nav API (no signing needed, just cookies).
  const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
  if (!navRes.ok) return video;
  const nav = await navRes.json();
  const imgUrl = nav?.data?.wbi_img?.img_url || '';
  const subUrl = nav?.data?.wbi_img?.sub_url || '';
  const imgKey = imgUrl.split('/').pop().split('.')[0];
  const subKey = subUrl.split('/').pop().split('.')[0];
  if (!imgKey || !subKey) return video;

  // Sign and call player API to get subtitle list.
  const qs = wbiSign({ bvid: video.bvid, cid: String(video.cid) }, imgKey, subKey);
  const playerRes = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${qs}`, { credentials: 'include' });
  if (!playerRes.ok) return video;
  const playerData = await playerRes.json();

  // Re-use existing subtitle fetcher.
  const subtitles = playerData?.data?.subtitle?.subtitles;
  const transcript = await fetchBilibiliSubtitle(subtitles);
  if (transcript) video.transcript = transcript;

  // Fetch B站 AI summary — reuse WBI keys already retrieved above.
  try {
    const sumQs = wbiSign(
      { bvid: video.bvid, cid: String(video.cid), up_mid: String(video.upMid || 0) },
      imgKey, subKey
    );
    const sumRes = await fetch(
      `https://api.bilibili.com/x/web-interface/view/conclusion/get?${sumQs}`,
      { credentials: 'include' }
    );
    if (sumRes.ok) {
      const sumData = await sumRes.json();
      const summary = extractBilibiliSummary(sumData);
      if (summary) video.summary = summary;
    }
  } catch (_) {}

  return video;
}

// Note: chrome.runtime.onMessage.addListener is NOT available in MAIN world
// content scripts (only sendMessage is). The background calls activeFetchBilibiliVideo
// via chrome.scripting.executeScript({ world: 'MAIN' }) instead.

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isBilibiliViewUrl, isBilibiliPlayerUrl, extractBilibiliVideo, installBilibiliInterceptor, md5, wbiSign, activeFetchBilibiliVideo, fetchBilibiliSubtitle, readBilibiliMediaStreams, fetchFreshBilibiliStreams };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  installBilibiliInterceptor();
}

// Expose the stream reader to the page's MAIN world so the background's
// chrome.scripting.executeScript({world:'MAIN'}) can call it by reference
// (the func injected by executeScript can't import this module). Read on
// demand when the user opens the download panel - no caching, so the URLs
// are always fresh relative to the signed __playinfo__ at click time.
if (typeof window !== 'undefined') {
  window.__browsaGetBilibiliStreams = readBilibiliMediaStreams;
  window.__browsaFetchFreshBilibiliStreams = fetchFreshBilibiliStreams;
}
