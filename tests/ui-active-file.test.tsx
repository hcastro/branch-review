import {describe, expect, it} from 'vitest';
import {
  buildFixture,
  cellPosition,
  emitMousePressAt,
  flush,
  frameLines,
  gutter,
  renderFixture,
} from './ui-fixtures.js';

// A file with no text diff (an empty file, a pure rename) can reach the app
// with a single blank line; it must still be a file the view can be on.
function withBlankFile() {
  return buildFixture([
    {path: 'a.txt', rawDiff: '@@ -1 +1 @@\n-a\n+alpha', rendered: ['• a.txt:1: ', `${gutter(1)}alpha`]},
    {path: 'empty.txt', rawDiff: '', rendered: []},
    {path: 'z.txt', rawDiff: '@@ -1 +1 @@\n-z\n+zulu', rendered: ['• z.txt:1: ', `${gutter(1)}zulu`]},
  ]);
}

function headerRow(frame: string | undefined) {
  return frameLines(frame)[4] ?? '';
}

// Presses a key and, given `expected`, waits for the frame that shows it. A
// loaded CI runner can take longer than a couple of event-loop turns to redraw.
async function press(instance: {stdin: {write: (data: string) => void}; lastFrame: () => string | undefined}, key: string, expected?: string) {
  instance.stdin.write(key);
  const deadline = Date.now() + 5_000;
  while (expected && Date.now() < deadline && !frameLines(instance.lastFrame()).join('\n').includes(expected)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await flush(2);
}

describe('a file whose only line is blank', () => {
  it('is reached by ↓ and ↑ in order', async () => {
    const instance = renderFixture(withBlankFile(), {columns: 120, rows: 30});
    await flush();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 1/3');

    await press(instance, '\u001B[B', 'file 2/3');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 2/3');
    expect(headerRow(instance.lastFrame())).toContain('empty.txt');

    await press(instance, '\u001B[B', 'file 3/3');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 3/3');

    await press(instance, '\u001B[A', 'file 2/3');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 2/3');
    expect(headerRow(instance.lastFrame())).toContain('empty.txt');

    await press(instance, '\u001B[A', 'file 1/3');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 1/3');

    instance.unmount();
  });

  it('is the file copied after clicking it in the tree', async () => {
    const writes: string[] = [];
    const instance = renderFixture(withBlankFile(), {columns: 120, rows: 30}, writes);
    await flush();

    const row = cellPosition(instance.lastFrame(), ['• empty.txt'], 'empty.txt');
    await emitMousePressAt(row.column, row.row);
    await flush(2);
    expect(headerRow(instance.lastFrame())).toContain('empty.txt');

    await press(instance, 'y');
    expect(writes).toEqual(['empty.txt']);

    instance.unmount();
  });

  it('still hands over to the next file from the blank line that ends a file', async () => {
    const data = buildFixture([
      {path: 'a.txt', rawDiff: '@@ -1 +1 @@\n-a\n+alpha', rendered: ['• a.txt:1: ', `${gutter(1)}alpha`]},
      {path: 'z.txt', rawDiff: '@@ -1 +1 @@\n-z\n+zulu', rendered: [`${gutter(1)}zulu`]},
    ]);
    const instance = renderFixture(data, {columns: 120, rows: 30});
    await flush();

    // a.txt draws 6 rows (a framed header and one code line) and a blank
    // line; with that blank line at the top, z.txt is the file in view.
    for (let index = 0; index < 6; index += 1) await press(instance, 'j');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 2/2');
    expect(headerRow(instance.lastFrame())).toContain('z.txt');

    instance.unmount();
  });
});
