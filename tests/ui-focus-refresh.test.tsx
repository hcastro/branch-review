import {describe, expect, it} from 'vitest';
import {
  appElement,
  buildFixture,
  flush,
  frameLines,
  gutter,
  multiBlockFile,
  recordingWriter,
  renderFixture,
  type FixtureFile,
} from './ui-fixtures.js';

// A block focused with [ or ] stays focused only while its header row is
// where it was focused. A refresh that moves the header (a hunk above it
// shrank, grew or went away) hands focus to the block at the top of the
// viewport, so the mark and the keys always act on a block on screen.

const FOCUS_BAR = '┃';
// Screen rows: top bar (3), diff pane border, file row, metrics row, then
// the first diff row.
const FIRST_DIFF_ROW = 6;
const DIMENSIONS = {columns: 120, rows: 30};

function file(path: string, hunks: Array<{start: number; size: number; tag: string}>): FixtureFile {
  const raw: string[] = [];
  const rendered: string[] = [];
  for (const {start, size, tag} of hunks) {
    raw.push(`@@ -${start},0 +${start},${size} @@`);
    rendered.push(`• ${path}:${start}: `);
    for (let index = 0; index < size; index += 1) {
      raw.push(`+${tag}-${index}`);
      rendered.push(`${gutter(start + index)}${tag}-${index}`);
    }
  }
  return {path, rawDiff: raw.join('\n'), rendered};
}

// Blocks A (optional, `aSize` lines), B and C in one file, then a long second
// file so the view can scroll any header to the top.
function fixture(aSize: number | null) {
  return buildFixture([
    file('src/one.ts', [
      ...(aSize === null ? [] : [{start: 1, size: aSize, tag: 'AAA'}]),
      {start: 101, size: 6, tag: 'BBB'},
      {start: 200, size: 30, tag: 'CCC'},
    ]),
    file('src/two.ts', [{start: 5, size: 40, tag: 'TWO'}]),
  ]);
}

function blockCode(built: ReturnType<typeof fixture>, start: number) {
  return built.review.files[0]!.blocks.find((block) => block.lineStart === start)!.addedCode;
}

function markedRows(frame: string | undefined) {
  return frameLines(frame).filter((line) => line.includes(FOCUS_BAR));
}

async function press(instance: {stdin: {write: (data: string) => void}}, input: string) {
  instance.stdin.write(input);
  await flush(2);
}

async function focusBThenRefresh(next: ReturnType<typeof fixture>, writes: string[]) {
  const instance = renderFixture(fixture(15), DIMENSIONS, writes);
  await flush();
  await press(instance, ']');
  expect(markedRows(instance.lastFrame())).toHaveLength(1);
  expect(markedRows(instance.lastFrame())[0]).toContain('src/one.ts:101:');

  instance.rerender(appElement(next, DIMENSIONS, recordingWriter(writes)));
  await flush(3);
  return instance;
}

describe('block focus after a refresh moves the focused header', () => {
  it('falls back to the block at the top when a hunk above goes away', async () => {
    const writes: string[] = [];
    const next = fixture(null);
    const instance = await focusBThenRefresh(next, writes);

    // B moved up out of view; C's body opens the viewport and takes the mark.
    const lines = frameLines(instance.lastFrame());
    expect(lines.join('\n')).not.toContain('BBB-');
    expect(markedRows(instance.lastFrame())).toHaveLength(1);
    expect(lines[FIRST_DIFF_ROW]).toContain(`${FOCUS_BAR}  204 ⋮ 204 │CCC-4`);

    await press(instance, 'c');
    await flush(2);
    expect(writes).toEqual([blockCode(next, 200)]);

    instance.unmount();
  });

  it('falls back to the block at the top when a hunk above grows', async () => {
    const writes: string[] = [];
    const next = fixture(30);
    const instance = await focusBThenRefresh(next, writes);

    // B's header moved down the screen; A's body opens the viewport.
    const lines = frameLines(instance.lastFrame());
    expect(lines[FIRST_DIFF_ROW]).toContain(`${FOCUS_BAR}   16 ⋮  16 │AAA-15`);
    expect(markedRows(instance.lastFrame())).toHaveLength(1);
    expect(lines.find((line) => line.includes('src/one.ts:101:'))).not.toContain(FOCUS_BAR);

    await press(instance, 'c');
    await flush(2);
    expect(writes).toEqual([blockCode(next, 1)]);

    instance.unmount();
  });
});

