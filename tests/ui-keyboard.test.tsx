import {describe, expect, it} from 'vitest';
import {buildBlockPromptPayload} from '../src/clipboard/payloads.js';
import {
  buildFixture,
  cellPosition,
  emitMousePressAt,
  flush,
  frameLines,
  multiBlockFile,
  recordingWriter,
  renderFixture,
  type FixtureFile,
} from './ui-fixtures.js';
import {render} from 'ink-testing-library';
import {appElement, renderOnTerminal} from './ui-fixtures.js';

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

describe('quitting', () => {
  // Ink reports Esc with `meta` set, so quit keys are checked before the
  // guard that ignores modified keys.
  for (const [name, key] of [['q', 'q'], ['Esc', '\u001B']] as const) {
    it(`quits on ${name}`, async () => {
      const instance = renderOnTerminal(keyboardFixture(), 120, 30);
      await flush();
      let exited = false;
      void instance.waitUntilExit().then(() => {
        exited = true;
      });

      instance.stdin.write(key);
      await flush(3);

      expect(exited).toBe(true);
      instance.unmount();
    });
  }

  it('does not quit on Alt-q or Ctrl-q', async () => {
    const instance = renderOnTerminal(keyboardFixture(), 120, 30);
    await flush();
    let exited = false;
    void instance.waitUntilExit().then(() => {
      exited = true;
    });

    instance.stdin.write('\u001Bq');
    await flush(2);
    instance.stdin.write('\u0011');
    await flush(3);

    expect(exited).toBe(false);
    instance.unmount();
  });
});

describe('keys while the terminal is too small', () => {
  it('ignores copy, scroll and tree keys while "Terminal too small" is shown', async () => {
    const writes: string[] = [];
    const instance = renderOnTerminal(keyboardFixture(), 50, 24, writes);
    await flush();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('Terminal too small');

    for (const key of ['y', 'Y', 'd', 'f', 'c', 'p', 'b', 'T', 't', 'j', ']', '\r', '\u001B[B']) {
      instance.stdin.write(key);
      await flush(2);
    }
    expect(writes).toEqual([]);

    instance.resize(120, 30);
    await flush(2);
    const frame = frameLines(instance.lastFrame()).join('\n');
    // `t` did not collapse the tree, `]` and `↓` did not move the view.
    expect(frame).toContain('Changed files');
    expect(frame).toContain('file 1/2');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:10:');

    instance.unmount();
  });

  for (const [name, key] of [['q', 'q'], ['Esc', '\u001B']] as const) {
    it(`still quits on ${name} while "Terminal too small" is shown`, async () => {
      const instance = renderOnTerminal(keyboardFixture(), 50, 24);
      await flush();
      let exited = false;
      void instance.waitUntilExit().then(() => {
        exited = true;
      });

      instance.stdin.write(key);
      await flush(3);

      expect(exited).toBe(true);
      instance.unmount();
    });
  }
});

describe('footer key hint', () => {
  const HINT_ITEMS = ['q quit', '↑/↓ jump file', 'j/k scroll', '[/] block', '⏎ fold', 'y d f c p b copy', 't tree'];

  // The footer row's text inside its border, without the right-hand range
  // label (`development...HEAD`, possibly cut from the start).
  function footerText(frame: string) {
    const footer = frameLines(frame).at(-2) ?? '';
    return footer.replace(/^│ /, '').replace(/ *│$/, '').replace(/ +…?[^ ]*\.\.\.HEAD$/, '').trimEnd();
  }

  // The hint part is whole items from the start of the list: it may drop
  // items from the end, never cut one.
  function expectWholeHint(hint: string) {
    const items = hint.split(' • ');
    expect(items).toEqual(HINT_ITEMS.slice(0, items.length));
  }

  for (const columns of [58, 80, 120]) {
    it(`leads with q quit and drops whole hints at ${columns} columns`, async () => {
      const instance = renderOnTerminal(keyboardFixture(), columns, 30);
      await flush();

      const text = footerText(instance.lastFrame());
      expect(text.startsWith('q quit')).toBe(true);
      expectWholeHint(text);
      if (columns === 120) expect(text).toBe(HINT_ITEMS.join(' • '));

      instance.unmount();
    });

    for (const status of ['watch error: git exploded', 'watch error: refresh worker exited with code 3']) {
      it(`keeps the whole status "${status}" and q quit at ${columns} columns`, async () => {
        const instance = renderOnTerminal({...keyboardFixture(), watchStatus: status}, columns, 30);
        await flush();

        const text = footerText(instance.lastFrame());
        // The footer row holds `columns - 4` cells inside its border and padding.
        if (`${status} • q quit`.length <= columns - 4) {
          expect(text.startsWith(`${status} • q quit`)).toBe(true);
          expectWholeHint(text.slice(status.length + ' • '.length));
        } else {
          // No room for both: the status keeps its reason.
          expect(text).toBe(status);
        }

        instance.unmount();
      });
    }
  }
});

