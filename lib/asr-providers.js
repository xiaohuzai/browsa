// lib/asr-providers.js — ASR / 视频解析服务商注册表。
//
// UI（options 的 ASR 卡片）与协议适配都从这里取元数据：下拉选项、Base URL
// 默认值、`?` 提示、文档链接、占位符全部由注册表驱动，接入新供应商时 UI 零改动。
// 接入一家 = ① 这里加一项元数据；② attach-asr.js 的 ASR_ADAPTERS 注册一个
// { transcribeAudio, analyzeVideo } 同签名适配器。下拉自动出现新选项。
//
// 原则：只列【已实现】的服务商——没接好的不摆出来骗人（与官网文案同一纪律）。

export const ASR_PROVIDERS = {
  ark: {
    id: 'ark',
    label: '火山方舟',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-lite-260428',
    apiKeyPlaceholder: '标准方舟 API Key（UUID 或 ark- 前缀均可）',
    baseUrlTip: '用标准版 <code>…/api/v3</code>：实测 Agent Plan 的 <code>…/api/plan/v3</code> 不支持文件上传（Files API）。',
    docUrl: 'https://ark.volcengine.com/region:cn-beijing/docs/82379/2377589?lang=zh',
    docLabel: '为什么要这样配置？→ 火山方舟音频理解文档',
  },
};

export function getAsrProvider(id) {
  return ASR_PROVIDERS[id] || ASR_PROVIDERS.ark;
}
