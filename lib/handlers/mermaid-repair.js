// lib/handlers/mermaid-repair.js — 「AI 修复重绘」的后端：把渲染失败的 mermaid
// 源码 + 解析错误发给当前 provider，取回修好的源码。一次独立的补全调用——不进
// 聊天历史、不动会话流；修复稿回到 sidepanel 后还会先过一遍本地 mermaid parse
// 校验才替换错误卡（双保险：模型回复仍可能不是合法图，不能直接上屏）。
import { chatStream, responsesStream, anthropicStream, DEFAULT_MAX_TOKENS } from '../llm-client.js';

const SYSTEM_PROMPT = [
  'You repair broken Mermaid diagram code.',
  'Reply with ONLY one ```mermaid fenced code block containing the corrected diagram — no explanations before or after.',
  'Keep the diagram type, the label language, and the content meaning unchanged; change only what is needed to make it valid, well-formed Mermaid.',
].join(' ');

// 模型回复取源码：优先第一个 ```mermaid/mmd 围栏；模型偶尔漏掉围栏时退回整段
// 修剪文本——再坏也会被 sidepanel 的 parse 校验拦住，不会污染界面。
export function extractMermaidFence(text) {
  const s = String(text ?? '');
  for (const match of s.matchAll(/```(?:mermaid|mmd)?[^\S\n]*\r?\n([\s\S]*?)```/gi)) {
    const body = match[1].trim();
    if (body) return body;
  }
  const bare = s.trim();
  return bare || null;
}

export async function repairMermaid({ provider, model, source, errorText }) {
  // 只带解析错误的前几行（token 转储对模型同样噪音），够定位出错位置即可。
  const errHead = String(errorText || '').split('\n').slice(0, 4).join('\n').slice(0, 400);
  const user = [
    'This Mermaid diagram fails to render. Parser error:',
    errHead || '(no parser message)',
    '',
    'Broken diagram:',
    '```mermaid',
    String(source || ''),
    '```',
    '',
    'Return the corrected diagram as a single ```mermaid fenced code block.',
  ].join('\n');

  // maxTokens：卡上显式配了正数就用它，否则 8192（修复稿长度约等于原图，够用
  // 且防跑飞）。anthropicStream 对 max_tokens 必填的兜底不依赖这里的值。
  const maxTokens = provider.maxTokens > 0 ? provider.maxTokens : 8192;
  const common = {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    temperature: provider.temperature ?? undefined,
    maxTokens,
  };
  let reply = '';
  const onDelta = (d) => { reply += d; };
  const apiStyle = provider.apiStyle || 'chat';
  if (apiStyle === 'responses') {
    await responsesStream({ ...common, instructions: SYSTEM_PROMPT, input: user, onDelta });
  } else if (apiStyle === 'anthropic') {
    await anthropicStream({ ...common, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }], onDelta });
  } else {
    await chatStream({ ...common, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], onDelta });
  }
  return extractMermaidFence(reply);
}
