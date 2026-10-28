// lib/handlers/attach-page.js — the ATTACH_PAGE case body, extracted from
// background.js (2026-10-28, ub-mode 体检 #6 / architecture-review candidate
// #2: the case was the last 372-line holdout against the 「大 case 体在
// lib/handlers/」 rule; #1 was attach-store.js).
//
// Contract: the ROUTER owns tabId resolution (and the no-tabId guard) and
// passes its resident plumbing — siteCacheCtx (site-cache/session restore)
// and pushDeepProgress (nav ports) live in background.js because the whole
// SW shares them. This module owns the attach flow itself:
// extraction → jina/deep/highwire escalation → deferred handoffs →
// llms.txt/video-note baking → [图N] inlining → storeAttachment.
//
// Behavior is unchanged; test/attach-page-*.test.mjs drives it through
// background's handle() exactly as before.

import * as storage from '../storage.js';
import { modeCaps, DEFERRED_HANDOFFS } from '../attach-modes.js';
import { ensureReadabilityInjected } from '../readability-injector.js';
import { extractActiveTab, tryXActiveFallback, autoJinaFallbackWarranted, fetchHighwireTablesInPageWorld } from '../page-extractor.js';
import { maybeDeepExtract } from '../agentic-extract.js';
import { inlinePageImages, collectMarkdownImages, refererGateForImageUrls } from '../page-images.js';
import { registerPageImageReferer, removePageImageReferer } from '../sidepanel/media-headers.js';
import { interleaveImageParts } from '../message-builder.js';
import { VIDEO_NOTE_HINT } from '../constants.js';
import { storeAttachment } from './attach-store.js';
import { buildAsrPendingCtx } from './attach-asr-pending.js';
import { checkAndRecordAttachChange } from './attach-change-tracker.js';
import { ASR_SUBTITLE_SOURCE } from './attach-asr.js';
import { fetchLlmsTxt } from './chat-handler.js';
import { selectionCache } from './selection-cache.js';

// 选区 HTML → Markdown（页面 MAIN world）。Turndown/GFM 由 ensureReadabilityInjected
// 注入为页面全局（未注入成功时 TurndownService undefined → 抛错，调用方回退纯文本）。
// 自包含：executeScript func 序列化只带函数本体。转换在分离容器上进行，只读传入
// 的 HTML 字符串——导航后的页面也能转换。
function selectionHtmlToMarkdownInPage(html) {
  const div = document.createElement('div');
  div.innerHTML = String(html || '');
  div.querySelectorAll('script, style, noscript, button, input, select, textarea').forEach((el) => el.remove());
  if (typeof TurndownService === 'undefined') throw new Error('turndown not injected');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', linkStyle: 'inlined' });
  if (typeof TurndownPluginGfm !== 'undefined' && TurndownPluginGfm && TurndownPluginGfm.gfm) td.use(TurndownPluginGfm.gfm);
  return td.turndown(div);
}

