export type FileMetrics = {
  path: string;
  additions: number;
  deletions: number;
  changedLines: number;
};

export type BranchMetrics = {
  filesChanged: number;
  additions: number;
  deletions: number;
  changedLines: number;
};

// Structure of one rendered row, produced when sections are wrapped, so the UI
// never has to recover block identity or wrap boundaries from display text.
export type SectionRow = {
  // Ordinal of the block (hunk) this row belongs to within its file, or -1
  // for rows before the first block header.
  block: number;
  // 'header' is the framed `• path:line:` row, 'frame' the blank and border
  // rows around it, 'body' everything else.
  kind: 'header' | 'frame' | 'body';
  // True when this row continues the previous row's source line after wrapping.
  continuation: boolean;
  // Cell column where code starts after delta's line-number gutter, when the
  // row has one.
  codeColumn?: number;
  // Header rows: the full display label (`• path:line:`) and its line number.
  label?: string;
  lineNumber?: number;
};

export type DiffSection = {
  path: string;
  signature?: string;
  metrics: FileMetrics;
  lines: string[];
  // Parallel to `lines` once the section has been wrapped.
  rows?: SectionRow[];
  startLine: number;
  endLineExclusive: number;
};

export const BLOCK_ACTION_LABELS = {
  code: 'Copy code',
  diff: 'Copy diff',
  prompt: 'Copy block',
} as const;

import {cellWidth, graphemes, toDisplayText, truncateStart} from './ui/text.js';

const ANSI_CSI_TOKEN = /(\[[0-9;:]*[A-Za-z])/;
const RESET = '[0m';
const SECTION_BORDER = '[36m';

type StyledCell = {
  char: string;
  style: string;
};

function toStyledCells(line: string): StyledCell[] {
  const parts = line.split(ANSI_CSI_TOKEN);
  const cells: StyledCell[] = [];
  let activeStyle = '';

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;

    if (i % 2 === 1) {
      if (!part.endsWith('m')) {
        continue;
      }

      activeStyle = part === RESET ? '' : activeStyle + part;
      continue;
    }

    for (let index = 0; index < part.length; index += 1) {
      cells.push({char: part[index], style: activeStyle});
    }
  }

  return cells;
}

function renderStyledCells(cells: StyledCell[]): string {
  if (cells.length === 0) {
    return RESET;
  }

  let output = '';
  let currentStyle = '';

  for (const cell of cells) {
    if (cell.style !== currentStyle) {
      if (currentStyle) {
        output += RESET;
      }

      if (cell.style) {
        output += cell.style;
      }

      currentStyle = cell.style;
    }

    output += cell.char;
  }

  return output + RESET;
}

function isWhitespace(char: string) {
  return /\s/.test(char);
}

function tokenizeCells(cells: StyledCell[]) {
  const tokens: Array<{start: number; end: number}> = [];
  let index = 0;

  while (index < cells.length) {
    const start = index;

    while (index < cells.length && isWhitespace(cells[index].char)) {
      index += 1;
    }

    if (index === cells.length) {
      tokens.push({start, end: index});
      break;
    }

    while (index < cells.length && !isWhitespace(cells[index].char)) {
      index += 1;
    }

    while (index < cells.length && isWhitespace(cells[index].char)) {
      index += 1;
    }

    tokens.push({start, end: index});
  }

  return tokens;
}

function buildPlainPrefix(prefix: string): StyledCell[] {
  return [...prefix].map((char) => ({char, style: ''}));
}

function normalizeSgrToken(token: string): string {
  if (!token.endsWith('m')) return '';

  const rawParams = token.slice(2, -1).replaceAll(':', ';');
  const params = rawParams ? rawParams.split(';') : ['0'];
  const groups: string[][] = [];

  for (let index = 0; index < params.length;) {
    const code = params[index] || '0';
    const mode = params[index + 1];
    if ((code === '38' || code === '48') && mode === '2' && index + 4 < params.length) {
      groups.push(params.slice(index, index + 5));
      index += 5;
      continue;
    }

    if ((code === '38' || code === '48') && mode === '5' && index + 2 < params.length) {
      groups.push(params.slice(index, index + 3));
      index += 3;
      continue;
    }

    groups.push([code]);
    index += 1;
  }

  return groups.map((group) => `\x1B[${group.join(';')}m`).join('');
}

