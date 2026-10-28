import React from 'react';
import stringWidth from 'string-width';
import {describe, expect, it} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildDiffSections, type DiffSection} from '../src/sections.js';
import type {ReviewModel} from '../src/review/model.js';
import {
  emitMouseMoveAt,
  emitMousePressAt,
  emitWheelDownAt,
  flush,
  frameFits,
  frameLines,
  recordingWriter,
  renderFixture,
  renderOnTerminal,
} from './ui-fixtures.js';

const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const paths = names.map((name) => `src/${name}.ts`);

function sixFileFixture(): {sections: DiffSection[]; review: ReviewModel} {
  const metricsFor = (path: string) => ({path, additions: 1, deletions: 0, changedLines: 1});
  return {
    sections: buildDiffSections(paths.map((path) => ({path, metrics: metricsFor(path), diff: `+${path}`}))),
    review: {
      base: 'development',
      branch: 'HEAD',
      label: 'development...HEAD',
      metrics: {filesChanged: 6, additions: 6, deletions: 0, changedLines: 6},
      files: paths.map((path) => ({
        path,
        status: 'modified' as const,
        metrics: metricsFor(path),
        rawDiff: `+${path}`,
        renderedLines: [],
        blocks: [],
      })),
    },
  };
}

function linesFile(path: string, count: number, prefix: string) {
  return {
    path,
    metrics: {path, additions: count, deletions: 0, changedLines: count},
    diff: Array.from({length: count}, (_, index) => `${prefix}-${index + 1}`).join('\n'),
  };
}

describe('small terminals', () => {
  for (const [columns, rows] of [[120, 14], [120, 16], [100, 16], [80, 24], [74, 24], [73, 24], [60, 20], [58, 14]] as const) {
    it(`keeps the whole frame on a ${columns}x${rows} screen`, async () => {
      const instance = renderFixture(sixFileFixture(), {columns, rows});
      await flush();

      const frame = instance.lastFrame() ?? '';
      expect(frameFits(frame, columns, rows)).toMatchObject({fits: true});
      const lines = frameLines(frame);
      // Top bar and footer are one content row each between their borders.
      expect(lines[0]).toMatch(/^╭─+╮$/);
      expect(lines[1]).toContain('branch-review');
      expect(lines[2]).toMatch(/^╰─+╯$/);
      expect(lines.at(-3)).toMatch(/^╭─+╮$/);
      expect(lines.at(-1)).toMatch(/^╰─+╯$/);
      expect(frame).not.toContain('Terminal too small');

      instance.unmount();
    });
  }

  it('uses the full height for the panes', async () => {
    const instance = renderFixture(sixFileFixture(), {columns: 120, rows: 30});
    await flush();

    // One row is left free: Ink clears the screen when the frame is as tall as it.
    expect(frameFits(instance.lastFrame() ?? '', 120, 30).height).toBe(29);

    instance.unmount();
  });

  it('copies the tree row under the pointer at 120x14', async () => {
    const writes: string[] = [];
    const instance = renderFixture(sixFileFixture(), {columns: 120, rows: 14}, writes);
    await flush();

    // The frame fits the screen, so frame rows are screen rows.
    const lines = frameLines(instance.lastFrame());
    expect(lines.length).toBeLessThanOrEqual(13);
    const row = lines.findIndex((line) => line.includes('charlie.ts'));
    expect(row).toBeGreaterThanOrEqual(0);
    const copyColumn = lines[row]!.indexOf('│', 2) - 3;
    await emitMouseMoveAt(copyColumn, row);
    await emitMousePressAt(copyColumn, row);
    await flush();

    expect(writes).toEqual(['src/charlie.ts']);

    instance.unmount();
  });

  it('collapses the tree when both panes cannot fit', async () => {
    const instance = renderFixture(sixFileFixture(), {columns: 60, rows: 20});
    await flush();

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).not.toContain('Changed files');
    expect(frame).toContain('6 files');
    expect(frame).toContain('src/alpha.ts');

    instance.unmount();
  });

  it('says why t cannot open the tree in a narrow terminal', async () => {
    const instance = renderFixture(sixFileFixture(), {columns: 60, rows: 20});
    await flush();

    instance.stdin.write('t');
    await flush();

    const lines = frameLines(instance.lastFrame());
    expect(lines.join('\n')).not.toContain('Changed files');
    expect(lines.at(-2)).toContain('The file tree needs a wider terminal');

    instance.unmount();
  });

  it('opens the tree again when the terminal grows wide enough', async () => {
    const instance = renderOnTerminal(sixFileFixture(), 60, 20);
    await flush(3);
    expect(frameLines(instance.lastFrame()).join('\n')).not.toContain('Changed files');

    instance.resize(120, 30);
    await flush(3);
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('Changed files');

    instance.unmount();
  });

  it('keeps the tree open when both panes fit', async () => {
    const instance = renderFixture(sixFileFixture(), {columns: 74, rows: 20});
    await flush();

    expect(frameLines(instance.lastFrame()).join('\n')).toContain('Changed files');

    instance.unmount();
  });

  for (const [columns, rows] of [[57, 24], [120, 13], [40, 8]] as const) {
    it(`shows "Terminal too small" instead of the panes at ${columns}x${rows}`, async () => {
      const instance = renderFixture(sixFileFixture(), {columns, rows});
      await flush();

      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('Terminal too small');
      expect(frame).not.toContain('src/alpha.ts');
      expect(frameFits(frame, columns, rows)).toMatchObject({fits: true});

      instance.unmount();
    });
  }
});

