import React from 'react';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildDiffSections, type DiffSection} from '../src/sections.js';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import type {ClipboardWriter} from '../src/commands/execute.js';
import type {ReviewModel} from '../src/review/model.js';

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function emitMouseMoveAt(column: number, row: number) {
  process.stdin.emit('data', `\u001B[<35;${column + 1};${row + 1}M`);
  await flush();
}

async function emitMousePressAt(column: number, row: number) {
  process.stdin.emit('data', `\u001B[<0;${column + 1};${row + 1}M`);
  await flush();
}

async function emitMouseDragAt(column: number, row: number, release = false) {
  process.stdin.emit('data', `\u001B[<32;${column + 1};${row + 1}${release ? 'm' : 'M'}`);
  await flush();
}

function frameLines(frame: string | undefined) {
  return stripAnsi(frame ?? '').split('\n');
}

// Screen position of `text` on the first frame row that contains every needle.
// Columns are terminal cells, so wide characters before the text count twice.
function cellPosition(frame: string | undefined, needles: string[], text: string, offset = 0) {
  const lines = frameLines(frame);
  const row = lines.findIndex((line) => needles.every((needle) => line.includes(needle)));
  expect(row, `row containing ${JSON.stringify(needles)}`).toBeGreaterThanOrEqual(0);
  const index = lines[row]!.indexOf(text);
  expect(index, `text ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
  return {row, column: stringWidth(lines[row]!.slice(0, index)) + offset};
}

function recordingWriter(writes: string[]): ClipboardWriter {
  return async (text) => {
    writes.push(text);
    return {ok: true, command: {command: '/usr/bin/pbcopy', args: [], displayName: 'pbcopy'}};
  };
}

type FixtureFile = {path: string; rawDiff: string; rendered: string[]};

function buildFixture(files: FixtureFile[]): {sections: DiffSection[]; review: ReviewModel} {
  const reviewFiles = files.map((file) => {
    const additions = file.rawDiff.split('\n').filter((line) => line.startsWith('+')).length;
    const deletions = file.rawDiff.split('\n').filter((line) => line.startsWith('-')).length;
    const metrics = {path: file.path, additions, deletions, changedLines: additions + deletions};
    return {
      path: file.path,
      status: 'modified' as const,
      metrics,
      rawDiff: file.rawDiff,
      renderedLines: file.rendered,
      blocks: parseUnifiedDiffBlocks(file.rawDiff, file.path),
    };
  });
  const metrics = {
    filesChanged: reviewFiles.length,
    additions: reviewFiles.reduce((sum, file) => sum + file.metrics.additions, 0),
    deletions: reviewFiles.reduce((sum, file) => sum + file.metrics.deletions, 0),
    changedLines: reviewFiles.reduce((sum, file) => sum + file.metrics.changedLines, 0),
  };

  return {
    sections: buildDiffSections(reviewFiles.map((file) => ({
      path: file.path,
      metrics: file.metrics,
      diff: file.renderedLines.join('\n'),
    }))),
    review: {base: 'development', branch: 'HEAD', label: 'development...HEAD', metrics, files: reviewFiles},
  };
}

function renderFixture(
  fixture: {sections: DiffSection[]; review?: ReviewModel},
  dimensions: {columns: number; rows: number},
  writes: string[] = [],
  copyWriter: ClipboardWriter = recordingWriter(writes),
) {
  return render(
    <App
      base="development"
      branch="HEAD"
      sections={fixture.sections}
      branchMetrics={fixture.review?.metrics ?? {filesChanged: fixture.sections.length, additions: 0, deletions: 0, changedLines: 0}}
      review={fixture.review}
      copyWriter={copyWriter}
      dimensions={dimensions}
    />,
  );
}

function gutter(line: number) {
  const label = String(line).padStart(3);
  return ` ${label} ⋮ ${label} │`;
}

describe('block identity comes from structure, not rendered text', () => {
  const longPath = 'packages/web/src/components/settings/notifications/PreferencesPanel.tsx';
  const firstRaw = '@@ -10 +10 @@ function first()\n-first(false);\n+first(true);';
  const secondRaw = '@@ -147 +147 @@ function second()\n-second(false);\n+second(true);';
  const longPathFixture = () => buildFixture([{
    path: longPath,
    rawDiff: `${firstRaw}\n${secondRaw}`,
    rendered: [
      `• ${longPath}:10: function first()`,
      `${gutter(10)}first(true);`,
      `• ${longPath}:147: function second()`,
      `${gutter(147)}second(true);`,
    ],
  }]);

  it('keeps a long block header on one row, truncated from the start', async () => {
    const instance = renderFixture(longPathFixture(), {columns: 100, rows: 40});
    await flush();

    const lines = frameLines(instance.lastFrame());
    const headerRows = lines.filter((line) => line.includes('Panel.tsx:147:'));
    expect(headerRows).toHaveLength(1);
    expect(headerRows[0]).toMatch(/│ [•▾▸] …\S*Panel\.tsx:147: /);

    instance.unmount();
  });

  it('copies a long-path block from its own header and keeps it visible when the block above collapses', async () => {
    const writes: string[] = [];
    const instance = renderFixture(longPathFixture(), {columns: 100, rows: 40}, writes);
    await flush();

    const header = cellPosition(instance.lastFrame(), ['Panel.tsx:147:'], 'Panel.tsx:147:');
    await emitMouseMoveAt(header.column, header.row);
    const copyBlock = cellPosition(instance.lastFrame(), [':147:', 'Copy block'], 'Copy block');
    expect(copyBlock.row).toBe(header.row);
    await emitMousePressAt(copyBlock.column, copyBlock.row);
    await flush();

    expect(writes.at(-1)).toContain(`File: ${longPath}`);
    expect(writes.at(-1)).toContain('Lines: 147-147');

    const firstHeader = cellPosition(instance.lastFrame(), ['Panel.tsx:10:'], 'Panel.tsx:10:');
    await emitMousePressAt(firstHeader.column, firstHeader.row);
    await flush();

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('▸ …');
    expect(frame).not.toContain('first(true);');
    expect(frame).toContain('Panel.tsx:147:');
    expect(frame).toContain('second(true);');

    instance.unmount();
  });

  it('copies the block of a file whose name contains :<digits>:', async () => {
    const writes: string[] = [];
    const fixture = buildFixture([
      {path: 'a', rawDiff: '@@ -1 +1 @@\n-alpha(false);\n+alpha(true);', rendered: ['• a:1: ', `${gutter(1)}alpha(true);`]},
      {path: 'a:1:b.ts', rawDiff: '@@ -12 +12 @@\n-beta(false);\n+beta(true);', rendered: ['• a:1:b.ts:12: ', `${gutter(12)}beta(true);`]},
    ]);
    const instance = renderFixture(fixture, {columns: 150, rows: 40}, writes);
    await flush();

    const header = cellPosition(instance.lastFrame(), ['a:1:b.ts:12:'], 'a:1:b.ts:12:');
    await emitMouseMoveAt(header.column, header.row);
    const copyBlock = cellPosition(instance.lastFrame(), ['a:1:b.ts:12:', 'Copy block'], 'Copy block');
    await emitMousePressAt(copyBlock.column, copyBlock.row);
    await flush();

    expect(writes.at(-1)).toContain('File: a:1:b.ts');
    expect(writes.at(-1)).toContain('beta(true);');
    expect(writes.at(-1)).not.toContain('alpha');

    instance.unmount();
  });
});

describe('block header guard', () => {
  it('offers no block copy when the rendered header does not match the parsed block', async () => {
    const writes: string[] = [];
    const fixture = buildFixture([{
      path: 'src/a.ts',
      rawDiff: '@@ -5 +5 @@\n-a\n+b',
      rendered: ['• src/a.ts:99: ', `${gutter(5)}b`],
    }]);
    const instance = renderFixture(fixture, {columns: 150, rows: 30}, writes);
    await flush();

    const header = cellPosition(instance.lastFrame(), ['src/a.ts:99:'], 'src/a.ts:99:');
    await emitMouseMoveAt(header.column, header.row);
    const copyBlock = cellPosition(instance.lastFrame(), ['src/a.ts:99:', 'Copy block'], 'Copy block');
    await emitMousePressAt(copyBlock.column, copyBlock.row);
    await flush();

    expect(writes).toEqual([]);

    instance.unmount();
  });
});

describe('wide characters are measured in terminal cells', () => {
  const wideText = '日本語テキストです';
  const raw1 = '@@ -1,6 +1,6 @@ function f1()\n+const a = 1;';
  const raw20 = '@@ -20 +20 @@ function f20()\n-twenty(false);\n+twenty(true);';
  const raw40 = '@@ -40 +40 @@ function f40()\n-forty(false);\n+forty(true);';
  const wideFixture = () => buildFixture([{
    path: 'src/jp.ts',
    rawDiff: [raw1, raw20, raw40].join('\n'),
    rendered: [
      '• src/jp.ts:1: function f1()',
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) => `${gutter(index + 1)}const ${name} = "${wideText}";`),
      '• src/jp.ts:20: function f20()',
      `${gutter(20)}twenty(true);`,
      '• src/jp.ts:40: function f40()',
      `${gutter(40)}forty(true);`,
    ],
  }]);

  it('renders every pane row in exactly one terminal row', async () => {
    const instance = renderFixture(wideFixture(), {columns: 120, rows: 40});
    await flush();

    const lines = frameLines(instance.lastFrame());
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(120);
    }
    expect(lines.some((line) => line.includes('src/jp.ts:20:'))).toBe(true);
    expect(lines.some((line) => line.includes('src/jp.ts:40:'))).toBe(true);
    const wideRows = lines.filter((line) => line.includes(wideText));
    expect(wideRows).toHaveLength(6);

    instance.unmount();
  });

  it('copies the block under the pointer below wide lines', async () => {
    const writes: string[] = [];
    const instance = renderFixture(wideFixture(), {columns: 120, rows: 40}, writes);
    await flush();

    const body = cellPosition(instance.lastFrame(), ['twenty(true);'], 'twenty(true);');
    await emitMouseMoveAt(body.column, body.row);
    const copyDiff = cellPosition(instance.lastFrame(), ['src/jp.ts:20:', 'Copy diff'], 'Copy diff');
    await emitMousePressAt(copyDiff.column, copyDiff.row);
    await flush();

    expect(writes.at(-1)).toBe(parseUnifiedDiffBlocks(raw20, 'src/jp.ts')[0]!.rawDiff);

    instance.unmount();
  });

  it('maps a drag over text after wide characters to that text', async () => {
    const writes: string[] = [];
    const fixture = {
      sections: buildDiffSections([{
        path: 'src/jp.ts',
        metrics: {path: 'src/jp.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: ['• src/jp.ts:10: function example()', `${gutter(10)}const s = "日本語テキスト"; const t = 1;`].join('\n'),
      }]),
    };
    const instance = renderFixture(fixture, {columns: 150, rows: 24}, writes);
    await flush();

    const start = cellPosition(instance.lastFrame(), ['const t = 1'], 'const t = 1');
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(start.column + 'const t = 1'.length - 1, start.row);
    await emitMouseDragAt(start.column + 'const t = 1'.length - 1, start.row, true);
    await flush();

    expect(writes.at(-1)).toBe('const t = 1');

    instance.unmount();
  });
});

describe('drag-select copy follows delta\'s real gutter', () => {
  it('keeps the first indentation column of each selected line', async () => {
    const writes: string[] = [];
    const fixture = {
      sections: buildDiffSections([{
        path: 'src/example.ts',
        metrics: {path: 'src/example.ts', additions: 2, deletions: 0, changedLines: 2},
        diff: [
          '• src/example.ts:10: function example()',
          `${gutter(10)}    const first = 1;`,
          `${gutter(11)}    return first;`,
        ].join('\n'),
      }]),
    };
    const instance = renderFixture(fixture, {columns: 150, rows: 24}, writes);
    await flush();

    const start = cellPosition(instance.lastFrame(), ['const first = 1;'], '│    const first', 1);
    const end = cellPosition(instance.lastFrame(), ['return first;'], 'return', 'return'.length - 1);
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(end.column, end.row);
    await emitMouseDragAt(end.column, end.row, true);
    await flush();

    expect(writes.at(-1)).toBe('    const first = 1;\n    return');

    instance.unmount();
  });

  it('copies a wrapped source line as one line', async () => {
    const writes: string[] = [];
    const source = 'const value = computeSomething(alpha, beta) + anotherCall(gamma, delta) + yetAnotherCall(epsilon, zeta1);;';
    expect(source.length).toBe(106);
    const fixture = {
      sections: buildDiffSections([{
        path: 'src/example.ts',
        metrics: {path: 'src/example.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: ['• src/example.ts:10: function example()', `${gutter(10)}${source}`, `${gutter(11)}done();`].join('\n'),
      }]),
    };
    const instance = renderFixture(fixture, {columns: 90, rows: 24}, writes);
    await flush();

    const start = cellPosition(instance.lastFrame(), ['const value'], 'const value');
    const end = cellPosition(instance.lastFrame(), ['zeta1);;'], 'zeta1);;', 'zeta1);;'.length - 1);
    expect(end.row).toBeGreaterThan(start.row);
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(end.column, end.row);
    await emitMouseDragAt(end.column, end.row, true);
    await flush();

    expect(writes.at(-1)).toBe(source);

    instance.unmount();
  });
});

describe('drag-selection across a live refresh', () => {
  const zetaLines = (changed = false) => Array.from(
    {length: 12},
    (_, index) => `${gutter(index + 1)}zeta${index + 1}${changed && index === 9 ? ' changed' : ''}`,
  );
  const zSection = (changed = false) => ({
    path: 'src/z.ts',
    metrics: {path: 'src/z.ts', additions: 12, deletions: 0, changedLines: 12},
    diff: ['• src/z.ts:1: ', ...zetaLines(changed)].join('\n'),
  });
  const aSection = {
    path: 'src/a.ts',
    metrics: {path: 'src/a.ts', additions: 3, deletions: 0, changedLines: 3},
    diff: ['• src/a.ts:1: ', `${gutter(1)}alpha1`, `${gutter(2)}alpha2`, `${gutter(3)}alpha3`].join('\n'),
  };

  function renderSections(sections: DiffSection[], writes: string[]) {
    return (
      <App
        base="development"
        branch="HEAD"
        sections={sections}
        branchMetrics={{filesChanged: sections.length, additions: 0, deletions: 0, changedLines: 0}}
        copyWriter={recordingWriter(writes)}
        dimensions={{columns: 150, rows: 40}}
      />
    );
  }

  it('copies the lines that were selected when a file appears above them mid-drag', async () => {
    const writes: string[] = [];
    const instance = render(renderSections(buildDiffSections([zSection()]), writes));
    await flush();

    const start = cellPosition(instance.lastFrame(), ['zeta9'], 'zeta9');
    const end = cellPosition(instance.lastFrame(), ['zeta11'], 'zeta11', 'zeta11'.length - 1);
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(end.column, end.row);

    instance.rerender(renderSections(buildDiffSections([aSection, zSection()]), writes));
    await flush();
    await flush();

    const endAfter = cellPosition(instance.lastFrame(), ['zeta11'], 'zeta11', 'zeta11'.length - 1);
    await emitMouseDragAt(endAfter.column, endAfter.row, true);
    await flush();

    expect(writes).toEqual(['zeta9\nzeta10\nzeta11']);

    instance.unmount();
  });

  it('cancels the selection and says so when the selected lines change', async () => {
    const writes: string[] = [];
    const instance = render(renderSections(buildDiffSections([zSection()]), writes));
    await flush();

    const start = cellPosition(instance.lastFrame(), ['zeta9'], 'zeta9');
    const end = cellPosition(instance.lastFrame(), ['zeta11'], 'zeta11', 'zeta11'.length - 1);
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(end.column, end.row);

    instance.rerender(renderSections(buildDiffSections([aSection, zSection(true)]), writes));
    await flush();
    await flush();
    await emitMouseDragAt(end.column, end.row, true);
    await flush();

    expect(writes).toEqual([]);
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('Selection cancelled');

    instance.unmount();
  });

  it('keeps a finished selection highlight on the lines it covered', async () => {
    const writes: string[] = [];
    const instance = render(renderSections(buildDiffSections([zSection()]), writes));
    await flush();

    const start = cellPosition(instance.lastFrame(), ['zeta9'], 'zeta9');
    const end = cellPosition(instance.lastFrame(), ['zeta11'], 'zeta11', 'zeta11'.length - 1);
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(end.column, end.row);
    await emitMouseDragAt(end.column, end.row, true);
    await flush();
    expect(writes).toEqual(['zeta9\nzeta10\nzeta11']);

    instance.rerender(renderSections(buildDiffSections([aSection, zSection()]), writes));
    await flush();
    await flush();

    const highlighted = (instance.lastFrame() ?? '')
      .split('\n')
      .filter((line) => line.includes('\u001B[48;2;28;68;76m'))
      .map((line) => stripAnsi(line));
    expect(highlighted.length).toBeGreaterThan(0);
    for (const line of highlighted) {
      expect(line).toMatch(/zeta(9|10|11)\b/);
    }

    instance.unmount();
  });
});

describe('diff header', () => {
  it('keeps the file name when truncating a long path for the action buttons', async () => {
    const fixture = buildFixture([
      {path: 'packages/web/src/components/settings/profile-a.tsx', rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: ['• packages/web/src/components/settings/profile-a.tsx:1: ', `${gutter(1)}b`]},
      {path: 'packages/web/src/components/settings/profile-b.tsx', rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: ['• packages/web/src/components/settings/profile-b.tsx:1: ', `${gutter(1)}b`]},
    ]);
    const instance = renderFixture(fixture, {columns: 100, rows: 30});
    await flush();

    const headerRow = frameLines(instance.lastFrame()).find((line) => line.includes('Copy path'));
    expect(headerRow).toContain('profile-a.tsx');
    expect(headerRow).toContain('…');

    instance.unmount();
  });

  it('shows no copy hint where hidden file actions would be in an empty review', async () => {
    const review: ReviewModel = {
      base: 'development',
      branch: 'HEAD',
      label: 'development...HEAD',
      metrics: {filesChanged: 0, additions: 0, deletions: 0, changedLines: 0},
      files: [],
    };
    const writes: string[] = [];
    const instance = renderFixture({sections: [], review}, {columns: 120, rows: 30}, writes);
    await flush();

    const headerRow = frameLines(instance.lastFrame()).findIndex((line) => line.includes('No changes to review'));
    expect(headerRow).toBeGreaterThan(0);
    for (const row of [headerRow - 1, headerRow]) {
      for (let column = 34; column < 120; column += 1) {
        await emitMouseMoveAt(column, row);
        expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain('copies');
        await emitMousePressAt(column, row);
      }
    }
    expect(writes).toEqual([]);

    instance.unmount();
  });
});

describe('copy feedback', () => {
  it('marks a failed copy with a failure marker, never a check mark', async () => {
    const fixture = buildFixture([
      {path: 'src/a.ts', rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: ['• src/a.ts:1: ', `${gutter(1)}b`]},
    ]);
    const failingWriter: ClipboardWriter = async () => ({ok: false, message: 'Clipboard write failed using pbcopy.', hint: 'boom'});
    const instance = renderFixture(fixture, {columns: 150, rows: 30}, [], failingWriter);
    await flush();

    const copyPath = cellPosition(instance.lastFrame(), ['Copy path'], 'Copy path');
    await emitMousePressAt(copyPath.column, copyPath.row);
    await flush();
    await flush();

    const frame = instance.lastFrame() ?? '';
    expect(stripAnsi(frame)).toContain('✗ Clipboard write failed using pbcopy. · boom');
    expect(stripAnsi(frame)).not.toContain('✓ Clipboard');

    instance.unmount();
  });

  it('keeps the success marker for a successful copy', async () => {
    const writes: string[] = [];
    const fixture = buildFixture([
      {path: 'src/a.ts', rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: ['• src/a.ts:1: ', `${gutter(1)}b`]},
    ]);
    const instance = renderFixture(fixture, {columns: 150, rows: 30}, writes);
    await flush();

    const copyPath = cellPosition(instance.lastFrame(), ['Copy path'], 'Copy path');
    await emitMousePressAt(copyPath.column, copyPath.row);
    await flush();

    expect(writes).toEqual(['src/a.ts']);
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('✓ Copied path · src/a.ts');

    instance.unmount();
  });
});

describe('control characters in repo-derived text', () => {
  it('shows controls in paths and refs as visible markers and copies the exact path', async () => {
    const writes: string[] = [];
    const evilPath = 'src/evil\u001B]0;pwned\u0007\rname.ts';
    const fixture = buildFixture([
      {path: evilPath, rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: [`• ${evilPath}:1: `, `${gutter(1)}b`]},
    ]);
    const instance = render(
      <App
        base={'main\u001B[2J'}
        branch={'feature\rHEAD'}
        sections={fixture.sections}
        branchMetrics={fixture.review.metrics}
        review={fixture.review}
        copyWriter={recordingWriter(writes)}
        dimensions={{columns: 160, rows: 30}}
      />,
    );
    await flush();

    const assertClean = (frame: string) => {
      expect(frame).not.toContain('\r');
      expect(frame).not.toContain('\u0007');
      expect(frame).not.toContain('\u001B]');
      expect(frame).not.toContain('\u001B[2J');
    };

    let frame = instance.lastFrame() ?? '';
    assertClean(frame);
    expect(stripAnsi(frame)).toContain('evil␛]0;pwned^G^Mname.ts');
    expect(stripAnsi(frame)).toContain('feature^MHEAD');
    expect(stripAnsi(frame)).toContain('main␛[2J');

    const copyPath = cellPosition(frame, ['Copy path'], 'Copy path');
    await emitMousePressAt(copyPath.column, copyPath.row);
    await flush();

    expect(writes).toEqual([evilPath]);
    frame = instance.lastFrame() ?? '';
    assertClean(frame);
    expect(stripAnsi(frame)).toContain('Copied path · src/evil␛]0;pwned^G^Mname.ts');

    instance.unmount();
  });
});
