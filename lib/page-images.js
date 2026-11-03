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

// 张数与体量上限与站点字节图（XHS/推特/Reddit）共用同一常数——
// lib/image-budget.js 的 SITE_IMAGES_*（2026-10-11 统一放开：两种管线在
// ATTACH_PAGE 汇入同一个附件条目，没有理由两套上限）。本管线的图更小
// （768px JPEG q0.72），预算很少先于张数触顶。
import { SITE_IMAGES_MAX_COUNT as MAX_IMAGES, SITE_IMAGES_BUDGET_CHARS } from './image-budget.js';
const MAX_CANDIDATES = 24;        // 候选扫描上限（正则按文档序取前 N 个；留出下载失败余量）
const MIN_WIDTH = 200;            // 图标/头像/分隔线过滤（解码后真实尺寸）
const MIN_HEIGHT = 120;
const MAX_WIDTH = 768;            // 压缩目标宽度上限
const JPEG_QUALITY = 0.72;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 8 * 1024 * 1024; // 单图下载上限（防异常大图撑爆内存）

/** 无信息量 alt（微信占位「图片」等）——锚点里不带，避免「[图N] 图片」这种读不出内容的标注。 */
const GENERIC_ALT_RE = /^(?:图片|图像|图|照片|image|img|photo|picture|screenshot|截图)(?:\.\w{1,5})?$/i;

// Referer 门禁图床：扩展上下文（SW 侧）取图 fetch 的头不受页面控制，这些 CDN
// 可能按「不像浏览器且无站内 Referer」拒件。2026-10-15 zhimg.com 同 IP 对照实测：
// curl UA 无/伪造 Referer 403，curl UA + 知乎 Referer 200，**浏览器 UA 无 Referer
// 也 200**——真扩展 SW 裸 fetch 现状可过（靠浏览器特征启发式），但那条启发式
// 收紧即静默降级，所以命中门表仍注入显式合同（知乎站内 Referer）：background
// 在下载前经 DNR session 规则挂上（lib/sidepanel/media-headers.js 的
// registerPageImageReferer），finally 移除。
export const IMAGE_CDN_REFERER_GATES = [
  { hostRe: /(^|\.)zhimg\.com$/i, urlFilter: 'zhimg', referer: 'https://www.zhihu.com/' },
];

/** 候选图 URL 里第一条命中的 Referer 门（无命中返回 null）。纯函数。 */
export function refererGateForImageUrls(urls) {
  for (const raw of urls || []) {
    try {
      const host = new URL(raw).hostname;
      const gate = IMAGE_CDN_REFERER_GATES.find((g) => g.hostRe.test(host));
      if (gate) return gate;
    } catch (_) { /* 非法 URL 跳过 */ }
  }
  return null;
}

/**
 * Markdown 里的代码区间 [start, end)（2026-11-03 第二批审计）：「文中的图」
 * 判定的单一 owner——collectMarkdownImages 与 inlinePageImages 的改写循环
 * 消费同一份区间，代码示例里的 ![alt](url) 不收集、不下载、不改写。
 * 覆盖 fenced block（``` 与 ~~~，闭合需同字符且长度 ≥ 开启、该行只有围栏
 * 字符；未闭合围栏视为延伸到文末）+ 行内 backtick run（CommonMark 等长配对，
 * 无匹配闭合的开启 run 按字面量处理）。刻意保守：4 空格缩进代码块不识别
 * （普通段落误判风险高于收益）。纯函数。
 */
