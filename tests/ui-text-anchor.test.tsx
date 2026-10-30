import {describe, expect, it} from 'vitest';
import type {SectionRow, WrappedSection} from '../src/sections.js';
import type {MediaRowsHook} from '../src/ui/App.js';
import {
  appElement,
  binaryMediaFile,
  buildFixture,
  cellPosition,
  emitMouseDragAt,
  emitMousePressAt,
  flush,
  frameLines,
  multiBlockFile,
  recordingWriter,
  renderSized,
  type AppFixtureProps,
} from './ui-fixtures.js';

// Media rows appear, grow and go away as pictures load and views change.
// The view and a selection are anchored to the text rows around them, so
// none of that moves the text the user is reading or cancels a selection.

const DIMENSIONS = {columns: 120, rows: 30};

function fixture(): AppFixtureProps {
  return buildFixture([
    multiBlockFile('src/one.ts', [1, 40], 12),
    multiBlockFile('src/two.ts', [1, 30, 60], 10),
    multiBlockFile('src/three.ts', [1], 20),
  ]);
}

const mediaRow = (path: string): SectionRow => ({block: -1, kind: 'media', continuation: false, media: {fileKey: path}});

// Puts `count` synthetic media rows into the section for `path` at row `at`.
function insertMediaRows(path: string, at: number, count: number, label = 'MEDIA'): MediaRowsHook {
  return <S extends WrappedSection>(sections: S[]) => sections.map((section) => {
    if (section.path !== path) return section;
    const lines = [...section.lines];
    const rows = [...section.rows];
    lines.splice(at, 0, ...Array.from({length: count}, (_, index) => `${label} ${index}`));
    rows.splice(at, 0, ...Array.from({length: count}, () => mediaRow(path)));
    return {...section, lines, rows};
  });
}

function start(props: AppFixtureProps, writes: string[] = []) {
  const writer = recordingWriter(writes);
  const instance = renderSized(appElement(props, DIMENSIONS, writer));
  return {
    instance,
    rerender: (next: AppFixtureProps) => instance.rerender(appElement(next, DIMENSIONS, writer)),
  };
}

async function press(instance: {stdin: {write: (data: string) => void}}, input: string, times = 1) {
  for (let index = 0; index < times; index += 1) {
    instance.stdin.write(input);
    await flush(2);
  }
}

