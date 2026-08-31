// lib/page-images.js — 页面配图 → [图N] 锚点。
//
// reader/auto/jina 模式提取出的正文 Markdown 里，文章配图本来就在原位：
// Turndown 把 <img> 转成 ![alt](url)（srcset 已被 page-extractor 换成高清候选）。
// 本模块把这些图下载、压成 JPEG dataURL，并把 Markdown 原位改写成 [图N] 锚点行，
// 交给 message-builder.interleaveImageParts 真交错入库——与视频截图 / PDF figure
// 同一套 [图N] 引用协议（模型回答引用 [图N]，渲染端 decorateFigureRefs 还原为
// 内联缩略图）。
//
// 设计红线（2026-08-29 用户否掉过 PDF 文末堆图方案）：锚点必须跟随图片在文中的
// 语义位置，不是文末清单。全程 fail-open：无图 / 下载失败 / 尺寸过小 / 无解码环境
// 都保持 Markdown 原样，绝不阻塞附加流程。

const MAX_IMAGES = 8;             // 随 history 每轮重发给多模态 provider，token 硬上限
const MAX_CANDIDATES = 16;        // 候选扫描上限（正则按文档序取前 N 个）
const MIN_WIDTH = 200;            // 图标/头像/分隔线过滤（解码后真实尺寸）
const MIN_HEIGHT = 120;
const MAX_WIDTH = 768;            // 压缩目标宽度上限
const JPEG_QUALITY = 0.72;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 8 * 1024 * 1024; // 单图下载上限（防异常大图撑爆内存）

/** 无信息量 alt（微信占位「图片」等）——锚点里不带，避免「[图N] 图片」这种读不出内容的标注。 */
const GENERIC_ALT_RE = /^(?:图片|图像|图|照片|image|img|photo|picture|screenshot|截图)(?:\.\w{1,5})?$/i;

/** 正文 Markdown 里的文章配图：绝对化 URL、去重、跳过 data:/blob:，按文档序。 */
export function collectMarkdownImages(markdown, baseUrl, { maxCandidates = MAX_CANDIDATES } = {}) {
  const out = [];
  const seen = new Set();
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  let m;
  while ((m = re.exec(String(markdown || ''))) !== null && out.length < maxCandidates) {
    const raw = (m[2] || '').trim();
    if (!raw || /^(data:|blob:)/i.test(raw)) continue;
    let abs = '';
    try { abs = new URL(raw, baseUrl || undefined).href; } catch (_) { continue; }
    if (!/^https?:/i.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, alt: (m[1] || '').trim() });
  }
  return out;
}

/** Uint8Array → base64（SW 无 FileReader；分块避免 apply 参数上限）。 */
function bufToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 图片 bytes → 压缩后的 JPEG dataURL。尺寸不足（图标/头像）返回 null；
 * 无 createImageBitmap/OffscreenCanvas（非 SW 环境）返回 null——调用方 fail-open。
 */
export async function blobToJpegDataURL(blob, {
  minWidth = MIN_WIDTH, minHeight = MIN_HEIGHT, maxWidth = MAX_WIDTH, quality = JPEG_QUALITY,
} = {}) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (_) {
    return null; // SVG、损坏图、不支持的格式
  }
  try {
    if (bmp.width < minWidth || bmp.height < minHeight) return null;
    const scale = Math.min(1, maxWidth / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff'; // PNG 透明底直接压 JPEG 会变黑底，先铺白
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return 'data:image/jpeg;base64,' + bufToBase64(await out.arrayBuffer());
  } catch (_) {
    return null;
  } finally {
    try { bmp.close?.(); } catch (_) { /* no-op */ }
  }
}

/** 下载一张页面配图并压缩；任何失败返回 null（绝不抛出）。 */
export async function fetchImageAsDataURL(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size || blob.size > MAX_BYTES) return null;
    if (blob.type && !/^image\//i.test(blob.type)) return null;
    return await blobToJpegDataURL(blob);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 Markdown 正文里的文章配图原位变成 [图N] 锚点行，返回 { text, figures }。
 * figures 与锚点编号一一对应（按文档序，无空洞）；同一 URL 只锚定首次出现；
 * 无信息量 alt（「图片」等占位词）不进锚点；超过 MAX_IMAGES 上限落选的成功图
 * 原位收敛为 `[图片]`（URL 对看不到像素的模型没有价值）；下载/解码失败的图
 * 保留 `![alt](url)` 原样（模型仍看得到 URL）。
 */
export async function inlinePageImages(markdown, { baseUrl, fetchImpl = fetch, timeoutMs } = {}) {
  const text = String(markdown || '');
  const candidates = collectMarkdownImages(text, baseUrl);
  if (!candidates.length) return { text, figures: [] };
  const results = await Promise.allSettled(
    candidates.map((c) => fetchImageAsDataURL(c.url, { fetchImpl, timeoutMs })),
  );
  // 成功者按文档序取前 MAX_IMAGES 张，顺序与 [图N] 编号一致。
  const figures = [];
  for (let i = 0; i < candidates.length && figures.length < MAX_IMAGES; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) figures.push({ url: r.value });
  }
  if (!figures.length) return { text, figures: [] };
  // 给成功下载的图按文档序编号：candidates[i] 与 results[i] 一一对应。
  const numByUrl = new Map();
  let next = 0;
  for (let i = 0; i < candidates.length && next < figures.length; i++) {
    if (results[i].status === 'fulfilled' && results[i].value) {
      numByUrl.set(candidates[i].url, ++next);
    }
  }
  // 超上限落选的成功图（抓取成功但排在第 MAX_IMAGES 位之后）：原位收敛为 [图片]。
  const cappedUrls = new Set();
  if (figures.length >= MAX_IMAGES) {
    for (let i = 0; i < candidates.length; i++) {
      const ok = results[i].status === 'fulfilled' && results[i].value;
      if (ok && !numByUrl.has(candidates[i].url)) cappedUrls.add(candidates[i].url);
    }
  }
  const consumed = new Set();
  const out = [];
  let last = 0;
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let abs = '';
    try { abs = new URL((m[2] || '').trim(), baseUrl || undefined).href; } catch (_) { continue; }
    if (cappedUrls.has(abs)) {
      out.push(text.slice(last, m.index));
      out.push('[图片]');
      last = m.index + m[0].length;
      continue;
    }
    const num = numByUrl.get(abs);
    if (!num || consumed.has(abs)) continue;
    consumed.add(abs);
    out.push(text.slice(last, m.index));
    const alt = (m[1] || '').trim();
    out.push(`[图${num}]${alt && !GENERIC_ALT_RE.test(alt) ? ' ' + alt : ''}`);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return { text: out.join(''), figures };
}
