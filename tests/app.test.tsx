import React from 'react';
import stripAnsi from 'strip-ansi';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildDiffSections, type BranchMetrics} from '../src/sections.js';

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

    let frame = stripAnsi(instance.lastFrame());
    expect(frame).toContain('CLAUDE.md');
    expect(frame).toContain('2 files • +5 • -2 • 7 changed');
    expect(frame).toContain('file 1/2');

    for (let index = 0; index < 12; index += 1) {
      instance.stdin.write('j');
      await flush();
    }

    frame = stripAnsi(instance.lastFrame());
    expect(frame).toContain('src/App.tsx');
    expect(frame).toContain('file 2/2');

    instance.stdin.write('\u001B[A');
    await flush();

    frame = stripAnsi(instance.lastFrame());
    expect(frame).toContain('file 1/2');
    expect(frame).toContain('CLAUDE.md');

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

    const frame = stripAnsi(instance.lastFrame());
    expect(frame).not.toContain('Δ notes.md');
    expect(frame).toContain('╭');
    expect(frame).toContain('• path/to/file.md:12: The point');
    expect(frame).toContain('  mobile Stream problem at once.');

    instance.unmount();
  });
});
