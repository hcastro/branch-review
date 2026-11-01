import React from 'react';
import stripAnsi from 'strip-ansi';
import {afterEach, describe, expect, it} from 'vitest';
import {App} from '../src/ui/App.js';
import {fileKey} from '../src/git.js';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import {pngHeaderOnly} from './media-helpers.js';
import type {FragmentRequest, LayoutResult, RenderedBackend, TileRequest, TileResult} from '../src/rendered/backend.js';
import {createRenderedPane, PANE_NEEDS_CHROME, type RenderedPane} from '../src/rendered/pane.js';
import type {PageLayout} from '../src/rendered/plan.js';
import {
  BLOCKS_CAPS,
  buildFixture,
  decodePlaceholders,
  emitMousePressAt,
  expectTransmitBeforeUse,
  flush,
  frameLines,
  KITTY_CAPS,
  markdownFile,
  parseApc,
  recordingWriter,
  renderSized,
  type FixtureFile,
  type TimelineEntry,
} from './ui-fixtures.js';
import {cleanupTempDirs} from './core-helpers.js';

// The page in the diff pane: `v` on a markdown file swaps its diff rows for
// placeholder rows of page tiles, every tile sent before a frame names it,
// the gutter's change marks as text beside them; `v` again is the diff in
// one frame. Scrolling keeps at most ten tiles live, a resize draws new
// tiles and frees the old, and the pane holds its crossing until the tiles
// on screen are in. Not offered, the app is exactly as before.

afterEach(cleanupTempDirs);

const SIZE = {columns: 120, rows: 30};
const CAPS = {...KITTY_CAPS, cellPx: {w: 10, h: 20}, bg: '#101418', scheme: 'dark' as const};
const ROW = 20 / 1.25;

const PAGE = markdownFile('docs/page.md', ['# Title', '', 'A new paragraph.', '', 'See [the docs](https://example.com/docs).', '', 'More text.']);
const CODE: FixtureFile = {path: 'src/app.ts', rawDiff: '@@ -0,0 +1,2 @@\n+one\n+two', rendered: ['• src/app.ts:1: ', ' 1 ⋮ 1 │one', ' 2 ⋮ 2 │two']};
const OTHER = markdownFile('docs/other.md', ['# Other', '', 'Text.']);

// A page `rows` pane rows tall: the title, an added paragraph on rows 3 to 5
// with a link in it, and a modified block at row 60.
function layoutOf(rows: number): PageLayout {
  return {
    heightCss: rows * ROW,
    blocks: [
      {id: 'b-title', top: 0, bottom: 2 * ROW, lines: [1, 1]},
      {id: 'b-new', top: 3 * ROW, bottom: 6 * ROW, lines: [3, 3], mark: 'added'},
      {id: 'b-link', top: 7 * ROW, bottom: 8 * ROW, lines: [5, 5]},
      {id: 'b-more', top: 60 * ROW, bottom: 61 * ROW, lines: [7, 7], mark: 'modified'},
    ],
    removed: [],
    links: [{href: 'https://example.com/docs', left: 0, right: 400, top: 7 * ROW, bottom: 8 * ROW}],
    anchors: [],
  };
}

