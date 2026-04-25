import React from 'react';
import stripAnsi from 'strip-ansi';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildDiffSections, type BranchMetrics} from '../src/sections.js';
import type {ReviewModel} from '../src/review/model.js';

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function emitMouseClickAt(column: number, row: number) {
  process.stdin.emit('data', `\u001B[<0;${column + 1};${row + 1}M`);
  await flush();
}

async function clickFrameText(frame: string, text: string) {
  const lines = stripAnsi(frame).split('\n');
  const row = lines.findIndex((line) => line.includes(text));
  expect(row).toBeGreaterThanOrEqual(0);
  const column = lines[row]?.indexOf(text) ?? -1;
  expect(column).toBeGreaterThanOrEqual(0);

  // xterm SGR mouse reports 1-based terminal coordinates. Try a narrow
  // spread because Ink yoga coordinates and terminal frame columns can differ
  // by border/padding cells.
  for (const delta of [-1, 0, 1, 2]) {
    process.stdin.emit('data', `\u001B[<0;${column + delta + 1};${row + 1}M`);
    await flush();
  }
}

async function clickFrameTextOnce(frame: string, text: string) {
  const lines = stripAnsi(frame).split('\n');
  const row = lines.findIndex((line) => line.includes(text));
  expect(row).toBeGreaterThanOrEqual(0);
  const column = lines[row]?.indexOf(text) ?? -1;
  expect(column).toBeGreaterThanOrEqual(0);

  await emitMouseClickAt(column, row);
}

async function clickFrameLineAction(frame: string, lineText: string, actionText: string) {
  const lines = stripAnsi(frame).split('\n');
  const row = lines.findIndex((line) => line.includes(lineText) && line.includes(actionText));
  expect(row).toBeGreaterThanOrEqual(0);
  const column = lines[row]?.indexOf(actionText) ?? -1;
  expect(column).toBeGreaterThanOrEqual(0);

  await emitMouseClickAt(column, row);
}

async function moveFrameText(frame: string, text: string) {
  const lines = stripAnsi(frame).split('\n');
  const row = lines.findIndex((line) => line.includes(text));
  expect(row).toBeGreaterThanOrEqual(0);
  const column = lines[row]?.indexOf(text) ?? -1;
  expect(column).toBeGreaterThanOrEqual(0);

  for (const delta of [-1, 0, 1, 2]) {
    process.stdin.emit('data', `\u001B[<35;${column + delta + 1};${row + 1}M`);
    await flush();
  }
}

const branchMetrics: BranchMetrics = {
  filesChanged: 2,
  additions: 5,
  deletions: 2,
  changedLines: 7,
};

