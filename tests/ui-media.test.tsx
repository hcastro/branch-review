import {randomBytes} from 'node:crypto';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  binaryMediaFile,
  buildFixture,
  cellPosition,
  decodePlaceholders,
  emitMouseDragAt,
  emitMouseMoveAt,
  emitMousePressAt,
  fakeMediaBackend,
  fakeMediaService,
  KITTY_CAPS,
  flush,
  frameLines,
  gutter,
  parseApc,
  pngFixture,
  renderFixture,
  sgrCodeNames,
  sideInfo,
  type FixtureFile,
} from './ui-fixtures.js';
import {tooltipCoversKittyRows} from '../src/ui/App.js';
import type {MediaBackend, RenderResult} from '../src/media/backend.js';
import {createMediaService} from '../src/media/service.js';

// Kitty still images in the diff pane: placeholder rows in place of the
// `binary file changed` line, drawn from a media service over a fake
// backend, with every escape the app sends recorded apart from the frames.

afterEach(() => {
  vi.useRealTimers();
});

const SIZE = {columns: 120, rows: 30};

function textFile(path: string, count = 6): FixtureFile {
  const raw = [`@@ -0,0 +1,${count} @@`];
  const rendered = [`• ${path}:1: `];
  for (let index = 0; index < count; index += 1) {
    raw.push(`+${path} line ${index}`);
    rendered.push(`${gutter(index + 1)}${path} line ${index}`);
  }
  return {path, rawDiff: raw.join('\n'), rendered};
}

// An added PNG of 200 × 100 px: with 10 × 20 px cells, a 20 × 5 cell box.
const LOGO = binaryMediaFile('docs/logo.png', 'added', ['0000000', '97fa3ee']);
const SIDES = {'97fa3ee': sideInfo({width: 200, height: 100, bytes: 232_000})};

async function settle(times = 6) {
  await flush(times);
}

function mediaApp(files: FixtureFile[], options: Parameters<typeof fakeMediaService>[0] = {}, size = SIZE) {
  const fixture = buildFixture(files);
  const fake = fakeMediaService({sides: SIDES, review: fixture.review, ...options});
  const writes: string[] = [];
  const instance = renderFixture({...fixture, media: fake.service}, size, writes);
  return {...fake, instance, writes, fixture};
}

// The placeholder cells as a rectangle: one id, rows and columns in order,
// on consecutive screen lines in the same columns.
function boxRectangle(frame: string | undefined) {
  const cells = decodePlaceholders(frame);
  const ids = new Set(cells.map((cell) => cell.id));
  const lines = [...new Set(cells.map((cell) => cell.line))];
  return {cells, ids, lines};
}

