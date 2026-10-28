import React from 'react';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DiffErrorBoundary, renderFailureText} from '../src/ui/DiffErrorBoundary.js';
import {buildDiffSections} from '../src/sections.js';
import stringWidth from 'string-width';
import {
  appElement,
  buildFixture,
  cellPosition,
  emitMousePressAt,
  flush,
  frameLines,
  recordingWriter,
  renderFixture,
  renderSized,
} from './ui-fixtures.js';

// The app draws every diff pane row through frameLine; make it throw for one
// file's content so a render-time failure inside the pane can be simulated.
vi.mock('../src/sections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sections.js')>();
  return {
    ...actual,
    frameLine: (line: string, ...rest: [number, string]) => {
      if (line.includes('BOOM')) throw new Error('renderer exploded');
      return actual.frameLine(line, ...rest);
    },
  };
});

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React reports caught render errors on console.error.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
});

function Thrower({fail}: {fail: boolean}) {
  if (fail) throw new Error('bad row');
  return <Text>rendered fine</Text>;
}

describe('diff error boundary', () => {
  it('shows which file failed and recovers when its reset key changes', async () => {
    const instance = render(
      <DiffErrorBoundary filePath="src/x.ts" resetKey="1" width={60}>
        <Thrower fail />
      </DiffErrorBoundary>,
    );
    await flush();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('could not render src/x.ts: bad row');

    instance.rerender(
      <DiffErrorBoundary filePath="src/x.ts" resetKey="2" width={60}>
        <Thrower fail={false} />
      </DiffErrorBoundary>,
    );
    await flush();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('rendered fine');

    instance.unmount();
  });
});

describe('the render failure row', () => {
  const deepPath = 'packages/server/src/features/notifications/delivery/channels/push/provider.ts';

  it('cuts a long path from its start and keeps the reason whole', () => {
    const text = renderFailureText(deepPath, 'bad row', 40);
    expect(stringWidth(text)).toBeLessThanOrEqual(40);
    expect(text).toMatch(/^✗ could not render …\S*provider\.ts: bad row$/);
  });

  it('leads with the reason when the reason alone fills the row', () => {
    const reason = 'Cannot read properties of undefined (reading replace)';
    const text = renderFailureText(deepPath, reason, 40);
    expect(stringWidth(text)).toBeLessThanOrEqual(40);
    expect(text.startsWith('✗ Cannot read properties of')).toBe(true);
  });

  it('keeps the reason in a narrow pane when the pane itself fails to draw', async () => {
    const instance = renderSized(
      <DiffErrorBoundary filePath={deepPath} resetKey="1" width={44}>
        <Thrower fail />
      </DiffErrorBoundary>,
      {columns: 44, rows: 10},
    );
    await flush();

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('provider.ts: bad row');

    instance.unmount();
  });

  it('keeps the reason when a file with a long path cannot be wrapped in a narrow terminal', async () => {
    const sections = buildDiffSections([
      {path: 'src/good.ts', metrics: {path: 'src/good.ts', additions: 1, deletions: 0, changedLines: 1}, diff: 'good line'},
      {path: deepPath, metrics: {path: deepPath, additions: 1, deletions: 0, changedLines: 1}, diff: 'x'},
    ]);
    // A malformed line makes wrapping this one section throw.
    sections[1]!.lines = [undefined as unknown as string];
    const instance = renderFixture({sections}, {columns: 80, rows: 24});
    await flush();
    instance.stdin.write('\u001B[B');
    await flush(2);

    // The reason alone is wider than the pane, so it leads the row.
    const row = frameLines(instance.lastFrame()).find((line) => line.includes('✗'));
    expect(row).toMatch(/│ ✗ Cannot read properties of undefined/);

    instance.unmount();
  });
});

