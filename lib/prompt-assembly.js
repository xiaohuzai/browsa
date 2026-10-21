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
// 2026-10-07 增项（用户批准的例外）：新增成文风格契约一条（用户要求把转写/资料
// 整理成文章时避免机器写作指纹），规则源自 orange2ai/podcast-to-article 的语料
// 研究（629 篇/9.5 万句 人类 vs AI，MIT）——9 条采用 5 条舍弃（模型自监不了的
// 句式纪律、与聊天气泡渲染冲突的排版禁令不收）；ADR-0010 的「勿增」自此以该
// 批准为界，后续再增条目仍须用户点头。
// 2026-10-20 回滚与「更生动」裁定（用户报告：只有被要求画图才画图，偶尔整段
// 纯文本；要求标题/加粗/列表/表格等富 Markdown 按需用足）：当天先上两段式
// （ALWAYS 底座 ~1.6K 每回合 + 渲染契约按家族追加），普通问答因此丢掉 6.3K
// 契约里「什么内容该用哪种围栏」的指路；同批加入的「Err on the side of NOT
// drawing」负向规则又进一步压制。裁决：① 恢复每轮全量 CAPABILITY_HINTS
//（ADR-0010 原状），删除家族门控；② 删除负向规则，换成正向的
// FIGURE_PROACTIVITY_RULE；③ 新增 RICH_MARKDOWN_RULE 作为默认排版契约。
// 勿再提按关键词/家族门控渲染契约，也勿再加「少画/少排版」类负向指令——
// 省下的 token 远不值行为回退。

// 围栏名索引——两个围栏句共用的那半截；加新渲染器先改这里和下面的契约条目。
export const FENCE_INDEX =
  '```mermaid (diagrams), ```echarts (charts), ```markmap (mind maps), ```smiles (chemistry), ```pdb (proteins), ```dot (neural nets & graphs)';
// chat 专属围栏句（文件条款只适用于纯补全模型，agent 有自己的文件工具）。
export const CHAT_FENCE_SENTENCE =
  'The chat UI renders these fenced code blocks natively, inline in the reply: ' + FENCE_INDEX + '. Output them directly — never create HTML files or write files to disk.';

// 公式规则两条——与 AGENT_RENDER_HINT 的共享件（数组内位置保持原序）。
export const MATH_RULE =
  'When writing mathematical expressions or formulas in prose and Markdown, always use LaTeX notation: $...$ for inline math, $$...$$ for display/block math — everywhere including inside Markdown table cells; never leave prose formulas as plain text and never wrap them in backticks. Inside a fenced diagram or chart, follow that format\'s own label rule instead.';
export const MERMAID_LABEL_MATH_RULE =
  'In Mermaid labels, formulas render as plain SVG text — write them with Unicode sub/superscripts and symbols (dₖ, QKᵀ, n×dₖ, √dₖ, ×), never $$...$$ or LaTeX: the panel sanitizer flattens label HTML to text, so LaTeX appears as source. Write each formula exactly once per label — never a compact plain-text copy alongside it.';

const MARKDOWN_BOLD_PUNCT_RULE = 'In Markdown, always place punctuation outside bold/italic delimiters: **text**, not **text,**.';
const MARKDOWN_CJK_SPACE_RULE = 'In Markdown, put a space between Chinese/CJK text and ** or * emphasis delimiters when directly adjacent — e.g. 一个 **"GPU 利用率"** 因子, never 一个**"GPU 利用率"**因子. Without that space, emphasis that starts/ends with punctuation cannot parse as a delimiter and renders as literal asterisks.';
const MARKDOWN_HEADING_RULE = 'When an answer covers multiple sub-questions or sections, give each one an actual Markdown heading (## or ###) — never a bare unformatted title line like "BF16 比 FP16 强在哪?", which renders with no visual distinction from body text.';
const MARKDOWN_LIST_RULE = 'When listing parallel points, reasons, or comparisons (even just 2-3 short ones), format them as a Markdown list (- or 1. per line), not separate plain lines — those render as one undifferentiated block.';
const IMAGE_URL_RULE = 'Never fabricate or invent image URLs — an unverifiable URL renders as a broken placeholder (the chat UI has no Markdown-image source of truth). To show a diagram, chart, mind map, molecule, protein or network figure, output one of the fenced blocks listed above, or a plain ASCII/text diagram.';