function setup({files = [PAGE, CODE, OTHER], env = {BRANCH_REVIEW_PANE: 'on'} as NodeJS.ProcessEnv, caps = CAPS as typeof CAPS | typeof BLOCKS_CAPS, rows = 150, layout, layoutDelay = 0, chrome = true, tile, animations = false, size = SIZE, readFile}: {
  layout?: PageLayout;
  // What reading a file from disk gives now, when it isn't the text the page was laid out from.
  readFile?: (path: string) => string | null;
  // How long the layout takes, as on a cold Chromium start.
  layoutDelay?: number;
  files?: FixtureFile[];
  env?: NodeJS.ProcessEnv;
  caps?: typeof CAPS | typeof BLOCKS_CAPS;
  rows?: number;
  chrome?: boolean;
  tile?: (request: TileRequest) => Promise<TileResult>;
  animations?: boolean;
  size?: {columns: number; rows: number};
} = {}) {
  const fixture = buildFixture(files);
  const timeline: TimelineEntry[] = [];
  const graphics: string[] = [];
  const registry = createImageRegistry({write: (sequence) => {
    graphics.push(sequence);
    timeline.push({kind: 'apc', seq: sequence});
  }, random: () => 0});
  const tiles: TileRequest[] = [];
  // The text each page is laid out from.
  const sources: Record<string, string> = {'docs/page.md': '# Title\n\nA new paragraph.\n\nSee [the docs](https://example.com/docs).\n\nMore text.\n'};
  const backend: Pick<RenderedBackend, 'layout' | 'tile' | 'disabledReason'> = {
    layout: async (request): Promise<LayoutResult> => {
      const text = sources[request.source.fragment.path];
      const answer: LayoutResult = {ok: true, layout: layout ?? layoutOf(rows), document: `doc-${request.source.fragment.key}`, ...(text === undefined ? {} : {text})};
      return layoutDelay ? new Promise((resolve) => setTimeout(() => resolve(answer), layoutDelay)) : answer;
    },
    tile: async (request) => {
      tiles.push(request);
      if (tile) return tile(request);
      const {geometry} = request.source;
      const height = Math.min(geometry.tileRows, request.rows - request.index * geometry.tileRows) * geometry.cellPx.h;
      return {ok: true, png: pngHeaderOnly(geometry.sheetCols * geometry.cellPx.w, height)};
    },
    disabledReason: () => null,
  };
  const markdown = new Set(files.filter((file) => file.path.endsWith('.md')).map((file) => fileKey({path: file.path})));
  const fragment = (path: string): FragmentRequest => ({cwd: '/repo', key: `frag-${path.replace(/\W/g, '')}`, path, status: 'modified', source: {kind: 'blob', id: 'abcdef1'}, groups: [], links: {}, assets: {base: null, after: {tree: 'HEAD'}, epoch: 0}});
  const pane: RenderedPane = createRenderedPane({
    backend,
    registry,
    caps: caps as typeof CAPS,
    env,
    chrome: () => (chrome ? {path: '/fake/chrome-headless-shell', headless: '--headless'} : null),
    source: (key) => (markdown.has(key) ? {fragment: fragment(key), base: 'development'} : null),
    fileForAlias: () => null,
  });
  const writes: string[] = [];
  const element = (dimensions: {columns: number; rows: number}) => (
    <App
      base="development"
      branch="HEAD"
      sections={fixture.sections}
      branchMetrics={fixture.review.metrics}
      review={fixture.review}
      copyWriter={recordingWriter(writes)}
      readFileContent={(file) => (readFile ? readFile(file.path) : sources[file.path] ?? null)}
      dimensions={dimensions}
      graphics={caps}
      animations={animations}
      rendered={{focus: () => undefined, pane}}
    />
  );
  const instance = renderSized(element(size), size, timeline);
  const resize = (dimensions: {columns: number; rows: number}) => instance.rerender(element(dimensions));
  return {instance, pane, registry, graphics, timeline, tiles, writes, resize};
}

const settle = (times = 8) => flush(times);
// A frame's lines with their colors.
const raw = (frame: string | undefined) => (frame ?? '').split('\n');
const text = (frame: string | undefined) => frameLines(frame).map((line) => stripAnsi(line)).join('\n');
// Each key on its own, as a person types them: Ink reads one write as one input.
async function press(instance: ReturnType<typeof setup>['instance'], keys: string, times = 8) {
  for (const key of keys.startsWith('\u001B') ? [keys] : [...keys]) {
    instance.stdin.write(key);
    await settle(times);
  }
}

