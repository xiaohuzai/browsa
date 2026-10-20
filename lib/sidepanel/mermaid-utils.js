// lib/sidepanel/mermaid-utils.js — ported near-verbatim from markstream-vue's
// src/utils/diagramHeight.ts and src/utils/mermaidSequenceSemicolons.ts
// (framework-free logic, confirmed by reading the source directly — the
// Vue component wiring around them was NOT ported, only the pure functions).

// ─── Preview-height estimation (reduces the layout jump between the raw
// code-fence placeholder and the real diagram once rendered) ──────────────

// Not exported -- only used as default params for clampMermaidPreviewHeight
// below, never referenced from another module or test.
const MERMAID_PREVIEW_MIN_HEIGHT = 60; // matches browsa's existing .mermaid-diagram min-height
const MERMAID_PREVIEW_MAX_HEIGHT = 500;

export function getMermaidDiagramKind(code) {
  const lines = String(code ?? '').split(/\r?\n/);
  for (let i = _diagramScanStart(lines); i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('%%')) continue;
    const match = line.match(/^([A-Z][\w-]*)\b/i);
    return match?.[1]?.toLowerCase() || '';
  }
  return '';
}

export function estimateMermaidPreviewHeight(code) {
  const all = String(code ?? '').split(/\r?\n/);
  // front matter 不是图内容：预览高度只数 `---` 闭合之后的真实行（pele 的
  // front matter 处理同款；否则带 title 的图会多算 2-4 行高度）。
  const meaningfulLines = all
    .slice(_diagramScanStart(all))
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('%%'));
  const lineCount = Math.max(1, meaningfulLines.length);
  const kind = getMermaidDiagramKind(code);

  if (kind === 'gantt') return 220 + lineCount * 28;
  if (kind === 'sequencediagram') return 180 + lineCount * 26;
  if (kind === 'classdiagram' || kind === 'statediagram' || kind === 'erdiagram') return 180 + lineCount * 24;
  if (kind === 'flowchart' || kind === 'graph') return 170 + lineCount * 28;
  return 200 + lineCount * 22;
}

export function clampMermaidPreviewHeight(height, minHeight = MERMAID_PREVIEW_MIN_HEIGHT, maxHeight = MERMAID_PREVIEW_MAX_HEIGHT) {
  return maxHeight == null
    ? Math.max(minHeight, height)
    : Math.min(Math.max(minHeight, height), maxHeight);
}

// ─── Sequence-diagram semicolon escaping (works around a real mermaid.js
// parser quirk: a bare `;` inside sequence-diagram message/Note text — e.g.
// dialogue containing a SQL snippet like "BEGIN; SELECT ... FOR UPDATE" —
// breaks the parser, since mermaid treats `;` as a statement terminator) ──

const SEMICOLON_ENTITY = '#59;';

function isEscapedEntityBefore(text, index) {
  return /(?:&#\d+|#\d+|&[a-z]+)$/i.test(text.slice(Math.max(0, index - 12), index));
}

function hasSequenceArrow(text) {
  return text.includes('->') || text.includes('-->') || text.includes('->>') || text.includes('-->>')
    || text.includes('-x') || text.includes('--x') || text.includes('-)') || text.includes('--)')
    || text.includes('-+') || text.includes('--+');
}

function startsSequenceMessage(text) {
  const segment = text.split(';', 1)[0];
  const colonIndex = segment.indexOf(':');
  return colonIndex > 0 && hasSequenceArrow(segment.slice(0, colonIndex));
}

function startsSequenceStatement(text) {
  const source = text.trimStart();
  return /^(?:accDescr|accTitle|activate|actor|and|alt|autonumber|box|break|critical|create\s+(?:actor|participant)|deactivate|destroy|else|end|link|links|loop|Note|opt|option|par|participant|properties|rect)\b/i.test(source)
    || startsSequenceMessage(source);
}

function isSequenceTextLine(line, colonIndex) {
  const prefix = line.slice(0, colonIndex);
  return /^\s*Note\b/i.test(prefix) || hasSequenceArrow(prefix);
}

function escapeTextSemicolons(text) {
  let escaped = '';
  let changed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== ';' || isEscapedEntityBefore(text, index)) {
      escaped += char;
      continue;
    }
    if (startsSequenceStatement(text.slice(index + 1))) {
      escaped += char;
      continue;
    }
    escaped += SEMICOLON_ENTITY;
    changed = true;
  }
  return changed ? escaped : text;
}

