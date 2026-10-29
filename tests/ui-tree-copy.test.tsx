import {describe, expect, it} from 'vitest';
import {buildFixture, cellPosition, emitMousePressAt, flush, frameLines, gutter, renderFixture} from './ui-fixtures.js';

// Copy tree lists every file by name. A file whose name is not valid UTF-8
// has only an escaped stand-in for a name, so Copy tree refuses the whole
// tree with that file's reason.

const NAME_ERROR = 'file name is not UTF-8';
// git's quoted form of the Latin-1 name `caf\xe9.txt`.
const UNNAMED = 'caf\\351.txt';

function fixture(withUnnamed: boolean) {
  const built = buildFixture([
    {path: 'src/ok.ts', rawDiff: '@@ -1 +1 @@\n-a\n+b\n', rendered: ['• src/ok.ts:1: ', `${gutter(1)}b`]},
    ...(withUnnamed ? [{path: UNNAMED, rawDiff: '', rendered: [], error: NAME_ERROR}] : []),
  ]);
  return {
    ...built,
    review: {
      ...built.review,
      files: built.review.files.map((file) => (file.path === UNNAMED
        ? {...file, rawDiffError: NAME_ERROR, pathError: NAME_ERROR}
        : file)),
    },
  };
}

const footer = (frame: string | undefined) => frameLines(frame).at(-2) ?? '';
const REFUSAL = `✗ Copy action unavailable. · ${NAME_ERROR}: ${UNNAMED}`;

describe('Copy tree with a file name that is not UTF-8', () => {
  it('refuses T with the reason and copies nothing', async () => {
    const writes: string[] = [];
    const instance = renderFixture(fixture(true), {columns: 140, rows: 30}, writes);
    await flush();

    instance.stdin.write('T');
    await flush(3);
    expect(footer(instance.lastFrame())).toContain(REFUSAL);
    expect(writes).toEqual([]);

    instance.unmount();
  });

  it('refuses the tree header button with the reason and copies nothing', async () => {
    const writes: string[] = [];
    const instance = renderFixture(fixture(true), {columns: 140, rows: 30}, writes);
    await flush();

    const button = cellPosition(instance.lastFrame(), ['Copy tree'], 'Copy tree', 2);
    await emitMousePressAt(button.column, button.row);
    await flush(3);
    expect(footer(instance.lastFrame())).toContain(REFUSAL);
    expect(footer(instance.lastFrame())).not.toContain('Copied file tree');
    expect(writes).toEqual([]);

    instance.unmount();
  });

  it('still copies the tree when every name is valid', async () => {
    const writes: string[] = [];
    const instance = renderFixture(fixture(false), {columns: 140, rows: 30}, writes);
    await flush();

    instance.stdin.write('T');
    await flush(3);
    expect(footer(instance.lastFrame())).toContain('✓ Copied file tree');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('└── ok.ts');

    instance.unmount();
  });
});