describe('block focus while the focused header stays in place', () => {
  // Three one-line blocks: the scroll ceiling keeps the last header off the
  // top, so only the recorded focus keeps it focused.
  const shortFile = () => buildFixture([multiBlockFile('src/one.ts', [10, 20, 30], 1)]);

  async function focusLastBlock(writes: string[]) {
    const instance = renderFixture(shortFile(), DIMENSIONS, writes);
    await flush();
    await press(instance, ']');
    await press(instance, ']');
    expect(markedRows(instance.lastFrame())).toHaveLength(1);
    expect(markedRows(instance.lastFrame())[0]).toContain('src/one.ts:30:');
    return instance;
  }

  it('keeps the focus through a refresh that leaves the header where it was', async () => {
    const writes: string[] = [];
    const instance = await focusLastBlock(writes);

    instance.rerender(appElement(shortFile(), DIMENSIONS, recordingWriter(writes)));
    await flush(3);
    expect(markedRows(instance.lastFrame())).toHaveLength(1);
    expect(markedRows(instance.lastFrame())[0]).toContain('src/one.ts:30:');

    await press(instance, 'c');
    await flush(2);
    expect(writes).toEqual(['src/one.ts-h2-0']);

    instance.unmount();
  });

  // The same three one-line blocks, by tag, so a refresh can change one.
  const taggedFile = (hunks: Array<{start: number; size: number; tag: string}>) => buildFixture([file('src/one.ts', hunks)]);

  async function focusLastTagged(writes: string[]) {
    const instance = renderFixture(
      taggedFile([{start: 10, size: 1, tag: 'P'}, {start: 20, size: 1, tag: 'Q'}, {start: 30, size: 1, tag: 'R'}]),
      DIMENSIONS,
      writes,
    );
    await flush();
    await press(instance, ']');
    await press(instance, ']');
    expect(markedRows(instance.lastFrame())).toHaveLength(1);
    expect(markedRows(instance.lastFrame())[0]).toContain('src/one.ts:30:');
    return instance;
  }

  it('drops the focus when a refresh puts another block\'s header on the focused row', async () => {
    const writes: string[] = [];
    const instance = await focusLastTagged(writes);

    // Row 4 is still a header, but of a block with other content.
    const next = taggedFile([{start: 10, size: 1, tag: 'P'}, {start: 20, size: 1, tag: 'Q'}, {start: 30, size: 1, tag: 'S'}]);
    instance.rerender(appElement(next, DIMENSIONS, recordingWriter(writes)));
    await flush(3);
    expect(markedRows(instance.lastFrame())).toHaveLength(1);
    expect(markedRows(instance.lastFrame())[0]).toContain('src/one.ts:10:');

    await press(instance, 'c');
    await flush(2);
    expect(writes).toEqual(['P-0']);

    instance.unmount();
  });

  it('drops the focus when a refresh puts a body row of the focused block on the focused row', async () => {
    const writes: string[] = [];
    const instance = await focusLastTagged(writes);
    const headerRow = frameLines(instance.lastFrame()).findIndex((line) => line.includes('src/one.ts:30:'));

    // The focused block keeps its content, so its key, but its header moves
    // up and its body row lands on the row the header held. A block draws
    // its header three rows above its first body row, so four lines in P
    // and Q gone put R's body row exactly there.
    const next = taggedFile([{start: 10, size: 4, tag: 'P'}, {start: 30, size: 1, tag: 'R'}]);
    instance.rerender(appElement(next, DIMENSIONS, recordingWriter(writes)));
    await flush(3);
    expect(frameLines(instance.lastFrame())[headerRow]).toContain('R-0');
    expect(markedRows(instance.lastFrame())).toHaveLength(1);
    expect(markedRows(instance.lastFrame())[0]).toContain('src/one.ts:10:');

    await press(instance, 'c');
    await flush(2);
    expect(writes).toEqual(['P-0\nP-1\nP-2\nP-3']);

    instance.unmount();
  });

  it('collapses and expands the same block on Enter twice', async () => {
    const instance = await focusLastBlock([]);

    await press(instance, '\r');
    let frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('▸ src/one.ts:30:');
    expect(frame).not.toContain('src/one.ts-h2-0');
    expect(markedRows(instance.lastFrame())[0]).toContain('▸ src/one.ts:30:');

    await press(instance, '\r');
    frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('▾ src/one.ts:30:');
    expect(frame).toContain('src/one.ts-h2-0');
    expect(frame).not.toContain('▸');
    expect(markedRows(instance.lastFrame())[0]).toContain('▾ src/one.ts:30:');

    instance.unmount();
  });
});
