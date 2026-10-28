import React from 'react';
import {describe, expect, it} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildFixture, emitMouseMoveAt, flush, frameLines, gutter, renderFixture, renderSized} from './ui-fixtures.js';

// Hover text built from repo strings (a truncated file name in the tree
// tooltip, the branch name in the top bar's tip) shows hidden characters as
// visible markers, the same as every other repo string on screen.

const HIDDEN = ['‮', '​', '\u001B'];

function expectNoHiddenCharacters(frame: string | undefined) {
  const text = frameLines(frame).join('\n');
  for (const char of HIDDEN) expect(text).not.toContain(char);
}

describe('hover text with hidden characters', () => {
  it('shows markers in the tooltip of a truncated tree file name', async () => {
    const name = 'a-file-name-long-enough-to-truncate‮gnp.exe​-in-the-tree.ts';
    const path = `src/${name}`;
    const fixture = buildFixture([{path, rawDiff: '@@ -1 +1 @@\n-a\n+b\n', rendered: [`• ${path}:1: `, `${gutter(1)}b`]}]);
    const instance = renderFixture(fixture, {columns: 120, rows: 30});
    await flush();

    // The tree row for the file, cut short with an ellipsis.
    const lines = frameLines(instance.lastFrame());
    const row = lines.findIndex((line) => line.includes('• a-file-name'));
    expect(row).toBeGreaterThanOrEqual(0);
    await emitMouseMoveAt(lines[row]!.indexOf('a-file-name') + 2, row);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flush();

    const escaped = 'a-file-name-long-enough-to-truncate<U+202E>gnp.exe<U+200B>-in-the-tree.ts';
    expect(frameLines(instance.lastFrame()).join('\n')).toContain(`│ ${escaped} │`);
    expectNoHiddenCharacters(instance.lastFrame());

    instance.unmount();
  });

  it('shows markers in the current-branch tip', async () => {
    const fixture = buildFixture([{path: 'a.ts', rawDiff: '@@ -1 +1 @@\n-a\n+b\n', rendered: ['• a.ts:1: ', `${gutter(1)}b`]}]);
    const dimensions = {columns: 160, rows: 20};
    const instance = renderSized(
      <App
        base="origin/development"
        branch="HEAD + worktree"
        worktreeBranchName={'feature/‮txt.exe\u001B[2J'}
        sections={fixture.sections}
        review={fixture.review}
        branchMetrics={fixture.review.metrics}
        dimensions={dimensions}
      />,
      dimensions,
    );
    await flush();

    const lines = frameLines(instance.lastFrame());
    const row = lines.findIndex((line) => line.includes('HEAD + worktree'));
    const column = lines[row]!.indexOf('worktree');
    for (const offset of [0, 1, 2]) await emitMouseMoveAt(column + offset, row);
    await flush();

    expect(frameLines(instance.lastFrame()).join('\n')).toContain('current branch feature/<U+202E>txt.exe␛[2J');
    expectNoHiddenCharacters(instance.lastFrame());

    instance.unmount();
  });
});
