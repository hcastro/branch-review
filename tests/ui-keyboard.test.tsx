import {describe, expect, it} from 'vitest';
import {buildBlockPromptPayload} from '../src/clipboard/payloads.js';
import {
  buildFixture,
  flush,
  frameLines,
  multiBlockFile,
  recordingWriter,
  renderFixture,
  type FixtureFile,
} from './ui-fixtures.js';
import {render} from 'ink-testing-library';
import {appElement} from './ui-fixtures.js';

// The focused block's header row is drawn with heavy side bars.
const FOCUS_BAR = '┃';

function keyboardFixture(files: FixtureFile[] = [
  multiBlockFile('src/one.ts', [10, 40], 6),
  multiBlockFile('src/two.ts', [5], 3),
]) {
  const fixture = buildFixture(files);
  return {
    ...fixture,
    readFileContent: (file: {path: string}) => `contents of ${file.path}`,
    resolveAbsolutePath: (file: {path: string}) => `/repo/${file.path}`,
  };
}

function focusedHeader(frame: string | undefined) {
  return frameLines(frame).filter((line) => line.includes(`${FOCUS_BAR} `));
}

async function press(instance: {stdin: {write: (data: string) => void}}, input: string) {
  instance.stdin.write(input);
  await flush(2);
}

describe('keyboard block navigation', () => {
  it('marks the block at the top of the viewport and moves with [ and ]', async () => {
    const instance = renderFixture(keyboardFixture(), {columns: 120, rows: 30});
    await flush();

    expect(focusedHeader(instance.lastFrame())).toHaveLength(1);
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:10:');

    await press(instance, ']');
    let lines = frameLines(instance.lastFrame());
    expect(focusedHeader(instance.lastFrame())).toHaveLength(1);
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:40:');
    // The block's frame starts the diff viewport, right under the two header rows.
    expect(lines.findIndex((line) => line.includes('src/one.ts:40:'))).toBe(8);

    await press(instance, ']');
    lines = frameLines(instance.lastFrame());
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/two.ts:5:');
    expect(lines.join('\n')).toContain('file 2/2');

    await press(instance, ']');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/two.ts:5:');

    await press(instance, '[');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:40:');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 1/2');

    await press(instance, '[');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:10:');

    instance.unmount();
  });

  it('focuses a block near the end even when the view cannot scroll its header to the top', async () => {
    const writes: string[] = [];
    const instance = renderFixture(keyboardFixture([
      multiBlockFile('src/one.ts', [10, 20, 30], 1),
    ]), {columns: 120, rows: 40}, writes);
    await flush();

    await press(instance, ']');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:20:');
    await press(instance, ']');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:30:');

    await press(instance, 'c');
    await flush(2);
    expect(writes).toEqual(['src/one.ts-h2-0']);

    // Any other scroll hands focus back to the block at the top of the view.
    await press(instance, 'g');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:10:');

    instance.unmount();
  });

  it('collapses and expands the focused block with Enter and Space', async () => {
    const instance = renderFixture(keyboardFixture(), {columns: 120, rows: 30});
    await flush();

    await press(instance, ']');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('src/one.ts-h1-0');

    await press(instance, '\r');
    let frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).not.toContain('src/one.ts-h1-0');
    expect(frame).toContain('▸ src/one.ts:40:');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:40:');

    await press(instance, '\r');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('src/one.ts-h1-0');

    await press(instance, ' ');
    expect(frameLines(instance.lastFrame()).join('\n')).not.toContain('src/one.ts-h1-0');
    await press(instance, ' ');
    frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('src/one.ts-h1-0');
    expect(frame).toContain('▾ src/one.ts:40:');

    instance.unmount();
  });

  it('shows a short key hint in the footer', async () => {
    const instance = renderFixture(keyboardFixture(), {columns: 120, rows: 30});
    await flush();

    const footer = frameLines(instance.lastFrame()).at(-2) ?? '';
    expect(footer).toContain('[/] block');
    expect(footer).toContain('t tree');

    instance.unmount();
  });
});

