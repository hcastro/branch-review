import type {ReviewHunk} from '../review/model.js';

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseLineCount(value: string | undefined) {
  return value === undefined ? 1 : Number(value);
}

function buildHunk(filePath: string, index: number, lines: string[]): ReviewHunk | null {
  const header = lines[0];
  const match = header?.match(HUNK_HEADER_PATTERN);
  if (!match) return null;

  const oldStart = Number(match[1]);
  const oldLines = parseLineCount(match[2]);
  const newStart = Number(match[3]);
  const newLines = parseLineCount(match[4]);
  const functionHeader = match[5]?.trim() || undefined;
  const lineStart = newStart;
  const lineEnd = newStart + Math.max(newLines, 1) - 1;
  const addedCode = lines
    .slice(1)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');

  return {
    id: `${filePath}:${newStart}:${index}`,
    filePath,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lineStart,
    lineEnd,
    functionHeader,
    rawDiff: lines.join('\n').trimEnd(),
    addedCode,
  };
}

export function parseUnifiedDiffHunks(rawDiff: string, filePath: string): ReviewHunk[] {
  const hunks: ReviewHunk[] = [];
  let current: string[] = [];

  for (const line of rawDiff.split('\n')) {
    if (HUNK_HEADER_PATTERN.test(line)) {
      if (current.length > 0) {
        const hunk = buildHunk(filePath, hunks.length, current);
        if (hunk) hunks.push(hunk);
      }

      current = [line];
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const hunk = buildHunk(filePath, hunks.length, current);
    if (hunk) hunks.push(hunk);
  }

  return hunks;
}
