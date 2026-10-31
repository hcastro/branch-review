import path from 'node:path';
import {fileKey, type DiffRange} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import type {ReviewFile, ReviewModel} from '../review/model.js';
import {reviewAssetSides, type AssetSides} from './assets.js';
import type {FragmentRequest, FragmentSummary, PageRequest, RenderedBackend} from './backend.js';
import {changeGroups} from './changes.js';
import {failedMarkdownPage, renderableKind} from './classify.js';
import {fileAlias, pageKey, railSignature, renderedPageKey} from './keys.js';
import type {LinkAnswer} from './markdown.js';
import {railLabel, type PageBody, type PageInput, type RailEntry} from './page.js';
import {createRenderedSite, type RenderedSite} from './site.js';
import {sourceSpec} from './source.js';
import {createRenderedBackend} from './workerClient.js';

// The UI side of the rendered view. It holds what names and labels the
// pages (keys, counts, failures), never their HTML: the worker renders,
// this side writes the finished pages into the session dir. When a review
// arrives it renders the review's markdown in the background, the active
// file first, so a page is usually on disk before anyone asks for it.

// The first review waits for the UI to settle; a watch refresh waits for
// a burst of writes to end.
const FIRST_DELAY_MS = 2_000;
const SETTLE_MS = 250;
const MAX_PRERENDER = 40;
// Files this close to the active one in the review's order render next.
const NEIGHBORS = 3;

export type PageOutcome = {ok: true; key: string; url: string} | {ok: false; reason: string};

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

export function createRenderedService({backend, site, now = Date.now, setTimer = defaultTimer}: {
  backend: RenderedBackend;
  site: RenderedSite;
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
  const notices: string[] = [];
  let saidOff = false;

  const offReason = () => {
    const reason = backend.disabledReason();
    if (reason && !saidOff) {
      saidOff = true;
      notices.push(`✗ ${reason}`);
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
    const done = backend.fragment(fragmentRequest(planned), controller.signal, priority).then((result): Answer => {
      if (result.ok) return {summary: result.summary};
      // The failure that used up the worker's last strike says so.
      offReason();
      return {failed: result.reason};
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
      label: railLabel(each.file.status, answer && 'summary' in answer && answer.summary.kind === 'rendered' ? answer.summary.changes : null),
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
    if (current.get(planned.fileKey) === key && site.has(key)) return {ok: true, key};

    const askedAt = epoch;
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
          return {ok: false, reason: result.reason};
        }
        try {
          site.write(key, result.html);
        } catch (error) {
          return {ok: false, reason: error instanceof Error ? error.message : String(error)};
        }
        return {ok: true, key};
      }).finally(() => writing.delete(key));
      writing.set(key, pending);
    }
    // Each review that asked for this page settles its own stable name: a
    // write one review started can finish for a later one that wants it.
    const written = await pending;
    return written.ok ? point(planned, key, askedAt) : written;
  }

  // Points the file's stable name at the page `askedAt`'s review wrote,
  // unless a newer review's page got there first: this one then stays on
  // disk for whoever asked for it, and the stable name keeps the newer.
  function point(planned: Planned, key: string, askedAt: number): Written {
    if ((aliasedAt.get(planned.fileKey) ?? -1) > askedAt) return {ok: true, key};
    try {
      site.alias(planned.alias, key);
    } catch (error) {
      return {ok: false, reason: error instanceof Error ? error.message : String(error)};
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
  // nothing, nor an older review's page.
  async function prerender() {
    started = true;
    cancelTimer = null;
    const pass = epoch;
    const chosen = [...plan.values()].sort((left, right) => priorityOf(left) - priorityOf(right) || left.order - right.order).slice(0, MAX_PRERENDER);
    await Promise.all(chosen.filter((planned) => planned.request && !failedBefore(planned)).map((planned) => ask(planned, priorityOf(planned))));
    if (disposed || pass !== epoch || offReason()) return;
    for (const planned of [...plan.values()]) {
      await writePage(planned, true);
      if (disposed || pass !== epoch) return;
    }
    site.prune({
      current: new Map([...plan.values()].flatMap((planned) => {
        const key = current.get(planned.fileKey);
        return key ? [[planned.alias, key] as const] : [];
      })),
      previous: new Set([...plan.keys()].flatMap((key) => (previous.has(key) ? [previous.get(key)!] : []))),
    });
  }

  const schedule = () => {
    // The first review's wait runs out once; a later review only settles.
    if (!started && cancelTimer) return;
    cancelTimer?.();
    cancelTimer = setTimer(() => void prerender(), started ? SETTLE_MS : FIRST_DELAY_MS);
  };

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
    async page(fileKey: string): Promise<PageOutcome> {
      const planned = plan.get(fileKey);
      if (!planned) return {ok: false, reason: 'no rendered page for this file'};
      const off = offReason();
      if (off) return {ok: false, reason: off};
      if (planned.request && answers.get(planned.request.key)?.epoch !== epoch) await ask(planned, 0);
      // The review may have moved on while it rendered.
      const latest = plan.get(fileKey);
      if (!latest) return {ok: false, reason: 'no rendered page for this file'};
      const written = await writePage(latest);
      return written.ok ? {...written, url: site.url(written.key)} : written;
    },

    /** Messages for the footer since the last call. */
    takeNotices() {
      return notices.splice(0);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer?.();
      for (const running of asking.values()) running.controller.abort();
      asking.clear();
      backend.dispose();
    },
  };
}

export type RenderedService = ReturnType<typeof createRenderedService>;

/** The service the CLI runs: its own worker, and pages in the session dir. */
export function startRenderedService({tempDir, env, cwd}: {tempDir: () => string; env: NodeJS.ProcessEnv; cwd: string}) {
  return createRenderedService({backend: createRenderedBackend({tempDir, env, cwd}), site: createRenderedSite({tempDir})});
}
