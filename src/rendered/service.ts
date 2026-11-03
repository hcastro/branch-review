import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {escapeHiddenCharacters} from '../controlChars.js';
import {branchTipsOperation, fileKey, runOperationAsync, type DiffRange} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import type {Opener} from '../media/openExternal.js';
import {findTool} from '../media/worker/tools.js';
import type {ReviewFile, ReviewModel} from '../review/model.js';
import {reviewAssetSides, reviewPaths, type AssetSides} from './sides.js';
import {LEAVES_PANE} from './marks.js';
import type {FragmentRequest, FragmentSummary, RenderedBackend, ReviewCardRequest, ReviewRequest} from './backend.js';
import {changeGroups} from './changes.js';
import {failedMarkdownPage, renderableKind, type RenderableKind} from './classify.js';
import {formatReviewHash} from './hash.js';
import {fileAlias, pageKey, railSignature} from './keys.js';
import type {LinkAnswer} from './markdown.js';
import {resolveMotion, type Motion} from './motion.js';
import {linkReport, type ReportSource} from './report.js';
import {reviewCardRequest, type CardRender} from './review/request.js';
import {runTool} from './run.js';
import {createRenderedPane, type RenderedPane} from './pane.js';
import {createRenderedSite, type RenderedSite} from './site.js';
import {oneLine, sourceSpec} from './source.js';
import {createSurface, type ShowResult, type Surface} from './surface.js';
import {createRenderedBackend} from './workerClient.js';
import {findChrome, type ChromeBinary} from './worker/chrome.js';
import type {ImageRegistry} from '../media/imageRegistry.js';
import type {GraphicsCaps} from '../media/types.js';

// The UI side of the rendered view. It holds what names the pages and
// what their marks depend on (keys, counts, failures), never their HTML:
// the worker renders, this side writes the finished page into the session
// dir. When a review arrives it renders the review's markdown, images and
// SVG in the background, the active file first, then writes the Review in
// browser page for the whole branch, so the page is usually on disk before
// anyone asks for it. A review with nothing but code renders nothing until
// someone does. `r` and `R` come here to open that page on the surface,
// `r` at the active file's card and `R` at the top: this side decides
// whether the TUI plays its crossing, and what the footer says after. A
// press renders every file the page shows, waits a moment for them, and
// writes the page; a card still on its way says so, and the page is
// written again once it is in. In watch mode, a split that shows the page
// is sent the page an edit wrote.
//
// Markdown the review doesn't list whose text is the same, but which shows
// an image the review changed, also looks different: a bounded search
// finds candidates, their renders say which show a changed image, and
// those get cards of their own. The link and anchor report reads every
// render, and the page lists what won't resolve on GitHub.

// The first review waits for the UI to settle; a watch refresh waits for
// a burst of writes to end.
const FIRST_DELAY_MS = 2_000;
const SETTLE_MS = 250;
const MAX_PRERENDER = 40;
// Files this close to the active one in the review's order render next.
const NEIGHBORS = 3;
/**
 * How long `r` waits for a page that isn't written yet: the whole branch,
 * which for a large one starts a worker, reads every file and colors it,
 * within the worker's build budget.
 */
export const OPEN_DEADLINE_MS = 10_000;
// How long a press gives the files it renders before the page is written
// with what is in: the rest say they are on their way. The refs are read
// beside that wait, so a press's page is asked for by the end of it. The
// page job never waits for a worker turn behind fragments (it has one of
// its own, workerClient.ts), and the worker's build, which gives git at
// most its own budget, ends inside the deadline.
export const PRESS_WAIT_MS = 2_500;
// How long the commits' and the branch state's refs may take to read.
export const TIPS_BUDGET_MS = 2_000;
// A page written partial is written again this long after, at most this
// many times for one review.
const FOLLOW_UP_MS = 1_000;
const MAX_FOLLOW_UPS = 3;
// The fewest ms between two live refreshes of the split.
const LIVE_GAP_MS = 1_000;
const NOTHING_TO_OPEN = 'nothing to open in the browser · no files changed on this branch';

/** The Review in browser page's stable name for the session. No file key holds a NUL, so no file shares it. */
export const REVIEW_ALIAS = fileAlias('\0review');

export {LEAVES_PANE} from './marks.js';

/** `partial`: something on the page wasn't ready, and it will be written again. */
export type PageOutcome = {ok: true; key: string; url: string; partial?: true} | {ok: false; reason: string};

// A page written, or why not, with the file keys of its cards in order: a
// card's place on that page, which its URL's hash names. Its URL is asked
// for only to show it: the site counts a page whose URL it gave as shown,
// and keeps it a while.
type Written = {ok: true; key: string; files: readonly string[]; partial?: true} | {ok: false; reason: string};

/** What the footer says after `r` or `R`. */
export type OpenOutcome = {message: string; kind: 'info' | 'error'};

/**
 * The TUI's part in a trip: `cross` plays the crossing for `motion` and
 * settles when it ends; `waiting` says the page is still being made.
 */
export type Trip = {cross: (motion: Motion) => Promise<void>; waiting: (message: string) => void};

export type PageSurface = Pick<Surface, 'kind' | 'refusal' | 'destination' | 'show'> & Partial<Pick<Surface, 'dispose' | 'refresh' | 'opensSplit' | 'refusalFor'>>;

export type SetTimer = (run: () => void, ms: number) => () => void;

/** The refs the commits and the branch's state are read from, as one line, or null when git didn't say. */
export type ReadTips = (cwd: string, refs: {base: string; branch: string}) => Promise<string | null>;

