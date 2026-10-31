import path from 'node:path';
import {escapeHiddenCharacters} from '../controlChars.js';
import {fileKey, type DiffRange} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import type {Opener} from '../media/openExternal.js';
import {findTool} from '../media/worker/tools.js';
import type {ReviewFile, ReviewModel} from '../review/model.js';
import {reviewAssetSides, type AssetSides} from './assets.js';
import type {FragmentRequest, FragmentSummary, PageRequest, RenderedBackend} from './backend.js';
import {changeGroups} from './changes.js';
import {failedMarkdownPage, renderableKind} from './classify.js';
import {formatPageHash, type PageHash} from './hash.js';
import {fileAlias, OVERVIEW_ALIAS, overviewKey, pageKey, railSignature, renderedPageKey} from './keys.js';
import type {LinkAnswer, RenderedFragment} from './markdown.js';
import {resolveMotion, type Motion} from './motion.js';
import {assembleOverview, railLabel, type OverviewEntry, type PageBody, type PageInput, type RailEntry} from './page.js';
import {runTool} from './run.js';
import {createRenderedSite, type RenderedSite} from './site.js';
import {oneLine, sourceSpec} from './source.js';
import {createSurface, type ShowResult, type Surface} from './surface.js';
import {createRenderedBackend} from './workerClient.js';

// The UI side of the rendered view. It holds what names and labels the
// pages (keys, counts, failures), never their HTML: the worker renders,
// this side writes the finished pages into the session dir. When a review
// arrives it renders the review's markdown in the background, the active
// file first, so a page is usually on disk before anyone asks for it. `r`
// and `R` come here to open a page on the surface: this side decides
// whether the TUI plays its crossing, and what the footer says after. Each
// trip's URL carries a hash for the page script: the line to open at, the
// full develop on a file's first visit and the short revisit after, motion
// and the terminal's colors. In watch mode, a page the split shows that a
// refresh rewrote is sent there again, with the blocks that are new.

// The first review waits for the UI to settle; a watch refresh waits for
// a burst of writes to end.
const FIRST_DELAY_MS = 2_000;
const SETTLE_MS = 250;
const MAX_PRERENDER = 40;
// Files this close to the active one in the review's order render next.
const NEIGHBORS = 3;
// How long `r` waits for a page that isn't written yet.
const OPEN_DEADLINE_MS = 5_000;
// How much of that `R` gives the background pass before it lists what is
// done so far: the overview never waits on every file of a cold review.
const OVERVIEW_WAIT_MS = 3_000;
// How many times a pass writes the pages again when a page's render moved
// the count its own rail shows.
const MAX_REWRITES = 3;
// The fewest ms between two live refreshes of the split.
const LIVE_GAP_MS = 1_000;
const NOTHING_TO_RENDER = 'nothing to render · no markdown files on this branch';

/**
 * The mark for "opens outside the pane". `↗` would read better, but
 * string-width, which Ink lays rows out with, counts it two cells while
 * terminals draw it in one, so every row holding it would end a cell short.
 */
export const LEAVES_PANE = '⇗';

export type PageOutcome = {ok: true; key: string; url: string} | {ok: false; reason: string};

/** What the footer says after `r` or `R`. */
export type OpenOutcome = {message: string; kind: 'info' | 'error'};

/**
 * The TUI's part in a trip: `cross` plays the crossing for `motion` and
 * settles when it ends; `waiting` says the page is still being rendered.
 */
export type Trip = {cross: (motion: Motion) => Promise<void>; waiting: (message: string) => void};

export type PageSurface = Pick<Surface, 'kind' | 'refusal' | 'destination' | 'show'> & Partial<Pick<Surface, 'dispose' | 'refresh'>>;

export type SetTimer = (run: () => void, ms: number) => () => void;

const defaultTimer: SetTimer = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

