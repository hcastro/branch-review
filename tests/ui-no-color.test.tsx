import {describe, expect, it, vi} from 'vitest';

// The palette and chalk read the environment when first imported. Turn on
// NO_COLOR, and force chalk colour so a leaked Ink colour prop would show,
// before any import of the app.
const previousEnv = vi.hoisted(() => {
  const previous = {NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR};
  process.env.NO_COLOR = '1';
  process.env.FORCE_COLOR = '3';
  return previous;
});

const {
  buildFixture,
  cellPosition,
  emitMouseDragAt,
  emitMouseMoveAt,
  emitMousePressAt,
  flush,
  frameLines,
  renderFixture,
} = await import('./ui-fixtures.js');

for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// SGR parameters that only set attributes (reset, bold, dim, inverse and
// their resets), never a colour.
const ATTRIBUTE_ONLY = new Set(['', '0', '1', '2', '7', '22', '27']);

function colourCodes(frame: string) {
  return [...frame.matchAll(/\u001B\[([0-9;:]*)m/g)]
    .map((match) => match[1]!)
    .filter((params) => params.split(/[;:]/).some((param) => !ATTRIBUTE_ONLY.has(param)));
}

// Delta's plain output under NO_COLOR: no SGR, and +/- markers kept after the
// gutter bar.
function plainFixture() {
  return buildFixture([{
    path: 'src/plain.ts',
    rawDiff: '@@ -1,2 +1,2 @@ function plain()\n-const a = 0;\n+const a = 1;\n context line',
    rendered: [
      '• src/plain.ts:1: function plain()',
      '   1 ⋮     │-const a = 0;',
      '     ⋮   1 │+const a = 1;',
      '   2 ⋮   2 │ context line',
    ],
  }, {
    path: 'src/other.ts',
    rawDiff: '@@ -1 +1 @@\n-x\n+y',
    rendered: ['• src/other.ts:1: ', '   1 ⋮     │-x', '     ⋮   1 │+y'],
  }]);
}

describe('NO_COLOR', () => {
  it('draws the whole app without colour codes', async () => {
    const writes: string[] = [];
    const instance = renderFixture(plainFixture(), {columns: 120, rows: 24}, writes);
    await flush();

    // Hover a file action and a block action, and copy, so hover, focus and
    // success styles are all on screen.
    const frame = instance.lastFrame();
    const copyDiff = cellPosition(frame, ['Copy path', 'Copy diff'], 'Copy diff', 1);
    await emitMouseMoveAt(copyDiff.column, copyDiff.row);
    await emitMousePressAt(copyDiff.column, copyDiff.row);
    await flush(2);

    const after = instance.lastFrame() ?? '';
    expect(writes).toHaveLength(1);
    expect(frameLines(after).join('\n')).toContain('✓ Copied file diff');
    expect(colourCodes(after)).toEqual([]);

    instance.unmount();
  });

  it('keeps a visible selection highlight without colour', async () => {
    const instance = renderFixture(plainFixture(), {columns: 120, rows: 24});
    await flush();

    const start = cellPosition(instance.lastFrame(), ['const a = 1;'], 'const a = 1;');
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(start.column + 4, start.row);
    await flush(3);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('\u001B[7m');
    expect(colourCodes(frame)).toEqual([]);

    instance.unmount();
  });

  it('copies selected code without the +/- markers delta keeps after the gutter', async () => {
    const writes: string[] = [];
    const instance = renderFixture(plainFixture(), {columns: 120, rows: 24}, writes);
    await flush();

    const frame = instance.lastFrame();
    // Press on the marker column itself: the selection starts at the code.
    const start = cellPosition(frame, ['const a = 1;'], '+const a = 1;');
    const end = cellPosition(frame, ['context line'], 'context line', 'context line'.length - 1);
    await emitMousePressAt(start.column + 1, start.row);
    await emitMouseDragAt(end.column, end.row);
    await emitMouseDragAt(end.column, end.row, true);
    await flush(3);

    expect(writes).toEqual(['const a = 1;\ncontext line']);

    instance.unmount();
  });

  it('copies a deleted line selected from its marker without the marker', async () => {
    const writes: string[] = [];
    const instance = renderFixture(plainFixture(), {columns: 120, rows: 24}, writes);
    await flush();

    const frame = instance.lastFrame();
    const start = cellPosition(frame, ['const a = 0;'], '-const a = 0;');
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(start.column + '-const a = 0;'.length - 1, start.row);
    await emitMouseDragAt(start.column + '-const a = 0;'.length - 1, start.row, true);
    await flush(3);

    expect(writes).toEqual(['const a = 0;']);

    instance.unmount();
  });

  it('copies the raw bytes of CRLF and tab lines from real plain delta output', async () => {
    const {renderDiffForDisplay} = await import('../src/git.js');
    const lines = ['crlf line\r', '\tindented();'];
    const rawDiff = ['@@ -0,0 +1,2 @@', ...lines.map((line) => `+${line}`)].join('\n');
    const patch = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${rawDiff}\n`;
    // delta reads the colour rule when it runs; render it the way the app was set up.
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    let rendered: string[];
    try {
      rendered = renderDiffForDisplay(process.cwd(), patch, 120).split('\n').filter(Boolean);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
    expect(rendered.join('\n')).toContain('│+crlf line^M');

    const writes: string[] = [];
    const instance = renderFixture(buildFixture([{path: 'src/x.ts', rawDiff, rendered}]), {columns: 150, rows: 30}, writes);
    await flush();

    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['crlf line^M'], 'crlf line^M');
    const to = cellPosition(frame, ['indented();'], 'indented();', 'indented();'.length - 1);
    await emitMousePressAt(from.column, from.row);
    await emitMouseDragAt(to.column, to.row);
    await emitMouseDragAt(to.column, to.row, true);
    await flush(2);

    expect(writes).toEqual(['crlf line\r\n\tindented();']);

    instance.unmount();
  });

  it('parses plain block headers so block copy still works', async () => {
    const writes: string[] = [];
    const fixture = plainFixture();
    const instance = renderFixture(fixture, {columns: 120, rows: 24}, writes);
    await flush();

    instance.stdin.write('c');
    await flush(3);

    expect(writes).toEqual([fixture.review.files[0]!.blocks[0]!.addedCode]);

    instance.unmount();
  });
});
