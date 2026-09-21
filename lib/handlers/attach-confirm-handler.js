// lib/handlers/attach-confirm-handler.js — the ATTACH_*_CONFIRM two-step
// handoff cases + ASR_FRESH_URLS, extracted verbatim from background.js's
// handle() switch (2026-09-20 refactor pass) so the dispatcher stays thin.
// Same grouped-cases-in-one-handler pattern as session-handler.js: these
// five are one family — they all finish a deferred attach pipeline the
// sidepanel started (screenshot crop / pdf.js text / docling office
// conversion / ASR transcript) and store the result, plus the playurl
// re-signing self-heal the ASR downloader calls on 403. Each case is a
// self-contained feature; grouping them keeps the family visible in one
// place instead of scattering five more files.
//
// 2026-09-20 deepening pass (architecture-review candidate #2): the storage
// recipe tail (attachId / entry assembly / append / image-byte bound /
// summarize kick) moved once more, into lib/handlers/attach-store.js — each
// case now normalizes its message into a pageContext and calls
// storeAttachment. Context headers all render through buildPageContextText
// (the PDF case's hand-rolled copy — including the arXiv header block
// sandwich — moved onto its new `headerBlock` param).
import { VIDEO_NOTE_HINT } from '../constants.js';
import { interleaveImageParts } from '../message-builder.js';
import { storeAttachment } from './attach-store.js';

export const ATTACH_CONFIRM_TYPES = new Set([
  'ATTACH_SCREENSHOT_CONFIRM',
  'ATTACH_PDF_CONFIRM',
  'ATTACH_OFFICE_CONFIRM',
  'ATTACH_ASR_CONFIRM',
  'ASR_FRESH_URLS',
]);

