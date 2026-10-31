import type {ReviewBlock, ReviewFile} from '../review/model.js';

// Place-keeping between the diff and its page. The TUI knows which hunk
// line is at the top of the pane; this turns that into a source line of the
// side the page shows, and the page turns the line into the rendered block
// that holds it. Pure, with no Node imports: the page script uses it too.

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The source line of a hunk's `ordinal`-th body line (0 is the first line
 * after the `@@` header), on `side`. A line that isn't on that side, such as
 * a removed line on the after side, sits at the line that follows it there.
 * Git's `\ No newline` note is no line: delta draws no row for it. Null
 * when the hunk has no such line.
 */
export function sourceLineAt(rawDiff: string, ordinal: number, side: 'after' | 'base'): number | null {
  const lines = rawDiff.split('\n');
  const header = HUNK_HEADER.exec(lines[0] ?? '');
  if (!header || ordinal < 0) return null;
  // A side with no lines names the line before the hunk.
  let base = Number(header[1]) + (header[2] === '0' ? 1 : 0);
  let after = Number(header[3]) + (header[4] === '0' ? 1 : 0);
  let seen = 0;
  for (const line of lines.slice(1)) {
    const marker = line[0];
    if (marker !== ' ' && marker !== '-' && marker !== '+') continue;
    if (seen === ordinal) return side === 'after' ? after : base;
    seen += 1;
    if (marker !== '+') base += 1;
    if (marker !== '-') after += 1;
  }
  return null;
}

/** The line of the file's page that a hunk's body line shows: a deleted file's page is its base side. */
export function anchorLine(file: Pick<ReviewFile, 'status'>, block: Pick<ReviewBlock, 'rawDiff'>, ordinal: number): number | null {
  return sourceLineAt(block.rawDiff, ordinal, file.status === 'deleted' ? 'base' : 'after');
}

/**
 * The index of the block that holds source line `line`: the innermost when
 * blocks nest (an item inside a quote), else the next block after the line
 * (a blank line belongs to what follows it), else the last block. -1 with
 * no blocks.
 */
export function blockForSourceLine(blocks: ReadonlyArray<{lines: readonly [number, number]}>, line: number): number {
  let holder = -1;
  let next = -1;
  for (const [index, block] of blocks.entries()) {
    const [start, end] = block.lines;
    if (start <= line && line <= end) {
      const span = end - start;
      if (holder < 0 || span < blocks[holder]!.lines[1] - blocks[holder]!.lines[0]) holder = index;
    } else if (start > line && (next < 0 || start < blocks[next]!.lines[0])) {
      next = index;
    }
  }
  return holder >= 0 ? holder : next >= 0 ? next : blocks.length - 1;
}
