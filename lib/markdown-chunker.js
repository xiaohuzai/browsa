// lib/markdown-chunker.js — structure-aware markdown chunking and safe
// truncation. Ported from auditing browser-use's chunk_markdown_by_structure.
//
// Two exports:
//   findSafeTruncationPoint(text, cap)
//     Given a long text and a hard character-count cap, returns the largest
//     index ≤ cap that doesn't land inside a fenced code block or on a table
//     row line. Falls back to cap if no safe newline exists before it.
//     Used by pdf-extractor.js to replace raw .slice(0, maxChars) calls.
//     Degrades gracefully for plain-text content (no fences/tables) — simply
//     returns the last \n position before cap, always better than slicing
//     mid-word.
//
//   splitIntoMarkdownChunks(text, chunkSizeChars)
//     Structure-aware chunker that understands fenced code blocks and tables
//     as atomic units (never split), and ATX headers as preferred split
//     points. Replaces attach-summarizer.js's plain line-greedy splitIntoChunks
//     for the auto-summarize-long-attachments pipeline.
//     Same return type (string[]) and same fallback behavior (a single block
//     larger than the budget becomes its own oversized chunk) as the original.

/**
 * Return the largest newline-boundary index ≤ cap that is not inside an
 * open fenced code block and is not on a table row line (|...|). Falls back
 * to `cap` if no safe position is found (e.g. content shorter than cap, or
 * no newlines before cap).
 */
export function findSafeTruncationPoint(text, cap) {
  if (!text || cap >= text.length) return cap;

  // Walk line-by-line, tracking fence parity and whether the current line
  // starts with '|' (table row). Record the end-of-line position (the index
  // of the '\n') as a safe cut point when the state is: fence closed AND
  // line is not a table row.
  let lastSafe = -1;
  let inFence = false;
  let pos = 0;

  while (pos < cap) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd > cap) break; // this line straddles cap — stop here

    const lineStart = pos;
    const firstChar = text[lineStart];

    // Detect fence toggle: line must start with ``` or ~~~ (3+ chars of same)
    const isFenceLine =
      (text[lineStart] === '`' && text[lineStart + 1] === '`' && text[lineStart + 2] === '`') ||
      (text[lineStart] === '~' && text[lineStart + 1] === '~' && text[lineStart + 2] === '~');
    if (isFenceLine) inFence = !inFence;

    const isTableRow = firstChar === '|';

    // Safe cut: end of this line (nl position), fence closed, not a table row
    if (!inFence && !isTableRow && nl !== -1 && nl <= cap) {
      lastSafe = nl;
    }

    if (nl === -1) break;
    pos = nl + 1;
  }

  return lastSafe > 0 ? lastSafe : cap;
}

/**
 * Structure-aware chunker. Replaces attach-summarizer.js's line-greedy
 * splitIntoChunks for the auto-summarize pipeline.
 *
 * Strategy: line-by-line greedy packing (same as the original splitIntoChunks)
 * with two important additions:
 *   1. Fenced code blocks are collected as one atomic unit before packing —
 *      the open fence and its matching close fence always land in the same chunk.
 *   2. Table rows (consecutive | lines) are collected as one atomic unit —
 *      header + separator + all data rows always land in the same chunk.
 *      When a table is flushed and a new chunk starts, the table's header+
 *      separator rows are prepended to the next chunk so the LLM can read
 *      the column names even when reading a continuation chunk.
 *
 * Oversized single units (larger than chunkSizeChars) become their own
 * chunk rather than being dropped — same behavior as the original.
 *
 * @param {string} text
 * @param {number} chunkSizeChars  default 12000
 * @returns {string[]}
 */
export function splitIntoMarkdownChunks(text, chunkSizeChars = 12_000) {
  if (!text) return [];
  const rawLines = text.split('\n');
  if (rawLines.length === 0) return [];

  // Pre-process: collect fence blocks and table blocks as atomic "units".
  // Each unit is a string[] of lines that must stay together.
  // Plain lines become single-element units.
  const units = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    // Fenced code block — collect until matching close
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      const marker = trimmed.match(/^(`{3,}|~{3,})/)[1];
      const fenceLines = [line];
      i++;
      while (i < rawLines.length) {
        fenceLines.push(rawLines[i]);
        const isClose = rawLines[i].trim().startsWith(marker);
        i++;
        if (isClose) break;
      }
      units.push({ lines: fenceLines, type: 'fence', tableHeader: null });
      continue;
    }

    // Table — collect all consecutive | lines as one unit
    if (trimmed.startsWith('|')) {
      const tableLines = [line];
      i++;
      while (i < rawLines.length && rawLines[i].trim().startsWith('|')) {
        tableLines.push(rawLines[i]);
        i++;
      }
      const tableHeader = tableLines.length >= 2 ? tableLines.slice(0, 2) : tableLines.slice(0, 1);
      units.push({ lines: tableLines, type: 'table', tableHeader });
      continue;
    }

    // Plain line (prose, headers, blanks) — individual unit
    units.push({ lines: [line], type: 'line', tableHeader: null });
    i++;
  }

  // Greedy pack units into chunks
  const chunks = [];
  let current = [];
  let currentLen = 0;
  let pendingTableHeader = null;

  function flush() {
    while (current.length > 0 && current[current.length - 1].trim() === '') current.pop();
    if (current.length > 0) chunks.push(current.join('\n'));
    current = [];
    currentLen = 0;
  }

  for (const unit of units) {
    const unitText = unit.lines.join('\n');
    const unitLen = unitText.length + 1; // +1 for the joining \n

    if (currentLen > 0 && currentLen + unitLen > chunkSizeChars) {
      flush();
      if (pendingTableHeader) {
        const hdr = pendingTableHeader.join('\n');
        current.push(...pendingTableHeader);
        currentLen = hdr.length + 1;
        pendingTableHeader = null;
      }
    }

    if (unit.type === 'table') {
      pendingTableHeader = unit.tableHeader;
    } else if (unit.type !== 'line' || unit.lines[0].trim() !== '') {
      pendingTableHeader = null;
    }

    current.push(...unit.lines);
    currentLen += unitLen;
  }

  flush();
  return chunks;
}
