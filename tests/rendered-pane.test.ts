import {describe, expect, it} from 'vitest';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import type {PlanBoxRow, PlanRow} from '../src/media/layout.js';
import type {FragmentRequest, LayoutRequest, LayoutResult, RenderedBackend, TileRequest, TileResult} from '../src/rendered/backend.js';
import {fileAlias} from '../src/rendered/keys.js';
import {createRenderedPane, PANE_NEEDS_CELL_SIZE, PANE_NEEDS_CHROME} from '../src/rendered/pane.js';
import type {PageLayout} from '../src/rendered/plan.js';
import {KITTY_CAPS, BLOCKS_CAPS, parseApc, pngHeaderOnly} from './media-helpers.js';

// The UI side of the in-pane view: whether it is offered, what `v` says
// when it can't draw, the rows a page takes once Chromium laid it out, the
// tiles near the viewport sent before any row names them and kept within
// the page pool, and what a row or a click on one means: a block to copy,
// a change to hop to, a link to follow.

const CAPS = {...KITTY_CAPS, cellPx: {w: 10, h: 20}, bg: '#101418', scheme: 'dark' as const};
// 200 inner columns, 10 by 20 px cells: dpr 1.25, 122 columns of sheet.
const GEOM = {innerCols: 200, viewportRows: 30};

// The page name another file of the review goes by, as the service names it.
const OTHER_ALIAS = fileAlias('docs/other.md');

// A page 150 rows tall at that scale, with an added block, a modified one,
// a removed marker, links of every kind and two headings.
const ROW = 20 / 1.25;
const LAYOUT: PageLayout = {
  heightCss: 150 * ROW,
  blocks: [
    {id: 'b-title', top: 0, bottom: 2 * ROW, lines: [1, 1]},
    {id: 'b-intro', top: 3 * ROW, bottom: 6 * ROW, lines: [3, 5], mark: 'added'},
    {id: 'b-table', top: 50 * ROW, bottom: 52 * ROW, lines: [20, 24]},
    {id: 'b-row', top: 51 * ROW, bottom: 52 * ROW, lines: [23, 23], mark: 'modified'},
    {id: 'b-end', top: 100 * ROW, bottom: 101 * ROW, lines: [40, 40]},
  ],
  removed: [{top: 30 * ROW, bottom: 31 * ROW}],
  links: [
    {href: '#user-content-usage', left: 16, right: 80, top: 4 * ROW, bottom: 5 * ROW},
    {href: `${OTHER_ALIAS}.html#user-content-x`, left: 100, right: 180, top: 4 * ROW, bottom: 5 * ROW},
    {href: 'https://example.com/docs', left: 200, right: 300, top: 4 * ROW, bottom: 5 * ROW},
    {href: 'javascript:alert(1)', left: 320, right: 400, top: 4 * ROW, bottom: 5 * ROW},
  ],
  anchors: [{id: 'user-content-usage', top: 100 * ROW}],
};

const FRAGMENT: FragmentRequest = {cwd: '/repo', key: 'frag-abc', path: 'docs/page.md', status: 'modified', source: {kind: 'blob', id: 'abcdef1'}, groups: [], links: {}, assets: {base: null, after: {tree: 'HEAD'}, epoch: 0}};

// The worker names a tile document by what it draws; here, by its fragment.
const documentOf = (request: LayoutRequest) => `doc-${request.source.fragment.key}`;