function stripNonSgrCsi(line: string): string {
  return line.replace(/\x1B\[[0-9;:]*[A-Za-z]/g, normalizeSgrToken);
}

export function truncateAnsi(line: string, maxWidth: number) {
  if (maxWidth <= 0) {
    return RESET;
  }

  const cleaned = stripNonSgrCsi(line);
  if (visibleWidth(cleaned) <= maxWidth) {
    return cleaned;
  }

  const parts = cleaned.split(ANSI_CSI_TOKEN);
  let output = '';
  let visible = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;

    if (i % 2 === 1) {
      if (part.endsWith('m')) {
        output += part;
      }
      continue;
    }

    for (const grapheme of graphemes(part)) {
      if (visible + grapheme.width > maxWidth) {
        return output + RESET;
      }
      output += grapheme.text;
      visible += grapheme.width;
    }
  }

  return output + RESET;
}

export function getContinuationPrefix(line: string): string {
  const plain = line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  const gutterIndex = plain.indexOf('│');

  if (gutterIndex >= 0) {
    const separatorPadding = plain[gutterIndex + 1] === ' ' ? ' ' : '';
    return `${' '.repeat(cellWidth(plain.slice(0, gutterIndex)))}│${separatorPadding}`;
  }

  const bulletMatch = plain.match(/^(\s*(?:[+\-•])\s+)/);
  if (bulletMatch) {
    return ' '.repeat(bulletMatch[1].length);
  }

  const indentMatch = plain.match(/^(\s+)/);
  return indentMatch?.[1] ?? '';
}

type AnsiSegment = {text: string; visible: number};

function segmentize(line: string): AnsiSegment[] {
  const parts = line.split(ANSI_CSI_TOKEN);
  const segments: AnsiSegment[] = [];
  let text = '';
  let visible = 0;
  let prevWasWhitespace = true;

  const commit = () => {
    if (text === '' && visible === 0) return;
    segments.push({text, visible});
    text = '';
    visible = 0;
  };

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;

    if (i % 2 === 1) {
      if (!part.endsWith('m')) continue;
      text += part;
      continue;
    }

    for (const grapheme of graphemes(part)) {
      const isWs = /^\s+$/.test(grapheme.text);
      if (!isWs && prevWasWhitespace && visible > 0) {
        commit();
      }
      text += grapheme.text;
      visible += grapheme.width;
      prevWasWhitespace = isWs;
    }
  }

  commit();
  return segments;
}

// Splits off the longest head of `segment` that fits in `amount` cells without
// splitting a grapheme. With `atLeastOne`, a grapheme wider than `amount` is
// still taken so wrapping always makes progress on an empty row.
function takeVisible(
  segment: AnsiSegment,
  amount: number,
  atLeastOne = false,
): {head: AnsiSegment; tail: AnsiSegment} {
  if (amount >= segment.visible) {
    return {head: segment, tail: {text: '', visible: 0}};
  }

  const parts = segment.text.split(ANSI_CSI_TOKEN);
  let headText = '';
  let tailText = '';
  let taken = 0;
  let stopped = false;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;

    if (i % 2 === 1) {
      if (!part.endsWith('m')) continue;
      if (!stopped && taken < amount) {
        headText += part;
      } else {
        tailText += part;
      }
      continue;
    }

    for (const grapheme of graphemes(part)) {
      const fits = taken + grapheme.width <= amount || (atLeastOne && taken === 0);
      if (!stopped && fits) {
        headText += grapheme.text;
        taken += grapheme.width;
      } else {
        stopped = true;
        tailText += grapheme.text;
      }
    }
  }

  if (taken === 0) {
    return {head: {text: '', visible: 0}, tail: segment};
  }

  return {
    head: {text: headText, visible: taken},
    tail: {text: tailText, visible: segment.visible - taken},
  };
}

function updateActiveStyle(segmentText: string, activeStyle: string): string {
  const parts = segmentText.split(ANSI_CSI_TOKEN);
  let next = activeStyle;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1 && part && part.endsWith('m')) {
      next = part === RESET ? '' : next + part;
    }
  }
  return next;
}

export function wrapAnsi(line: string, maxWidth: number, continuationPrefix = ''): string[] {
  return wrapAnsiRows(line, maxWidth, continuationPrefix).rows;
}