describe('keyboard copy', () => {
  const expected = (fixture: ReturnType<typeof keyboardFixture>) => {
    const one = fixture.review.files[0]!;
    const block = one.blocks[1]!;
    return {one, block};
  };

  for (const [key, label, payload] of [
    ['y', 'path', () => 'src/one.ts'],
    ['Y', 'absolute path', () => '/repo/src/one.ts'],
    ['d', 'file diff', (fixture: ReturnType<typeof keyboardFixture>) => expected(fixture).one.rawDiff],
    ['f', 'file contents', () => 'contents of src/one.ts'],
    ['c', 'block code', (fixture: ReturnType<typeof keyboardFixture>) => expected(fixture).block.addedCode],
    ['p', 'block diff', (fixture: ReturnType<typeof keyboardFixture>) => expected(fixture).block.rawDiff],
    ['b', 'block with context', (fixture: ReturnType<typeof keyboardFixture>) => buildBlockPromptPayload(expected(fixture).one, expected(fixture).block)],
  ] as const) {
    it(`copies the ${label} with ${key}`, async () => {
      const fixture = keyboardFixture();
      const writes: string[] = [];
      const instance = renderFixture(fixture, {columns: 120, rows: 30}, writes);
      await flush();

      await press(instance, ']');
      await press(instance, key);
      await flush(2);

      expect(writes).toEqual([payload(fixture)]);
      expect(frameLines(instance.lastFrame()).at(-2)).toContain('✓ Copied');

      instance.unmount();
    });
  }

  it('copies the block that is focused, not the first one', async () => {
    const fixture = keyboardFixture();
    const writes: string[] = [];
    const instance = renderFixture(fixture, {columns: 120, rows: 30}, writes);
    await flush();

    await press(instance, 'c');
    await press(instance, ']');
    await press(instance, 'c');
    await flush(2);

    expect(writes).toEqual([fixture.review.files[0]!.blocks[0]!.addedCode, fixture.review.files[0]!.blocks[1]!.addedCode]);

    instance.unmount();
  });

  it('copies the tree with T', async () => {
    const writes: string[] = [];
    const instance = renderFixture(keyboardFixture(), {columns: 120, rows: 30}, writes);
    await flush();

    await press(instance, 'T');
    await flush(2);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('one.ts');
    expect(writes[0]).toContain('two.ts');
    expect(frameLines(instance.lastFrame()).at(-2)).toContain('✓ Copied file tree');

    instance.unmount();
  });

  it('toggles the tree pane with t', async () => {
    const instance = renderFixture(keyboardFixture(), {columns: 120, rows: 30});
    await flush();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('Changed files');

    await press(instance, 't');
    let frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).not.toContain('Changed files');
    expect(frame).toContain('2 files');

    await press(instance, 't');
    frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('Changed files');

    instance.unmount();
  });

  it('keeps the existing keys', async () => {
    const instance = renderFixture(keyboardFixture(), {columns: 120, rows: 30});
    await flush();

    await press(instance, '\u001B[B');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 2/2');
    await press(instance, 'g');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 1/2');

    instance.unmount();
  });
});

describe('collapse state across refreshes', () => {
  it('keeps a block collapsed when an edit above moves its start line', async () => {
    const writes: string[] = [];
    const instance = render(appElement(keyboardFixture([multiBlockFile('src/one.ts', [10, 40], 6)]), {columns: 120, rows: 30}, recordingWriter(writes)));
    await flush();

    await press(instance, ']');
    await press(instance, '\r');
    expect(frameLines(instance.lastFrame()).join('\n')).not.toContain('src/one.ts-h1-0');

    instance.rerender(appElement(keyboardFixture([multiBlockFile('src/one.ts', [11, 41], 6)]), {columns: 120, rows: 30}, recordingWriter(writes)));
    await flush(2);

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('src/one.ts:41:');
    expect(frame).not.toContain('src/one.ts-h1-0');
    expect(frame).toContain('src/one.ts-h0-0');

    instance.unmount();
  });

  it('collapses only the chosen one of two identical blocks', async () => {
    const identical: FixtureFile = {
      path: 'src/same.ts',
      rawDiff: '@@ -10,0 +10,1 @@\n+same line\n@@ -40,0 +40,1 @@\n+same line',
      rendered: ['• src/same.ts:10: ', '  10 ⋮  10 │same line', '• src/same.ts:40: ', '  40 ⋮  40 │same line'],
    };
    const instance = render(appElement(keyboardFixture([identical]), {columns: 120, rows: 30}, recordingWriter([])));
    await flush();

    await press(instance, ']');
    await press(instance, '\r');
    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('▾ src/same.ts:10:');
    expect(frame).toContain('▸ src/same.ts:40:');
    expect(frame.match(/same line/g)).toHaveLength(1);

    instance.unmount();
  });
});
