import {describe, expect, it} from 'vitest';
import {escapeHiddenCharactersInLines} from '../src/controlChars.js';
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

// How delta draws a raw line: hidden characters as the visible markers the
// CLI feeds it (^M, ␛, <U+200B>), then tabs as eight spaces.
function drawn(line: string) {
  return escapeHiddenCharactersInLines(line).replaceAll('\t', ' '.repeat(8));
}

// A hunk shaped the way git writes it: a trailing newline, and a
// `\ No newline at end of file` line after the last line, which delta draws
// as a row of its own with no gutter.
function bytesFixture(lines = RAW_LINES): FixtureFile {
  const noNewline = '\\ No newline at end of file';
  return {
    path: 'src/x.ts',
    rawDiff: `${[`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), noNewline].join('\n')}\n`,
    rendered: ['• src/x.ts:1: ', ...lines.map((line, index) => `${gutter(index + 1)}${drawn(line)}`), noNewline],
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

  it('copies a trailing zero-width character drawn as its marker as the one character', async () => {
    const writes: string[] = [];
    const instance = renderFixture(buildFixture([bytesFixture(['last word\u200B', 'next'])]), {columns: 150, rows: 30}, writes);
    await flush();

    // The whole row, past the end of the marker into the empty cells after it.
    const from = cellPosition(instance.lastFrame(), ['last word<U+200B>'], 'last word');
    const marker = cellPosition(instance.lastFrame(), ['last word<U+200B>'], '<U+200B>');
    await dragCopy(instance, from, {row: from.row, column: marker.column + '<U+200B>'.length + 4});
    expect(writes).toEqual(['last word\u200B']);

    // Part of the marker alone.
    await dragCopy(instance, {row: marker.row, column: marker.column + 1}, {row: marker.row, column: marker.column + 3});
    expect(writes.at(-1)).toBe('\u200B');

    instance.unmount();
  });

  it('maps a bidi control drawn as its marker, then a tab, back to the raw line', async () => {
    const writes: string[] = [];
    // The tab only lines up if the marker was matched as one character.
    const instance = renderFixture(buildFixture([bytesFixture(['a\u202Eb\tc', 'next'])]), {columns: 150, rows: 30}, writes);
    await flush();

    const from = cellPosition(instance.lastFrame(), ['a<U+202E>b        c'], 'a<U+202E>');
    const to = cellPosition(instance.lastFrame(), ['a<U+202E>b        c'], '        c', 8);
    await dragCopy(instance, from, to);
    expect(writes).toEqual(['a\u202Eb\tc']);

    await dragCopy(instance, {row: from.row, column: from.column + 1}, {row: from.row, column: from.column + 2});
    expect(writes.at(-1)).toBe('\u202E');

    instance.unmount();
  });

  it('copies the drawn text when the drawn rows do not match the hunk', async () => {
    const writes: string[] = [];
    // One raw line, two drawn rows: no row gets a raw line, even the first,
    // whose drawn text would line up with it.
    const mismatched: FixtureFile = {
      path: 'src/x.ts',
      rawDiff: '@@ -0,0 +1,1 @@\n+first\trow\n',
      rendered: ['• src/x.ts:1: ', `${gutter(1)}first        row`, `${gutter(2)}second row`],
    };
    const instance = renderFixture(buildFixture([mismatched]), {columns: 150, rows: 30}, writes);
    await flush();

    const from = cellPosition(instance.lastFrame(), ['first        row'], 'first');
    await dragCopy(instance, from, {row: from.row, column: from.column + 'first        row'.length - 1});

    expect(writes).toEqual(['first        row']);

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

  it('copies CR, tab and no-newline lines as their raw bytes', async () => {
    // A removed last line and a new last line, each without a final newline.
    const rawDiff = '@@ -1 +1,3 @@\n-old\n\\ No newline at end of file\n+a\r\n+b\r\n+c\tx\r\n\\ No newline at end of file\n';
    const patch = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${rawDiff}`;
    const rendered = renderDiffForDisplay(process.cwd(), patch, 120).split('\n').filter(Boolean);
    expect(rendered.filter((line) => line.includes('No newline at end of file'))).toHaveLength(2);
    const writes: string[] = [];
    const instance = renderFixture(buildFixture([{path: 'src/x.ts', rawDiff, rendered}]), {columns: 150, rows: 30}, writes);
    await flush();

    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['│a^M'], 'a^M');
    const to = cellPosition(frame, ['x^M'], 'x^M', 'x^M'.length - 1);
    await dragCopy(instance, from, to);

    expect(writes).toEqual(['a\r\nb\r\nc\tx\r']);

    instance.unmount();
  });
});
