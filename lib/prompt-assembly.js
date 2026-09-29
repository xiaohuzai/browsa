// lib/prompt-assembly.js — 「一轮 turn 的有效系统提示」的单一实现（C5）。
//
// 搬家前：langMap 逐字两份（chat-handler 组装 / sidepanel /prompt 镜像）、
// 提示常量住 background.js，而 /prompt 检视器拼的比实际发送的少两块
// （capabilityHints / choiceRequestHint）——显示 ≠ 发送。现在常量、语言指令、
// 组装、分节视图都住这里，消费点各一行调用。
//
// 渲染契约（2026-09-28 起全量共享）：CAPABILITY_HINTS_ENTRIES 是唯一文本源，
// 两个消费方逐字复用——CAPABILITY_HINTS（LLM/Hermes 的 system 通道，每轮，
// byte-stable 前缀勿逐条门控）与 lib/agent-turn.js 的 AGENT_RENDER_HINT
// （opencode/bridge/squilla 无 system 位，挂首轮 turn 尾巴；复用
// SHARED_RENDER_RULES = 本数组去掉 CHAT_FENCE_SENTENCE）。通道专属只剩
// framing + 文件条款：chat 的「不要写文件」对带工具的 agent 是反指令，
// agent 侧换成「不要写图件文件」。守卫：test/lib-agent-turn.test.mjs 的
// 共享配对断言 + test/subchat.test.mjs 的单一定义 pin。ADR-0010：维持现状、
// 勿再提压缩/重构——本次是结构共享，CAPABILITY_HINTS 输出字节未变。

// 围栏名索引——两个围栏句共用的那半截；加新渲染器先改这里和下面的契约条目。
export const FENCE_INDEX =
  '```mermaid (diagrams), ```echarts (charts), ```markmap (mind maps), ```smiles (chemistry), ```pdb (proteins), ```dot (neural nets & graphs)';
// chat 专属围栏句（文件条款只适用于纯补全模型，agent 有自己的文件工具）。
export const CHAT_FENCE_SENTENCE =
  'The chat UI renders these fenced code blocks natively, inline in the reply: ' + FENCE_INDEX + '. Output them directly — never create HTML files or write files to disk.';

// 公式规则两条——与 AGENT_RENDER_HINT 的共享件（数组内位置保持原序）。
export const MATH_RULE =
  'When writing mathematical expressions or formulas, always use LaTeX notation: $...$ for inline math, $$...$$ for display/block math — everywhere including inside Markdown table cells; never leave formulas as plain text and never wrap them in backticks.';
export const MERMAID_LABEL_MATH_RULE =
  'In Mermaid node labels, write math as $$...$$ (KaTeX) with SINGLE backslashes: A["$$T = \\frac{D_{vol}}{B_{bw}}$$"]. Write the formula EXACTLY ONCE per label — never a compact plain-text copy alongside the LaTeX version; put explanations in a separate node or as plain text outside the $$...$$ span. Never double backslashes (\\\\frac).';

export const CAPABILITY_HINTS_ENTRIES = [
  MATH_RULE,
  CHAT_FENCE_SENTENCE,
  'In Mermaid, always quote node labels that contain special characters (<, >, /, \\, (, ), {, }, ;, #, ~, %) using double-quoted syntax: ["label text"].',
  'In Markdown, always place punctuation outside bold/italic delimiters: **text**, not **text,**.',
  'In Markdown, put a space between Chinese/CJK text and ** or * emphasis delimiters when directly adjacent — e.g. 一个 **"GPU 利用率"** 因子, never 一个**"GPU 利用率"**因子. Without that space, emphasis that starts/ends with punctuation cannot parse as a delimiter and renders as literal asterisks.',
  'When an answer covers multiple sub-questions or sections, give each one an actual Markdown heading (## or ###) — never a bare unformatted title line like "BF16 比 FP16 强在哪?", which renders with no visual distinction from body text.',
  'When listing parallel points, reasons, or comparisons (even just 2-3 short ones), format them as a Markdown list (- or 1. per line), not separate plain lines — those render as one undifferentiated block.',
  'In Mermaid node labels, NEVER use Markdown bold/italic (**text**/*text*) — they display as literal asterisks. Use HTML instead: <b>text</b>, <i>text</i>, e.g. A["<b>Title</b><br/>subtitle"].',
  MERMAID_LABEL_MATH_RULE,
  'For data visualizations (bar/line/pie/scatter charts), output an ECharts option object as JSON in a ```echarts block: ```echarts\n{"xAxis":{"type":"category","data":["A","B","C"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2,3]}]}\n```',
  'In ECharts option JSON, NEVER put HTML tags (<b>, <br/>, <span>) inside title/legend/axis/label text fields — unlike Mermaid labels, ECharts renders them as literal characters. Use \\n for line breaks; for mixed styling in one field use ECharts\' rich-text syntax (a "rich" object in textStyle, referenced as {styleName|text}), never raw HTML.',
  'For mind maps / outlines / hierarchical breakdowns (a topic and its sub-points, a video TOC), output a ```markmap block containing a plain Markdown outline (headings # ## ### and/or nested - lists) — not Mermaid syntax, not JSON. Never use it for flowcharts, sequence diagrams, or timelines — those are Mermaid.',
  'For chemical structures, output a ```smiles block whose content is the SMILES string — rendered as a 2D structure diagram natively, with a properties line (molecular weight, logP, TPSA, H-bond donors/acceptors) computed for you. Molecule example: ```smiles\nCC(=O)OC1=CC=CC=C1C(=O)O\n``` (aspirin). For REACTIONS use reaction SMILES reactants>agents>products in the same block, species dot-separated (empty agent section when none), e.g. CC(=O)O.CCO>>CCOC(=O)CC.O. The SMILES must be chemically valid (correct valences, closed rings) — invalid structures are NOT drawn; the source is shown with an error note instead. Never draw molecules or reactions as ASCII art or Mermaid graphs.',
  'For protein 3D structures, output a ```pdb block whose content is ONLY a structure ID you are confident exists: the 4-character RCSB Protein Data Bank ID (e.g. 1UBQ), or an AlphaFold predicted model ID like AF-P00533-F1 (a real UniProt accession; rendered with pLDDT confidence coloring) — the UI fetches real coordinates and renders a 3D viewer. NEVER write raw ATOM coordinate lines and NEVER invent an ID; if you don\'t know a real one, say so.',
  'For neural-network / model-architecture figures (MLP, CNN, Transformer — any stack or block diagram) and for dependency/dataflow graphs, output a ```dot block (Graphviz DOT, laid out and rendered natively): ```dot\ndigraph G { rankdir=LR; node [shape=box]; Input [label="input IDs"]; Input -> "Embed + Pos" -> "Multi-Head Attention" -> "Add & Norm" -> "FFN" -> "Add & Norm" -> Output; }\n``` — label nodes ONLY as ID [label="text"]; bare ID["text"] is INVALID Graphviz (it fails to render), a node ID alone renders as the label. Use rankdir for direction, rank=same { A; B; } for parallel branches, cluster subgraphs for grouped stages, and edge labels ([label="..."]) for tensor shapes/details; keep node labels short. Route the figure type: Mermaid for flowcharts/sequence diagrams/timelines, ```dot whenever the figure is blocks-and-arrows — including every neural-network architecture.',
  'Never fabricate or invent image URLs — an unverifiable URL renders as a broken placeholder (the chat UI has no Markdown-image source of truth). To show a diagram, chart, mind map, molecule, protein or network figure, output one of the fenced blocks listed above, or a plain ASCII/text diagram.',
];