describe('focus inside a long block', () => {
  // Screen rows: top bar (3), diff pane border, file row, metrics row, then
  // the first diff row.
  const FIRST_DIFF_ROW = 6;

  it('marks the top row when the focused block\'s header has scrolled off', async () => {
    const writes: string[] = [];
    const fixture = keyboardFixture();
    const instance = renderFixture(fixture, {columns: 120, rows: 30}, writes);
    await flush();

    // Header frame (5 rows) plus one body row scrolled away: the top row is
    // the second body row of block 0.
    for (let index = 0; index < 6; index += 1) await press(instance, 'j');
    const lines = frameLines(instance.lastFrame());
    expect(lines.join('\n')).not.toContain('src/one.ts:10:');
    expect(lines[FIRST_DIFF_ROW]).toContain('src/one.ts-h0-1');
    expect(lines[FIRST_DIFF_ROW]).toContain(`${FOCUS_BAR} `);
    // Only the top row carries the mark.
    expect(lines.filter((line) => line.includes(FOCUS_BAR))).toHaveLength(1);

    await press(instance, 'c');
    await flush(2);
    expect(writes).toEqual([fixture.review.files[0]!.blocks[0]!.addedCode]);

    instance.unmount();
  });

  it('draws no top-row mark while the focused header is on screen', async () => {
    const instance = renderFixture(keyboardFixture(), {columns: 120, rows: 30});
    await flush();

    const lines = frameLines(instance.lastFrame());
    expect(lines[FIRST_DIFF_ROW]).not.toContain(FOCUS_BAR);
    expect(focusedHeader(instance.lastFrame())).toHaveLength(1);

    instance.unmount();
  });

  it('focuses the block whose frame opens the viewport', async () => {
    const writes: string[] = [];
    const fixture = keyboardFixture();
    const instance = renderFixture(fixture, {columns: 120, rows: 30}, writes);
    await flush();

    // Block 0 takes rows 0-10 (5 frame rows, 6 body rows); row 11 is the
    // blank row that opens block 1's frame.
    for (let index = 0; index < 11; index += 1) await press(instance, 'j');
    // The diff pane starts at column 34; its top row is the blank frame row.
    expect(frameLines(instance.lastFrame())[FIRST_DIFF_ROW]!.slice(34)).toMatch(/^│ +│$/);
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:40:');

    await press(instance, 'c');
    await flush(2);
    expect(writes).toEqual([fixture.review.files[0]!.blocks[1]!.addedCode]);

    instance.unmount();
  });
});

describe('Enter inside a long block', () => {
  const longBlocks = () => keyboardFixture([multiBlockFile('src/one.ts', [10, 100, 200], 40)]);

  it('brings the block\'s header into view, so a second Enter expands the same block', async () => {
    const instance = renderFixture(longBlocks(), {columns: 120, rows: 30});
    await flush();

    for (let index = 0; index < 15; index += 1) await press(instance, 'j');
    expect(frameLines(instance.lastFrame()).join('\n')).not.toContain('src/one.ts:10:');

    await press(instance, '\r');
    let frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('▸ src/one.ts:10:');
    expect(frame).not.toContain('src/one.ts-h0-');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('src/one.ts:10:');
    expect(frame).toContain('▾ src/one.ts:100:');

    await press(instance, '\r');
    frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('▾ src/one.ts:10:');
    expect(frame).toContain('src/one.ts-h0-0');
    expect(frame).not.toContain('▸');

    instance.unmount();
  });

  it('keeps the header of the last block in view when Enter collapses it near the end', async () => {
    const instance = renderFixture(keyboardFixture([multiBlockFile('src/one.ts', [10, 100], 40)]), {columns: 120, rows: 30});
    await flush();

    await press(instance, 'G');
    expect(frameLines(instance.lastFrame()).join('\n')).not.toContain('src/one.ts:100:');

    await press(instance, '\r');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('▸ src/one.ts:100:');
    await press(instance, '\r');
    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('▾ src/one.ts:100:');
    expect(frame).not.toContain('▸');
    expect(focusedHeader(instance.lastFrame())[0]).toContain('▾ src/one.ts:100:');

    instance.unmount();
  });

  it('keeps a clicked header in view when the click collapses its block', async () => {
    const instance = renderFixture(keyboardFixture([multiBlockFile('src/one.ts', [10, 100], 40)]), {columns: 120, rows: 30});
    await flush();

    // Scroll until block 1's header is on the bottom rows of the pane.
    for (let index = 0; index < 30; index += 1) await press(instance, 'j');
    const header = cellPosition(instance.lastFrame(), ['src/one.ts:100:'], 'src/one.ts:100:');
    await emitMousePressAt(header.column, header.row);
    await flush(2);

    const frame = frameLines(instance.lastFrame()).join('\n');
    expect(frame).toContain('▸ src/one.ts:100:');
    expect(frame).not.toContain('src/one.ts-h1-');

    instance.unmount();
  });
});
