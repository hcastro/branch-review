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
// header up to the next hunk, line terminators included, so a copied block
// keeps a trailing blank context line and its final newline.
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

export function parseUnifiedDiffBlocks(rawDiff: string, filePath: string): ReviewBlock[] {
  const blocks: ReviewBlock[] = [];
  let blockStart = -1;
  let offset = 0;

  const closeBlock = (end: number) => {
    if (blockStart < 0) return;
    const block = buildBlock(filePath, blocks.length, rawDiff.slice(blockStart, end));
    if (block) blocks.push(block);
  };

  while (offset < rawDiff.length) {
    const newline = rawDiff.indexOf('\n', offset);
    const lineEnd = newline < 0 ? rawDiff.length : newline;
    if (BLOCK_HEADER_PATTERN.test(rawDiff.slice(offset, lineEnd))) {
      closeBlock(offset);
      blockStart = offset;
    }
    offset = newline < 0 ? rawDiff.length : newline + 1;
  }

  closeBlock(rawDiff.length);
  return blocks;
}