describe('terminal resize', () => {
  it('lays the frame out again for the new size', async () => {
    const instance = renderOnTerminal(sixFileFixture(), 120, 30);
    await flush(3);
    expect(frameFits(instance.lastFrame(), 120, 30)).toMatchObject({fits: true, maxWidth: 120});

    instance.resize(80, 20);
    await flush(3);

    const frame = instance.lastFrame();
    expect(frameFits(frame, 80, 20)).toMatchObject({fits: true, maxWidth: 80});
    expect(frameFits(frame, 80, 20).height).toBe(19);

    instance.unmount();
  });

  it('prefers explicit dimensions over the terminal size', async () => {
    const fixture = sixFileFixture();
    const instance = renderOnTerminal(fixture, 120, 30);
    await flush();
    instance.rerender(
      <App
        base="development"
        branch="HEAD"
        sections={fixture.sections}
        branchMetrics={fixture.review.metrics}
        review={fixture.review}
        copyWriter={recordingWriter([])}
        dimensions={{columns: 90, rows: 20}}
      />,
    );
    await flush(3);

    expect(frameFits(instance.lastFrame(), 90, 20)).toMatchObject({fits: true, maxWidth: 90});

    instance.unmount();
  });
});

describe('footer', () => {
  it('keeps a long watch error on the footer row', async () => {
    const longError = `watch error: git diff failed: ${'/Users/someone/Projects/a-very-long-repository-name/packages/'.repeat(4)}file.ts`;
    const instance = renderFixture({...sixFileFixture(), watchStatus: longError}, {columns: 100, rows: 20});
    await flush();

    const frame = instance.lastFrame() ?? '';
    expect(frameFits(frame, 100, 20)).toMatchObject({fits: true, height: 19});
    const lines = frameLines(frame);
    expect(lines.at(-3)).toMatch(/^╭─+╮$/);
    expect(lines.at(-2)).toMatch(/^│ watch error: git diff failed: .*│$/);
    expect(stringWidth(lines.at(-2)!)).toBe(100);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);

    instance.unmount();
  });

  it('keeps the range label when the status fits', async () => {
    // A real-size terminal: the test renderer's stdout is fixed at 100 columns.
    const instance = renderOnTerminal({...sixFileFixture(), watchStatus: 'updated now'}, 160, 20);
    await flush(3);

    expect(frameLines(instance.lastFrame()).at(-2)).toMatch(/^│ updated now .* development\.\.\.HEAD │$/);

    instance.unmount();
  });
});