function setup({env = {BRANCH_REVIEW_PANE: 'on'}, caps = CAPS, chrome = true, layout = async (request): Promise<LayoutResult> => ({ok: true, layout: LAYOUT, document: documentOf(request)}), tile, disabled = null as string | null | (() => string | null), registry: registryOptions = {}, now}: {
  env?: NodeJS.ProcessEnv;
  caps?: typeof CAPS | typeof BLOCKS_CAPS;
  chrome?: boolean;
  layout?: (request: LayoutRequest) => Promise<LayoutResult>;
  tile?: (request: TileRequest) => Promise<TileResult>;
  disabled?: string | null | (() => string | null);
  registry?: Parameters<typeof createImageRegistry>[0]['page'];
  now?: () => number;
} = {}) {
  const writes: string[] = [];
  const registry = createImageRegistry({write: (sequence) => writes.push(sequence), random: () => 0, ...(registryOptions ? {page: registryOptions} : {}), ...(now ? {now} : {})});
  const layouts: LayoutRequest[] = [];
  const tiles: Array<TileRequest & {priority?: number}> = [];
  const backend: Pick<RenderedBackend, 'layout' | 'tile' | 'disabledReason'> = {
    layout: async (request) => {
      layouts.push(request);
      return layout(request);
    },
    tile: async (request, _signal, priority) => {
      tiles.push({...request, priority});
      if (tile) return tile(request);
      const range = request.source.geometry;
      return {ok: true, png: pngHeaderOnly(range.sheetCols * range.cellPx.w, Math.min(range.tileRows, request.rows - request.index * range.tileRows) * range.cellPx.h)};
    },
    disabledReason: () => (typeof disabled === 'function' ? disabled() : disabled),
  };
  const pane = createRenderedPane({
    backend,
    registry,
    caps,
    env,
    chrome: () => (chrome ? {path: '/fake/chrome-headless-shell', headless: '--headless'} : null),
    source: (fileKey) => (fileKey === 'docs/page.md' ? {fragment: FRAGMENT, base: 'main'} : null),
    fileForAlias: (alias) => (alias === OTHER_ALIAS ? 'docs/other.md' : null),
  });
  return {pane, registry, writes, layouts, tiles};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const boxRows = (rows: PlanRow[]) => rows.filter((row): row is PlanBoxRow => row.type === 'box');

async function ready(env = setup()) {
  env.pane.enter();
  env.pane.rows('docs/page.md', GEOM);
  await flush();
  return env;
}

describe('whether the pane is offered', () => {
  it('is offered only with BRANCH_REVIEW_PANE=on in a terminal that draws Kitty images', () => {
    expect(setup().pane.offered()).toBe(true);
    expect(setup({env: {}}).pane.offered()).toBe(false);
    expect(setup({env: {BRANCH_REVIEW_PANE: 'off'}}).pane.offered()).toBe(false);
    expect(setup({caps: {...BLOCKS_CAPS, bg: '#000000', scheme: 'dark'} as typeof CAPS}).pane.offered()).toBe(false);
  });

  it('names Chrome and r when no browser is found, and stays on the diff', () => {
    const {pane} = setup({chrome: false});
    expect(pane.enter()).toEqual({ok: false, message: PANE_NEEDS_CHROME});
    expect(PANE_NEEDS_CHROME).toBe('the in-pane view needs Chrome · set BRANCH_REVIEW_CHROME or install chrome-headless-shell · r opens it rendered');
    expect(pane.mode()).toBe('diff');
  });

  it('names the cell size when the terminal didn\'t report it, since a tile sized from a guess is scaled', () => {
    for (const cellPxSource of ['csi14', 'default'] as const) {
      const {pane} = setup({caps: {...CAPS, cellPxSource}});
      expect(pane.offered()).toBe(true);
      expect(pane.enter()).toEqual({ok: false, message: PANE_NEEDS_CELL_SIZE});
      expect(pane.mode()).toBe('diff');
    }
    expect(PANE_NEEDS_CELL_SIZE).toBe("the terminal didn't report its cell size, which sharp tiles need · r opens it rendered");
  });

  it('draws at the scale BRANCH_REVIEW_PANE_DPR names, for comparing it with the type-matched one', () => {
    const scaleOf = (env: NodeJS.ProcessEnv) => {
      const {pane, layouts} = setup({env: {BRANCH_REVIEW_PANE: 'on', ...env}});
      pane.enter();
      pane.rows('docs/page.md', GEOM);
      return layouts[0]!.source.geometry.dpr;
    };
    expect(scaleOf({})).toBe(1.25);
    expect(scaleOf({BRANCH_REVIEW_PANE_DPR: '2'})).toBe(2);
    expect(scaleOf({BRANCH_REVIEW_PANE_DPR: '1.75'})).toBe(1.75);
    expect(scaleOf({BRANCH_REVIEW_PANE_DPR: 'sharp'})).toBe(1.25);
    expect(scaleOf({BRANCH_REVIEW_PANE_DPR: '-1'})).toBe(1.25);
  });

  it('says the rendered view is off when its worker gave up', () => {
    const {pane} = setup({disabled: 'rendered view turned off: timed out'});
    expect(pane.enter()).toEqual({ok: false, message: '✗ rendered view turned off: timed out'});
  });

  it('enters and leaves in one step, and covers only the review\'s markdown', () => {
    const {pane} = setup();
    expect(pane.enter()).toEqual({ok: true});
    expect(pane.mode()).toBe('rendered');
    expect(pane.covers('docs/page.md')).toBe(true);
    expect(pane.covers('src/app.ts')).toBe(false);
    pane.leave();
    expect(pane.mode()).toBe('diff');
  });
});

describe('a page in the pane', () => {
  it('asks for the layout once, in the terminal scheme and background, and says it is laying out', async () => {
    const {pane, layouts} = setup();
    pane.enter();
    const first = pane.rows('docs/page.md', GEOM);
    pane.rows('docs/page.md', GEOM);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]!.source).toMatchObject({fragment: FRAGMENT, scheme: 'dark', bg: '#101418', base: 'main', chrome: {path: '/fake/chrome-headless-shell'}});
    expect(layouts[0]!.source.geometry).toMatchObject({dpr: 1.25, sheetCols: 122});
    expect(first.map((row) => row.type)).toEqual(['text', 'text']);
    expect(JSON.stringify(first[1])).toContain('laying out the page');
    await flush();
    const rows = pane.rows('docs/page.md', GEOM);
    expect(rows[0]!.type).toBe('text');
    expect(boxRows(rows)).toHaveLength(150);
  });

  it('draws a page the repo made millions of pixels tall to a cap, says the rest opens with r, and cuts no tile past it', async () => {
    // A table cell with height="40000000", laid out at Chromium's largest height.
    const towering: PageLayout = {...LAYOUT, heightCss: 33_554_431.98, blocks: [...LAYOUT.blocks, {id: 'b-tall', top: 200 * ROW, bottom: 33_554_431, lines: [50, 50], mark: 'modified'}]};
    const {pane, tiles} = setup({layout: async (request) => ({ok: true, layout: towering, document: documentOf(request)})});
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    await flush();
    const started = performance.now();
    const rows = pane.rows('docs/page.md', GEOM);
    expect(performance.now() - started).toBeLessThan(1_000);
    const boxes = boxRows(rows);
    expect(boxes).toHaveLength(10_000);
    expect(new Set(boxes.map((row) => row.boxes[0]!.imageKey)).size).toBe(250);
    expect(JSON.stringify(rows.at(-1))).toContain('the page is too long to draw here · r opens it rendered');
    expect(pane.changeStarts('docs/page.md').every((row) => row < 10_000)).toBe(true);
    // The last tile there is: whole, and within the page's rows.
    const last = boxes.at(-1)!;
    pane.want([{fileKey: 'docs/page.md', box: last.boxes[0]!}], new Set([last.boxes[0]!.imageKey]));
    await flush();
    expect(tiles).toMatchObject([{index: 249, rows: 10_000}]);
  });

  it('keeps drawing the page it has while a refresh of the file is laid out, then the new one', async () => {
    let fragment = FRAGMENT;
    const env = setup();
    const pane = createRenderedPane({
      backend: {layout: async (request) => ({ok: true, layout: LAYOUT, document: documentOf(request)}), tile: async () => ({ok: false, state: 'error', reason: 'unused'}), disabledReason: () => null},
      registry: env.registry,
      caps: CAPS,
      env: {BRANCH_REVIEW_PANE: 'on'},
      chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      source: () => ({fragment, base: 'main'}),
      fileForAlias: () => null,
    });
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    await flush();
    const first = boxRows(pane.rows('docs/page.md', GEOM));
    expect(first).toHaveLength(150);
    // The file changed: a new fragment, whose layout is on its way.
    fragment = {...FRAGMENT, key: 'frag-def'};
    const during = boxRows(pane.rows('docs/page.md', GEOM));
    expect(during.map((row) => row.boxes[0]!.imageKey)).toEqual(first.map((row) => row.boxes[0]!.imageKey));
    await flush();
    const after = boxRows(pane.rows('docs/page.md', GEOM));
    expect(after[0]!.boxes[0]!.imageKey).toContain('frag-def');
  });

  it('says why when the layout fails, and asks again for a new geometry or on the next v', async () => {
    let fails = true;
    const {pane, layouts} = setup({layout: async (request) => (fails ? {ok: false, state: 'error', reason: 'the browser exited (code 3)'} : {ok: true, layout: LAYOUT, document: documentOf(request)})});
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    await flush();
    const rows = pane.rows('docs/page.md', GEOM);
    expect(JSON.stringify(rows)).toContain('the browser exited (code 3)');
    // Not on every redraw: the row says why until the reader acts.
    expect(layouts).toHaveLength(1);
    pane.rows('docs/page.md', {...GEOM, innerCols: 120});
    expect(layouts).toHaveLength(2);
    // The browser starts anew after a crash: leaving and coming back asks again, and draws the page.
    fails = false;
    pane.leave();
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    expect(layouts).toHaveLength(3);
    await flush();
    expect(boxRows(pane.rows('docs/page.md', GEOM))).toHaveLength(150);
  });

  it('cuts a tile that failed once more on the next v, and draws it', async () => {
    let fails = true;
    const env = await ready(setup({tile: async (request) => (fails
      ? {ok: false, state: 'error', reason: 'the browser exited (code 3)'}
      : {ok: true, png: pngHeaderOnly(request.source.geometry.sheetCols * 10, request.source.geometry.tileRows * 20)})}));
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    const want = async () => {
      env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
      env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
      await flush();
    };
    await want();
    expect(env.pane.boxState(box)).toEqual({status: 'error', reason: 'the browser exited (code 3)'});
    await want();
    expect(env.tiles).toHaveLength(1);
    fails = false;
    env.pane.leave();
    env.pane.enter();
    await want();
    expect(env.tiles).toHaveLength(2);
    expect(env.pane.boxState(box).status).toBe('kitty');
  });

  it('lays out the active file\'s page ahead of the other pages, and moves a waiting one ahead when it becomes active', async () => {
    const asked: Array<{path: string; priority: number | undefined; signal: AbortSignal}> = [];
    const moved: Array<{path: string; priority: number}> = [];
    const env = setup();
    const pane = createRenderedPane({
      backend: {
        layout: (request, signal, priority) => {
          asked.push({path: request.source.fragment.path, priority, signal});
          return new Promise(() => undefined);
        },
        tile: async () => ({ok: false, state: 'error', reason: 'unused'}),
        prioritize: (signal, priority) => moved.push({path: asked.find((each) => each.signal === signal)!.path, priority}),
        disabledReason: () => null,
      },
      registry: env.registry,
      caps: CAPS,
      env: {BRANCH_REVIEW_PANE: 'on'},
      chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      source: (fileKey) => ({fragment: {...FRAGMENT, key: `frag-${fileKey}`, path: fileKey}, base: 'main'}),
      fileForAlias: () => null,
    });
    pane.focus('docs/page.md');
    pane.enter();
    // The rows are built in the review's order, the active file last.
    for (const file of ['docs/a.md', 'docs/b.md', 'docs/page.md']) pane.rows(file, GEOM);
    expect(asked.map(({path, priority}) => [path, priority])).toEqual([['docs/a.md', 2], ['docs/b.md', 2], ['docs/page.md', 0]]);
    pane.focus('docs/b.md');
    expect(moved).toEqual(expect.arrayContaining([{path: 'docs/b.md', priority: 0}, {path: 'docs/page.md', priority: 2}]));
    expect(moved.some((each) => each.path === 'docs/a.md' && each.priority !== 2)).toBe(false);
  });

  it('lays a page out again when the review refreshes, and keeps its tiles while the document is the same', async () => {
    // An image the page embeds moved on the branch: the same fragment key in a new review.
    let fragment = FRAGMENT;
    let document = 'doc-1';
    const layouts: LayoutRequest[] = [];
    const env = setup();
    const pane = createRenderedPane({
      backend: {
        layout: async (request) => {
          layouts.push(request);
          return {ok: true, layout: LAYOUT, document};
        },
        tile: async () => ({ok: false, state: 'error', reason: 'unused'}),
        disabledReason: () => null,
      },
      registry: env.registry,
      caps: CAPS,
      env: {BRANCH_REVIEW_PANE: 'on'},
      chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      source: () => ({fragment, base: 'main'}),
      fileForAlias: () => null,
    });
    const firstKey = async () => {
      pane.rows('docs/page.md', GEOM);
      await flush();
      return boxRows(pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!.imageKey;
    };
    pane.enter();
    const before = await firstKey();
    expect(layouts).toHaveLength(1);
    // A refresh that changed nothing the page draws: the same tiles.
    fragment = {...FRAGMENT, assets: {...FRAGMENT.assets, epoch: 1}};
    expect(await firstKey()).toBe(before);
    expect(layouts).toHaveLength(2);
    // Only the image changed: the worker's document is new, and so is every tile.
    fragment = {...FRAGMENT, assets: {...FRAGMENT.assets, epoch: 2}};
    document = 'doc-2';
    const after = await firstKey();
    expect(layouts).toHaveLength(3);
    expect(after).not.toBe(before);
    expect(after).toContain('doc-2');
  });

  it('lays a page out again once the links it draws broken change, and sends them along', async () => {
    let brokenRefs: number[] = [];
    const layouts: LayoutRequest[] = [];
    const env = setup();
    const pane = createRenderedPane({
      backend: {
        layout: async (request) => {
          layouts.push(request);
          return {ok: true, layout: LAYOUT, document: 'doc-1'};
        },
        tile: async () => ({ok: false, state: 'error', reason: 'unused'}),
        disabledReason: () => null,
      },
      registry: env.registry,
      caps: CAPS,
      env: {BRANCH_REVIEW_PANE: 'on'},
      chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      source: () => ({fragment: FRAGMENT, base: 'main', brokenRefs}),
      fileForAlias: () => null,
    });
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    expect(layouts[0]!.source.brokenRefs).toBeUndefined();
    brokenRefs = [0, 2];
    pane.rows('docs/page.md', GEOM);
    expect(layouts).toHaveLength(2);
    expect(layouts[1]!.source.brokenRefs).toEqual([0, 2]);
  });

  it('sends a visible tile before any row names its id, in the page pool', async () => {
    const env = await ready();
    const rows = boxRows(env.pane.rows('docs/page.md', GEOM));
    const box = rows[0]!.boxes[0]!;
    expect(env.pane.boxState(box)).toEqual({status: 'loading'});
    // As the pane does after each commit: want, then sweep.
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
    expect(env.tiles).toHaveLength(1);
    expect(env.tiles[0]).toMatchObject({index: 0, rows: 150, mosaic: true, priority: 0});
    await flush();
    const state = env.pane.boxState(box);
    expect(state.status).toBe('kitty');
    const commands = parseApc(env.writes);
    expect(commands[0]).toMatchObject({a: 't', i: (state as {id: number}).id});
    expect(env.registry.liveCount('page')).toBe(1);
    expect(env.pane.ready(new Set([box.imageKey]))).toBe(true);
  });

  it('is not ready while a file on screen is still laying out, though no tile of it is on screen yet', async () => {
    let answer: () => void = () => undefined;
    const env = setup({layout: (request) => new Promise((resolve) => {
      answer = () => resolve({ok: true, layout: LAYOUT, document: documentOf(request)});
    })});
    env.pane.enter();
    expect(boxRows(env.pane.rows('docs/page.md', GEOM))).toHaveLength(0);
    // A cold Chromium start: the rows are the label and `laying out`, no tile yet.
    expect(env.pane.ready(new Set(), new Set(['docs/page.md']))).toBe(false);
    // Another file on screen holds nothing up.
    expect(env.pane.ready(new Set(), new Set(['src/app.ts']))).toBe(true);
    answer();
    await flush();
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    // Laid out, it waits for its tiles instead.
    expect(env.pane.ready(new Set([box.imageKey]), new Set(['docs/page.md']))).toBe(false);
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
    await flush();
    expect(env.pane.ready(new Set([box.imageKey]), new Set(['docs/page.md']))).toBe(true);
  });

  it('sends a tile on screen once an id comes out of quarantine, with no other want from outside', async () => {
    let now = 0;
    const env = setup({now: () => now});
    await ready(env);
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    // Every id is live or in quarantine: 255 images, all released just now.
    for (let at = 0; at < 255; at += 1) env.registry.acquire(`other-${at}`, pngHeaderOnly(10, 10), 1, 1);
    env.registry.sweep(new Set(), new Set());
    let notified = 0;
    env.pane.subscribe(() => {
      notified += 1;
      // As the app does on each notice: want again with what is on screen.
      env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    });
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
    await flush();
    expect(env.pane.boxState(box)).toEqual({status: 'loading'});
    expect(env.pane.ready(new Set([box.imageKey]))).toBe(false);
    // The quarantine ends; the timer the pane set wakes it.
    now += 2_000;
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(notified).toBeGreaterThan(0);
    expect(env.pane.boxState(box).status).toBe('kitty');
    expect(env.pane.ready(new Set([box.imageKey]))).toBe(true);
  });

  it('keeps at most 10 tiles live while scrolling a 40-tile page, and never sends one off screen that would be evicted', async () => {
    const tall: PageLayout = {...LAYOUT, heightCss: 40 * 40 * ROW};
    const env = await ready(setup({layout: async (request) => ({ok: true, layout: tall, document: documentOf(request)})}));
    const rows = boxRows(env.pane.rows('docs/page.md', GEOM));
    const keys = [...new Set(rows.map((row) => row.boxes[0]!.imageKey))];
    expect(keys).toHaveLength(40);
    let maxLive = 0;
    for (let at = 0; at < 40; at += 1) {
      // On screen: this tile; near: one above, two below.
      const near = keys.slice(Math.max(0, at - 1), at + 3);
      const boxes = near.map((key) => ({fileKey: 'docs/page.md', box: rows.find((row) => row.boxes[0]!.imageKey === key)!.boxes[0]!}));
      env.pane.want(boxes, new Set([keys[at]!]));
      await flush();
      env.pane.want(boxes, new Set([keys[at]!]));
      env.pane.sweep(new Set(keys), new Set([keys[at]!]));
      maxLive = Math.max(maxLive, env.registry.liveCount('page'));
    }
    expect(maxLive).toBeLessThanOrEqual(10);
    // Sends and deletes balance: no tile went out, was evicted and went out again in one step.
    const commands = parseApc(env.writes);
    const transmits = commands.filter((command) => command.a === 't').length;
    expect(transmits).toBeLessThanOrEqual(40 + 10);
  });

  it('sends ahead no tile that the page pool would evict, so no tile goes out twice', async () => {
    const tall: PageLayout = {...LAYOUT, heightCss: 12 * 40 * ROW};
    // A pool of two: the tile on screen and one more.
    const env = await ready(setup({registry: {maxLive: 2}, layout: async (request) => ({ok: true, layout: tall, document: documentOf(request)})}));
    const rows = boxRows(env.pane.rows('docs/page.md', GEOM));
    const boxes = [...new Map(rows.map((row) => [row.boxes[0]!.imageKey, row.boxes[0]!])).values()];
    // One on screen, five near it, every one already cut.
    const near = boxes.slice(0, 6).map((box) => ({fileKey: 'docs/page.md', box}));
    const live = new Set(near.map(({box}) => box.imageKey));
    const visible = new Set([boxes[0]!.imageKey]);
    env.pane.want(near, visible);
    await flush();
    // Every id each key went out under: a key sent, evicted and sent again has two.
    const idsOf = new Map<string, Set<number>>();
    for (let step = 0; step < 5; step += 1) {
      env.pane.want(near, visible);
      for (const {box} of near) {
        const id = env.registry.idFor(box.imageKey);
        if (id !== undefined) idsOf.set(box.imageKey, new Set([...(idsOf.get(box.imageKey) ?? []), id]));
      }
      env.pane.sweep(live, visible);
    }
    expect([...idsOf.values()].every((ids) => ids.size === 1)).toBe(true);
    // The tile on screen and the one more the pool holds, each once.
    const transmits = parseApc(env.writes).filter((command) => command.a === 't');
    expect(transmits).toHaveLength(2);
    expect(env.registry.liveCount('page')).toBeLessThanOrEqual(2);
    expect(env.pane.boxState(boxes[0]!).status).toBe('kitty');
  });

  it('over SSH sends ahead only the tile below the screen, with no mosaic', async () => {
    const tall: PageLayout = {...LAYOUT, heightCss: 6 * 40 * ROW};
    const env = await ready(setup({env: {BRANCH_REVIEW_PANE: 'on', SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}, layout: async (request) => ({ok: true, layout: tall, document: documentOf(request)})}));
    const keys = [...new Set(boxRows(env.pane.rows('docs/page.md', GEOM)).map((row) => row.boxes[0]!))];
    const boxes = [...new Map(keys.map((box) => [box.imageKey, box])).values()].slice(0, 4).map((box) => ({fileKey: 'docs/page.md', box}));
    env.pane.want(boxes, new Set([boxes[0]!.box.imageKey]));
    expect(env.tiles.map((tile) => tile.index)).toEqual([0, 1]);
    expect(env.tiles.every((tile) => tile.mosaic === false)).toBe(true);
    expect(env.pane.slow).toBe(true);
  });

  it('cuts a page into 20-row tiles once a 40-row tile came out too large', async () => {
    const env = await ready(setup({tile: async () => ({ok: false, state: 'error', reason: 'tile too large', tooLarge: true})}));
    const before = boxRows(env.pane.rows('docs/page.md', GEOM));
    const box = before[0]!.boxes[0]!;
    expect(box.rows).toBe(40);
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    const after = boxRows(env.pane.rows('docs/page.md', GEOM));
    expect(after[0]!.boxes[0]!.rows).toBe(20);
    expect(after[0]!.boxes[0]!.imageKey).not.toBe(box.imageKey);
    expect(after).toHaveLength(150);
  });

  it('gives up on a tile still too large at 20 rows, and says so, after asking twice', async () => {
    const env = await ready(setup({tile: async () => ({ok: false, state: 'error', reason: 'tile too large', tooLarge: true})}));
    let box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    // As the app does: rows, then want, after every change.
    for (let round = 0; round < 30; round += 1) {
      box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
      env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
      env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
      await flush();
    }
    expect(env.tiles.map((tile) => tile.source.geometry.tileRows)).toEqual([40, 20]);
    expect(env.pane.boxState(box)).toEqual({status: 'error', reason: 'too large · r opens it rendered'});
    expect(env.pane.ready(new Set([box.imageKey]))).toBe(true);
  });

  it('turns itself off, back on the diff, when the browser gave up, and says r still works', async () => {
    const env = await ready(setup({tile: async () => ({ok: false, state: 'unavailable', reason: 'in-pane view turned off: the browser exited (code 3)', tilesOff: true})}));
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    expect(env.pane.mode()).toBe('diff');
    expect(env.pane.takeNotices()).toEqual(['✗ in-pane view turned off: the browser exited (code 3) · r still works']);
    expect(env.pane.enter()).toEqual({ok: false, message: '✗ in-pane view turned off: the browser exited (code 3) · r still works'});
  });

  it('turns itself off, back on the diff, when the rendered worker gave up on a tile', async () => {
    let disabled: string | null = null;
    const env = await ready(setup({
      disabled: () => disabled,
      tile: async () => {
        disabled = 'rendered view turned off: timed out';
        return {ok: false, state: 'unavailable', reason: 'rendered view turned off: timed out'};
      },
    }));
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    expect(env.pane.mode()).toBe('diff');
    expect(env.pane.takeNotices()).toEqual(['✗ rendered view turned off: timed out']);
    expect(env.pane.boxState(box)).toEqual({status: 'loading'});
  });

  it('turns itself off when the worker gave up while the page drew tiles it had', async () => {
    let disabled: string | null = null;
    const env = await ready(setup({disabled: () => disabled}));
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    disabled = 'rendered view turned off: the worker crashed';
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    expect(env.pane.mode()).toBe('diff');
    expect(env.pane.takeNotices()).toEqual(['✗ rendered view turned off: the worker crashed']);
  });
});

