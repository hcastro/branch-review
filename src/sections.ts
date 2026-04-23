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

export type DiffSection = {
  path: string;
  metrics: FileMetrics;
  lines: string[];
  startLine: number;
  endLineExclusive: number;
};

const ANSI_CSI_TOKEN = /(\[[0-9;]*[A-Za-z])/;
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

function stripNonSgrCsi(line: string): string {
  return line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, (match) => (match.endsWith('m') ? match : ''));
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

    for (const ch of part) {
      if (visible >= maxWidth) {
        return output + RESET;
      }
      output += ch;
      visible += 1;
    }
  }

  return output + RESET;
}

export function getContinuationPrefix(line: string): string {
  const plain = line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  const gutterIndex = plain.indexOf('│');

  if (gutterIndex >= 0) {
    const separatorPadding = plain[gutterIndex + 1] === ' ' ? ' ' : '';
    return `${' '.repeat(gutterIndex)}│${separatorPadding}`;
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

    for (const ch of part) {
      const isWs = /\s/.test(ch);
      if (!isWs && prevWasWhitespace && visible > 0) {
        commit();
      }
      text += ch;
      visible += 1;
      prevWasWhitespace = isWs;
    }
  }

  commit();
  return segments;
}

function takeVisible(
  segment: AnsiSegment,
  amount: number,
): {head: AnsiSegment; tail: AnsiSegment} {
  if (amount >= segment.visible) {
    return {head: segment, tail: {text: '', visible: 0}};
  }

  const parts = segment.text.split(ANSI_CSI_TOKEN);
  let headText = '';
  let tailText = '';
  let taken = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;

    if (i % 2 === 1) {
      if (!part.endsWith('m')) continue;
      if (taken < amount) {
        headText += part;
      } else {
        tailText += part;
      }
      continue;
    }

    for (const ch of part) {
      if (taken < amount) {
        headText += ch;
        taken += 1;
      } else {
        tailText += ch;
      }
    }
  }

  return {
    head: {text: headText, visible: amount},
    tail: {text: tailText, visible: segment.visible - amount},
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
  if (maxWidth <= 0) {
    return [''];
  }

  const cleaned = stripNonSgrCsi(line);
  if (visibleWidth(cleaned) <= maxWidth) {
    return [cleaned];
  }

  const safePrefix = continuationPrefix && continuationPrefix.length < maxWidth ? continuationPrefix : '';
  const prefixWidth = safePrefix.length;
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
      if (available <= 0) {
        flushLine();
        continue;
      }

      const {head, tail} = takeVisible(remaining, available);
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
    return [''];
  }

  return result;
}

export function visibleWidth(line: string): number {
  return line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').length;
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
    const wrappedLines = section.lines.flatMap((line) => wrapSectionLine(line, maxWidth));
    const startLine = cursor;
    const endLineExclusive = cursor + wrappedLines.length;
    cursor = endLineExclusive;

    return {
      path: section.path,
      metrics: section.metrics,
      lines: wrappedLines,
      startLine,
      endLineExclusive,
    };
  });
}

function wrapSectionLine(line: string, maxWidth: number) {
  if (isHunkHeader(line)) {
    return frameWrappedLines(wrapAnsi(line, Math.max(maxWidth - 4, 1), getContinuationPrefix(line)), maxWidth);
  }

  return wrapAnsi(line, maxWidth, getContinuationPrefix(line));
}

function isHunkHeader(line: string) {
  const plain = line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  return /^• .+:\d+:/.test(plain);
}

function frameWrappedLines(lines: string[], maxWidth: number) {
  if (maxWidth < 4) {
    return lines;
  }

  const innerWidth = maxWidth - 4;
  return [
    '',
    frameTopBorder(maxWidth, SECTION_BORDER),
    ...lines.map((line) => frameLine(line, innerWidth, SECTION_BORDER)),
    frameBottomBorder(maxWidth, SECTION_BORDER),
    '',
  ];
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

export function buildDiffSections(input: Array<{path: string; metrics: FileMetrics; diff: string}>): DiffSection[] {
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

export function getSectionIndexForLine(sections: DiffSection[], lineOffset: number) {
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