describe('scroll ceiling', () => {
  const shortLastFile = () => ({
    sections: buildDiffSections([linesFile('src/a.ts', 30, 'a'), linesFile('src/b.ts', 2, 'b')]),
  });

  it('keeps a short last file in view when scrolling down after jumping to it', async () => {
    const instance = renderFixture(shortLastFile(), {columns: 120, rows: 20});
    await flush();

    instance.stdin.write('\u001B[B');
    await flush();
    let frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('file 2/2');
    expect(frame).toContain('b-1');

    instance.stdin.write('j');
    await flush();
    frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('file 2/2');
    expect(frame).toContain('b-2');
    expect(frame).not.toMatch(/a-\d+/);

    instance.unmount();
  });

  it('keeps a short last file in view when the wheel scrolls down after jumping to it', async () => {
    const instance = renderFixture(shortLastFile(), {columns: 120, rows: 20});
    await flush();

    instance.stdin.write('\u001B[B');
    await flush();
    const lines = frameLines(instance.lastFrame());
    const row = lines.findIndex((line) => line.includes('b-1'));
    await emitWheelDownAt(lines[row]!.indexOf('b-1'), row);
    await flush();

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('file 2/2');
    expect(frame).not.toMatch(/a-\d+/);

    instance.unmount();
  });

  it('still scrolls up from a jumped-to last file', async () => {
    const instance = renderFixture(shortLastFile(), {columns: 120, rows: 20});
    await flush();

    instance.stdin.write('G');
    await flush();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 2/2');
    for (let index = 0; index < 3; index += 1) {
      instance.stdin.write('k');
      await flush();
    }

    expect(frameLines(instance.lastFrame()).join('\n')).toContain('a-30');

    instance.unmount();
  });
});

describe('refresh that removes the file in view', () => {
  it('opens the next file at its top', async () => {
    const files = [linesFile('src/a.ts', 2, 'a'), linesFile('src/b.ts', 40, 'b'), linesFile('src/c.ts', 40, 'c')];
    const instance = renderFixture({sections: buildDiffSections(files)}, {columns: 120, rows: 20});
    await flush();

    instance.stdin.write('\u001B[B');
    await flush();
    for (let index = 0; index < 30; index += 1) {
      instance.stdin.write('j');
      await flush();
    }
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('b-31');

    instance.rerender(
      <App
        base="development"
        branch="HEAD"
        sections={buildDiffSections([files[0]!, files[2]!])}
        branchMetrics={{filesChanged: 2, additions: 42, deletions: 0, changedLines: 42}}
        dimensions={{columns: 120, rows: 20}}
      />,
    );
    await flush(2);

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('file 2/2');
    expect(frame).toMatch(/│ c-1 +│/);
    expect(frame).not.toContain('c-31');

    instance.unmount();
  });

  it('keeps the offset inside a file that is still there', async () => {
    const files = [linesFile('src/a.ts', 2, 'a'), linesFile('src/b.ts', 40, 'b')];
    const instance = renderFixture({sections: buildDiffSections(files)}, {columns: 120, rows: 20});
    await flush();

    instance.stdin.write('\u001B[B');
    await flush();
    for (let index = 0; index < 10; index += 1) {
      instance.stdin.write('j');
      await flush();
    }

    instance.rerender(
      <App
        base="development"
        branch="HEAD"
        sections={buildDiffSections([linesFile('src/a.ts', 5, 'a'), files[1]!])}
        branchMetrics={{filesChanged: 2, additions: 45, deletions: 0, changedLines: 45}}
        dimensions={{columns: 120, rows: 20}}
      />,
    );
    await flush(2);

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('file 2/2');
    expect(frame).toContain('b-11');
    expect(frame).not.toContain('b-10 ');

    instance.unmount();
  });
});