describe('App', () => {
  it('scrolls the right panel and syncs the file tree to the file in view', async () => {
    const sections = buildDiffSections([
      {
        path: 'CLAUDE.md',
        metrics: {path: 'CLAUDE.md', additions: 2, deletions: 1, changedLines: 3},
        diff: 'a1\na2\na3\na4\na5\na6\na7\na8',
      },
      {
        path: 'src/App.tsx',
        metrics: {path: 'src/App.tsx', additions: 3, deletions: 1, changedLines: 4},
        diff: 'b1\nb2\nb3\nb4',
      },
    ]);

    const instance = render(
      <App
        base="development"
        branch="feature/example"
        sections={sections}
        branchMetrics={branchMetrics}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();

    let frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('CLAUDE.md');
    expect(frame).toContain('2 files • +5 • -2 • 7 changed');
    expect(frame).toContain('file 1/2');

    for (let index = 0; index < 12; index += 1) {
      instance.stdin.write('j');
      await flush();
    }

    frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('src/App.tsx');
    expect(frame).toContain('file 2/2');

    instance.stdin.write('\u001B[A');
    await flush();

    frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('file 1/2');
    expect(frame).toContain('CLAUDE.md');
    expect(frame).toContain('↑/↓ jump file');
    expect(frame).toContain('j/k scroll');
    expect(frame).not.toContain('copy menu');
    expect(frame).not.toContain('PgUp');
    expect(frame).not.toContain('/ search');

    instance.unmount();
  });

  it('steps through files predictably with arrow keys', async () => {
    const sections = buildDiffSections(
      Array.from({length: 5}, (_, index) => ({
        path: `src/file-${index + 1}.ts`,
        metrics: {path: `src/file-${index + 1}.ts`, additions: 1, deletions: 0, changedLines: 1},
        diff: `line ${index + 1}`,
      })),
    );

    const instance = render(
      <App
        base="development"
        branch="feature/example"
        sections={sections}
        branchMetrics={{filesChanged: 5, additions: 5, deletions: 0, changedLines: 5}}
        dimensions={{columns: 120, rows: 18}}
      />,
    );

    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('file 1/5');

    for (let index = 0; index < 4; index += 1) {
      instance.stdin.write('\u001B[B');
      await flush();
    }

    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('file 5/5');

    for (let index = 0; index < 2; index += 1) {
      instance.stdin.write('\u001B[A');
      await flush();
    }

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('src/file-3.ts');
    expect(frame).toContain('file 3/5');

    instance.unmount();
  });

  it('preserves the selected file when refreshed sections still contain it', async () => {
    const firstSections = buildDiffSections([
      {
        path: 'src/one.ts',
        metrics: {path: 'src/one.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: 'one before',
      },
      {
        path: 'src/two.ts',
        metrics: {path: 'src/two.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: 'two before',
      },
    ]);
    const nextSections = buildDiffSections([
      {
        path: 'src/one.ts',
        metrics: {path: 'src/one.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: 'one after',
      },
      {
        path: 'src/two.ts',
        metrics: {path: 'src/two.ts', additions: 2, deletions: 0, changedLines: 2},
        diff: 'two after',
      },
    ]);

    const instance = render(
      <App
        base="development"
        branch="feature/example"
        sections={firstSections}
        branchMetrics={{filesChanged: 2, additions: 2, deletions: 0, changedLines: 2}}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    instance.stdin.write('\u001B[B');
    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('file 2/2');

    instance.rerender(
      <App
        base="development"
        branch="feature/example"
        sections={nextSections}
        branchMetrics={{filesChanged: 2, additions: 3, deletions: 0, changedLines: 3}}
        dimensions={{columns: 120, rows: 16}}
      />,
    );
    await flush();

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('src/two.ts');
    expect(frame).toContain('two after');
    expect(frame).toContain('file 2/2');

    instance.unmount();
  });

  it('renders an empty state without exiting the app', async () => {
    const instance = render(
      <App
        base="development"
        branch="HEAD + worktree"
        sections={[]}
        branchMetrics={{filesChanged: 0, additions: 0, deletions: 0, changedLines: 0}}
        dimensions={{columns: 120, rows: 16}}
        watchStatus="updated now"
        emptyStateHint="Watching for repo updates..."
      />,
    );

    await flush();

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('0 files • +0 • -0 • 0 changed');
    expect(frame).toContain('No changes to review');
    expect(frame).toContain('Watching for repo updates...');
    expect(frame).toContain('updated now • ↑/↓ jump file');

    instance.unmount();
  });

  it('renders wrapped diff lines with a hanging indent for continuation rows', async () => {
    const sections = buildDiffSections([
      {
        path: 'notes.md',
        metrics: {path: 'notes.md', additions: 1, deletions: 0, changedLines: 1},
        diff: '• path/to/file.md:12: The point of this plan is not to solve every mobile Stream problem at once.',
      },
    ]);

    const instance = render(
      <App
        base="development"
        branch="feature/example"
        sections={sections}
        branchMetrics={{filesChanged: 1, additions: 1, deletions: 0, changedLines: 1}}
        dimensions={{columns: 100, rows: 16}}
      />,
    );

    await flush();

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).not.toContain('Δ notes.md');
    expect(frame).toContain('╭');
    expect(frame).toContain('• path/to/file.md:12:');
    expect(frame).not.toContain('mobile Stream problem at once.');

    instance.unmount();
  });

  it('clicks tree file rows without landing on adjacent rows', async () => {
    const sections = buildDiffSections([
      {
        path: 'src/one.ts',
        metrics: {path: 'src/one.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: '+one',
      },
      {
        path: 'src/two.ts',
        metrics: {path: 'src/two.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: '+two',
      },
      {
        path: 'src/three.ts',
        metrics: {path: 'src/three.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: '+three',
      },
    ]);

    const instance = render(
      <App
        base="development"
        branch="feature/example"
        sections={sections}
        branchMetrics={{filesChanged: 3, additions: 3, deletions: 0, changedLines: 3}}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('file 1/3');

    await clickFrameText(instance.lastFrame() ?? '', 'two.ts');
    await flush();

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('src/two.ts');
    expect(frame).toContain('file 2/3');

    instance.unmount();
  });

  it('keeps the top visible file active when the next file fills more of the viewport', async () => {
    const sections = buildDiffSections([
      {
        path: 'src/short.ts',
        metrics: {path: 'src/short.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: '• src/short.ts:10:\nshort();',
      },
      {
        path: 'src/long.ts',
        metrics: {path: 'src/long.ts', additions: 8, deletions: 0, changedLines: 8},
        diff: Array.from({length: 8}, (_, index) => `long line ${index + 1}`).join('\n'),
      },
    ]);

    const instance = render(
      <App
        base="development"
        branch="feature/example"
        sections={sections}
        branchMetrics={{filesChanged: 2, additions: 9, deletions: 0, changedLines: 9}}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('src/short.ts');
    expect(frame).toContain('file 1/2');

    instance.unmount();
  });

  it('collapses and expands nested folders from the file tree', async () => {
    const sections = buildDiffSections([
      {
        path: 'w/src/App.tsx',
        metrics: {path: 'w/src/App.tsx', additions: 1, deletions: 0, changedLines: 1},
        diff: '+web',
      },
      {
        path: 'w/test/App.test.tsx',
        metrics: {path: 'w/test/App.test.tsx', additions: 1, deletions: 0, changedLines: 1},
        diff: '+test',
      },
      {
        path: 'a/src/server.ts',
        metrics: {path: 'a/src/server.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: '+server',
      },
    ]);

    const instance = render(
      <App
        base="development"
        branch="feature/example"
        sections={sections}
        branchMetrics={{filesChanged: 3, additions: 3, deletions: 0, changedLines: 3}}
        dimensions={{columns: 140, rows: 18}}
      />,
    );

    await flush();

    let frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('▾ w');

    await clickFrameTextOnce(instance.lastFrame() ?? '', '▾ w');
    await flush();

    frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('▸ w');
    expect(frame).toContain('file 1/3');

    await clickFrameTextOnce(instance.lastFrame() ?? '', '▸ w');
    await flush();

    frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('▾ w');
    expect(frame).toContain('file 1/3');

    instance.unmount();
  });

  it('copies the hovered block from its own file even when another file is active', async () => {
    const shortRawDiff = [
      '@@ -10 +10 @@ function short()',
      '-short(false);',
      '+short(true);',
    ].join('\n');
    const longRawDiff = [
      '@@ -33 +33 @@ function long()',
      '-long(false);',
      '+long(true);',
    ].join('\n');
    const sections = buildDiffSections([
      {
        path: 'src/short.ts',
        metrics: {path: 'src/short.ts', additions: 1, deletions: 1, changedLines: 2},
        diff: '• src/short.ts:10: function short()\n  10 ⋮  10 │short(true);',
      },
      {
        path: 'src/long.ts',
        metrics: {path: 'src/long.ts', additions: 8, deletions: 1, changedLines: 9},
        diff: [
          '• src/long.ts:33: function long()',
          '  33 ⋮  33 │long(true);',
          ...Array.from({length: 8}, (_, index) => `long line ${index + 1}`),
        ].join('\n'),
      },
    ]);
    const review: ReviewModel = {
      base: 'development',
      branch: 'HEAD + worktree',
      label: 'development...HEAD + worktree',
      metrics: {filesChanged: 2, additions: 9, deletions: 2, changedLines: 11},
      files: [
        {
          path: 'src/short.ts',
          status: 'modified',
          metrics: {path: 'src/short.ts', additions: 1, deletions: 1, changedLines: 2},
          rawDiff: shortRawDiff,
          renderedLines: [],
          blocks: [{
            id: 'src/short.ts:10:0',
            filePath: 'src/short.ts',
            oldStart: 10,
            oldLines: 1,
            newStart: 10,
            newLines: 1,
            lineStart: 10,
            lineEnd: 10,
            functionHeader: 'function short()',
            rawDiff: shortRawDiff,
            addedCode: 'short(true);',
          }],
        },
        {
          path: 'src/long.ts',
          status: 'modified',
          metrics: {path: 'src/long.ts', additions: 8, deletions: 1, changedLines: 9},
          rawDiff: longRawDiff,
          renderedLines: [],
          blocks: [{
            id: 'src/long.ts:33:0',
            filePath: 'src/long.ts',
            oldStart: 33,
            oldLines: 1,
            newStart: 33,
            newLines: 1,
            lineStart: 33,
            lineEnd: 33,
            functionHeader: 'function long()',
            rawDiff: longRawDiff,
            addedCode: 'long(true);',
          }],
        },
      ],
    };
    const writes: string[] = [];
    const instance = render(
      <App
        base="development"
        branch="HEAD + worktree"
        sections={sections}
        branchMetrics={{filesChanged: 2, additions: 9, deletions: 2, changedLines: 11}}
        review={review}
        copyWriter={async (text) => {
          writes.push(text);
          return {
            ok: true,
            command: {command: '/usr/bin/pbcopy', args: [], displayName: 'pbcopy'},
          };
        }}
        dimensions={{columns: 150, rows: 18}}
      />,
    );

    await flush();
    await moveFrameText(instance.lastFrame() ?? '', 'src/short.ts:10');
    await flush();
    await clickFrameLineAction(instance.lastFrame() ?? '', 'src/short.ts:10', 'Copy block');
    await flush();

    expect(writes.at(-1)).toContain('File: src/short.ts');
    expect(writes.at(-1)).toContain('Lines: 10-10');
    expect(writes.at(-1)).toContain(shortRawDiff);
    expect(writes.at(-1)).not.toContain('src/long.ts');
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('✓ Copied block · src/short.ts:10');

    instance.unmount();
  });

  it('renders copy affordances from the review model', async () => {
    const rawDiff = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1,2 @@ function example()',
      '-export const value = 1;',
      '+export const value = 2;',
      '+export const next = 3;',
    ].join('\n');
    const sections = buildDiffSections([
      {
        path: 'src/example.ts',
        metrics: {path: 'src/example.ts', additions: 2, deletions: 1, changedLines: 3},
        diff: '• src/example.ts:1: function example()\n  1 ⋮  1 │export const value = 2;',
      },
    ]);
    const review: ReviewModel = {
      base: 'development',
      branch: 'HEAD + worktree',
      label: 'development...HEAD + worktree',
      metrics: {filesChanged: 1, additions: 2, deletions: 1, changedLines: 3},
      files: [{
        path: 'src/example.ts',
        status: 'modified',
        metrics: {path: 'src/example.ts', additions: 2, deletions: 1, changedLines: 3},
        rawDiff,
        renderedLines: [],
        blocks: [{
          id: 'src/example.ts:1:0',
          filePath: 'src/example.ts',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lineStart: 1,
          lineEnd: 2,
          functionHeader: 'function example()',
          rawDiff: rawDiff.split('\n').slice(3).join('\n'),
          addedCode: 'export const value = 2;\nexport const next = 3;',
        }],
      }],
    };

    const instance = render(
      <App
        base="development"
        branch="HEAD + worktree"
        sections={sections}
        branchMetrics={{filesChanged: 1, additions: 2, deletions: 1, changedLines: 3}}
        review={review}
        dimensions={{columns: 160, rows: 18}}
      />,
    );

    await flush();

    let frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('M');
    expect(frame).toContain('Copy');
    expect(frame).toContain('Copy path');
    expect(frame).toContain('Copy diff');
    expect(frame).toContain('Copy file');
    expect(frame).not.toContain('Copy absolute path');
    expect(frame).toContain('Copy block');
    expect(frame).not.toContain('Copy prompt');
    expect(frame).toContain('Copy code');
    expect(frame).not.toContain('palette');
    expect(frame).not.toContain('copy menu');
    expect(instance.lastFrame() ?? '').not.toContain('\u001B[96mCopy block');
    expect(frame).not.toContain('More');
    expect(instance.lastFrame() ?? '').not.toContain('\u001B[96;1mCopy code');

    await moveFrameText(instance.lastFrame() ?? '', 'Copy code');
    await flush();
    expect(instance.lastFrame() ?? '').toMatch(/\u001B\[(?:96;1|96m\u001B\[1)mCopy code/);

    instance.unmount();
  });

  it('keeps file tree status badges separated from filenames when copy is hidden', async () => {
    const sections = buildDiffSections([
      {
        path: 'src/qmd-query-playbook.md',
        metrics: {path: 'src/qmd-query-playbook.md', additions: 1, deletions: 0, changedLines: 1},
        diff: '+query',
      },
    ]);
    const review: ReviewModel = {
      base: 'development',
      branch: 'HEAD + worktree',
      label: 'development...HEAD + worktree',
      metrics: {filesChanged: 1, additions: 1, deletions: 0, changedLines: 1},
      files: [{
        path: 'src/qmd-query-playbook.md',
        status: 'untracked',
        metrics: {path: 'src/qmd-query-playbook.md', additions: 1, deletions: 0, changedLines: 1},
        rawDiff: '',
        renderedLines: ['+query'],
        blocks: [],
      }],
    };

    const instance = render(
      <App
        base="development"
        branch="HEAD + worktree"
        sections={sections}
        branchMetrics={{filesChanged: 1, additions: 1, deletions: 0, changedLines: 1}}
        review={review}
        dimensions={{columns: 220, rows: 18}}
      />,
    );

    await flush();

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).not.toContain('qmd-query-playbook.mdU');

    instance.unmount();
  });

  it('does not treat Ctrl+K as normal k scrolling while palette is unavailable', async () => {
    const sections = buildDiffSections([
      {
        path: 'src/example.ts',
        metrics: {path: 'src/example.ts', additions: 1, deletions: 0, changedLines: 1},
        diff: Array.from({length: 12}, (_, index) => `line ${index + 1}`).join('\n'),
      },
    ]);

    const instance = render(
      <App
        base="development"
        branch="feature/example"
        sections={sections}
        branchMetrics={{filesChanged: 1, additions: 1, deletions: 0, changedLines: 1}}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    instance.stdin.write('\u000B');
    await flush();

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('✓ Palette is not available yet.');
    expect(frame).toContain('ln 1-');

    instance.unmount();
  });

  it('shows a toast when a file copy action is clicked', async () => {
    const rawDiff = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1,2 @@ function example()',
      '-export const value = 1;',
      '+export const value = 2;',
      '+export const next = 3;',
    ].join('\n');
    const sections = buildDiffSections([
      {
        path: 'src/example.ts',
        metrics: {path: 'src/example.ts', additions: 2, deletions: 1, changedLines: 3},
        diff: '• src/example.ts:1: function example()\n  1 ⋮  1 │export const value = 2;',
      },
    ]);
    const review: ReviewModel = {
      base: 'development',
      branch: 'HEAD + worktree',
      label: 'development...HEAD + worktree',
      metrics: {filesChanged: 1, additions: 2, deletions: 1, changedLines: 3},
      files: [{
        path: 'src/example.ts',
        status: 'modified',
        metrics: {path: 'src/example.ts', additions: 2, deletions: 1, changedLines: 3},
        rawDiff,
        renderedLines: [],
        blocks: [{
          id: 'src/example.ts:1:0',
          filePath: 'src/example.ts',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lineStart: 1,
          lineEnd: 2,
          functionHeader: 'function example()',
          rawDiff: rawDiff.split('\n').slice(3).join('\n'),
          addedCode: 'export const value = 2;\nexport const next = 3;',
        }],
      }],
    };
    const writes: string[] = [];
    const instance = render(
      <App
        base="development"
        branch="HEAD + worktree"
        sections={sections}
        branchMetrics={{filesChanged: 1, additions: 2, deletions: 1, changedLines: 3}}
        review={review}
        copyWriter={async (text) => {
          writes.push(text);
          return {
            ok: true,
            command: {command: '/usr/bin/pbcopy', args: [], displayName: 'pbcopy'},
          };
        }}
        readFileContent={() => 'export const value = 2;\nexport const next = 3;\n'}
        resolveAbsolutePath={() => '/repo/src/example.ts'}
        dimensions={{columns: 160, rows: 18}}
      />,
    );

    await flush();
    await clickFrameTextOnce(instance.lastFrame() ?? '', 'Copy path');
    await flush();

    expect(writes).toContain('src/example.ts');
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('✓ Copied path · src/example.ts');
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('Copy absolute path');

    await clickFrameTextOnce(instance.lastFrame() ?? '', 'Copy absolute path');
    await flush();

    expect(writes).toContain('/repo/src/example.ts');
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('✓ Copied absolute path · src/example.ts');

    await clickFrameTextOnce(instance.lastFrame() ?? '', 'Copy diff');
    await flush();

    expect(writes).toContain(rawDiff);
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('✓ Copied file diff · src/example.ts');

    await clickFrameTextOnce(instance.lastFrame() ?? '', 'Copy file');
    await flush();

    expect(writes).toContain('export const value = 2;\nexport const next = 3;\n');
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('✓ Copied file · src/example.ts');

    await moveFrameText(instance.lastFrame() ?? '', 'export const value = 2;');
    await flush();

    let frameLines = stripAnsi(instance.lastFrame() ?? '').split('\n');
    const actionRow = frameLines.findIndex((line) => line.includes('Copy code'));
    const actionColumn = frameLines[actionRow]?.indexOf('Copy code') ?? -1;
    const codeRow = frameLines.findIndex((line) => line.includes('export const value = 2;'));
    expect(actionRow).toBeGreaterThanOrEqual(0);
    expect(actionColumn).toBeGreaterThanOrEqual(0);
    expect(codeRow).toBeGreaterThanOrEqual(0);

    await emitMouseClickAt(actionColumn + 1, codeRow);
    await flush();
    expect(writes).not.toContain('export const value = 2;\nexport const next = 3;');
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain('Copied block code');

    await clickFrameText(instance.lastFrame() ?? '', 'Copy code');
    await flush();

    expect(writes).toContain('export const value = 2;\nexport const next = 3;');
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('✓ Copied block code · src/example.ts:1');
    expect(instance.lastFrame() ?? '').toMatch(/\u001B\[(?:32;1|32m\u001B\[1)m✓ Copied/);

    instance.unmount();
  });
});
