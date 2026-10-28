import {describe, expect, it} from 'vitest';
import stripAnsi from 'strip-ansi';
import {
  buildDiffSections,
  fitBlockHeaderLabel,
  flattenSectionLines,
  formatMetrics,
  getSectionForLine,
  getSectionIndexForLine,
  getContinuationPrefix,
  padToWidth,
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

  it('splits compound delta color sequences before wrapping', () => {
    const compound = '\x1B[48;2;0;56;0;38;2;166;226;46mblocked user posts are removed\x1B[0m';
    const wrapped = wrapAnsi(compound, 18);
    const output = wrapped.join('');

    expect(output).not.toContain('\x1B[48;2;0;56;0;38;2;166;226;46m');
    expect(output).toContain('\x1B[48;2;0;56;0m\x1B[38;2;166;226;46m');
    expect(stripAnsi(output)).toBe('blocked user posts are removed');
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

  it('renders block headers on one framed row, truncating the path from the start', () => {
    const base = buildDiffSections([
      {
        path: 'notes.md',
        metrics: {path: 'a.ts', additions: 12, deletions: 3, changedLines: 15},
        diff: '• very/long/path/to/a/file/that/should/wrap.md:12: The point of this plan is not to solve every mobile Stream problem at once.',
      },
    ]);

    const wrapped = wrapSections(base, 48);
    const frameStart = wrapped[0].lines.findIndex((line) => stripAnsi(line).startsWith('╭'));
    const plainHeader = wrapped[0].lines.slice(frameStart, frameStart + 3).map(stripAnsi);

    expect(stripAnsi(wrapped[0].lines[frameStart - 1])).toBe('');
    expect(plainHeader).toEqual([
      `╭${'─'.repeat(46)}╮`,
      '│ • …ng/path/to/a/file/that/should/wrap.md:12: │',
      `╰${'─'.repeat(46)}╯`,
    ]);
    expect(stripAnsi(wrapped[0].lines[frameStart + 3])).toBe('');
    for (const line of wrapped[0].lines.slice(frameStart, frameStart + 3)) {
      expect(visibleWidth(line)).toBe(48);
    }
    expect(wrapped[0].rows?.map((row) => row.kind)).toEqual(['frame', 'frame', 'header', 'frame', 'frame', 'body']);
    expect(wrapped[0].rows?.[2]).toMatchObject({
      block: 0,
      label: '• very/long/path/to/a/file/that/should/wrap.md:12:',
      lineNumber: 12,
    });
  });

  it('records block identity, continuations and the code column for every wrapped row', () => {
    const base = buildDiffSections([
      {
        path: 'src/a.ts',
        metrics: {path: 'src/a.ts', additions: 2, deletions: 0, changedLines: 2},
        diff: [
          '• src/a.ts:3: function a()',
          '  3 ⋮  3 │const first = 1;',
          '• src/a.ts:40: function b()',
          ` 40 ⋮ 40 │${'word '.repeat(12)}`,
        ].join('\n'),
      },
    ]);

    const [section] = wrapSections(base, 30);
    const rows = section!.rows!;
    expect(rows).toHaveLength(section!.lines.length);
    expect(rows.filter((row) => row.kind === 'header').map((row) => [row.block, row.lineNumber])).toEqual([[0, 3], [1, 40]]);

    const firstBody = rows.findIndex((row) => row.kind === 'body');
    expect(rows[firstBody]).toMatchObject({block: 0, continuation: false, codeColumn: 10});

    const wrappedStart = rows.findIndex((row, index) => row.kind === 'body' && row.block === 1 && index > 0);
    const wrappedRows = rows.slice(wrappedStart).filter((row) => row.block === 1 && row.kind === 'body');
    expect(wrappedRows.length).toBeGreaterThan(2);
    expect(wrappedRows[0]).toMatchObject({continuation: false, codeColumn: 10});
    expect(wrappedRows[1]).toMatchObject({continuation: true, codeColumn: 10});
  });

  it('keeps a path containing :<digits>: whole in its block header label', () => {
    const base = buildDiffSections([
      {path: 'a:1:b.ts', metrics: {path: 'a:1:b.ts', additions: 1, deletions: 0, changedLines: 1}, diff: '• a:1:b.ts:12: context'},
    ]);

    const header = wrapSections(base, 80)[0]!.rows!.find((row) => row.kind === 'header');
    expect(header).toMatchObject({label: '• a:1:b.ts:12:', lineNumber: 12});
  });

  it('detects a block header whose path holds control characters and shows them as markers', () => {
    const path = 'src/a\rb\u001B]0;x\u0007.ts';
    const base = buildDiffSections([
      {path, metrics: {path, additions: 1, deletions: 0, changedLines: 1}, diff: `• ${path}:7: context`},
    ]);

    const [section] = wrapSections(base, 80);
    const header = section!.rows!.find((row) => row.kind === 'header');
    expect(header).toMatchObject({label: '• src/a^Mb␛]0;x^G.ts:7:', lineNumber: 7});
    expect(section!.lines.join('')).not.toContain('\r');
  });

  it('measures, truncates and wraps wide characters in terminal cells', () => {
    expect(visibleWidth('日本語')).toBe(6);
    expect(visibleWidth('\u001B[31m日本\u001B[0mab')).toBe(6);
    expect(stripAnsi(truncateAnsi('日本語テキスト', 5))).toBe('日本');
    expect(visibleWidth(padToWidth('日本', 6))).toBe(6);

    const wrapped = wrapAnsi('日本語テキストです 日本語テキストです', 12);
    for (const row of wrapped) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(12);
    }
    expect(wrapped.map(stripAnsi).join('')).toBe('日本語テキストです 日本語テキストです');
  });

  it('never splits a surrogate pair or grapheme when truncating or wrapping', () => {
    const emoji = '👍🏽';
    expect(stripAnsi(truncateAnsi(`ab${emoji}cd`, 3))).toBe('ab');
    expect(stripAnsi(truncateAnsi(`ab${emoji}cd`, 4))).toBe(`ab${emoji}`);
    const wrapped = wrapAnsi(`${emoji}${emoji}${emoji}`, 3).map(stripAnsi);
    expect(wrapped.join('')).toBe(`${emoji}${emoji}${emoji}`);
    for (const row of wrapped) {
      expect(row).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
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

describe('block header labels', () => {
  const label = '• packages/server/src/handlers/very-long-module-name.ts:120:';

  it('drops the start of the path and keeps `:<line>:` whole', () => {
    for (const width of [32, 20, 12, 9]) {
      const fitted = fitBlockHeaderLabel(label, width);
      expect(visibleWidth(fitted), `width ${width}`).toBeLessThanOrEqual(width);
      expect(fitted, `width ${width}`).toMatch(/^• …\S+:120:$/);
    }
    expect(fitBlockHeaderLabel(label, 32)).toBe('• …very-long-module-name.ts:120:');
  });

  it('leaves a label that fits unchanged', () => {
    expect(fitBlockHeaderLabel('• a.ts:3:', 20)).toBe('• a.ts:3:');
  });
});
