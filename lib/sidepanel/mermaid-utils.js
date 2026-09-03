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
  for (const rawLine of code.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) continue;
    const match = line.match(/^([A-Z][\w-]*)\b/i);
    return match?.[1]?.toLowerCase() || '';
  }
  return '';
}

export function estimateMermaidPreviewHeight(code) {
  const meaningfulLines = code
    .split(/\r?\n/)
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
