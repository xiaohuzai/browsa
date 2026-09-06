// lib/handlers/selection-explain.js — 划词内联解释/翻译的后端。float bar 的「解释」
// 和「翻译」不再绕道 side panel，而是由 content script 开一条一次性端口
// （browsa-explain，与 browsa-subchat 同款 per-request 模式）把选中文本发过来，
// 这里用当前 provider 流式生成一段简短回答，CHUNK/DONE/ERROR 直接推回端口。
// 一次独立的补全调用——不进聊天历史、无会话状态；用户关掉浮层即
// port.disconnect → AbortController.abort() 掐断上游请求。
import * as storage from '../storage.js';
import { chatStream, responsesStream, anthropicStream } from '../llm-client.js';
import { resolveProvider, resolveInferenceParams, resolveChatModel } from './provider-resolver.js';

// 浮层一屏能读完的量。固定小预算，不读 provider.maxTokens——那是聊天输出的
// 配置，跟 150 字的词条解释无关；anthropicStream 对 max_tokens 必填，这里恒有值。
export const EXPLAIN_MAX_TOKENS = 700;
// selection-toolbar 的 MAX_PREVIEW 已截到 2000，这里兜底同值。
export const EXPLAIN_TEXT_CAP = 2000;

// 端口协议沿用 EXPLAIN_* 命名（改 INLINE_* 是纯翻新，不值得全链路翻动），
// 请求里的 mode 字段区分 explain / translate 两种回答形态。
const SYSTEM_PROMPTS = {
  explain: {
    zh: [
      '你是网页划词解释助手。用户在网页上选中了一段文字，请给出简短、准确的解释。',
      '- 用简体中文回答；专有名词、代码、英文缩写保留原文。',
      '- 选中的是单词或短语时：给出核心释义；英文单词附音标和词性；如有助于理解，可补一个例句或常见搭配。',
      '- 选中的是句子或段落时：用两三句话解释它的含义，不要逐句翻译，不要复述原文。',
      '- 结合网页语境判断最可能的词义。',
      '- 直接输出解释正文：不要开场白，不要标题，不要复述用户的问题。',
      '- 排版：可用 - 分点和 **加粗** 标出关键词；不要表格、图片或多级标题。',
      '- 总长度尽量不超过 150 字（单词/短语）或 250 字（句子/段落）。',
    ].join('\n'),
    en: [
      'You are an on-page selection explainer. The user selected some text on a web page; give a short, accurate explanation.',
      '- Reply in English; keep proper nouns, code, and acronyms verbatim.',
      '- For a single word or short phrase: give the core meaning; for an English word include pronunciation and part of speech; add one example or common collocation if it aids understanding.',
      '- For a sentence or paragraph: explain what it means in two or three sentences; do not translate line by line or repeat the original text.',
      '- Judge the most likely sense from the surrounding page context.',
      '- Output the explanation directly: no preamble, no headings, no restating the question.',
      '- Formatting: use - bullets and **bold** sparingly; no tables, images, or nested headings.',
      '- Keep it under ~60 words (word/phrase) or ~110 words (sentence/paragraph).',
    ].join('\n'),
  },
  translate: {
    zh: [
      '你是网页划词翻译助手。把用户选中的文字翻译成简体中文。',
      '- 只输出译文，不要解释、不要音标、不要复述原文。',
      '- 专有名词、代码、命令、URL 保留原文；缩写可首次出现时括注全称。',
      '- 选中的是单个英文单词时：给出在常见语境下最贴切的 1-3 个译法，用「；」分隔。',
      '- 译文排版跟随原文：原文是列表就给列表，原文是一句话就给一句话。',
      '- 按常识选择最可能的语义，不要逐词直译。',
    ].join('\n'),
    en: [
      'You are an on-page selection translator. Translate the selected text into English.',
      '- Output ONLY the translation: no explanations, no phonetics, no restating the original.',
      '- Keep proper nouns, code, commands, and URLs verbatim.',
      '- If the selection is a single word, give the 1-3 most fitting renderings separated by ";".',
      '- Mirror the original formatting: lists stay lists, one sentence stays one sentence.',
      '- Choose the most probable sense; do not translate word by word.',
    ].join('\n'),
  },
};

// 粗判选中文字是否 CJK（汉字/假名/谚文计数 vs 拉丁字母计数）。用于翻译目标
// 语言的翻转规则：译成界面语言；选中文字已经是界面语言时翻成另一种。
export function isMostlyCjk(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (!cjk && !latin) return false;
  return cjk >= latin;
}

// 纯函数（测试直接覆盖）：把选中文本 + 界面语言 + 模式整理成一次补全的
// system/user。translate 的目标语言按上面规则翻转（zh↔en）。
export function buildExplainRequest(text, lang, mode = 'explain') {
  const t = String(text || '').trim().slice(0, EXPLAIN_TEXT_CAP);
  const m = mode === 'translate' ? 'translate' : 'explain';
  let promptLang = lang === 'en' ? 'en' : 'zh';
  if (m === 'translate' && isMostlyCjk(t) === (promptLang === 'zh')) {
    promptLang = promptLang === 'zh' ? 'en' : 'zh';
  }
  return { mode: m, system: SYSTEM_PROMPTS[m][promptLang], user: t };
}

// 端口会话：首个 EXPLAIN_REQUEST 启动一次流式补全；后续消息忽略（每端口一次）。
// deps 可注入 getAll/streams 供测试；生产路径与 mermaid-repair 同款 apiStyle 分派。
export function handleExplainPort(port, deps = {}) {
  const getAll = deps.getAll || (() => storage.getAll());
  const streams = deps.streams || { chatStream, responsesStream, anthropicStream };
  const post = (m) => { try { port.postMessage(m); } catch (_) {} };

  let started = false;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async (msg) => {
    if (started || !msg || msg.type !== 'EXPLAIN_REQUEST') return;
    started = true;
    const text = String(msg.text || '').trim();
    if (!text) { post({ type: 'EXPLAIN_ERROR', message: 'Empty selection' }); return; }
    try {
      const all = await getAll();
      const provider = resolveProvider(all);
      const model = resolveChatModel(provider, all);
      const { temperature } = resolveInferenceParams(provider);
      const { system, user } = buildExplainRequest(text, msg.lang, msg.mode);
      const common = {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model,
        temperature,
        maxTokens: EXPLAIN_MAX_TOKENS,
        signal: controller.signal,
      };
      const onDelta = (d) => post({ type: 'EXPLAIN_CHUNK', delta: d });
      const apiStyle = provider.apiStyle || 'chat';
      if (apiStyle === 'responses') {
        await streams.responsesStream({ ...common, instructions: system, input: user, onDelta });
      } else if (apiStyle === 'anthropic') {
        await streams.anthropicStream({ ...common, system, messages: [{ role: 'user', content: user }], onDelta });
      } else {
        await streams.chatStream({ ...common, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], onDelta });
      }
      post({ type: 'EXPLAIN_DONE' });
    } catch (e) {
      // 浮层已关（端口断开）时中止是预期路径，别再试图往死端口写错误。
      if (controller.signal.aborted) return;
      post({ type: 'EXPLAIN_ERROR', message: e?.message || String(e) });
    }
  });
}