describe('Kitty still images', () => {
  it('draws an added PNG as a contiguous rectangle of placeholder cells inside the pane', async () => {
    const {instance, graphicsWrites} = mediaApp([textFile('src/a.ts', 3), LOGO]);
    await settle();
    // Jump to the picture.
    instance.stdin.write('\u001B[B');
    await settle();

    const frame = instance.lastFrame();
    const {cells, ids, lines} = boxRectangle(frame);
    expect(cells).toHaveLength(20 * 5);
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)! - lines[0]!).toBe(4);
    for (const [boxRow, line] of lines.entries()) {
      const row = cells.filter((cell) => cell.line === line);
      expect(row.map((cell) => cell.row)).toEqual(Array(20).fill(boxRow));
      expect(row.map((cell) => cell.col)).toEqual(Array.from({length: 20}, (_, col) => col));
      expect(row.map((cell) => cell.column)).toEqual(Array.from({length: 20}, (_, col) => row[0]!.column + col));
    }
    // Every row of the box still ends at the pane's right border.
    for (const line of lines) {
      const text = stripAnsi(frameLines(frame)[line] ?? '');
      expect(stringWidth(text)).toBe(SIZE.columns);
      expect(text.trimEnd().endsWith('│')).toBe(true);
    }
    // Sent once, transmit then placement, before any frame named the id.
    const commands = parseApc(graphicsWrites);
    expect(commands.filter((command) => command.a === 't')).toHaveLength(1);
    expect(commands.find((command) => command.a === 'p')).toMatchObject({i: id, U: 1, c: 20, r: 5, q: 2});
    const firstWithId = instance.frames.findIndex((each) => decodePlaceholders(each).length > 0);
    expect(firstWithId).toBeGreaterThan(0);

    const text = frameLines(frame).join('\n');
    expect(text).toContain('after');
    expect(text).toContain('shown at 100%');
    expect(text).not.toContain('binary file changed');
    instance.unmount();
  });

  it('names the transmitted id in every cell when the id is also an SGR code', async () => {
    // Ids start at a random point; this one starts at 39, which is also the
    // SGR code for the default foreground, so `38;5;39` must read as id 39.
    const {instance, graphicsWrites} = mediaApp([LOGO], {registry: {random: () => 38.5 / 255}});
    await settle();
    const placement = parseApc(graphicsWrites).find((command) => command.a === 'p');
    expect(placement).toMatchObject({i: 39});
    const cells = decodePlaceholders(instance.lastFrame());
    expect(cells).toHaveLength(20 * 5);
    expect(new Set(cells.map((cell) => cell.id))).toEqual(new Set([39]));
    instance.unmount();
  });

  it('shows one loading row until inspect answers, and the reason when it fails', async () => {
    const {instance} = mediaApp([LOGO], {sides: {'97fa3ee': {error: 'not a PNG image'}}});
    expect(frameLines(instance.frames[0]).join('\n')).toContain('loading preview…');
    await settle();
    const text = frameLines(instance.lastFrame()).join('\n');
    expect(text).toContain('not a PNG image');
    expect(text).not.toContain('loading preview…');
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    instance.unmount();
  });

  it('says a render failure on the first box row and leaves the rest blank', async () => {
    const {instance} = mediaApp([LOGO], {render: () => ({ok: false, state: 'error', reason: 'could not decode image'})});
    await settle();
    const lines = frameLines(instance.lastFrame());
    const at = lines.findIndex((line) => line.includes('preview unavailable: could not decode image'));
    expect(at).toBeGreaterThan(0);
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    instance.unmount();
  });

  it('clips the box row by row when scrolled, drawing only the rows on screen', async () => {
    const {instance} = mediaApp([LOGO, textFile('src/z.ts', 30)], {}, {columns: 120, rows: 20});
    await settle();
    const before = decodePlaceholders(instance.lastFrame());
    expect(new Set(before.map((cell) => cell.row))).toEqual(new Set([0, 1, 2, 3, 4]));

    // The label row and two box rows scroll off the top.
    for (let step = 0; step < 3; step += 1) {
      instance.stdin.write('j');
      await settle(2);
    }
    const after = decodePlaceholders(instance.lastFrame());
    const rows = [...new Set(after.map((cell) => cell.row))];
    expect(rows).toEqual([2, 3, 4]);
    expect(after.every((cell) => cell.col >= 0 && cell.col < 20)).toBe(true);
    // The first line of the pane is a box row.
    const firstPaneLine = frameLines(instance.lastFrame()).findIndex((line) => line.includes('file 1/2')) + 1;
    expect(after[0]!.line).toBe(firstPaneLine);
    instance.unmount();
  });

  // Ids start at a random point. 7 (inverse) and 48 (background) are also
  // SGR codes, so the image's own `38;5;N` must not read as either.
  const noWashOrSelection = async (firstId?: number) => {
    const registry = firstId === undefined ? {} : {registry: {random: () => (firstId - 0.5) / 255}};
    const {instance, graphicsWrites} = mediaApp([textFile('src/a.ts', 3), LOGO, textFile('src/b.ts', 3)], registry, {columns: 120, rows: 40});
    await settle();
    // Drag from the text above the picture to the text below it.
    const start = cellPosition(instance.lastFrame(), ['src/a.ts line 0'], 'src/a.ts line 0');
    const end = cellPosition(instance.lastFrame(), ['src/b.ts line 1'], 'src/b.ts line 1');
    await emitMousePressAt(start.column, start.row);
    await emitMouseDragAt(end.column + 3, end.row);
    // A drag redraws the selection at most every few tens of milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle(3);

    const frame = instance.lastFrame() ?? '';
    const lines = frame.split('\n');
    const selection = '\u001B[48;2;28;68;76m';
    // The selection covers the text on both sides of the picture.
    for (const text of ['src/a.ts line 2', 'src/b.ts line 0']) {
      expect(lines.find((line) => line.includes(text)), text).toContain(selection);
    }
    expect(decodePlaceholders(frame).length).toBeGreaterThan(0);
    for (const cell of decodePlaceholders(frame)) {
      const line = lines[cell.line]!;
      // No background colour and no inverse, read as codes: the image's own
      // `38;5;N` is a foreground whatever N is.
      const codes = sgrCodeNames(line);
      expect(codes).not.toContain('48');
      expect(codes).not.toContain('7');
      expect(line).not.toContain('\u001B[48;2;28;68;76m');
    }
    if (firstId !== undefined) {
      expect(parseApc(graphicsWrites).find((command) => command.a === 'p')).toMatchObject({i: firstId});
      expect(new Set(decodePlaceholders(frame).map((cell) => cell.id))).toEqual(new Set([firstId]));
    }
    instance.unmount();
  };

  it('puts no arrival wash or selection colour inside a media row', async () => {
    await noWashOrSelection();
  });

  it.each([7, 48])('puts no arrival wash or selection colour inside a media row whose image id is %i', async (firstId) => {
    await noWashOrSelection(firstId);
  });

  it('copies only the text around a picture when a drag crosses it, with no placeholder', async () => {
    const files = [textFile('src/a.ts', 3), LOGO, textFile('src/b.ts', 3)];
    const run = async (withMedia: boolean) => {
      const fixture = buildFixture(files);
      const fake = fakeMediaService({sides: SIDES, review: fixture.review});
      const writes: string[] = [];
      const instance = renderFixture({...fixture, ...(withMedia ? {media: fake.service} : {})}, {columns: 120, rows: 40}, writes);
      await settle();
      const start = cellPosition(instance.lastFrame(), ['src/a.ts line 1'], 'src/a.ts line 1');
      const end = cellPosition(instance.lastFrame(), ['src/b.ts line 1'], 'src/b.ts line 1');
      await emitMousePressAt(start.column, start.row);
      await emitMouseDragAt(end.column + 3, end.row);
      await emitMouseDragAt(end.column + 3, end.row, true);
      await settle(4);
      if (withMedia) expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
      instance.unmount();
      return writes;
    };

    const withPreview = await run(true);
    const without = await run(false);
    expect(withPreview).toHaveLength(1);
    expect(withPreview[0]).not.toContain('\u{10EEEE}');
    expect(withPreview).toEqual(without);
  });

  it('keeps a selection across a picture while the picture loads, and copies the same text', async () => {
    const files = [textFile('src/a.ts', 3), LOGO, textFile('src/b.ts', 3)];
    const selectionColour = '\u001B[48;2;28;68;76m';
    // Inspect answers only when the test opens the gate, so the picture is
    // one `loading preview…` row while the drag starts and its full height
    // when it ends.
    const run = async (withMedia: boolean, releaseBeforeLoad: boolean) => {
      const fixture = buildFixture(files);
      const fake = fakeMediaBackend({sides: SIDES});
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const backend: MediaBackend = {...fake.backend, inspect: async (...args) => {
        await gate;
        return fake.backend.inspect(...args);
      }};
      const service = createMediaService({caps: KITTY_CAPS, backend, sink: {write: () => undefined}, opener: () => undefined, env: {}});
      service.setReview(fixture.review, {cwd: '/repo', range: {includeWorktree: false}});
      const writes: string[] = [];
      const instance = renderFixture({...fixture, ...(withMedia ? {media: service} : {})}, {columns: 120, rows: 40}, writes);
      await settle();
      if (withMedia) expect(frameLines(instance.lastFrame()).join('\n')).toContain('loading preview…');
      const start = cellPosition(instance.lastFrame(), ['src/a.ts line 1'], 'src/a.ts line 1');
      const end = cellPosition(instance.lastFrame(), ['src/b.ts line 1'], 'src/b.ts line 1');
      await emitMousePressAt(start.column, start.row);
      await emitMouseDragAt(end.column + 3, end.row);
      // A drag redraws the selection at most every few tens of milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (releaseBeforeLoad) await emitMouseDragAt(end.column + 3, end.row, true);
      await settle(3);

      openGate();
      await settle(10);
      const frame = instance.lastFrame() ?? '';
      if (withMedia) expect(decodePlaceholders(frame).length).toBeGreaterThan(0);
      const footer = frameLines(frame).at(-2) ?? '';
      expect(footer).not.toContain('Selection cancelled');
      for (const text of ['src/a.ts line 2', 'src/b.ts line 0']) {
        expect(frame.split('\n').find((line) => line.includes(text)), `${text} selected`).toContain(selectionColour);
      }
      if (!releaseBeforeLoad) {
        // The text the drag ends on moved down under the grown picture.
        const moved = cellPosition(frame, ['src/b.ts line 1'], 'src/b.ts line 1');
        if (withMedia) expect(moved.row).toBeGreaterThan(end.row);
        await emitMouseDragAt(moved.column + 3, moved.row, true);
        await settle(4);
      }
      instance.unmount();
      return writes;
    };

    for (const releaseBeforeLoad of [false, true]) {
      const withPreview = await run(true, releaseBeforeLoad);
      const without = await run(false, releaseBeforeLoad);
      expect(withPreview, `released ${releaseBeforeLoad ? 'before' : 'after'} the load`).toHaveLength(1);
      expect(withPreview).toEqual(without);
    }
  });

  it('gives every copy key the same payload with previews on and off', async () => {
    const files = [LOGO, textFile('src/b.ts', 3)];
    const run = async (withMedia: boolean) => {
      const fixture = buildFixture(files);
      const fake = fakeMediaService({sides: SIDES, review: fixture.review});
      const writes: string[] = [];
      const instance = renderFixture({
        ...fixture,
        readFileContent: (file) => {
          if (file.path.endsWith('.png')) throw new Error(`${file.path} is not UTF-8 text`);
          return 'contents\n';
        },
        resolveAbsolutePath: (file) => `/repo/${file.path}`,
        ...(withMedia ? {media: fake.service} : {}),
      }, SIZE, writes);
      await settle();
      const frames: string[] = [];
      for (const file of [0, 1]) {
        for (const key of ['y', 'Y', 'd', 'f', 'c', 'p', 'b', 'T']) {
          instance.stdin.write(key);
          await settle(3);
          frames.push(frameLines(instance.lastFrame()).at(-2) ?? '');
        }
        if (file === 0) {
          instance.stdin.write('\u001B[B');
          await settle(3);
        }
      }
      instance.unmount();
      return {writes, toasts: frames.map((line) => line.replace(/│/g, '').trim().split('  ')[0])};
    };

    const on = await run(true);
    const off = await run(false);
    expect(on.writes.length).toBeGreaterThan(5);
    expect(on.writes).toEqual(off.writes);
    expect(on.toasts).toEqual(off.toasts);
  });

  it('does not draw the tree tooltip over a picture, and shows its text in the top bar', async () => {
    const longName = `assets/${'deeply-nested-folder-name/'.repeat(3)}hero-banner-with-a-long-name.png`;
    const file = binaryMediaFile(longName, 'added', ['0000000', '97fa3ee']);
    const {instance} = mediaApp([file], {}, {columns: 120, rows: 30});
    await settle();
    const frameBefore = instance.lastFrame();
    const cellsBefore = decodePlaceholders(frameBefore);
    expect(cellsBefore.length).toBeGreaterThan(0);

    const label = cellPosition(frameBefore, ['• hero'], 'hero');
    await emitMouseMoveAt(label.column, label.row);
    // The tooltip shows after its hover delay.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();

    const frame = instance.lastFrame();
    expect(frameLines(frame)[1]).toContain('hero-banner-with-a-long-name.png');
    expect(frameLines(frame).some((line) => line.includes('╭') && line.indexOf('╭') > 40 && line.indexOf('╭') < 100 && !line.includes('Changed files'))).toBe(false);
    expect(decodePlaceholders(frame)).toEqual(cellsBefore);
    instance.unmount();
  });

  it('draws the tree tooltip in Kitty mode when the rows it covers hold no picture', async () => {
    const longName = `src/${'deeply-nested-folder-name/'.repeat(3)}a-source-file-with-a-long-name.ts`;
    // The picture is on screen below the long file's text, and the tooltip
    // of the long file's tree entry spans only that text.
    const {instance} = mediaApp([textFile(longName, 3), LOGO], {}, {columns: 120, rows: 40});
    await settle();
    const frameBefore = instance.lastFrame();
    const cells = decodePlaceholders(frameBefore);
    expect(cells.length).toBeGreaterThan(0);
    const label = cellPosition(frameBefore, ['• a-source-fil'], 'a-source-fil');
    // The overlay takes the three rows under the hovered entry.
    const TOOLTIP_ROWS = 3;
    expect(Math.min(...cells.map((cell) => cell.line))).toBeGreaterThan(label.row + TOOLTIP_ROWS);
    await emitMouseMoveAt(label.column, label.row);
    // The tooltip shows after its hover delay.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();

    const frame = instance.lastFrame();
    const lines = frameLines(frame);
    // The overlay under the hovered entry, reaching from the tree into the
    // diff pane over the long file's text rows.
    const tip = lines.findIndex((line) => line.includes('│ a-source-file-with-a-long-name.ts │'));
    expect(tip).toBe(label.row + 2);
    expect(lines[tip - 1]!.indexOf('╭')).toBeLessThan(40);
    expect(lines[tip - 1]!.lastIndexOf('╮')).toBeGreaterThan(40);
    expect(lines[1]).not.toContain('a-source-file-with-a-long-name.ts');
    expect(decodePlaceholders(frame)).toEqual(cells);
    instance.unmount();
  });

  it('decides tooltip cover from the rows it spans', () => {
    const tooltip = {left: 30, top: 8, width: 40};
    expect(tooltipCoversKittyRows(tooltip, 40, (row) => row === 10)).toBe(true);
    expect(tooltipCoversKittyRows(tooltip, 40, (row) => row === 11)).toBe(false);
    expect(tooltipCoversKittyRows({left: 0, top: 8, width: 30}, 40, () => true)).toBe(false);
  });

  it('opens a temp copy with o and Quick Looks it with O, by absolute path', async () => {
    const {instance, opened, calls} = mediaApp([LOGO]);
    await settle();
    instance.stdin.write('o');
    await settle();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('opened logo.png (after)');
    instance.stdin.write('O');
    await settle();

    expect(opened).toEqual([
      {command: '/usr/bin/open', args: ['/tmp/branch-review-media-test/open-1/after.png']},
      {command: '/usr/bin/qlmanage', args: ['-p', '/tmp/branch-review-media-test/open-1/after.png']},
    ]);
    const exports = calls.filter((call) => call.type === 'exportCopy');
    expect(exports).toHaveLength(2);
    expect(exports[0]!.request).toMatchObject({format: 'png', side: {side: 'after', path: 'docs/logo.png', abbrevId: '97fa3ee'}});
    instance.unmount();
  });

  it('opens from the Open header button', async () => {
    const {instance, opened} = mediaApp([LOGO]);
    await settle();
    const open = cellPosition(instance.lastFrame(), ['Copy path', 'Open'], 'Open', 1);
    await emitMouseMoveAt(open.column, open.row);
    expect(frameLines(instance.lastFrame())[1]).toContain('opens the image in the default viewer');
    await emitMousePressAt(open.column, open.row);
    await settle();
    expect(opened).toHaveLength(1);
    instance.unmount();
  });

  it('refuses to open over SSH', async () => {
    const {instance, opened} = mediaApp([LOGO], {env: {SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22'}});
    await settle();
    instance.stdin.write('o');
    await settle();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('open is not available over SSH');
    expect(opened).toEqual([]);
    instance.unmount();
  });

  it('says what o does on a file that is not media', async () => {
    const {instance, opened} = mediaApp([textFile('src/a.ts'), LOGO]);
    await settle();
    instance.stdin.write('o');
    await settle();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('o opens images and video');
    expect(opened).toEqual([]);
    instance.unmount();
  });

  it('shows the format, pixel size and bytes in the metrics row', async () => {
    const {instance} = mediaApp([LOGO]);
    await settle();
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('PNG · 200 × 100 px · 232 KB  file 1/1');
    instance.unmount();
  });

  it('gives footer hints and header buttons per kind', async () => {
    const {instance} = mediaApp([LOGO, textFile('src/b.ts')]);
    await settle();
    let lines = frameLines(instance.lastFrame());
    expect(lines.at(-2)).toContain('q quit • ↑/↓ jump file • o open • v text • j/k scroll • y d copy • t tree');
    const header = lines.find((line) => line.includes('docs/logo.png'))!;
    expect(header).toMatch(/Copy path.*Open.*Copy diff/);
    expect(header).not.toContain('Copy file');

    instance.stdin.write('\u001B[B');
    await settle();
    lines = frameLines(instance.lastFrame());
    expect(lines.at(-2)).toContain('q quit • ↑/↓ jump file • j/k scroll • [/] block • ⏎ fold');
    expect(lines.find((line) => line.includes('src/b.ts') && line.includes('Copy path'))).toMatch(/Copy path.*Copy diff.*Copy file/);
    instance.unmount();
  });

  it('toggles a details table in place of the picture with v', async () => {
    const {instance} = mediaApp([LOGO]);
    await settle();
    expect(decodePlaceholders(instance.lastFrame()).length).toBe(100);
    instance.stdin.write('v');
    await settle();
    const text = frameLines(instance.lastFrame()).join('\n');
    expect(text).toContain('binary file changed');
    expect(text).toMatch(/format\s+PNG/);
    expect(text).toMatch(/pixels\s+200 × 100/);
    expect(text).toMatch(/ids\s+97fa3ee/);
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    instance.stdin.write('v');
    await settle();
    expect(decodePlaceholders(instance.lastFrame()).length).toBe(100);
    instance.unmount();
  });

  it('shows a modified image\'s after side alone, with no tab row', async () => {
    const modified = binaryMediaFile('docs/logo.png', 'modified', ['029ace0', '97fa3ee']);
    const {instance, calls} = mediaApp([modified], {sides: {...SIDES, '029ace0': sideInfo({width: 100, height: 100})}});
    await settle();
    const text = frameLines(instance.lastFrame()).join('\n');
    expect(text).toContain('after');
    expect(text).not.toContain('Side by side');
    expect(calls.filter((call) => call.type === 'render').map((call) => (call.request as {sides: Array<{side: string}>}).sides[0]!.side)).toEqual(['after']);
    expect(decodePlaceholders(instance.lastFrame())).toHaveLength(100);
    instance.unmount();
  });

  it('lists both sides of a modified image in the text view', async () => {
    const modified = binaryMediaFile('docs/logo.png', 'modified', ['029ace0', '97fa3ee']);
    const {instance} = mediaApp([modified], {sides: {...SIDES, '029ace0': sideInfo({width: 100, height: 50, bytes: 1_000})}});
    await settle();
    instance.stdin.write('v');
    await settle();
    const text = frameLines(instance.lastFrame()).join('\n');
    expect(text).toMatch(/pixels\s+100 × 50 → 200 × 100/);
    expect(text).toMatch(/bytes\s+1\.0 KB → 232 KB/);
    expect(text).toMatch(/ids\s+029ace0 → 97fa3ee/);
    instance.unmount();
  });

  it('opens the after side of a modified image', async () => {
    const modified = binaryMediaFile('docs/logo.png', 'modified', ['029ace0', '97fa3ee']);
    const {instance, calls} = mediaApp([modified], {sides: {...SIDES, '029ace0': sideInfo({width: 100, height: 100})}});
    await settle();
    instance.stdin.write('o');
    await settle();
    const exports = calls.filter((call) => call.type === 'exportCopy');
    expect(exports).toHaveLength(1);
    expect(exports[0]!.request).toMatchObject({side: {side: 'after', abbrevId: '97fa3ee'}});
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('opened logo.png (after)');
    instance.unmount();
  });

  it('says a file that changed on disk will refresh, or needs a restart when nothing watches', async () => {
    for (const [watching, wording] of [[true, 'changed on disk · refreshing'], [false, 'changed on disk · restart to see it']] as const) {
      const {instance} = mediaApp([LOGO], {sides: {'97fa3ee': {error: 'changed on disk · refreshing', state: 'stale'}}, watching});
      await settle();
      expect(frameLines(instance.lastFrame()).join('\n'), String(watching)).toContain(wording);
      instance.unmount();
    }
  });

  it('never renders a failed box again, however often the pane redraws', async () => {
    // Answered on a timer, as the worker is: a retry loop then shows up as
    // many render calls instead of starving the test's own timers.
    const fail = () => new Promise<RenderResult>((resolve) => setTimeout(() => resolve({ok: false, state: 'error', reason: 'could not decode image'}), 1));
    const {instance, calls} = mediaApp([LOGO, textFile('src/z.ts', 30)], {render: fail}, {columns: 120, rows: 20});
    await settle();
    for (const key of ['j', 'j', 'k', 'k', 'v', 'v']) {
      instance.stdin.write(key);
      await settle(3);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    const renders = calls.filter((call) => call.type === 'render');
    expect(renders).toHaveLength(1);
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('preview unavailable: could not decode image');
    instance.unmount();
  });

  it('never inspects a failed side again, however often the pane redraws', async () => {
    const {instance, calls} = mediaApp([LOGO, textFile('src/z.ts', 30)], {sides: {'97fa3ee': {error: 'not a PNG image'}}}, {columns: 120, rows: 20});
    await settle();
    for (const key of ['j', 'k', 'v', 'v', 'o']) {
      instance.stdin.write(key);
      await settle(3);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    expect(calls.filter((call) => call.type === 'inspect')).toHaveLength(1);
    expect(calls.filter((call) => call.type === 'render')).toEqual([]);
    instance.unmount();
  });

  it('keeps a picture scrolled just off screen, with no delete and no new transmit when it comes back', async () => {
    const {instance, graphicsWrites} = mediaApp([LOGO, textFile('src/z.ts', 30)], {}, {columns: 120, rows: 20});
    await settle();
    const [id] = new Set(decodePlaceholders(instance.lastFrame()).map((cell) => cell.id));
    expect(id).toBeDefined();
    for (let step = 0; step < 8; step += 1) {
      instance.stdin.write('j');
      await settle(2);
    }
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    for (let step = 0; step < 8; step += 1) {
      instance.stdin.write('k');
      await settle(2);
    }
    expect(new Set(decodePlaceholders(instance.lastFrame()).map((cell) => cell.id))).toEqual(new Set([id]));
    const commands = parseApc(graphicsWrites);
    expect(commands.filter((command) => command.a === 't')).toHaveLength(1);
    expect(commands.filter((command) => command.a === 'd')).toEqual([]);
    instance.unmount();
  });

  it('sends each picture once when the ones near the viewport pass the byte budget', async () => {
    // Noise does not compress; the budget holds one of these pictures.
    const noise = randomBytes(200 * 100 * 4);
    const png = pngFixture(200, 100, (x, y) => {
      const at = (y * 200 + x) * 4;
      return [noise[at]!, noise[at + 1]!, noise[at + 2]!, 255];
    });
    // The first picture on screen, the other two just below it.
    const files = [
      textFile('src/a.ts', 6),
      binaryMediaFile('docs/one.png', 'added', ['0000000', '1111111']),
      binaryMediaFile('docs/two.png', 'added', ['0000000', '2222222']),
      binaryMediaFile('docs/three.png', 'added', ['0000000', '3333333']),
    ];
    const sides = Object.fromEntries(['1111111', '2222222', '3333333'].map((id) => [id, sideInfo({width: 200, height: 100})]));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const {instance, graphicsWrites} = mediaApp(files, {sides, render: () => ({ok: true, png}), registry: {maxBytes: Math.ceil(png.byteLength / 3) * 4 + 1_000}});
      await settle(30);
      expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
      const transmits = parseApc(graphicsWrites).filter((command) => command.a === 't');
      expect(transmits.length).toBeLessThanOrEqual(3);
      expect(new Set(transmits.map((command) => command.i)).size).toBe(transmits.length);
      expect(errors.mock.calls.map((call) => String(call[0]))).not.toContainEqual(expect.stringContaining('Maximum update depth'));
      instance.unmount();
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps today\'s frames exactly with a service whose protocol is none', async () => {
    const files = [textFile('src/a.ts'), LOGO];
    const plain = renderFixture(buildFixture(files), SIZE);
    await settle();
    const fixture = buildFixture(files);
    const fake = fakeMediaService({caps: {...fakeMediaService().service.caps, protocol: 'none'}, sides: SIDES, review: fixture.review});
    const none = renderFixture({...fixture, media: fake.service}, SIZE);
    await settle();
    for (const key of ['j', 'o', 'v', 'O', '\u001B[B']) {
      plain.stdin.write(key);
      none.stdin.write(key);
      await settle(3);
    }
    expect(none.frames).toEqual(plain.frames);
    expect(fake.graphicsWrites).toEqual([]);
    expect(fake.calls).toEqual([]);
    plain.unmount();
    none.unmount();
  });
});
