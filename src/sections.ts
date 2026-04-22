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

export function truncateAnsi(line: string, maxWidth: number) {
  if (maxWidth <= 0) {
    return RESET;
  }

  let output = '';
  let visible = 0;
  const parts = line.split(ANSI_CSI_TOKEN);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (i % 2 === 1) {
      if (part.endsWith('m')) {
        output += part;
      }
      continue;
    }

    const remaining = maxWidth - visible;
    if (remaining <= 0) break;

    if (part.length <= remaining) {
      output += part;
      visible += part.length;
    } else {
      output += part.slice(0, remaining);
      visible += remaining;
      break;
    }
  }

  return output + RESET;
}

export function wrapAnsi(line: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return [''];
  }

  const parts = line.split(ANSI_CSI_TOKEN);
  const result: string[] = [];
  let current = '';
  let visible = 0;
  let activeStyle = '';

  const flush = () => {
    if (visible === 0 && current.length === 0) return;
    result.push(current + RESET);
    current = activeStyle;
    visible = 0;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (i % 2 === 1) {
      if (!part.endsWith('m')) {
        continue;
      }
      current += part;
      activeStyle = part === RESET ? '' : activeStyle + part;
      continue;
    }

    let remaining = part;
    while (remaining.length > 0) {
      const budget = maxWidth - visible;
      if (budget <= 0) {
        flush();
        continue;
      }

      const chunk = remaining.slice(0, budget);
      current += chunk;
      visible += chunk.length;
      remaining = remaining.slice(budget);
    }
  }

  if (current.length > 0 || visible > 0) {
    result.push(current + RESET);
  }

  if (result.length === 0) {
    result.push('');
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
    const wrappedLines = section.lines.flatMap((line) => wrapAnsi(line, maxWidth));
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

function cyan(text: string) {
  return `\u001B[36m${text}\u001B[0m`;
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

function gray(text: string) {
  return `\u001B[90m${text}\u001B[0m`;
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
      cyan(`Δ ${entry.path}`),
      `${formatMetrics(entry.metrics)} ${gray(`• ${diffLines.length} rendered lines`)}`,
      gray('─'.repeat(72)),
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
