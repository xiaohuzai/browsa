// dev-preview/seed.js — realistic conversation + config for the preview env.
window.__BROWSA_PREVIEW_SEED = {
  activeProvider: 'llm1',
  pingStates: { llm1: 'reachable', hermes: 'unreachable' },
  providers: {
    hermes: { type: 'agent', alias: 'Hermes Agent', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: true, apiStyle: 'chat', temperature: null, maxTokens: 0 },
    squilla: { type: 'agent', alias: 'OpenSquilla', baseUrl: 'ws://127.0.0.1:18791/ws', apiKey: '', model: '', stream: true, isHermes: false, isSquilla: true, apiStyle: 'chat', temperature: null, maxTokens: 0 },
    codex: { type: 'agent', alias: 'Codex', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: false, isSquilla: false, isCodex: true, apiStyle: 'chat', temperature: null, maxTokens: 0, codexBin: '' },
    workbuddy: { type: 'agent', alias: 'WorkBuddy', baseUrl: '', apiKey: '', model: '', stream: true, isHermes: false, isSquilla: false, isWorkbuddy: true, apiStyle: 'chat', temperature: null, maxTokens: 0, codebuddyBin: '' },
    llm1: { type: 'llm', alias: 'My OpenAI', baseUrl: 'https://api.openai.com', apiKey: 'sk-preview', model: 'gpt-4o', apiStyle: 'chat', temperature: null, maxTokens: 0 },
    llm2: { type: 'llm', alias: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'qwen3:32b', apiStyle: 'chat', temperature: null, maxTokens: 0 },
  },
  replyLanguage: '',
  systemPrompt: 'You are a helpful assistant.',
  contextMode: 'auto',
  asr: { enabled: false, apiKey: '', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-0-lite-260428', videoModel: '', language: 'zh', format: 'audio/x-m4a', timeoutMs: 150000, subtitleSource: 'original', videoModel: '' },
  __pageMeta: {
    id: 7,
    title: '【4K】2026 前端趋势分享会 - 哔哩哔哩',
    url: 'https://www.bilibili.com/video/BV1preview',
  },
  history: [
    {
      role: 'user',
      content: `[Page context attached by browsa]

## 视频信息

标题：【4K】2026 前端趋势分享会
UP主：前端晚自习
播放量：128,442

## 字幕

[00:02] 大家好，欢迎来到 2026 前端趋势分享会。
[00:15] 第一位讲者会聊本地优先架构在今年的落地情况。
[01:24] 核心观点：本地优先正在从理念走向基础设施，同步引擎成为新的数据库中间层。
[07:42] 框架动向：React Compiler 进入稳定版，Vue 的 Vapor Mode 开始落地，Svelte 持续迭代 Runes。
[23:10] 工具链方面，Rust 已经全面接管构建层，从打包器到格式化工具。
[38:05] 最后的圆桌环节讨论了 2026 年的前端比拼的是运行时之外的能力。`,
      videoSrc: { platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1preview', tabId: 7 },
    },
    { role: 'user', content: '帮我总结一下这个视频的内容，做好笔记' },
    {
      role: 'assistant',
      videoSrc: { platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1preview', tabId: 7 },
      content: `<think>用户附带了B站视频字幕，需要生成带时间戳的结构化笔记。按章节组织，保留原始时间戳。</think>\n# 视频笔记：2026 前端趋势分享会 [00:00]\n\n## 一、核心观点 [01:24]\n\n三位讲者都提到：**本地优先（Local-first）** 正在从理念走向基础设施。\n\n- 同步引擎成为新的「数据库中间层」\n- CRDT 已不再是学术玩具\n- 边缘渲染与本地缓存边界模糊\n\n## 二、框架动向 [07:42]\n\n| 框架 | 动向 | 关键词 |\n|---|---|---|
| React | Compiler 稳定版 | 自动记忆化 |
| Vue | Vapor Mode 落地 | 去虚拟 DOM |
| Svelte | Runes 迭代 | 细粒度响应 |\n\n## 三、工具链 [23:10]\n\nRust 工具链全面接管构建层：\n\n\`\`\`bash\nnpm create vite@latest my-app -- --template rust-tooling\n\`\`\`\n\n> 结论：2026 年的前端比拼的是**运行时之外**的能力。详细讨论见 [38:05] 的圆桌环节。`,
    },
    { role: 'user', content: '用 TypeScript 写一个快速排序，带类型推导' },
    {
      role: 'assistant',
      content: '下面是一个泛型版本，对任意可比较元素数组都适用：\n\n```typescript\nfunction quickSort<T>(arr: readonly T[]): T[] {\n  if (arr.length <= 1) return [...arr];\n  const [pivot, ...rest] = arr;\n  const left = rest.filter((x) => x < pivot);\n  const right = rest.filter((x) => x >= pivot);\n  return [...quickSort(left), pivot, ...quickSort(right)];\n}\n\nconst sorted = quickSort([3, 1, 4, 1, 5, 9, 2, 6]); // number[]\n```\n\n要点：\n\n1. `readonly T[]` 保证不修改入参\n2. 展开运算符让泛型 `T` 自然参与推断\n3. 平均时间复杂度 O(n log n)，最坏 O(n²)',
    },
    { role: 'user', content: '注意力机制的数学形式是什么？' },
    {
      role: 'assistant',
      content: '缩放点积注意力的定义：\n\n$$\\text{Attention}(Q,K,V)=\\text{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V$$\n\n其中查询矩阵 $Q$ 与键矩阵 $K$ 的点积衡量相关性，除以 $\\sqrt{d_k}$ 防止内积随维度增大而进入饱和区。',
    },
    { role: 'user', content: '画个模块架构图' },
    {
      role: 'assistant',
      content: '```mermaid\nflowchart LR\n  A[页面内容] --> B[侧边栏]\n  B --> C{Provider}\n  C -->|Agent| D[Hermes /v1/runs]\n  C -->|LLM| E[Chat Completions]\n  D --> F[流式回复]\n  E --> F\n```',
    },
  ],
};
