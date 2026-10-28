import {afterEach, describe, expect, it, vi} from 'vitest';

// Ink colours through chalk, which picks its colour level when first
// imported; force colour on before any import so the frame carries the bold
// that marks the selected tree row.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  return previous;
});

const {buildFixture, emitMouseMoveAt, flush, frameLines, gutter, renderFixture} = await import('./ui-fixtures.js');

if (previousForceColor === undefined) {
  delete process.env.FORCE_COLOR;
} else {
  process.env.FORCE_COLOR = previousForceColor;
}

const BOLD = /\u001B\[(?:\d+;)*1m/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tree rows with the same path', () => {
  // A deleted file `bin/tool` and an added `bin/tool/index.js` give a file
  // row and a directory row that share the path `bin/tool`.
  const fixture = () => buildFixture([
    {path: 'bin/tool', rawDiff: '@@ -1 +0,0 @@\n-old tool', rendered: ['• bin/tool:0: ', `${gutter(1)}old tool`]},
    {path: 'bin/tool/index.js', rawDiff: '@@ -0,0 +1 @@\n+new tool', rendered: ['• bin/tool/index.js:1: ', `${gutter(1)}new tool`]},
  ]);

  it('selects only the file row and renders without a duplicate-key warning', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const instance = renderFixture(fixture(), {columns: 120, rows: 30});
    await flush();

    const lines = (instance.lastFrame() ?? '').split('\n');
    const fileRow = lines.find((line) => frameLines(line)[0]!.includes('• tool'));
    const directoryRow = lines.find((line) => frameLines(line)[0]!.includes('▾ tool'));
    expect(fileRow).toBeDefined();
    expect(directoryRow).toBeDefined();
    // Only the tree part of the row: the diff pane on the same row has its own styles.
    const treePart = (line: string) => line.slice(0, line.indexOf('tool') + 'tool'.length);
    expect(treePart(fileRow!)).toMatch(BOLD);
    expect(treePart(directoryRow!)).not.toMatch(BOLD);

    const messages = errors.mock.calls.map((call) => call.map(String).join(' '));
    expect(messages.filter((message) => message.includes('same key'))).toEqual([]);

    instance.unmount();
  });
});

describe('collapsed tree rail', () => {
  const longName = 'a-file-name-long-enough-to-be-truncated-in-the-tree.ts';
  const fixture = () => buildFixture([
    {path: `src/${longName}`, rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: [`• src/${longName}:1: `, `${gutter(1)}b`]},
    {path: 'src/b.ts', rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: ['• src/b.ts:1: ', `${gutter(1)}b`]},
  ]);

  async function hoverTreeRows(instance: ReturnType<typeof renderFixture>, columns: number) {
    const seen: string[] = [];
    // Tree rows start on the fourth screen row (top bar, pane border, header).
    for (let row = 4; row < 8; row += 1) {
      for (let column = 1; column < columns; column += 1) {
        await emitMouseMoveAt(column, row);
        seen.push(frameLines(instance.lastFrame()).join('\n'));
      }
    }
    // The truncated-name tooltip appears after a short delay.
    await new Promise((resolve) => setTimeout(resolve, 350));
    seen.push(frameLines(instance.lastFrame()).join('\n'));
    return seen;
  }

  it('shows no row hints or tooltips over the collapsed rail', async () => {
    const instance = renderFixture(fixture(), {columns: 120, rows: 30});
    await flush();
    instance.stdin.write('t');
    await flush(2);
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('2 files');

    for (const frame of await hoverTreeRows(instance, 18)) {
      expect(frame).not.toContain('copies relative file path');
      expect(frame).not.toContain('file status');
      // The tooltip box draws the bare file name right after its border.
      expect(frame).not.toContain(`│ ${longName}`);
    }

    instance.unmount();
  });

  it('still shows the row hint over the open tree', async () => {
    const instance = renderFixture(fixture(), {columns: 120, rows: 30});
    await flush();

    const frames = await hoverTreeRows(instance, 32);
    expect(frames.some((frame) => frame.includes('copies relative file path'))).toBe(true);

    instance.unmount();
  });
});