function escapeLine(line) {
  if (!line.includes(';')) return line;
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1 || !isSequenceTextLine(line, colonIndex)) return line;
  const beforeText = line.slice(0, colonIndex + 1);
  const text = line.slice(colonIndex + 1);
  const escapedText = escapeTextSemicolons(text);
  return escapedText === text ? line : `${beforeText}${escapedText}`;
}

export function escapeSequenceTextSemicolons(code) {
  if (getMermaidDiagramKind(code) !== 'sequencediagram') return code;
  const parts = code.split(/(\r\n|\n|\r)/);
  let changed = false;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const escapedLine = escapeLine(line);
    if (escapedLine !== line) {
      parts[index] = escapedLine;
      changed = true;
    }
  }
  return changed ? parts.join('') : code;
}

// Retries a Mermaid render once, with sequence-diagram semicolons escaped,
// if the first attempt fails — isolated as a pure function (injectable `m`)
// so it's testable without loading the real mermaid vendor bundle.
export async function renderMermaidWithRetry(m, id, source, host) {
  try {
    return await m.render(id, source, host);
  } catch (e) {
    const escaped = escapeSequenceTextSemicolons(source);
    if (escaped === source) throw e; // nothing to retry with — rethrow original error
    return await m.render(id, escaped, host);
  }
}

// ─── Flowchart direction detect/toggle（2026-10-19，借 pele 的 autoDirection
// 思路——窄侧栏里横向图会被 max-width:100% 缩成蚂蚁；mermaid 没有运行期换向，
// 所以提供一个用户可控的横/纵切换，只改写首行的显式方向 token）─────────────
// 语法覆盖：flowchart / flowchart-elk / graph + LR|RL|TD|TB|BT。front matter
// （--- … ---）、%% 注释与 %%{…}%% 指令行都跳过；没有显式方向（如裸
// `flowchart`）返回 null——不猜测、不注入。
const MERMAID_FLOW_DIRECTION_RE = /^(flowchart(?:-elk)?|graph)\s+(LR|RL|TD|TB|BT)(?=\s|;|$)(.*)$/;

function _diagramScanStart(lines) {
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (lines[start]?.trim() === '---') {
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') return i + 1;
    }
  }
  return start;
}

// ─── Front matter config 剥离（2026-10-19 安全审计）─────────────────────────
// mermaid 12 的 front matter `config:` 走 `cleanAndMerge` 直接 merge，**不经过**
// directive 的 `sanitize()`：`secure` 列表与 `<`/`>`/`url(data:` 过滤都绕过了。
// 模型可以在图源里写
//   ---
//   config:
//     themeCSS: "body{display:none}"
//     maxEdges: 999999
//   ---
// 注入页面级 CSS、抬高渲染上限。browsa 的主题/字体/上限全部由宿主配置，per-
// diagram config 不在 prompt 契约里——整块剥掉，保留 title/displayMode。
export function stripFrontMatterConfig(code) {
  const src = String(code ?? '');
  const lines = src.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (lines[start]?.trim() !== '---') return src;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return src;

  const body = lines.slice(start + 1, end);
  const blank = new Set();
  const opens = (s) => (s.match(/[{\[]/g) || []).length;
  const closes = (s) => (s.match(/[}\]]/g) || []).length;
  for (let i = 0; i < body.length; i++) {
    const m = body[i].match(/^(\s*)["']?config["']?\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const inline = m[2].replace(/#.*$/, '').trim();
    let j = i + 1;
    if (inline && !/^[|>][-+]?$/.test(inline)) {
      // 同行标量，或跨行的 flow 集合（config: { … } / [ … ]）。
      let depth = opens(inline) - closes(inline);
      while (depth > 0 && j < body.length) {
        depth += opens(body[j]) - closes(body[j]);
        j++;
      }
    } else {
      // 空值（块映射）或块标量：一直吞到缩进回到 config 同级的行。
      for (; j < body.length; j++) {
        const line = body[j];
        if (line.trim() === '') continue;
        if ((line.match(/^\s*/)[0].length) <= indent) break;
      }
    }
    for (let k = i; k < j; k++) blank.add(k);
    i = j - 1; // 继续扫，重复的 config: 键同样要剥（YAML 重复键不可信）
  }
  if (blank.size === 0) return src;
  // 用空行替换而不是删除：mermaid 的 parse error 行号是相对剥后源码的，
  // 行数一变，「第 N 行」就和下面展示的原始 source 对不上（pele 的
  // remapErrorLines 处理的是同一类问题；保留行数是更省事的等价解法）。
  const kept = body.map((line, i) => (blank.has(i) ? '' : line));
  const out = [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)];
  return out.join(/\r\n/.test(src) ? '\r\n' : '\n');
}

export function findMermaidFlowDirection(code) {
  const lines = String(code ?? '').split(/\r?\n/);
  for (let i = _diagramScanStart(lines); i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('%%')) continue;
    const m = trimmed.match(MERMAID_FLOW_DIRECTION_RE);
    if (!m) return null;
    return {
      lineIndex: i,
      keyword: m[1],
      direction: m[2],
      horizontal: m[2] === 'LR' || m[2] === 'RL',
      rest: m[3],
    };
  }
  return null;
}