describe('rows and clicks on the page', () => {
  it('maps a source line to its block\'s row and a row back to its line, for place-keeping both ways', async () => {
    const {pane} = await ready();
    expect(pane.rowForLine('docs/page.md', 4)).toBe(3);
    expect(pane.rowForLine('docs/page.md', 23)).toBe(51);
    expect(pane.lineAtRow('docs/page.md', 51)).toBe(23);
    expect(pane.lineAtRow('docs/page.md', 4)).toBe(3);
  });

  it('lists the rows where each change starts, for [ and ]', async () => {
    const {pane} = await ready();
    expect(pane.changeStarts('docs/page.md')).toEqual([3, 30, 51]);
  });

  it('names the block a row shows, the innermost where they nest, for c', async () => {
    const {pane} = await ready();
    expect(pane.blockAt('docs/page.md', 4)).toEqual({id: 'b-intro', lines: [3, 5]});
    expect(pane.blockAt('docs/page.md', 51)).toEqual({id: 'b-row', lines: [23, 23]});
    // Between blocks, the next one down.
    expect(pane.blockAt('docs/page.md', 10)).toEqual({id: 'b-table', lines: [20, 24]});
  });

  it('tells a heading link, a link to another page of the review and a web link apart, and ignores the rest', async () => {
    const {pane} = await ready();
    const geometry = {leftPad: 3 + Math.floor((200 - 3 - 122) / 2), cell: 10 / 1.25};
    const col = (css: number) => geometry.leftPad + Math.floor(css / geometry.cell);
    expect(pane.hitTest('docs/page.md', 4, col(20))).toEqual({kind: 'anchor', row: 100});
    expect(pane.hitTest('docs/page.md', 4, col(120))).toEqual({kind: 'file', fileKey: 'docs/other.md'});
    expect(pane.hitTest('docs/page.md', 4, col(220))).toEqual({kind: 'external', url: 'https://example.com/docs'});
    expect(pane.hitTest('docs/page.md', 4, col(340))).toBeNull();
    expect(pane.hitTest('docs/page.md', 9, col(20))).toBeNull();
  });

  it('takes a heading link with a malformed escape as written, never throwing on the repo\'s text', async () => {
    const odd: PageLayout = {
      ...LAYOUT,
      links: [
        {href: '#%E0%A4', left: 16, right: 80, top: 4 * ROW, bottom: 5 * ROW},
        {href: '#%E0', left: 100, right: 180, top: 4 * ROW, bottom: 5 * ROW},
        {href: '#caf%C3%A9', left: 200, right: 300, top: 4 * ROW, bottom: 5 * ROW},
      ],
      anchors: [{id: 'user-content-%E0', top: 20 * ROW}, {id: 'user-content-café', top: 40 * ROW}],
    };
    const {pane} = await ready(setup({layout: async (request) => ({ok: true, layout: odd, document: documentOf(request)})}));
    const geometry = {leftPad: 3 + Math.floor((200 - 3 - 122) / 2), cell: 10 / 1.25};
    const col = (css: number) => geometry.leftPad + Math.floor(css / geometry.cell);
    expect(pane.hitTest('docs/page.md', 4, col(20))).toBeNull();
    expect(pane.hitTest('docs/page.md', 4, col(120))).toEqual({kind: 'anchor', row: 20});
    expect(pane.hitTest('docs/page.md', 4, col(220))).toEqual({kind: 'anchor', row: 40});
  });
});
