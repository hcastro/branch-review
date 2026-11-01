import {IMAGE_IDS, type ImageRegistry} from '../media/imageRegistry.js';
import type {BoxSpec, PlanRow} from '../media/layout.js';
import {createLru} from '../media/lru.js';
import type {GraphicsCaps} from '../media/types.js';
import {blockForSourceLine} from './anchor.js';
import type {FragmentRequest, LayoutResult, RenderedBackend, TileSource} from './backend.js';
import {FILE_ALIAS_LINK} from './keys.js';
import {oneLine} from './source.js';
import {HEADLESS} from './surface.js';
import {planRenderedRows, rowAt, rowMarks, rowSpan, type LayoutBlock, type LayoutBox, type LayoutLink, type PageLayout} from './plan.js';
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
// It is offered in a terminal that draws Kitty images unless
// BRANCH_REVIEW_PANE turns it off, and advertised only where it can draw:
// a Chromium found and the cell size known. A failure never strands the
// reader on a page that won't come: a layout or tile that failed, tiles
// on screen still not drawn after a hold of 5 s, or a tile the terminal
// has no room for sends that file back to its diff, with one toast, until
// the next `v` asks again. Only the browser or the worker giving up ends it
// for the session.

// Where the reader can still read the page when the pane can't draw it:
// `r`, or where `r` opens nothing (over SSH, or with no browser opener),
// the pages `--render-out` writes.
const R_OPENS = 'r opens it in the browser';
const needsChrome = (elsewhere: string) => `the in-pane view needs Chrome · set BRANCH_REVIEW_CHROME or install chrome-headless-shell · ${elsewhere}`;
/** What `v` says when no Chromium is found; `r` needs none. */
export const PANE_NEEDS_CHROME = needsChrome(R_OPENS);
/** What `v` says when the terminal didn't answer CSI 16t: a tile sized from a guess would be scaled, and blurred. */
export const PANE_NEEDS_CELL_SIZE = "the terminal didn't report its cell size, which sharp tiles need · r opens it rendered";

const TILE_CACHE_BYTES = 48 * 1024 * 1024;
// The terminal background when it didn't answer OSC 11.
const FALLBACK = {bg: '#111318', scheme: 'dark' as const};
const LAYING_OUT = 'laying out the page…';
// The shade a page row holds at until its tile comes.
const SHADE = '░';
const TOO_NARROW = 'the pane is too narrow for the page · r opens it rendered';
const TOO_LARGE = 'a part of the page is too large to draw here';
const TOO_LONG = 'the page is too long to draw here · r opens it rendered';
// How long the screen may wait for a page row's tile before the file goes
// back to its diff. A layout is no part of it: its job has its own
// deadline, long enough for Chromium's cold start.
export const PANE_HOLD_MS = 5_000;
const HELD = `the page didn't draw within ${PANE_HOLD_MS / 1000} s`;
const NO_ROOM = "the terminal's image memory is full";
const NO_IDS = 'every terminal image id is in use';
// Values of BRANCH_REVIEW_PANE that turn the view off; any other leaves it on.
const TURNED_OFF = new Set(['off', '0', 'false', 'none']);
// The active file's page is laid out first, then tiles near the screen
// (priority 0 on it, 1 near it), then every other page the pane covers.
const ACTIVE_LAYOUT = 0;
const OTHER_LAYOUT = 2;
// A layout that drew an image or link that didn't answer in time is asked
// for again this long after, at most this many times.
const LATE_RETRY_MS = 1_000;
const LATE_RETRIES = 3;

/** Whether BRANCH_REVIEW_PANE turns the in-pane view off. */
export function paneTurnedOff(env: NodeJS.ProcessEnv) {
  return TURNED_OFF.has((env.BRANCH_REVIEW_PANE ?? '').trim().toLowerCase());
}

/**
 * The page's scale: type-matched, or the one BRANCH_REVIEW_PANE_DPR names,
 * for comparing scales by eye. Anything but a positive number is ignored.
 */