export async function handleAttachConfirm(msg) {
  switch (msg.type) {
    case 'ATTACH_SCREENSHOT_CONFIRM': {
      // Side panel confirmed the screenshot (possibly cropped). Store it now.
      const { imageDataUrl, metaUrl, metaTitle } = msg;
      if (!imageDataUrl) return { ok: false, error: 'no imageDataUrl' };
      // No summarize: pixels are compacted by boundUnseenImageBytes, not the
      // text summarizer.
      const { attachId } = await storeAttachment({
        pageContext: {
          meta: { url: metaUrl || '', title: metaTitle || '' },
          mode: 'screenshot',
          text: '(screenshot)',
        },
        contentFrom: (contextText) => [
          { type: 'text', text: contextText },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
        summarize: false,
      });
      return { ok: true, attachId };
    }

    case 'ATTACH_PDF_CONFIRM': {
      // Side panel finished pdf.js text extraction (or fell back to the
      // placeholder text on any parse failure/timeout) and hands us the final
      // text to store — mirrors ATTACH_SCREENSHOT_CONFIRM's two-step handoff.
      const { text, metaUrl, metaTitle, numPages, figureImages, arxivHeader } = msg;
      if (!text) return { ok: false, error: 'no text' };
      // arXiv enrichment: the sidepanel fetched the paper's Atom API metadata
      // (authors/categories/dates/DOI) and passes the formatted header block
      // in. It rides the context header (like URL/Title) — the model sees
      // provenance up front without it polluting the extracted body.
      const headerBlock = (typeof arxivHeader === 'string' && arxivHeader.trim()) ? arxivHeader.trim() + '\n' : '';
      let finalText = text;
      // Figure preservation (vision-capable providers): each extracted figure
      // arrives as {url, caption, page} (caption may be null). The caption is
      // the positional anchor - it is listed in the body text under a Figures
      // section (so the model can match "Figure 3" in the prose to the labeled
      // figure), and the image_url blocks follow in the SAME order. This gives
      // figure<->text correspondence WITHOUT page markers, which the (page-
      // boundary-less) wasm markdown cannot provide. Bare-string figureImages
      // (older callers / fallbacks) are normalized to {url} with no caption.
      const figures = (Array.isArray(figureImages) ? figureImages : [])
        .map((f) => (typeof f === 'string' ? { url: f } : f))
        .filter((f) => f && f.url);
      if (figures.length) {
        const lines = figures.map((f, i) =>
          `${i + 1}. ${f.caption || `Figure on page ${f.page || '?'}`}`);
        // PDF 文本提取不保留插图位置（wasm markdown 无占位），图片按文档顺序
        // 附在文末；引用约定与视频截图统一：回答中用 [图N]（N 为顺序号）。
        finalText += '\n\n## Figures\nThe attached images are the document\'s figures in document order — refer to them as [图N] (N = order below) when citing them in your reply:\n' + lines.join('\n');
      }
      // paper flag: paper-shaped analysis prompts downstream (auto-summarizer
      // digest, paper analysis card). arXiv URL is the current signal; the
      // sidepanel's detection result wins if it ever disagrees.
      let isPaper = !!msg.paper;
      if (!isPaper) {
        try { isPaper = /(^|\.)arxiv\.org$/i.test(new URL(metaUrl || '').hostname); } catch (_) { /* non-URL */ }
      }
      const { attachId, contextText } = await storeAttachment({
        pageContext: {
          meta: { url: metaUrl || '', title: metaTitle || '', paper: isPaper },
          mode: 'pdf',
          text: finalText,
          format: numPages ? `pdf-text, ${numPages} pages` : 'pdf-text',
          headerBlock,
        },
        contentFrom: figures.length
          ? (contextText) => [
              { type: 'text', text: contextText },
              ...figures.map((f) => ({ type: 'image_url', image_url: { url: f.url } }))
            ]
          : undefined,
        log: `pdf attached — ${finalText.length} chars, ${numPages || '?'} pages`,
      });
      // contextText = the exact text the model receives (header incl. the
      // arXiv block + body incl. the Figures section) — the sidepanel's
      // 检查 dialog displays this, not the pre-header pdfText it holds.
      return { ok: true, contextText, attachId };
    }

    case 'ATTACH_OFFICE_CONFIRM': {
      // Side panel finished docling.rs-wasm conversion (or fell back to the
      // placeholder on any conversion failure/timeout) and hands us the final
      // text to store — a slimmed ATTACH_PDF_CONFIRM: no figures (v1 keeps
      // docling's `<!-- image -->` placeholders), no arXiv enrichment. Same
      // two-step handoff, summarize pass-through, and attachId undo identity.
      const { text, metaUrl, metaTitle, ext } = msg;
      if (!text) return { ok: false, error: 'no text' };
      const format = ext ? `${ext}-text` : 'office-text';
      const { attachId, contextText } = await storeAttachment({
        pageContext: {
          meta: { url: metaUrl || '', title: metaTitle || '' },
          mode: 'office',
          text,
          // header omits the format note when the filename had no extension
          // (defensive path — extractOfficeContent floors ext at 'doc').
          format: ext ? format : undefined,
        },
        log: `office document attached — ${text.length} chars (${format})`,
      });
      return { ok: true, contextText, attachId };
    }

    case 'ATTACH_ASR_CONFIRM': {
      // Side panel finished the ASR pipeline (download audio -> upload to
      // 火山方舟 Files API -> poll -> Responses API ASR transcript) and hands
      // us the final subtitle text to store. Mirrors ATTACH_PDF_CONFIRM's
      // two-step handoff. The transcript is a `[mm:ss] text` block which, when
      // stamped with videoSrc below, becomes clickable seek links in the
      // rendered reply (linkifyTimestamps).
      const { text, metaUrl, metaTitle, platform, figureImages } = msg;
      if (!text) return { ok: false, error: 'no text' };
      let finalText = text;
      // 关键帧截图（视频精读专属，镜像 ATTACH_PDF_CONFIRM 的 figure 管线）：模型在
      // 精读文档里标记的 [截屏] 时刻，sidepanel 从视频 blob 抽帧后以 {url, caption}
      // 传入。captions 按顺序列进正文 Figures 段（模型把「截图 N」与 image_url 块
      // 一一对应），image_url 块随 history 每轮重发给多模态 provider。
      const figures = (Array.isArray(figureImages) ? figureImages : [])
        .map((f) => (typeof f === 'string' ? { url: f } : f))
        .filter((f) => f && f.url);
      if (figures.length) {
        // 锚点说明（VinQA 式引用约定）：精读文档的 [图N] 锚点行已带 caption 与
        // 时间戳，无需再列编号清单；这里只告诉模型对应关系与引用方式。
        finalText += `\n\n（文中 [图N] 标记按顺序对应随附的 ${figures.length} 张视频截图；在回答中引用截图时请使用相同的 [图N] 标记。）`;
      }
      // 原始平台由 sidepanel 透传（bilibili / youtube）——决定 mode、videoSrc.platform
      // 和日志标签。缺省回退 bilibili（兼容旧调用/测试）。
      const asrPlatform = (platform === 'youtube') ? 'youtube' : 'bilibili';
      // format 标签：音频转写 `${platform}-asr`（默认，兼容旧调用）；视频精读由
      // sidepanel 传 `${platform}-video`，让下游上下文/日志能区分两种产物。
      const asrFormat = (typeof msg.format === 'string' && msg.format) ? msg.format : `${asrPlatform}-asr`;
      const { attachId } = await storeAttachment({
        pageContext: {
          meta: { url: metaUrl || '', title: metaTitle || '' },
          mode: asrPlatform,
          text: `${finalText}\n\nNote: ${VIDEO_NOTE_HINT}`,
          format: asrFormat,
        },
        // 有关键帧时存成按 [图N] 锚点真交错的多模态 content（与 ATTACH_PDF_CONFIRM 同为
        // image_url 部件，但按锚点插入文档中间）。buildMessages 把 history 原样透传，
        // 截图每轮随文本一起发给多模态 provider。无截图保持纯字符串 content 形状不变。
        contentFrom: figures.length
          ? (contextText) => interleaveImageParts(contextText, figures)
          : undefined,
        // Stamp videoSrc so the [mm:ss] transcript renders as clickable seek
        // links (same platform/url/tabId shape as ATTACH_PAGE stamps on video
        // page-contexts).
        videoSrc: {
          platform: asrPlatform,
          url: metaUrl || '',
          tabId: msg.tabId ?? null,
        },
        // 阈值判定用未拼 hint 的转写正文（hint 约 340 字符，不该把临界条目推过线）。
        summarizeText: finalText,
        log: `${asrPlatform} asr attached — ${finalText.length} chars${figures.length ? `, ${figures.length} keyframes` : ''}`,
      });
      return { ok: true, attachId };
    }

    case 'ASR_FRESH_URLS': {
      // 播放地址过期（deadline 签名 m4s URL，CDN 无条件 403）的自愈重试：在页内重调
      // playurl API 换全新签名 URL。由 sidepanel 在下载 403 时触发一次；失败则返回
      // 原因由 sidepanel 走现有兜底（明示报错），不在此抛错。
      // bilibili 重调 playurl（bvid/cid + WBI 签名）；youtube 重调 /player（新 PO token）。
      const { tabId, platform } = msg;
      try {
        if (platform === 'youtube') {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            files: ['lib/content-scripts/youtube-content-script.js']
          });
          const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            // videoId parsed INSIDE the func from window.location (never the
            // service-worker closure — executeScript re-evaluates func in the
            // page, closures don't survive serialization; the countImages lesson).
            func: async () => {
              const freshFn = window.__browsaFetchFreshYouTubeStreams;
              const vid = (() => {
                try { return new URLSearchParams(window.location.search).get('v') || ''; }
                catch (_) { return ''; }
              })();
              if (typeof freshFn !== 'function' || !vid) {
                return { ok: false, error: '脚本未注入或缺 videoId' };
              }
              // Prefer pot-bearing audio streams from the page's real player
              // response (pot-less ANDROID URLs 403 — real test 2026-08-25).
              try {
                const potStreams = (typeof window.__browsaGetPlayerAudioStreams === 'function')
                  ? window.__browsaGetPlayerAudioStreams(vid)
                  : [];
                if (Array.isArray(potStreams) && potStreams.length > 0) {
                  const usable = potStreams.filter((s) => s.url && s.hasPot);
                  if (usable.length > 0) return { ok: true, streams: usable };
                }
              } catch (_) {}
              const fresh = await freshFn(vid);
              const audios = (Array.isArray(fresh.streams) ? fresh.streams : []).filter((s) => s.type === 'audio' && s.url);
              if (!audios.length) return { ok: false, error: 'player 返回空音频流' };
              return { ok: true, streams: audios };
            }
          });
          const r = res?.result;
          if (r?.ok && Array.isArray(r.streams) && r.streams.length) {
            console.log(`browsa: ASR_FRESH_URLS(youtube) ok — ${r.streams.length} fresh audio streams`);
            return { ok: true, streams: r.streams };
          }
          console.warn('browsa: ASR_FRESH_URLS(youtube) refresh failed:', r?.error || 'no result');
          return { ok: false, error: r?.error || 'no result' };
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['lib/content-scripts/bilibili-content-script.js']
        });
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          // bvid/cid 同样必须从页面世界内解析（closure 不跨序列化存活）。
          func: async () => {
            try {
              const pi = window.__playinfo__?.data || window.__playinfo__;
              // bvid 不能读 __playinfo__（playurl 响应无此字段，恒空串 → 自愈永远
              // 拦死）；与字幕提取同策略：URL path 优先，__INITIAL_STATE__ 兜底。
              const pathBvid = (window.location?.pathname || '').match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1] || '';
              const vd = window.__INITIAL_STATE__?.videoData;
              const bvid = pathBvid || pi?.bvid || vd?.bvid || '';
              const cid = pi?.cid || vd?.cid || 0;
              const freshFn = window.__browsaFetchFreshBilibiliStreams;
              if (typeof freshFn !== 'function' || !bvid || !cid) {
                return { ok: false, error: '脚本未注入或缺 bvid/cid（页面可能未播放过）' };
              }
              const fresh = await freshFn(bvid, cid);
              // 返回全部流类型（audio/video/muxed），由 background 按 msg.want 过滤——
              // 视频解析模式需要 video/muxed 流一起刷新（want 缺省 'audio'，纯 ASR 行为不变）。
              const all = (Array.isArray(fresh) ? fresh : []).filter((s) => s.url);
              if (!all.length) return { ok: false, error: 'playurl 返回空流列表' };
              return { ok: true, streams: all };
            } catch (e) {
              return { ok: false, error: String((e && e.message) || e) };
            }
          }
        });
        const r = res?.result;
        if (r?.ok && Array.isArray(r.streams) && r.streams.length) {
          // want: 'audio'（缺省，纯 ASR）只回音频流；'all' 连 video/muxed 一起回
          //（视频解析模式的自愈刷新，sidepanel 拿到后重新选流）。
          const want = msg.want === 'all' ? 'all' : 'audio';
          const filtered = want === 'all' ? r.streams : r.streams.filter((s) => s.type === 'audio');
          console.log(`browsa: ASR_FRESH_URLS ok — ${filtered.length} fresh ${want} streams`);
          return { ok: true, streams: filtered };
        }
        console.warn('browsa: ASR_FRESH_URLS refresh failed:', r?.error || 'no result');
        return { ok: false, error: r?.error || 'no result' };
      } catch (e) {
        console.warn('browsa: ASR_FRESH_URLS executeScript failed:', e?.message);
        return { ok: false, error: String((e && e.message) || e) };
      }
    }
  }
}
