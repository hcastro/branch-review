import {describe, expect, it, vi} from 'vitest';
import type {ReviewModel} from '../src/review/model.js';
import {buildReviewSections} from '../src/review/build.js';
import type {DiffSection} from '../src/sections.js';
import {prewrapSections, sectionsToPrewrap} from '../src/ui/App.js';

// A delta row as delta draws it: line numbers, the gutter and 24-bit color
// around each token.
function deltaRow(index: number) {
  return `\x1B[34m\x1B[38;5;88m      \x1B[34m⋮\x1B[38;5;28m ${String(index + 1).padStart(6)}  \x1B[34m│\x1B[38;2;249;38;114mexport\x1B[38;2;248;248;242m \x1B[38;2;102;217;239mconst\x1B[38;2;248;248;242m value${index} = ${index};\x1B[0m`;
}

function smallSection(index: number, rows: number): DiffSection {
  const path = `src/file-${index}.ts`;
  const lines = Array.from({length: rows}, (_, row) => deltaRow(index * rows + row));
  return {path, metrics: {path, additions: rows, deletions: 0, changedLines: rows}, lines, startLine: 0, endLineExclusive: lines.length};
}

describe('prewrapping a review of many small files', () => {
  it('hands the event loop back between slices across files, not only inside one file', async () => {
    const sections = Array.from({length: 2_000}, (_, index) => smallSection(index, 5));
    // A modeled clock: every reading is one ms after the last, so each file
    // costs a few ms and the review as a whole costs thousands.
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 1;
      return clock;
    });
    let ticks = 0;
    let ticking = true;
    const tick = () => {
      ticks += 1;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    try {
      await prewrapSections(sections, 120);
    } finally {
      ticking = false;
      now.mockRestore();
    }

    // One slice is 8 modeled ms, so 10,000 rows give over a thousand slices.
    // A slice clock that starts over on every file never yields here.
    expect(ticks).toBeGreaterThanOrEqual(500);
  });
});

describe('choosing the sections to wrap ahead', () => {
  function reviewOf(errors: Array<string | undefined>): ReviewModel {
    const files = errors.map((error, index) => {
      const path = `src/file-${index}.ts`;
      return {
        path,
        status: 'modified' as const,
        signature: `sig-${index}`,
        metrics: {path, additions: 3, deletions: 0, changedLines: 3},
        rawDiff: '',
        renderedLines: [deltaRow(index * 3), deltaRow(index * 3 + 1), deltaRow(index * 3 + 2)],
        blocks: [],
        ...(error ? {error} : {}),
      };
    });
    return {base: 'main', branch: 'HEAD', label: 'main...HEAD', metrics: {filesChanged: files.length, additions: 9, deletions: 0, changedLines: 9}, files};
  }

  it('keeps every section the render has not wrapped', () => {
    const review = reviewOf([undefined, undefined, undefined]);
    const sections = buildReviewSections(review);
    expect(sectionsToPrewrap(sections, review, 120, new Map())).toEqual(sections);
  });

  it('leaves out a section the render shows with an error row, whose lines a wrap ahead would never match', () => {
    const review = reviewOf([undefined, 'could not read the diff', undefined]);
    const sections = buildReviewSections(review);
    expect(sectionsToPrewrap(sections, review, 120, new Map())).toEqual([sections[0], sections[2]]);
  });
});