describe('a diff that fails to render', () => {
  const fixture = () => buildFixture([
    {path: 'src/bad.ts', rawDiff: '@@ -1 +1 @@\n-a\n+BOOM', rendered: ['• src/bad.ts:1: ', '   1 ⋮   1 │BOOM']},
    {path: 'src/good.ts', rawDiff: '@@ -1 +1 @@\n-a\n+fine', rendered: ['• src/good.ts:1: ', '   1 ⋮   1 │fine line']},
  ]);

  it('keeps the rest of the review working when one file throws while drawing', async () => {
    const writes: string[] = [];
    const instance = renderFixture(fixture(), {columns: 120, rows: 24}, writes);
    await flush();

    let frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('could not render src/bad.ts');
    expect(frame).toContain('Changed files');
    expect(frame).toContain('good.ts');

    // The tree and the keyboard still work, and the next file draws.
    const treeRow = cellPosition(instance.lastFrame(), ['good.ts'], 'good.ts');
    await emitMousePressAt(treeRow.column, treeRow.row);
    await flush(2);
    frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('fine line');
    expect(frame).toContain('file 2/2');

    instance.stdin.write('y');
    await flush(3);
    expect(writes).toEqual(['src/good.ts']);

    instance.unmount();
  });

  it('draws the pane again when a refresh fixes the file, at the same offset', async () => {
    const broken = buildFixture([{path: 'src/bad.ts', rawDiff: '@@ -1 +1 @@\n-a\n+BOOM', rendered: ['• src/bad.ts:1: ', '   1 ⋮   1 │BOOM']}]);
    const instance = renderFixture(broken, {columns: 120, rows: 24});
    await flush();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('could not render src/bad.ts');

    // Same file, same offset and width: only the refresh changed.
    const fixed = buildFixture([{path: 'src/bad.ts', rawDiff: '@@ -1 +1 @@\n-a\n+fixed', rendered: ['• src/bad.ts:1: ', '   1 ⋮   1 │fixed now']}]);
    instance.rerender(appElement(fixed, {columns: 120, rows: 24}, recordingWriter([])));
    await flush(2);

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('fixed now');
    expect(frame).not.toContain('could not render');

    instance.unmount();
  });

  it('isolates a file whose lines cannot be wrapped', async () => {
    const sections = buildDiffSections([
      {path: 'src/good.ts', metrics: {path: 'src/good.ts', additions: 1, deletions: 0, changedLines: 1}, diff: 'good line'},
      {path: 'src/broken.ts', metrics: {path: 'src/broken.ts', additions: 1, deletions: 0, changedLines: 1}, diff: 'x'},
    ]);
    // A malformed line makes wrapping this one section throw.
    sections[1]!.lines = [undefined as unknown as string];
    const instance = renderFixture({sections}, {columns: 120, rows: 24});
    await flush();

    expect(frameLines(instance.lastFrame()).join('\n')).toContain('good line');
    instance.stdin.write('\u001B[B');
    await flush(2);
    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('file 2/2');
    // The path gives way so the whole reason fits; the file header names it.
    expect(frameLines(instance.lastFrame())[4]).toContain('src/broken.ts');
    expect(frame).toMatch(/could not render …\S*\.ts: Cannot read properties of undefined \(reading 'replace'\)/);

    instance.unmount();
  });
});

describe('a file whose diff failed to build', () => {
  const fixture = () => buildFixture([
    {
      path: 'src/err.ts',
      rawDiff: '@@ -1 +1 @@\n-a\n+b',
      rendered: [],
      error: 'delta exited with code 2\u001B[2J',
    },
    {path: 'src/ok.ts', rawDiff: '@@ -1 +1 @@\n-a\n+ok', rendered: ['• src/ok.ts:1: ', '   1 ⋮   1 │ok line']},
  ]);

  it('shows the error under the file header with control characters made visible', async () => {
    const instance = renderFixture(fixture(), {columns: 120, rows: 24});
    await flush();

    const raw = instance.lastFrame() ?? '';
    const lines = frameLines(raw);
    const errorRow = lines.findIndex((line) => line.includes('✗ Could not load diff: delta exited with code 2␛[2J'));
    expect(errorRow).toBe(6);
    expect(raw).not.toContain('\u001B[2J');

    instance.unmount();
  });

  it('keeps the copy actions working for that file', async () => {
    const writes: string[] = [];
    const data = fixture();
    const instance = renderFixture(data, {columns: 120, rows: 24}, writes);
    await flush();

    const copyDiff = cellPosition(instance.lastFrame(), ['Copy path', 'Copy diff'], 'Copy diff', 1);
    await emitMousePressAt(copyDiff.column, copyDiff.row);
    await flush(2);
    instance.stdin.write('c');
    await flush(3);

    expect(writes).toEqual([data.review.files[0]!.rawDiff, data.review.files[0]!.blocks[0]!.addedCode]);

    instance.unmount();
  });

  it('adds no error row for a file without an error', async () => {
    const instance = renderFixture(fixture(), {columns: 120, rows: 24});
    await flush();
    instance.stdin.write('\u001B[B');
    await flush(2);

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('ok line');
    expect(frame.match(/Could not load diff/g) ?? []).toHaveLength(0);

    instance.unmount();
  });
});
