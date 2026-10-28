import {describe, expect, it} from 'vitest';
import {renderDiffForDisplay} from '../src/git.js';
import {
  buildFixture,
  cellPosition,
  emitMouseDragAt,
  emitMousePressAt,
  flush,
  gutter,
  renderFixture,
  type FixtureFile,
} from './ui-fixtures.js';

// A drag-selection copies the file's bytes, not what the screen shows: a
// control character drawn as a marker copies as that one character, a tab
// drawn as spaces copies as one tab.

const RAW_LINES = [
  'hel\rlo',
  'crlf line\r',
  '\tworld();\u001B[31mred',
  'wide 日本 end',
  'literal ^M here',
  'plain',
];

// How delta draws a raw line: tabs as eight spaces, control characters as the
// visible markers the CLI feeds it.
function drawn(line: string) {
  return line
    .replaceAll('\t', ' '.repeat(8))
    .replaceAll('\r', '^M')
    .replaceAll('\u001B', '␛');
}

function bytesFixture(lines = RAW_LINES): FixtureFile {
  return {
    path: 'src/x.ts',
    rawDiff: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n'),
    rendered: ['• src/x.ts:1: ', ...lines.map((line, index) => `${gutter(index + 1)}${drawn(line)}`)],
  };
}

async function dragCopy(
  instance: ReturnType<typeof renderFixture>,
  from: {row: number; column: number},
  to: {row: number; column: number},
) {
  await emitMousePressAt(from.column, from.row);
  await emitMouseDragAt(to.column, to.row);
  await emitMouseDragAt(to.column, to.row, true);
  await flush(2);
}