describe('the text anchor', () => {
  it('keeps the text in view still when media rows appear above the top row of the active file', async () => {
    const props = fixture();
    const {instance, rerender} = start(props);
    await flush();
    await press(instance, '\u001B[B');
    await press(instance, 'j', 9);
    const before = instance.lastFrame();
    expect(frameLines(before).join('\n')).toContain('src/two.ts-h0-7');

    rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 2, 6)});
    await flush(3);
    expect(instance.lastFrame()).toBe(before);

    // Growing, shrinking and removing the run moves nothing either.
    for (const count of [14, 1]) {
      rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 2, count)});
      await flush(3);
      expect(instance.lastFrame()).toBe(before);
    }
    rerender({...props});
    await flush(3);
    expect(instance.lastFrame()).toBe(before);

    instance.unmount();
  });

  it('keeps the place inside a run of media rows at the top, clamped when the run shrinks', async () => {
    const props = fixture();
    const {instance, rerender} = start({...props, addMediaRows: insertMediaRows('src/two.ts', 2, 8)});
    await flush();
    await press(instance, '\u001B[B');
    await press(instance, 'j', 5);
    const top = () => frameLines(instance.lastFrame()).find((line) => /MEDIA \d|two\.ts-h/.test(line)) ?? '';
    expect(top()).toContain('MEDIA 3');

    rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 2, 8, 'GROWN')});
    await flush(3);
    expect(frameLines(instance.lastFrame()).find((line) => /GROWN \d/.test(line))).toContain('GROWN 3');

    rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 2, 2, 'SMALL')});
    await flush(3);
    expect(frameLines(instance.lastFrame()).find((line) => /SMALL \d|two\.ts-h/.test(line))).toContain('SMALL 1');

    instance.unmount();
  });

  it('keeps a file opened at its first row on its first row when media rows appear there', async () => {
    const props = fixture();
    const {instance, rerender} = start(props);
    await flush();
    await press(instance, '\u001B[B');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 2/3');

    rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 0, 4)});
    await flush(3);
    const lines = frameLines(instance.lastFrame());
    const first = lines.findIndex((line) => line.includes('MEDIA 0'));
    expect(first).toBe(6);
    expect(lines.join('\n')).toContain('file 2/3');

    instance.unmount();
  });

  it('keeps a file top on its first row when the top row is the previous file\'s trailing blank row', async () => {
    const props = fixture();
    const {instance, rerender} = start({...props, addMediaRows: insertMediaRows('src/two.ts', 0, 4)});
    await flush();
    await press(instance, '\u001B[B');
    await press(instance, 'k');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('MEDIA 0');

    rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 0, 5)});
    await flush(3);
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('MEDIA 0');

    instance.unmount();
  });

  it('keeps the first text row under a picture at the top when the picture grows or shrinks', async () => {
    const props = fixture();
    const {instance, rerender} = start({...props, addMediaRows: insertMediaRows('src/two.ts', 0, 4)});
    await flush();
    await press(instance, '\u001B[B');
    await press(instance, 'j', 4);
    const before = instance.lastFrame();
    // The block's frame row is at the top, just past the picture.
    expect(frameLines(before).join('\n')).not.toContain('MEDIA');
    expect(frameLines(before).join('\n')).toContain('src/two.ts-h0-0');

    for (const count of [6, 1, 4]) {
      rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 0, count)});
      await flush(3);
      expect(instance.lastFrame()).toBe(before);
    }

    instance.unmount();
  });

  it('keeps the text in view still when a block under a picture is folded', async () => {
    const props = fixture();
    const {instance} = start({...props, addMediaRows: insertMediaRows('src/two.ts', 0, 4)});
    await flush();
    await press(instance, '\u001B[B');
    await press(instance, 'j', 7);
    await press(instance, ']');
    const before = frameLines(instance.lastFrame());
    // The picture is above the top row, and the focused block's header is in view.
    expect(before.join('\n')).not.toContain('MEDIA');
    const top = before.findIndex((line) => line.includes('src/two.ts:30:'));
    expect(top).toBeGreaterThan(0);

    await press(instance, '\r');
    const after = frameLines(instance.lastFrame());
    expect(after.join('\n')).not.toContain('src/two.ts-h1-0');
    expect(after.findIndex((line) => line.includes('src/two.ts:30:'))).toBe(top);
    expect(after.slice(0, top)).toEqual(before.slice(0, top));
    expect(after[top]).toContain('▸ src/two.ts:30:');

    instance.unmount();
  });

  it('keeps a selection in progress when media rows appear above it, and copies the same text', async () => {
    const props = fixture();
    const writes: string[] = [];
    const {instance, rerender} = start(props, writes);
    await flush();
    await press(instance, '\u001B[B');
    await press(instance, 'j', 4);

    let frame = instance.lastFrame();
    const from = cellPosition(frame, ['src/two.ts-h0-4'], 'src/two.ts-h0-4');
    const to = cellPosition(frame, ['src/two.ts-h0-6'], 'src/two.ts-h0-6', 'src/two.ts-h0-6'.length - 1);
    await emitMousePressAt(from.column, from.row);
    await emitMouseDragAt(to.column, to.row);

    rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 2, 5)});
    await flush(3);
    frame = instance.lastFrame();
    expect(frameLines(frame).join('\n')).not.toContain('Selection cancelled');
    await emitMouseDragAt(to.column, to.row, true);
    await flush(2);

    expect(writes).toEqual(['src/two.ts-h0-4\nsrc/two.ts-h0-5\nsrc/two.ts-h0-6']);
    instance.unmount();
  });

  it('still cancels a selection when media rows appear inside it', async () => {
    const props = fixture();
    const writes: string[] = [];
    const {instance, rerender} = start(props, writes);
    await flush();
    await press(instance, '\u001B[B');
    await press(instance, 'j', 4);

    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['src/two.ts-h0-4'], 'src/two.ts-h0-4');
    const to = cellPosition(frame, ['src/two.ts-h0-6'], 'src/two.ts-h0-6', 'src/two.ts-h0-6'.length - 1);
    await emitMousePressAt(from.column, from.row);
    await emitMouseDragAt(to.column, to.row);

    // The section's rows 0-4 frame the block header; row 10 is h0-5.
    rerender({...props, addMediaRows: insertMediaRows('src/two.ts', 10, 2)});
    await flush(3);
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('Selection cancelled');
    instance.unmount();
  });

  it('lets a blank media row at the top name its own file as the active one', async () => {
    const props = buildFixture([
      multiBlockFile('src/one.ts', [1], 20),
      binaryMediaFile('img/a.png'),
      multiBlockFile('src/three.ts', [1], 40),
    ]);
    // A loading picture box: blank rows in place of the placeholder line.
    const blankBox: MediaRowsHook = <S extends WrappedSection>(sections: S[]) => sections.map((section) => section.path !== 'img/a.png'
      ? section
      : {...section, lines: ['', '', '', ...section.lines.slice(1)], rows: [mediaRow(section.path), mediaRow(section.path), mediaRow(section.path), ...section.rows.slice(1)]});
    const {instance} = start({...props, addMediaRows: blankBox});
    await flush();
    await press(instance, '\u001B[B');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 2/3');
    await press(instance, 'j');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('file 2/3');
    instance.unmount();
  });

  it('gives the same frames as no hook when the hook adds nothing', async () => {
    const props = fixture();
    const run = async (extra: Partial<AppFixtureProps>) => {
      const {instance} = start({...props, ...extra});
      await flush();
      for (const key of ['\u001B[B', 'j', 'j', ']', '\r', 'G', '[', 'k', 'g']) await press(instance, key);
      const frames = [...instance.frames];
      instance.unmount();
      return frames;
    };

    const plain = await run({});
    const identity: MediaRowsHook = (sections) => sections;
    expect(await run({addMediaRows: identity})).toEqual(plain);
    expect(await run({addMediaRows: insertMediaRows('src/none.ts', 0, 3)})).toEqual(plain);
  });
});
