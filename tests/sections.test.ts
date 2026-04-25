import {describe, expect, it} from 'vitest';
import stripAnsi from 'strip-ansi';
import {
  buildDiffSections,
  flattenSectionLines,
  formatMetrics,
  getSectionForLine,
  getSectionIndexForLine,
  getContinuationPrefix,
  truncateAnsi,
  visibleWidth,
  wrapAnsi,
  wrapSections,
} from '../src/sections.js';

describe('section helpers', () => {
  it('maps scroll offsets back to the file section in view', () => {
    const sections = buildDiffSections([
      {
        path: 'a.ts',
        metrics: {path: 'a.ts', additions: 3, deletions: 1, changedLines: 4},
        diff: 'line-a1\nline-a2',
      },
      {
        path: 'b.ts',
        metrics: {path: 'b.ts', additions: 2, deletions: 2, changedLines: 4},
        diff: 'line-b1\nline-b2\nline-b3',
      },
    ]);

    expect(getSectionIndexForLine(sections, 0)).toBe(0);
    expect(getSectionForLine(sections, sections[0].endLineExclusive)?.path).toBe('b.ts');
    expect(flattenSectionLines(sections).length).toBe(sections[1].endLineExclusive);
  });

  it('formats important metrics for header display', () => {
    expect(formatMetrics({additions: 5, deletions: 2, changedLines: 7})).toContain('7 changed');
  });

  it('truncates colored lines to a visible width without bleeding styles', () => {
    const colored = '[32mgreen text that is quite long[0m tail';
    const truncated = truncateAnsi(colored, 10);

    expect(stripAnsi(truncated)).toBe('green text');
    expect(truncated.endsWith('[0m')).toBe(true);
  });

  it('preserves ANSI codes without counting them against the width budget', () => {
    const line = '[31mabc[0m[32mdef[0m';
    expect(stripAnsi(truncateAnsi(line, 100))).toBe('abcdef');
    expect(stripAnsi(truncateAnsi(line, 4))).toBe('abcd');
  });

  it('wraps long colored lines into multiple width-constrained pieces', () => {
    const line = '[32m' + 'x'.repeat(25) + '[0m';
    const wrapped = wrapAnsi(line, 10);

    expect(wrapped).toHaveLength(3);
    expect(wrapped.map(stripAnsi)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    for (const piece of wrapped) {
      expect(piece.endsWith('[0m')).toBe(true);
    }
  });

  it('prefers whitespace boundaries so prose wraps by word when possible', () => {
    const line = '[32mThe point of this plan[0m';
    const wrapped = wrapAnsi(line, 10);

    expect(wrapped.map(stripAnsi)).toEqual(['The point ', 'of this ', 'plan']);
    expect(stripAnsi(wrapped.join(''))).toBe('The point of this plan');
  });

  it('falls back to hard splits when a single token is wider than the pane', () => {
    const line = '[32msupercalifragilistic[0m';
    const wrapped = wrapAnsi(line, 5);

    expect(wrapped.map(stripAnsi)).toEqual(['super', 'calif', 'ragil', 'istic']);
  });

  it('detects hanging indents for guttered and bullet-prefixed lines', () => {
    expect(getContinuationPrefix('  1 ⋮  1 │ const x = 1;')).toBe(`${' '.repeat(9)}│ `);
    expect(getContinuationPrefix('  1 ⋮    │old text')).toBe(`${' '.repeat(9)}│`);
    expect(getContinuationPrefix('• path/to/file.md:12: The point of this plan')).toBe('  ');
  });

  it('keeps the line-number gutter separator across wrapped delta rows', () => {
    const line = '  1 ⋮  1 │ decision: prepend newly created comments and make selectors scroll exactly';
    const wrapped = wrapAnsi(line, 44, getContinuationPrefix(line)).map(stripAnsi);

    expect(wrapped).toEqual([
      '  1 ⋮  1 │ decision: prepend newly created ',
      '         │ comments and make selectors ',
      '         │ scroll exactly',
    ]);
  });

  it('keeps delta continuation rows inside the gutter when there is no separator padding', () => {
    const line = '  1 ⋮    │old text that is long enough to wrap against the review pane';
    const wrapped = wrapAnsi(line, 38, getContinuationPrefix(line)).map(stripAnsi);

    expect(wrapped).toEqual([
      '  1 ⋮    │old text that is long ',
      '         │enough to wrap against the ',
      '         │review pane',
    ]);
  });

  it('adds a hanging indent to continuation lines when wrapping prose with prefixes', () => {
    const wrapped = wrapAnsi(
      '• path/to/file.md:12: The point of this plan is not to solve every mobile Stream problem at once.',
      44,
      '  ',
    );

    const plain = wrapped.map(stripAnsi);
    expect(plain[0]).toBe('• path/to/file.md:12: The point of this ');
    expect(plain[1]?.startsWith('  ')).toBe(true);
    expect(plain[2]?.startsWith('  ')).toBe(true);
    expect([plain[0], ...plain.slice(1).map((line) => line.trimStart())].join('')).toBe(
      '• path/to/file.md:12: The point of this plan is not to solve every mobile Stream problem at once.',
    );
  });

  it('drops non-SGR CSI sequences so they cannot overwrite the pane border', () => {
    // Delta's --line-fill-method=ansi emits \x1B[K (Erase in Line). If it
    // leaks through, the terminal interprets it and overwrites whatever is
    // drawn to the right of the content - specifically the pane border.
    const withEraseEol = '\x1B[32mhi\x1B[K\x1B[0m';

    const wrapped = wrapAnsi(withEraseEol, 10);
    for (const piece of wrapped) {
      expect(piece).not.toContain('\x1B[K');
    }
    expect(stripAnsi(wrapped.join(''))).toBe('hi');

    const truncated = truncateAnsi(withEraseEol, 10);
    expect(truncated).not.toContain('\x1B[K');
    expect(stripAnsi(truncated)).toBe('hi');
  });

  it('rewraps sections and recomputes line boundaries across wrapped lines', () => {
    const base = buildDiffSections([
      {
        path: 'a.ts',
        metrics: {path: 'a.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: 'x'.repeat(25),
      },
    ]);

    const wrapped = wrapSections(base, 10);
    expect(wrapped[0].lines.length).toBeGreaterThan(base[0].lines.length);
    expect(wrapped[0].startLine).toBe(0);
    expect(wrapped[0].endLineExclusive).toBe(wrapped[0].lines.length);
  });

  it('renders block headers with one width-constrained frame', () => {
    const base = buildDiffSections([
      {
        path: 'notes.md',
        metrics: {path: 'a.ts', additions: 12, deletions: 3, changedLines: 15},
        diff: '• very/long/path/to/a/file/that/should/wrap.md:12: The point of this plan is not to solve every mobile Stream problem at once.',
      },
    ]);

    const wrapped = wrapSections(base, 48);
    const frameStart = wrapped[0].lines.findIndex((line) => stripAnsi(line).startsWith('╭'));
    const plainHeader = wrapped[0].lines.slice(frameStart, frameStart + 4).map(stripAnsi);

    expect(stripAnsi(wrapped[0].lines[frameStart - 1])).toBe('');
    expect(plainHeader).toEqual([
      `╭${'─'.repeat(46)}╮`,
      '│ • very/long/path/to/a/file/that/should/wrap. │',
      '│   md:12:                                     │',
      `╰${'─'.repeat(46)}╯`,
    ]);
    expect(stripAnsi(wrapped[0].lines[frameStart + 4])).toBe('');
    for (const line of wrapped[0].lines.slice(frameStart, frameStart + 4)) {
      expect(visibleWidth(line)).toBe(48);
    }
  });

  it('removes styled block context after the path and line label', () => {
    const base = buildDiffSections([
      {
        path: 'handler.ts',
        metrics: {path: 'handler.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: '\u001B[36m• apps/core-service/src/events/handlers/create-user-handler.ts:39:\u001B[0m \u001B[35mexport async function processCreateNewUserEvent\u001B[0m',
      },
    ]);

    const wrapped = wrapSections(base, 120);
    const rendered = wrapped[0].lines.map(stripAnsi).join('\n');
    expect(rendered).toContain('• apps/core-service/src/events/handlers/create-user-handler.ts:39:');
    expect(rendered).not.toContain('export async function processCreateNewUserEvent');
  });
});