// Wraps one source line and reports the continuation prefix actually used, so
// callers can tell where content starts on continuation rows.
function wrapAnsiRows(line: string, maxWidth: number, continuationPrefix = ''): {rows: string[]; prefix: string} {
  if (maxWidth <= 0) {
    return {rows: [''], prefix: ''};
  }

  const cleaned = stripNonSgrCsi(line);
  if (visibleWidth(cleaned) <= maxWidth) {
    return {rows: [cleaned], prefix: ''};
  }

  const safePrefix = continuationPrefix && cellWidth(continuationPrefix) < maxWidth ? continuationPrefix : '';
  const prefixWidth = cellWidth(safePrefix);
  const segments = segmentize(cleaned);

  const result: string[] = [];
  let lineText = '';
  let lineVisible = 0;
  let activeStyle = '';

  const flushLine = () => {
    if (lineText === '' && lineVisible === 0) return;
    result.push(lineText + RESET);
    lineText = safePrefix + activeStyle;
    lineVisible = prefixWidth;
  };

  for (const segment of segments) {
    if (segment.visible === 0) {
      lineText += segment.text;
      activeStyle = updateActiveStyle(segment.text, activeStyle);
      continue;
    }

    if (lineVisible + segment.visible <= maxWidth) {
      lineText += segment.text;
      lineVisible += segment.visible;
      activeStyle = updateActiveStyle(segment.text, activeStyle);
      continue;
    }

    if (lineVisible > prefixWidth && segment.visible <= maxWidth - prefixWidth) {
      flushLine();
      lineText += segment.text;
      lineVisible += segment.visible;
      activeStyle = updateActiveStyle(segment.text, activeStyle);
      continue;
    }

    let remaining = segment;
    while (remaining.visible > 0) {
      const available = maxWidth - lineVisible;
      const {head, tail} = takeVisible(remaining, Math.max(0, available), lineVisible <= prefixWidth);
      if (head.visible === 0) {
        flushLine();
        continue;
      }

      lineText += head.text;
      lineVisible += head.visible;
      activeStyle = updateActiveStyle(head.text, activeStyle);
      remaining = tail;

      if (remaining.visible > 0) {
        flushLine();
      }
    }
  }

  if (lineVisible > 0 || (lineText !== '' && result.length === 0)) {
    result.push(lineText + RESET);
  }

  if (result.length === 0) {
    return {rows: [''], prefix: safePrefix};
  }

  return {rows: result, prefix: safePrefix};
}

export function visibleWidth(line: string): number {
  return cellWidth(line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, ''));
}

export function padToWidth(line: string, width: number): string {
  const diff = width - visibleWidth(line);
  return diff > 0 ? line + ' '.repeat(diff) : line;
}

export function frameLine(
  line: string,
  innerWidth: number,
  borderAnsi: string,
): string {
  const truncated = truncateAnsi(line, innerWidth);
  const padded = padToWidth(truncated, innerWidth);
  const vbar = `${borderAnsi}\u2502${RESET}`;
  return `${vbar} ${padded} ${vbar}`;
}

export function frameTopBorder(paneWidth: number, borderAnsi: string): string {
  const inner = paneWidth - 2;
  return `${borderAnsi}\u256D${'\u2500'.repeat(inner)}\u256E${RESET}`;
}

export function frameBottomBorder(paneWidth: number, borderAnsi: string): string {
  const inner = paneWidth - 2;
  return `${borderAnsi}\u2570${'\u2500'.repeat(inner)}\u256F${RESET}`;
}

export function wrapSections(sections: DiffSection[], maxWidth: number): DiffSection[] {
  let cursor = 0;
  return sections.map((section) => {
    const lines: string[] = [];
    const rows: SectionRow[] = [];
    let block = -1;

    for (const line of section.lines) {
      const header = parseBlockHeader(line, section.path);
      if (header) {
        block += 1;
        const framed = frameBlockHeader(header.label, maxWidth);
        lines.push(...framed.lines);
        rows.push(...framed.kinds.map((kind): SectionRow => kind === 'header'
          ? {block, kind, continuation: false, label: header.label, lineNumber: header.lineNumber}
          : {block, kind, continuation: false}));
        continue;
      }

      const plain = stripAnsi(line);
      const gutterIndex = plain.indexOf('│');
      const wrapped = wrapAnsiRows(line, maxWidth, getContinuationPrefix(line));
      for (const [index, row] of wrapped.rows.entries()) {
        lines.push(row);
        rows.push({
          block,
          kind: 'body',
          continuation: index > 0,
          ...(index === 0 && gutterIndex > 0
            ? {codeColumn: cellWidth(plain.slice(0, gutterIndex + 1))}
            : index > 0 && wrapped.prefix.includes('│')
              ? {codeColumn: cellWidth(wrapped.prefix)}
              : {}),
        });
      }
    }

    const startLine = cursor;
    const endLineExclusive = cursor + lines.length;
    cursor = endLineExclusive;

    return {
      path: section.path,
      signature: section.signature,
      metrics: section.metrics,
      lines,
      rows,
      startLine,
      endLineExclusive,
    };
  });
}