export function paneDpr(env: NodeJS.ProcessEnv): DprMode {
  const fixed = Number(env.BRANCH_REVIEW_PANE_DPR);
  return env.BRANCH_REVIEW_PANE_DPR && Number.isFinite(fixed) && fixed > 0 ? fixed : 'type';
}

/**
 * What a click on a page row leads to. Repo URLs are copied, never opened,
 * and only as a URL parsed clean; one that holds control characters is
 * `refused`, with the reason the footer shows.
 */
export type LinkTarget = {kind: 'anchor'; row: number} | {kind: 'file'; fileKey: string} | {kind: 'external'; url: string} | {kind: 'refused'; reason: string};

/** Why a link isn't copied. */
export const LINK_HAS_CONTROLS = 'this link holds control characters · not copied';

export type PaneBoxState = {status: 'kitty'; id: number} | {status: 'loading'};

export type PaneGeometryInput = {innerCols: number; viewportRows: number};

type LayoutEntry = {status: 'pending'} | {status: 'ready'; layout: PageLayout; document: string; text?: string} | {status: 'failed'; reason: string};
type Tile = {png: Uint8Array; mosaic?: Uint8Array};
// What a tile key stands for, so a want can render it: `document` is the
// name of the tile document it is cut from, which the file's layout
// `layoutKey` answered.
type TileMeta = {source: TileSource; document: string; index: number; rows: number; fileKey: string; layoutKey: string};
type Failure = Extract<LayoutResult, {ok: false}>;

// The blocks that name the source lines they came from.
const sourced = (layout: PageLayout) => layout.blocks.filter((block): block is LayoutBlock & {lines: readonly [number, number]} => block.lines !== undefined);

