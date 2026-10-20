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

const MARKDOWN_BOLD_PUNCT_RULE = 'In Markdown, always place punctuation outside bold/italic delimiters: **text**, not **text,**.';
const MARKDOWN_CJK_SPACE_RULE = 'In Markdown, put a space between Chinese/CJK text and ** or * emphasis delimiters when directly adjacent — e.g. 一个 **"GPU 利用率"** 因子, never 一个**"GPU 利用率"**因子. Without that space, emphasis that starts/ends with punctuation cannot parse as a delimiter and renders as literal asterisks.';
const MARKDOWN_HEADING_RULE = 'When an answer covers multiple sub-questions or sections, give each one an actual Markdown heading (## or ###) — never a bare unformatted title line like "BF16 比 FP16 强在哪?", which renders with no visual distinction from body text.';
const MARKDOWN_LIST_RULE = 'When listing parallel points, reasons, or comparisons (even just 2-3 short ones), format them as a Markdown list (- or 1. per line), not separate plain lines — those render as one undifferentiated block.';
const IMAGE_URL_RULE = 'Never fabricate or invent image URLs — an unverifiable URL renders as a broken placeholder (the chat UI has no Markdown-image source of truth). To show a diagram, chart, mind map, molecule, protein or network figure, output one of the fenced blocks listed above, or a plain ASCII/text diagram.';

