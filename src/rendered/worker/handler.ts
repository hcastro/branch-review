import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createLru} from '../../media/lru.js';
import type {WorkerFailure} from '../../media/workerClient.js';
import {createAssetResolver, LATE_IDENTITY, linkIdentity, pageLookups, type AssetResolver, type AssetSides, type AssetUse} from '../assets.js';
import {BROWSER_JOB_DEADLINES_MS, type EmbeddersResult, type FragmentRequest, type FragmentResult, type FragmentSummary, type LayoutResult, type RenderedWorkerRequest, type ReviewResult, type TileResult, type TileSource} from '../backend.js';
import {imageBody, imageFacts} from '../image.js';
import {renderMarkdown, type RenderInput, type RenderedFragment} from '../markdown.js';
import type {PageLayout} from '../plan.js';
import {assembleTileDocument, type PageBody} from '../page.js';
import {createSourceReader, oneLine, pageBody} from '../source.js';
import {MAX_TILE_PNG_BYTES, tileRange} from '../tileGeometry.js';
import {createBrowser, type Browser, type BrowserBudget, type TileDocument} from './browser.js';
import type {ChromeBinary} from './chrome.js';
import {createTileFinisher} from './mosaic.js';
import {createReviewBuilder} from '../review/build.js';

// The rendered worker's jobs, with no process of its own, so tests can run
// them in place. Repo text and images are read, rendered and assembled here;
// the UI gets back counts and the finished page. Fragments are held by key,
// so writing the page again costs no second render. An image's fragment is
// its two sides, inlined.
//
// The in-pane view's jobs lay out and cut a page's tile document in a
// headless Chromium, started on the first one and closed a minute after the
// last. Its failures are counted here, apart from the worker's own: three
// in a minute turn the in-pane view off, and the pages keep rendering. A
// browser job ends a margin before its deadline, so a browser that hangs,
// even on a cold start, fails as a browser failure and the worker lives.

const FRAGMENT_CACHE_BYTES = 32 * 1024 * 1024;
const BROWSER_IDLE_MS = 60_000;
const BROWSER_FAILURE_WINDOW_MS = 60_000;
const BROWSER_MAX_FAILURES = 3;
const TILES_OFF = 'off for this session';
// What a browser job leaves of its deadline for cutting the tile to size
// and sending the answer back.
const BROWSER_MARGIN_MS = 1_000;
const LAYOUT_CACHE_BYTES = 4 * 1024 * 1024;
// The tile documents laid out, which tiles are cut from.
const DRAWN_CACHE_BYTES = 16 * 1024 * 1024;
const STALE = 'the page changed since it was laid out';
// The files whose newest tile document is held past the budget: more
// than a screen shows pages of at once.
const NEWEST_FILES = 4;

// A tile document, with the markdown its blocks came from when it has any.
type DrawnDocument = TileDocument & {text?: string};

// `text`: the markdown a rendered body came from.
type Held = {body: PageBody; summary: FragmentSummary; uses: AssetUse[]; text?: string};

// JavaScript strings take two bytes a character.
function heldBytes(held: Held) {
  const body = held.body;
  const image = body.kind === 'image' ? [body.image.before, body.image.after].reduce((sum, side) => sum + (side?.kind === 'shown' ? side.dataUrl.length : 0), 0) : 0;
  const text = body.kind === 'rendered' ? body.fragment.html : body.kind === 'tooLarge' ? body.head : body.kind === 'failed' ? body.source : '';
  return (text.length + (held.text?.length ?? 0) + image) * 2 + 1024;
}