const MERMAID_QUOTE_RULE = 'In Mermaid, always quote node labels that contain special characters (<, >, /, \\, (, ), {, }, ;, #, ~, %) using double-quoted syntax: ["label text"].';
const MERMAID_BOLD_RULE = 'In Mermaid node labels, NEVER use Markdown bold/italic (**text**/*text*) — they display as literal asterisks. Use HTML instead: <b>text</b>, <i>text</i>, e.g. A["<b>Title</b><br/>subtitle"].';
const ECHARTS_RULE = 'For data visualizations (bar/line/pie/scatter charts), output an ECharts option object as JSON in a ```echarts block: ```echarts\n{"xAxis":{"type":"category","data":["A","B","C"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2,3]}]}\n```';
const ECHARTS_HTML_RULE = 'In ECharts option JSON, NEVER put HTML tags (<b>, <br/>, <span>) inside title/legend/axis/label text fields — unlike Mermaid labels, ECharts renders them as literal characters. Use \\n for line breaks; for mixed styling in one field use ECharts\' rich-text syntax (a "rich" object in textStyle, referenced as {styleName|text}), never raw HTML. ECharts draws its text on canvas and has no math renderer: write formulas/shapes with Unicode (dₖ, QKᵀ, ×, √), never $...$ or LaTeX.';
const MARKMAP_RULE = 'For mind maps / outlines / hierarchical breakdowns (a topic and its sub-points, a video TOC), output a ```markmap block containing a plain Markdown outline (headings # ## ### and/or nested - lists) — not Mermaid syntax, not JSON. Never use it for flowcharts, sequence diagrams, or timelines — those are Mermaid.';
const SMILES_RULE = 'For chemical structures, output a ```smiles block whose content is the SMILES string — rendered as a 2D structure diagram natively, with a properties line (molecular weight, logP, TPSA, H-bond donors/acceptors) computed for you. Molecule example: ```smiles\nCC(=O)OC1=CC=CC=C1C(=O)O\n``` (aspirin). For REACTIONS use reaction SMILES reactants>agents>products in the same block, species dot-separated (empty agent section when none), e.g. CC(=O)O.CCO>>CCOC(=O)CC.O. The SMILES must be chemically valid (correct valences, closed rings) — invalid structures are NOT drawn; the source is shown with an error note instead. Never draw molecules or reactions as ASCII art or Mermaid graphs.';
const PDB_RULE = 'For protein 3D structures, output a ```pdb block whose content is ONLY a structure ID you are confident exists: the 4-character RCSB Protein Data Bank ID (e.g. 1UBQ), or an AlphaFold predicted model ID like AF-P00533-F1 (a real UniProt accession; rendered with pLDDT confidence coloring) — the UI fetches real coordinates and renders a 3D viewer. NEVER write raw ATOM coordinate lines and NEVER invent an ID; if you don\'t know a real one, say so.';
const DOT_RULE = 'For neural-network / model-architecture figures (MLP, CNN, Transformer — any stack or block diagram) and for dependency/dataflow graphs, output a ```dot block (Graphviz DOT, laid out and rendered natively): ```dot\ndigraph G { rankdir=LR; node [shape=box]; Input [label="input IDs"]; Input -> "Embed + Pos" -> "Multi-Head Attention" -> "Add & Norm" -> "FFN" -> "Add & Norm" -> Output; }\n``` — label nodes ONLY as ID [label="text"]; bare ID["text"] is INVALID Graphviz (it fails to render), a node ID alone renders as the label. If a node uses style=filled, ALWAYS set fillcolor AND a contrasting fontcolor (dark fill ⇒ fontcolor="white") — black fill with the default black font is unreadable. Use rankdir for direction, rank=same { A; B; } for parallel branches, cluster subgraphs for grouped stages, and edge labels ([label="..."]) for tensor shapes/details; keep node labels short; write formulas/shapes as plain text with `_x` or `_{…}` subscripts and `^x` or `^{…}` superscripts (e.g. label="QK^{T}\\nn×d_k") — they render as real sub/superscripts, and a paired `$…$` wrapper is accepted too; a label wider than ~12 CJK characters must break into lines with \\n inside the quoted label (e.g. label="第一行\\n第二行") — single-line CJK runs overflow the node box. Route the figure type: Mermaid for flowcharts/sequence diagrams/timelines, ```dot whenever the figure is blocks-and-arrows — including every neural-network architecture.';
const ARTICLE_STYLE_RULE = 'When asked to turn provided material (a transcript, article, or notes) into a polished ARTICLE, avoid machine-writing tells: no em-dash (——); never the contrast frame 不是X而是Y (nor 并非…而是 / 不在于…而在于); never summary-tone openers (本质上/核心是/归根结底/换言之/值得注意的是/综上所述/说到底); paragraphs after the first must continue the previous topic or carry an explicit subject — no floating commentary openers (问题在于…); start sentences with subjects, not connectors (然而/因此/此外/与此同时); one idea per paragraph, 2-4 sentences; reuse source terminology verbatim. KEEP the source\'s concrete material — numbers, names, dates, figures (human writing is ~3x denser in them; abstracting them away is the biggest AI tell). Rhetorical questions and metaphors are good — humans use both far more often; no anthropomorphic figures like 就像一个导师. Colloquial numbers in Chinese characters (百分之十、两万亿); model numbers, years and technical specs in Arabic numerals (iPhone 18 Pro Max、2027 年). Re-scan for these patterns before finishing.';
const MERMAID_TYPE_MENU_RULE = 'Mermaid renders many more diagram types — pick the one that matches the content instead of defaulting to flowchart: stateDiagram-v2 for state machines, lifecycles, modes with transitions; classDiagram for classes/interfaces with fields and methods; erDiagram for database entities and their relations; journey for user-experience stages with satisfaction scores; gantt for schedules with dates and durations; gitGraph for branch/merge history; quadrantChart for 2x2 positioning of items on two axes; requirementDiagram for requirements with ids and verification links; sankey-beta for flows/quantities between stages; kanban for columns of cards; timeline for chronological events. Keep the routing: data charts (bar/line/pie/scatter) are ```echarts, mind maps/outlines are ```markmap, blocks-and-arrows figures including neural-network architectures are ```dot. In the narrow side panel prefer TD over LR for flowcharts, keep label text short, and note that gantt/gitGraph/journey/sankey run wide and shrink — use them only when the content is genuinely that form. Do not emit %%{init}%% directives or YAML front-matter config: theme, fonts and limits are app-controlled, and front-matter config is stripped before rendering.';