// Delta renders each hunk header as `• <path>:<line>: <context>`. The label
// keeps `• <path>:<line>:`; when the file's own path prefixes the line it is
// used verbatim, so a path that itself contains `:<digits>:` stays whole.
function parseBlockHeader(line: string, path: string): {label: string; lineNumber: number} | null {
  const plain = stripAnsi(line);
  if (!/^• .+:\d+:/s.test(plain)) return null;

  const ownPrefix = `• ${path}:`;
  const ownLine = plain.startsWith(ownPrefix) ? plain.slice(ownPrefix.length).match(/^(\d+):/) : null;
  const label = ownLine
    ? `${ownPrefix}${ownLine[1]}:`
    : plain.replace(/^(•\s+.+?:\d+:).*$/s, '$1');
  const lineNumber = Number(label.match(/:(\d+):$/)?.[1]);
  return {label: toDisplayText(label), lineNumber};
}

// Fits a block header label on one row by dropping the start of the path,
// the way the file header does, so a header never wraps.
export function fitBlockHeaderLabel(label: string, maxWidth: number) {
  if (cellWidth(label) <= maxWidth) return label;
  const marker = label.slice(0, 2);
  return `${marker}${truncateStart(label.slice(2), Math.max(0, maxWidth - 2))}`;
}

function frameBlockHeader(label: string, maxWidth: number): {lines: string[]; kinds: SectionRow['kind'][]} {
  if (maxWidth < 4) {
    return {lines: [truncateAnsi(label, Math.max(maxWidth, 0))], kinds: ['header']};
  }

  const innerWidth = maxWidth - 4;
  return {
    lines: [
      '',
      frameTopBorder(maxWidth, SECTION_BORDER),
      frameLine(fitBlockHeaderLabel(label, innerWidth), innerWidth, SECTION_BORDER),
      frameBottomBorder(maxWidth, SECTION_BORDER),
      '',
    ],
    kinds: ['frame', 'frame', 'header', 'frame', 'frame'],
  };
}

function stripAnsi(line: string) {
  return line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function yellow(text: string) {
  return `\u001B[33m${text}\u001B[0m`;
}

function green(text: string) {
  return `\u001B[32m${text}\u001B[0m`;
}

function red(text: string) {
  return `\u001B[31m${text}\u001B[0m`;
}

export function formatMetrics(metrics: Pick<FileMetrics, 'additions' | 'deletions' | 'changedLines'>) {
  return `${green(`+${metrics.additions}`)} ${red(`-${metrics.deletions}`)} ${yellow(`${metrics.changedLines} changed`)}`;
}

export function buildDiffSections(input: Array<{path: string; signature?: string; metrics: FileMetrics; diff: string}>): DiffSection[] {
  const sections: DiffSection[] = [];
  let lineCursor = 0;

  for (const entry of input) {
    const diffLines = entry.diff.trimEnd().split('\n').filter(Boolean);
    const lines = [
      ...diffLines,
      '',
    ];

    sections.push({
      path: entry.path,
      signature: 'signature' in entry && typeof entry.signature === 'string' ? entry.signature : undefined,
      metrics: entry.metrics,
      lines,
      startLine: lineCursor,
      endLineExclusive: lineCursor + lines.length,
    });

    lineCursor += lines.length;
  }

  return sections;
}

export function flattenSectionLines(sections: DiffSection[]) {
  return sections.flatMap((section) => section.lines);
}

export function getSectionIndexForLine(
  sections: ReadonlyArray<Pick<DiffSection, 'startLine' | 'endLineExclusive'>>,
  lineOffset: number,
) {
  if (sections.length === 0) {
    return -1;
  }

  for (const [index, section] of sections.entries()) {
    if (lineOffset >= section.startLine && lineOffset < section.endLineExclusive) {
      return index;
    }
  }

  return sections.length - 1;
}

export function getSectionForLine(sections: DiffSection[], lineOffset: number) {
  const index = getSectionIndexForLine(sections, lineOffset);
  return index >= 0 ? sections[index] : null;
}
