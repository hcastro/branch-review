import type {FileStatus} from '../git.js';
import type {WorkerFailure} from '../media/workerClient.js';
import type {AssetSides} from './assets.js';
import type {ChangeGroup} from './changes.js';
import type {ImageFacts} from './image.js';
import type {LinkAnswer, RenderedFragment} from './markdown.js';
import type {PageBody, PageFile, PageInput, RailEntry} from './page.js';
import type {ReviewPageCard, ReviewPageInput} from './review/page.js';
import type {PageLayout} from './plan.js';
import type {SourceSpec} from './source.js';
import type {PageGeometry} from './tileGeometry.js';
import type {ChromeBinary} from './worker/chrome.js';

// The jobs the UI process asks of the rendered worker, and their answers.
// The UI side only sees this interface, so service tests can answer it in
// process. The worker keeps each fragment's HTML; the UI holds what it needs
// to name pages and label the rail.

/** One file to render, from the side the review shows: markdown, or an image's own page. */
export type FragmentRequest = {
  cwd: string;
  /** An image or SVG file's page; markdown when left out. */
  kind?: 'raster' | 'svg';
  /** Markdown whose text the review didn't change, marked by the images it shows alone. */
  textUnchanged?: true;
  /** Names the fragment's content: the same key, the same HTML, unless an image it embeds changed. */
  key: string;
  path: string;
  /** Where the file was on the base side, when the review moved it: the base side's images resolve from there. */
  oldPath?: string;
  status: FileStatus;
  source: SourceSpec;
  groups: ChangeGroup[];
  /** How a link to each rendered file resolves; any other repo path is outside the review. */
  links: Record<string, LinkAnswer>;
  assets: AssetSides;
};

/** What the UI keeps of a fragment: its page's state and counts, never its HTML. */
export type FragmentSummary = {
  kind: PageBody['kind'];
  changes: RenderedFragment['changes'];
  differences: RenderedFragment['differences'];
  blocks: RenderedFragment['blocks'];
  headings: RenderedFragment['headings'];
  links: RenderedFragment['links'];
  // What the link and anchor report reads; none for a page with nothing to report.
  anchors?: RenderedFragment['anchors'];
  images?: RenderedFragment['images'];
  /** An image's page: its sides' sizes. */
  image?: ImageFacts;
  /** A failed page's one-line reason. */
  reason?: string;
  /** Names the images the page embeds and how each resolved: it changes when one of them does. */
  assets: string;
  /** An image lookup ran out of time, so rendering again can show and mark more. */
  late?: true;
};

export type FragmentResult = {ok: true; summary: FragmentSummary} | WorkerFailure;

/**
 * One whole page. Its body is the fragment the worker rendered for that
 * request (rendered again if the worker no longer holds it), or a body the
 * UI already knows, such as a file whose render kept timing out.
 */
export type PageRequest = {
  key: string;
  title: PageInput['title'];
  file: {path: string; status: FileStatus; oldPath?: string; also?: PageFile['also']};
  rail: RailEntry[];
  content: {fragment: FragmentRequest} | {body: PageBody};
} & Pick<PageInput, 'brokenRefs' | 'appears' | 'report'>;

/** A card's fragment as the page asks for it: the review's links and asset sides, which every fragment shares, ride once with the page. */
export type ReviewFragmentRequest = Omit<FragmentRequest, 'links' | 'assets'>;

/**
 * One changed file's card on the Review in browser page, as the UI plans it
 * from the review: its hunks as the review read them, where each side's
 * text is (for colors across the file, and the context the page carries),
 * and for a markdown file, an image or an SVG the fragment its rich view
 * is rendered from, once the review has rendered it.
 */
export type ReviewCardRequest = {
  path: string;
  /** The file's stable page name, which links to it in other files' rich views name. */
  alias?: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  kind: ReviewPageCard['kind'];
  /** What the file is on each side apart from its hunks: the blob ids, a mode change and the old path. A file with no hunks changes here. */
  identity: string;
  blocks: Array<{rawDiff: string}>;
  sides: {before?: SourceSpec; after?: SourceSpec};
  /** Sent only once the review rendered the file: one that hasn't yet is drawn as on its way. */
  fragment?: ReviewFragmentRequest;
  /** Why the file's render failed, when it did: the card says so, and nothing renders it again. */
  renderFailure?: string;
  /** The rich view's links to a heading another file doesn't have, by their `ref` index, drawn broken. */
  brokenRefs?: readonly number[];
  /** In place of a diff, why there is none. */
  notice?: string;
  /** A file the review doesn't list whose text is the same, which shows the changed images named here. */
  also?: string[];
};

/**
 * The Review in browser page for the whole review. `refs` are the refs as
 * git resolves them, which the commits and the branch's state are read
 * with; `title` names them for people. `links` and `assets` are what each
 * card's fragment shares; `findings` is the link and asset report.
 */