// 横向 → 纵向（TD）；纵向 → `horizontalDirection`（默认 LR，调用方记住用户
// 原来的 RL 以便切回来）。返回 null = 这张图没有可切的方向 token。
export function toggleMermaidDirection(code, horizontalDirection = 'LR') {
  const hit = findMermaidFlowDirection(code);
  if (!hit) return null;
  const to = hit.horizontal ? 'TD' : (horizontalDirection === 'RL' ? 'RL' : 'LR');
  const eol = /\r\n/.test(code) ? '\r\n' : '\n';
  const lines = String(code).split(/\r?\n/);
  const line = lines[hit.lineIndex];
  const indent = line.match(/^\s*/)[0];
  lines[hit.lineIndex] = `${indent}${hit.keyword} ${to}${hit.rest}`;
  return { source: lines.join(eol), from: hit.direction, to };
}

// ─── Parse-error 短句提取（错误卡不再全量甩 token 转储）─────────────────────
// mermaid 的 parse error 形如四行：
//   Parse error on line 12:
//   <出错原文摘录>
//   <脱字符定位行>
//   Expecting 'X', 'Y', ... got 'Z'
// 抽出行号 + 出错原文 + Expecting 尾巴给错误卡短句展示；完整原文收进「查看源码」。
// 非 parse error（模块加载失败、渲染期异常）返回 null，调用方回退展示原始 message。
export function formatMermaidParseError(message) {
  const m = String(message ?? '')
    .match(/Parse error on line (\d+):\s*\n([^\n]*)\n[^\n]*\^[^\n]*\n?\s*(Expecting[^\n]*)/);
  if (!m) return null;
  return {
    line: Number(m[1]),
    excerpt: m[2].trim(),
    expecting: m[3].trim(),
  };
}

// ─── 围栏语言别名（模型常把图类型直接当围栏语言）───────────────────────────
// The prompt teaches ```mermaid, but models sometimes emit ```quadrantChart /
// ```sequenceDiagram / ```gantt. Treat the diagram-type names as mermaid fences
// so those blocks render instead of staying raw code. Lowercase; the class-name
// lookup lowercases the language token too.
const MERMAID_FENCE_ALIASES = new Set([
  'mermaid',
  'flowchart', 'graph', 'sequencediagram', 'classdiagram',
  'statediagram', 'statediagram-v2', 'erdiagram', 'journey', 'gantt', 'pie',
  'quadrantchart', 'requirementdiagram', 'gitgraph',
  'c4context', 'c4container', 'c4component', 'c4dynamic', 'c4deployment',
  'mindmap', 'timeline', 'sankey-beta', 'xychart-beta', 'block-beta',
  'packet-beta', 'architecture-beta', 'radar-beta', 'treemap-beta', 'kanban',
]);

export function isMermaidFenceLanguage(lang) {
  return MERMAID_FENCE_ALIASES.has(String(lang || '').trim().toLowerCase());
}
