import {describe, expect, it, vi} from 'vitest';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import type {PlanBoxRow, PlanRow} from '../src/media/layout.js';
import type {FragmentRequest, LayoutRequest, LayoutResult, RenderedBackend, TileRequest, TileResult} from '../src/rendered/backend.js';
import {fileAlias} from '../src/rendered/keys.js';
import {createRenderedPane, PANE_NEEDS_CELL_SIZE, PANE_NEEDS_CHROME} from '../src/rendered/pane.js';
import type {PageLayout} from '../src/rendered/plan.js';
import {parseSnapshot} from '../src/rendered/worker/browser.js';
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
    {href: '#user-content-usage', rects: [{left: 16, right: 80, top: 4 * ROW, bottom: 5 * ROW}]},
    {href: `${OTHER_ALIAS}.html#user-content-x`, rects: [{left: 100, right: 180, top: 4 * ROW, bottom: 5 * ROW}]},
    {href: 'https://example.com/docs', rects: [{left: 200, right: 300, top: 4 * ROW, bottom: 5 * ROW}]},
    {href: 'javascript:alert(1)', rects: [{left: 320, right: 400, top: 4 * ROW, bottom: 5 * ROW}]},
  ],
  anchors: [{id: 'user-content-usage', top: 100 * ROW}],
};

const FRAGMENT: FragmentRequest = {cwd: '/repo', key: 'frag-abc', path: 'docs/page.md', status: 'modified', source: {kind: 'blob', id: 'abcdef1'}, groups: [], links: {}, assets: {base: null, after: {tree: 'HEAD'}, epoch: 0}};

// The worker names a tile document by what it draws; here, by its fragment.
const documentOf = (request: LayoutRequest) => `doc-${request.source.fragment.key}`;