// llms.txt — fetched ONCE at attach time and baked into the stored
// page-context text (see ATTACH_PAGE), keyed to the ATTACHED page's own URL.
// It used to be injected into the per-turn system prompt from whatever tab was
// active at message time, which (a) invalidated the KV/prompt prefix cache on
// every origin change (the "dynamic system prompt" anti-pattern from
// ai-agent-book chapter 2 — same failure as a `Current time: {{now}}` line in
// the system prompt) and (b) could deliver site instructions for a page the
// user never attached. Baked into the attach text instead, it rides through
// history exactly like the page body — auto-summarize, image compaction, and
// session export all treat it as normal content. Returns the (possibly new)
// ctx; a no-op when llms.txt is disabled, the URL is unparseable/non-http(s),
// or the origin doesn't publish an llms.txt.
// Exported for the background re-export (test/attach-llms-txt.test.mjs
// destructures them from background.js — the import surface predates the move).
export async function withSiteInstructions(ctx, all) {
  if (all.llmsTxtEnabled === false) return ctx;
  const url = ctx?.meta?.url;
  if (!url || !/^https?:\/\//.test(url)) return ctx;
  const instructions = await fetchLlmsTxt(url);
  if (!instructions) return ctx;
  let site = url;
  try { site = new URL(url).origin; } catch (_) {}
  return Object.assign({}, ctx, {
    text: `[Site instructions from ${site}/llms.txt]\n${instructions}\n\n${ctx.text || ''}`
  });
}

// Video-note formatting instruction — baked into youtube/bilibili page-context
// text at attach time (see ATTACH_PAGE / ATTACH_ASR_CONFIRM). It used to live
// in the per-turn system prompt, present only when a video was attached — a
// conditional dynamic prefix that split the KV/prompt cache key between
// "video session" and "normal session" (same anti-pattern as llms.txt, cf.
// ai-agent-book chapter 2). Rides in the trajectory like the transcript itself.

export function withVideoNote(ctx) {
  return Object.assign({}, ctx, {
    text: `${ctx.text || ''}\n\nNote: ${VIDEO_NOTE_HINT}`
  });
}

export async function handleAttachPage(msg, sender, { tabId, siteCacheCtx, pushDeepProgress }) {
  // User explicitly clicked "📎 Attach page". Extract the current page,
  // save it to global history as a user message, and return the result
  // so the side panel can render a context bubble.
  const all = await storage.getAll();
  const mode = msg.mode || all.contextMode || 'reader';
  try {
    let ctx;
    // For 'selected' mode, use the cached selection (captured before focus
    // shifted to the side panel, which clears window.getSelection()).
    if (mode === 'selected') {
      // Prefer the live cache; fall back to msg.text (passed explicitly by
      // handleSelectionAction when the SW was sleeping and SELECTION_CACHE
      // was dropped — right-click / toolbar path always has the text).
      // Cache values are {text, html} since the selection-structure pass;
      // a bare string means a pre-upgrade in-memory entry (same SW life).
      const cached = selectionCache.get(tabId);
      const cachedText = (typeof cached === 'string' ? cached : cached?.text) || msg.text || '';
      const cachedHtml = (typeof cached === 'object' && cached?.html) || '';
      // Stale-cache guard: a selection captured on page A must not be
      // attached under whatever page B is showing now (the entry is keyed
      // only by tabId and survives navigation). Compare origins; when they
      // differ, prefer the explicitly-passed text (right-click / toolbar,
      // which carry the current selection) and drop the stale HTML.
      const cachedUrl = (typeof cached === 'object' && cached?.url) || '';
      const liveUrl = (sender?.tab?.url) || msg.tabUrl || '';
      const sameOrigin = (() => {
        if (!cachedUrl || !liveUrl) return true; // unknown → don't second-guess
        try { return new URL(cachedUrl).origin === new URL(liveUrl).origin; } catch (_) { return true; }
      })();
      if (!sameOrigin && !msg.text) {
        selectionCache.delete(tabId);
        return { ok: false, error: 'Selection is from a different page. Select text again, then click 📎.' };
      }
      const usableCachedText = sameOrigin ? cachedText : (msg.text || '');
      const usableCachedHtml = sameOrigin ? cachedHtml : '';
      if (usableCachedText && cached) selectionCache.set(tabId, cached); // keep in sync
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const meta = tab ? { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl || '' } : { url: '', title: '', favIconUrl: '' };
      if (!usableCachedText) return { ok: false, error: 'No text selected. Select some text on the page first, then click 📎.' };
      ctx = {
        meta, mode: 'selected',
        text: usableCachedText,
        truncated: { rawTextLength: usableCachedText.length, textLength: usableCachedText.length, wasCapped: false }
      };
      // 选区附加保留结构（2026-10-07，移植自 EdgeEver 的 selection clip）：捕获时
      // 存的选区 HTML 在页面 MAIN world 里经 Turndown（ensureReadabilityInjected
      // 注入的页面全局）转 Markdown——表格/列表/链接结构进上下文，纯文本全部丢失
      // 的那类信息不再丢。转换在分离容器上进行，与当前页面内容无关（导航过也能转）；
      // 任何一步失败都保持纯文本（md 长度 sanity 门：明显短于纯文本视为转换失真）。
      if (usableCachedHtml) {
        try {
          await ensureReadabilityInjected(tabId).catch(() => {});
          const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: selectionHtmlToMarkdownInPage,
            args: [usableCachedHtml]
          });
          const md = String(res?.result || '').trim();
          if (md && md.length >= usableCachedText.length * 0.5) {
            ctx.text = md;
            // `format` is the channel buildPageContextText renders into the
            // header ("Mode: selected | markdown" — model-facing provenance
            // that the text is structured Markdown). The old `selectedFormat`
            // stamp had zero consumers (2026-10-11 audit).
            ctx.format = 'markdown';
          }
        } catch (_) { /* fail-open: plain text stands */ }
      }
    } else if (mode === 'jina') {
      // Jina Reader: fetch clean Markdown from r.jina.ai/{url}
      // Runs in the service worker — no CORS restrictions, no cookies sent.
      // Best for paywalled/JS-heavy pages where Readability gives poor results.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab?.url) return { ok: false, error: 'Cannot get tab URL' };
      if (!/^https?:\/\//.test(tab.url)) return { ok: false, error: 'Jina Reader only works on http/https pages' };
      // 推文 URL 先走 X 本站路径（activeXFetch + syndication 兜底，见
      // tryXActiveFallback）：r.jina.ai 是匿名服务端抓取，X 的推文页只
      // 拿得到登录墙、图片也丢（2026-10-16 用户报告），本站路径才是权威
      // 数据；拿不到再退回 jina。
      ctx = await tryXActiveFallback(tab, { url: tab.url, title: tab.title || '', favIconUrl: tab.favIconUrl || '' }).catch(() => null);
      if (!ctx) {
        const jinaUrl = 'https://r.jina.ai/' + tab.url;
        const resp = await fetch(jinaUrl, {
          headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' }
        }).catch(e => { throw new Error('Jina fetch failed: ' + e.message); });
        if (!resp.ok) throw new Error(`Jina Reader returned ${resp.status} for this page`);
        const markdown = await resp.text();
        if (!markdown?.trim()) return { ok: false, error: 'Jina Reader returned empty content' };
        ctx = {
          meta: { url: tab.url, title: tab.title || '', favIconUrl: tab.favIconUrl || '' },
          mode: 'jina',
          text: markdown,
          truncated: { rawTextLength: markdown.length, textLength: markdown.length, wasCapped: false }
        };
      }
    } else {
      // auto and reader modes may need Readability; dom/full don't
      if (mode === 'reader' || mode === 'auto') await ensureReadabilityInjected(tabId).catch(() => {});
      // Host for cache selection comes from the live tab (ctx doesn't
      // exist yet here) — without it a stale entry from the previous site
      // in this tab shadowed the live one.
      const tabForCache = await chrome.tabs.get(tabId).catch(() => null);
      ctx = await extractActiveTab({
        mode,
        tabId,
        maxTextChars: all.maxTextChars,
        ...(await siteCacheCtx(tabId, msg.url || tabForCache?.url || '')),
        query: msg.query || '',
        preClean: true
      });
      if (!ctx) return { ok: false, error: 'extraction returned null' };

      // Auto mode silent Jina fallback: if local extraction FAILED, try
      // r.jina.ai as last resort and adopt only if it returns more.
      // Jina runs on their servers without user cookies, so it's only
      // useful for public pages. We set autoMode='jina' so the UI label
      // shows "auto/jina" rather than the empty/failed local mode.
      // 失败判据用 page-extractor 的 autoJinaFallbackWarranted（2026-10-16
      // 正解化）：绝对下限 + 相对亏空（页面 body.innerText 量做参照），
      // 替代旧的单看 <200 字符——短页面不再误判、大页面的半失败反而开始
      // 被救援。站点合成产物（siteSynthesized）永不回退。
      let jinaWarranted = false;
      if (mode === 'auto' && !ctx.siteSynthesized) {
        let bodyTextLen = null;
        if ((ctx.text?.length || 0) >= 200) {
          // 相对亏空层才需要页面参照：探 body.innerText 量（tab 没了/
          // 注入失败 → null → 相对层失效，绝对层照旧）。
          try {
            const [probe] = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => (document.body?.innerText || '').length,
            });
            bodyTextLen = typeof probe?.result === 'number' ? probe.result : null;
          } catch (_) { /* fail-open */ }
        }
        jinaWarranted = autoJinaFallbackWarranted({
          textLen: ctx.text?.length || 0,
          siteSynthesized: ctx.siteSynthesized,
          bodyTextLen,
        });
      }
      if (jinaWarranted) {
        try {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (tab?.url && /^https?:\/\//.test(tab.url)) {
            const resp = await fetch('https://r.jina.ai/' + tab.url, {
              headers: { 'Accept': 'text/plain', 'X-Return-Format': 'markdown' }
            });
            if (resp.ok) {
              const markdown = await resp.text();
              if (markdown?.trim().length > (ctx.text?.length || 0)) {
                ctx = Object.assign({}, ctx, {
                  autoMode: 'jina',
                  text: markdown,
                  truncated: { rawTextLength: markdown.length, textLength: markdown.length, wasCapped: false }
                });
              }
            }
          }
        } catch (_) { /* Jina fallback is best-effort; ignore errors */ }
      }

      // Deep extraction (auto-escalation): when the heuristic pass
      // reports content it could not reach (URL pagination / load-more /
      // leftover collapsed expanders), finish the job — walk next pages
      // in a background tab and let the active provider click through
      // what the heuristics missed. Provider-agnostic, hard-capped, and
      // fail-open: any null/throw keeps the baseline result above.
      // Generic modes only — site fast paths own their extraction.
      if (modeCaps(ctx.mode).deepExtract && all.deepExtractEnabled !== false) {
        try {
          const deep = await maybeDeepExtract({
            tabId,
            ctx,
            textCap: all.maxTextChars,
            query: msg.query || '',
            redoMode: ctx.autoMode || ctx.mode,
            sendProgress: (text) => pushDeepProgress(tabId, text)
          });
          if (deep) {
            ctx.text = deep.text;
            ctx.truncated.textLength = deep.text.length;
            ctx.deepExtract = { clicks: deep.clicks, pages: deep.pages };
          }
        } catch (_) { /* fail-open: baseline result wins */ }
      }

      // HighWire tables (biorxiv/medrxiv 及同平台期刊，2026-10-25)：该平台把
      // 表格预渲染成 GIF 藏在 XHR expansion 端点后，主 DOM 只有
      // [data-table-url] 占位与 caption——reader 正文里表格数据缺失。
      // extractInPageWorld 已计数占位（highwireTableCount），>0 时回页面
      // fetch expansion 提取表格图 URL，以 ![Table N: 标题](url) 追加进
      // 文本——下方 inlineImages 分支会把它们与正文配图一起转成 [图N]
      // vision 附件，alt 文本（表格标题）留在锚点行供模型文本面阅读。
      // 全程 fail-open：探测 0 / 注入失败 / 无图 → 原文照旧。
      // 必须在 deepExtract 之后（deep 可能整体重写 ctx.text）、
      // inlineImages 之前（注入的图要走 [图N] 转换）。
      if ((mode === 'reader' || mode === 'auto') && ctx.highwireTableCount > 0 && !ctx.siteSynthesized) {
        try {
          const [tablesRes] = await chrome.scripting.executeScript({
            target: { tabId },
            func: fetchHighwireTablesInPageWorld,
          });
          const tables = tablesRes?.result;
          if (Array.isArray(tables) && tables.length) {
            // alt 进 [图N] 锚点行（模型文本面可读）；] 与换行会破坏
            // markdown 图片语法，换成空格。URL 两侧不加空格——
            // collectMarkdownImages 的捕获组不容忍前导空白。
            const figLines = tables
              .filter((t) => t && t.imageUrl)
              .map((t) => `![${String(t.alt || 'Table').replace(/[\]\n\r]/g, ' ')}](${t.imageUrl})`);
            if (figLines.length) {
              ctx.text = (ctx.text || '') +
                '\n\n## Tables\n\n' +
                'The tables below are rendered by the site itself as images (HighWire platform); their data is only available as pixels, not HTML.\n\n' +
                figLines.join('\n\n');
            }
          }
        } catch (_) { /* fail-open: caption-only text is the floor */ }
      }
    }
    // Deferred-storage handoffs (screenshot crop / pdf.js text / docling
    // office conversion): history storage is deferred until the sidepanel
    // confirms via the matching ATTACH_*_CONFIRM message. One table
    // (lib/attach-modes.js) drives both this check and the sidepanel's
    // dispatch, so a new deferred mode is one row, not two if-chains.
    // Screenshot keys off the REQUEST mode (the mocked/extraction ctx may not
    // carry mode); pdf/office pendings key off ctx.mode — the request mode is
    // never 'pdf-pending'/'office-pending', so the OR is exact, not loose.
    const handoff = DEFERRED_HANDOFFS.find((h) => (ctx.mode === h.mode || mode === h.mode) && ctx[h.field]);
    if (handoff) {
      return { ok: true, ctx };
    }
    // Bilibili / YouTube video WITHOUT subtitles + ASR enabled: hand off to
    // sidepanel for the ASR pipeline (download audio in page-world -> upload to 火山方舟
    // Files API -> poll -> Responses API transcript). Deferred storage until
    // ATTACH_ASR_CONFIRM, mirroring the pdf-pending handoff. The audio stream
    // URL is read fresh via the MAIN-world-exposed reader so the signed URL is
    // valid at handoff time. Detection keys off the structured noTranscript
    // flag (from synthesizeBilibiliResult / synthesizeYouTubeResult), NOT the
    // `## 字幕`/`*(No captions...)*` text marker — auto mode's silent Jina
    // fallback can rewrite ctx.text and drop the marker.
    // `all.asr.subtitleSource === 'asr'` additionally forces the ASR handoff even
    // for videos that ALREADY have subtitles (user opted to prefer ASR
    // subtitles over low-quality originals — the strip/replace happens in the
    // sidepanel at ATTACH_ASR_CONFIRM time, keeping ctx.text intact for the
    // fail-open fallback).
    // xiaoyuzhou (podcast) joins the ASR handoff too — episodes never carry
    // transcripts, so synthesizeXiaoyuzhouResult always sets noTranscript.
    const isVideoPlatform = ctx.mode === 'bilibili' || ctx.mode === 'youtube' || ctx.mode === 'xiaoyuzhou';
    if (isVideoPlatform && all.asr?.enabled && (ctx.noTranscript || all.asr.subtitleSource === ASR_SUBTITLE_SOURCE.ASR)) {
      const asrCtx = await buildAsrPendingCtx(tabId, ctx);
      if (asrCtx) return { ok: true, ctx: asrCtx };
      // ASR 已启用但 ctx 构建失败（小宇宙 enclosure/og:audio 两路都拿不到、
      // 视频平台拿不到流等）：与 ASR 未启用同样降级为「页面信息 + 无字幕
      // 提示」，不要无声无息地只存页面信息。
      ctx.noTranscriptHint = true;
    } else if (isVideoPlatform && ctx.noTranscript) {
      // Video WITHOUT subtitles AND ASR not enabled: keep the
      // current behavior (plain video-info attach) but flag the ctx so
      // the sidepanel can hint that this video has no subtitles and
      // that enabling ASR would auto-transcribe it.
      ctx.noTranscriptHint = true;
    }

    // Local, offline change detection: warn the model (not the UI, no
    // new chip/badge) when a re-attached page's content differs from the
    // last time it was attached. Keyed by (mode, url) rather than just
    // url -- comparing across different extraction modes for the same
    // page would produce false "changed" signals, since reader/dom/full
    // naturally yield different text for the same page.
    if (ctx.meta?.url && !modeCaps(ctx.mode).skipChangeTracking && (ctx.text || '').length > 50) {
      const changeInfo = await checkAndRecordAttachChange(`${ctx.mode}::${ctx.meta.url}`, ctx.text);
      if (changeInfo.changed) ctx.changedSinceLastAttach = changeInfo;
    }

    // llms.txt: fetch once per attach (NOT per chat turn) for the attached
    // page's own origin, and bake it into the stored page-context text.
    // This keeps the system prompt a byte-stable prefix (KV/prompt-cache
    // friendly) and ties site instructions to the page actually attached.
    // reader/dom/full/auto only: `selected` is a partial excerpt (quick
    // actions shouldn't pull in full site instructions), `jina` is a
    // third-party proxy, and the deferred paths (screenshot/pdf/asr) store
    // derived content — none should carry site instructions.
    if (modeCaps(ctx.mode).siteInstructions) {
      ctx = await withSiteInstructions(ctx, all);
    }
    // Video page-contexts (youtube/bilibili): append the video-note
    // formatting instruction to the stored text (same KV-cache rationale
    // as llms.txt — dynamic formatting hints ride in the trajectory, not
    // the static system prompt).
    if (modeCaps(ctx.mode).video) {
      ctx = withVideoNote(ctx);
    }

    // 页面配图（reader/auto/jina）：正文 Markdown 里的 ![alt](url) 原位转成
    // [图N] 锚点行，图片在 SW 下载压缩成 JPEG dataURL 随条目交错入库——与视频
    // 截图 / PDF figure 同一套 [图N] 引用协议（回答引用 [图N]，渲染端还原缩略图）。
    // 全程 fail-open：无图/下载失败/无解码环境保持原文，绝不阻塞附加。
    // dom/full 是树状文本（无 Markdown 图片语法）、selected 是局部摘录，不参与。
    if (modeCaps(ctx.mode).inlineImages && ctx.text) {
      try {
        // Referer 门禁图床（zhimg.com 实测：不像浏览器且无站内 Referer
        // 才 403；显式注入知乎 Referer 把合同钉死，不赌 CDN 的浏览器
        // 特征启发式）：命中门表就先挂 DNR 注入规则、finally 移除——
        // 与整条管线同一 fail-open 精神。
        const gate = refererGateForImageUrls(
          collectMarkdownImages(ctx.text, ctx.meta?.url || '').map((c) => c.url));
        if (gate) await registerPageImageReferer(gate);
        let inlined;
        try {
          inlined = await inlinePageImages(ctx.text, { baseUrl: ctx.meta?.url || '' });
        } finally {
          if (gate) await removePageImageReferer();
        }
        if (inlined.figures.length) {
          ctx.text = inlined.text
            + `\n\n（文中 [图N] 标记按顺序对应随附的 ${inlined.figures.length} 张页面配图；在回答中引用配图时请使用相同的 [图N] 标记。）`;
          ctx.pageFigures = inlined.figures;
        }
      } catch (e) {
        console.warn('browsa: page image inlining failed, keeping plain text:', e?.message);
      }
    }

    // All other modes: save to global history immediately, via the single
    // owner of the storage recipe (attachId = the panel 撤销 undo identity,
    // stamped on every entry; summarize kick; image-byte bounding).
    const pageFigures = Array.isArray(ctx.pageFigures) ? ctx.pageFigures : [];
    // 站点字节图（小红书/推特/Reddit：MAIN world 取到的 base64 随
    // ctx.imageBase64List 带回）。这些合成文本只带张数（「🖼 N 图」/
    // 「**配图**: N 张」），没有 [图N] 文内锚点 → interleaveImageParts
    // 落成 [text, ...images] 形状（PDF 无位置信息的同款兜底）。图片由此
    // 随 attach 条目入库并发往多模态 provider——v0.21.0 把请求重建搬到
    // history 条目后，buildMessages 的 pageContext 分支成了死路，这些
    // 字节一直被丢在落库之外（2026-10-11 用户报告小红书只有文字后修复）。
    const siteImageBytes = Array.isArray(ctx.imageBase64List) ? ctx.imageBase64List.filter(Boolean) : [];
    // Very long attachments (e.g. a 4-5 hour video's transcript) get
    // resent in FULL on every subsequent turn — the one-time chunk/
    // summarize/merge pass here is cheaper than paying that cost on every
    // message. maybeSummarizeAttachment runs fire-and-forget AFTER the
    // response is prepared; the raw text is never rendered in the chat
    // bubble, so there's no UI to block on.
    const { attachId: pageAttachId } = await storeAttachment({
      pageContext: ctx,
      contentFrom: (contextText) => {
        const figures = pageFigures.length ? pageFigures : siteImageBytes;
        return figures.length ? interleaveImageParts(contextText, figures) : null;
      },
      // Stamp the video source on video page-contexts (youtube/bilibili)
      // so video-note replies can turn their [mm:ss] markers into clickable
      // seek links. Other pages have no seekable <video> target.
      videoSrc: modeCaps(ctx.mode).video
        ? { platform: ctx.mode, url: ctx.meta?.url || '', tabId }
        : null,
      log: (contextText) => `page attached — ${contextText.length} chars, mode=${mode}${pageFigures.length ? `, ${pageFigures.length} page images` : ''}${siteImageBytes.length ? `, ${siteImageBytes.length} site images` : ''}`,
    });
    return { ok: true, ctx, attachId: pageAttachId };
  } catch (e) {
    console.warn('browsa: ATTACH_PAGE failed', e);
    // `code` (when present) lets the side panel say the failure in the
    // user's own language instead of echoing a raw browser string; the
    // message stays English for logs and any other consumer.
    return { ok: false, error: e?.message || String(e), code: e?.code };
  }
}
