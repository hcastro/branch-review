import type {ImageRegistry} from '../media/imageRegistry.js';
import type {BoxSpec, PlanRow} from '../media/layout.js';
import {createLru} from '../media/lru.js';
import type {GraphicsCaps} from '../media/types.js';
import {blockForSourceLine} from './anchor.js';
import type {FragmentRequest, LayoutResult, RenderedBackend, TileSource} from './backend.js';
import {FILE_ALIAS_LINK} from './keys.js';
import {oneLine} from './source.js';
import {planRenderedRows, rowAt, rowMarks, rowSpan, type LayoutBlock, type PageLayout} from './plan.js';
import {geometryKey, GUTTER_COLS, pageCut, pageRows, SHORT_TILE_ROWS, tileGeometry, type DprMode, type PageGeometry} from './tileGeometry.js';
import type {ChromeBinary} from './worker/chrome.js';

// The UI side of the in-pane view: `v` on a markdown file swaps its diff
// rows for the page itself, as Kitty placeholder tiles that a headless
// Chromium in the rendered worker cuts. This side holds what names and
// places the tiles (each page's layout, the tile PNGs near the viewport,
// which terminal id draws which tile) and never the HTML. It sends a tile
// before any row names its id, the way media previews do, from the page
// pool of the shared image registry, and answers what a row means: the
// block to copy, where each change starts, which link a click is on.
//
// It is offered only in a terminal that draws Kitty images, and only with
// BRANCH_REVIEW_PANE=on until the owner's hands-on checks in cmux pass. A
// failure is never for good, short of the browser or the worker giving up:
// the next `v` asks again for what failed.

/** What `v` says when no Chromium is found; `r` needs none. */
export const PANE_NEEDS_CHROME = 'the in-pane view needs Chrome · set BRANCH_REVIEW_CHROME or install chrome-headless-shell · r opens it rendered';
/** What `v` says when the terminal didn't answer CSI 16t: a tile sized from a guess would be scaled, and blurred. */
export const PANE_NEEDS_CELL_SIZE = "the terminal didn't report its cell size, which sharp tiles need · r opens it rendered";

const TILE_CACHE_BYTES = 48 * 1024 * 1024;
// The terminal background when it didn't answer OSC 11.
const FALLBACK = {bg: '#111318', scheme: 'dark' as const};
const LAYING_OUT = 'laying out the page…';
const TOO_NARROW = 'the pane is too narrow for the page · r opens it rendered';
const TOO_LARGE = 'too large · r opens it rendered';
const TOO_LONG = 'the page is too long to draw here · r opens it rendered';
// The active file's page is laid out first, then tiles near the screen
// (priority 0 on it, 1 near it), then every other page the pane covers.
const ACTIVE_LAYOUT = 0;
const OTHER_LAYOUT = 2;

/**
 * The page's scale: type-matched, or the one BRANCH_REVIEW_PANE_DPR names,
 * for comparing scales by eye. Anything but a positive number is ignored.
 */
export function paneDpr(env: NodeJS.ProcessEnv): DprMode {
  const fixed = Number(env.BRANCH_REVIEW_PANE_DPR);
  return env.BRANCH_REVIEW_PANE_DPR && Number.isFinite(fixed) && fixed > 0 ? fixed : 'type';
}

/** What a click on a page row leads to. Repo URLs are copied, never opened. */
export type LinkTarget = {kind: 'anchor'; row: number} | {kind: 'file'; fileKey: string} | {kind: 'external'; url: string};

export type PaneBoxState = {status: 'kitty'; id: number} | {status: 'loading'} | {status: 'error'; reason: string};

export type PaneGeometryInput = {innerCols: number; viewportRows: number};

type LayoutEntry = {status: 'pending'} | {status: 'ready'; layout: PageLayout; document: string; text?: string} | {status: 'failed'; reason: string};
type Tile = {png: Uint8Array; mosaic?: Uint8Array};
// What a tile key stands for, so a want can render it: `document` is the
// name of the tile document it is cut from.
type TileMeta = {source: TileSource; document: string; index: number; rows: number};
type Failure = Extract<LayoutResult, {ok: false}>;