const defaultTimer: SetTimer = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** The tips from git, within their budget: TIPS_BUDGET_MS, longer only in a test on a loaded machine. */
export const readTips = async (cwd: string, refs: {base: string; branch: string}, budgetMs = TIPS_BUDGET_MS): Promise<string | null> => {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), budgetMs);
  timer.unref();
  try {
    return await runOperationAsync(branchTipsOperation(cwd, refs.base, refs.branch), {signal: stop.signal});
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// One file the review renders, with everything its fragment depends on.
type Planned = {
  file: ReviewFile;
  fileKey: string;
  alias: string;
  order: number;
  kind: RenderableKind;
  // Null when the review entry itself failed: its rich view is that card.
  request: Omit<FragmentRequest, 'assets'> | null;
  // The review's asset sides, shared by its files and read from its
  // patches the first time a fragment is sent, not while the UI renders.
  sides: () => AssetSides;
  failure?: string;
  // Markdown the review doesn't list, which may show an image it changed.
  also?: true;
};

type Answer = {summary: FragmentSummary} | {failed: string};

type Asking = {epoch: number; fileKey: string; priority: number; controller: AbortController; done: Promise<Answer | null>};

// The page the split shows, as a press or a refresh cmux confirmed put it
// there: its key, and the file key of the card the press opened it at,
// found again on each newer page, where a file added or gone may have
// moved it. Null when the split shows something else. `seq` orders what
// set it.
type InSplit = {key: string; file?: string; seq: number};

export function createRenderedService({backend, site, surface, motion, animations = true, now = Date.now, setTimer = defaultTimer, pane: paneOptions, live = false, tips, openDeadlineMs = OPEN_DEADLINE_MS}: {
  backend: RenderedBackend;
  site: RenderedSite;
  /** Where pages open. Without one, the service only renders. */
  surface?: PageSurface;
  /** How much the TUI moves, asked once, at the first trip. */
  motion?: () => Promise<Motion>;
  /** False with `--no-animations`: pages arrive with no motion at all. */
  animations?: boolean;
  now?: () => number;
  setTimer?: SetTimer;
  /** The in-pane view, in a terminal that draws Kitty images: the image registry it shares with media, and how to find Chromium. */
  pane?: {registry: ImageRegistry; caps: GraphicsCaps; env: NodeJS.ProcessEnv; chrome: () => ChromeBinary | null};
  /** Watch mode: the split follows edits to the page it shows. Off, it changes only on a press. */
  live?: boolean;
  /**
   * The refs the page's commits and branch state are read from, read on
   * every write: a push or an amend makes a new page. Without it, a page
   * changes only with the review.
   */
  tips?: ReadTips;
  /** How long `r` waits for its page: OPEN_DEADLINE_MS, longer only in a test on a loaded machine. */
  openDeadlineMs?: number;
}) {
  let plan = new Map<string, Planned>();
  // Markdown outside the review that shows an image the review changed, by
  // file key, once the search for this review found it; and that search.
  let also = new Map<string, Planned>();
  let alsoSearch: {cwd: string; links: Record<string, LinkAnswer>; linkSignature: string; sides: () => AssetSides; done: Promise<void> | null} | null = null;
  // The review as it is now, which the page is made from.
  let shown: {review: ReviewModel; cwd: string; range: DiffRange; title: ReviewRequest['title']; reviewId: string; links: Record<string, LinkAnswer>; sides: () => AssetSides} | null = null;
  let epoch = 0;
  // Counts the changes to `answers`, for what is read from all of them.
  let answersChanged = 0;
  let started = false;
  let cancelTimer: (() => void) | null = null;
  let focused: string | null = null;
  let disposed = false;
  // By fragment key: the newest answer, the review it was asked for, and
  // the images it names as that review had them (embedsOf).
  const answers = new Map<string, {epoch: number; answer: Answer; embeds: string}>();
  // The review's files by every path they go by, for what an answer's
  // images were when it was asked: a fragment's key covers the file's own
  // text, not the images it embeds.
  let reviewed = new Map<string, ReviewFile>();
  const asking = new Map<string, Asking>();
  const notices: string[] = [];
  let saidOff = false;
  const listeners = new Set<() => void>();
  let version = 0;
  // The page's writes on their way, by key, and the newest two written:
  // the one before stays a while for a split that still shows it.
  // `press`: a write in a press's turn. `signal` names its job to the
  // backend. `askedAt`: the newest review that asked for it, which a
  // caller joining it for the same page raises.
  type Writing = {done: Promise<Written>; press: boolean; signal: AbortSignal; askedAt: number};
  const writing = new Map<string, Writing>();
  let latest: {key: string; epoch: number; files: readonly string[]} | null = null;
  let previous: string | null = null;
  // Pages written while something they show wasn't ready, which are never
  // shown again: the next write of the same page goes under the next name
  // (`attempts`, by the page's own key).
  const partial = new Set<string>();
  const attempts = new Map<string, number>();
  // Each page's own key, before attempts: a page written again under the
  // next name shows the same review and refs.
  const bases = new Map<string, string>();
  // Each page's HTML, by a digest, as it was written: a page written under
  // a new name with the same bytes (the refs read in time once and not the
  // next) moves no split.
  const digests = new Map<string, string>();
  let followUps = {epoch: -1, count: 0};
  let cancelFollowUp: (() => void) | null = null;
  // The review a press asked for every file of, which passes then render
  // past the prerender limit.
  let wideAt = -1;
  // The files the newest pass left out by the prerender limit, by file key.
  let capped = new Set<string>();
  let motionAsked: Promise<Motion> | null = null;
  // Counts `r` and `R` presses: only the newest one's page is shown.
  let presses = 0;
  // Counts the URLs sent to the surface, so each one differs and a split
  // showing the page already still hears it.
  let trips = 0;
  // The tips read on their way, shared by every write that asks meanwhile.
  let tipsRead: Promise<string | null> | null = null;

  let inSplit: InSplit | null = null;
  let splitSeq = 0;
  let seqs = 0;
  // The refreshes sent and not answered yet: the split may show any of
  // them by the time the next one asks cmux what it shows.
  const sending = new Set<InSplit>();
  const setSplit = (next: InSplit | null) => {
    inSplit = next;
    splitSeq = next?.seq ?? (seqs += 1);
  };
  let lastLive = -Infinity;
  let cancelLive: (() => void) | null = null;
  // Presses whose page is still on its way to the surface. A live refresh
  // waits for them: the press decides what the split shows, and a refresh
  // still due after it goes then.
  let traveling = 0;
  let liveAfterPress = false;

  const say = (notice: string) => {
    notices.push(notice);
    version += 1;
    for (const listener of listeners) listener();
  };

  // Reasons reach the footer and the page as one line with the home dir as
  // `~`. A worker that crashed is described by its stderr, which can name
  // any path on the machine.
  const offReason = () => {
    const disabled = backend.disabledReason();
    const reason = disabled ? oneLine(disabled) : null;
    if (reason && !saidOff) {
      saidOff = true;
      say(`✗ ${reason}`);
    }
    return reason;
  };

  // A fragment already on its way is moved up when someone needs it sooner.
  const raise = (running: Asking, priority: number) => {
    if (priority >= running.priority) return;
    running.priority = priority;
    backend.prioritize(running.controller.signal, priority);
  };

  const fragmentRequest = (planned: Planned): FragmentRequest => ({...planned.request!, assets: planned.sides()});

  const ask = (planned: Planned, priority: number): Promise<Answer | null> => {
    const request = planned.request!;
    const running = asking.get(request.key);
    if (running && running.epoch === epoch) {
      raise(running, priority);
      return running.done;
    }
    const askedAt = epoch;
    const filesAt = reviewed;
    const controller = new AbortController();
    const send = () => backend.fragment(fragmentRequest(planned), controller.signal, priority);
    // A render whose image lookups ran out of time (a cold git) marks less
    // than it will once they answer, so it is asked once more before the
    // page counts on it.
    const done = send().then((result) => (result.ok && result.summary.late ? send() : result)).then((result): Answer => {
      if (result.ok) return {summary: result.summary};
      // The failure that used up the worker's last strike says so.
      offReason();
      return {failed: oneLine(result.reason)};
    }).then((answer) => {
      const known = answers.get(request.key);
      if (!known || known.epoch <= askedAt) {
        answers.set(request.key, {epoch: askedAt, answer, embeds: imagesAt(answer, filesAt)});
        answersChanged += 1;
      }
      // The link report grew, and a page in the pane may draw a link broken now.
      pane?.sourcesChanged();
      return answer;
    }, () => null).finally(() => {
      if (asking.get(request.key)?.controller === controller) asking.delete(request.key);
    });
    asking.set(request.key, {epoch: askedAt, fileKey: planned.fileKey, priority, controller, done});
    return done;
  };

  // The images an answer names, each with what the review said of it:
  // its status, where it moved from and the blobs its patch names (its
  // whole diff when it names none), or nothing for an image the review
  // doesn't list. An image whose side changed changes this,
  // though the answer's own key stays the same.
  const fileIds = new WeakMap<ReviewFile, string>();
  const imagesAt = (answer: Answer, files: ReadonlyMap<string, ReviewFile>) => {
    if (!('summary' in answer)) return '';
    const named = [...new Set((answer.summary.images ?? []).map((image) => image.path))].sort();
    return JSON.stringify(named.map((imagePath) => {
      const file = files.get(imagePath);
      if (!file) return [imagePath, null];
      let id = fileIds.get(file);
      if (id === undefined) {
        id = createHash('sha256').update(JSON.stringify([file.status, file.oldPath ?? null, patchObjectIds(file.rawDiff) ?? file.rawDiff])).digest('hex').slice(0, 20);
        fileIds.set(file, id);
      }
      return [imagePath, id];
    }));
  };

  // Whether an answer names an image whose side changed since it was asked.
  const embedsMoved = (key: string) => {
    const known = answers.get(key);
    return known !== undefined && known.embeds !== imagesAt(known.answer, reviewed);
  };

  // Active file 0, its neighbors 1, the rest 2.
  const priorityOf = (planned: Planned) => {
    const active = focused === null ? undefined : plan.get(focused);
    if (!active) return 2;
    const distance = Math.abs(active.order - planned.order);
    return distance === 0 ? 0 : distance <= NEIGHBORS ? 1 : 2;
  };

  const answerFor = (planned: Planned) => (planned.request ? answers.get(planned.request.key)?.answer : undefined);

  // A file whose render failed isn't sent again by later passes while it
  // is unchanged: a file that keeps timing out would cost the worker a
  // strike on every refresh and turn the whole view off.
  const failedBefore = (planned: Planned) => {
    const answer = answerFor(planned);
    return answer !== undefined && 'failed' in answer;
  };

  const summaryOf = (planned: Planned) => {
    const answer = answerFor(planned);
    return answer && 'summary' in answer ? answer.summary : undefined;
  };

  // The pages outside the review that show an image it changed: those whose
  // render marked a block, which only a changed image can, their text being
  // the same on both sides.
  const alsoShown = () => [...also.values()].filter((planned) => {
    const summary = summaryOf(planned);
    return summary?.kind === 'rendered' && summary.changes.changed > 0;
  });

  // The review's images by every path they go by: markdown outside the
  // review may still name a moved image where it was.
  const changedImages = () => reviewPaths([...plan.values()].filter((each) => each.kind !== 'markdown').map((each) => each.file));

  // The changed images a page outside the review shows.
  const embedsOf = (planned: Planned) => {
    const changed = changedImages();
    return [...new Set((summaryOf(planned)?.images ?? []).map((image) => image.path).filter((image) => changed.has(image)))];
  };

  // The link and anchor report over the review's markdown as rendered so
  // far: a file not rendered yet adds nothing, and its anchors are no one's
  // finding. Asked for on every page write and tile layout: read again only
  // when the review or an answer changed since.
  let reported: {at: string; value: ReturnType<typeof linkReport>} | null = null;
  function report() {
    const at = `${epoch}:${answersChanged}`;
    if (reported?.at === at) return reported.value;
    // A file that only looks different isn't checked: its links are as they were.
    const sources: ReportSource[] = [...plan.values()].flatMap((planned) => {
      const summary = summaryOf(planned);
      if (planned.kind !== 'markdown' || summary?.kind !== 'rendered') return [];
      return [{path: planned.file.path, status: planned.file.status, links: summary.links, images: summary.images ?? [], anchors: summary.anchors ?? []}];
    });
    reported = {at, value: linkReport(sources)};
    return reported.value;
  }

  // The page for the review as it is now: every changed file's card, a
  // rendered file's with the fragment its rich view or image comes from,
  // once the review rendered it, then the files that also look different.
  // Its name hashes what it is drawn from: each card with its fragment's
  // key (which names the fragment's content and the links it draws), what
  // each fragment embeds as its answers name it, the report, and the refs
  // the commits are read from, so a review that changed nothing a card
  // shows keeps its page, and a changed image, a push or an amend writes
  // a new one.
  function reviewRequest(tipsNow: string | null): ReviewRequest | null {
    if (!shown) return null;
    const {review, cwd, range, title, reviewId, links} = shown;
    const {broken, findings} = report();
    const renderOf = (planned: Planned): CardRender => {
      // A render that failed isn't sent again with the page: the card says
      // why, until the file changes. One not back yet is on its way.
      const answer = answerFor(planned);
      const failure = planned.failure ?? (answer && 'failed' in answer ? answer.failed : undefined);
      let fragment: CardRender['fragment'] = null;
      if (planned.request && failure === undefined && summaryOf(planned)) {
        const {links: _links, ...own} = planned.request;
        fragment = own;
      }
      return {
        kind: planned.kind,
        fragment,
        ...(failure !== undefined ? {failure} : {}),
        ...(fragment === null && failure === undefined && capped.has(planned.fileKey) ? {deferred: true as const} : {}),
        ...(broken.has(planned.file.path) ? {brokenRefs: broken.get(planned.file.path)!} : {}),
      };
    };
    const cards: ReviewCardRequest[] = review.files.map((file) => {
      const planned = plan.get(fileKey({path: file.path, nameError: file.pathError}));
      return {...reviewCardRequest(file, range, planned ? renderOf(planned) : null), alias: fileAlias(fileKey({path: file.path, nameError: file.pathError}))};
    });
    for (const planned of alsoShown()) cards.push({...reviewCardRequest(planned.file, range, renderOf(planned)), also: embedsOf(planned)});
    const embedded = [...plan.values(), ...alsoShown()].map((planned) => summaryOf(planned)?.assets ?? '');
    const named = cards.map(({fragment, ...card}) => ({...card, fragment: fragment?.key ?? null}));
    const key = createHash('sha256').update(JSON.stringify([cwd, range, title, reviewId, named, embedded, findings, tipsNow])).digest('hex').slice(0, 20);
    const anyFragment = cards.some((card) => card.fragment);
    return {key, cwd, refs: {base: range.base, branch: range.branch}, title, reviewId, cards, links, assets: anyFragment ? shown.sides() : null, findings};
  }

  const keyAt = (base: string, attempt: number) => (attempt === 0 ? base : createHash('sha256').update(`${base}\0${attempt}`).digest('hex').slice(0, 20));

  // Within their budget here too, so a press never waits past it.
  const readTipsNow = () => {
    if (!shown || !tips) return Promise.resolve(null);
    const {cwd, range} = shown;
    if (!tipsRead) {
      const read = tips;
      const reading = new Promise<string | null>((resolve) => {
        const stop = setTimer(() => resolve(null), TIPS_BUDGET_MS);
        void read(cwd, {base: range.base, branch: range.branch}).catch(() => null).then((value) => {
          stop();
          resolve(value);
        });
      });
      tipsRead = reading;
      void reading.then(() => {
        if (tipsRead === reading) tipsRead = null;
      });
    }
    return tipsRead;
  };

  // The newest page and the one before stay, and so do pages shown in the
  // last two minutes or on their way to the split: the rest go, after every
  // write, so a session of edits keeps a few pages on disk, not one each.
  const prune = () => {
    if (!latest) return;
    site.prune({current: new Map([[REVIEW_ALIAS, latest.key]]), previous: new Set(previous ? [previous] : []), sending: new Set([...sending].map((each) => each.key))});
    // A page's own key is asked for only while the split may show it or it
    // is on its way.
    const kept = new Set([latest.key, previous, inSplit?.key, ...[...sending].map((each) => each.key), ...writing.keys()]);
    for (const key of bases.keys()) if (!kept.has(key)) bases.delete(key);
    for (const key of digests.keys()) if (!kept.has(key)) digests.delete(key);
  };

  // A page written partial is written again a moment later by a pass that
  // renders what it waited for, a few times at most for one review.
  const followUp = () => {
    if (followUps.epoch !== epoch) followUps = {epoch, count: 0};
    if (followUps.count >= MAX_FOLLOW_UPS || cancelFollowUp || disposed) return;
    followUps.count += 1;
    const pass = epoch;
    cancelFollowUp = setTimer(() => {
      cancelFollowUp = null;
      if (pass === epoch) void renderPass(pass);
    }, FOLLOW_UP_MS);
  };

  // Writes the review's page unless it is on disk already, and names it
  // the newest. Showing it is the caller's business. `tipsAt`: the refs a
  // press began reading as it was made. `press`: a press waits for it, and
  // its job has a worker turn of its own, so it never queues behind a page
  // a pass is writing in the background.
  async function writeReview(tipsAt?: Promise<string | null>, press = false): Promise<Written> {
    const off = offReason();
    if (off) return {ok: false, reason: off};
    if (!backend.review) return {ok: false, reason: 'pages open only in the full app'};
    if (!shown) return {ok: false, reason: NOTHING_TO_OPEN};
    const tipsNow = await (tipsAt ?? readTipsNow());
    const request = reviewRequest(tipsNow);
    if (!request || !shown) return {ok: false, reason: NOTHING_TO_OPEN};
    const files = shown.review.files.map((file) => fileKey({path: file.path, nameError: file.pathError}));
    const base = request.key;
    let attempt = attempts.get(base) ?? 0;
    if (partial.has(keyAt(base, attempt)) && !writing.has(keyAt(base, attempt))) attempts.set(base, (attempt += 1));
    const key = keyAt(base, attempt);
    bases.set(key, base);
    // A page an older review asked for that lands after a newer one's is
    // still shown to whoever asked, but the newer stays the newest.
    const done = (askedAt: number): Written => {
      if (latest?.key !== key && (latest?.epoch ?? -1) <= askedAt) {
        previous = latest?.key ?? null;
        latest = {key, epoch: askedAt, files};
        site.alias(REVIEW_ALIAS, key);
      }
      prune();
      return {ok: true, key, files, ...(partial.has(key) ? {partial: true as const} : {})};
    };
    if (site.has(key) && !partial.has(key)) {
      try {
        return done(epoch);
      } catch (error) {
        return {ok: false, reason: oneLine(error)};
      }
    }
    let pending = writing.get(key);
    // A press joins the same page on its way in the background. While that
    // job still waits for a worker turn, maybe behind another page, it
    // moves into the press's own; once the worker is building it, it is
    // the soonest way to the page, and a second build beside it would only
    // slow both.
    if (pending && press && !pending.press && backend.promote?.(pending.signal)) pending.press = true;
    // A newer review with the same page that joins it, as a rebuild for a
    // new width does, makes it that review's page: the newest, and written
    // again a moment later if it comes back partial.
    if (pending) pending.askedAt = Math.max(pending.askedAt, epoch);
    if (!pending) {
      const signal = new AbortController().signal;
      const entry = {press, signal, askedAt: epoch} as Writing;
      entry.done = backend.review({...request, key}, signal, press).then<Written, Written>((result) => {
        if (!result.ok) {
          offReason();
          return {ok: false, reason: oneLine(result.reason)};
        }
        try {
          site.write(key, result.html);
          digests.set(key, createHash('sha256').update(result.html).digest('hex'));
          if (result.partial) partial.add(key);
          const written = done(entry.askedAt);
          if (result.partial && entry.askedAt === epoch) followUp();
          return written;
        } catch (error) {
          return {ok: false, reason: oneLine(error)};
        }
      }, (error: unknown) => ({ok: false, reason: oneLine(error)})).finally(() => {
        if (writing.get(key) === entry) writing.delete(key);
      });
      writing.set(key, entry);
      pending = entry;
    }
    return pending.done;
  }

  // Renders the review's markdown, images and SVG, nearest the active file
  // first, then writes the page: a card's rich view draws its links broken
  // by what every file's render says. A file this review already has an
  // answer for isn't asked again. Past the prerender limit only once a
  // press asked for the whole page.
  function prerender() {
    started = true;
    cancelTimer = null;
    return renderPass(epoch);
  }

  // The page the pass wrote, or null when it stopped short of writing one.
  // `pressed`: whether the press that started the pass still waits for
  // its page, which then has a worker turn of its own.
  async function renderPass(pass: number, pressed: () => boolean = () => false): Promise<Written | null> {
    // Every file once a press asked for the whole page. Before any press,
    // and in the browser, the limit. While a live split shows a page of
    // this review, past the limit only a file with no answer for what it
    // is now, or whose answer names an image that changed since: an edit
    // to a far file, or to an image it shows, renders it, and the other far
    // files an earlier pass rendered keep that answer rather than each
    // being asked again on every pass.
    const wide = wideAt === pass;
    const sorted = [...plan.values()].sort((left, right) => priorityOf(left) - priorityOf(right) || left.order - right.order);
    const chosen = sorted.slice(0, wide ? Infinity : MAX_PRERENDER);
    const far = wide || !live || inSplit === null ? [] : sorted.slice(chosen.length).filter((each) => each.request && (!answers.has(each.request.key) || embedsMoved(each.request.key)));
    const asked = new Set([...chosen, ...far]);
    capped = new Set(sorted.filter((each) => !asked.has(each)).map((each) => each.fileKey));
    const unanswered = (each: Planned) => each.request && !failedBefore(each) && answers.get(each.request.key)?.epoch !== pass;
    await Promise.all([...asked].filter(unanswered).map((planned) => ask(planned, priorityOf(planned))));
    if (disposed || pass !== epoch || offReason()) return null;
    // Then the markdown outside the review that may show its images.
    await searchAlso(MAX_PRERENDER - Math.min(plan.size, MAX_PRERENDER));
    if (disposed || pass !== epoch) return null;
    await Promise.all([...also.values()].filter(unanswered).map((planned) => ask(planned, 2)));
    if (disposed || pass !== epoch || offReason()) return null;
    const written = await writeReview(undefined, pressed());
    if (disposed || pass !== epoch) return null;
    if (written.ok) refreshSplit();
    return written;
  }

  // The search for markdown outside the review that shows one of its images,
  // once per review, and only for a review with images. Each file found is
  // planned for a render, which says whether it shows a changed one, up to
  // `room`: what the prerender budget has left after the review's own files.
  function searchAlso(room: number): Promise<void> {
    const search = alsoSearch;
    if (!search || !backend.embedders || room <= 0) return Promise.resolve();
    search.done ??= (async () => {
      const files = [...plan.values()];
      const names = [...new Set([...changedImages()].map((imagePath) => path.posix.basename(imagePath)))];
      const found = await backend.embedders!({cwd: search.cwd, assets: search.sides(), names, skip: [...reviewPaths(files.map((each) => each.file))]}, new AbortController().signal);
      if (!found.ok || alsoSearch !== search) return;
      for (const [index, {path: repoPath, oid}] of found.files.slice(0, room).entries()) {
        const key = fileKey({path: repoPath});
        const file = {path: repoPath, status: 'modified', metrics: {path: repoPath, additions: 0, deletions: 0, changedLines: 0}, rawDiff: '', renderedLines: [], blocks: []} as ReviewFile;
        also.set(key, {
          file,
          fileKey: key,
          alias: fileAlias(key),
          order: files.length + index,
          kind: 'markdown',
          also: true,
          request: {
            cwd: search.cwd,
            textUnchanged: true,
            key: pageKey({path: repoPath, status: 'modified', after: oid, groups: [], rail: `${search.linkSignature}\0also`}),
            path: repoPath,
            status: 'modified',
            source: {kind: 'blob', id: oid},
            groups: [],
            links: search.links,
          },
          sides: search.sides,
        });
      }
    })();
    return search.done;
  }

  const schedule = () => {
    // The first review's wait runs out once; a later review only settles.
    if (!started && cancelTimer) return;
    cancelTimer?.();
    cancelTimer = setTimer(() => void prerender(), started ? SETTLE_MS : FIRST_DELAY_MS);
  };

  // The page for a press: every file it shows rendered, the active one
  // first, for as long as the press can wait, then written with what is in,
  // under the refs read meanwhile.
  async function pressPage(): Promise<Written> {
    const tipsAt = readTipsNow();
    wideAt = epoch;
    if (!started || cancelTimer) {
      cancelTimer?.();
      started = true;
      cancelTimer = null;
    }
    let waiting = true;
    const pass = renderPass(epoch, () => waiting);
    let stop = () => {};
    const passed = await Promise.race([pass, new Promise<null>((resolve) => {
      stop = setTimer(() => resolve(null), PRESS_WAIT_MS);
    })]);
    stop();
    waiting = false;
    // A pass done in time wrote the page itself.
    return passed ?? writeReview(tipsAt, true);
  }

  // The split shows the page, and a pass wrote a newer one: it goes to the
  // new page at the card the press opened it at, which lands where the
  // reader was. At most once a second; a refresh inside the second waits,
  // and the newest page goes then. The split goes only while it still
  // shows a page the last press or refresh sent it, by that page's name or
  // the stable one: the reader may have moved on inside it, and the next
  // change tries again. A page with the same bytes as the one the split
  // shows moves no split, nor does a page written again for what it left
  // out (the same review and refs): a reload would undo what the
  // reader did on it, and their next press gets the whole page. A split
  // that is gone ends live refreshes until the next press opens one.
  function refreshSplit() {
    const confirmed = inSplit;
    if (!live || !confirmed || !surface?.refresh || disposed || cancelLive) return;
    if (traveling > 0) {
      liveAfterPress = true;
      return;
    }
    // Sent since the split was last confirmed: what it may show by now.
    const sent = [...sending].filter((each) => each.seq > splitSeq);
    const newest = sent.at(-1) ?? confirmed;
    const key = latest?.key;
    if (!key || key === newest.key || bases.get(key) === bases.get(newest.key)) return;
    const digest = digests.get(key);
    if (digest !== undefined && digest === digests.get(newest.key)) return;
    const wait = lastLive + LIVE_GAP_MS - now();
    if (wait > 0) {
      cancelLive = setTimer(() => {
        cancelLive = null;
        refreshSplit();
      }, wait);
      return;
    }
    lastLive = now();
    const next: InSplit = {key, ...(confirmed.file !== undefined ? {file: confirmed.file} : {}), seq: (seqs += 1)};
    const at = confirmed.file === undefined ? -1 : latest!.files.indexOf(confirmed.file);
    const url = () => site.url(key, formatReviewHash({...(at >= 0 ? {file: at} : {}), m: animations, n: (trips += 1), l: true}));
    sending.add(next);
    // The split may show the page confirmed or any refresh still on its
    // way: one queued behind a slow goto finds the page that goto sent.
    const showing = [...new Set([confirmed, ...sent].map((each) => `${each.key}.html`)), `${REVIEW_ALIAS}.html`];
    void surface.refresh(url, showing).then((went) => {
      sending.delete(next);
      // A press, or a newer refresh cmux confirmed, came after this one.
      if (next.seq <= splitSeq) return;
      if (went === true) setSplit(next);
      else if (went === false) setSplit(null);
    });
  }

  // One trip to the page: the TUI's crossing, played while the page is
  // written and placed on the surface, so the crossing covers the split
  // opening. A new split narrows the TUI as it opens, which would cut the
  // launch's specks off, so a press that opens one places the page once
  // the crossing lands, as the specks reach the button, and the diff draws
  // back in at the new width; one that goes to an open split places it
  // while it plays.
  // `name` is how the footer names what opened. Nothing crosses toward a
  // surface that refuses. A page still unwritten after the crossing is
  // said to be on its way, until the deadline gives up on it, and then it
  // opens nowhere. A press made after this one wins: this one's page is
  // never shown over it. `pressedOn`: the file the reader was on, which a
  // refusal may point `v` to; null for `R`. `file`: the file key of the
  // card it opens at, which the hash names by its place on the page the
  // press writes.
  async function travel(pressedOn: string | null, name: string, file: string | undefined, trip?: Trip): Promise<OpenOutcome | null> {
    const place = surface;
    if (!place) return {kind: 'error', message: 'pages open only in the full app'};
    const refusal = place.refusalFor ? place.refusalFor(pressedOn) : place.refusal;
    if (refusal) return {kind: 'error', message: refusal};
    const press = (presses += 1);
    const tripNumber = (trips += 1);
    traveling += 1;
    motionAsked ??= motion ? motion() : Promise.resolve('off');
    const crossing = motionAsked.then((kind) => trip?.cross(kind));
    let ready = false;
    let gaveUp = false;
    let cancelDeadline = () => {};
    const late = new Promise<'late'>((resolve) => {
      cancelDeadline = setTimer(() => {
        gaveUp = true;
        resolve('late');
      }, openDeadlineMs);
    });
    const shownOn = pressPage().then<ShowResult | {error: string} | null>((written) => {
      ready = true;
      cancelDeadline();
      // After dispose the session dir is going: nothing is placed.
      if (gaveUp || disposed || press !== presses) return null;
      if (!written.ok) return {error: written.reason};
      const at = file === undefined ? -1 : written.files.indexOf(file);
      const hash = formatReviewHash({...(at >= 0 ? {file: at} : {}), m: animations, n: tripNumber});
      const show = () => (gaveUp || disposed || press !== presses ? null : place.show(`${site.url(written.key)}#${hash}`).then((result) => {
        if ('where' in result) setSplit(result.where === 'browser' ? null : {key: written.key, ...(file === undefined ? {} : {file}), seq: (seqs += 1)});
        return result;
      }));
      return place.opensSplit?.() ? crossing.then(show) : show();
    });
    void shownOn.catch(() => null).then(() => {
      traveling -= 1;
      if (traveling > 0 || !liveAfterPress) return;
      liveAfterPress = false;
      refreshSplit();
    });
    await crossing;
    if (!ready && press === presses) trip?.waiting(`preparing ${name}…`);
    const outcome = await Promise.race([shownOn, late]);
    // A newer press's toast is on screen by now, and its page is the one shown.
    if (outcome === 'late') return press === presses ? {kind: 'error', message: `${name} took too long to prepare`} : null;
    if (outcome === null || 'superseded' in outcome) return null;
    if ('error' in outcome) return {kind: 'error', message: outcome.error};
    if ('refused' in outcome) return {kind: 'error', message: outcome.refused};
    return {kind: 'info', message: `${LEAVES_PANE} ${name} ${outcome.message}`};
  }

  // Whether `r` and `R` open anything here: not over SSH, nor with no
  // browser opener. Preview's toasts point to `r` only when it does.
  const opens = () => surface !== undefined && surface.kind !== 'none';

  // The page the pane draws for a review file: its markdown fragment, with
  // the links its rich view draws broken.
  const pane: RenderedPane | null = paneOptions ? createRenderedPane({
    backend,
    ...paneOptions,
    browserOpens: opens(),
    source: (fileKey) => {
      const planned = plan.get(fileKey);
      if (planned?.kind !== 'markdown' || !planned.request || !shown) return null;
      const brokenRefs = report().broken.get(planned.file.path) ?? [];
      return {fragment: fragmentRequest(planned), base: shown.title.base, ...(brokenRefs.length > 0 ? {brokenRefs} : {})};
    },
    // A link in a page in the pane names a file by its stable page name.
    fileForAlias: (alias) => [...plan.values()].find((planned) => planned.alias === alias)?.fileKey ?? null,
  }) : null;

  return {
    /** The in-pane view, when the terminal can draw it. */
    pane,

    /**
     * Takes a new review: plans its rendered files and drops work for
     * files that left it. Called while rendering, so it only starts work.
     */
    setReview(review: ReviewModel, {cwd, range}: {cwd: string; range: DiffRange}) {
      if (disposed) return;
      epoch += 1;
      const title = {repo: path.basename(cwd), base: range.base, branch: review.branch, worktree: range.includeWorktree};
      // Names this review's viewed marks in the browser: the repo and its
      // refs, hashed, so no path or ref name rides in the page.
      const reviewId = createHash('sha256').update(JSON.stringify([cwd, range.base, review.branch])).digest('hex').slice(0, 16);
      const files = review.files.flatMap((file): Array<{file: ReviewFile; kind: RenderableKind; failure?: string}> => {
        const kind = renderableKind(file, range);
        if (kind) return [{file, kind}];
        const failed = failedMarkdownPage(file, range);
        return failed === null ? [] : [{file, kind: 'markdown', ...('reason' in failed ? {failure: failed.reason} : {})}];
      });
      const linkSignature = railSignature(files.map(({file}) => file));
      // A link to another rendered file names its stable page name, which
      // the page script takes to the file's card and the pane to its page.
      // A deleted file has a card, but the link is broken on GitHub.
      const links: Record<string, LinkAnswer> = Object.fromEntries(files.map(({file}): [string, LinkAnswer] => [
        file.path,
        file.status === 'deleted' ? {kind: 'missing'} : {kind: 'inReview', href: `${fileAlias(fileKey({path: file.path, nameError: file.pathError}))}.html`},
      ]));
      const reviewEpoch = epoch;
      let assets: AssetSides | null = null;
      const sides = () => (assets ??= reviewAssetSides(review, range, reviewEpoch));
      shown = {review, cwd, range, title, reviewId, links, sides};
      reviewed = new Map(review.files.flatMap((file) => [...reviewPaths([file])].map((each): [string, ReviewFile] => [each, file])));

      const next = new Map<string, Planned>();
      for (const [order, {file, kind, failure}] of files.entries()) {
        const key = fileKey({path: file.path, nameError: file.pathError});
        const ids = patchObjectIds(file.rawDiff) ?? {};
        // An image's page marks no blocks: its sides are the change.
        const groups = kind === 'markdown' ? changeGroups(file) : [];
        const moved = file.oldPath ? {oldPath: file.oldPath} : {};
        const request: Planned['request'] = failure !== undefined ? null : {
          cwd,
          ...(kind === 'markdown' ? {} : {kind}),
          key: pageKey({path: file.path, ...moved, status: file.status, ...ids, groups, rail: linkSignature}),
          path: file.path,
          ...moved,
          status: file.status,
          source: kind === 'markdown' ? sourceSpec(file, range, ids) : {kind: 'none', reason: 'an image page reads its sides as images'},
          groups,
          links,
        };
        next.set(key, {file, fileKey: key, alias: fileAlias(key), order, kind, request, sides, ...(failure !== undefined ? {failure} : {})});
      }
      plan = next;
      capped = new Set();
      also = new Map();
      alsoSearch = files.some(({kind}) => kind !== 'markdown') ? {cwd, links, linkSignature, sides, done: null} : null;
      cancelFollowUp?.();
      cancelFollowUp = null;

      const wanted = new Set([...next.values()].flatMap((planned) => (planned.request ? [planned.request.key] : [])));
      for (const [key, running] of asking) {
        if (wanted.has(key)) continue;
        running.controller.abort();
        asking.delete(key);
      }
      for (const key of answers.keys()) if (!wanted.has(key)) answers.delete(key);
      answersChanged += 1;
      // A split showing the page follows an edit to a review with nothing
      // to render too.
      if (next.size > 0 || (live && inSplit !== null)) schedule();
    },

    /** The active file changed: it and its neighbors render first. */
    focus(fileKey: string) {
      focused = fileKey;
      pane?.focus(fileKey);
      for (const running of asking.values()) {
        const planned = running.epoch === epoch ? plan.get(running.fileKey) : undefined;
        if (planned) raise(running, priorityOf(planned));
      }
    },

    /** Whether the file is markdown, an image or an SVG: what the header's button and the first-time tip speak of. */
    renderable(fileKey: string) {
      return plan.has(fileKey);
    },

    /** The review's page, written now if it isn't yet. */
    async page(): Promise<PageOutcome> {
      const written = await writeReview();
      if (!written.ok) return written;
      const {files: _files, ...outcome} = written;
      return {...outcome, url: site.url(written.key)};
    },

    /**
     * Opens the review's page at the file's card, with `trip` played on
     * the way, at the top when the review has no such file. Null when a
     * newer press took this one's place.
     */
    async open({fileKey: key}: {fileKey: string}, trip?: Trip): Promise<OpenOutcome | null> {
      const off = offReason();
      if (off) return {kind: 'error', message: off};
      const files = shown?.review.files ?? [];
      if (files.length === 0) return {kind: 'info', message: NOTHING_TO_OPEN};
      const index = files.findIndex((file) => fileKey({path: file.path, nameError: file.pathError}) === key);
      const name = index < 0 ? 'all files' : path.posix.basename(escapeHiddenCharacters(files[index]!.path));
      return travel(key, name, index < 0 ? undefined : key, trip);
    },

    /** Opens the review's page at its top, like `open`. */
    async openOverview(trip?: Trip): Promise<OpenOutcome | null> {
      const off = offReason();
      if (off) return {kind: 'error', message: off};
      if ((shown?.review.files.length ?? 0) === 0) return {kind: 'info', message: NOTHING_TO_OPEN};
      return travel(null, 'all files', undefined, trip);
    },

    /** How much the TUI moves on a trip, asked once for the session. */
    crossingMotion(): Promise<Motion> {
      motionAsked ??= motion ? motion() : Promise.resolve('off');
      return motionAsked;
    },

    /** The Review in browser button's hover tip: what it opens and where, or why it can't. */
    openHint() {
      if (!surface) return null;
      // A refusal's reason, without the alternative it goes on to name.
      return surface.destination ? `Open this file's changes ${surface.destination}, as GitHub shows them` : (surface.refusal ?? '').split(' · ')[0]!;
    },

    /** Whether `r` and `R` open anything here. */
    opens,

    /** Calls `listener` whenever there is a notice to take. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Changes whenever a notice arrives. */
    getVersion() {
      return version;
    },

    /** Messages for the footer since the last call. */
    takeNotices() {
      return notices.splice(0);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer?.();
      cancelLive?.();
      cancelFollowUp?.();
      pane?.dispose();
      surface?.dispose?.();
      for (const running of asking.values()) running.controller.abort();
      asking.clear();
      backend.dispose();
    },
  };
}

export type RenderedService = ReturnType<typeof createRenderedService>;

/** What the TUI uses to open pages and hear the service's notices. */
export type RenderedPages = Pick<RenderedService, 'renderable' | 'open' | 'openOverview' | 'openHint' | 'subscribe' | 'getVersion' | 'takeNotices'> & Partial<Pick<RenderedService, 'pane' | 'crossingMotion' | 'opens'>>;

/**
 * The service the CLI runs: its own worker, pages in the session dir, and
 * the surface they open on. `live`: watch mode, where an open split
 * follows the edits.
 */
export function startRenderedService({tempDir, env, cwd, animations = true, opener, pane, live = false, openDeadlineMs}: {tempDir: () => string; env: NodeJS.ProcessEnv; cwd: string; animations?: boolean; opener: Opener; pane?: {registry: ImageRegistry; caps: GraphicsCaps}; live?: boolean; openDeadlineMs?: number}) {
  const platform = process.platform;
  // Looked up the first time `v` asks, and fixed for the session.
  let chrome: ChromeBinary | null | undefined;
  const findBrowser = () => (chrome === undefined ? (chrome = findChrome({env, home: os.homedir(), platform, findTool: (name) => findTool(name, env, cwd), repoRoot: cwd})) : chrome);
  // Over SSH, `r` names `v` only on a file whose page the pane draws, which
  // is known once the service, and the pane in it, exists.
  let service: RenderedService | null = null;
  const inPane = (fileKey: string | null) => Boolean(fileKey !== null && service?.pane?.covers(fileKey) && service.pane.advertised());
  service = createRenderedService({
    backend: createRenderedBackend({tempDir, env, cwd}),
    site: createRenderedSite({tempDir}),
    surface: createSurface({env, run: runTool, findTool: (name) => findTool(name, env, cwd), opener, platform, inPane}),
    ...(pane ? {pane: {...pane, env, chrome: findBrowser}} : {}),
    motion: () => resolveMotion({env, animations, run: runTool, platform}),
    animations,
    live,
    tips: readTips,
    ...(openDeadlineMs !== undefined ? {openDeadlineMs} : {}),
  });
  return service;
}
