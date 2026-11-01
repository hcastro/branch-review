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
  binaryMediaFile,
  BLOCKS_CAPS,
  buildFixture,
  decodePlaceholders,
  emitMousePressAt,
  expectTransmitBeforeUse,
  fakeMediaService,
  flush,
  frameLines,
  KITTY_CAPS,
  markdownFile,
  multiBlockFile,
  parseApc,
  recordingWriter,
  renderSized,
  sideInfo,
  svgMediaFile,
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
    links: [{href: 'https://example.com/docs', rects: [{left: 0, right: 400, top: 7 * ROW, bottom: 8 * ROW}]}],
    anchors: [],
  };
}

function setup({files = [PAGE, CODE, OTHER], env = {BRANCH_REVIEW_PANE: 'on'} as NodeJS.ProcessEnv, caps = CAPS as typeof CAPS | typeof BLOCKS_CAPS, rows = 150, layout, layoutFor, layoutDelay = 0, chrome = true, tile, animations = false, size = SIZE, readFile, mediaSides}: {
  // With media previews, the sides they read by id.
  mediaSides?: NonNullable<Parameters<typeof fakeMediaService>[0]>['sides'];
  layout?: PageLayout;
  // The layout at the sheet width asked for, as text wraps taller in a narrower sheet.
  layoutFor?: (cssWidth: number) => PageLayout;
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
      const answer: LayoutResult = {ok: true, layout: layoutFor?.(request.source.geometry.cssWidth) ?? layout ?? layoutOf(rows), document: `doc-${request.source.fragment.key}`, ...(text === undefined ? {} : {text})};
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
  const media = mediaSides ? fakeMediaService({caps: caps as typeof CAPS, sides: mediaSides, review: fixture.review}).service : undefined;
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
      {...(media ? {media} : {})}
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
    const layout = {...layoutOf(150), links: [{href: '#more', rects: [{left: 0, right: 400, top: 7 * ROW, bottom: 8 * ROW}]}], anchors: [{id: 'user-content-more', top: 60 * ROW}]};
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

  it('keeps the file and the block at the top when a resize lays the page out anew', async () => {
    // Each line's block is two page rows at the first width, three at the narrower one.
    let wide = 0;
    const layoutFor = (cssWidth: number): PageLayout => {
      wide = Math.max(wide, cssWidth);
      const each = cssWidth < wide ? 3 : 2;
      return {heightCss: 80 * each * ROW, blocks: Array.from({length: 80}, (_, index) => ({id: `b-${index}`, top: each * index * ROW, bottom: (each * index + each) * ROW, lines: [index + 1, index + 1] as const})), removed: [], links: [], anchors: []};
    };
    const {instance, pane, resize} = setup({files: [LONG, CODE], layoutFor, layoutDelay: 300});
    await settle();
    await press(instance, 'v');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    // The label row, then 19 page rows down.
    await press(instance, 'j'.repeat(20));
    let frame = instance.lastFrame();
    expect(decodePlaceholders(frame).find((cell) => cell.line === topRow(frame).index)?.row).toBe(19);
    const line = pane.lineAtRow('docs/long.md', 19);
    expect(line).toBe(10);
    // Narrower: another sheet width, so the page is laid out again, in 300 ms.
    resize({columns: 100, rows: 30});
    await new Promise((resolve) => setTimeout(resolve, 250));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    frame = instance.lastFrame();
    // At 100 columns the header shortens the path.
    expect(text(frame)).toContain('long.md');
    expect(text(frame)).toContain('file 1/2');
    const top = decodePlaceholders(frame).find((cell) => cell.line === topRow(frame).index)?.row;
    // Line 10's block, at three rows a line, half way in: rows 27 to 29.
    expect(top).toBeGreaterThanOrEqual(27);
    expect(pane.lineAtRow('docs/long.md', top!)).toBe(line);
    instance.unmount();
  });

  // A page of three changes, each a hunk of the file's diff, and an unchanged block between the first two.
  const THREE = multiBlockFile('docs/three.md', [3, 20, 40], 2);
  const THREE_LAYOUT: PageLayout = {
    heightCss: 80 * ROW,
    blocks: [
      {id: 'b-title', top: 0, bottom: 2 * ROW, lines: [1, 1]},
      {id: 'b-h0', top: 4 * ROW, bottom: 6 * ROW, lines: [3, 4], mark: 'added'},
      {id: 'b-same', top: 20 * ROW, bottom: 22 * ROW, lines: [10, 12]},
      {id: 'b-h1', top: 40 * ROW, bottom: 42 * ROW, lines: [20, 21], mark: 'added'},
      {id: 'b-h2', top: 60 * ROW, bottom: 62 * ROW, lines: [40, 41], mark: 'added'},
    ],
    removed: [],
    links: [],
    anchors: [],
  };

  it('copies with p the diff of the change at the top, and nothing on a block that didn\'t change', async () => {
    const {instance, writes} = setup({files: [THREE, CODE], layout: THREE_LAYOUT});
    await settle();
    await press(instance, 'v');
    await press(instance, ']]]');
    await press(instance, 'p');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('docs/three.md-h2-0');
    expect(writes[0]).not.toContain('docs/three.md-h1-0');
    await press(instance, 'b');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain('docs/three.md-h2-0');
    expect(writes[1]).not.toContain('docs/three.md-h0-0');
    instance.unmount();

    const again = setup({files: [THREE, CODE], layout: THREE_LAYOUT});
    await settle();
    await press(again.instance, 'v');
    // The label row, then down to the unchanged block's first row.
    await press(again.instance, 'j'.repeat(21));
    await press(again.instance, 'p');
    await press(again.instance, 'b');
    expect(again.writes).toEqual([]);
    expect(text(again.instance.lastFrame())).toContain('no change here · v shows the diff');
    again.instance.unmount();
  });

  // Hunks as git prints them by default, with three lines of context
  // around each change: line 10 added, line 25 added, and three lines
  // removed ahead of line 37.
  function contextFile(): FixtureFile {
    const path = 'docs/context.md';
    const raw: string[] = [];
    const rendered: string[] = [];
    const gutterOf = (line: number) => ` ${String(line).padStart(3)} ⋮ ${String(line).padStart(3)} │`;
    const added = (oldStart: number, newStart: number, at: number) => {
      raw.push(`@@ -${oldStart},6 +${newStart},7 @@`);
      rendered.push(`• ${path}:${newStart}: `);
      for (let line = newStart; line < newStart + 7; line += 1) {
        const body = line === at ? `line${line}-added` : `line${line}`;
        raw.push(`${line === at ? '+' : ' '}${body}`);
        rendered.push(`${gutterOf(line)}${body}`);
      }
    };
    added(7, 7, 10);
    added(21, 22, 25);
    raw.push('@@ -33,6 +34,3 @@');
    rendered.push(`• ${path}:34: `);
    for (const line of [34, 35, 36]) {
      raw.push(` line${line}`);
      rendered.push(`${gutterOf(line)}line${line}`);
    }
    for (const gone of [1, 2, 3]) {
      raw.push(`-gone${gone}`);
      rendered.push(` ${String(35 + gone).padStart(3)} ⋮     │gone${gone}`);
    }
    return {path, rawDiff: raw.join('\n'), rendered};
  }
  const contextLayout = (lines: [number, number], mark?: 'modified'): PageLayout => ({
    heightCss: 80 * ROW,
    blocks: [
      {id: 'b-title', top: 0, bottom: 2 * ROW, lines: [1, 1]},
      {id: 'b-first', top: 4 * ROW, bottom: 6 * ROW, lines: [7, 10], mark: 'modified'},
      {id: 'b-top', top: 20 * ROW, bottom: 30 * ROW, lines, ...(mark ? {mark} : {})},
    ],
    removed: [],
    links: [],
    anchors: [],
  });
  // `p` with the pane's top row on the block at lines `lines`.
  // `file`: another diff of the page. The pane opens where the diff's first
  // line is drawn, which for a file whose first hunk starts inside the block
  // is that block, so `g` takes it to the top first.
  const copiedAt = async (lines: [number, number], mark?: 'modified', file?: FixtureFile) => {
    const {instance, writes} = setup({files: [file ?? contextFile(), CODE], layout: contextLayout(lines, mark)});
    await settle();
    await press(instance, 'v');
    if (file) await press(instance, 'g');
    await press(instance, 'j'.repeat(21));
    await press(instance, 'p');
    const frame = text(instance.lastFrame());
    instance.unmount();
    return {writes, frame};
  };

  it('copies with p the hunk that changed the block\'s lines, not one whose context lines only run over them', async () => {
    // Lines 12 to 30: hunk 1's last context lines, and hunk 2's change at line 25.
    const spanning = await copiedAt([12, 30], 'modified');
    expect(spanning.writes).toHaveLength(1);
    expect(spanning.writes[0]).toContain('line25-added');
    expect(spanning.writes[0]).not.toContain('line10-added');
    // Lines 12 and 13 are only hunk 1's context: nothing changed there.
    const context = await copiedAt([12, 13]);
    expect(context.writes).toEqual([]);
    expect(context.frame).toContain('no change here · v shows the diff');
    // Lines removed ahead of line 37, after three lines of context.
    const removed = await copiedAt([37, 40], 'modified');
    expect(removed.writes).toHaveLength(1);
    expect(removed.writes[0]).toContain('gone2');
  });

  // A file whose hunks are given line by line, as git prints them: each
  // line a mark (' ', '+' or '-') and its text.
  function hunksFile(path: string, hunks: Array<{oldStart: number; newStart: number; lines: string[]}>): FixtureFile {
    const raw: string[] = [];
    const rendered: string[] = [];
    for (const {oldStart, newStart, lines} of hunks) {
      const olds = lines.filter((line) => !line.startsWith('+')).length;
      const news = lines.filter((line) => !line.startsWith('-')).length;
      raw.push(`@@ -${oldStart},${olds} +${newStart},${news} @@`);
      rendered.push(`• ${path}:${newStart}: `);
      let before = oldStart;
      let after = newStart;
      for (const line of lines) {
        const body = line.slice(1);
        raw.push(line);
        const left = line.startsWith('+') ? '   ' : String(before).padStart(3);
        const right = line.startsWith('-') ? '   ' : String(after).padStart(3);
        rendered.push(` ${left} ⋮ ${right} │${body}`);
        if (!line.startsWith('+')) before += 1;
        if (!line.startsWith('-')) after += 1;
      }
    }
    return {path, rawDiff: raw.join('\n'), rendered};
  }
  // A change far down the file, on no block the tests below put at the top,
  // so each file has two hunks as the pane tests above do.
  const far = (oldStart: number, newStart: number) => ({oldStart, newStart, lines: [' far1', '+far-added', ' far2']});

  it('copies with p the hunk that changed the most of a block\'s lines, where two hunks change it', async () => {
    // Lines 3 to 20: hunk 1 adds line 4, hunk 2 adds lines 15 and 16.
    const file = hunksFile('docs/context.md', [
      {oldStart: 1, newStart: 1, lines: [' l1', ' l2', ' l3', '+one-added4', ' l5', ' l6', ' l7']},
      {oldStart: 11, newStart: 12, lines: [' l12', ' l13', ' l14', '+two-added15', '+two-added16', ' l17', ' l18', ' l19']},
    ]);
    const spanning = await copiedAt([3, 20], 'modified', file);
    expect(spanning.writes).toHaveLength(1);
    expect(spanning.writes[0]).toContain('two-added15');
    expect(spanning.writes[0]).not.toContain('one-added4');
  });

  it('copies with p the hunk that removed a modified block\'s last line, and nothing on an unchanged block a removal comes after', async () => {
    // Lines 9 to 11 keep their text; the line after them, `gone12`, is removed.
    const tail = hunksFile('docs/context.md', [
      {oldStart: 9, newStart: 9, lines: [' line9', ' line10', ' line11', '-gone12', ' line12', ' line13', ' line14']},
      far(60, 59),
    ]);
    const lost = await copiedAt([9, 11], 'modified', tail);
    expect(lost.writes).toHaveLength(1);
    expect(lost.writes[0]).toContain('gone12');
    expect(lost.frame).not.toContain('no change here');

    // A paragraph and the blank line ahead of it are removed right after an
    // unchanged paragraph at line 9: that paragraph has nothing to copy.
    const neighbor = hunksFile('docs/context.md', [
      {oldStart: 6, newStart: 6, lines: [' line6', ' ', ' # Notes', ' Para one.', '-', '-Gone para.', ' ', ' Next para.', ' line12']},
      far(60, 58),
    ]);
    const unchanged = await copiedAt([9, 9], undefined, neighbor);
    expect(unchanged.writes).toEqual([]);
    expect(unchanged.frame).toContain('no change here · v shows the diff');
  });

  it('copies with p the hunk that cut a modified paragraph\'s last line, mid-file and at the end of the file', async () => {
    // `para four` removed from the paragraph at lines 3 to 5, before a blank line.
    const middle = hunksFile('docs/context.md', [
      {oldStart: 3, newStart: 3, lines: [' para one', ' para two', ' para three', '-para four', ' ', ' Next para.']},
      far(60, 59),
    ]);
    const cut = await copiedAt([3, 5], 'modified', middle);
    expect(cut.writes).toHaveLength(1);
    expect(cut.writes[0]).toContain('-para four');
    // The file's last paragraph goes from two lines to one, at line 24.
    const end = hunksFile('docs/context.md', [
      {oldStart: 1, newStart: 1, lines: [' l1', '+early-added', ' l2', ' l3', ' l4']},
      {oldStart: 21, newStart: 22, lines: [' Intro.', ' ', ' last one', '-last two']},
    ]);
    const atEnd = await copiedAt([24, 24], 'modified', end);
    expect(atEnd.writes).toHaveLength(1);
    expect(atEnd.writes[0]).toContain('-last two');
    expect(atEnd.writes[0]).not.toContain('early-added');
  });

  it('keeps v for the text view on a PNG and the source view on an SVG, and the pane stays on the diff', async () => {
    const files = [PAGE, binaryMediaFile('docs/logo.png', 'added', ['0000000', '97fa3ee']), svgMediaFile('docs/flow.svg')];
    const {instance, pane} = setup({files, mediaSides: {'97fa3ee': sideInfo({width: 200, height: 100, bytes: 232_000}), '35ecfd6': sideInfo({format: 'svg', width: 200, height: 100, bytes: 1_200, hasAlpha: true})}});
    await settle();
    const goTo = async (path: string) => {
      for (let step = 0; step < 4 && !frameLines(instance.lastFrame()).some((line) => line.includes(path) && line.includes('Copy path')); step += 1) await press(instance, '\u001B[B');
      expect(frameLines(instance.lastFrame()).some((line) => line.includes(path) && line.includes('Copy path'))).toBe(true);
    };
    await goTo('docs/logo.png');
    expect(text(instance.lastFrame())).not.toMatch(/format\s+PNG/);
    await press(instance, 'v');
    // The image's details in place of its picture.
    expect(text(instance.lastFrame())).toMatch(/format\s+PNG/);
    expect(pane.mode()).toBe('diff');
    await press(instance, 'v');
    expect(text(instance.lastFrame())).not.toMatch(/format\s+PNG/);
    expect(pane.mode()).toBe('diff');
    await goTo('docs/flow.svg');
    expect(text(instance.lastFrame())).toContain('picture · rendered from the SVG source');
    await press(instance, 'v');
    // Its source alone, unfolded, with no picture.
    expect(text(instance.lastFrame())).not.toContain('picture · rendered from the SVG source');
    expect(text(instance.lastFrame())).not.toContain('lines folded');
    expect(pane.mode()).toBe('diff');
    expect(text(instance.lastFrame())).not.toContain('rendered here');
    instance.unmount();
  });

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

  it('copies nothing for a link that holds control characters, and says why', async () => {
    const layout = {...layoutOf(150), links: [{href: 'https://example.com/a\u001b]52;c;Zm9v\u0007', rects: [{left: 0, right: 400, top: 7 * ROW, bottom: 8 * ROW}]}]};
    const {instance, writes} = setup({layout});
    await settle();
    await press(instance, 'v');
    const lines = frameLines(instance.lastFrame());
    const top = lines.findIndex((line) => stripAnsi(line).includes('rendered here')) + 1;
    const diffLeft = stripAnsi(lines[top]!).indexOf('││') + 1;
    await emitMousePressAt(diffLeft + 2 + 3 + 10, top + 1 + 7);
    await settle();
    expect(writes).toEqual([]);
    expect(text(instance.lastFrame())).toContain('this link holds control characters · not copied');
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