// The blocks that name the source lines they came from.
const sourced = (layout: PageLayout) => layout.blocks.filter((block): block is LayoutBlock & {lines: readonly [number, number]} => block.lines !== undefined);

const WEB_LINK = /^(?:https?:|mailto:)/i;

export function createRenderedPane({backend, registry, caps, env, chrome, source, fileForAlias}: {
  backend: Pick<RenderedBackend, 'layout' | 'tile' | 'disabledReason'> & Partial<Pick<RenderedBackend, 'prioritize'>>;
  registry: ImageRegistry;
  caps: GraphicsCaps;
  env: NodeJS.ProcessEnv;
  /** The browser to draw with, looked up once, or null. */
  chrome: () => ChromeBinary | null;
  /**
   * The fragment a review file's page shows, the base ref's name and the
   * links the page draws broken; null for a file with no markdown page.
   */
  source: (fileKey: string) => {fragment: FragmentRequest; base: string; brokenRefs?: readonly number[]} | null;
  /** The review file a page name (`f-….html`) stands for. */
  fileForAlias: (alias: string) => string | null;
}) {
  const offered = env.BRANCH_REVIEW_PANE === 'on' && caps.protocol === 'kitty' && Boolean(backend.layout && backend.tile);
  // Over SSH and tmux every byte crosses a slow link: no mosaic, and tiles
  // are sent ahead only one below the screen.
  const slow = Boolean(env.SSH_CONNECTION) || caps.tmux;
  const colors = {bg: caps.bg ?? FALLBACK.bg, scheme: caps.scheme ?? FALLBACK.scheme};
  const dprMode = paneDpr(env);
  let mode: 'diff' | 'rendered' = 'diff';
  let off: string | null = null;
  const layouts = new Map<string, LayoutEntry>();
  // Tile documents whose 40-row tiles came out too large: they are cut at 20 rows.
  const shortTiles = new Set<string>();
  // Files whose page row on screen says it is laying out: no tile of
  // theirs exists yet to wait for, so the crossing waits for the layout.
  const layingOut = new Set<string>();
  let idRetry: ReturnType<typeof setTimeout> | null = null;
  let focused: string | null = null;
  // By file key: the layout still waiting for an answer, to move ahead when its file becomes active.
  const waiting = new Map<string, AbortController>();
  const layoutPriority = (fileKey: string) => (fileKey === focused ? ACTIVE_LAYOUT : OTHER_LAYOUT);
  const tiles = createLru<Tile>(TILE_CACHE_BYTES, (tile) => tile.png.byteLength + (tile.mosaic?.byteLength ?? 0));
  const tileMeta = new Map<string, TileMeta>();
  const rendering = new Map<string, AbortController>();
  const tileErrors = new Map<string, string>();
  let liveKeys: ReadonlySet<string> = new Set();
  let visibleKeys: ReadonlySet<string> = new Set();
  const notices: string[] = [];
  const listeners = new Set<() => void>();
  let version = 0;
  let planVersion = 0;
  let disposed = false;

  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  // The rows a page takes changed, not only what a row draws.
  const planChanged = () => {
    planVersion += 1;
    notify();
  };

  // Back to the diff for the session, saying why once.
  const turnOff = (message: string) => {
    if (off) return;
    off = message;
    mode = 'diff';
    notices.push(off);
    planChanged();
  };

  // Whether a failed job means the pane can't go on: the browser gave up
  // for the session (pages still open with r), or the worker did (they
  // don't). Either way the pane goes back to the diff.
  const gaveUp = (failure: Failure) => {
    if (failure.tilesOff) {
      turnOff(`✗ ${oneLine(failure.reason)} · r still works`);
      return true;
    }
    const disabled = backend.disabledReason();
    if (failure.state !== 'unavailable' && !disabled) return false;
    turnOff(`✗ ${oneLine(disabled ?? failure.reason)}`);
    return true;
  };

  // The page the pane draws for a file at this pane width: its source, its
  // geometry, and the key its layout goes by. The key names everything the
  // tile document is drawn from that this side knows: the file's text (its
  // fragment), the review it is part of (an image the page embeds can
  // change while the text doesn't), the links drawn broken, the colors and
  // the sheet. The worker answers the document's own name, which only
  // changes when what it draws does, and the tiles go by that.
  const pageFor = (fileKey: string, innerCols: number) => {
    const shown = source(fileKey);
    const binary = chrome();
    if (!shown || !binary) return null;
    const geometry = tileGeometry(innerCols, caps.cellPx, dprMode);
    if (!geometry) return {shown, geometry: null, layoutKey: ''};
    const {fragment, base, brokenRefs = []} = shown;
    const layoutKey = [fragment.key, fragment.assets.epoch, brokenRefs.join(','), colors.scheme, colors.bg, geometryKey(geometry)].join('|');
    const tileSource: TileSource = {fragment, scheme: colors.scheme, bg: colors.bg, base, geometry, chrome: binary, ...(brokenRefs.length > 0 ? {brokenRefs} : {})};
    return {shown, geometry, layoutKey, tileSource};
  };

  // By file key: the page the pane last drew, which the questions that
  // come later from a key press or a click are about. A watch refresh that
  // changed the file keeps drawing it, at its place, while the new one is
  // laid out, so the pane never drops to a `laying out` row and back.
  // `text`: the markdown the page was laid out from.
  type Drawn = {layoutKey: string; layout: PageLayout; document: string; geometry: PageGeometry; tileSource: TileSource; text?: string};
  const shown = new Map<string, Drawn>();
  const lastCols = new Map<string, number>();
  const known = (fileKey: string) => shown.get(fileKey) ?? null;

  const askLayout = (fileKey: string, layoutKey: string, tileSource: TileSource) => {
    layouts.set(layoutKey, {status: 'pending'});
    const controller = new AbortController();
    waiting.set(fileKey, controller);
    void backend.layout!({source: tileSource}, controller.signal, layoutPriority(fileKey)).then((result) => {
      if (waiting.get(fileKey) === controller) waiting.delete(fileKey);
      if (disposed) return;
      if (result.ok) {
        const text = result.text === undefined ? {} : {text: result.text};
        layouts.set(layoutKey, {status: 'ready', layout: result.layout, document: result.document, ...text});
        shown.set(fileKey, {layoutKey, layout: result.layout, document: result.document, geometry: tileSource.geometry, tileSource, ...text});
      } else {
        layouts.set(layoutKey, {status: 'failed', reason: oneLine(result.reason)});
        gaveUp(result);
      }
      planChanged();
    });
  };

  const textRow = (text: string, tone: 'dim' | 'error'): PlanRow => ({type: 'text', role: tone === 'error' ? 'reason' : 'loading', pieces: [{at: GUTTER_COLS, parts: [{text, tone}]}]});

  // With every id in quarantine, a tile on screen waits for the first to
  // come free, and nothing else may wake the pane (an idle session): one
  // timer tells it then, and the want that follows sends the tile.
  const retryWhenIdFree = () => {
    if (idRetry || disposed) return;
    idRetry = setTimeout(() => {
      idRetry = null;
      if (!disposed) notify();
    }, Math.max(1, registry.nextFreeIn()));
    idRetry.unref?.();
  };

  // Sends a cut tile, and says whether a row on screen now draws it. One
  // near the screen is sent ahead only while it fits the page pool: one
  // that didn't would be evicted by the next sweep and sent again by the
  // next want, a loop of transmits.
  const send = (box: BoxSpec, tile: Tile) => {
    if (!visibleKeys.has(box.imageKey)) {
      if (registry.fits(tile.png, undefined, 'page')) registry.acquire(box.imageKey, tile.png, box.cols, box.rows, undefined, 'page');
      return false;
    }
    if (registry.acquire(box.imageKey, tile.png, box.cols, box.rows, undefined, 'page') !== null) return true;
    retryWhenIdFree();
    return false;
  };

  const render = (box: BoxSpec, meta: TileMeta, priority: number) => {
    const controller = new AbortController();
    rendering.set(box.imageKey, controller);
    void backend.tile!({source: meta.source, index: meta.index, rows: meta.rows, mosaic: !slow}, controller.signal, priority).then((result) => {
      if (controller.signal.aborted || disposed) return;
      rendering.delete(box.imageKey);
      if (result.ok) {
        const tile: Tile = result.mosaic ? {png: result.png, mosaic: result.mosaic} : {png: result.png};
        tiles.set(box.imageKey, tile);
        if (liveKeys.has(box.imageKey)) send(box, tile);
      } else if (gaveUp(result)) {
        return;
      } else if (result.tooLarge && meta.source.geometry.tileRows > SHORT_TILE_ROWS) {
        shortTiles.add(meta.document);
        planVersion += 1;
      } else {
        // Already as short as tiles go, a tile too large stays undrawn.
        tileErrors.set(box.imageKey, result.tooLarge ? TOO_LARGE : oneLine(result.reason));
      }
      notify();
    }, () => {
      // Aborted: no row names the tile any more.
    });
  };

  return {
    /** Whether `v` on markdown draws the page here. */
    offered: () => offered,
    /** The file the reader is on, whose page is laid out ahead of the rest. */
    focus(fileKey: string) {
      if (fileKey === focused) return;
      const before = focused;
      focused = fileKey;
      for (const key of [before, fileKey]) {
        const controller = key === null ? undefined : waiting.get(key);
        if (controller) backend.prioritize?.(controller.signal, layoutPriority(key!));
      }
    },
    mode: () => mode,
    /** Whether the file's diff becomes a page in the pane. */
    covers: (fileKey: string) => source(fileKey) !== null,

    /** Turns the pane to pages, or says why it can't. */
    enter(): {ok: true} | {ok: false; message: string} {
      const disabled = backend.disabledReason();
      if (disabled) return {ok: false, message: `✗ ${oneLine(disabled)}`};
      if (off) return {ok: false, message: off};
      if (caps.cellPxSource !== 'csi16') return {ok: false, message: PANE_NEEDS_CELL_SIZE};
      if (!chrome()) return {ok: false, message: PANE_NEEDS_CHROME};
      // What failed before is asked for again: a browser that crashed
      // starts anew, and only three failures in a minute turn it off.
      for (const [key, entry] of layouts) if (entry.status === 'failed') layouts.delete(key);
      tileErrors.clear();
      mode = 'rendered';
      planChanged();
      return {ok: true};
    },
    /** Back to the diff, at once. */
    leave() {
      if (mode === 'diff') return;
      mode = 'diff';
      planChanged();
    },

    /**
     * The rows the file's page takes at this pane width: a label, then one
     * box row per page row once Chromium laid it out, or a row saying why
     * not yet. Asks for the layout the first time.
     */
    rows(fileKey: string, {innerCols}: PaneGeometryInput): PlanRow[] {
      const page = pageFor(fileKey, innerCols);
      if (!page) return [];
      const label = textRow(page.shown.fragment.path, 'dim');
      layingOut.delete(fileKey);
      if (!page.geometry || !page.tileSource) return [label, textRow(TOO_NARROW, 'dim')];
      lastCols.set(fileKey, innerCols);
      let entry = layouts.get(page.layoutKey);
      if (!entry) {
        askLayout(fileKey, page.layoutKey, page.tileSource);
        entry = layouts.get(page.layoutKey)!;
      }
      if (entry.status === 'ready') shown.set(fileKey, {layoutKey: page.layoutKey, layout: entry.layout, document: entry.document, geometry: page.geometry, tileSource: page.tileSource, ...(entry.text === undefined ? {} : {text: entry.text})});
      const before = shown.get(fileKey);
      const drawn = entry.status === 'ready' || (entry.status === 'pending' && before && geometryKey(before.geometry) === geometryKey(page.geometry)) ? before! : null;
      if (!drawn) {
        if (entry.status === 'failed') return [label, textRow(`couldn't lay out the page · ${entry.reason} · r opens it rendered`, 'error')];
        shown.delete(fileKey);
        layingOut.add(fileKey);
        return [label, textRow(LAYING_OUT, 'dim')];
      }
      const {layout, document} = drawn;
      const geometry = shortTiles.has(document) ? tileGeometry(innerCols, caps.cellPx, dprMode, SHORT_TILE_ROWS)! : drawn.geometry;
      const tileSource: TileSource = {...drawn.tileSource, geometry};
      const rows = pageRows(geometry, layout.heightCss);
      return [label, ...planRenderedRows(layout, geometry, (index) => {
        const key = `page:${document}:${geometryKey(geometry)}:${index}`;
        tileMeta.set(key, {source: tileSource, document, index, rows});
        return key;
      }), ...(pageCut(geometry, layout.heightCss) ? [textRow(TOO_LONG, 'dim')] : [])];
    },

    boxState(box: BoxSpec): PaneBoxState {
      const reason = tileErrors.get(box.imageKey);
      if (reason !== undefined) return {status: 'error', reason};
      const id = registry.idFor(box.imageKey);
      return id === undefined ? {status: 'loading'} : {status: 'kitty', id};
    },

    /** Each cell's mean color in a rendered tile, RGB row by row, or null. */
    mosaic: (box: BoxSpec) => tiles.get(box.imageKey)?.mosaic ?? null,

    /**
     * Whether the page on screen can be drawn: no file among `files` (those
     * with a row on screen) is still laying out, and every tile on screen
     * has its id or failed.
     */
    ready: (visible: ReadonlySet<string>, files: ReadonlySet<string> = new Set()) => (
      ![...files].some((fileKey) => layingOut.has(fileKey)) && [...visible].every((key) => registry.idFor(key) !== undefined || tileErrors.has(key))
    ),

    /**
     * After each commit, with the page's boxes near the viewport: sends
     * what is cut, cuts what is not, and marks what is drawn as used. Over
     * a slow link, only the screen and the next tile below.
     */
    want(boxes: ReadonlyArray<{fileKey: string; box: BoxSpec}>, visible: ReadonlySet<string>) {
      if (disposed || off) return;
      // The worker gave up while the page was drawn from tiles cut before.
      const disabled = backend.disabledReason();
      if (disabled && mode === 'rendered') {
        turnOff(`✗ ${oneLine(disabled)}`);
        return;
      }
      visibleKeys = visible;
      let lastVisible = -1;
      if (slow) for (const [at, {box}] of boxes.entries()) if (visible.has(box.imageKey)) lastVisible = at;
      let changed = false;
      for (const [at, {box}] of boxes.entries()) {
        const key = box.imageKey;
        if (slow && !visible.has(key) && at !== lastVisible + 1) continue;
        if (tileErrors.has(key)) continue;
        if (registry.idFor(key) !== undefined) {
          registry.touch(key);
          continue;
        }
        const tile = tiles.get(key);
        if (tile) {
          if (send(box, tile)) changed = true;
          continue;
        }
        const meta = tileMeta.get(key);
        if (meta && !rendering.has(key)) render(box, meta, visible.has(key) ? 0 : 1);
      }
      if (changed) notify();
    },

    /** After each commit: frees the page pool's ids no row names, and trims it to budget off screen. */
    sweep(live: ReadonlySet<string>, visible: ReadonlySet<string>) {
      liveKeys = live;
      visibleKeys = visible;
      for (const [key, controller] of rendering) {
        if (live.has(key)) continue;
        controller.abort();
        rendering.delete(key);
      }
      registry.sweep(live, visible, 'page');
    },

    /**
     * After what a page is drawn from may have changed with nothing on
     * screen asking (a fragment landed, and the link report with it): plans
     * the rows again when a page the pane drew would now be laid out anew.
     */
    sourcesChanged() {
      if (mode !== 'rendered' || disposed) return;
      for (const [fileKey, cols] of lastCols) {
        const page = pageFor(fileKey, cols);
        if (page?.geometry && !layouts.has(page.layoutKey)) {
          planChanged();
          return;
        }
      }
    },

    /** Whether the file's layout failed, so its rows say why and no page rows will come. */
    layoutFailed(fileKey: string) {
      const cols = lastCols.get(fileKey);
      const page = cols === undefined ? null : pageFor(fileKey, cols);
      const entry = page?.geometry ? layouts.get(page.layoutKey) : undefined;
      return !shown.has(fileKey) && entry?.status === 'failed';
    },

    /** The page row that shows source line `line`, for opening the pane where the diff was. */
    rowForLine(fileKey: string, line: number): number | null {
      const page = known(fileKey);
      const blocks = page ? sourced(page.layout) : [];
      const block = blocks[blockForSourceLine(blocks, line)];
      return page && block ? rowAt(page.geometry, block.top) : null;
    },

    /**
     * The markdown source of the block a page row shows, for `c`: cut from
     * the text the drawn page was laid out from, so it is the block on
     * screen even when the file changed on disk since. Null with no block
     * there, `unread` when the page came without its text.
     */
    blockSource(fileKey: string, row: number): {text: string; lines: number} | 'unread' | null {
      const block = this.blockAt(fileKey, row);
      if (!block) return null;
      const text = known(fileKey)?.text;
      if (text === undefined) return 'unread';
      return {text: text.split('\n').slice(block.lines[0] - 1, block.lines[1]).join('\n'), lines: block.lines[1] - block.lines[0] + 1};
    },

    /** The first source line of the block a page row shows, for going back to the diff there. */
    lineAtRow(fileKey: string, row: number): number | null {
      return this.blockAt(fileKey, row)?.lines[0] ?? null;
    },

    /**
     * The block a page row shows: the innermost one that crosses it, else
     * the next one down. Null past the last block.
     */
    blockAt(fileKey: string, row: number): {id: string; lines: readonly [number, number]} | null {
      const page = known(fileKey);
      if (!page) return null;
      const span = rowSpan(page.geometry, row);
      const blocks = sourced(page.layout);
      const crossing = blocks.filter((block) => block.top < span.bottom && block.bottom > span.top).sort((left, right) => (left.bottom - left.top) - (right.bottom - right.top));
      const block = crossing[0] ?? blocks.filter((block) => block.top >= span.bottom).sort((left, right) => left.top - right.top)[0];
      return block ? {id: block.id, lines: block.lines} : null;
    },

    /** The page rows where a run of marked rows starts, top to bottom. */
    changeStarts(fileKey: string): number[] {
      const page = known(fileKey);
      if (!page) return [];
      const marks = rowMarks(page.layout, page.geometry, pageRows(page.geometry, page.layout.heightCss));
      return marks.flatMap((mark, row) => (mark && marks[row - 1] !== mark ? [row] : []));
    },

    /**
     * The link under a cell of a page row, `col` cells from the pane's
     * inner left edge. Only our own kinds of link count: a heading on the
     * page, another page of the review, a web or mail address.
     */
    hitTest(fileKey: string, row: number, col: number): LinkTarget | null {
      const page = known(fileKey);
      if (!page) return null;
      const {cellPx, dpr, leftPad} = page.geometry;
      const x = ((col - leftPad + 0.5) * cellPx.w) / dpr;
      const y = ((row + 0.5) * cellPx.h) / dpr;
      const link = page.layout.links.find((each) => x >= each.left && x <= each.right && y >= each.top && y <= each.bottom);
      if (!link) return null;
      if (link.href.startsWith('#')) {
        let id = link.href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // The repo's own text: a malformed escape names the id as written.
        }
        const anchor = page.layout.anchors.find((each) => each.id === id || each.id === `user-content-${id}`);
        return anchor ? {kind: 'anchor', row: rowAt(page.geometry, anchor.top)} : null;
      }
      const alias = FILE_ALIAS_LINK.exec(link.href)?.[1];
      if (alias) {
        const fileKey = fileForAlias(alias);
        return fileKey ? {kind: 'file', fileKey} : null;
      }
      return WEB_LINK.test(link.href) ? {kind: 'external', url: link.href} : null;
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
    /** Changes only when the rows a page takes change. */
    planVersion: () => planVersion,
    /** Messages for the footer since the last call. */
    takeNotices: () => notices.splice(0),
    /** Whether tiles cross a slow link: SSH or tmux. */
    slow,
    dispose() {
      disposed = true;
      if (idRetry) clearTimeout(idRetry);
      for (const controller of rendering.values()) controller.abort();
      rendering.clear();
    },
  };
}

export type RenderedPane = ReturnType<typeof createRenderedPane>;