const MERMAID_QUOTE_RULE = 'In Mermaid, always quote node labels that contain special characters (<, >, /, \\, (, ), {, }, ;, #, ~, %) using double-quoted syntax: ["label text"].';
const MERMAID_BOLD_RULE = 'In Mermaid node labels, NEVER use Markdown bold/italic (**text**/*text*) — they display as literal asterisks. Use HTML instead: <b>text</b>, <i>text</i>, e.g. A["<b>Title</b><br/>subtitle"].';
const ECHARTS_RULE = 'For data visualizations (bar/line/pie/scatter charts), output an ECharts option object as JSON in a ```echarts block: ```echarts\n{"xAxis":{"type":"category","data":["A","B","C"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2,3]}]}\n```';
const ECHARTS_HTML_RULE = 'In ECharts option JSON, NEVER put HTML tags (<b>, <br/>, <span>) inside title/legend/axis/label text fields — unlike Mermaid labels, ECharts renders them as literal characters. Use \\n for line breaks; for mixed styling in one field use ECharts\' rich-text syntax (a "rich" object in textStyle, referenced as {styleName|text}), never raw HTML.';
const MARKMAP_RULE = 'For mind maps / outlines / hierarchical breakdowns (a topic and its sub-points, a video TOC), output a ```markmap block containing a plain Markdown outline (headings # ## ### and/or nested - lists) — not Mermaid syntax, not JSON. Never use it for flowcharts, sequence diagrams, or timelines — those are Mermaid.';
const SMILES_RULE = 'For chemical structures, output a ```smiles block whose content is the SMILES string — rendered as a 2D structure diagram natively, with a properties line (molecular weight, logP, TPSA, H-bond donors/acceptors) computed for you. Molecule example: ```smiles\nCC(=O)OC1=CC=CC=C1C(=O)O\n``` (aspirin). For REACTIONS use reaction SMILES reactants>agents>products in the same block, species dot-separated (empty agent section when none), e.g. CC(=O)O.CCO>>CCOC(=O)CC.O. The SMILES must be chemically valid (correct valences, closed rings) — invalid structures are NOT drawn; the source is shown with an error note instead. Never draw molecules or reactions as ASCII art or Mermaid graphs.';
const PDB_RULE = 'For protein 3D structures, output a ```pdb block whose content is ONLY a structure ID you are confident exists: the 4-character RCSB Protein Data Bank ID (e.g. 1UBQ), or an AlphaFold predicted model ID like AF-P00533-F1 (a real UniProt accession; rendered with pLDDT confidence coloring) — the UI fetches real coordinates and renders a 3D viewer. NEVER write raw ATOM coordinate lines and NEVER invent an ID; if you don\'t know a real one, say so.';
const DOT_RULE = 'For neural-network / model-architecture figures (MLP, CNN, Transformer — any stack or block diagram) and for dependency/dataflow graphs, output a ```dot block (Graphviz DOT, laid out and rendered natively): ```dot\ndigraph G { rankdir=LR; node [shape=box]; Input [label="input IDs"]; Input -> "Embed + Pos" -> "Multi-Head Attention" -> "Add & Norm" -> "FFN" -> "Add & Norm" -> Output; }\n``` — label nodes ONLY as ID [label="text"]; bare ID["text"] is INVALID Graphviz (it fails to render), a node ID alone renders as the label. If a node uses style=filled, ALWAYS set fillcolor AND a contrasting fontcolor (dark fill ⇒ fontcolor="white") — black fill with the default black font is unreadable. Use rankdir for direction, rank=same { A; B; } for parallel branches, cluster subgraphs for grouped stages, and edge labels ([label="..."]) for tensor shapes/details; keep node labels short; a label wider than ~12 CJK characters must break into lines with \\n inside the quoted label (e.g. label="第一行\\n第二行") — single-line CJK runs overflow the node box. Route the figure type: Mermaid for flowcharts/sequence diagrams/timelines, ```dot whenever the figure is blocks-and-arrows — including every neural-network architecture.';
const ARTICLE_STYLE_RULE = 'When asked to turn provided material (a transcript, article, or notes) into a polished ARTICLE, avoid machine-writing tells: no em-dash (——); never the contrast frame 不是X而是Y (nor 并非…而是 / 不在于…而在于); never summary-tone openers (本质上/核心是/归根结底/换言之/值得注意的是/综上所述/说到底); paragraphs after the first must continue the previous topic or carry an explicit subject — no floating commentary openers (问题在于…); start sentences with subjects, not connectors (然而/因此/此外/与此同时); one idea per paragraph, 2-4 sentences; reuse source terminology verbatim. KEEP the source\'s concrete material — numbers, names, dates, figures (human writing is ~3x denser in them; abstracting them away is the biggest AI tell). Rhetorical questions and metaphors are good — humans use both far more often; no anthropomorphic figures like 就像一个导师. Colloquial numbers in Chinese characters (百分之十、两万亿); model numbers, years and technical specs in Arabic numerals (iPhone 18 Pro Max、2027 年). Re-scan for these patterns before finishing.';
const MERMAID_TYPE_MENU_RULE = 'Mermaid renders many more diagram types — pick the one that matches the content instead of defaulting to flowchart: stateDiagram-v2 for state machines, lifecycles, modes with transitions; classDiagram for classes/interfaces with fields and methods; erDiagram for database entities and their relations; journey for user-experience stages with satisfaction scores; gantt for schedules with dates and durations; gitGraph for branch/merge history; quadrantChart for 2x2 positioning of items on two axes; requirementDiagram for requirements with ids and verification links; sankey-beta for flows/quantities between stages; kanban for columns of cards; timeline for chronological events. Keep the routing: data charts (bar/line/pie/scatter) are ```echarts, mind maps/outlines are ```markmap, blocks-and-arrows figures including neural-network architectures are ```dot. In the narrow side panel prefer TD over LR for flowcharts, keep label text short, and note that gantt/gitGraph/journey/sankey run wide and shrink — use them only when the content is genuinely that form. Err on the side of NOT drawing: simple or short content (a plain answer, a short list, a small table) is fine as plain Markdown — never draw a diagram for its own sake, and at most one diagram per reply unless asked. Do not emit %%{init}%% directives or YAML front-matter config: theme, fonts and limits are app-controlled, and front-matter config is stripped before rendering.';