/** LLM/Hermes system 通道每轮携带的能力提示（join 自唯一文本源）。 */
export const CAPABILITY_HINTS = CAPABILITY_HINTS_ENTRIES.join(' ');
/** 通道无关契约全集——AGENT_RENDER_HINT 逐字复用（去掉 chat 专属围栏句）。 */
export const SHARED_RENDER_RULES = CAPABILITY_HINTS_ENTRIES.filter(s => s !== CHAT_FENCE_SENTENCE).join(' ');

// CHOICE_REQUEST is CHAT-only, deliberately NOT part of CAPABILITY_HINTS:
// rendering it as clickable buttons requires background.js's CHAT case to
// parse+strip the tail and sidepanel.js to call renderChoiceRequest() —
// SUBCHAT's detail-thread card does neither, so including this hint there
// would just leak the raw "CHOICE_REQUEST:{...}" JSON into the reply text.
export const CHOICE_REQUEST_HINT =
  'When you need the user to pick one of several distinct options (not free-form text), end your reply with a line in this exact format so the chat UI renders clickable buttons: CHOICE_REQUEST:{"question":"short question text","choices":["full text of option 1","full text of option 2"]}. This must be the very last thing in your reply, valid single-line JSON, with no text after it. Each choice string should be the complete message that gets sent back to you when clicked (not just a letter like "A") — write full option text, not a lettered index. Only use this when you are truly asking the user to choose between distinct paths forward, not for yes/no confirmations or open-ended questions.';

// 七语言应答指令——唯一一份（此前 chat-handler 与 sidepanel 各拷一份）。
const LANG_INSTRUCTIONS = {
  en: 'Please always respond in English.',
  zh: '请始终用中文回答。',
  ja: '常に日本語で回答してください。',
  ko: '항상 한국어로 답변해 주세요.',
  de: 'Bitte antworte immer auf Deutsch.',
  fr: 'Veuillez toujours répondre en français.',
  es: 'Por favor, responde siempre en español.',
};

/**
 * 单独取语言指令——OpenSquilla 这类没有 system 通道的 provider 把它拼进消息
 * 正文（buildSquillaTurn 的 langExtra），system 组装走下面两个函数。
 */
export function langInstruction(replyLanguage) {
  return LANG_INSTRUCTIONS[replyLanguage] || '';
}

/**
 * 组装发给无状态 LLM 渠道的 system prompt：base + 语言 + 能力提示 + 选项协议。
 * 两个提示块由调用方按通道给：CHAT 两块都要；SUBCHAT 永不带 choiceRequestHint
 * ——卡片不解析 CHOICE_REQUEST 尾巴，带了会把原文漏进回复。
 */
export function buildEffectiveSystemPrompt({ systemPrompt, replyLanguage } = {}, { capabilityHints = '', choiceRequestHint = '' } = {}) {
  const langExtra = langInstruction(replyLanguage);
  return [systemPrompt || '', langExtra, capabilityHints, choiceRequestHint]
    .map(s => s.trim()).filter(Boolean).join('\n\n');
}

/**
 * /prompt 检视器的分节视图——与 buildEffectiveSystemPrompt 同一套零件（所见
 * 即所发）。
 */
export function effectiveSystemPromptSections({ systemPrompt, replyLanguage } = {}, { capabilityHints = '', choiceRequestHint = '' } = {}) {
  const langExtra = langInstruction(replyLanguage);
  return [
    (systemPrompt || '').trim() && { label: 'Base system prompt', text: systemPrompt.trim() },
    langExtra && { label: 'Language instruction', text: langExtra },
    capabilityHints.trim() && { label: 'Capability hints', text: capabilityHints.trim() },
    choiceRequestHint.trim() && { label: 'Choice request protocol', text: choiceRequestHint.trim() },
  ].filter(Boolean);
}
