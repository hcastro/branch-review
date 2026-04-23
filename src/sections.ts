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

export function truncateAnsi(line: string, maxWidth: number) {
  if (maxWidth <= 0) {
    return RESET;
  }

  const cells = toStyledCells(line);
  return renderStyledCells(cells.slice(0, maxWidth));
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

export function wrapAnsi(line: string, maxWidth: number, continuationPrefix = ''): string[] {
  if (maxWidth <= 0) {
    return [''];
  }

  const cells = toStyledCells(line);
  if (cells.length === 0) {
    return [''];
  }

  const rawPrefixCells = buildPlainPrefix(continuationPrefix);
  const prefixCells = rawPrefixCells.length < maxWidth ? rawPrefixCells : [];
  const prefixWidth = prefixCells.length;
  const tokens = tokenizeCells(cells);
  const result: StyledCell[][] = [];
  let currentLine: StyledCell[] = [];
  let currentWidth = 0;
  let continuation = false;

  const flush = () => {
    if (currentLine.length === 0) {
      return;
    }

    result.push(currentLine);
    continuation = true;
    currentLine = prefixCells.map((cell) => ({...cell}));
    currentWidth = prefixWidth;
  };

  const appendCells = (input: StyledCell[]) => {
    currentLine.push(...input);
    currentWidth += input.length;
  };

  const lineHasContent = () => currentWidth > (continuation ? prefixWidth : 0);

  for (const token of tokens) {
    let remaining = cells.slice(token.start, token.end);

    while (remaining.length > 0) {
      const available = maxWidth - currentWidth;

      if (available <= 0) {
        flush();
        continue;
      }

      if (remaining.length <= available) {
        appendCells(remaining);
        remaining = [];
        continue;
      }

      const nextLineAvailable = maxWidth - prefixWidth;
      if (lineHasContent() && remaining.length <= nextLineAvailable) {
        flush();
        continue;
      }

      appendCells(remaining.slice(0, available));
      remaining = remaining.slice(available);

      if (remaining.length > 0) {
        flush();
      }
    }
  }

  if (currentLine.length > 0) {
    result.push(currentLine);
  }

  if (result.length === 0) {
    return [''];
  }

  return result.map((lineCells) => renderStyledCells(lineCells));
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