export const CAPABILITY_HINTS_ENTRIES = [
  MATH_RULE,
  CHAT_FENCE_SENTENCE,
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

// ─── 两段式能力提示（2026-10-20 用户报告：说个 hi 也要背整个渲染契约）──────
// ALWAYS：所有回合都带的底座——围栏菜单（模型由此知道有哪些围栏可路由）+
// 通用 Markdown/写作规则（每个回答都用得上，且各自修过真实渲染 bug）+ 数学
// 记法 + 图片 URL 禁造。RENDER（渲染契约细节）按**家族**追加（2026-10-20
// 第二批：换模型后复检，单块 6.3K 仍然把化学/蛋白/成文契约塞进一次画图请求）：
// 每个家族有自己的触发词和围栏指纹，历史里画过该家族的图就持续命中；只有
// 命中家族才带其文本。**顺序 = 首次出现的先后**（历史里的围栏顺序 + 本轮
// 触发词按家族表顺序排在末尾），所以追加是纯尾部生长——激活新家族时已发送
// 的前缀不变，只多付新增那一段。
export const CAPABILITY_HINTS_ALWAYS_ENTRIES = [MATH_RULE, CHAT_FENCE_SENTENCE, MARKDOWN_BOLD_PUNCT_RULE, MARKDOWN_CJK_SPACE_RULE, MARKDOWN_HEADING_RULE, MARKDOWN_LIST_RULE, IMAGE_URL_RULE];
export const CAPABILITY_HINTS_ALWAYS = CAPABILITY_HINTS_ALWAYS_ENTRIES.join(' ');
export const RENDER_CONTRACT_HINTS = CAPABILITY_HINTS_ENTRIES.filter((e) => !CAPABILITY_HINTS_ALWAYS_ENTRIES.includes(e)).join(' ');

// 家族表：id → 条目 + 历史围栏指纹 + 本轮触发词。trigger 只在用户消息上跑
//（历史只认围栏，避免旧消息里的一个名词让契约永久赖着）；fence 为 null 的
// 家族（routing/成文风格）没有自己的围栏，只能按本轮触发词或 anyFence 出现。
export const RENDER_HINT_GROUPS = [
  {
    id: 'routing',
    entries: [MERMAID_TYPE_MENU_RULE],
    fence: null,
    anyFence: true,
    trigger: /(?:绘图|绘制|画(?:一|个|张|幅|出|下|图|两|几|[^，。,.!?！？]{0,4}(?:图|表))|(?:生成|做个|做一张|来一张|出一张|整一张)[^，。,.!?！？]{0,4}图|示意|结构图|流程图|架构图|关系图|状态图|时序图|图表|可视化|\bdiagram\b|\bdraw\b|visuali[sz]|\bcharts?\b|\bplots?\b|描(?:い|く|画)|図解|作図|図示|그려|그리기|도해|dibuj|desenh|нарису|рисун|zeichne|dessine)/i,
  },
  {
    id: 'mermaid',
    entries: [MERMAID_QUOTE_RULE, MERMAID_BOLD_RULE, MERMAID_LABEL_MATH_RULE],
    fence: 'mermaid',
    trigger: /(?:mermaid|flow\s?chart|sequence\s?diagram|state\s?diagram|class\s?diagram|er\s?diagram|gantt|git\s?graph|quadrant|sankey|kanban|timeline|journey|requirement\s?diagram|时序图|顺序图|状态机|状态图|类图|er\s?[图図]|实体关系图|关系图|甘特|时间线|时间轴|看板|桑基|象限|流程图|フローチャート|シーケンス図|状態図|状態遷移|クラス図|構成図|순서도|시퀀스|상태도|클래스 다이어그램|구성도|diagrama de flujo|diagrama de secuencia|diagrama de estados|diagrama de clases|fluxograma|diagrama de sequência|diagrama de estados|diagrama de classes|блок-схем|последовательност|диаграмм[аы] состояни|диаграмм[аы] классов|flussdiagramm|sequenzdiagramm|zustandsdiagramm|klassendiagramm|organigramme|diagramme de séquence|diagramme d['’]états|diagramme de classes|diagramme de flux|mind\s?map|マインドマップ|마인드맵|mapa mental|carte mentale|интеллект-карт|mindmap|gliederung)/i,
  },
  {
    id: 'echarts',
    entries: [ECHARTS_RULE, ECHARTS_HTML_RULE],
    fence: 'echarts',
    trigger: /(?:echarts|图表|柱状图|条形图|折线图|饼图|散点图|雷达图|数据可视化|可视化|visuali[sz]|\bcharts?\b|\bplots?\b|\bgraphs?\b|グラフ|チャート|棒グラフ|折れ線|円グラフ|散布図|可視化|그래프|차트|막대 ?그래프|꺾은선|원형 ?그래프|산점도|시각화|gr[áa]fic[oa]s?|barras|tarta|pastel|dispersi[óo]n|pizza|график|столбчат|кругов|точечн|визуализ|balkendiagramm|kreisdiagramm|streudiagramm|liniendiagramm|visualisier|camembert|nuage de points|diagramme en barres)/i,
  },
  {
    id: 'markmap',
    entries: [MARKMAP_RULE],
    fence: 'markmap',
    trigger: /(?:markmap|思维导图|脑图|mind\s?map|大纲|\boutline\b|マインドマップ|마인드맵|mapa mental|carte mentale|интеллект-карт|mindmap|gliederung|개요)/i,
  },
  {
    id: 'smiles',
    entries: [SMILES_RULE],
    fence: 'smiles',
    trigger: /(?:smiles|分子|结构式|化学|molecule|molecular|chemical|compound|反应式|分子構造|化学構造|構造式|化学反応|분자|화학 구조|구조식|화학 반응|mol[ée]cula|estructura química|reacci[óo]n química|estrutura química|rea[çc][ãa]o química|молекул|химическ|molekül|chemische struktur|r[ée]action chimique|structure chimique)/i,
  },
  {
    id: 'pdb',
    entries: [PDB_RULE],
    fence: 'pdb',
    trigger: /(?:\bpdb\b|蛋白|protein|uni\s?prot|rcsb|alphafold|3d\s+structure|タンパク質|立体構造|단백질|3d\s*구조|prote[íi]nas?|prot[ée]ines?|estructura 3d|estrutura 3d|бел(?:ок|ка|ков)|3d-структур|proteinstruktur|structure 3d)/i,
  },
  {
    id: 'dot',
    entries: [DOT_RULE],
    fence: 'dot',
    trigger: /(?:graphviz|神经网络|neural\s+nets?|transformer|\bcnn\b|\bmlp\b|模型架构|网络架构|网络结构|依赖图|数据流|data\s?flow|架构图|block\s?diagram|architecture\s+(?:diagram|figure|chart)|(?:draw|plot|visuali[sz]e|diagram of|figure of)[^.!?\n]{0,40}architecture|ニューラルネット|神経回路|モデルアーキテクチャ|신경망|모델 아키텍처|red neuronal|rede neural|нейронн|граф зависимостей|neuronale[sn]?|modellarchitektur|r[ée]seau de neurones|architecture du mod[èe]le)/i,
  },
  {
    id: 'article',
    entries: [ARTICLE_STYLE_RULE],
    fence: null,
    trigger: /(?:润色|改写|成文|写成|整理成|转成文章|写(?:一|篇|成|出)[^，。,.!?！？]{0,10}文章|\bpolish\b|\brewrite\b|proofread|write\s+an?\s+article|turn\s+(?:this|it)\s+into\s+an?\s+article|添削|校正|推敲|書き直|記事に|文章に|記事作成|글을 써|작성해 ?글|다듬|교정|redacta|reescribe|reescribir|corrige|pule|redija|reescreva|revise|polir|перепиши|отредактируй|вычитай|überarbeit|umschreib|korrigier|réécri|reformul|en un art[íi]culo|als artikel|en article)/i,
  },
];

/**
 * 选出本轮真正要追加的渲染契约文本。
 * 历史命中按首次出现位置排序（纯尾部生长，缓存友好）；仅本轮触发词命中的
 * 家族排在历史家族之后，按家族表顺序稳定输出。
 */
const RENDER_FENCE_RE = /```(mermaid|dot|echarts|markmap|smiles|pdb)\b/g;
export function buildRenderHints({ history = [], userText = '' } = {}) {
  const texts = Array.isArray(history) ? history.map((t) => String(t || '')) : [];
  const text = String(userText || '');
  // 一趟扫描所有历史文本，记下每个家族围栏的首次出现位置（历史可能很长，
  // 逐家族 findIndex 会把同一份历史重扫 7 遍）。
  const firstAt = Object.create(null);
  let anyFence = false;
  for (let i = 0; i < texts.length; i++) {
    for (const m of texts[i].matchAll(RENDER_FENCE_RE)) {
      anyFence = true;
      if (firstAt[m[1]] === undefined) firstAt[m[1]] = i;
    }
  }
  const hits = [];
  for (let gi = 0; gi < RENDER_HINT_GROUPS.length; gi++) {
    const g = RENDER_HINT_GROUPS[gi];
    let at = Infinity;
    // routing（类型菜单/路由条款）没有自己的围栏：任何渲染围栏出现过就留住
    // 它，并固定排在最前。这样「第一次画图」之后每轮的输出 = 同一前缀 +
    // 尾部新增家族，不会因为 routing 掉队而让后面的字节整体前移。
    if (g.anyFence && anyFence) at = -1;
    if (g.fence && firstAt[g.fence] !== undefined) at = firstAt[g.fence];
    if (at === Infinity && g.trigger && g.trigger.test(text)) at = Number.MAX_SAFE_INTEGER;
    if (at !== Infinity) hits.push({ g, at, gi });
  }
  hits.sort((a, b) => (a.at - b.at) || (a.gi - b.gi));
  return hits.map((h) => h.g.entries.join(' ')).join(' ');
}

export function renderHintsTriggered({ history = [], userText = '' } = {}) {
  return buildRenderHints({ history, userText }) !== '';
}

/**
 * /prompt 检视器用：按存储的对话记录重算「上一轮用户消息实际选中的家族」。
 * 取最后一条 user 条目作为本轮文本，它之前的条目作为历史（围栏滞回），与
 * chat-handler 收到 CHAT 时的输入同形。没有对话时返回 ''。
 */
export function renderHintsForLastUserTurn(history) {
  const entries = Array.isArray(history) ? history : [];
  let idx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role === 'user') { idx = i; break; }
  }
  const prev = (idx >= 0 ? entries.slice(0, idx) : entries).map((m) => String(m?.text || ''));
  const lastUserText = idx >= 0 ? String(entries[idx]?.text || '') : '';
  return buildRenderHints({ history: prev, userText: lastUserText });
}

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
 * 组装发给无状态 LLM 渠道的 system prompt：base + 语言 + 能力提示底座 +
 * 选项协议 + 按需渲染契约。
 * 两个提示块由调用方按通道给：CHAT 两块都要；SUBCHAT 永不带 choiceRequestHint
 * ——卡片不解析 CHOICE_REQUEST 尾巴，带了会把原文漏进回复。renderHints 放
 * 最后：它是唯一按回合变化的块，放尾部让前面所有静态字节保持前缀命中。
 */
export function buildEffectiveSystemPrompt({ systemPrompt, replyLanguage } = {}, { capabilityHints = '', renderHints = '', choiceRequestHint = '' } = {}) {
  const langExtra = langInstruction(replyLanguage);
  return [systemPrompt || '', langExtra, capabilityHints, choiceRequestHint, renderHints]
    .map(s => s.trim()).filter(Boolean).join('\n\n');
}

/**
 * /prompt 检视器的分节视图——与 buildEffectiveSystemPrompt 同一套零件（所见
 * 即所发）。渲染契约按家族启用，检视器展示全部家族（标注为条件性）。
 */
export function effectiveSystemPromptSections({ systemPrompt, replyLanguage } = {}, { capabilityHints = '', renderHints = '', choiceRequestHint = '' } = {}) {
  const langExtra = langInstruction(replyLanguage);
  return [
    (systemPrompt || '').trim() && { label: 'Base system prompt', text: systemPrompt.trim() },
    langExtra && { label: 'Language instruction', text: langExtra },
    capabilityHints.trim() && { label: 'Capability hints (always)', text: capabilityHints.trim() },
    choiceRequestHint.trim() && { label: 'Choice request protocol', text: choiceRequestHint.trim() },
    renderHints.trim() && { label: 'Capability hints (render contract — the families selected for the last user turn; a new ask may append its family on top)', text: renderHints.trim() },
  ].filter(Boolean);
}