describe('drag-select copies exact bytes', () => {
  it('copies whole lines with CR, CRLF, ESC and a tab as the raw lines', async () => {
    const writes: string[] = [];
    const instance = renderFixture(buildFixture([bytesFixture()]), {columns: 150, rows: 30}, writes);
    await flush();

    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['hel^Mlo'], 'hel^Mlo');
    const to = cellPosition(frame, ['world();␛[31mred'], 'red', 'red'.length - 1);
    await dragCopy(instance, from, to);

    expect(writes).toEqual(['hel\rlo\ncrlf line\r\n\tworld();\u001B[31mred']);

    instance.unmount();
  });

  it('copies one control character for a partly selected marker', async () => {
    const writes: string[] = [];
    const instance = renderFixture(buildFixture([bytesFixture()]), {columns: 150, rows: 30}, writes);
    await flush();

    // `l` and the `^` of `^M`.
    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['hel^Mlo'], 'l^M');
    await dragCopy(instance, from, {row: from.row, column: from.column + 1});

    expect(writes).toEqual(['l\r']);

    instance.unmount();
  });

  it('copies one tab for part of its spaces, and the ESC byte for its marker', async () => {
    const writes: string[] = [];
    const instance = renderFixture(buildFixture([bytesFixture()]), {columns: 150, rows: 30}, writes);
    await flush();

    // Three of the tab's eight spaces, then `world`.
    let frame = instance.lastFrame();
    const tabRow = cellPosition(frame, ['world();'], 'world');
    await dragCopy(instance, {row: tabRow.row, column: tabRow.column - 3}, {row: tabRow.row, column: tabRow.column + 'world'.length - 1});
    expect(writes).toEqual(['\tworld']);

    frame = instance.lastFrame();
    const escape = cellPosition(frame, ['world();'], '␛[31m');
    await dragCopy(instance, escape, {row: escape.row, column: escape.column + '␛[31m'.length - 1});
    expect(writes.at(-1)).toBe('\u001B[31m');

    instance.unmount();
  });

  it('copies a wide character whole when one of its cells is selected', async () => {
    const writes: string[] = [];
    const instance = renderFixture(buildFixture([bytesFixture()]), {columns: 150, rows: 30}, writes);
    await flush();

    // From the first cell of 日 to the first cell of 本.
    const wide = cellPosition(instance.lastFrame(), ['wide 日本 end'], '日本');
    await dragCopy(instance, wide, {row: wide.row, column: wide.column + 2});

    expect(writes).toEqual(['日本']);

    instance.unmount();
  });

  it('copies a literal ^M in the source as the two characters it is', async () => {
    const writes: string[] = [];
    const instance = renderFixture(buildFixture([bytesFixture()]), {columns: 150, rows: 30}, writes);
    await flush();

    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['literal ^M here'], 'literal');
    const to = cellPosition(frame, ['literal ^M here'], 'here', 'here'.length - 1);
    await dragCopy(instance, from, to);
    expect(writes).toEqual(['literal ^M here']);

    const caret = cellPosition(instance.lastFrame(), ['literal ^M here'], '^M');
    await dragCopy(instance, caret, {row: caret.row, column: caret.column + 1});
    expect(writes.at(-1)).toBe('^M');

    instance.unmount();
  });

  it('copies a wrapped line with a tab and a CR as one raw line', async () => {
    const writes: string[] = [];
    const long = `\tstart ${'word '.repeat(20)}end\r`;
    const instance = renderFixture(buildFixture([bytesFixture([long, 'next'])]), {columns: 90, rows: 30}, writes);
    await flush();

    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['start word'], 'start', -8);
    const to = cellPosition(frame, ['end^M'], 'end^M', 'end^M'.length - 1);
    expect(to.row).toBeGreaterThan(from.row);
    await dragCopy(instance, from, to);

    expect(writes).toEqual([long]);

    instance.unmount();
  });

  it('copies a fully selected line whole, a trailing zero-width character included', async () => {
    const writes: string[] = [];
    // drawn() leaves U+200B as it is, so it takes no cell at the end of the row.
    const instance = renderFixture(buildFixture([bytesFixture(['last word\u200B', 'next'])]), {columns: 150, rows: 30}, writes);
    await flush();

    const from = cellPosition(instance.lastFrame(), ['last word'], 'last word');
    await dragCopy(instance, from, {row: from.row, column: from.column + 'last word'.length - 1});

    expect(writes).toEqual(['last word\u200B']);

    instance.unmount();
  });

  it('maps a character delta drew as itself, even one the app would mark', async () => {
    const writes: string[] = [];
    // U+202E (a bidi control the app marks on screen) drawn as itself, then
    // a tab: the tab only lines up if the control was matched as drawn.
    const instance = renderFixture(buildFixture([bytesFixture(['a\u202Eb\tc', 'next'])]), {columns: 150, rows: 30}, writes);
    await flush();

    const from = cellPosition(instance.lastFrame(), ['        c'], 'a');
    const to = cellPosition(instance.lastFrame(), ['        c'], '        c', 8);
    await dragCopy(instance, from, to);

    expect(writes).toEqual(['a\u202Eb\tc']);

    instance.unmount();
  });

  it('copies the drawn text when the drawn rows do not match the hunk', async () => {
    const writes: string[] = [];
    // One raw line, two drawn rows: no row gets a raw line.
    const mismatched: FixtureFile = {
      path: 'src/x.ts',
      rawDiff: '@@ -0,0 +1,1 @@\n+only\tline',
      rendered: ['• src/x.ts:1: ', `${gutter(1)}first row`, `${gutter(2)}second row`],
    };
    const instance = renderFixture(buildFixture([mismatched]), {columns: 150, rows: 30}, writes);
    await flush();

    const from = cellPosition(instance.lastFrame(), ['first row'], 'first row');
    await dragCopy(instance, from, {row: from.row, column: from.column + 'first row'.length - 1});

    expect(writes).toEqual(['first row']);

    instance.unmount();
  });
});

describe('drag-select over real delta output', () => {
  it('copies CRLF and tab lines as their raw bytes', async () => {
    const lines = ['crlf line\r', '\tindented();', 'plain'];
    const rawDiff = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
    const patch = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${rawDiff}\n`;
    const rendered = renderDiffForDisplay(process.cwd(), patch, 120).split('\n').filter(Boolean);
    const writes: string[] = [];
    const instance = renderFixture(buildFixture([{path: 'src/x.ts', rawDiff, rendered}]), {columns: 150, rows: 30}, writes);
    await flush();

    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['crlf line^M'], 'crlf line^M');
    const to = cellPosition(frame, ['plain'], 'plain', 'plain'.length - 1);
    await dragCopy(instance, from, to);

    expect(writes).toEqual(['crlf line\r\n\tindented();\nplain']);

    instance.unmount();
  });
});