// 默认排版契约（2026-10-20 用户要求「输出更生动」）：此前只有标题/列表各一条
// 纠错式规则，普通回答仍可能整段纯文本。这条把富 Markdown 设为默认，同时保留
//「短回答不必硬套结构」的边界，避免每句话都加粗。
const RICH_MARKDOWN_RULE = 'Write every substantial answer as rich Markdown rather than a plain-text wall: use ## / ### headings to separate distinct sections, **bold** for key terms and conclusions, `inline code` for identifiers, commands, file paths and API names, bullet or numbered lists for parallel points and steps, Markdown tables for comparisons across several attributes, > blockquotes for quoted material, and fenced code blocks with a language tag for code. Match structure to content — a short conversational reply can stay plain, and not every phrase needs bold — but once an answer runs past a couple of sentences, give it visible structure instead of one undifferentiated block of text.';

// 主动配图（2026-10-20 用户报告「只有要求画图才会画」）：把配图从「被点名才做」
// 改成「内容本身有结构就配」，同时明确「一张合适的图胜过几张冗余图」与「简单
// 回答不必硬配」，防止从一个极端滑到另一个极端。
const FIGURE_PROACTIVITY_RULE = 'Visualize proactively, not only when explicitly asked: whenever the content is inherently structural — how something works, an architecture or pipeline, a request/response flow, a state machine or lifecycle, a hierarchy or taxonomy, a timeline or schedule, a comparison on two axes, a dependency or dataflow graph — include the appropriate fenced figure alongside your prose, because it usually explains the shape better than paragraphs. Pick the format by content (see the routing below), prefer one well-chosen figure over several redundant ones, and skip the figure when the answer is genuinely simple.';

// 源文档已带图时优先引用（2026-10-21 用户报告：0.44.3 的回答会引用文档里的
// 图片，现在几乎不引用了）。FIGURE_PROACTIVITY_RULE 让模型倾向自己画图，
// 与「引用随附的 [图N]」竞争；这条明确优先级：源材料有带编号的图就引用原图，
// 只有源里没有可用图、或自己的图能补充新信息时才生成新围栏。它也让
// attach 管线里 [图N] 锚点的含义对模型显式化（此前只能从上下文自己推断）。
const SOURCE_FIGURE_RULE = 'When the supplied material already contains labeled figures ([图1], [图2], … in the text), cite those figures with the SAME [图N] markers instead of drawing a new diagram of the same content; add a generated fenced figure only when the source has no usable figure or when your own figure explains something the source figures do not.';

export const CAPABILITY_HINTS_ENTRIES = [
  MATH_RULE,
  CHAT_FENCE_SENTENCE,
  RICH_MARKDOWN_RULE,
  FIGURE_PROACTIVITY_RULE,
  SOURCE_FIGURE_RULE,
  MERMAID_QUOTE_RULE,
  MARKDOWN_BOLD_PUNCT_RULE,
  MARKDOWN_CJK_SPACE_RULE,
  MARKDOWN_HEADING_RULE,
  MARKDOWN_LIST_RULE,
  MERMAID_BOLD_RULE,
  MERMAID_LABEL_MATH_RULE,
  ECHARTS_RULE,
  ECHARTS_HTML_RULE,
  MARKMAP_RULE,
  SMILES_RULE,
  PDB_RULE,
  DOT_RULE,
  ARTICLE_STYLE_RULE,
  IMAGE_URL_RULE,
  MERMAID_TYPE_MENU_RULE,
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
 * 能力提示每轮全量下发（2026-10-20 回滚：按家族门控会让普通问答失去画图
 * 指路，用户实测画图变少、偶尔整段纯文本）。两个提示块由调用方按通道给：
 * CHAT 两块都要；SUBCHAT 永不带 choiceRequestHint——卡片不解析
 * CHOICE_REQUEST 尾巴，带了会把原文漏进回复。
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