export type ReviewRequest = {
  key: string;
  cwd: string;
  refs: {base: string; branch: string};
  title: ReviewPageInput['title'];
  reviewId: string;
  cards: ReviewCardRequest[];
  links: Record<string, LinkAnswer>;
  assets: AssetSides | null;
  findings: ReviewPageInput['findings'];
};

/** `partial`: something on the page wasn't ready (the commits, a card's colors or its rich view), so it is written again. */
export type ReviewResult = {ok: true; html: string; partial?: true} | WorkerFailure;

/** Markdown the review didn't change that may show one of its images (assets.embedders). */
export type EmbeddersRequest = {cwd: string; assets: AssetSides; names: string[]; skip: string[]};

export type EmbeddersResult = {ok: true; files: Array<{path: string; oid: string}>} | WorkerFailure;

// `rerendered`: the page rendered its fragment again rather than use the one
// held, so its summary can count differently from the fragment's answer.
export type PageResult = {ok: true; html: string; summary: FragmentSummary; rerendered?: true} | WorkerFailure;

/**
 * A page for the in-pane view: the fragment the tiles show, drawn in the
 * terminal's scheme and background at the pane's geometry, by the browser
 * the UI found.
 */
export type TileSource = {
  fragment: FragmentRequest;
  scheme: 'dark' | 'light';
  bg: string;
  /** The base ref's name, which a deleted file's banner shows. */
  base: string;
  geometry: PageGeometry;
  chrome: ChromeBinary;
  /** The page's links to a heading another page doesn't have, by their `ref` index, drawn broken. */
  brokenRefs?: readonly number[];
};

/**
 * How long the worker has for a layout and a tile, from when it is sent.
 * A cold Chromium start counts: the worker gives the browser what is left
 * of it, less a margin, so a browser that hangs fails as a browser failure
 * before the deadline kills the worker.
 */
export const BROWSER_JOB_DEADLINES_MS = {layout: 15_000, tile: 8_000} as const;

// A browser failure says whether it was the one that turned the in-pane
// view off for the session; a tile whose PNG came out too large asks to be
// cut in shorter tiles.
// A tile asked of a document the worker no longer holds is `stale`: the
// page is laid out again, and no browser was asked.
type TileFailure = WorkerFailure & {tilesOff?: true; tooLarge?: true; stale?: true};

export type LayoutRequest = {source: TileSource};
/**
 * `document`: the name of the tile document laid out, which changes with
 * anything it draws, an embedded image included. `text`: the markdown its
 * blocks came from, which `c` copies a block of, so a copy is what the page
 * shows however the file changed on disk since. `late`: an image or link
 * the page shows didn't answer in time, so laying it out again later can
 * draw more.
 */
export type LayoutResult = {ok: true; layout: PageLayout; document: string; text?: string; late?: true} | TileFailure;

/**
 * Tile `index` of a page `rows` rows tall, cut from `document`, the tile
 * document a layout answered, with each cell's mean color when `mosaic`.
 */
export type TileRequest = {source: TileSource; document: string; index: number; rows: number; mosaic: boolean};
export type TileResult = {ok: true; png: Uint8Array; mosaic?: Uint8Array} | TileFailure;

export interface RenderedBackend {
  // `priority`: lower runs first; the active file asks with 0.
  fragment(request: FragmentRequest, signal: AbortSignal, priority?: number): Promise<FragmentResult>;
  // Moves a fragment still waiting for the worker, asked for with `signal`, to `priority`.
  prioritize(signal: AbortSignal, priority: number): void;
  page(request: PageRequest, signal: AbortSignal): Promise<PageResult>;
  // The Review in browser page. A backend without it opens none.
  review?(request: ReviewRequest, signal: AbortSignal): Promise<ReviewResult>;
  // The review's markdown candidates for "also looks different". A backend
  // without it finds none.
  embedders?(request: EmbeddersRequest, signal: AbortSignal): Promise<EmbeddersResult>;
  // The in-pane view's jobs. A backend without them has no pane.
  // `priority`: as for fragments; the active file's page asks with 0.
  layout?(request: LayoutRequest, signal: AbortSignal, priority?: number): Promise<LayoutResult>;
  tile?(request: TileRequest, signal: AbortSignal, priority?: number): Promise<TileResult>;
  // Ends the worker at once (exit hook): synchronous.
  dispose(): void;
  // Why the rendered view is off for the session (the worker kept failing), or null.
  disabledReason(): string | null;
}

export type RenderedJobs = {
  fragment: {request: FragmentRequest; result: FragmentResult};
  page: {request: PageRequest; result: PageResult};
  review: {request: ReviewRequest; result: ReviewResult};
  embedders: {request: EmbeddersRequest; result: EmbeddersResult};
  layout: {request: LayoutRequest; result: LayoutResult};
  tile: {request: TileRequest; result: TileResult};
};

export type RenderedWorkerRequest = ({type: 'fragment'} & FragmentRequest) | ({type: 'page'} & PageRequest) | ({type: 'review'} & ReviewRequest) | ({type: 'embedders'} & EmbeddersRequest)
  | ({type: 'layout'} & LayoutRequest) | ({type: 'tile'} & TileRequest);
