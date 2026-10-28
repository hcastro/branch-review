import {describe, expect, it} from 'vitest';
import {
  buildFixture,
  emitMouseMoveAt,
  emitMousePressAt,
  flush,
  frameLines,
  gutter,
  renderFixture,
} from './ui-fixtures.js';

const longPath = 'packages/server/src/handlers/very-long-module-name.ts';
const fileName = 'very-long-module-name.ts';

function longPathFixture() {
  const data = buildFixture([{
    path: longPath,
    rawDiff: '@@ -120 +120 @@\n-old();\n+fresh();\n@@ -300 +300 @@\n-before();\n+after();',
    rendered: [
      `• ${longPath}:120: `,
      `${gutter(120)}fresh();`,
      `• ${longPath}:300: `,
      `${gutter(300)}after();`,
    ],
  }]);
  return {...data, readFileContent: () => 'file contents'};
}

const FILE_BUTTONS = ['Copy path', 'Copy diff', 'Copy file'];
const BLOCK_ACTIONS = ['Copy code', 'Copy diff', 'Copy block'];

// The diff pane's part of a frame row: the text after the tree pane.
function diffPart(line: string) {
  const index = line.indexOf('││');
  return index < 0 ? line : line.slice(index + 1);
}

function fileButtons(row: string) {
  return [...row.matchAll(/╭─(.*?)─╮/g)].map((match) => match[1]!);
}

describe.each([58, 67, 73, 74, 80, 100])('the diff pane at %i columns', (columns) => {
  it('shows the file name and only whole buttons in the file header', async () => {
    const instance = renderFixture(longPathFixture(), {columns, rows: 24});
    await flush();

    const header = diffPart(frameLines(instance.lastFrame())[4]!);
    expect(header).toContain(fileName);
    const buttons = fileButtons(header);
    expect(buttons).toEqual(FILE_BUTTONS.slice(0, buttons.length));
    // Every button border and every `Copy` belongs to a whole button.
    expect(header.split('╭─').length - 1).toBe(buttons.length);
    expect(header.split('─╮').length - 1).toBe(buttons.length);
    expect(header.split('Copy').length - 1).toBe(buttons.length);

    instance.unmount();
  });

  it('copies only through the file header buttons it draws', async () => {
    const writes: string[] = [];
    const data = longPathFixture();
    const instance = renderFixture(data, {columns, rows: 24}, writes);
    await flush();

    const lines = frameLines(instance.lastFrame());
    const row = lines[4]!;
    const drawn = fileButtons(diffPart(row));
    const paneStart = row.length - diffPart(row).length;
    for (let column = paneStart; column < row.length; column += 1) {
      await emitMouseMoveAt(column, 4);
      await emitMousePressAt(column, 4);
    }
    await flush(2);

    const payloads: Record<string, string> = {
      'Copy path': longPath,
      'Copy diff': data.review.files[0]!.rawDiff,
      'Copy file': 'file contents',
    };
    expect(new Set(writes)).toEqual(new Set(drawn.map((label) => payloads[label])));

    instance.unmount();
  });

  it('keeps `<name>:<line>:` and whole action labels on the focused block header', async () => {
    const instance = renderFixture(longPathFixture(), {columns, rows: 24});
    await flush();

    const header = frameLines(instance.lastFrame()).map(diffPart).find((line) => line.includes(':120:'));
    expect(header).toBeDefined();
    expect(header).toContain(`${fileName}:120:`);
    expect(header).not.toMatch(/Copy(?! code\b| diff\b| block\b)/);
    const labels = BLOCK_ACTIONS.filter((label) => header!.includes(label));
    expect(labels).toEqual(BLOCK_ACTIONS.slice(0, labels.length));

    instance.unmount();
  });
});

describe('block header actions at 100 columns', () => {
  it('does not copy from the place of an action that is not drawn', async () => {
    const writes: string[] = [];
    const data = longPathFixture();
    const instance = renderFixture(data, {columns: 100, rows: 24}, writes);
    await flush();

    const lines = frameLines(instance.lastFrame());
    const row = lines.findIndex((line) => line.includes(':120:'));
    expect(lines[row]).toContain('Copy diff');
    expect(lines[row]).not.toContain('Copy block');

    // Where `Copy block` would follow `Copy diff`.
    const after = lines[row]!.indexOf('Copy diff') + 'Copy diff'.length + 2;
    await emitMouseMoveAt(after, row);
    await emitMousePressAt(after, row);
    await flush(2);
    expect(writes).toEqual([]);

    // The drawn ones still copy.
    const fresh = frameLines(instance.lastFrame());
    const headerRow = fresh.findIndex((line) => line.includes(':120:'));
    const copyDiff = fresh[headerRow]!.indexOf('Copy diff') + 1;
    await emitMouseMoveAt(copyDiff, headerRow);
    await emitMousePressAt(copyDiff, headerRow);
    await flush(2);
    expect(writes).toEqual([data.review.files[0]!.blocks[0]!.rawDiff]);

    instance.unmount();
  });
});
