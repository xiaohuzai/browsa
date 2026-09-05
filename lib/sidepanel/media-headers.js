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