// One file the review can render, with everything its fragment depends on.
type Planned = {
  file: ReviewFile;
  fileKey: string;
  alias: string;
  order: number;
  // Null when the review entry itself failed: the page is that card.
  request: Omit<FragmentRequest, 'assets'> | null;
  // The review's asset sides, shared by its files and read from its
  // patches the first time a fragment is sent, not while the UI renders.
  sides: () => AssetSides;
  failure?: string;
};

type Answer = {summary: FragmentSummary} | {failed: string};

type Written = {ok: true; key: string} | {ok: false; reason: string};

type Asking = {epoch: number; fileKey: string; priority: number; controller: AbortController; done: Promise<Answer | null>};

export function createRenderedService({backend, site, surface, motion, animations = true, colors = {}, now = Date.now, setTimer = defaultTimer}: {
  backend: RenderedBackend;
  site: RenderedSite;
  /** Where pages open. Without one, the service only renders. */
  surface?: PageSurface;
  /** How much the TUI moves, asked once, at the first trip. */
  motion?: () => Promise<Motion>;
  /** False with `--no-animations`: pages arrive final, with no motion at all. */
  animations?: boolean;
  /** The terminal's text and background colors, which the page's first frame paints in. */
  colors?: {fg?: string; bg?: string};
  now?: () => number;
  setTimer?: SetTimer;
}) {
  let plan = new Map<string, Planned>();
  let title: Omit<PageInput['title'], 'renderedAt'> | null = null;
  let epoch = 0;
  let started = false;
  let cancelTimer: (() => void) | null = null;
  let focused: string | null = null;
  let disposed = false;
  // By fragment key: the newest answer, and the review it was asked for.
  const answers = new Map<string, {epoch: number; answer: Answer}>();
  const asking = new Map<string, Asking>();
  // By file key: its newest page, and the one before it.
  const current = new Map<string, string>();
  const previous = new Map<string, string>();
  const writing = new Map<string, Promise<Written>>();
  // By file key: the review whose page its stable name points at, so a
  // slower write for an older review never takes it back.
  const aliasedAt = new Map<string, number>();
  // By file key: why the newest write of its page failed, and for which review.
  const unwritten = new Map<string, {epoch: number; reason: string}>();
  const notices: string[] = [];
  let saidOff = false;
  const listeners = new Set<() => void>();
  let version = 0;
  // The pass rendering a review in the background, when one runs.
  let background: {epoch: number; done: Promise<void>} | null = null;
  // A page's render counted its file differently from the answer its rail
  // was written with, so that page is written again.
  let stale = false;
  // The overview's newest page, kept through prunes.
  let overview: string | null = null;
  let motionAsked: Promise<Motion> | null = null;
  // The first page shown says that it was rendered here.
  let saidLocal = false;
  // Counts `r` and `R` presses: only the newest one's page is shown.
  let presses = 0;
  // Counts the URLs sent to the surface, so each one differs and a split
  // showing the page already still hears it.
  let trips = 0;
  // Files whose page opened this session: the next trip is a revisit.
  const visited = new Set<string>();
  // The file page the split shows, where it opened it, and the blocks it
  // had, for live refreshes. Null when the split shows something else.
  let inSplit: {fileKey: string; key: string; at?: number; f?: number; blocks: Set<string>} | null = null;
  let lastLive = -Infinity;
  let cancelLive: (() => void) | null = null;
  // Presses whose page is still on its way to the surface. A live refresh
  // waits for them: the press decides what the split shows, and a refresh
  // still due after it goes then.
  let travelling = 0;
  let liveAfterPress = false;

  const tripHash = (hash: Pick<PageHash, 'at' | 'f' | 'd' | 'g'>) => formatPageHash({...hash, m: animations, bg: colors.bg, fg: colors.fg, n: (trips += 1)});

  const say = (notice: string) => {
    notices.push(notice);
    version += 1;
    for (const listener of listeners) listener();
  };

  // Reasons reach the footer, page cards and the overview as one line with
  // the home dir as `~`. A worker that crashed is described by its stderr,
  // which can name any path on the machine.
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
    const controller = new AbortController();
    const send = () => backend.fragment(fragmentRequest(planned), controller.signal, priority);
    // A render whose image lookups ran out of time (a cold git) marks less
    // than its page will once they answer, so it is asked once more before
    // any rail counts it.
    const done = send().then((result) => (result.ok && result.summary.late ? send() : result)).then((result): Answer => {
      if (result.ok) return {summary: result.summary};
      // The failure that used up the worker's last strike says so.
      offReason();
      return {failed: oneLine(result.reason)};
    }).then((answer) => {
      const known = answers.get(request.key);
      if (!known || known.epoch <= askedAt) answers.set(request.key, {epoch: askedAt, answer});
      return answer;
    }, () => null).finally(() => {
      if (asking.get(request.key)?.controller === controller) asking.delete(request.key);
    });
    asking.set(request.key, {epoch: askedAt, fileKey: planned.fileKey, priority, controller, done});
    return done;
  };

  // Active file 0, its neighbors 1, the rest 2.
  const priorityOf = (planned: Planned) => {
    const active = focused === null ? undefined : plan.get(focused);
    if (!active) return 2;
    const distance = Math.abs(active.order - planned.order);
    return distance === 0 ? 0 : distance <= NEIGHBORS ? 1 : 2;
  };

  const answerFor = (planned: Planned) => (planned.request ? answers.get(planned.request.key)?.answer : undefined);

  // A page's render is the newest word on its file: when it counts the file
  // differently from the fragment's answer (an image lookup that ran out of
  // time, then answered), the page's count becomes the answer. The overview
  // and every rail written from then on show it, and the file's own page is
  // written again so its rail matches what it marks.
  function revise(key: string, summary: FragmentSummary, askedAt: number) {
    const known = answers.get(key);
    if (known && known.epoch > askedAt) return;
    if (known && 'summary' in known.answer && JSON.stringify(known.answer.summary) === JSON.stringify(summary)) return;
    answers.set(key, {epoch: askedAt, answer: {summary}});
    stale = true;
    // A pass running, or waiting to start, writes them; else one starts.
    if (askedAt === epoch && background?.epoch !== epoch && !cancelTimer) void prerender();
  }

  // A file whose render failed isn't sent again by later passes while it
  // is unchanged: a file that keeps timing out would cost the worker a
  // strike on every refresh and turn the whole view off. Opening its page
  // asks again.
  const failedBefore = (planned: Planned) => {
    const answer = answerFor(planned);
    return answer !== undefined && 'failed' in answer;
  };

  const railFor = (planned: Planned): RailEntry[] => [...plan.values()].map((each) => {
    const answer = answerFor(each);
    return {
      path: each.file.path,
      status: each.file.status,
      href: `${each.alias}.html`,
      label: railLabel(each.file.status, each.request && !answer ? 'pending' : answer && 'summary' in answer && answer.summary.kind === 'rendered' ? answer.summary.changes : null),
      current: each === planned,
    };
  });

  // Writes the file's page for the review as it is now, unless it is on
  // disk already. Showing it is the caller's business. `placeholder`: a
  // file with no fragment yet gets a page saying so, not a render, so every
  // link to it opens something.
  async function writePage(planned: Planned, placeholder = false): Promise<Written> {
    const off = offReason();
    if (off) return {ok: false, reason: off};
    const answer = answerFor(planned);
    const failure = planned.failure ?? (answer && 'failed' in answer ? answer.failed : undefined);
    // A render that timed out isn't sent again: the page says why.
    const body: PageBody | null = failure !== undefined ? {kind: 'failed', reason: failure, source: ''} : placeholder && !answer ? {kind: 'pending'} : null;
    const summary = answer && 'summary' in answer ? answer.summary : undefined;
    const rail = railFor(planned);
    const key = renderedPageKey({
      fragment: planned.request?.key ?? planned.fileKey,
      // A failed page and the page that renders once the failure passes
      // never share a name.
      body: failure !== undefined ? `failed:${failure}` : summary ? (summary.kind === 'failed' ? `failed:${summary.reason ?? ''}` : summary.kind) : body ? body.kind : 'unrendered',
      assets: summary?.assets ?? '',
      rail,
      title: title!,
    });
    const askedAt = epoch;
    // The page on disk, which the stable name already points at, is the one
    // this review wants: the name now stands for this review too.
    if (current.get(planned.fileKey) === key && site.has(key)) {
      if ((aliasedAt.get(planned.fileKey) ?? -1) < askedAt) aliasedAt.set(planned.fileKey, askedAt);
      return {ok: true, key};
    }

    let pending = writing.get(key);
    if (!pending) {
      const request: PageRequest = {
        key,
        title: {...title!, renderedAt: now()},
        file: {path: planned.file.path, status: planned.file.status, ...(planned.file.oldPath ? {oldPath: planned.file.oldPath} : {})},
        rail,
        content: body ? {body} : {fragment: fragmentRequest(planned)},
      };
      pending = backend.page(request, new AbortController().signal).then((result): Written => {
        if (!result.ok) {
          offReason();
          return {ok: false, reason: oneLine(result.reason)};
        }
        if (result.rerendered && 'fragment' in request.content) revise(request.content.fragment.key, result.summary, askedAt);
        try {
          site.write(key, result.html);
        } catch (error) {
          return {ok: false, reason: oneLine(error)};
        }
        return {ok: true, key};
      }).finally(() => writing.delete(key));
      writing.set(key, pending);
    }
    // Each review that asked for this page settles its own stable name: a
    // write one review started can finish for a later one that wants it.
    const written = await pending;
    const settled = written.ok ? point(planned, key, askedAt) : written;
    if (!settled.ok) unwritten.set(planned.fileKey, {epoch: askedAt, reason: settled.reason});
    return settled;
  }

  // Whether the file's stable name opens a page written for the review as
  // it is now. An older review's page may count other changes, so the
  // overview never links to one.
  const pointedNow = (planned: Planned) => aliasedAt.get(planned.fileKey) === epoch;

  // Points the file's stable name at the page `askedAt`'s review wrote,
  // unless a newer review's page got there first: this one then stays on
  // disk for whoever asked for it, and the stable name keeps the newer.
  function point(planned: Planned, key: string, askedAt: number): Written {
    if ((aliasedAt.get(planned.fileKey) ?? -1) > askedAt) return {ok: true, key};
    try {
      site.alias(planned.alias, key);
    } catch (error) {
      return {ok: false, reason: oneLine(error)};
    }
    aliasedAt.set(planned.fileKey, askedAt);
    const was = current.get(planned.fileKey);
    if (was !== undefined && was !== key) previous.set(planned.fileKey, was);
    current.set(planned.fileKey, key);
    return {ok: true, key};
  }

  // Renders the review's markdown, nearest the active file first, then
  // writes the pages: their rails count every file's changes, so pages wait
  // for the fragments. A file past the limit gets a page saying it isn't
  // rendered yet, so the rail and the links that point at it never open
  // nothing, nor an older review's page. A file this review already has an
  // answer for isn't asked again.
  function prerender() {
    started = true;
    cancelTimer = null;
    const running = {epoch, done: Promise.resolve()};
    background = running;
    running.done = renderPass(running);
    return running.done;
  }

  async function renderPass(running: {epoch: number}) {
    const pass = running.epoch;
    try {
      const chosen = [...plan.values()].sort((left, right) => priorityOf(left) - priorityOf(right) || left.order - right.order).slice(0, MAX_PRERENDER);
      const unanswered = chosen.filter((planned) => planned.request && !failedBefore(planned) && answers.get(planned.request.key)?.epoch !== pass);
      await Promise.all(unanswered.map((planned) => ask(planned, priorityOf(planned))));
      if (disposed || pass !== epoch || offReason()) return;
      for (let round = 0; round < MAX_REWRITES; round += 1) {
        stale = false;
        for (const planned of [...plan.values()]) {
          await writePage(planned, true);
          if (disposed || pass !== epoch) return;
        }
        if (!stale) break;
      }
      refreshSplit();
      site.prune({
        current: new Map([...plan.values()].flatMap((planned) => {
          const key = current.get(planned.fileKey);
          return key ? [[planned.alias, key] as const] : [];
        }).concat(overview ? [[OVERVIEW_ALIAS, overview] as const] : [])),
        previous: new Set([...plan.keys()].flatMap((key) => (previous.has(key) ? [previous.get(key)!] : []))),
      });
    } finally {
      // In the same turn as the last check above, so a count that moves
      // after it finds no pass running and starts one.
      if (background === running) background = null;
    }
  }

  const schedule = () => {
    // The first review's wait runs out once; a later review only settles.
    if (!started && cancelTimer) return;
    cancelTimer?.();
    cancelTimer = setTimer(() => void prerender(), started ? SETTLE_MS : FIRST_DELAY_MS);
  };

  /** The file's newest page, rendered and written now if it isn't yet. */
  async function page(fileKey: string): Promise<PageOutcome> {
    const planned = plan.get(fileKey);
    if (!planned) return {ok: false, reason: 'no rendered page for this file'};
    const off = offReason();
    if (off) return {ok: false, reason: off};
    if (planned.request && answers.get(planned.request.key)?.epoch !== epoch) await ask(planned, 0);
    // The review may have moved on while it rendered.
    const latest = plan.get(fileKey);
    if (!latest) return {ok: false, reason: 'no rendered page for this file'};
    const answered = answerFor(latest);
    let written = await writePage(latest);
    // Its render counted the file anew: the page shown has a rail that says so.
    if (written.ok && answerFor(latest) !== answered) written = await writePage(latest);
    return written.ok ? {...written, url: site.url(written.key)} : written;
  }

  // Writes the overview of the review as it is now. The pages are written
  // first, by a background pass started now if none is running, for as long
  // as the deadline allows. A row with no page yet has no link.
  async function writeOverview(): Promise<PageOutcome> {
    if (background?.epoch !== epoch) {
      cancelTimer?.();
      void prerender();
    }
    if (background) {
      let stop = () => {};
      await Promise.race([background.done, new Promise<void>((resolve) => {
        stop = setTimer(resolve, OVERVIEW_WAIT_MS);
      })]);
      stop();
    }
    const off = offReason();
    if (off) return {ok: false, reason: off};
    const differences = new Map<RenderedFragment['differences'][number]['kind'], number>();
    const entries = [...plan.values()].map((planned): OverviewEntry => {
      const answer = answerFor(planned);
      const summary = answer && 'summary' in answer ? answer.summary : undefined;
      const failure = planned.failure ?? (answer && 'failed' in answer ? answer.failed : undefined);
      for (const difference of summary?.differences ?? []) differences.set(difference.kind, (differences.get(difference.kind) ?? 0) + difference.count);
      const written = pointedNow(planned);
      // A row with no page says why this review's write failed, if it did.
      const notWritten = unwritten.get(planned.fileKey);
      const reason = written ? failure ?? summary?.reason : notWritten?.epoch === epoch ? notWritten.reason : undefined;
      return {
        path: planned.file.path,
        status: planned.file.status,
        ...(planned.file.oldPath ? {oldPath: planned.file.oldPath} : {}),
        href: written ? `${planned.alias}.html` : null,
        state: !written ? 'pending' : failure !== undefined ? 'failed' : summary?.kind ?? 'pending',
        changes: summary?.kind === 'rendered' ? summary.changes : null,
        ...(reason !== undefined ? {reason} : {}),
      };
    });
    const input = {title: {...title!, renderedAt: now()}, entries, differences: [...differences].map(([kind, count]) => ({kind, count}))};
    const key = overviewKey(input);
    try {
      if (!site.has(key)) site.write(key, assembleOverview(input));
      site.alias(OVERVIEW_ALIAS, key);
    } catch (error) {
      return {ok: false, reason: oneLine(error)};
    }
    overview = key;
    return {ok: true, key, url: site.url(key)};
  }

  const blockIds = (planned: Planned) => {
    const answer = answerFor(planned);
    return new Set(answer && 'summary' in answer ? answer.summary.blocks.map((block) => block.id) : []);
  };

  // The split shows a file page a refresh just rewrote: it goes to the new
  // page where it was, with no develop and a pulse on the blocks that are
  // new. At most once a second; a refresh inside the second waits, and the
  // newest page goes then. A split that is gone ends live refreshes until
  // the next trip opens one.
  function refreshSplit() {
    const shown = inSplit;
    if (!shown || !surface?.refresh || disposed || cancelLive) return;
    if (travelling > 0) {
      liveAfterPress = true;
      return;
    }
    const planned = plan.get(shown.fileKey);
    const key = current.get(shown.fileKey);
    if (!planned || !key || key === shown.key || !pointedNow(planned)) return;
    const wait = lastLive + LIVE_GAP_MS - now();
    if (wait > 0) {
      cancelLive = setTimer(() => {
        cancelLive = null;
        refreshSplit();
      }, wait);
      return;
    }
    lastLive = now();
    const blocks = blockIds(planned);
    const fresh = [...blocks].filter((id) => !shown.blocks.has(id));
    const place = {...(shown.at !== undefined ? {at: shown.at} : {}), ...(shown.f !== undefined ? {f: shown.f} : {})};
    const next = {...shown, key, blocks};
    inSplit = next;
    void surface.refresh(site.url(key, tripHash({...place, d: 'none', g: fresh}))).then((went) => {
      if (!went && inSplit === next) inSplit = null;
    });
  }

  // One trip to a page: the TUI's crossing, played while the page is
  // written and placed on the surface, so the crossing covers the split
  // opening. `name` is how the footer names the page, and `note` what it
  // adds about it. Nothing crosses toward a surface that refuses. A page
  // still unwritten after the crossing is said to be rendering, until the
  // deadline gives up on it, and then it opens nowhere. A press made after
  // this one wins: this one's page is never shown over it. `opened` hears
  // where the page went once it did.
  async function travel(name: string, note: string | null, write: () => Promise<PageOutcome>, trip?: Trip, opened?: (where: 'cmux-new' | 'cmux-reuse' | 'browser', key: string) => void): Promise<OpenOutcome | null> {
    const place = surface;
    if (!place) return {kind: 'error', message: 'pages open only in the full app'};
    if (place.refusal) return {kind: 'error', message: place.refusal};
    const press = (presses += 1);
    travelling += 1;
    motionAsked ??= motion ? motion() : Promise.resolve('off');
    const crossing = motionAsked.then((kind) => trip?.cross(kind));
    let ready = false;
    let gaveUp = false;
    let cancelDeadline = () => {};
    const late = new Promise<'late'>((resolve) => {
      cancelDeadline = setTimer(() => {
        gaveUp = true;
        resolve('late');
      }, OPEN_DEADLINE_MS);
    });
    const shown = write().then<ShowResult | {error: string} | null>((written) => {
      ready = true;
      cancelDeadline();
      // After dispose the session dir is going: nothing is placed.
      if (gaveUp || disposed || press !== presses) return null;
      if (!written.ok) return {error: written.reason};
      return place.show(written.url).then((result) => {
        if ('where' in result) opened?.(result.where, written.key);
        return result;
      });
    });
    void shown.catch(() => null).then(() => {
      travelling -= 1;
      if (travelling > 0 || !liveAfterPress) return;
      liveAfterPress = false;
      refreshSplit();
    });
    await crossing;
    if (!ready && press === presses) trip?.waiting(`rendering ${name}…`);
    const outcome = await Promise.race([shown, late]);
    // A newer press's toast is on screen by now, and its page is the one shown.
    if (outcome === 'late') return press === presses ? {kind: 'error', message: `${name} took too long to render`} : null;
    if (outcome === null || 'superseded' in outcome) return null;
    if ('error' in outcome) return {kind: 'error', message: outcome.error};
    if ('refused' in outcome) return {kind: 'error', message: outcome.refused};
    const parts = [`${LEAVES_PANE} ${name}`, ...(note ? [note] : []), outcome.message];
    if (!saidLocal) parts.push('nothing left this machine');
    saidLocal = true;
    return {kind: 'info', message: parts.join(' · ')};
  }

  return {
    /**
     * Takes a new review: plans its markdown pages and drops work for files
     * that left it. Called while rendering, so it only starts work.
     */
    setReview(review: ReviewModel, {cwd, range}: {cwd: string; range: DiffRange}) {
      if (disposed) return;
      epoch += 1;
      title = {repo: path.basename(cwd), base: range.base, branch: review.branch, worktree: range.includeWorktree};
      const files = review.files.flatMap((file) => {
        if (renderableKind(file, range) === 'markdown') return [{file}];
        const failed = failedMarkdownPage(file, range);
        return failed === null ? [] : [{file, ...('reason' in failed ? {failure: failed.reason} : {})}];
      });
      const linkSignature = railSignature(files.map(({file}) => file));
      const aliases = new Map(files.map(({file}) => [file.path, fileAlias(fileKey({path: file.path, nameError: file.pathError}))]));
      // A link to another rendered file opens its newest page. A deleted
      // file's page exists, but the link is broken on GitHub.
      const links: Record<string, LinkAnswer> = Object.fromEntries(files.map(({file}): [string, LinkAnswer] => [
        file.path,
        file.status === 'deleted' ? {kind: 'missing'} : {kind: 'inReview', href: `${aliases.get(file.path)!}.html`},
      ]));
      const reviewEpoch = epoch;
      let assets: AssetSides | null = null;
      const sides = () => (assets ??= reviewAssetSides(review, range, reviewEpoch));

      const next = new Map<string, Planned>();
      for (const [order, {file, failure}] of files.entries()) {
        const key = fileKey({path: file.path, nameError: file.pathError});
        const ids = patchObjectIds(file.rawDiff) ?? {};
        const groups = changeGroups(file);
        const moved = file.oldPath ? {oldPath: file.oldPath} : {};
        const request: Planned['request'] = failure !== undefined ? null : {
          cwd,
          key: pageKey({path: file.path, ...moved, status: file.status, ...ids, groups, rail: linkSignature}),
          path: file.path,
          ...moved,
          status: file.status,
          source: sourceSpec(file, range, ids),
          groups,
          links,
        };
        next.set(key, {file, fileKey: key, alias: aliases.get(file.path)!, order, request, sides, ...(failure !== undefined ? {failure} : {})});
      }
      plan = next;

      const wanted = new Set([...next.values()].flatMap((planned) => (planned.request ? [planned.request.key] : [])));
      for (const [key, running] of asking) {
        if (wanted.has(key)) continue;
        running.controller.abort();
        asking.delete(key);
      }
      for (const key of answers.keys()) if (!wanted.has(key)) answers.delete(key);
      for (const key of [...current.keys()]) {
        if (next.has(key)) continue;
        current.delete(key);
        previous.delete(key);
        aliasedAt.delete(key);
      }
      if (next.size > 0) schedule();
    },

    /** The active file changed: it and its neighbors render first. */
    focus(fileKey: string) {
      focused = fileKey;
      for (const running of asking.values()) {
        const planned = running.epoch === epoch ? plan.get(running.fileKey) : undefined;
        if (planned) raise(running, priorityOf(planned));
      }
    },

    /** Whether the file has a rendered page. */
    renderable(fileKey: string) {
      return plan.has(fileKey);
    },

    /** The file's newest page, rendered and written now if it isn't yet. */
    page,

    /**
     * Opens the file's page, or the review's first page when the file has
     * none, with `trip` played on the way. `line` is the source line the
     * diff shows at the top of the pane, and `fraction` how far down the
     * pane it is, so the page opens with that block in the same place.
     * Null when a newer press took this one's place.
     */
    async open({fileKey, line, fraction}: {fileKey: string; line?: number; fraction?: number}, trip?: Trip): Promise<OpenOutcome | null> {
      const off = offReason();
      if (off) return {kind: 'error', message: off};
      const planned = plan.get(fileKey) ?? plan.values().next().value;
      if (!planned) return {kind: 'info', message: NOTHING_TO_RENDER};
      const shownPath = escapeHiddenCharacters(planned.file.path);
      const fallback = planned.fileKey !== fileKey;
      // The line belongs to the active file: another file's page opens at its top.
      const place = fallback ? {} : {...(line !== undefined ? {at: line} : {}), ...(fraction !== undefined ? {f: fraction} : {})};
      const hash = tripHash({...place, d: visited.has(planned.fileKey) ? 'short' : 'full'});
      const write = async (): Promise<PageOutcome> => {
        const written = await page(planned.fileKey);
        return written.ok ? {...written, url: `${written.url}#${hash}`} : written;
      };
      return travel(fallback ? shownPath : path.posix.basename(shownPath), fallback ? 'first rendered file' : null, write, trip, (where, key) => {
        visited.add(planned.fileKey);
        inSplit = where === 'browser' ? null : {fileKey: planned.fileKey, key, ...place, blocks: blockIds(planned)};
      });
    },

    /** Opens the overview of the review's pages, like `open`. */
    async openOverview(trip?: Trip): Promise<OpenOutcome | null> {
      const off = offReason();
      if (off) return {kind: 'error', message: off};
      if (plan.size === 0) return {kind: 'info', message: NOTHING_TO_RENDER};
      // The split shows the overview now, which no file's refresh replaces.
      return travel('overview', null, writeOverview, trip, () => {
        inSplit = null;
      });
    },

    /** The Rendered button's hint: where its page opens, or why it can't. */
    openHint() {
      if (!surface) return null;
      // A refusal's reason, without the alternative it goes on to name.
      return surface.destination ? `r · opens the rendered page ${surface.destination}` : `r · ${(surface.refusal ?? '').split(' · ')[0]}`;
    },

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
      surface?.dispose?.();
      for (const running of asking.values()) running.controller.abort();
      asking.clear();
      backend.dispose();
    },
  };
}

export type RenderedService = ReturnType<typeof createRenderedService>;

/** What the TUI uses to open pages and hear the service's notices. */
export type RenderedPages = Pick<RenderedService, 'renderable' | 'open' | 'openOverview' | 'openHint' | 'subscribe' | 'getVersion' | 'takeNotices'>;

/**
 * The service the CLI runs: its own worker, pages in the session dir, and
 * the surface they open on. `colors` are the terminal's, as it answered
 * them at startup.
 */
export function startRenderedService({tempDir, env, cwd, animations = true, opener, colors = {}}: {tempDir: () => string; env: NodeJS.ProcessEnv; cwd: string; animations?: boolean; opener: Opener; colors?: {fg?: string; bg?: string}}) {
  const platform = process.platform;
  return createRenderedService({
    backend: createRenderedBackend({tempDir, env, cwd}),
    site: createRenderedSite({tempDir}),
    surface: createSurface({env, run: runTool, findTool: (name) => findTool(name, env, cwd), opener, platform}),
    motion: () => resolveMotion({env, animations, run: runTool, platform}),
    animations,
    colors,
  });
}