function setup({env = {BRANCH_REVIEW_PREVIEW: 'on'}, caps = CAPS, chrome = true, layout = async (request): Promise<LayoutResult> => ({ok: true, layout: LAYOUT, document: documentOf(request)}), tile, disabled = null as string | null | (() => string | null), registry: registryOptions = {}, now, browserOpens}: {
  env?: NodeJS.ProcessEnv;
  // False where `r` opens nothing, as over SSH.
  browserOpens?: boolean;
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
    ...(browserOpens === undefined ? {} : {browserOpens}),
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
  it('is offered by default in a terminal that draws Kitty images, and BRANCH_REVIEW_PREVIEW=off, 0, false or none turns it off', () => {
    expect(setup({env: {}}).pane.offered()).toBe(true);
    expect(setup({env: {BRANCH_REVIEW_PREVIEW: 'on'}}).pane.offered()).toBe(true);
    for (const value of ['off', '0', 'false', 'none', 'OFF', ' False ']) expect(setup({env: {BRANCH_REVIEW_PREVIEW: value}}).pane.offered()).toBe(false);
    // A value it doesn't know changes nothing.
    expect(setup({env: {BRANCH_REVIEW_PREVIEW: 'yes'}}).pane.offered()).toBe(true);
    // The old name was never released, and does nothing.
    expect(setup({env: {BRANCH_REVIEW_PANE: 'off'}}).pane.offered()).toBe(true);
    expect(setup({caps: {...BLOCKS_CAPS, bg: '#000000', scheme: 'dark'} as typeof CAPS}).pane.offered()).toBe(false);
  });

  it('is advertised only where it can draw: Chromium found, the cell size known, and not turned off for the session', async () => {
    expect(setup({env: {}}).pane.advertised()).toBe(true);
    expect(setup({env: {BRANCH_REVIEW_PREVIEW: 'off'}}).pane.advertised()).toBe(false);
    expect(setup({chrome: false}).pane.advertised()).toBe(false);
    expect(setup({caps: {...CAPS, cellPxSource: 'csi14'}}).pane.advertised()).toBe(false);
    const env = await ready(setup({tile: async () => ({ok: false, state: 'unavailable', reason: 'the browser exited (code 3) · off for this session', tilesOff: true})}));
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    expect(env.pane.advertised()).toBe(false);
  });

  it('is not advertised once the rendered worker turned off, though v was never pressed, and v says why', () => {
    const {pane} = setup({env: {}, disabled: 'Preview and Review in browser turned off: the worker exited 3 times in a minute'});
    expect(pane.offered()).toBe(true);
    expect(pane.advertised()).toBe(false);
    expect(pane.enter()).toEqual({ok: false, message: '✗ Preview and Review in browser turned off: the worker exited 3 times in a minute'});
  });

  it('names Chrome and r when no browser is found, and stays on the diff', () => {
    const {pane} = setup({chrome: false});
    expect(pane.offered()).toBe(true);
    expect(pane.enter()).toEqual({ok: false, message: PANE_NEEDS_CHROME});
    expect(PANE_NEEDS_CHROME).toBe('✗ Preview isn\'t available: no Chrome found · set BRANCH_REVIEW_CHROME or install chrome-headless-shell · r opens it in the browser');
    expect(pane.mode()).toBe('diff');
  });

  it('names the pages --export-html writes in place of r where r opens nothing, as over SSH', async () => {
    const ssh = {BRANCH_REVIEW_PREVIEW: 'on', SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'};
    const headless = 'branch-review --export-html <dir> writes the pages';
    expect(setup({env: ssh, browserOpens: false, chrome: false}).pane.enter()).toEqual({ok: false, message: `✗ Preview isn't available: no Chrome found · set BRANCH_REVIEW_CHROME or install chrome-headless-shell · ${headless}`});

    const layout = setup({env: ssh, browserOpens: false, layout: async () => ({ok: false, state: 'error', reason: 'timed out'})});
    layout.pane.focus('docs/page.md');
    await ready(layout);
    expect(layout.pane.takeNotices()).toEqual([`✗ Preview isn't available: timed out · ${headless}`]);

    const strikes = await ready(setup({env: ssh, browserOpens: false, tile: async () => ({ok: false, state: 'unavailable', reason: 'the browser exited (code 3) · off for this session', tilesOff: true})}));
    const box = boxRows(strikes.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    strikes.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    expect(strikes.pane.takeNotices()).toEqual([`✗ Preview isn't available: the browser exited (code 3) · off for this session · ${headless}`]);
    expect(strikes.pane.enter()).toEqual({ok: false, message: `✗ Preview isn't available: the browser exited (code 3) · off for this session · ${headless}`});
  });

  it('names the cell size when the terminal didn\'t report it, since a tile sized from a guess is scaled', () => {
    for (const cellPxSource of ['csi14', 'default'] as const) {
      const {pane} = setup({caps: {...CAPS, cellPxSource}});
      expect(pane.offered()).toBe(true);
      expect(pane.enter()).toEqual({ok: false, message: PANE_NEEDS_CELL_SIZE});
      expect(pane.mode()).toBe('diff');
    }
    expect(PANE_NEEDS_CELL_SIZE).toBe("✗ Preview isn't available: the terminal didn't report its cell size, which sharp pictures need · r opens it in the browser");
  });

  it('draws at the scale BRANCH_REVIEW_PREVIEW_DPR names, for comparing it with the type-matched one', () => {
    const scaleOf = (env: NodeJS.ProcessEnv) => {
      const {pane, layouts} = setup({env: {BRANCH_REVIEW_PREVIEW: 'on', ...env}});
      pane.enter();
      pane.rows('docs/page.md', GEOM);
      return layouts[0]!.source.geometry.dpr;
    };
    expect(scaleOf({})).toBe(1.25);
    expect(scaleOf({BRANCH_REVIEW_PREVIEW_DPR: '2'})).toBe(2);
    expect(scaleOf({BRANCH_REVIEW_PREVIEW_DPR: '1.75'})).toBe(1.75);
    expect(scaleOf({BRANCH_REVIEW_PREVIEW_DPR: 'sharp'})).toBe(1.25);
    expect(scaleOf({BRANCH_REVIEW_PREVIEW_DPR: '-1'})).toBe(1.25);
    expect(scaleOf({BRANCH_REVIEW_PANE_DPR: '2'})).toBe(1.25);
  });

  it('says the rendered view is off when its worker gave up', () => {
    const {pane} = setup({disabled: 'Preview and Review in browser turned off: timed out'});
    expect(pane.enter()).toEqual({ok: false, message: '✗ Preview and Review in browser turned off: timed out'});
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
    expect(JSON.stringify(rows.at(-1))).toContain('the rest of the page is too long to preview · r opens it in the browser');
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
      env: {BRANCH_REVIEW_PREVIEW: 'on'},
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

  it('goes back to the diff for the file when its layout fails, with one toast, and asks again only on the next v', async () => {
    for (const failure of [
      {state: 'error' as const, reason: 'the browser exited (code 3)'},
      // A cold Chromium that never came up: the job's deadline.
      {state: 'error' as const, reason: 'timed out'},
    ]) {
      let fails = true;
      const {pane, layouts} = setup({layout: async (request) => (fails ? {ok: false, ...failure} : {ok: true, layout: LAYOUT, document: documentOf(request)})});
      // The reader is on the file.
      pane.focus('docs/page.md');
      pane.enter();
      pane.rows('docs/page.md', GEOM);
      expect(pane.shows('docs/page.md')).toBe(true);
      await flush();
      expect(pane.shows('docs/page.md')).toBe(false);
      expect(pane.rows('docs/page.md', GEOM)).toEqual([]);
      expect(pane.takeNotices()).toEqual([`✗ Preview isn't available: ${failure.reason} · r opens it in the browser`]);
      // The pane stays on for other files; this one stays on its diff, at any width.
      expect(pane.mode()).toBe('rendered');
      pane.rows('docs/page.md', {...GEOM, innerCols: 120});
      expect(layouts).toHaveLength(1);
      expect(pane.takeNotices()).toEqual([]);
      // The browser starts anew after a crash: the next v asks again, and draws the page.
      fails = false;
      expect(pane.enter()).toEqual({ok: true});
      expect(pane.shows('docs/page.md')).toBe(true);
      pane.rows('docs/page.md', GEOM);
      expect(layouts).toHaveLength(2);
      await flush();
      expect(boxRows(pane.rows('docs/page.md', GEOM))).toHaveLength(150);
    }
  });

  it('goes back to the diff for the file when a tile fails, and cuts it again on the next v', async () => {
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
    expect(env.pane.shows('docs/page.md')).toBe(false);
    expect(env.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: the browser exited (code 3) · r opens it in the browser']);
    // Back on the diff, nothing more is cut for that file.
    env.pane.want([], new Set());
    env.pane.sweep(new Set(), new Set());
    await flush();
    expect(env.tiles).toHaveLength(1);
    fails = false;
    env.pane.enter();
    expect(boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!.imageKey).toBe(box.imageKey);
    await want();
    expect(env.tiles).toHaveLength(2);
    expect(env.pane.boxState(box).status).toBe('kitty');
    expect(env.pane.shows('docs/page.md')).toBe(true);
  });

  it('goes back to the diff for the file when the screen still waits for its page after 5 s, and not before', async () => {
    vi.useFakeTimers();
    try {
      // A tile that never comes, as from a Chromium that hangs.
      const env = setup({tile: () => new Promise(() => undefined)});
      env.pane.enter();
      env.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(0);
      const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
      env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]), new Set(['docs/page.md']));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(env.pane.shows('docs/page.md')).toBe(true);
      expect(env.pane.takeNotices()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(env.pane.shows('docs/page.md')).toBe(false);
      expect(env.pane.takeNotices()).toEqual(["✗ Preview isn't available: the page didn't draw within 5 s · r opens it in the browser"]);

      // A page still laying out is no hold: the layout job's own deadline,
      // long enough for Chromium's cold start, says when it failed.
      let answerLayout: (result: LayoutResult) => void = () => undefined;
      const cold = setup({layout: () => new Promise((resolve) => {
        answerLayout = resolve;
      })});
      cold.pane.enter();
      cold.pane.rows('docs/page.md', GEOM);
      cold.pane.want([], new Set(), new Set(['docs/page.md']));
      await vi.advanceTimersByTimeAsync(14_000);
      expect(cold.pane.shows('docs/page.md')).toBe(true);
      expect(cold.pane.takeNotices()).toEqual([]);
      answerLayout({ok: false, state: 'error', reason: 'timed out'});
      await vi.advanceTimersByTimeAsync(0);
      expect(cold.pane.shows('docs/page.md')).toBe(false);
      expect(cold.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: timed out · r opens it in the browser']);

      // A tile that comes at 4 s, and the screen that moves on from one that
      // didn't, never fail.
      let answer: (png: Uint8Array) => void = () => undefined;
      const slow = setup({tile: () => new Promise((resolve) => {
        answer = (png) => resolve({ok: true, png});
      })});
      slow.pane.enter();
      slow.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(0);
      const boxes = [...new Map(boxRows(slow.pane.rows('docs/page.md', GEOM)).map((row) => [row.boxes[0]!.imageKey, row.boxes[0]!])).values()];
      const first = boxes[0]!;
      slow.pane.subscribe(() => slow.pane.want([{fileKey: 'docs/page.md', box: first}], new Set([first.imageKey]), new Set(['docs/page.md'])));
      slow.pane.want([{fileKey: 'docs/page.md', box: first}], new Set([first.imageKey]), new Set(['docs/page.md']));
      await vi.advanceTimersByTimeAsync(4_000);
      answer(pngHeaderOnly(first.cols * 10, first.rows * 20));
      await vi.advanceTimersByTimeAsync(0);
      expect(slow.pane.boxState(first).status).toBe('kitty');
      const second = boxes[1]!;
      slow.pane.want([{fileKey: 'docs/page.md', box: second}], new Set([second.imageKey]), new Set(['docs/page.md']));
      await vi.advanceTimersByTimeAsync(3_000);
      // Scrolled back to the tile that is in, before the second waited 5 s.
      slow.pane.want([{fileKey: 'docs/page.md', box: first}], new Set([first.imageKey]), new Set(['docs/page.md']));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(slow.pane.shows('docs/page.md')).toBe(true);
      expect(slow.pane.takeNotices()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The app asks for the page's rows and wants its first box after each
  // change, as it does after each commit.
  const follow = (env: ReturnType<typeof setup>) => {
    const wantNow = () => {
      const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]?.boxes[0];
      if (box) env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]), new Set(['docs/page.md']));
      else env.pane.want([], new Set(), new Set(['docs/page.md']));
    };
    env.pane.subscribe(wantNow);
    env.pane.enter();
    wantNow();
  };

  it('starts the 5 s hold only once the page is laid out, so a slow first layout that succeeds draws, and a tile that never comes after it fails 5 s later', async () => {
    vi.useFakeTimers();
    try {
      const slowLayout = (ms: number) => (request: LayoutRequest) => new Promise<LayoutResult>((resolve) => {
        setTimeout(() => resolve({ok: true, layout: LAYOUT, document: documentOf(request)}), ms);
      });
      const tileIn = (ms: number) => (request: TileRequest) => new Promise<TileResult>((resolve) => {
        const range = request.source.geometry;
        setTimeout(() => resolve({ok: true, png: pngHeaderOnly(range.sheetCols * range.cellPx.w, Math.min(range.tileRows, request.rows - request.index * range.tileRows) * range.cellPx.h)}), ms);
      });

      // A cold Chromium: the layout takes 14 s, the tile 3 s more.
      const cold = setup({layout: slowLayout(14_000), tile: tileIn(3_000)});
      follow(cold);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(cold.tiles).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(cold.pane.shows('docs/page.md')).toBe(true);
      expect(cold.registry.liveCount('page')).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cold.pane.takeNotices()).toEqual([]);

      // The same layout, and a tile that never comes: 5 s after the layout, not after v.
      const stuck = setup({layout: slowLayout(14_000), tile: () => new Promise(() => undefined)});
      follow(stuck);
      await vi.advanceTimersByTimeAsync(14_000 + 4_999);
      expect(stuck.pane.shows('docs/page.md')).toBe(true);
      expect(stuck.pane.takeNotices()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(stuck.pane.shows('docs/page.md')).toBe(false);
      expect(stuck.pane.takeNotices()).toEqual(["✗ Preview isn't available: the page didn't draw within 5 s · r opens it in the browser"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds no clock while the page is laid out again for a worker that lost its document, and starts it when that layout lands', async () => {
    vi.useFakeTimers();
    try {
      for (const again of [12_000, 3_000]) {
      let layouts = 0;
      // The second layout is the one asked again, as slow as a browser started anew, or quicker than a hold.
      const env = setup({
        layout: (request) => new Promise<LayoutResult>((resolve) => {
          layouts += 1;
          setTimeout(() => resolve({ok: true, layout: LAYOUT, document: documentOf(request)}), layouts === 1 ? 0 : again);
        }),
        tile: async (): Promise<TileResult> => (env.tiles.length === 1 ? {ok: false, state: 'error', reason: 'stale', stale: true} : new Promise(() => undefined)),
      });
      follow(env);
      await vi.advanceTimersByTimeAsync(0);
      expect(env.tiles).toHaveLength(1);
      expect(layouts).toBe(2);
      await vi.advanceTimersByTimeAsync(again - 1);
      expect(env.pane.shows('docs/page.md')).toBe(true);
      expect(env.pane.takeNotices()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(env.tiles).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(env.pane.shows('docs/page.md'), `${again} ms`).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(env.pane.shows('docs/page.md')).toBe(false);
      expect(env.pane.takeNotices()).toEqual(["✗ Preview isn't available: the page didn't draw within 5 s · r opens it in the browser"]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds no clock while the reader scrolls through a slow layout asked again for a worker that lost its document', async () => {
    vi.useFakeTimers();
    try {
      let layouts = 0;
      const env = setup({
        layout: (request) => new Promise<LayoutResult>((resolve) => {
          layouts += 1;
          setTimeout(() => resolve({ok: true, layout: LAYOUT, document: documentOf(request)}), layouts === 1 ? 0 : 12_000);
        }),
        tile: async (): Promise<TileResult> => (env.tiles.length === 1 ? {ok: false, state: 'error', reason: 'stale', stale: true} : new Promise(() => undefined)),
      });
      follow(env);
      await vi.advanceTimersByTimeAsync(0);
      expect(layouts).toBe(2);
      // The app wants the screen after every commit: here once a second, as
      // a reader scrolling would, half a second out of step with the layout.
      const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
      await vi.advanceTimersByTimeAsync(500);
      const scrolling = setInterval(() => env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]), new Set(['docs/page.md'])), 1_000);
      try {
        await vi.advanceTimersByTimeAsync(11_500);
        expect(env.tiles).toHaveLength(2);
        expect(env.pane.shows('docs/page.md')).toBe(true);
        expect(env.pane.takeNotices()).toEqual([]);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(env.pane.shows('docs/page.md')).toBe(true);
        expect(env.pane.takeNotices()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(env.pane.shows('docs/page.md')).toBe(false);
        expect(env.pane.takeNotices()).toEqual(["✗ Preview isn't available: the page didn't draw within 5 s · r opens it in the browser"]);
      } finally {
        clearInterval(scrolling);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the hold on through the retries of a late layout, 5 s from when the first layout lands', async () => {
    vi.useFakeTimers();
    try {
      for (const takes of [0, 4_000]) {
        // An image on the page never answers in time, and neither does the tile.
        const env = setup({
          layout: () => new Promise<LayoutResult>((resolve) => {
            setTimeout(() => resolve({ok: true, layout: LAYOUT, document: 'doc-late', late: true}), takes);
          }),
          tile: () => new Promise(() => undefined),
        });
        follow(env);
        await vi.advanceTimersByTimeAsync(takes + 4_999);
        expect(env.layouts.length, `${takes} ms`).toBeGreaterThan(1);
        expect(env.pane.shows('docs/page.md'), `${takes} ms`).toBe(true);
        expect(env.pane.takeNotices()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(env.pane.shows('docs/page.md'), `${takes} ms`).toBe(false);
        expect(env.pane.takeNotices()).toEqual(["✗ Preview isn't available: the page didn't draw within 5 s · r opens it in the browser"]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the page whose tile on screen came just inside the hold, though no want ran before the hold ended', async () => {
    vi.useFakeTimers();
    try {
      let answer: () => void = () => undefined;
      const env = setup({tile: (request) => new Promise((resolve) => {
        answer = () => {
          const range = request.source.geometry;
          resolve({ok: true, png: pngHeaderOnly(range.sheetCols * range.cellPx.w, Math.min(range.tileRows, request.rows - request.index * range.tileRows) * range.cellPx.h)});
        };
      })});
      env.pane.enter();
      env.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(0);
      const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
      env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]), new Set(['docs/page.md']));
      env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
      await vi.advanceTimersByTimeAsync(4_990);
      answer();
      await vi.advanceTimersByTimeAsync(0);
      expect(env.pane.boxState(box).status).toBe('kitty');
      // The app's next want runs after its next commit, which the hold's end comes before.
      await vi.advanceTimersByTimeAsync(10);
      expect(env.pane.shows('docs/page.md')).toBe(true);
      expect(env.pane.takeNotices()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes back to the diff for the file, with no shade rows, when the terminal has no room left for a tile on screen', async () => {
    // A page pool smaller than one tile, decoded.
    const tight = await ready(setup({registry: {maxDecoded: 1024}}));
    const box = boxRows(tight.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    tight.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    tight.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
    await flush();
    expect(tight.registry.liveCount('page')).toBe(0);
    expect(tight.pane.shows('docs/page.md')).toBe(false);
    expect(tight.pane.takeNotices()).toEqual(["✗ Preview isn't available: the terminal's image memory is full · r opens it in the browser"]);

    // Every terminal image id live: none will come free.
    const full = await ready();
    for (let at = 0; at < 255; at += 1) full.registry.acquire(`other-${at}`, pngHeaderOnly(10, 10), 1, 1);
    const fullBox = boxRows(full.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    full.pane.want([{fileKey: 'docs/page.md', box: fullBox}], new Set([fullBox.imageKey]));
    full.pane.sweep(new Set([fullBox.imageKey]), new Set([fullBox.imageKey]));
    await flush();
    expect(full.pane.shows('docs/page.md')).toBe(false);
    expect(full.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: every terminal image id is in use · r opens it in the browser']);
  });

  it('draws a tile on screen though media previews off screen fill the shared budget, since their sweep lets them go', async () => {
    const env = await ready();
    // Nine screenshots seen earlier in the review, 204 MB decoded, still named by rows but off screen.
    const shots = Array.from({length: 9}, (_, at) => `media-${at}`);
    for (const key of shots) env.registry.acquire(key, pngHeaderOnly(3024, 1964), 10, 10);
    env.registry.sweep(new Set(shots), new Set());
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
    await flush();
    expect(env.pane.shows('docs/page.md')).toBe(true);
    expect(env.pane.boxState(box).status).toBe('kitty');
    expect(env.pane.takeNotices()).toEqual([]);
  });

  it('looks for no Chromium and lays nothing out until the first v', async () => {
    let looked = 0;
    let laidOut = 0;
    const env = setup();
    const pane = createRenderedPane({
      backend: {
        layout: async (request) => {
          laidOut += 1;
          return {ok: true, layout: LAYOUT, document: documentOf(request)};
        },
        tile: async () => ({ok: false, state: 'error', reason: 'unused'}),
        disabledReason: () => null,
      },
      registry: env.registry,
      caps: CAPS,
      env: {},
      chrome: () => {
        looked += 1;
        return {path: '/fake/chrome-headless-shell', headless: '--headless'};
      },
      source: (fileKey) => (fileKey === 'docs/page.md' ? {fragment: FRAGMENT, base: 'main'} : null),
      fileForAlias: () => null,
    });
    // What the app asks of a review on a file that isn't markdown, before any v.
    expect(pane.offered()).toBe(true);
    expect(pane.covers('src/app.ts')).toBe(false);
    expect(pane.shows('docs/page.md')).toBe(false);
    pane.want([], new Set(), new Set());
    pane.sweep(new Set(), new Set());
    pane.sourcesChanged();
    await flush();
    expect(looked).toBe(0);
    expect(laidOut).toBe(0);
    // The first v looks for it, and the page's rows ask for the layout.
    expect(pane.enter()).toEqual({ok: true});
    expect(looked).toBeGreaterThan(0);
    pane.rows('docs/page.md', GEOM);
    expect(laidOut).toBe(1);
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
      env: {BRANCH_REVIEW_PREVIEW: 'on'},
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
      env: {BRANCH_REVIEW_PREVIEW: 'on'},
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
      env: {BRANCH_REVIEW_PREVIEW: 'on'},
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
    const env = await ready(setup({env: {BRANCH_REVIEW_PREVIEW: 'on', SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}, layout: async (request) => ({ok: true, layout: tall, document: documentOf(request)})}));
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

  it('gives up on a tile still too large at 20 rows after asking twice, and goes back to the diff for the file', async () => {
    const env = await ready(setup({tile: async () => ({ok: false, state: 'error', reason: 'tile too large', tooLarge: true})}));
    let box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    // As the app does: rows, then want, after every change, while the file's page shows.
    for (let round = 0; round < 30 && env.pane.shows('docs/page.md'); round += 1) {
      box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
      env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
      env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
      await flush();
    }
    expect(env.tiles.map((tile) => tile.source.geometry.tileRows)).toEqual([40, 20]);
    expect(env.pane.shows('docs/page.md')).toBe(false);
    expect(env.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: a part of the page is too large to draw · r opens it in the browser']);
  });

  it('turns itself off for the session, back on the diff, when the browser gave up, and v says why', async () => {
    const env = await ready(setup({tile: async () => ({ok: false, state: 'unavailable', reason: 'the browser exited (code 3) · off for this session', tilesOff: true})}));
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    expect(env.pane.mode()).toBe('diff');
    expect(env.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: the browser exited (code 3) · off for this session · r opens it in the browser']);
    expect(env.pane.enter()).toEqual({ok: false, message: '✗ Preview isn\'t available: the browser exited (code 3) · off for this session · r opens it in the browser'});
  });

  it('turns itself off, back on the diff, when the rendered worker gave up on a tile', async () => {
    let disabled: string | null = null;
    const env = await ready(setup({
      disabled: () => disabled,
      tile: async () => {
        disabled = 'Preview and Review in browser turned off: timed out';
        return {ok: false, state: 'unavailable', reason: 'Preview and Review in browser turned off: timed out'};
      },
    }));
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    expect(env.pane.mode()).toBe('diff');
    expect(env.pane.takeNotices()).toEqual(['✗ Preview and Review in browser turned off: timed out']);
    expect(env.pane.boxState(box)).toEqual({status: 'loading'});
  });

  it('turns itself off when the worker gave up while the page drew tiles it had', async () => {
    let disabled: string | null = null;
    const env = await ready(setup({disabled: () => disabled}));
    const box = boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    disabled = 'Preview and Review in browser turned off: the worker crashed';
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    expect(env.pane.mode()).toBe('diff');
    expect(env.pane.takeNotices()).toEqual(['✗ Preview and Review in browser turned off: the worker crashed']);
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

  it('takes the link whose box under the click is smallest where two links overlap, whichever comes first', async () => {
    const overlapping: PageLayout = {
      ...LAYOUT,
      links: [
        {href: 'https://wide.example/', rects: [{left: 0, right: 400, top: 4 * ROW, bottom: 6 * ROW}]},
        {href: 'https://narrow.example/', rects: [{left: 100, right: 180, top: 4 * ROW, bottom: 5 * ROW}]},
      ],
    };
    const {pane} = await ready(setup({layout: async (request) => ({ok: true, layout: overlapping, document: documentOf(request)})}));
    const geometry = {leftPad: 3 + Math.floor((200 - 3 - 122) / 2), cell: 10 / 1.25};
    const col = (css: number) => geometry.leftPad + Math.floor(css / geometry.cell);
    expect(pane.hitTest('docs/page.md', 4, col(120))).toEqual({kind: 'external', url: 'https://narrow.example/'});
    expect(pane.hitTest('docs/page.md', 4, col(20))).toEqual({kind: 'external', url: 'https://wide.example/'});
    expect(pane.hitTest('docs/page.md', 5, col(120))).toEqual({kind: 'external', url: 'https://wide.example/'});
  });

  it('takes a heading link with a malformed escape as written, never throwing on the repo\'s text', async () => {
    const odd: PageLayout = {
      ...LAYOUT,
      links: [
        {href: '#%E0%A4', rects: [{left: 16, right: 80, top: 4 * ROW, bottom: 5 * ROW}]},
        {href: '#%E0', rects: [{left: 100, right: 180, top: 4 * ROW, bottom: 5 * ROW}]},
        {href: '#caf%C3%A9', rects: [{left: 200, right: 300, top: 4 * ROW, bottom: 5 * ROW}]},
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

describe('the document each tile is cut from', () => {
  const firstBox = (pane: ReturnType<typeof setup>['pane']) => boxRows(pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
  const want = async (env: ReturnType<typeof setup>, box: PlanBoxRow['boxes'][number]) => {
    env.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    env.pane.sweep(new Set([box.imageKey]), new Set([box.imageKey]));
    await flush();
  };

  it('names the document its layout answered in every tile it asks for', async () => {
    const env = await ready();
    const box = firstBox(env.pane);
    await want(env, box);
    expect(env.tiles[0]!.document).toBe('doc-frag-abc');
  });

  it('lays the page out again when the worker no longer holds its document, drawing the page it has meanwhile', async () => {
    let stale = true;
    let laidOut = 0;
    let answer: () => void = () => undefined;
    const env = await ready(setup({
      layout: async (request) => {
        laidOut += 1;
        // The layout asked again waits until the test lets it answer.
        if (laidOut > 1) {
          await new Promise<void>((resolve) => {
            answer = resolve;
          });
        }
        return {ok: true, layout: LAYOUT, document: documentOf(request)};
      },
      tile: async (request) => (stale
        ? {ok: false, state: 'error', reason: 'the page changed since it was laid out', stale: true}
        : {ok: true, png: pngHeaderOnly(request.source.geometry.sheetCols * 10, request.source.geometry.tileRows * 20)}),
    }));
    const box = firstBox(env.pane);
    await want(env, box);
    expect(env.layouts).toHaveLength(2);
    expect(env.pane.boxState(box)).toEqual({status: 'loading'});
    // Still the page it had, at the same geometry, while that layout is on its way,
    // and no tile of the document the worker dropped is asked for again.
    expect(firstBox(env.pane).imageKey).toBe(box.imageKey);
    await want(env, box);
    expect(env.tiles).toHaveLength(1);
    stale = false;
    answer();
    await flush();
    await want(env, firstBox(env.pane));
    expect(env.tiles).toHaveLength(2);
    expect(env.pane.boxState(firstBox(env.pane)).status).toBe('kitty');
    expect(env.layouts).toHaveLength(2);
  });

  it('drops a tile answer for a document the file no longer draws', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let document = 'doc-1';
    const env = setup({
      layout: async () => ({ok: true, layout: LAYOUT, document}),
      tile: async (request) => {
        await gate;
        // With a mosaic, so a tile kept from the old document would show in mosaic().
        return {ok: true, png: pngHeaderOnly(request.source.geometry.sheetCols * 10, request.source.geometry.tileRows * 20), mosaic: new Uint8Array(3)};
      },
    });
    await ready(env);
    const old = firstBox(env.pane);
    env.pane.want([{fileKey: 'docs/page.md', box: old}], new Set([old.imageKey]));
    // The file changes while its tile is cut: a new review, a new document.
    document = 'doc-2';
    env.pane.rows('docs/page.md', {...GEOM, innerCols: 120});
    await flush();
    env.pane.rows('docs/page.md', GEOM);
    await flush();
    expect(firstBox(env.pane).imageKey).toContain('doc-2');
    release();
    await flush();
    expect(env.registry.idFor(old.imageKey)).toBeUndefined();
    expect(env.pane.mosaic(old)).toBeNull();
  });

  it('goes back to the diff for the file when the retry of a late layout fails after the worker let its document go, and v asks again', async () => {
    let calls = 0;
    let failRetry: (result: LayoutResult) => void = () => undefined;
    const env = setup({
      layout: async () => {
        calls += 1;
        if (calls === 1) return {ok: true, layout: LAYOUT, document: 'doc-late', late: true};
        if (calls === 2) return new Promise<LayoutResult>((resolve) => {
          failRetry = resolve;
        });
        return {ok: true, layout: LAYOUT, document: 'doc-new'};
      },
      tile: async () => ({ok: false, state: 'error', reason: 'the page changed since it was laid out', stale: true}),
    });
    env.pane.enter();
    env.pane.rows('docs/page.md', GEOM);
    await flush();
    // The late page's retry is on its way when a tile of it answers stale.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(env.layouts).toHaveLength(2);
    await want(env, firstBox(env.pane));
    failRetry({ok: false, state: 'error', reason: 'the browser exited (signal SIGKILL)'});
    await flush();
    await flush();
    expect(env.pane.shows('docs/page.md')).toBe(false);
    expect(env.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: the browser exited (signal SIGKILL) · r opens it in the browser']);
    // Nothing more is asked by itself; the next v asks again and draws.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(env.layouts).toHaveLength(2);
    env.pane.enter();
    env.pane.rows('docs/page.md', GEOM);
    await flush();
    expect(env.layouts).toHaveLength(3);
    expect(firstBox(env.pane).imageKey).toContain('doc-new');
  });
});

describe('a layout that drew something late', () => {
  it('is asked for again a second later, and the newer answer is drawn', async () => {
    vi.useFakeTimers();
    try {
      let answers = 0;
      const env = setup({layout: async () => {
        answers += 1;
        return answers === 1 ? {ok: true, layout: LAYOUT, document: 'doc-late', late: true} : {ok: true, layout: LAYOUT, document: 'doc-whole'};
      }});
      env.pane.enter();
      env.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(0);
      expect(boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!.imageKey).toContain('doc-late');
      await vi.advanceTimersByTimeAsync(999);
      expect(env.layouts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(env.layouts).toHaveLength(2);
      // Drawn as it was until the newer answer lands, then the newer one.
      await vi.advanceTimersByTimeAsync(0);
      expect(boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!.imageKey).toContain('doc-whole');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(env.layouts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is asked for again at most three times, and one that was on time never', async () => {
    vi.useFakeTimers();
    try {
      const late = setup({layout: async () => ({ok: true, layout: LAYOUT, document: 'doc-late', late: true})});
      late.pane.enter();
      late.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(late.layouts).toHaveLength(4);
      const onTime = setup();
      onTime.pane.enter();
      onTime.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onTime.layouts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('asking again for a page already drawn', () => {
  it('keeps the page it drew when the retry of a late layout fails, and says nothing', async () => {
    vi.useFakeTimers();
    try {
      let answers = 0;
      const env = setup({layout: async () => {
        answers += 1;
        return answers === 1 ? {ok: true, layout: LAYOUT, document: 'doc-late', late: true} : {ok: false, state: 'error', reason: 'the browser exited (signal SIGKILL)'};
      }});
      env.pane.enter();
      env.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(0);
      const drawn = boxRows(env.pane.rows('docs/page.md', GEOM)).map((row) => row.boxes[0]!.imageKey);
      expect(drawn[0]).toContain('doc-late');
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(env.layouts).toHaveLength(2);
      const after = env.pane.rows('docs/page.md', GEOM);
      expect(JSON.stringify(after)).not.toContain("couldn't lay out the page");
      expect(boxRows(after).map((row) => row.boxes[0]!.imageKey)).toEqual(drawn);
      expect(env.pane.shows('docs/page.md')).toBe(true);
      expect(env.pane.mode()).toBe('rendered');
      expect(env.pane.takeNotices()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again after a failed retry of a late layout, and draws the page that comes back whole', async () => {
    vi.useFakeTimers();
    try {
      let answers = 0;
      const env = setup({layout: async () => {
        answers += 1;
        if (answers === 1) return {ok: true, layout: LAYOUT, document: 'doc-late', late: true};
        if (answers === 2) return {ok: false, state: 'error', reason: 'the browser exited (signal SIGKILL)'};
        return {ok: true, layout: LAYOUT, document: 'doc-whole'};
      }});
      env.pane.enter();
      env.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(0);
      for (let second = 0; second < 5; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        env.pane.rows('docs/page.md', GEOM);
      }
      expect(env.layouts).toHaveLength(3);
      expect(boxRows(env.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!.imageKey).toContain('doc-whole');
      expect(env.pane.takeNotices()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking after three retries of a late layout that all fail, and keeps the page it drew', async () => {
    vi.useFakeTimers();
    try {
      let answers = 0;
      const env = setup({layout: async () => {
        answers += 1;
        return answers === 1 ? {ok: true, layout: LAYOUT, document: 'doc-late', late: true} : {ok: false, state: 'error', reason: 'the browser exited (signal SIGKILL)'};
      }});
      env.pane.enter();
      env.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(0);
      for (let second = 0; second < 10; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        env.pane.rows('docs/page.md', GEOM);
      }
      expect(env.layouts).toHaveLength(4);
      const rows = env.pane.rows('docs/page.md', GEOM);
      expect(JSON.stringify(rows)).not.toContain("couldn't lay out the page");
      expect(boxRows(rows)[0]!.boxes[0]!.imageKey).toContain('doc-late');
      expect(env.pane.shows('docs/page.md')).toBe(true);
      expect(env.pane.takeNotices()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still turns itself off when the retry of a late layout finds the browser gave up', async () => {
    vi.useFakeTimers();
    try {
      let answers = 0;
      const env = setup({layout: async () => {
        answers += 1;
        return answers === 1 ? {ok: true, layout: LAYOUT, document: 'doc-late', late: true} : {ok: false, state: 'unavailable', reason: 'the browser exited (code 3) · off for this session', tilesOff: true};
      }});
      env.pane.enter();
      env.pane.rows('docs/page.md', GEOM);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(env.layouts).toHaveLength(2);
      expect(env.pane.mode()).toBe('diff');
      expect(env.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: the browser exited (code 3) · off for this session · r opens it in the browser']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('telling the screen a page failed', () => {
  // How often the pane told its listeners since this was called.
  const counted = (pane: ReturnType<typeof setup>['pane']) => {
    let told = 0;
    pane.subscribe(() => {
      told += 1;
    });
    return () => told;
  };

  it('tells its listeners once per failure, so the rows above the screen change in one step', async () => {
    // A layout that fails.
    const layout = setup({layout: async () => ({ok: false, state: 'error', reason: 'timed out'})});
    layout.pane.enter();
    const toldLayout = counted(layout.pane);
    layout.pane.rows('docs/page.md', GEOM);
    await flush();
    expect(layout.pane.shows('docs/page.md')).toBe(false);
    expect(toldLayout()).toBe(1);

    // A tile that fails.
    const tile = await ready(setup({tile: async () => ({ok: false, state: 'error', reason: 'the browser exited (code 3)'})}));
    const box = boxRows(tile.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    const toldTile = counted(tile.pane);
    tile.pane.want([{fileKey: 'docs/page.md', box}], new Set([box.imageKey]));
    await flush();
    expect(tile.pane.shows('docs/page.md')).toBe(false);
    expect(toldTile()).toBe(1);

    // A worker that gave up as the page was laid out.
    let disabled: string | null = null;
    const worker = setup({disabled: () => disabled, layout: async () => {
      disabled = 'Preview and Review in browser turned off: timed out';
      return {ok: false, state: 'unavailable', reason: 'Preview and Review in browser turned off: timed out'};
    }});
    worker.pane.enter();
    const toldWorker = counted(worker.pane);
    worker.pane.rows('docs/page.md', GEOM);
    await flush();
    expect(worker.pane.mode()).toBe('diff');
    expect(toldWorker()).toBe(1);

    // A screen with no room for its tile.
    const tight = await ready(setup({registry: {maxDecoded: 1024}}));
    const tightBox = boxRows(tight.pane.rows('docs/page.md', GEOM))[0]!.boxes[0]!;
    tight.pane.want([{fileKey: 'docs/page.md', box: tightBox}], new Set([tightBox.imageKey]));
    await flush();
    // The tile is cut; the next want finds no room for it.
    const toldTight = counted(tight.pane);
    tight.pane.want([{fileKey: 'docs/page.md', box: tightBox}], new Set([tightBox.imageKey]));
    expect(tight.pane.shows('docs/page.md')).toBe(false);
    expect(toldTight()).toBe(1);
  });

  it('says nothing of a page that fails off screen while the reader is on another file, until the reader gets there', async () => {
    const {pane} = setup({layout: async () => ({ok: false, state: 'error', reason: 'timed out'})});
    pane.focus('docs/other.md');
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    // The screen shows another file.
    pane.want([], new Set(), new Set(['docs/other.md']));
    await flush();
    expect(pane.shows('docs/page.md')).toBe(false);
    expect(pane.takeNotices()).toEqual([]);
    let told = 0;
    pane.subscribe(() => {
      told += 1;
    });
    pane.focus('docs/page.md');
    expect(told).toBe(1);
    expect(pane.takeNotices()).toEqual(['✗ Preview isn\'t available: timed out · r opens it in the browser']);
    // Said once.
    pane.focus('docs/other.md');
    pane.focus('docs/page.md');
    expect(pane.takeNotices()).toEqual([]);

    // On screen though the reader is on another file, it is said at once.
    const shown = setup({layout: async () => ({ok: false, state: 'error', reason: 'timed out'})});
    shown.pane.focus('docs/other.md');
    shown.pane.enter();
    shown.pane.rows('docs/page.md', GEOM);
    shown.pane.want([], new Set(), new Set(['docs/other.md', 'docs/page.md']));
    await flush();
    expect(shown.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: timed out · r opens it in the browser']);
  });

  it('says nothing of a page that failed off screen once v went back to the diff, when the reader gets there later', async () => {
    const {pane} = setup({layout: async () => ({ok: false, state: 'error', reason: 'timed out'})});
    pane.focus('docs/other.md');
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    pane.want([], new Set(), new Set(['docs/other.md']));
    await flush();
    expect(pane.takeNotices()).toEqual([]);
    pane.leave();
    expect(pane.mode()).toBe('diff');
    pane.focus('docs/page.md');
    expect(pane.takeNotices()).toEqual([]);
  });
});

describe('a resize whose new layout fails', () => {
  it('goes back to the diff for the file, with one toast, and stays there at the width it drew at until the next v', async () => {
    let calls = 0;
    const env = setup({layout: async (request) => {
      calls += 1;
      return calls === 1 ? {ok: true, layout: LAYOUT, document: documentOf(request)} : {ok: false, state: 'error', reason: 'the browser exited (code 3)'};
    }});
    await ready(env);
    env.pane.focus('docs/page.md');
    const narrow = {...GEOM, innerCols: 120};
    env.pane.rows('docs/page.md', narrow);
    // On its way, not failed yet.
    expect(env.pane.shows('docs/page.md')).toBe(true);
    await flush();
    expect(env.pane.shows('docs/page.md')).toBe(false);
    expect(env.pane.takeNotices()).toEqual(['✗ Preview isn\'t available: the browser exited (code 3) · r opens it in the browser']);
    expect(env.pane.rows('docs/page.md', GEOM)).toEqual([]);
    // The page drawn before still answers where the reader was.
    expect(env.pane.lineAtRow('docs/page.md', 3)).toBe(3);
    env.pane.enter();
    expect(boxRows(env.pane.rows('docs/page.md', GEOM))).toHaveLength(150);
  });
});

describe('the state the pane keeps per file', () => {
  it('keeps at most the drawn layout and the newest one per file over 100 reviews, and names only drawn tiles', async () => {
    let epoch = 0;
    const env = setup();
    const pane = createRenderedPane({
      backend: {layout: async (request) => ({ok: true, layout: LAYOUT, document: `doc-${request.source.fragment.assets.epoch}`}), tile: async () => ({ok: false, state: 'error', reason: 'unused'}), disabledReason: () => null},
      registry: env.registry,
      caps: CAPS,
      env: {BRANCH_REVIEW_PREVIEW: 'on'},
      chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      // The text never changes; each review is a new epoch.
      source: () => ({fragment: {...FRAGMENT, assets: {...FRAGMENT.assets, epoch}}, base: 'main'}),
      fileForAlias: () => null,
    });
    pane.enter();
    let most = 0;
    for (; epoch < 100; epoch += 1) {
      pane.rows('docs/page.md', GEOM);
      most = Math.max(most, pane.stateSizes().layouts);
      await flush();
      pane.rows('docs/page.md', GEOM);
      most = Math.max(most, pane.stateSizes().layouts);
      pane.sweep(new Set(), new Set());
    }
    expect(most).toBeLessThanOrEqual(2);
    expect(pane.stateSizes().layouts).toBeLessThanOrEqual(2);
    // One page of 150 rows names 4 tiles of 40 rows.
    expect(pane.stateSizes().tileMeta).toBeLessThanOrEqual(4);
  });

  it('aborts the layout a newer one of the file replaces', async () => {
    const signals: AbortSignal[] = [];
    let epoch = 0;
    const env = setup();
    const pane = createRenderedPane({
      backend: {
        layout: (_request, signal) => {
          signals.push(signal);
          return new Promise(() => undefined);
        },
        tile: async () => ({ok: false, state: 'error', reason: 'unused'}),
        disabledReason: () => null,
      },
      registry: env.registry,
      caps: CAPS,
      env: {BRANCH_REVIEW_PREVIEW: 'on'},
      chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      source: () => ({fragment: {...FRAGMENT, assets: {...FRAGMENT.assets, epoch}}, base: 'main'}),
      fileForAlias: () => null,
    });
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    epoch = 1;
    pane.rows('docs/page.md', GEOM);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(pane.stateSizes().layouts).toBe(1);
  });
});

describe('a resize while a page is drawn', () => {
  it('shows the page\'s rows at the new size in the hold shade while it is laid out there, never the old tiles', async () => {
    let answer: () => void = () => undefined;
    let calls = 0;
    const env = setup({layout: (request) => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ok: true, layout: LAYOUT, document: documentOf(request)});
      return new Promise((resolve) => {
        answer = () => resolve({ok: true, layout: LAYOUT, document: documentOf(request)});
      });
    }});
    await ready(env);
    const old = new Set(boxRows(env.pane.rows('docs/page.md', GEOM)).map((row) => row.boxes[0]!.imageKey));
    // Narrower: 117 columns of sheet, so another geometry.
    const narrow = {...GEOM, innerCols: 120};
    const rows = env.pane.rows('docs/page.md', narrow);
    const expected = Math.ceil((LAYOUT.heightCss * 1.25) / 20);
    expect(rows).toHaveLength(1 + expected);
    expect(boxRows(rows)).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toContain('page:');
    for (const row of rows.slice(1)) expect(JSON.stringify(row)).toContain('░'.repeat(117));
    expect(env.pane.ready(new Set(), new Set(['docs/page.md']))).toBe(false);
    // The page still answers questions about the reader's place.
    expect(env.pane.lineAtRow('docs/page.md', 3)).toBe(3);
    answer();
    await flush();
    const after = boxRows(env.pane.rows('docs/page.md', narrow));
    expect(after).toHaveLength(expected);
    expect(after.some((row) => old.has(row.boxes[0]!.imageKey))).toBe(false);
  });
});

describe('rows of a list whose items are shorter than a row and a half', () => {
  // The owner's pane: 13 by 29 cells at dpr 1.75, rows 16.57 CSS px.
  const OWNER_CAPS = {...CAPS, cellPx: {w: 13, h: 29}};
  const item = (index: number) => ({top: index * 28, bottom: index * 28 + 24});
  const LIST: PageLayout = {
    heightCss: 112,
    blocks: [
      {id: 'b-list', top: 0, bottom: 108, lines: [1, 4]},
      {id: 'b-one', ...item(0), lines: [1, 1]},
      {id: 'b-two', ...item(1), lines: [2, 2], mark: 'modified'},
      {id: 'b-three', ...item(2), lines: [3, 3]},
      {id: 'b-four', ...item(3), lines: [4, 4]},
    ],
    removed: [],
    links: [],
    anchors: [],
  };

  it('copies with c the item each row mostly shows, and lands [ and ] on the changed one', async () => {
    const {pane} = await ready(setup({caps: OWNER_CAPS, layout: async (request) => ({ok: true, layout: LIST, document: documentOf(request)})}));
    expect(boxRows(pane.rows('docs/page.md', GEOM)).map((row) => row.lead?.map((part) => part.text).join(''))).toEqual(['   ', '   ', ' ▌ ', '   ', '   ', '   ', '   ']);
    expect(pane.blockAt('docs/page.md', 2)).toEqual({id: 'b-two', lines: [2, 2]});
    // Row 3 shows the end of the changed item, but mostly the next one.
    expect(pane.blockAt('docs/page.md', 3)).toEqual({id: 'b-three', lines: [3, 3]});
    expect(pane.blockAt('docs/page.md', 0)).toEqual({id: 'b-one', lines: [1, 1]});
    expect(pane.changeStarts('docs/page.md')).toEqual([2]);
  });
});

describe('the block a row shows, where blocks only graze it', () => {
  // Rows of 16 CSS px at 10 by 20 cells and dpr 1.25: row 3 is 48 to 64, its center 56; row 5 is 80 to 96, its center 88.
  const GRAZED: PageLayout = {
    heightCss: 300,
    blocks: [
      // Holds row 3's center; a short block grazes the row's last 3 px.
      {id: 'b-big', top: 40, bottom: 62, lines: [1, 3]},
      {id: 'b-small', top: 61, bottom: 70, lines: [4, 4]},
      // No block holds row 5's center: one overlaps its first 6 px, a short one its last 3.
      {id: 'b-above', top: 70, bottom: 86, lines: [5, 6]},
      {id: 'b-below', top: 93, bottom: 97, lines: [7, 7]},
      {id: 'b-far', top: 200, bottom: 220, lines: [9, 9]},
    ],
    removed: [],
    links: [],
    anchors: [],
  };

  it('takes the block that holds the row\'s center over a shorter one that grazes it, and else the one that overlaps it most', async () => {
    const {pane} = await ready(setup({layout: async (request) => ({ok: true, layout: GRAZED, document: documentOf(request)})}));
    expect(pane.blockAt('docs/page.md', 3)).toEqual({id: 'b-big', lines: [1, 3]});
    expect(pane.blockAt('docs/page.md', 5)).toEqual({id: 'b-above', lines: [5, 6]});
  });
});

describe('a click on a link that wraps', () => {
  // `plain words [a link that wraps](one) [second](two)` in a 400 px column,
  // 16 CSS px a line at 10 by 20 cells and dpr 1.25: the first link runs
  // from x 60 on line one to x 100 on line two, and the second follows it
  // on line two. Chromium's box for the first link spans both whole lines.
  function wrapped(): PageLayout {
    const strings: string[] = [];
    const s = (text: string) => (strings.includes(text) ? strings.indexOf(text) : strings.push(text) - 1);
    const nodes = [
      {name: '#document', parent: -1, attributes: [] as number[]},
      {name: 'HTML', parent: 0, attributes: [], box: [0, 0, 400, 48]},
      {name: 'BODY', parent: 1, attributes: [], box: [0, 0, 400, 48]},
      {name: 'P', parent: 2, attributes: [s('data-block'), s('b-p'), s('data-lines'), s('1-1')], box: [0, 0, 400, 32]},
      {name: '#text', parent: 3, attributes: [], box: [0, 0, 60, 16]},
      {name: 'A', parent: 3, attributes: [s('href'), s('https://one.example/a')], box: [0, 0, 400, 32]},
      {name: '#text', parent: 5, attributes: [], box: [0, 0, 400, 32]},
      {name: 'A', parent: 3, attributes: [s('href'), s('https://two.example/b')], box: [110, 16, 90, 16]},
      {name: '#text', parent: 7, attributes: [], box: [110, 16, 90, 16]},
    ];
    const laid = nodes.flatMap((node, index) => (node.box ? [{index, box: node.box}] : []));
    const layoutIndexOf = (node: number) => laid.findIndex((each) => each.index === node);
    return parseSnapshot({
      strings,
      documents: [{
        nodes: {nodeName: nodes.map((node) => s(node.name)), parentIndex: nodes.map((node) => node.parent), attributes: nodes.map((node) => node.attributes)},
        layout: {nodeIndex: laid.map((each) => each.index), bounds: laid.map((each) => each.box)},
        textBoxes: {
          layoutIndex: [layoutIndexOf(4), layoutIndexOf(6), layoutIndexOf(6), layoutIndexOf(8)],
          bounds: [[0, 0, 60, 16], [60, 0, 340, 16], [0, 16, 100, 16], [110, 16, 90, 16]],
        },
      }],
    }, 48);
  }

  // `[logo ![badge](b.png)](https://img.example/)`: the link's text, then
  // an image in it 32 px tall, taller than the line its text sits on.
  function imageLink(): PageLayout {
    const strings: string[] = [];
    const s = (text: string) => (strings.includes(text) ? strings.indexOf(text) : strings.push(text) - 1);
    const nodes = [
      {name: '#document', parent: -1, attributes: [] as number[]},
      {name: 'HTML', parent: 0, attributes: [], box: [0, 0, 400, 48]},
      {name: 'BODY', parent: 1, attributes: [], box: [0, 0, 400, 48]},
      {name: 'P', parent: 2, attributes: [s('data-block'), s('b-p'), s('data-lines'), s('1-1')], box: [0, 0, 400, 32]},
      {name: 'A', parent: 3, attributes: [s('href'), s('https://img.example/')], box: [0, 16, 72, 16]},
      {name: '#text', parent: 4, attributes: [], box: [0, 16, 40, 16]},
      {name: 'IMG', parent: 4, attributes: [s('src'), s('data:image/png;base64,AA==')], box: [40, 0, 32, 32]},
    ];
    const laid = nodes.flatMap((node, index) => (node.box ? [{index, box: node.box}] : []));
    return parseSnapshot({
      strings,
      documents: [{
        nodes: {nodeName: nodes.map((node) => s(node.name)), parentIndex: nodes.map((node) => node.parent), attributes: nodes.map((node) => node.attributes)},
        layout: {nodeIndex: laid.map((each) => each.index), bounds: laid.map((each) => each.box)},
        textBoxes: {layoutIndex: [laid.findIndex((each) => each.index === 5)], bounds: [[0, 16, 40, 16]]},
      }],
    }, 48);
  }

  it('keeps a box for an image in a link as well as its text, so a click on the image follows it', async () => {
    expect(imageLink().links).toEqual([{href: 'https://img.example/', rects: [{left: 0, right: 40, top: 16, bottom: 32}, {left: 40, right: 72, top: 0, bottom: 32}]}]);
    const {pane} = await ready(setup({layout: async (request) => ({ok: true, layout: imageLink(), document: documentOf(request)})}));
    const leftPad = 3 + Math.floor((200 - 3 - 122) / 2);
    const col = (css: number) => leftPad + Math.floor(css / 8);
    // Row 0 shows only the image's top half.
    expect(pane.hitTest('docs/page.md', 0, col(50))).toEqual({kind: 'external', url: 'https://img.example/'});
    expect(pane.hitTest('docs/page.md', 1, col(20))).toEqual({kind: 'external', url: 'https://img.example/'});
    expect(pane.hitTest('docs/page.md', 0, col(20))).toBeNull();
  });

  it('keeps one box per line of the link, and none over the text beside it', () => {
    expect(wrapped().links).toEqual([
      {href: 'https://one.example/a', rects: [{left: 60, right: 400, top: 0, bottom: 16}, {left: 0, right: 100, top: 16, bottom: 32}]},
      {href: 'https://two.example/b', rects: [{left: 110, right: 200, top: 16, bottom: 32}]},
    ]);
  });

  it('copies the link under the click, never the wrapped one beside it', async () => {
    const {pane} = await ready(setup({layout: async (request) => ({ok: true, layout: wrapped(), document: documentOf(request)})}));
    const leftPad = 3 + Math.floor((200 - 3 - 122) / 2);
    const col = (css: number) => leftPad + Math.floor(css / 8);
    // Line two: the second link, and the end of the first.
    expect(pane.hitTest('docs/page.md', 1, col(150))).toEqual({kind: 'external', url: 'https://two.example/b'});
    expect(pane.hitTest('docs/page.md', 1, col(50))).toEqual({kind: 'external', url: 'https://one.example/a'});
    // Line one: the plain words before the link, and the link itself.
    expect(pane.hitTest('docs/page.md', 0, col(30))).toBeNull();
    expect(pane.hitTest('docs/page.md', 0, col(200))).toEqual({kind: 'external', url: 'https://one.example/a'});
    // Past the end of line two, beside both links.
    expect(pane.hitTest('docs/page.md', 1, col(300))).toBeNull();
  });
});

describe('what a click on a web link copies', () => {
  const layoutWith = (href: string): PageLayout => ({...LAYOUT, links: [{href, rects: [{left: 16, right: 300, top: 4 * ROW, bottom: 5 * ROW}]}]});
  const clicked = async (href: string) => {
    const {pane} = await ready(setup({layout: async (request) => ({ok: true, layout: layoutWith(href), document: documentOf(request)})}));
    const leftPad = 3 + Math.floor((200 - 3 - 122) / 2);
    return pane.hitTest('docs/page.md', 4, leftPad + 5);
  };

  it('refuses a link that holds a newline, an ESC, a BEL or a C1 control', async () => {
    for (const href of ['https://example.com/a\nb', 'https://example.com/\u001b]52;c;Zm9v\u0007', 'https://example.com/\u009b2J', 'https://example.com/\u007f']) {
      expect(await clicked(href)).toEqual({kind: 'refused', reason: 'this link holds control characters · not copied'});
    }
  });

  it('copies the URL as parsed: a space percent-encoded, a plain one unchanged', async () => {
    expect(await clicked('https://example.com/a b')).toEqual({kind: 'external', url: 'https://example.com/a%20b'});
    expect(await clicked('https://example.com/docs?x=1#y')).toEqual({kind: 'external', url: 'https://example.com/docs?x=1#y'});
    expect(await clicked('mailto:someone@example.com')).toEqual({kind: 'external', url: 'mailto:someone@example.com'});
    expect(await clicked('https://')).toBeNull();
    expect(await clicked('ftp://example.com/x')).toBeNull();
  });
});

describe('tiles queued while the reader holds PgDn', () => {
  it('cuts the tiles of the screen it stops on first, and drops the ones it went past', async () => {
    // A 40-tile page, and a worker that cuts one tile at a time, the lowest
    // priority number first, taking a moment for each.
    const TALL: PageLayout = {heightCss: 1600 * ROW, blocks: [], removed: [], links: [], anchors: []};
    type Job = {index: number; signal: AbortSignal; priority: number; resolve: (result: TileResult) => void};
    const queue: Job[] = [];
    const cut: number[] = [];
    const aborted: number[] = [];
    let running = false;
    const pump = async () => {
      if (running) return;
      running = true;
      while (queue.length > 0) {
        queue.sort((left, right) => left.priority - right.priority);
        const job = queue.shift()!;
        await new Promise((resolve) => setTimeout(resolve, 5));
        cut.push(job.index);
        job.resolve({ok: true, png: pngHeaderOnly(1220, 800)});
      }
      running = false;
    };
    const env = setup();
    const pane = createRenderedPane({
      backend: {
        layout: async (request) => ({ok: true, layout: TALL, document: documentOf(request)}),
        tile: (request, signal, priority = 1) => new Promise((resolve, reject) => {
          const job: Job = {index: request.index, signal, priority, resolve};
          queue.push(job);
          signal.addEventListener('abort', () => {
            // A queued job is dropped; one being cut finishes, unheard.
            const at = queue.indexOf(job);
            if (at >= 0) {
              queue.splice(at, 1);
              aborted.push(request.index);
            }
            reject(new Error('aborted'));
          }, {once: true});
          void pump();
        }),
        prioritize: (signal, priority) => {
          const job = queue.find((each) => each.signal === signal);
          if (job) job.priority = priority;
        },
        disabledReason: () => null,
      },
      registry: env.registry,
      caps: CAPS,
      env: {BRANCH_REVIEW_PREVIEW: 'on'},
      chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      source: () => ({fragment: FRAGMENT, base: 'main'}),
      fileForAlias: () => null,
    });
    pane.enter();
    pane.rows('docs/page.md', GEOM);
    await flush();
    const rows = boxRows(pane.rows('docs/page.md', GEOM));
    expect(new Set(rows.map((row) => row.boxes[0]!.imageKey)).size).toBe(40);
    const live = new Set(rows.map((row) => row.boxes[0]!.imageKey));
    const view = 30;
    // As the app asks after each frame: the boxes on screen, one screen
    // above and two below, and those on screen.
    const at = (offset: number) => {
      const window = new Map<string, PlanBoxRow['boxes'][number]>();
      const visible = new Set<string>();
      for (const [row, each] of rows.entries()) {
        const box = each.boxes[0]!;
        if (row >= offset - view && row < offset + 2 * view && !window.has(box.imageKey)) window.set(box.imageKey, box);
        if (row >= offset && row < offset + view) visible.add(box.imageKey);
      }
      return {boxes: [...window.values()].map((box) => ({fileKey: 'docs/page.md', box})), visible};
    };
    const tileOf = (key: string) => Number(key.split(':').at(-1));
    let final = at(0);
    for (let offset = 0; offset <= 1500; offset += view) {
      final = at(offset);
      pane.want(final.boxes, final.visible);
      pane.sweep(live, final.visible);
    }
    while (queue.length > 0 || running) await new Promise((resolve) => setTimeout(resolve, 10));
    const onScreen = [...final.visible].map(tileOf).sort((left, right) => left - right);
    const near = final.boxes.map(({box}) => tileOf(box.imageKey)).filter((index) => !onScreen.includes(index));
    // The first tile was already being cut when the reader started; then the screen, then what is near it.
    expect(cut[0]).toBe(0);
    expect(cut.slice(1, 1 + onScreen.length).sort((left, right) => left - right)).toEqual(onScreen);
    expect(cut.slice(1 + onScreen.length).sort((left, right) => left - right)).toEqual(near.sort((left, right) => left - right));
    // Everything passed on the way was dropped, never cut.
    expect(aborted.length).toBeGreaterThan(10);
    for (const index of aborted) expect(cut).not.toContain(index);
  });
});