export function summarize(body: PageBody, uses: readonly AssetUse[] = []): FragmentSummary {
  // Lookups finish in whatever order git answers them, so the signature
  // reads them sorted and once each: the same images, the same signature.
  const named = [...new Set(uses.map((use) => JSON.stringify(use.kind === 'link' ? ['link', use.path, use.hash ?? null, use.identity] : [use.side, use.path, use.identity])))].sort();
  const assets = named.length === 0 ? '' : createHash('sha256').update(JSON.stringify(named)).digest('hex').slice(0, 20);
  const late = uses.some((use) => use.identity === LATE_IDENTITY) ? {late: true as const} : {};
  const empty: Pick<RenderedFragment, 'changes' | 'differences' | 'blocks' | 'headings' | 'links' | 'anchors' | 'images'> = {changes: {changed: 0, removed: 0}, differences: [], blocks: [], headings: [], links: [], anchors: [], images: []};
  if (body.kind === 'rendered') {
    const {changes, differences, blocks, headings, links, anchors, images} = body.fragment;
    return {kind: 'rendered', changes, differences, blocks, headings, links, anchors, images, assets, ...late};
  }
  if (body.kind === 'image') return {kind: 'image', ...empty, image: imageFacts(body.image), assets, ...late};
  return {kind: body.kind, ...empty, assets, ...late, ...(body.kind === 'failed' ? {reason: body.reason} : {})};
}

type HandlerOptions = {
  render?: (input: RenderInput) => Promise<RenderedFragment>;
  sleep?: (ms: number) => Promise<void>;
  // How long a page's image lookups may take, for a process whose jobs
  // have a deadline (pageLookups).
  lookupBudgetMs?: number;
  // The browser the in-pane view draws with, for a binary.
  browser?: (binary: ChromeBinary) => Browser;
  now?: () => number;
};

// Chromium's profile goes in the session dir, removed at exit.
const defaultBrowser = (binary: ChromeBinary) => createBrowser({binary, userDataDir: path.join(process.env.BRANCH_REVIEW_MEDIA_TMP ?? os.tmpdir(), 'chrome')});