// C0 controls, DEL and C1 controls: a newline, ESC or BEL in an href
// would reach the clipboard, and the terminal of whoever pastes it.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const WEB_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function createRenderedPane({backend, registry, caps, env, chrome, source, fileForAlias, browserOpens = true}: {
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
  /** Whether `r` opens a page here, which the toasts point to when it does. */
  browserOpens?: boolean;
}) {
  const elsewhere = browserOpens ? R_OPENS : HEADLESS;
  const offered = !paneTurnedOff(env) && caps.protocol === 'kitty' && Boolean(backend.layout && backend.tile);
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
  // By file key: the layout keys it has entries under, at most the one
  // drawn and the newest asked for.
  const fileLayouts = new Map<string, Set<string>>();
  // How often each late layout was asked for again, and the timers that will.
  const lateTries = new Map<string, number>();
  const lateTimers = new Set<ReturnType<typeof setTimeout>>();
  // Documents the worker no longer holds: their tiles wait for the layout asked again.
  const staleDocuments = new Set<string>();
  const layoutPriority = (fileKey: string) => (fileKey === focused ? ACTIVE_LAYOUT : OTHER_LAYOUT);
  const tiles = createLru<Tile>(TILE_CACHE_BYTES, (tile) => tile.png.byteLength + (tile.mosaic?.byteLength ?? 0));
  const tileMeta = new Map<string, TileMeta>();
  const rendering = new Map<string, AbortController>();
  // By file key: why its page failed. It shows its diff until the next `v`.
  const failed = new Map<string, string>();
  // By file key: the toast of a failure off screen, said once the reader
  // reaches the file, so a page failing in the background never reads as
  // the one the reader is on.
  const untold = new Map<string, string>();
  // The files with a page row on screen at the last want.
  let screenFiles: ReadonlySet<string> = new Set();
  // What the screen waits for, and since when: a tile on screen with no id
  // yet, by its key.
  const holding = new Map<string, {fileKey: string; since: number}>();
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
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

  // The file back to its diff until the next `v`, saying why once: now
  // when the reader is on it or it is on screen, else when the reader
  // reaches it. Only while the pane draws pages: an answer that comes after
  // `v` went back is no one's failure. It changes the plan without telling
  // the listeners, which the caller does once: two renders for one change
  // would let the place-keeping of the first see rows the second moves.
  const fail = (fileKey: string, reason: string) => {
    if (mode !== 'rendered' || off || failed.has(fileKey)) return;
    failed.set(fileKey, reason);
    for (const [key, held] of holding) if (held.fileKey === fileKey) holding.delete(key);
    const notice = `✗ in-pane view: ${oneLine(reason)} · ${elsewhere}`;
    if (fileKey === focused || screenFiles.has(fileKey)) notices.push(notice);
    else untold.set(fileKey, notice);
    planVersion += 1;
  };

  // Back to the diff for the session, saying why once. Like `fail`, the
  // caller tells the listeners.
  const turnOff = (message: string) => {
    if (off) return;
    off = message;
    mode = 'diff';
    untold.clear();
    notices.push(off);
    planVersion += 1;
  };
  // The worker gave up: `r` and `R` stop too, so the toast offers neither.
  const workerOff = (reason: string) => turnOff(`✗ in-pane view: ${oneLine(reason)}`);

  // Whether a failed job means the pane can't go on: the browser gave up
  // for the session (pages still open with r), or the worker did (they
  // don't). Either way the pane goes back to the diff.
  const gaveUp = (failure: Failure) => {
    if (failure.tilesOff) {
      turnOff(`✗ ${oneLine(failure.reason)} · ${elsewhere}`);
      return true;
    }
    const disabled = backend.disabledReason();
    if (failure.state !== 'unavailable' && !disabled) return false;
    workerOff(disabled ?? failure.reason);
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

  // The block a page row shows: the smallest whose box holds the row's
  // center, else the one that overlaps the row most, else (a row between
  // blocks) the next one down. Null past the last block.
  const blockBoxAt = (page: Drawn, row: number) => {
    const span = rowSpan(page.geometry, row);
    const center = (span.top + span.bottom) / 2;
    const blocks = sourced(page.layout);
    const size = (block: LayoutBox) => block.bottom - block.top;
    const overlap = (block: LayoutBox) => Math.min(block.bottom, span.bottom) - Math.max(block.top, span.top);
    const holding = blocks.filter((block) => block.top <= center && center < block.bottom).sort((left, right) => size(left) - size(right));
    const crossing = blocks.filter((block) => overlap(block) > 0).sort((left, right) => overlap(right) - overlap(left));
    return holding[0] ?? crossing[0] ?? blocks.filter((block) => block.top >= span.bottom).sort((left, right) => left.top - right.top)[0] ?? null;
  };
  const lastCols = new Map<string, number>();
  const known = (fileKey: string) => shown.get(fileKey) ?? null;

  // Drops what no drawn page names: tile names and short-tile marks of
  // documents no file draws.
  const pruneDocuments = () => {
    const live = new Set([...shown.values()].map((each) => each.document));
    for (const [key, meta] of tileMeta) if (!live.has(meta.document)) tileMeta.delete(key);
    for (const document of shortTiles) if (!live.has(document)) shortTiles.delete(document);
    for (const document of staleDocuments) if (!live.has(document)) staleDocuments.delete(document);
  };

  const forget = (fileKey: string, layoutKey: string) => {
    layouts.delete(layoutKey);
    lateTries.delete(layoutKey);
    fileLayouts.get(fileKey)?.delete(layoutKey);
  };

  // `again`: the page drawn under this key is asked for anew (a late
  // image), and kept when that answer fails.
  const askLayout = (fileKey: string, layoutKey: string, tileSource: TileSource, again = false) => {
    // A file keeps the entry it draws and the one asked for now; any other
    // is a geometry or a review it has left.
    const keys = fileLayouts.get(fileKey) ?? new Set<string>();
    fileLayouts.set(fileKey, keys);
    const drawnKey = shown.get(fileKey)?.layoutKey;
    for (const key of [...keys]) if (key !== layoutKey && key !== drawnKey) forget(fileKey, key);
    keys.add(layoutKey);
    waiting.get(fileKey)?.abort();
    layouts.set(layoutKey, {status: 'pending'});
    const controller = new AbortController();
    waiting.set(fileKey, controller);
    void backend.layout!({source: tileSource}, controller.signal, layoutPriority(fileKey)).then((result) => {
      if (waiting.get(fileKey) === controller) waiting.delete(fileKey);
      if (disposed || controller.signal.aborted || layouts.get(layoutKey)?.status !== 'pending') return;
      if (result.ok) {
        const text = result.text === undefined ? {} : {text: result.text};
        layouts.set(layoutKey, {status: 'ready', layout: result.layout, document: result.document, ...text});
        const before = shown.get(fileKey)?.layoutKey;
        shown.set(fileKey, {layoutKey, layout: result.layout, document: result.document, geometry: tileSource.geometry, tileSource, ...text});
        if (before !== undefined && before !== layoutKey) forget(fileKey, before);
        staleDocuments.delete(result.document);
        pruneDocuments();
        if (result.late) retryLate(fileKey, layoutKey, tileSource);
      } else {
        layouts.set(layoutKey, {status: 'failed', reason: oneLine(result.reason)});
        const drawn = shown.get(fileKey);
        // A retry that failed leaves the page as it was drawn, and the
        // retries it has left still come, unless the browser or the worker
        // gave up for the session. A page whose document the worker no
        // longer holds can't cut the tiles it still lacks: the file goes
        // back to its diff, and the next `v` asks again.
        if (!gaveUp(result)) {
          if (again && drawn?.layoutKey === layoutKey && !staleDocuments.has(drawn.document)) {
            layouts.set(layoutKey, {status: 'ready', layout: drawn.layout, document: drawn.document, ...(drawn.text === undefined ? {} : {text: drawn.text})});
            retryLate(fileKey, layoutKey, tileSource);
          } else {
            fail(fileKey, result.reason);
          }
        }
      }
      planChanged();
    }, () => {
      // Aborted: a newer layout of the file replaced it.
    });
  };

  // A page drawn with an image or link still late is laid out again a
  // second later, the page on screen kept until the newer answer lands.
  // At most LATE_RETRIES times per layout key, whether the retries land
  // late again or fail.
  const retryLate = (fileKey: string, layoutKey: string, tileSource: TileSource) => {
    const tries = lateTries.get(layoutKey) ?? 0;
    if (tries >= LATE_RETRIES) return;
    lateTries.set(layoutKey, tries + 1);
    const timer = setTimeout(() => {
      lateTimers.delete(timer);
      if (disposed || layouts.get(layoutKey)?.status !== 'ready' || shown.get(fileKey)?.layoutKey !== layoutKey) return;
      askLayout(fileKey, layoutKey, tileSource, true);
    }, LATE_RETRY_MS);
    timer.unref?.();
    lateTimers.add(timer);
  };

  // The worker no longer holds the document a tile was to be cut from (it
  // was evicted, or the worker started anew): the page is laid out again,
  // and drawn as it is until that lands.
  const relayout = (meta: TileMeta) => {
    staleDocuments.add(meta.document);
    const drawn = shown.get(meta.fileKey);
    if (!drawn || drawn.document !== meta.document || layouts.get(drawn.layoutKey)?.status === 'pending') return;
    layouts.delete(drawn.layoutKey);
    askLayout(meta.fileKey, drawn.layoutKey, drawn.tileSource);
  };

  const textRow = (text: string): PlanRow => ({type: 'text', role: 'loading', pieces: [{at: GUTTER_COLS, parts: [{text, tone: 'dim'}]}]});
  // A page row whose tile is on its way, in the shade the pane holds at.
  const shadeRow = (geometry: PageGeometry): PlanRow => ({type: 'text', role: 'loading', pieces: [{at: geometry.leftPad, parts: [{text: SHADE.repeat(geometry.sheetCols), tone: 'dim'}]}]});

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
  // next want, a loop of transmits. One on screen that the terminal has no
  // room or id for, even with every tile off screen let go, would hold the
  // screen in shade for good: its file goes back to the diff. An id still
  // in quarantine comes free in a moment.
  const send = (box: BoxSpec, tile: Tile, fileKey: string) => {
    if (!visibleKeys.has(box.imageKey)) {
      if (registry.fits(tile.png, undefined, 'page')) registry.acquire(box.imageKey, tile.png, box.cols, box.rows, undefined, 'page');
      return false;
    }
    if (!registry.fitsOnScreen(tile.png, visibleKeys, 'page')) {
      fail(fileKey, NO_ROOM);
      return false;
    }
    if (registry.acquire(box.imageKey, tile.png, box.cols, box.rows, undefined, 'page') !== null) return true;
    if (registry.liveCount() >= IMAGE_IDS) fail(fileKey, NO_IDS);
    else retryWhenIdFree();
    return false;
  };

  // Watches what the screen waits for, given as a key to its file: what
  // has waited a hold's length sends its file back to the diff. What the
  // screen no longer waits for, or no longer shows, starts afresh.
  const watchHold = (waiting: ReadonlyMap<string, string>) => {
    const at = Date.now();
    for (const key of holding.keys()) if (!waiting.has(key)) holding.delete(key);
    for (const [key, fileKey] of waiting) if (!holding.has(key)) holding.set(key, {fileKey, since: at});
    armHold();
  };
  const armHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    if (holding.size === 0 || disposed) return;
    const first = Math.min(...[...holding.values()].map((held) => held.since));
    holdTimer = setTimeout(() => {
      holdTimer = null;
      const at = Date.now();
      const plan = planVersion;
      for (const [key, held] of [...holding]) {
        // A tile that came in since the last want is drawn: the want after
        // the next commit would have let it go anyway.
        if (registry.idFor(key) !== undefined) {
          holding.delete(key);
          continue;
        }
        if (at - held.since < PANE_HOLD_MS) continue;
        holding.delete(key);
        fail(held.fileKey, HELD);
      }
      if (planVersion !== plan) notify();
      armHold();
    }, Math.max(0, first + PANE_HOLD_MS - Date.now()));
    holdTimer.unref?.();
  };

  const render = (box: BoxSpec, meta: TileMeta, priority: number) => {
    const controller = new AbortController();
    rendering.set(box.imageKey, controller);
    void backend.tile!({source: meta.source, document: meta.document, index: meta.index, rows: meta.rows, mosaic: !slow}, controller.signal, priority).then((result) => {
      if (controller.signal.aborted || disposed) return;
      rendering.delete(box.imageKey);
      // A tile of a page the file no longer draws is no tile of its page.
      if (shown.get(meta.fileKey)?.document !== meta.document) return;
      if (!result.ok && result.stale) {
        relayout(meta);
        return;
      }
      if (result.ok) {
        const tile: Tile = result.mosaic ? {png: result.png, mosaic: result.mosaic} : {png: result.png};
        tiles.set(box.imageKey, tile);
        if (liveKeys.has(box.imageKey)) send(box, tile, meta.fileKey);
      } else if (gaveUp(result)) {
        // Back on the diff for the session.
      } else if (result.tooLarge && meta.source.geometry.tileRows > SHORT_TILE_ROWS) {
        shortTiles.add(meta.document);
        planVersion += 1;
      } else {
        // Already as short as tiles go, a tile too large can't be drawn either.
        fail(meta.fileKey, result.tooLarge ? TOO_LARGE : result.reason);
      }
      notify();
    }, () => {
      // Aborted: no row names the tile any more.
    });
  };

  return {
    /** Whether `v` on markdown means the page in the pane here, though it may only say why it can't draw. */
    offered: () => offered,
    /**
     * Whether the footer names `v`: offered, with a Chromium found, the
     * cell size known, and neither the pane nor the rendered worker turned
     * off for the session. Looks for Chromium on disk the first time, and
     * never starts it.
     */
    advertised: () => offered && !off && !backend.disabledReason() && caps.cellPxSource === 'csi16' && chrome() !== null,
    /** The file the reader is on, whose page is laid out ahead of the rest. */
    focus(fileKey: string) {
      if (fileKey === focused) return;
      const before = focused;
      focused = fileKey;
      const notice = untold.get(fileKey);
      if (notice) {
        untold.delete(fileKey);
        notices.push(notice);
        notify();
      }
      for (const key of [before, fileKey]) {
        const controller = key === null ? undefined : waiting.get(key);
        if (controller) backend.prioritize?.(controller.signal, layoutPriority(key!));
      }
    },
    mode: () => mode,
    /** Whether the file's diff becomes a page in the pane. */
    covers: (fileKey: string) => source(fileKey) !== null,
    /** Whether the pane shows the file's page now: it draws pages, and that page hasn't failed since the last `v`. */
    shows: (fileKey: string) => mode === 'rendered' && !failed.has(fileKey) && source(fileKey) !== null,

    /** Turns the pane to pages, or says why it can't. */
    enter(): {ok: true} | {ok: false; message: string} {
      const disabled = backend.disabledReason();
      if (disabled) return {ok: false, message: `✗ ${oneLine(disabled)}`};
      if (off) return {ok: false, message: off};
      if (caps.cellPxSource !== 'csi16') return {ok: false, message: PANE_NEEDS_CELL_SIZE};
      if (!chrome()) return {ok: false, message: needsChrome(elsewhere)};
      // What failed before is asked for again: a browser that crashed
      // starts anew, and only three failures in a minute turn it off.
      for (const [key, entry] of layouts) if (entry.status === 'failed') layouts.delete(key);
      failed.clear();
      untold.clear();
      mode = 'rendered';
      planChanged();
      return {ok: true};
    },
    /** Back to the diff, at once. A page that failed out of sight is no one's news now. */
    leave() {
      if (mode === 'diff') return;
      mode = 'diff';
      untold.clear();
      planChanged();
    },

    /**
     * The rows the file's page takes at this pane width: a label, then one
     * box row per page row once Chromium laid it out, or a row saying why
     * not yet. Asks for the layout the first time.
     */
    rows(fileKey: string, {innerCols}: PaneGeometryInput): PlanRow[] {
      if (failed.has(fileKey)) return [];
      const page = pageFor(fileKey, innerCols);
      if (!page) return [];
      const label = textRow(page.shown.fragment.path);
      layingOut.delete(fileKey);
      if (!page.geometry || !page.tileSource) return [label, textRow(TOO_NARROW)];
      lastCols.set(fileKey, innerCols);
      let entry = layouts.get(page.layoutKey);
      if (!entry) {
        askLayout(fileKey, page.layoutKey, page.tileSource);
        entry = layouts.get(page.layoutKey)!;
      }
      const was = shown.get(fileKey)?.layoutKey;
      if (entry.status === 'ready' && was !== undefined && was !== page.layoutKey) forget(fileKey, was);
      if (entry.status === 'ready') shown.set(fileKey, {layoutKey: page.layoutKey, layout: entry.layout, document: entry.document, geometry: page.geometry, tileSource: page.tileSource, ...(entry.text === undefined ? {} : {text: entry.text})});
      const before = shown.get(fileKey);
      const drawn = entry.status === 'ready' || (entry.status === 'pending' && before && geometryKey(before.geometry) === geometryKey(page.geometry)) ? before! : null;
      if (!drawn) {
        // A failure sent the file back to its diff when it landed.
        if (entry.status === 'failed') return [];
        layingOut.add(fileKey);
        // A new geometry (a resize): the page's rows at its new size, as
        // the shade of a page on its way, never the old tiles stretched.
        // What was drawn stays known, so the reader's place can be found.
        if (before) return [label, ...Array.from({length: pageRows(page.geometry, before.layout.heightCss)}, () => shadeRow(page.geometry))];
        return [label, textRow(LAYING_OUT)];
      }
      const {layout, document} = drawn;
      const geometry = shortTiles.has(document) ? tileGeometry(innerCols, caps.cellPx, dprMode, SHORT_TILE_ROWS)! : drawn.geometry;
      const tileSource: TileSource = {...drawn.tileSource, geometry};
      const rows = pageRows(geometry, layout.heightCss);
      return [label, ...planRenderedRows(layout, geometry, (index) => {
        const key = `page:${document}:${geometryKey(geometry)}:${index}`;
        tileMeta.set(key, {source: tileSource, document, index, rows, fileKey, layoutKey: drawn.layoutKey});
        return key;
      }), ...(pageCut(geometry, layout.heightCss) ? [textRow(TOO_LONG)] : [])];
    },

    boxState(box: BoxSpec): PaneBoxState {
      const id = registry.idFor(box.imageKey);
      return id === undefined ? {status: 'loading'} : {status: 'kitty', id};
    },

    /** Each cell's mean color in a rendered tile, RGB row by row, or null. */
    mosaic: (box: BoxSpec) => tiles.get(box.imageKey)?.mosaic ?? null,

    /**
     * Whether the page on screen can be drawn: no file among `files` (those
     * with a row on screen) is still laying out, and every tile on screen
     * has its id.
     */
    ready: (visible: ReadonlySet<string>, files: ReadonlySet<string> = new Set()) => (
      ![...files].some((fileKey) => layingOut.has(fileKey)) && [...visible].every((key) => registry.idFor(key) !== undefined)
    ),

    /**
     * After each commit, with the page's boxes near the viewport and the
     * files with a page row on screen: sends what is cut, cuts what is not,
     * and marks what is drawn as used. Over a slow link, only the screen
     * and the next tile below. A tile the screen still waits for is held
     * for at most PANE_HOLD_MS.
     */
    want(boxes: ReadonlyArray<{fileKey: string; box: BoxSpec}>, visible: ReadonlySet<string>, files: ReadonlySet<string> = new Set()) {
      if (disposed || off) return;
      // The worker gave up while the page was drawn from tiles cut before.
      const disabled = backend.disabledReason();
      if (disabled && mode === 'rendered') {
        workerOff(disabled);
        notify();
        return;
      }
      visibleKeys = visible;
      screenFiles = new Set([...files, ...boxes.filter(({box}) => visible.has(box.imageKey)).map(({fileKey}) => fileKey)]);
      const plan = planVersion;
      // A tile still waiting for the worker follows the screen: first when
      // it is on screen, next when near; one the screen has gone past (out
      // of the window `boxes` covers) is dropped, not cut for nothing.
      const near = new Set(boxes.map(({box}) => box.imageKey));
      for (const [key, controller] of rendering) {
        if (!near.has(key)) {
          controller.abort();
          rendering.delete(key);
          continue;
        }
        backend.prioritize?.(controller.signal, visible.has(key) ? 0 : 1);
      }
      let lastVisible = -1;
      if (slow) for (const [at, {box}] of boxes.entries()) if (visible.has(box.imageKey)) lastVisible = at;
      let changed = false;
      for (const [at, {fileKey, box}] of boxes.entries()) {
        const key = box.imageKey;
        if (slow && !visible.has(key) && at !== lastVisible + 1) continue;
        if (failed.has(fileKey)) continue;
        if (registry.idFor(key) !== undefined) {
          registry.touch(key);
          continue;
        }
        const tile = tiles.get(key);
        if (tile) {
          if (send(box, tile, fileKey)) changed = true;
          continue;
        }
        const meta = tileMeta.get(key);
        if (meta && !rendering.has(key) && !staleDocuments.has(meta.document)) render(box, meta, visible.has(key) ? 0 : 1);
      }
      const waiting = new Map<string, string>();
      if (mode === 'rendered') {
        for (const {fileKey, box} of boxes) if (visible.has(box.imageKey) && !failed.has(fileKey) && registry.idFor(box.imageKey) === undefined) waiting.set(box.imageKey, fileKey);
      }
      watchHold(waiting);
      if (changed || planVersion !== plan) notify();
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
      pruneDocuments();
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

    /**
     * The page row that shows source line `line`, for opening the pane
     * where the diff was: its block's first row, or the row `within` (0 to
     * 1) of the way down the block.
     */
    rowForLine(fileKey: string, line: number, within = 0): number | null {
      const page = known(fileKey);
      const blocks = page ? sourced(page.layout) : [];
      const block = blocks[blockForSourceLine(blocks, line)];
      return page && block ? rowAt(page.geometry, block.top + within * (block.bottom - block.top)) : null;
    },

    /**
     * Where a page row is in the source: the first line of the block it
     * shows and how far down that block the row's top is (0 to 1), for
     * keeping the reader's place when the page is laid out anew.
     */
    placeAt(fileKey: string, row: number): {line: number; within: number} | null {
      const page = known(fileKey);
      const block = page ? blockBoxAt(page, row) : null;
      if (!page || !block) return null;
      const height = block.bottom - block.top;
      const top = rowSpan(page.geometry, row).top;
      return {line: block.lines[0], within: height > 0 ? Math.min(1, Math.max(0, (top - block.top) / height)) : 0};
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
     * The block a page row shows: the smallest whose box holds the row's
     * center, else the one that overlaps the row most, else (a row between
     * blocks) the next one down. Null past the last block.
     */
    blockAt(fileKey: string, row: number): {id: string; lines: readonly [number, number]} | null {
      const page = known(fileKey);
      const block = page ? blockBoxAt(page, row) : null;
      return block ? {id: block.id, lines: block.lines} : null;
    },

    /**
     * The mark the page gave the block `blockAt` names: `added` or
     * `modified`, or null for a block the branch didn't change or no block.
     */
    markAt(fileKey: string, row: number): 'added' | 'modified' | null {
      const page = known(fileKey);
      return (page ? blockBoxAt(page, row)?.mark : undefined) ?? null;
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
      // A link is under the point when one of its boxes is; of several,
      // the one whose box there is smallest, the most specific.
      let link: LayoutLink | null = null;
      let smallest = Infinity;
      for (const each of page.layout.links) {
        for (const rect of each.rects) {
          if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
          const area = (rect.right - rect.left) * (rect.bottom - rect.top);
          if (area < smallest) {
            smallest = area;
            link = each;
          }
        }
      }
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
      if (CONTROLS.test(link.href)) return {kind: 'refused', reason: LINK_HAS_CONTROLS};
      let parsed: URL;
      try {
        parsed = new URL(link.href);
      } catch {
        return null;
      }
      return WEB_PROTOCOLS.has(parsed.protocol) ? {kind: 'external', url: parsed.href} : null;
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
    /** For tests: how much per-file state the pane holds. */
    stateSizes: () => ({layouts: layouts.size, tileMeta: tileMeta.size, shortTiles: shortTiles.size, waiting: waiting.size}),
    dispose() {
      disposed = true;
      if (idRetry) clearTimeout(idRetry);
      if (holdTimer) clearTimeout(holdTimer);
      for (const timer of lateTimers) clearTimeout(timer);
      lateTimers.clear();
      for (const controller of waiting.values()) controller.abort();
      for (const controller of rendering.values()) controller.abort();
      rendering.clear();
    },
  };
}

export type RenderedPane = ReturnType<typeof createRenderedPane>;
