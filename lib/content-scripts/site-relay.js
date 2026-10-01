// lib/content-scripts/site-relay.js — ISOLATED-world 信使（2026-10-01 批G，修活九/十站被动推送）。
//
// 背景：v0.19.1 把十个站点脚本挪进 MAIN world 以便补丁页面的 XHR/fetch——
// 但 MAIN world 没有 chrome.runtime，「抓到数据就推给后台」的那一半从此静默
// 死亡（SITE_CACHES 永远收不到信、小红书侧栏推送永不发生），直到 2026-10-01
// 审计才被发现。修法：MAIN 脚本抓到数据后 window.postMessage 出来，本脚本
// （ISOLATED，有 chrome.runtime）在同批站点上监听并转发给后台——SITE_MESSAGE_MAP
// 九键与 XHS_XHR_NOTE 接收器一直是活的，只等信来。
//
// 信任边界（刻意接受）：postMessage 无法区分「我们的 MAIN 脚本」与「页面自己」
// ——两者共享同一个 JS 世界。即被匹配站点上的页面可以伪造推送数据。这与页面
// 本就完全控制自己 API 返回内容是同一信任级别；数据最终走与正文提取相同的
// 消毒/附加管线，per-tab 缓存、仅在用户点 📎 附加该页时消费；type 不在后台
// 已知集合内的消息会被后台丢弃。
//
// 本文件必须保持零依赖、自包含（ISOLATED world 不能 import ES modules）。
if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
  if (!window.__browsaSiteRelayInstalled) {
    window.__browsaSiteRelayInstalled = true;
    window.addEventListener('message', (ev) => {
      if (ev.source !== window || !ev.data || ev.data.__browsaRelay !== true) return;
      const msg = ev.data.message;
      if (!msg || typeof msg.type !== 'string') return;
      try {
        // 背景对这些类型不做应答——MV3 下 sendMessage 的 promise 以
        // 「message port closed」reject，属正常路径，吞掉即可。
        chrome.runtime.sendMessage(msg).catch(() => {});
      } catch (_) { /* 扩展上下文失效（SW 重启窗口等）——静默 */ }
    });
  }
}