describe('the page in the pane', () => {
  it('swaps the markdown diff for page tiles on v, each sent before a frame names it, with the gutter beside them', async () => {
    const {instance, timeline, graphics} = setup();
    await settle();
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    await press(instance, 'v');
    const cells = decodePlaceholders(instance.lastFrame());
    expect(cells.length).toBeGreaterThan(0);
    const ids = new Set(cells.map((cell) => cell.id));
    expect(ids.size).toBe(1);
    // Rows of the first tile in order, from its first row.
    const rows = [...new Set(cells.map((cell) => cell.row))];
    expect(rows[0]).toBe(0);
    expect(rows).toEqual(rows.map((_, index) => index));
    expectTransmitBeforeUse(timeline);
    expect(parseApc(graphics).find((command) => command.a === 'p')).toMatchObject({U: 1, c: 79, r: 40});
    // The added paragraph's rows carry a green bar in the gutter, as text.
    const lines = raw(instance.lastFrame());
    const barred = lines.filter((line) => stripAnsi(line).includes('│  ▌ '));
    expect(barred).toHaveLength(3);
    expect(barred[0]).toContain('\u001B[32m▌');
    instance.unmount();
  });

  it('says it is the page in the header and the footer, with the Diff button first', async () => {
    const {instance} = setup();
    await settle();
    expect(text(instance.lastFrame())).toContain('v here');
    await press(instance, 'v');
    const shown = text(instance.lastFrame());
    // The Diff button leads; this review has no split, so no Rendered button.
    expect(shown).toMatch(/docs\/page\.md +╭─Diff─╮ ╭─Copy path─╮/);
    expect(shown).toContain('rendered here · [ ] between changes · c copies a block');
    expect(shown).toContain('v diff • [/] change • j/k scroll • c copy block');
    expect(shown).toContain('◆ rendered · local');
    instance.unmount();
  });

  it('goes back to the diff in one frame on v, with no placeholder cell left', async () => {
    const {instance} = setup();
    await settle();
    await press(instance, 'v');
    expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
    const before = instance.frames.length;
    instance.stdin.write('v');
    await settle();
    const next = instance.frames[before]!;
    expect(decodePlaceholders(next)).toEqual([]);
    expect(text(next)).toContain('A new paragraph.');
    instance.unmount();
  });

  it('keeps the page on while moving between markdown files, and the diff on other files', async () => {
    const {instance} = setup({rows: 12});
    await settle();
    await press(instance, 'v');
    await press(instance, '\u001B[B');
    expect(text(instance.lastFrame())).toContain('src/app.ts');
    expect(text(instance.lastFrame())).toContain('one');
    await press(instance, '\u001B[B');
    const shown = instance.lastFrame();
    expect(text(shown)).toContain('docs/other.md');
    expect(decodePlaceholders(shown).length).toBeGreaterThan(0);
    instance.unmount();
  });

  it('keeps at most 10 tiles live while scrolling a page of 40 tiles, every frame naming only sent ids', async () => {
    // A change at the top of every tile, so ] steps the pane a tile at a time.
    const tall: PageLayout = {...layoutOf(40 * 40), blocks: Array.from({length: 40}, (_, index) => ({id: `b-${index}`, top: (index * 40 + 1) * ROW, bottom: (index * 40 + 2) * ROW, lines: [index + 1, index + 1] as const, mark: index % 2 === 0 ? 'added' as const : 'modified' as const}))};
    const {instance, registry, timeline, graphics} = setup({layout: tall});
    await settle();
    await press(instance, 'v');
    let most = 0;
    for (let step = 0; step < 40; step += 1) {
      await press(instance, ']', 4);
      most = Math.max(most, registry.liveCount('page'));
    }
    for (let step = 0; step < 40; step += 1) {
      await press(instance, '[', 4);
      most = Math.max(most, registry.liveCount('page'));
    }
    expect(most).toBeLessThanOrEqual(10);
    expect(most).toBeGreaterThan(1);
    // Each tile went out at most once down and once back up: no send and evict loop.
    expect(parseApc(graphics).filter((command) => command.a === 't').length).toBeLessThanOrEqual(80);
    expectTransmitBeforeUse(timeline);
    instance.unmount();
  }, 60_000);

  it('draws new tiles on a resize and frees the old ones', async () => {
    const {instance, graphics, timeline, resize} = setup();
    await settle();
    await press(instance, 'v');
    const before = new Set(decodePlaceholders(instance.lastFrame()).map((cell) => cell.id));
    // Narrower: a new geometry once the width settles, so new tiles.
    resize({columns: 100, rows: 30});
    await new Promise((resolve) => setTimeout(resolve, 250));
    await settle();
    const after = decodePlaceholders(instance.lastFrame());
    expect(after.length).toBeGreaterThan(0);
    for (const id of new Set(after.map((cell) => cell.id))) expect(before.has(id)).toBe(false);
    const deleted = parseApc(graphics).filter((command) => command.a === 'd').map((command) => command.i);
    for (const id of before) expect(deleted).toContain(id);
    expectTransmitBeforeUse(timeline);
    instance.unmount();
  });

  it('holds the crossing on the mosaic while the tiles are on their way, and says it is developing', async () => {
    let answer: (() => void) | null = null;
    const {instance} = setup({
      animations: true,
      tile: (request) => new Promise((resolve) => {
        answer = () => resolve({ok: true, png: pngHeaderOnly(request.source.geometry.sheetCols * 10, request.source.geometry.tileRows * 20)});
      }),
    });
    await settle();
    await press(instance, 'v');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await settle();
    expect(text(instance.lastFrame())).toContain('developing');
    expect(instance.frames.every((frame) => decodePlaceholders(frame).length === 0)).toBe(true);
    answer!();
    await new Promise((resolve) => setTimeout(resolve, 900));
    await settle();
    expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
    expect(text(instance.lastFrame())).not.toContain('developing');
    instance.unmount();
  });

  it('holds the crossing on a cold Chromium start, while the page is still laying out, and develops only once its tiles are in', async () => {
    const {instance, tiles} = setup({animations: true, layoutDelay: 2_000});
    await settle();
    await press(instance, 'v');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await settle();
    // No tile exists yet to wait for, and still the crossing holds.
    expect(text(instance.lastFrame())).toContain('developing');
    expect(text(instance.lastFrame())).not.toContain('laying out the page');
    expect(tiles).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await settle();
    expect(tiles.length).toBeGreaterThan(0);
    expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
    expect(text(instance.lastFrame())).not.toContain('developing');
    instance.unmount();
  });

  it('scrolls to the heading a link on the page names when it is clicked', async () => {
    const layout = {...layoutOf(150), links: [{href: '#more', left: 0, right: 400, top: 7 * ROW, bottom: 8 * ROW}], anchors: [{id: 'user-content-more', top: 60 * ROW}]};
    const {instance, writes} = setup({layout});
    await settle();
    await press(instance, 'v');
    let lines = frameLines(instance.lastFrame());
    const top = lines.findIndex((line) => stripAnsi(line).includes('rendered here')) + 1;
    const diffLeft = stripAnsi(lines[top]!).indexOf('││') + 1;
    await emitMousePressAt(diffLeft + 2 + 3 + 10, top + 1 + 7);
    await settle();
    // Page row 60, the modified block, is at the top of the pane.
    lines = raw(instance.lastFrame());
    expect(lines[top]).toContain('\u001B[33m▌');
    expect(writes).toEqual([]);
    instance.unmount();
  });

  // An 80-line page, one block of two page rows per source line, then a code file.
  const LONG = markdownFile('docs/long.md', Array.from({length: 80}, (_, index) => `Line ${index + 1}`));
  const LONG_LAYOUT: PageLayout = {heightCss: 160 * ROW, blocks: Array.from({length: 80}, (_, index) => ({id: `b-${index}`, top: 2 * index * ROW, bottom: (2 * index + 2) * ROW, lines: [index + 1, index + 1] as const})), removed: [], links: [], anchors: []};
  // The first row under the file header: the diff's top line, or the page's.
  const topRow = (frame: string | undefined) => {
    const lines = frameLines(frame);
    return {line: lines[lines.findIndex((each) => /file \d+\/\d+|rendered here/.test(stripAnsi(each))) + 1] ?? '', index: lines.findIndex((each) => /file \d+\/\d+|rendered here/.test(stripAnsi(each))) + 1};
  };

  for (const layoutDelay of [0, 300]) {
    it(`keeps its place across v both ways, scrolled into the file${layoutDelay ? ', with the layout on its way' : ''}`, async () => {
      const {instance} = setup({files: [LONG, CODE], layout: LONG_LAYOUT, layoutDelay});
      await settle();
      await press(instance, 'j'.repeat(20));
      const top = Number(/│Line (\d+)/.exec(stripAnsi(topRow(instance.lastFrame()).line))![1]);
      expect(top).toBeGreaterThan(10);
      await press(instance, 'v');
      if (layoutDelay) {
        expect(text(instance.lastFrame())).toContain('laying out the page');
        await new Promise((resolve) => setTimeout(resolve, layoutDelay + 100));
        await settle();
      }
      let frame = instance.lastFrame();
      expect(text(frame)).toContain('docs/long.md');
      expect(text(frame)).not.toContain('file 2/2');
      // The page's top row is the top line's block: page row 2 × (line − 1), in the first tile.
      const at = topRow(frame).index;
      const cells = decodePlaceholders(frame).filter((cell) => cell.line === at);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells[0]!.row).toBe(2 * (top - 1));
      // Five page rows down, then back: the diff at the line the page showed at the top.
      await press(instance, 'jjjjj');
      frame = instance.lastFrame();
      expect(decodePlaceholders(frame).find((cell) => cell.line === topRow(frame).index)?.row).toBe(2 * (top - 1) + 5);
      await press(instance, 'v');
      expect(stripAnsi(topRow(instance.lastFrame()).line)).toContain(`│Line ${top + 2}`);
      instance.unmount();
    });
  }

  it('copies the markdown of the block at the top with c', async () => {
    const {instance, writes} = setup();
    await settle();
    await press(instance, 'v');
    // The page's label row, then the title's rows: down to the added paragraph.
    await press(instance, 'jjjj');
    await press(instance, 'c');
    expect(writes.at(-1)).toBe('A new paragraph.');
    expect(text(instance.lastFrame())).toContain('Copied block');
    instance.unmount();
  });

  it('copies the block as the page shows it, after the file changed on disk', async () => {
    const {instance, writes} = setup({readFile: () => 'Two new lines\nat the top.\n# Title\n\nA new paragraph.\n'});
    await settle();
    await press(instance, 'v');
    await press(instance, 'jjjj');
    await press(instance, 'c');
    expect(writes.at(-1)).toBe('A new paragraph.');
    expect(text(instance.lastFrame())).toContain('Copied block');
    instance.unmount();
  });

  it('copies the block, and stays up, when the file can no longer be read', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const {instance, writes} = setup({readFile: () => {
        throw new Error('docs/page.md no longer exists');
      }});
      await settle();
      await press(instance, 'v');
      await press(instance, 'jjjj');
      await press(instance, 'c');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
      expect(writes.at(-1)).toBe('A new paragraph.');
      expect(text(instance.lastFrame())).toContain('Copied block');
      instance.unmount();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('hops between changes with ] and [', async () => {
    const {instance} = setup();
    await settle();
    await press(instance, 'v');
    await press(instance, ']');
    // The added paragraph's first row is at the top of the pane.
    let lines = raw(instance.lastFrame());
    const top = lines.findIndex((line) => stripAnsi(line).includes('rendered here')) + 1;
    expect(stripAnsi(lines[top]!)).toContain('│  ▌ ');
    await press(instance, ']');
    lines = raw(instance.lastFrame());
    expect(lines[top]).toContain('\u001B[33m▌');
    await press(instance, '[');
    lines = raw(instance.lastFrame());
    expect(lines[top]).toContain('\u001B[32m▌');
    instance.unmount();
  });

  it('copies a web link a click lands on, and opens nothing', async () => {
    const {instance, writes} = setup();
    await settle();
    await press(instance, 'v');
    const lines = frameLines(instance.lastFrame());
    const top = lines.findIndex((line) => stripAnsi(line).includes('rendered here')) + 1;
    // Page row 7 holds the link, under the label row; the sheet starts
    // after the diff pane's border, a space and the gutter.
    const diffLeft = stripAnsi(lines[top]!).indexOf('││') + 1;
    await emitMousePressAt(diffLeft + 2 + 3 + 10, top + 1 + 7);
    await settle();
    expect(writes.at(-1)).toBe('https://example.com/docs');
    expect(text(instance.lastFrame())).toContain('Copied link');
    instance.unmount();
  });
});

