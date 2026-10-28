import type {ReviewBlock} from '../review/model.js';

const BLOCK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function hashText(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function parseLineCount(value: string | undefined) {
  return value === undefined ? 1 : Number(value);
}

// `text` is the hunk exactly as it appears in the file diff, from its @@
// header to its last line, line terminators included, so a copied block keeps
// a trailing blank context line and its final newline.
function buildBlock(filePath: string, index: number, text: string): ReviewBlock | null {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const header = lines[0];
  const match = header?.match(BLOCK_HEADER_PATTERN);
  if (!match) return null;

  const oldStart = Number(match[1]);
  const oldLines = parseLineCount(match[2]);
  const newStart = Number(match[3]);
  const newLines = parseLineCount(match[4]);
  const functionHeader = match[5]?.trim() || undefined;
  const lineStart = newStart;
  const lineEnd = newStart + Math.max(newLines, 1) - 1;
  // Hunk bodies hold no file headers, so every `+` line is an added line,
  // including code such as `++i;`.
  const addedCode = lines
    .slice(1)
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1))
    .join('\n');

  const rawDiff = text;

  return {
    id: `${filePath}:${newStart}:${index}`,
    filePath,
    signature: hashText(`${newStart}:${newLines}:${rawDiff}:${addedCode}`),
    oldStart,
    oldLines,
    newStart,
    newLines,
    lineStart,
    lineEnd,
    functionHeader,
    rawDiff,
    addedCode,
  };
}

// Where the hunk whose header line ends at `offset` ends. A hunk ends once its
// header's old and new line counts are used up (plus any `\ No newline` lines
// right after), or at the first line that is not ` `, `+`, `-`, `\` or empty. Either
// way it never runs into a following `diff --git` section, which git prints
// for a type change (a file replaced by a symlink) on the same path.
function hunkEnd(rawDiff: string, offset: number, oldLines: number, newLines: number) {
  let oldLeft = oldLines;
  let newLeft = newLines;

  while (offset < rawDiff.length) {
    const newline = rawDiff.indexOf('\n', offset);
    const next = newline < 0 ? rawDiff.length : newline + 1;
    const marker = rawDiff[offset];
    const countsUsed = oldLeft <= 0 && newLeft <= 0;

    if (marker === '\\') {
      offset = next;
      continue;
    }
    if (countsUsed) break;
    // A bare empty line is a blank context line from a patch made with
    // diff.suppressBlankEmpty.
    if (marker === ' ' || marker === '\n') {
      oldLeft -= 1;
      newLeft -= 1;
    } else if (marker === '-') {
      oldLeft -= 1;
    } else if (marker === '+') {
      newLeft -= 1;
    } else {
      break;
    }
    offset = next;
  }

  return offset;
}

export function parseUnifiedDiffBlocks(rawDiff: string, filePath: string): ReviewBlock[] {
  const blocks: ReviewBlock[] = [];
  let offset = 0;

  while (offset < rawDiff.length) {
    const newline = rawDiff.indexOf('\n', offset);
    const lineEnd = newline < 0 ? rawDiff.length : newline;
    const next = newline < 0 ? rawDiff.length : newline + 1;
    const match = rawDiff.slice(offset, lineEnd).match(BLOCK_HEADER_PATTERN);
    if (!match) {
      offset = next;
      continue;
    }

    const end = hunkEnd(rawDiff, next, parseLineCount(match[2]), parseLineCount(match[4]));
    const block = buildBlock(filePath, blocks.length, rawDiff.slice(offset, end));
    if (block) blocks.push(block);
    offset = end;
  }

  return blocks;
}