export function codeSpanRanges(markdown) {
  const text = String(markdown || '');
  const ranges = [];
  let fence = null; // { ch, len, start }
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    if (!fence) {
      // ``` 围栏的 info string 不能含 backtick（CommonMark）——含则不是开启。
      if (m[1][0] === '`' && m[2].includes('`')) continue;
      fence = { ch: m[1][0], len: m[1].length, start: lineStart };
    } else if (m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) {
      ranges.push([fence.start, lineEnd]);
      fence = null;
    }
  }
  if (fence) ranges.push([fence.start, text.length]);
  // 行内 backtick run：跳过围栏内的，等长配对；配对成功的中间 run 一并吞掉。
  const runs = [];
  const runRe = /`+/g;
  let r;
  while ((r = runRe.exec(text)) !== null) {
    if (ranges.some(([s, e]) => r.index >= s && r.index < e)) continue;
    runs.push({ start: r.index, end: r.index + r[0].length, len: r[0].length });
  }
  for (let i = 0; i < runs.length;) {
    let j = i + 1;
    while (j < runs.length && runs[j].len !== runs[i].len) j++;
    if (j < runs.length) { ranges.push([runs[i].start, runs[j].end]); i = j + 1; }
    else i++; // 无等长闭合 → 字面量 backtick，不是代码
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

/** match.index 是否落在代码区间内（收集与改写共用同一判定）。 */
function inCodeSpan(ranges, index) {
  return ranges.some(([s, e]) => index >= s && index < e);
}

/** 正文 Markdown 里的文章配图：绝对化 URL、去重、跳过 data:/blob: 与代码区间，按文档序。 */
export function collectMarkdownImages(markdown, baseUrl, { maxCandidates = MAX_CANDIDATES } = {}) {
  const out = [];
  const seen = new Set();
  const text = String(markdown || '');
  const codeRanges = codeSpanRanges(text);
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  let m;
  while ((m = re.exec(text)) !== null && out.length < maxCandidates) {
    if (inCodeSpan(codeRanges, m.index)) continue;
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

// ── SSRF 门禁（2026-10-23，借鉴 usememos/web-clipper 的附件下载防护）──────────
// 页面配图 URL 本质是页面内容（collectMarkdownImages 收文章 Markdown 里任意
// http(s) URL），恶意/被投毒页面可以让扩展 SW 替它向内网发 GET：云 metadata
// 端点（169.254.169.254）、内网管理面、loopback 服务。命中黑名单的 URL 按
// 「下载失败」处理（fail-open：正文保留 ![alt](url) 原文，模型仍看得到 URL），
// 绝不发出请求。DNS rebinding 不在此门范围内（SW fetch 的解析在浏览器侧，
// 扩展拿不到解析结果；与 web-clipper 同一边界）。

const PRIVATE_HOST_SUFFIXES = ['.corp', '.home', '.internal', '.lan', '.local', '.localdomain'];

function blockedIpv4(hostname) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||  // CGNAT 100.64/10
    (a === 169 && b === 254) ||            // link-local（含云 metadata 169.254.169.254）
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224                                // 组播 + 保留段
  );
}

/**
 * 页面配图下载的黑名单判定（纯函数，供测试）。公网 IP 字面量与普通域名放行；
 * data:/blob: 在 collect 阶段已被跳过，这里再拦一道协议外的输入。
 */
export function isBlockedPageImageUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch (_) { return true; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (url.username || url.password) return true;
  // 剥尾点（DNS 规范根锚形式）：URL 解析器只对 IP 字面量归一尾点，普通主机名
  // 保留——`metadata.google.internal.` / `localhost.` / `*.internal.` 在 GCP/内网
  // 照样解析到内部地址，却因尾点失配绕过下方所有 equality/suffix 检查（2026-11-03
  // 安全审计实测确认）。判定前统一去掉一个尾点。
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' || host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    PRIVATE_HOST_SUFFIXES.some((s) => host.endsWith(s))
  ) return true;
  if (host.includes(':')) {
    // IPv6 字面量（URL.hostname 保留方括号，上面已剥）：
    // - `^::`（首 hextet 为 0）整类拦：含 ::（未指定）、::1（loopback）、
    //   ::ffff:0:0/96（IPv4-mapped，点分与十六进制写法都归一到此），以及 ::/96
    //   IPv4-compatible——`[::127.0.0.1]` 被 URL 解析器归一成 `::7f00:1`，不含
    //   ffff: 段，旧门放行（2026-11-03 审计实测）。公网 IPv6 属 2000::/3，不以
    //   :: 开头，故不误伤。
    // - fc00::/7 唯一本地、fe80::/10 链路本地另拦。
    return /^::/.test(host) || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  // 单标签主机名通常经私有 DNS 搜索域解析（corp 内网惯例），同样拦。
  if (!host.includes('.')) return true;
  return blockedIpv4(host);
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

/** 流式量尺寸：超限立即 cancel，不把整只异常大图读进内存再丢弃。 */
async function readBoundedBlob(res) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const blob = await res.blob();
    if (!blob.size || blob.size > MAX_BYTES) return null;
    if (blob.type && !/^image\//i.test(blob.type)) return null;
    return blob;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch (_) { /* already aborted */ }
      return null;
    }
    chunks.push(value);
  }
  if (!total) return null;
  return new Blob(chunks);
}

/**
 * 下载一张页面配图并压缩；任何失败返回 null（绝不抛出）。
 * 「SW 侧下载一张图」的安全包络单点（2026-11-03 第二批审计导出）：
 * SSRF 门 + redirect:'error' + credentials:'omit' + content-type 前置 +
 * 流式量上限。site-fallbacks 的 syndication 照片循环是第二个消费者。
 */
export async function fetchImageAsDataURL(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  // SSRF 门（isBlockedPageImageUrl）：内网/loopback/metadata 目标连请求都不发。
  if (isBlockedPageImageUrl(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // redirect:'error'：manual 模式读不到 Location，无法对 302 目标逐跳过
    // SSRF 门——公网配图的跳转几乎只出现在热链占位/协议升级，宁可让这类图
    // 降级成原文里的 ![alt](url)，不留「公网 URL 跳内网」的绕过面。
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) return null;
    // content-type 前置检查：非图片在读 body 之前就放弃。头缺失时靠
    // readBoundedBlob 里的 blob.type / 解码失败兜底（部分 CDN 不回 content-type）。
    const headType = res.headers?.get?.('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (headType && !headType.startsWith('image/')) return null;
    const blob = await readBoundedBlob(res);
    if (!blob) return null;
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
export async function inlinePageImages(markdown, { baseUrl, fetchImpl = fetch, timeoutMs, budgetChars: budgetCharsOpt = SITE_IMAGES_BUDGET_CHARS } = {}) {
  const text = String(markdown || '');
  const candidates = collectMarkdownImages(text, baseUrl);
  if (!candidates.length) return { text, figures: [] };
  const results = await Promise.allSettled(
    candidates.map((c) => fetchImageAsDataURL(c.url, { fetchImpl, timeoutMs })),
  );
  // 成功者按文档序取前 MAX_IMAGES 张、总量不超预算（张数与体量先到者停），
  // 顺序与 [图N] 编号一致。
  const figures = [];
  let budgetChars = budgetCharsOpt;
  for (let i = 0; i < candidates.length && figures.length < MAX_IMAGES; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    if (budgetChars - r.value.length < 0) break;
    budgetChars -= r.value.length;
    figures.push({ url: r.value });
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
  // 落选的成功图（超出张数上限或体量预算）：原位收敛为 [图片]（URL 不残留）。
  const cappedUrls = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const ok = results[i].status === 'fulfilled' && results[i].value;
    if (ok && !numByUrl.has(candidates[i].url)) cappedUrls.add(candidates[i].url);
  }
  const consumed = new Set();
  const out = [];
  let last = 0;
  // 与 collectMarkdownImages 消费同一份代码区间：示例语法不改写，也绝不
  // 抢锚（同 URL 在围栏示例与正文真图各出现一次时，锚定正文那次）。
  const codeRanges = codeSpanRanges(text);
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (inCodeSpan(codeRanges, m.index)) continue;
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
