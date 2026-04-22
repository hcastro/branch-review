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