export function createRenderedHandler({render = renderMarkdown, sleep, lookupBudgetMs, browser: makeBrowser = defaultBrowser, now = Date.now}: HandlerOptions = {}) {
  const sources = createSourceReader(sleep ? {sleep} : {});
  const resolvers = new Map<string, AssetResolver>();
  const held = createLru<Held>(FRAGMENT_CACHE_BYTES, heldBytes);

  const resolverFor = (cwd: string) => {
    let resolver = resolvers.get(cwd);
    if (!resolver) {
      resolver = createAssetResolver({cwd});
      resolvers.set(cwd, resolver);
    }
    return resolver;
  };

  // A held fragment is current while every image it looked up and every
  // link it checked would still get the same answer: the key covers the
  // file's own text, not the images it embeds nor the files its links
  // name. One with a lookup that ran out of time never is. The links are
  // asked again together, within one lookup budget; the resolver's answers
  // for the review keep that cheap.
  const current = async (entry: Held, cwd: string, sides: AssetSides) => {
    const resolver = resolverFor(cwd);
    if (entry.uses.some((use) => use.identity === LATE_IDENTITY)) return false;
    for (const use of entry.uses) {
      if (use.kind === 'asset' && await resolver.identity(sides, use.side, use.path) !== use.identity) return false;
    }
    const links = entry.uses.filter((use) => use.kind === 'link');
    if (links.length === 0) return true;
    const checks = Promise.all(links.map(async (use) => linkIdentity(await resolver.linkTarget(sides, use.path, use.hash).checked) === use.identity)).then((same) => same.every(Boolean));
    if (lookupBudgetMs === undefined) return checks;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), lookupBudgetMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([checks, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  async function fragment(request: FragmentRequest): Promise<Held> {
    const known = held.get(request.key);
    if (known && await current(known, request.cwd, request.assets)) return known;

    const uses: AssetUse[] = [];
    const budget = lookupBudgetMs === undefined ? {} : {budgetMs: lookupBudgetMs};
    let body: PageBody;
    let text: string | undefined;
    if (request.kind) {
      // Both sides as images, whatever the file's status says the page shows.
      const {asset, baseAsset} = pageLookups(resolverFor(request.cwd), request.assets, false, uses, budget);
      body = {kind: 'image', image: await imageBody({format: request.kind, path: request.path, ...(request.oldPath ? {oldPath: request.oldPath} : {}), status: request.status, asset, baseAsset})};
    } else {
      const lookups = pageLookups(resolverFor(request.cwd), request.assets, request.status === 'deleted', uses, budget);
      // Own keys only: a link to `constructor` names no file in the review.
      const link: RenderInput['link'] = (repoPath, hash) => (Object.hasOwn(request.links, repoPath) ? request.links[repoPath]! : lookups.linkTarget(repoPath, hash));
      const unchanged = request.textUnchanged ? {textUnchanged: true as const} : {};
      body = await pageBody(
        () => sources.read(request.cwd, request.source),
        (source) => {
          text = source;
          return render({path: request.path, ...(request.oldPath ? {basePath: request.oldPath} : {}), status: request.status, ...unchanged, source, groups: request.groups, ...lookups, link});
        },
      );
    }
    const entry: Held = {body, summary: summarize(body, uses), uses, ...(body.kind === 'rendered' && text !== undefined ? {text} : {})};
    // A failure can depend on the moment (a file mid-write), so it is
    // rendered again next time rather than held.
    if (body.kind !== 'failed') held.set(request.key, entry);
    return entry;
  }

  // The Review in browser page, from the fragments held here.
  // Every changed file's sides, read by the ids the review's patches name,
  // none of them fetched.
  const review = createReviewBuilder({sources: createSourceReader({...(sleep ? {sleep} : {}), local: true}), fragment, now});

  let browser: {binary: string; instance: Browser} | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let browserFailures: number[] = [];
  let tilesOff: string | null = null;
  const finishTile = createTileFinisher();

  const closeBrowser = () => {
    if (idle) clearTimeout(idle);
    idle = null;
    browser?.instance.close();
    browser = null;
  };

  const browserFor = (binary: ChromeBinary) => {
    if (browser?.binary !== binary.path) {
      closeBrowser();
      browser = {binary: binary.path, instance: makeBrowser(binary)};
    }
    if (idle) clearTimeout(idle);
    idle = setTimeout(closeBrowser, BROWSER_IDLE_MS);
    idle.unref?.();
    return browser.instance;
  };

  // The tile document for a source, named by everything it is drawn from,
  // with the markdown it was drawn from. `late`: a lookup it drew didn't
  // answer in time, or answered with a failure of the moment.
  const tileDocument = async (source: TileSource): Promise<{document: DrawnDocument; late: boolean}> => {
    const {fragment: request, scheme, bg, base, geometry, brokenRefs} = source;
    const {body, text, uses} = await fragment(request);
    const html = assembleTileDocument({file: {path: request.path, status: request.status, ...(request.oldPath ? {oldPath: request.oldPath} : {}), body}, scheme, bg, cssWidth: geometry.cssWidth, base, ...(brokenRefs ? {brokenRefs} : {})});
    const key = createHash('sha256').update(html).digest('hex').slice(0, 20);
    const late = uses.some((use) => use.identity === LATE_IDENTITY || use.identity.startsWith('retry:'));
    return {document: {key, html, cssWidth: geometry.cssWidth, dpr: geometry.dpr, scheme, ...(text !== undefined ? {text} : {})}, late};
  };

  // Laid-out documents by name, so each tile is cut from the very document
  // its layout measured, never one built again (a late image that has since
  // answered would move everything below it). Each file's newest is kept
  // whatever its size, for the few files laid out last, so pages past the
  // budget on screen together still draw and never evict each other.
  const drawn = createLru<DrawnDocument>(DRAWN_CACHE_BYTES, (document) => document.html.length * 2);
  const newest = new Map<string, DrawnDocument>();
  const hold = (file: string, document: DrawnDocument) => {
    drawn.set(document.key, document);
    newest.delete(file);
    newest.set(file, document);
    for (const oldest of newest.keys()) {
      if (newest.size <= NEWEST_FILES) break;
      newest.delete(oldest);
    }
  };
  const heldDocument = (key: string) => drawn.get(key) ?? [...newest.values()].find((document) => document.key === key);

  // Browser jobs take turns: they share Chromium's one page.
  let turn: Promise<unknown> = Promise.resolve();

  // Layouts by the document and scale they were laid out at, so asking
  // again for a page that didn't change asks the browser nothing.
  const layouts = createLru<PageLayout>(LAYOUT_CACHE_BYTES, (layout) => JSON.stringify(layout).length * 2);

  // Runs a browser job, counting its failure toward turning tiles off.
  // `budget`: when the job must be done, its deadline less the margin.
  function withBrowser<T extends LayoutResult | TileResult>(source: TileSource, budget: BrowserBudget, work: (browser: Browser) => Promise<T>): Promise<T | LayoutResult | TileResult> {
    const run = turn.then(() => browserJob(source, budget, work));
    turn = run.catch(() => undefined);
    return run;
  }

  async function browserJob<T extends LayoutResult | TileResult>(source: TileSource, budget: BrowserBudget, work: (browser: Browser) => Promise<T>): Promise<T | LayoutResult | TileResult> {
    if (tilesOff) return {ok: false, state: 'unavailable', reason: tilesOff, tilesOff: true};
    try {
      return await work(browserFor(source.chrome));
    } catch (error) {
      const reason = oneLine(error);
      const at = now();
      browserFailures = [...browserFailures.filter((when) => at - when < BROWSER_FAILURE_WINDOW_MS), at];
      if (browserFailures.length < BROWSER_MAX_FAILURES) return {ok: false, state: 'error', reason};
      // The failure that turns tiles off says so, so the pane goes back to
      // the diff now, not on some later job that may never come.
      tilesOff = `${reason} · ${TILES_OFF}`;
      closeBrowser();
      return {ok: false, state: 'unavailable', reason: tilesOff, tilesOff: true};
    }
  }

  const budgetFor = (type: keyof typeof BROWSER_JOB_DEADLINES_MS, startedAt: number): BrowserBudget => ({deadline: startedAt + BROWSER_JOB_DEADLINES_MS[type] - BROWSER_MARGIN_MS});

  return {
    async handle(message: RenderedWorkerRequest): Promise<FragmentResult | ReviewResult | EmbeddersResult | LayoutResult | TileResult> {
      // The job's deadline started when it was sent, a moment before this.
      const startedAt = Date.now();
      try {
        if (message.type === 'layout') {
          const budget = budgetFor('layout', startedAt);
          if (tilesOff) return {ok: false, state: 'unavailable', reason: tilesOff, tilesOff: true};
          const {document, late} = await tileDocument(message.source);
          hold(`${message.source.fragment.cwd}\0${message.source.fragment.path}`, document);
          return await withBrowser(message.source, budget, async (instance) => {
            const name = `${document.key}@${document.dpr}`;
            const layout = layouts.get(name) ?? await instance.layout(document, budget);
            layouts.set(name, layout);
            return {ok: true, layout, document: document.key, ...(document.text !== undefined ? {text: document.text} : {}), ...(late ? {late: true as const} : {})};
          });
        }
        if (message.type === 'tile') {
          const {source, index, rows, mosaic} = message;
          // Cut from the document its layout measured, or from none: one
          // no longer held is laid out again, and no browser is asked.
          const document = heldDocument(message.document);
          if (!document) return {ok: false, state: 'error', reason: STALE, stale: true};
          const range = tileRange(index, rows, source.geometry);
          const budget = budgetFor('tile', startedAt);
          return await withBrowser(source, budget, async (instance): Promise<TileResult> => {
            // A device pixel more than the tile, since Chromium rounds a
            // fractional clip down; the finisher cuts it to the exact size.
            const drawn = await instance.capture(document, {cssY: range.cssY, cssHeight: range.cssHeight + 1 / source.geometry.dpr}, budget);
            const cells = mosaic ? {cols: source.geometry.sheetCols, rows: range.rows} : undefined;
            const finished = await finishTile(drawn, {width: range.width, height: range.height, bg: source.bg, ...(cells ? {cells} : {})});
            if (finished.png.byteLength > MAX_TILE_PNG_BYTES) return {ok: false, state: 'error', reason: 'tile too large', tooLarge: true};
            return {ok: true, ...finished};
          });
        }
        if (message.type === 'fragment') {
          const {type: _type, ...request} = message;
          return {ok: true, summary: (await fragment(request)).summary};
        }
        if (message.type === 'review') {
          const {type: _type, ...request} = message;
          const {html, partial} = await review.page(request);
          return {ok: true, html, ...(partial ? {partial: true as const} : {})};
        }
        return {ok: true, files: await resolverFor(message.cwd).embedders(message.assets, message.names, new Set(message.skip))};
      } catch (error) {
        return {ok: false, state: 'error', reason: oneLine(error)} satisfies WorkerFailure;
      }
    },
    /** Closes the browser, for a worker that is going away. */
    dispose: closeBrowser,
  };
}
