// lib/sidepanel/media-headers.js
//
// ASR 媒体下载管线的 CDN 请求头注入（DNR session rule）——音频/视频两条管线
// 共用。这条通道是被真机验证过的唯一可靠下载方式：扩展上下文 fetch + 注入
// referer/origin/cookie。chrome.downloads 直接拉 CDN URL 的路子两次实测都失败
//（「无法从网站上提取文件」——下载请求的 initiator/resourceType 分类不可控，
// 注头落不落得到请求上不可依赖）。
//
// 产品决策（2026-09-05）：面向用户的右下角媒体下载功能整体移除——旁支需求
// 不值得长期背着第三方 CDN 的可靠性负担（YouTube 被 PO token 反爬判死，B 站
// 依赖登录态 cookie），browsa 的用户群要存媒体自有 cat-catch/yt-dlp。本模块
// 保留，服务 ASR/视频精读管线（喂模型的媒体获取与用户存盘无关）。

// 平台 CDN 的完整 cookie 串（含 HttpOnly 的 SESSDATA / SID——document.cookie
// 读不到，chrome.cookies 权限 + <all_urls> host_permissions 才能读全）。登录态 /
// 高清流缺 SESSDATA 会被 CDN 403。读不到返回空串（匿名可访问的流仍可下载）。
export async function readPlatformCookie(platform) {
  try {
    const url = platform === 'youtube' ? 'https://www.youtube.com' : 'https://www.bilibili.com';
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (_) {
    return '';
  }
}

// Deterministic media-rule ids (2026-10-17): these used to be
// `Math.floor(Math.random() * 4_999_999) + 1`, which cannot be cleaned up by
// anything except the caller's own `finally` — if the panel document was torn
// down mid-attach, a Cookie-injecting rule survived for the rest of the
// browser session. One id per platform + a startup sweep makes the leak
// self-healing (register still remove-then-add, so it stays idempotent).
export const MEDIA_RULE_IDS = { youtube: 9_000_002, bilibili: 9_000_003 };

/**
 * Remove every browsa-owned session DNR rule. Called on service-worker
 * startup: a rule left behind by a torn-down panel would otherwise keep
 * injecting platform cookies into this session's CDN requests.
 */
export async function sweepOrphanedMediaRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ours = rules
      .map((r) => r.id)
      .filter((id) => id === MEDIA_RULE_IDS.youtube || id === MEDIA_RULE_IDS.bilibili);
    if (ours.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ours });
  } catch (_) { /* DNR unavailable — nothing to sweep */ }
}

// 注册一条 session 规则，把 CDN 要求的头注到扩展自己发起的媒体请求上。
// cookie 传空串就不注入（保持请求原样）。
export async function registerMediaHeaders(ruleId, platform, cookie) {
  const isYt = platform === 'youtube';
  const referer = isYt ? 'https://www.youtube.com' : 'https://www.bilibili.com';
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: referer },
          // YouTube 的 googlevideo 拒绝 chrome-extension origin——必须改成
          // youtube.com（实测 403 根因之一）。B站 bilivideo 不校验 Origin，
          // 显式保留扩展 origin（与 ASR 管线已验证的行为一致）。
          { header: 'origin', operation: 'set', value: isYt ? referer : 'chrome-extension://' + chrome.runtime.id },
          ...(cookie ? [{ header: 'cookie', operation: 'set', value: cookie }] : []),
        ]
      },
      condition: {
        // 只作用于扩展上下文自己发起的请求（对齐 cat-catch 的
        // initiatorDomains 做法），不误伤页面自身的媒体请求。
        initiatorDomains: [chrome.runtime.id],
        // 整域匹配（非单个主机）：CDN 302 到镜像主机后规则仍命中——
        // 'bilivideo' 同时覆盖 .com / .cn（mcdn.bilivideo.cn /
        // upos-sz-*.bilivideo.com），'googlevideo' 覆盖 YouTube 各镜像。
        urlFilter: isYt ? 'googlevideo' : 'bilivideo',
        // 全量 resourceTypes：CDN 重定向保持原请求的 resourceType，
        // 必须全列出才能在重定向后带着注入的头存活。
        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other']
      }
    }]
  });
}

// 移除规则。session 规则随浏览器会话自清理，但主动移除避免积攒。
export async function removeMediaHeaders(ruleId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch (_) {}
}

// 页面配图的 Referer 门（2026-10-15，zhihu 附加回归修复）：zhimg.com 实测对
// 「不像浏览器且无站内 Referer」的请求 403（真扩展 SW 裸 fetch 靠浏览器特征
// 可过，但该启发式收紧即静默降级），命中 lib/page-images.js 的
// IMAGE_CDN_REFERER_GATES 门表就显式注入站内 Referer。与 ASR 的随机 ruleId
// 不同，这里用固定 id——附加是单飞操作（面板按钮附着期间禁用），register 内
// remove 同 id 保证幂等，调用方 finally 里 remove。
const PAGE_IMAGE_REFERER_RULE_ID = 9_000_001;

export async function registerPageImageReferer(gate) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [PAGE_IMAGE_REFERER_RULE_ID],
    addRules: [{
      id: PAGE_IMAGE_REFERER_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: gate.referer }],
      },
      condition: {
        // 只作用于扩展自己发起的请求（与 registerMediaHeaders 同一
        // initiatorDomains 做法），不碰页面自身的图片请求。
        initiatorDomains: [chrome.runtime.id],
        urlFilter: gate.urlFilter,
        resourceTypes: ['xmlhttprequest', 'other', 'image'],
      },
    }],
  });
}

export async function removePageImageReferer() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [PAGE_IMAGE_REFERER_RULE_ID] });
  } catch (_) {}
}