describe('the page in the pane at the owner\'s width', () => {
  it('keeps a scrolled frame of tiles within budget at 226×67', async () => {
    const size = {columns: 226, rows: 67};
    const {instance} = setup({rows: 400, size});
    await settle();
    await press(instance, 'v');
    const costs: number[] = [];
    const bytes: number[] = [];
    for (let step = 0; step < 10; step += 1) {
      const from = instance.frames.length;
      const started = performance.now();
      instance.stdin.write('j');
      await settle(4);
      costs.push(performance.now() - started);
      for (const frame of instance.frames.slice(from)) bytes.push(Buffer.byteLength(frame));
    }
    expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
    const largest = Math.max(...bytes);
    expect(largest).toBeLessThanOrEqual(130 * 1024);
    const median = [...costs].sort((left, right) => left - right)[Math.floor(costs.length / 2)]!;
    // Printed for the report: what one scroll of a full pane of tiles costs.
    console.log(`pane at 226x67: largest frame ${largest} bytes, median ${Math.round(median)} ms from key to settled frame`);
    instance.unmount();
  });
});

describe('when the page in the pane is not offered', () => {
  it('without BRANCH_REVIEW_PANE=on, v does nothing on markdown and the footer does not name it', async () => {
    const {instance, tiles} = setup({env: {}});
    await settle();
    const before = text(instance.lastFrame());
    expect(before).not.toContain('v here');
    await press(instance, 'v');
    expect(text(instance.lastFrame())).toBe(before);
    expect(tiles).toEqual([]);
    instance.unmount();
  });

  it('in a terminal without Kitty images, v does nothing new', async () => {
    const {instance, tiles} = setup({caps: BLOCKS_CAPS});
    await settle();
    await press(instance, 'v');
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    expect(text(instance.lastFrame())).not.toContain('rendered here');
    expect(tiles).toEqual([]);
    instance.unmount();
  });

  it('names Chrome when none is found, and keeps the diff', async () => {
    const {instance} = setup({chrome: false});
    await settle();
    await press(instance, 'v');
    expect(text(instance.lastFrame())).toContain(PANE_NEEDS_CHROME.slice(0, 40));
    expect(text(instance.lastFrame())).toContain('A new paragraph.');
    instance.unmount();
  });
});
