import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import type {DiffRange} from '../src/git.js';
import type {ReviewFile, ReviewModel} from '../src/review/model.js';
import type {EmbeddersRequest, FragmentRequest, FragmentResult, FragmentSummary, LayoutRequest, RenderedBackend, ReviewRequest, ReviewResult} from '../src/rendered/backend.js';
import {GIT_BUDGET_MS} from '../src/rendered/review/build.js';
import {createRenderedService, OPEN_DEADLINE_MS, PRESS_WAIT_MS, REVIEW_ALIAS, startRenderedService, TIPS_BUDGET_MS} from '../src/rendered/service.js';
import type {RunTool} from '../src/rendered/run.js';
import {createSurface, type Surface} from '../src/rendered/surface.js';
import {createRenderedSite} from '../src/rendered/site.js';
import {createRenderedBackend} from '../src/rendered/workerClient.js';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';
import {KITTY_CAPS, pngFixture} from './media-helpers.js';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import {diffFile} from './rendered-helpers.js';

// The rendered service on its own, over a scripted backend and a fake
// clock: which fragments it asks for and in what order, the Review in
// browser page it writes for the whole review, where `r` and `R` open it,
// and what it says when the worker can't answer.

afterEach(cleanupTempDirs);

const RANGE: DiffRange = {base: 'main', branch: 'feature', diffArg: 'main...feature', includeWorktree: false};
const CTX = {cwd: '/repo/project', range: RANGE};

function review(files: ReviewFile[]): ReviewModel {
  return {base: 'main', branch: 'feature', label: 'feature', metrics: {files: files.length, additions: 0, deletions: 0}, files} as unknown as ReviewModel;
}

const edited = (name: string, before = 'One.\n', after = 'One, edited.\n') => diffFile(before, after, name);

function summary(overrides: Partial<FragmentSummary> = {}): FragmentSummary {
  return {kind: 'rendered', changes: {changed: 1, removed: 0}, differences: [], blocks: [], headings: [], links: [], assets: '', ...overrides};
}

type Deferred<T> = {promise: Promise<T>; resolve: (value: T) => void};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

// Answers each fragment from `answer` (at once by default, or held until a
// test lets it go) and each Review in browser page from `page` (by default
// HTML naming the request's key, at once). Records every fragment asked
// for, every fragment moved to another priority, and every page asked for.
function scriptedBackend(
  answer: (request: FragmentRequest) => FragmentResult | Promise<FragmentResult> = () => ({ok: true, summary: summary()}),
  page: (request: ReviewRequest) => ReviewResult | Promise<ReviewResult> = (request) => ({ok: true, html: `<p>${request.key}</p>`}),
) {
  const fragments: Array<{request: FragmentRequest; priority: number | undefined; signal: AbortSignal}> = [];
  const prioritized: Array<{path: string; priority: number}> = [];
  const reviews: ReviewRequest[] = [];
  let off: string | null = null;
  const backend: RenderedBackend = {
    async fragment(request, signal, priority) {
      fragments.push({request, priority, signal});
      if (off) return {ok: false, state: 'unavailable', reason: off};
      return answer(request);
    },
    prioritize(signal, priority) {
      const asked = fragments.find((each) => each.signal === signal);
      if (asked) prioritized.push({path: asked.request.path, priority});
    },
    async review(request): Promise<ReviewResult> {
      reviews.push(request);
      if (off) return {ok: false, state: 'unavailable', reason: off};
      return page(request);
    },
    dispose: () => undefined,
    disabledReason: () => off,
  };
  return {backend, fragments, prioritized, reviews, turnOff: (reason: string) => {
    off = reason;
  }};
}

// A clock the test moves: timers fire as it passes them.
function fakeTimers() {
  let now = 0;
  let timers: Array<{at: number; run: () => void}> = [];
  return {
    now: () => now,
    setTimer(run: () => void, ms: number) {
      const timer = {at: now + ms, run};
      timers.push(timer);
      return () => {
        timers = timers.filter((each) => each !== timer);
      };
    },
    async advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= now).sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        due.run();
      }
      // Let the answers the timers asked for settle.
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function serviceWith(backend: RenderedBackend, clock = fakeTimers(), site?: ReturnType<typeof createRenderedSite>) {
  const session = makeTempDir('branch-review-media-service-');
  const usedSite = site ?? createRenderedSite({tempDir: () => session, now: clock.now});
  const service = createRenderedService({backend, site: usedSite, now: clock.now, setTimer: clock.setTimer});
  return {service, clock, dir: path.join(session, 'rendered')};
}

const pageFiles = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^[0-9a-f]{20}\.html$/.test(name)) : []);
const cardOf = (request: ReviewRequest, file: string) => request.cards.find((card) => card.path === file)!;

describe('the rendered service', () => {
  it('does nothing for a review with no markdown, and waits two seconds after the first review before rendering', async () => {
    const {backend, fragments, reviews} = scriptedBackend();
    const {service, clock, dir} = serviceWith(backend);

    service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts')]), CTX);
    await clock.advance(5_000);
    expect(fragments).toHaveLength(0);
    expect(reviews).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(service.renderable('src/app.ts')).toBe(false);

    service.setReview(review([edited('README.md')]), CTX);
    expect(service.renderable('README.md')).toBe(true);
    await clock.advance(1_999);
    expect(fragments).toHaveLength(0);
    await clock.advance(1);
    expect(fragments.map((each) => each.request.path)).toEqual(['README.md']);
  });

  it('renders the active file first, then its neighbors, then the rest, forty at most', async () => {
    const {backend, fragments} = scriptedBackend();
    const {service, clock} = serviceWith(backend);
    const files = Array.from({length: 45}, (_, index) => edited(`doc-${String(index).padStart(2, '0')}.md`));
    service.setReview(review(files), CTX);
    service.focus('doc-20.md');
    await clock.advance(2_000);

    expect(fragments).toHaveLength(40);
    const byPath = new Map(fragments.map((each) => [each.request.path, each.priority]));
    expect(fragments[0]!.request.path).toBe('doc-20.md');
    expect(byPath.get('doc-20.md')).toBe(0);
    for (const near of ['doc-17.md', 'doc-19.md', 'doc-21.md', 'doc-23.md']) expect(byPath.get(near)).toBe(1);
    expect(byPath.get('doc-24.md')).toBe(2);
    expect(byPath.get('doc-00.md')).toBe(2);
  });

  it('writes the review\'s page once its fragments are back, a card for every file in the review\'s order', async () => {
    const {backend, fragments, reviews} = scriptedBackend();
    const {service, clock, dir} = serviceWith(backend);
    service.setReview(review([edited('README.md'), diffFile('a\n', 'b\n', 'src/app.ts'), edited('docs/guide.md'), diffFile('Old.\n', null, 'docs/old.md')]), CTX);
    await clock.advance(2_000);

    expect(reviews).toHaveLength(1);
    const [request] = reviews;
    expect(request!.cards.map((card) => [card.path, card.kind, card.status])).toEqual([
      ['README.md', 'markdown', 'modified'], ['src/app.ts', 'text', 'modified'], ['docs/guide.md', 'markdown', 'modified'], ['docs/old.md', 'markdown', 'deleted'],
    ]);
    // A markdown card carries the fragment its rich view renders from, as the prerender asked for it.
    expect(cardOf(request!, 'README.md').fragment!.key).toBe(fragments.find((each) => each.request.path === 'README.md')!.request.key);
    expect(cardOf(request!, 'src/app.ts').fragment).toBeUndefined();
    expect(request).toMatchObject({cwd: '/repo/project', refs: {base: 'main', branch: 'feature'}, title: {repo: 'project', base: 'main', branch: 'feature', worktree: false}});
    expect(request!.reviewId).toMatch(/^[0-9a-f]{16}$/);
    // A link to another rendered file names its stable page name, which the page takes to its card.
    const readme = fragments.find((each) => each.request.path === 'README.md')!.request;
    expect(readme.links['docs/guide.md']).toEqual({kind: 'inReview', href: `${cardOf(request!, 'docs/guide.md').alias}.html`});
    // A deleted file has a card, but a link to it is broken on GitHub.
    expect(readme.links['docs/old.md']).toEqual({kind: 'missing'});
    expect(pageFiles(dir)).toEqual([`${request!.key}.html`]);
    expect(fs.readFileSync(path.join(dir, `${REVIEW_ALIAS}.html`), 'utf8')).toBe(`<p>${request!.key}</p>`);

    expect(await service.page()).toEqual({ok: true, key: request!.key, url: `file://${path.join(dir, `${request!.key}.html`)}`});
    expect(reviews).toHaveLength(1);
  });

  it('names each review\'s viewed marks apart: another repo, base or branch gets another id', async () => {
    const ids: string[] = [];
    for (const [cwd, base, branch] of [['/repo/project', 'main', 'feature'], ['/repo/project', 'main', 'feature'], ['/repo/other', 'main', 'feature'], ['/repo/project', 'develop', 'feature'], ['/repo/project', 'main', 'fix']] as const) {
      const {backend, reviews} = scriptedBackend();
      const {service} = serviceWith(backend);
      service.setReview({...review([diffFile('a\n', 'b\n', 'src/app.ts')]), branch} as ReviewModel, {cwd, range: {...RANGE, base, branch}});
      await service.page();
      ids.push(reviews[0]!.reviewId);
    }
    expect(ids[1]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(4);
  });

  it('waits for a watch refresh to settle, asks every fragment again, and writes the page again only when a card changed', async () => {
    const {backend, fragments, reviews} = scriptedBackend((request) => ({ok: true, summary: summary({assets: request.path === 'README.md' && request.assets.epoch > 2 ? 'new-logo' : ''})}));
    const {service, clock, dir} = serviceWith(backend);
    const files = [edited('README.md'), edited('docs/guide.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    expect(reviews).toHaveLength(1);

    // The same files again: the worker checks each one's images, and nothing changed.
    service.setReview(review(files), CTX);
    await clock.advance(249);
    expect(fragments).toHaveLength(2);
    await clock.advance(1);
    expect(fragments).toHaveLength(4);
    expect(reviews).toHaveLength(1);

    // An image README.md embeds changed: a new page, and the old one stays as the one before.
    service.setReview(review(files), CTX);
    await clock.advance(250);
    expect(reviews).toHaveLength(2);
    expect(reviews[1]!.key).not.toBe(reviews[0]!.key);
    expect(pageFiles(dir).sort()).toEqual([`${reviews[0]!.key}.html`, `${reviews[1]!.key}.html`].sort());
  });

  it('keeps the newest page and the one before it, and drops older pages nobody opened', async () => {
    const {backend, reviews} = scriptedBackend((request) => ({ok: true, summary: summary({assets: `logo-${request.assets.epoch}`})}));
    const {service, clock, dir} = serviceWith(backend);
    const files = [edited('README.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    for (let refresh = 0; refresh < 2; refresh += 1) {
      service.setReview(review(files), CTX);
      await clock.advance(250);
    }
    expect(reviews).toHaveLength(3);
    // Written in the background, never shown: the first page goes at once.
    expect(pageFiles(dir).sort()).toEqual([`${reviews[1]!.key}.html`, `${reviews[2]!.key}.html`].sort());

    // A page someone opened stays for two minutes after it was shown.
    const opened = await service.page();
    service.setReview(review(files), CTX);
    await clock.advance(250);
    service.setReview(review(files), CTX);
    await clock.advance(250);
    expect(pageFiles(dir)).toContain(`${opened.ok && opened.key}.html`);
    expect(pageFiles(dir)).toHaveLength(3);
  });

  it('drops work for files that left the review, and renders the rest again under their new links', async () => {
    const answers = new Map<string, Deferred<FragmentResult>>();
    const {backend, fragments} = scriptedBackend((request) => {
      const held = deferred<FragmentResult>();
      answers.set(request.path, held);
      return held.promise;
    });
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md'), edited('gone.md')]), CTX);
    await clock.advance(2_000);
    const before = fragments.find((each) => each.request.path === 'README.md')!.request;
    service.setReview(review([edited('README.md')]), CTX);
    expect(fragments.find((each) => each.request.path === 'gone.md')!.signal.aborted).toBe(true);
    expect(service.renderable('gone.md')).toBe(false);
    // README.md's link to gone.md now goes nowhere, so its fragment is another.
    await clock.advance(250);
    const after = fragments.at(-1)!.request;
    expect(after.path).toBe('README.md');
    expect(after.key).not.toBe(before.key);
    expect(after.links).not.toHaveProperty('gone.md');
  });

  it('sends the page only the fragments the review rendered, and renders the rest once a press asks for the whole page', async () => {
    const {backend, fragments, reviews} = scriptedBackend();
    const {service, clock, trip} = openingService(backend);
    const files = Array.from({length: 42}, (_, index) => edited(`doc-${String(index).padStart(2, '0')}.md`));
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    expect(reviews[0]!.cards).toHaveLength(42);
    // The two past the prerender limit aren't rendered in the page's job, which has its own deadline.
    expect(reviews[0]!.cards.filter((card) => card.fragment === undefined).map((card) => card.path)).toEqual(['doc-40.md', 'doc-41.md']);
    // The links every fragment shares ride once with the page, not with each card.
    expect(reviews[0]!.links['doc-41.md']).toMatchObject({kind: 'inReview'});
    expect(reviews[0]!.cards[0]!.fragment).not.toHaveProperty('links');
    expect(reviews[0]!.cards[0]!.fragment).not.toHaveProperty('assets');

    await service.openOverview(trip);
    expect(fragments).toHaveLength(42);
    expect(reviews.at(-1)!.cards.every((card) => card.fragment !== undefined)).toBe(true);
  });

  it('gives a file whose render timed out a card saying so, and never sends it with the page to render again', async () => {
    const {backend, reviews} = scriptedBackend((request) => (request.path === 'slow.md' ? {ok: false, state: 'error', reason: 'timed out'} : {ok: true, summary: summary()}));
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md'), edited('slow.md')]), CTX);
    await clock.advance(2_000);
    const slow = cardOf(reviews[0]!, 'slow.md');
    expect(slow.renderFailure).toBe('timed out');
    expect(slow.fragment).toBeUndefined();
    expect(cardOf(reviews[0]!, 'README.md').fragment).toBeDefined();
  });

  it('says the rendered view is off once, and refuses pages with the reason', async () => {
    const {backend, turnOff} = scriptedBackend();
    const {service, clock} = serviceWith(backend);
    turnOff('Preview and Review in browser turned off: timed out');
    service.setReview(review([edited('README.md')]), CTX);
    await clock.advance(2_000);
    expect(await service.page()).toEqual({ok: false, reason: 'Preview and Review in browser turned off: timed out'});
    expect(service.takeNotices()).toEqual(['✗ Preview and Review in browser turned off: timed out']);
    await service.page();
    expect(service.takeNotices()).toEqual([]);
  });

  it('moves a fragment already queued to the front when its file gets the focus', async () => {
    const {backend, fragments, prioritized} = scriptedBackend(() => new Promise<FragmentResult>(() => undefined));
    const {service, clock} = serviceWith(backend);
    const files = Array.from({length: 30}, (_, index) => edited(`doc-${String(index).padStart(2, '0')}.md`));
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    expect(fragments.find((each) => each.request.path === 'doc-29.md')!.priority).toBe(2);

    service.focus('doc-15.md');
    expect([...prioritized].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      {path: 'doc-12.md', priority: 1}, {path: 'doc-13.md', priority: 1}, {path: 'doc-14.md', priority: 1},
      {path: 'doc-15.md', priority: 0},
      {path: 'doc-16.md', priority: 1}, {path: 'doc-17.md', priority: 1}, {path: 'doc-18.md', priority: 1},
    ]);
    // Moved, not asked again.
    expect(fragments).toHaveLength(30);
  });

  it('says the rendered view is off when the worker turns off on a fragment of the prerender', async () => {
    let asked = 0;
    const scripted = scriptedBackend(() => {
      asked += 1;
      if (asked < 3) return {ok: false, state: 'error', reason: 'timed out'};
      scripted.turnOff('Preview and Review in browser turned off: timed out');
      return {ok: false, state: 'error', reason: 'timed out'};
    });
    const {service, clock} = serviceWith(scripted.backend);
    service.setReview(review([edited('a.md'), edited('b.md'), edited('c.md')]), CTX);
    await clock.advance(2_000);
    expect(service.takeNotices()).toEqual(['✗ Preview and Review in browser turned off: timed out']);
    expect(scripted.reviews).toHaveLength(0);
  });

  it('keeps the newest review\'s page the newest when an older review\'s write lands last', async () => {
    const held: Array<Deferred<ReviewResult>> = [];
    const {backend, reviews} = scriptedBackend(
      (request) => ({ok: true, summary: summary({assets: `logo-${request.assets.epoch}`})}),
      () => {
        const answer = deferred<ReviewResult>();
        held.push(answer);
        return answer.promise;
      },
    );
    const {service, clock, dir} = serviceWith(backend);
    const files = [edited('README.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    service.setReview(review(files), CTX);
    await clock.advance(250);
    expect(reviews).toHaveLength(2);
    const [older, newer] = reviews;
    // The newer review's page comes back first, then the older one's.
    held[1]!.resolve({ok: true, html: `<p>${newer!.key}</p>`});
    await clock.advance(0);
    held[0]!.resolve({ok: true, html: `<p>${older!.key}</p>`});
    await clock.advance(0);

    expect(fs.readFileSync(path.join(dir, `${REVIEW_ALIAS}.html`), 'utf8')).toBe(`<p>${newer!.key}</p>`);
    expect(await service.page()).toMatchObject({ok: true, key: newer!.key});
  });

  it('sends a file whose render timed out to the worker once, however many refreshes follow', async () => {
    const {backend, fragments} = scriptedBackend((request) => (request.path === 'hang.md' ? {ok: false, state: 'error', reason: 'timed out'} : {ok: true, summary: summary()}));
    const {service, clock} = serviceWith(backend);
    const files = [edited('hang.md'), edited('answer.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    for (let refresh = 0; refresh < 3; refresh += 1) {
      service.setReview(review(files), CTX);
      await clock.advance(250);
    }
    expect(fragments.filter((each) => each.request.path === 'hang.md')).toHaveLength(1);
    expect(fragments.filter((each) => each.request.path === 'answer.md')).toHaveLength(4);
  });

  it('reads no patch of a review with no markdown, and a review\'s patches only once its first fragment is sent', async () => {
    const {backend} = scriptedBackend();
    const {service, clock} = serviceWith(backend);
    let reads = 0;
    const counted = (file: ReviewFile): ReviewFile => {
      const {rawDiff} = file;
      return Object.defineProperty({...file}, 'rawDiff', {get: () => {
        reads += 1;
        return rawDiff;
      }}) as ReviewFile;
    };
    const worktree = {...CTX, range: {...RANGE, includeWorktree: true}};
    service.setReview(review([counted(diffFile('a\n', 'b\n', 'src/app.ts'))]), worktree);
    await clock.advance(5_000);
    expect(reads).toBe(0);

    service.setReview(review([counted(diffFile('a\n', 'b\n', 'src/app.ts')), edited('README.md')]), worktree);
    const planned = reads;
    await clock.advance(2_000);
    expect(reads).toBeGreaterThan(planned);
  });

  it('refuses a page it could not write, with the reason', async () => {
    const {backend} = scriptedBackend();
    const session = makeTempDir('branch-review-media-full-');
    fs.writeFileSync(path.join(session, 'rendered'), '');
    const clock = fakeTimers();
    const {service} = serviceWith(backend, clock, createRenderedSite({tempDir: () => session, now: clock.now}));
    service.setReview(review([edited('README.md')]), CTX);
    expect(await service.page()).toEqual({ok: false, reason: "can't write the page: not a directory"});
  });

  it('carries each card\'s part of the link report: the links its rich view draws broken', async () => {
    const guideLinks = [{href: 'README.md#nope', status: 'ok' as const, line: 4, ref: {path: 'README.md', anchor: 'user-content-nope', index: 0}}];
    const {backend, reviews} = scriptedBackend((request) => ({ok: true, summary: summary(request.path === 'README.md' ? {links: [], anchors: ['user-content-readme']} : {links: guideLinks, anchors: []})}));
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    expect(cardOf(reviews.at(-1)!, 'docs/guide.md').brokenRefs).toEqual([0]);
    expect(cardOf(reviews.at(-1)!, 'README.md').brokenRefs).toBeUndefined();
  });

  it('gives an image its card from its own fragment, which reads its two sides', async () => {
    const {backend, fragments, reviews} = scriptedBackend((request) => ({ok: true, summary: request.kind ? summary({kind: 'image', changes: {changed: 0, removed: 0}}) : summary()}));
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md'), imageFile(pngFixture(3, 2), pngFixture(4, 5), 'docs/hero.png')]), CTX);
    expect(service.renderable('docs/hero.png')).toBe(true);
    await clock.advance(2_000);
    expect(fragments.find((each) => each.request.path === 'docs/hero.png')!.request).toMatchObject({kind: 'raster', groups: []});
    expect(cardOf(reviews[0]!, 'docs/hero.png')).toMatchObject({kind: 'raster', fragment: {kind: 'raster'}, special: {kind: 'binary'}});
  });
});

const CRASHING_WORKER = fileURLToPath(new URL('./fixtures/crashing-rendered-worker.mjs', import.meta.url));

// The service with a surface that records what it was asked to show and a
// motion the test picks. `cross` records the crossing the TUI was asked to
// play, which ends a turn of the event loop later, as a real one ends
// 320 ms after it starts. `live`: watch mode, on here unless a test says.
// `tips`: the refs the commits are read from, as git would say them.
function openingService(backend: RenderedBackend, {
  surface = recordingSurface(),
  motion = 'full' as const,
  site,
  animations,
  live = true,
  tips,
}: {surface?: ReturnType<typeof recordingSurface>; motion?: 'full' | 'reduced' | 'off'; site?: ReturnType<typeof createRenderedSite>; animations?: boolean; live?: boolean; tips?: () => string | null | Promise<string | null>} = {}) {
  const clock = fakeTimers();
  const session = makeTempDir('branch-review-open-');
  const usedSite = site ?? createRenderedSite({tempDir: () => session, now: clock.now});
  let motionAsked = 0;
  const service = createRenderedService({
    backend,
    site: usedSite,
    now: clock.now,
    setTimer: clock.setTimer,
    surface,
    motion: async () => {
      motionAsked += 1;
      return motion;
    },
    ...(animations !== undefined ? {animations} : {}),
    live,
    ...(tips ? {tips: async () => tips()} : {}),
  });
  const events: string[] = [];
  const trip = {
    cross: async (kind: string) => {
      events.push(`cross ${kind}`);
      await new Promise((resolve) => setImmediate(resolve));
    },
    waiting: (message: string) => events.push(`waiting ${message}`),
  };
  return {service, clock, surface, trip, events, dir: path.join(session, 'rendered'), motionAsked: () => motionAsked};
}

function recordingSurface({kind = 'cmux' as 'cmux' | 'browser' | 'none', refusal = null as string | null, answer = {where: 'cmux-new', message: 'opened in the browser split'} as Awaited<ReturnType<Surface['show']>>, refreshes = true as boolean | 'skipped' | 'superseded', opensSplit = undefined as (() => boolean) | undefined} = {}) {
  const shown: string[] = [];
  const refreshed: string[] = [];
  // The page names each refresh said the split may show.
  const showing: Array<readonly string[] | undefined> = [];
  const disposed = {count: 0};
  return {
    ...(opensSplit ? {opensSplit} : {}),
    kind,
    refusal,
    destination: kind === 'cmux' ? 'in a browser split' : kind === 'browser' ? 'in your browser' : null,
    shown,
    refreshed,
    showing,
    disposed,
    async show(url: string) {
      shown.push(url);
      return answer;
    },
    // A live refresh sends the split it opened to `url`; false once it can't.
    // Nothing is ever in flight here, so a `url` to work out is sent at once.
    async refresh(url: string | (() => string), names?: readonly string[]) {
      refreshed.push(typeof url === 'string' ? url : url());
      showing.push(names);
      return refreshes;
    },
    dispose() {
      disposed.count += 1;
    },
  };
}

const hashOf = (url: string) => url.slice(url.indexOf('#') + 1);

describe('opening the page', () => {
  it('shows the page at the file\'s card after the crossing, and says where it opened, the same way each time', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface, trip, events, dir} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);

    const outcome = await service.open({fileKey: 'docs/guide.md'}, trip);
    expect(outcome).toEqual({kind: 'info', message: '⇗ guide.md opened in the browser split'});
    expect(events).toEqual(['cross full']);
    expect(surface.shown).toHaveLength(1);
    const shown = new URL(surface.shown[0]!).pathname;
    expect(fs.realpathSync(path.dirname(shown))).toBe(fs.realpathSync(dir));
    expect(fs.readFileSync(shown, 'utf8')).toMatch(/^<p>[0-9a-f]{20}<\/p>$/);
    expect(hashOf(surface.shown[0]!)).toBe('file-1&m=1&n=1');

    expect(await service.open({fileKey: 'docs/guide.md'}, trip)).toEqual({kind: 'info', message: '⇗ guide.md opened in the browser split'});
    // The same page, at the same card, with a new count, so an open split hears it.
    expect(surface.shown[1]).toBe(`${surface.shown[0]!.split('#')[0]}#file-1&m=1&n=2`);
  });

  it('opens a code file at its card too, writing the page when no prerender ran', async () => {
    const {backend, reviews} = scriptedBackend();
    const {service, surface, trip} = openingService(backend);
    service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts'), diffFile('c\n', 'd\n', 'src/lib.ts')]), CTX);
    expect(await service.open({fileKey: 'src/lib.ts'}, trip)).toEqual({kind: 'info', message: '⇗ lib.ts opened in the browser split'});
    expect(reviews).toHaveLength(1);
    expect(hashOf(surface.shown[0]!)).toBe('file-1&m=1&n=1');
  });

  it('opens at the top for R, and sends m=0 with --no-animations', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface, trip} = openingService(backend, {animations: false});
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    expect(await service.openOverview(trip)).toEqual({kind: 'info', message: '⇗ all files opened in the browser split'});
    await service.open({fileKey: 'README.md'}, trip);
    expect(surface.shown.map(hashOf)).toEqual(['top&m=0&n=1', 'file-0&m=0&n=2']);
    // One page for both: R and r differ only in where it opens.
    expect(new Set(surface.shown.map((url) => url.split('#')[0])).size).toBe(1);
  });

  it('throws nothing toward a page that will not open', async () => {
    const {backend, turnOff} = scriptedBackend();
    const nothing = openingService(backend);
    nothing.service.setReview(review([]), CTX);
    expect(await nothing.service.open({fileKey: 'src/app.ts'}, nothing.trip)).toEqual({kind: 'info', message: 'nothing to open in the browser · no files changed on this branch'});
    expect(await nothing.service.openOverview(nothing.trip)).toEqual({kind: 'info', message: 'nothing to open in the browser · no files changed on this branch'});

    const refusal = "open isn't available over SSH · branch-review --export-html <dir> writes the pages";
    const ssh = openingService(backend, {surface: recordingSurface({kind: 'none', refusal})});
    ssh.service.setReview(review([edited('README.md')]), CTX);
    expect(await ssh.service.open({fileKey: 'README.md'}, ssh.trip)).toEqual({kind: 'error', message: refusal});
    expect(await ssh.service.openOverview(ssh.trip)).toEqual({kind: 'error', message: refusal});

    const off = openingService(backend);
    off.service.setReview(review([edited('README.md')]), CTX);
    turnOff('Preview and Review in browser turned off: the worker kept crashing');
    expect(await off.service.open({fileKey: 'README.md'}, off.trip)).toEqual({kind: 'error', message: 'Preview and Review in browser turned off: the worker kept crashing'});

    for (const each of [nothing, ssh, off]) {
      expect(each.events).toEqual([]);
      expect(each.surface.shown).toEqual([]);
    }
    expect(fs.existsSync(ssh.dir)).toBe(false);
  });

  it('says the page is on its way when it is not ready by the end of the crossing, then opens it', async () => {
    const held = deferred<ReviewResult>();
    const {backend} = scriptedBackend(undefined, () => held.promise);
    const {service, surface, trip, events} = openingService(backend);
    service.setReview(review([edited('docs/slow.md')]), CTX);
    const opening = service.open({fileKey: 'docs/slow.md'}, trip);
    for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['cross full', 'waiting preparing slow.md…']);
    expect(surface.shown).toEqual([]);
    held.resolve({ok: true, html: '<p>slow</p>'});
    expect(await opening).toMatchObject({kind: 'info', message: expect.stringMatching(/^⇗ slow\.md opened in the browser split/)});
    expect(surface.shown).toHaveLength(1);
  });

  it('gives up after 10 s with an error, and opens nothing late', async () => {
    const held = deferred<ReviewResult>();
    const {backend} = scriptedBackend(undefined, () => held.promise);
    const {service, clock, surface, trip, dir} = openingService(backend);
    service.setReview(review([edited('docs/stuck.md')]), CTX);
    const opening = service.open({fileKey: 'docs/stuck.md'}, trip);
    await clock.advance(9_999);
    await clock.advance(1);
    expect(await opening).toEqual({kind: 'error', message: 'stuck.md took too long to prepare'});
    // The page arrives after all, and is written: it still opens nowhere,
    // since the footer already said it wouldn't.
    held.resolve({ok: true, html: '<p>late</p>'});
    await clock.advance(0);
    expect(pageFiles(dir)).toHaveLength(1);
    expect(surface.shown).toEqual([]);
  });

  it('opens within the deadline when git and the refs never answer and the markdown renders slowly, saying the branch state is unknown', async () => {
    // The worker's build waits out git's budget, then answers with the page
    // that says git didn't say, as partial.
    let clock!: ReturnType<typeof fakeTimers>;
    const {backend, reviews} = scriptedBackend(() => new Promise(() => undefined), (request) => new Promise((resolve) => {
      clock.setTimer(() => resolve({ok: true, html: `<p>${request.key} Branch state unavailable</p>`, partial: true}), GIT_BUDGET_MS);
    }));
    const opened = openingService(backend, {tips: () => new Promise(() => undefined)});
    ({clock} = opened);
    const {service, surface, trip} = opened;
    service.setReview(review([edited('README.md'), diffFile('a\n', 'b\n', 'src/app.ts')]), CTX);
    const opening = service.open({fileKey: 'src/app.ts'}, trip);
    let outcome: Awaited<typeof opening> | undefined;
    void opening.then((value) => {
      outcome = value;
    });
    for (let at = 0; at < OPEN_DEADLINE_MS - 500 && outcome === undefined; at += 100) await clock.advance(100);
    expect(outcome).toEqual({kind: 'info', message: '⇗ app.ts opened in the browser split'});
    expect(reviews).toHaveLength(1);
    expect(fs.readFileSync(new URL(surface.shown[0]!).pathname, 'utf8')).toContain('Branch state unavailable');
    // The refs are read beside the press's wait, so its worst case fits with room for the worker to start.
    expect(Math.max(PRESS_WAIT_MS, TIPS_BUDGET_MS) + GIT_BUDGET_MS + 1_000).toBeLessThanOrEqual(OPEN_DEADLINE_MS);
  });

  it('names the card by its place on the page the press wrote, though a file came into the review while it waited', async () => {
    const held = deferred<FragmentResult>();
    const {backend} = scriptedBackend(() => held.promise);
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    const opening = service.open({fileKey: 'docs/guide.md'}, trip);
    await clock.advance(0);
    // An agent adds a file that sorts first while the press waits for its render.
    service.setReview(review([edited('CHANGELOG.md'), edited('README.md'), edited('docs/guide.md')]), CTX);
    let outcome: Awaited<typeof opening> | undefined;
    void opening.then((value) => {
      outcome = value;
    });
    for (let at = 0; at < OPEN_DEADLINE_MS - 500 && outcome === undefined; at += 100) await clock.advance(100);
    expect(outcome).toEqual({kind: 'info', message: '⇗ guide.md opened in the browser split'});
    expect(hashOf(surface.shown[0]!)).toBe('file-2&m=1&n=1');
  });

  it('says why a page could not be written, and why the surface refused it', async () => {
    const {backend} = scriptedBackend();
    const clock = fakeTimers();
    const session = makeTempDir('branch-review-open-full-');
    const site = createRenderedSite({tempDir: () => session, now: clock.now});
    site.write = () => {
      throw new Error("can't write the page: disk full");
    };
    const full = openingService(backend, {site});
    full.service.setReview(review([edited('README.md')]), CTX);
    expect(await full.service.open({fileKey: 'README.md'}, full.trip)).toEqual({kind: 'error', message: "can't write the page: disk full"});

    const none = openingService(backend, {surface: recordingSurface({answer: {refused: 'no browser opener found · branch-review --export-html <dir> writes the pages'}})});
    none.service.setReview(review([edited('README.md')]), CTX);
    expect(await none.service.open({fileKey: 'README.md'}, none.trip)).toEqual({kind: 'error', message: 'no browser opener found · branch-review --export-html <dir> writes the pages'});
  });

  it('says what the worker answered when it could not make the page', async () => {
    const {backend} = scriptedBackend(undefined, () => ({ok: false, state: 'error', reason: 'renderer crashed\n    at somewhere'}));
    const {service, trip, surface} = openingService(backend);
    service.setReview(review([edited('README.md')]), CTX);
    expect(await service.open({fileKey: 'README.md'}, trip)).toEqual({kind: 'error', message: 'renderer crashed'});
    expect(surface.shown).toEqual([]);
  });

  it('says nothing for a press a newer one replaced, and reads the motion setting once', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, trip, motionAsked} = openingService(backend, {surface: recordingSurface({answer: {superseded: true}})});
    service.setReview(review([edited('README.md')]), CTX);
    await clock.advance(2_000);
    expect(await service.open({fileKey: 'README.md'}, trip)).toBeNull();
    await service.open({fileKey: 'README.md'}, trip);
    await service.openOverview(trip);
    expect(motionAsked()).toBe(1);
  });

  it('escapes hidden characters in the names it says', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, trip} = openingService(backend);
    service.setReview(review([edited('docs/evil‮gnp.md')]), CTX);
    await clock.advance(2_000);
    const outcome = await service.open({fileKey: 'docs/evil‮gnp.md'}, trip);
    expect(outcome!.message).toContain('evil<U+202E>gnp.md');
    expect(outcome!.message).not.toContain('‮');
  });

  it('places the page on the surface while the crossing plays, and toasts once it ends', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface} = openingService(backend);
    service.setReview(review([edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    const crossing = deferred<void>();
    const events: string[] = [];
    const trip = {
      cross: async () => {
        events.push('cross starts');
        await crossing.promise;
        events.push(`cross ends, shown ${surface.shown.length}`);
      },
      waiting: () => undefined,
    };
    let toast: unknown = null;
    const opening = service.open({fileKey: 'docs/guide.md'}, trip).then((outcome) => {
      toast = outcome;
      return outcome;
    });
    await clock.advance(0);
    // The split opens under the beam: cmux is asked before the crossing ends.
    expect(surface.shown).toHaveLength(1);
    expect(toast).toBeNull();
    crossing.resolve();
    expect(await opening).toMatchObject({kind: 'info', message: expect.stringMatching(/^⇗ guide\.md opened in the browser split/)});
    expect(events).toEqual(['cross starts', 'cross ends, shown 1']);
  });

  it('never shows an older press\'s card over a newer one, however late the page lands', async () => {
    const held = deferred<ReviewResult>();
    const {backend} = scriptedBackend(undefined, () => held.promise);
    const {service, surface, trip, events} = openingService(backend);
    service.setReview(review([edited('docs/slow.md'), edited('docs/fast.md')]), CTX);
    const older = service.open({fileKey: 'docs/slow.md'}, trip);
    const newer = service.open({fileKey: 'docs/fast.md'}, trip);
    for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    held.resolve({ok: true, html: '<p>both</p>'});
    expect(await newer).toMatchObject({kind: 'info', message: expect.stringMatching(/^⇗ fast\.md opened in the browser split/)});
    expect(await older).toBeNull();
    expect(surface.shown.map(hashOf)).toEqual(['file-1&m=1&n=2']);
    // Nor does the older press say it is still on its way once a newer one took its place.
    expect(events.filter((event) => event.startsWith('waiting'))).toEqual(['waiting preparing fast.md…']);
  });

  it('asks the worker for no fragment again on R once this review\'s are in, and writes the page once', async () => {
    const {backend, fragments, reviews} = scriptedBackend();
    const {service, clock, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/a.md'), edited('docs/b.md')]), CTX);
    await clock.advance(2_000);
    expect(fragments).toHaveLength(3);
    await service.openOverview(trip);
    await service.openOverview(trip);
    await clock.advance(0);
    expect(fragments).toHaveLength(3);
    expect(reviews).toHaveLength(1);
    // A new review asks again.
    service.setReview(review([edited('README.md'), edited('docs/a.md'), edited('docs/b.md')]), CTX);
    await clock.advance(250);
    expect(fragments).toHaveLength(6);
  });

  it('opens on R after a moment with a slow render drawn on its way, and writes the page again once it lands', async () => {
    const held = deferred<FragmentResult>();
    const {backend, reviews} = scriptedBackend((request) => (request.path === 'docs/cold.md' ? held.promise : {ok: true, summary: summary()}));
    const {service, clock, trip, surface} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/cold.md')]), CTX);
    await clock.advance(2_000);
    const opening = service.openOverview(trip);
    await clock.advance(2_499);
    expect(surface.shown).toEqual([]);
    await clock.advance(1);
    expect(await opening).toMatchObject({kind: 'info', message: '⇗ all files opened in the browser split'});
    expect(cardOf(reviews.at(-1)!, 'docs/cold.md').fragment).toBeUndefined();
    expect(cardOf(reviews.at(-1)!, 'README.md').fragment).toBeDefined();
    held.resolve({ok: true, summary: summary()});
    await clock.advance(0);
    expect(cardOf(reviews.at(-1)!, 'docs/cold.md').fragment).toBeDefined();
    const written = await service.page();
    expect(written.ok && surface.shown[0]!.startsWith(written.url)).toBe(false);
  });

  it('asks again for a render whose image lookups ran out of time before it writes the page', async () => {
    let readme = 0;
    const {backend, fragments, reviews} = scriptedBackend((request) => {
      if (request.path !== 'README.md') return {ok: true, summary: summary()};
      readme += 1;
      return {ok: true, summary: readme === 1 ? summary({changes: {changed: 13, removed: 0}, assets: 'late', late: true}) : summary({changes: {changed: 14, removed: 0}, assets: 'with-image'})};
    });
    const {service, clock} = openingService(backend);
    service.setReview(review([edited('docs/guide.md'), edited('README.md'), edited('docs/new-api.md')]), CTX);
    await clock.advance(2_000);
    expect(fragments.filter((each) => each.request.path === 'README.md')).toHaveLength(2);
    expect(reviews).toHaveLength(1);
  });

  it('writes the page again once the files rendered after a press that came before them', async () => {
    const held = deferred<FragmentResult>();
    const guideLinks = [{href: 'README.md#nope', status: 'ok' as const, line: 4, ref: {path: 'README.md', anchor: 'user-content-nope', index: 0}}];
    const {backend, reviews} = scriptedBackend((request) => (request.path === 'docs/guide.md' ? held.promise : {ok: true, summary: summary({anchors: []})}));
    const {service, clock, trip, surface} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    // `r` in the first two seconds, before the background pass, which the
    // press starts now and waits a moment for.
    const opening = service.open({fileKey: 'README.md'}, trip);
    await clock.advance(2_500);
    await opening;
    expect(cardOf(reviews[0]!, 'docs/guide.md').brokenRefs).toBeUndefined();
    held.resolve({ok: true, summary: summary({links: guideLinks, anchors: []})});
    await clock.advance(0);
    // The guide's render found a broken link: the page draws it now.
    expect(cardOf(reviews.at(-1)!, 'docs/guide.md').brokenRefs).toEqual([0]);
    await service.open({fileKey: 'README.md'}, trip);
    expect(surface.shown[1]!.split('#')[0]).not.toBe(surface.shown[0]!.split('#')[0]);
  });

  it('keeps the home dir and stack lines of a crashing worker out of every toast, notice and page', async () => {
    const session = makeTempDir('branch-review-open-crash-');
    const backend = createRenderedBackend({tempDir: () => session, cwd: session, modulePath: CRASHING_WORKER, backoffMs: [10, 10, 10]});
    try {
      const site = createRenderedSite({tempDir: () => session});
      const {service, trip, clock} = openingService(backend, {site});
      const files = [edited('README.md'), edited('docs/guide.md')];
      service.setReview(review(files), CTX);
      // The prerender's two fragments crash the worker twice; the page
      // says why on each card.
      await clock.advance(2_000);
      for (let turn = 0; turn < 50 && !fs.existsSync(path.join(session, 'rendered')); turn += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      const said = [await service.open({fileKey: 'README.md'}, trip), await service.openOverview(trip)];
      // Each edit asks again, and the third crash in a minute turns the view off.
      for (let edit = 1; edit <= 4 && !backend.disabledReason(); edit += 1) {
        service.setReview(review([edited('README.md', 'One.\n', `One, edited ${edit} more times.\n`), edited('docs/guide.md')]), CTX);
        await clock.advance(250);
        for (let turn = 0; turn < 50 && !backend.disabledReason() && fs.readdirSync(path.join(session, 'rendered')).length < edit + 2; turn += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      said.push(await service.open({fileKey: 'README.md'}, trip));
      const notices = service.takeNotices();
      const dir = path.join(session, 'rendered');
      const written = fs.readdirSync(dir).filter((name) => name.endsWith('.html')).map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));

      // Every place a reason shows was reached.
      expect(said.at(-1)).toMatchObject({kind: 'error', message: expect.stringMatching(/^Preview and Review in browser turned off: page worker exited \(code 1\): Error: ENOENT/)});
      expect(notices).toEqual([`✗ ${said.at(-1)!.message}`]);
      expect(written.some((html) => html.includes('page worker exited'))).toBe(true);
      for (const text of [...said.map((outcome) => JSON.stringify(outcome)), ...notices, ...written]) {
        expect(text).not.toContain(os.homedir());
        expect(text).not.toMatch(/\/Users\/|\/home\/| {4}at /);
      }
      expect(said.at(-1)!.message).toContain("open '~/Projects/secret/notes.md'");
    } finally {
      backend.dispose();
    }
  }, 30_000);

  it('places nothing once disposed, and stops the surface', async () => {
    const held = deferred<ReviewResult>();
    const {backend} = scriptedBackend(undefined, () => held.promise);
    const {service, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md')]), CTX);
    const opening = service.open({fileKey: 'README.md'}, trip);
    await new Promise((resolve) => setImmediate(resolve));
    // `q` while the page is made: the session dir is about to go.
    service.dispose();
    expect(surface.disposed.count).toBe(1);
    held.resolve({ok: true, html: '<p>late</p>'});
    expect(await opening).toBeNull();
    expect(surface.shown).toEqual([]);
  });

  it('says in plain words where the button opens the page, for its hover tip', () => {
    const {backend} = scriptedBackend();
    expect(openingService(backend).service.openHint()).toBe("Open this file's changes in a browser split, as GitHub shows them");
    expect(openingService(backend, {surface: recordingSurface({kind: 'browser'})}).service.openHint()).toBe("Open this file's changes in your browser, as GitHub shows them");
    expect(openingService(backend, {surface: recordingSurface({kind: 'none', refusal: "open isn't available over SSH · branch-review --export-html <dir> writes the pages"})}).service.openHint())
      .toBe("open isn't available over SSH");
  });

  it('tells its listeners when it has something to say', async () => {
    const {backend, turnOff} = scriptedBackend();
    const {service, clock} = openingService(backend);
    let heard = 0;
    const stop = service.subscribe(() => {
      heard += 1;
    });
    const before = service.getVersion();
    service.setReview(review([edited('README.md')]), CTX);
    turnOff('Preview and Review in browser turned off: the worker kept crashing');
    await clock.advance(2_000);
    expect(heard).toBeGreaterThan(0);
    expect(service.getVersion()).not.toBe(before);
    expect(service.takeNotices()).toEqual(['✗ Preview and Review in browser turned off: the worker kept crashing']);
    stop();
  });
});

describe('the page on disk and the refs it is read from', () => {
  it('writes a new page after a push or an amend, which move the refs the commits and the state are read from', async () => {
    let tips: string | null = 'base0 tip0 -';
    const {backend, reviews} = scriptedBackend();
    const {service, clock} = openingService(backend, {tips: () => tips});
    service.setReview(review([edited('README.md')]), CTX);
    await clock.advance(2_000);
    const first = await service.page();
    expect(await service.page()).toEqual(first);
    // A push: the upstream names the tip now.
    tips = 'base0 tip0 tip0';
    const pushed = await service.page();
    // An amend: a new tip.
    tips = 'base0 tip1 tip0';
    const amended = await service.page();
    expect(new Set([first, pushed, amended].map((outcome) => outcome.ok && outcome.key)).size).toBe(3);
    expect(reviews).toHaveLength(3);
    // Git didn't say in time: a page that says so, written again once it does.
    tips = null;
    const unread = await service.page();
    tips = 'base0 tip1 tip0';
    expect(await service.page()).toMatchObject({ok: true, key: amended.ok && amended.key});
    expect(unread.ok && unread.key).not.toBe(amended.ok && amended.key);
  });

  it('never shows a partial page again: the next press writes it anew, and so does a pass a moment after', async () => {
    let partial = true;
    const {backend, reviews} = scriptedBackend(undefined, (request) => ({ok: true, html: `<p>${request.key}</p>`, ...(partial ? {partial: true as const} : {})}));
    const {service, clock, surface, trip, dir} = openingService(backend, {live: false});
    service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts')]), CTX);
    await service.open({fileKey: 'src/app.ts'}, trip);
    await service.open({fileKey: 'src/app.ts'}, trip);
    expect(reviews).toHaveLength(2);
    const [first, second] = surface.shown.map((url) => new URL(url).pathname);
    expect(first).not.toBe(second);
    // A moment later the page is written again for the next press.
    partial = false;
    await clock.advance(1_000);
    expect(reviews).toHaveLength(3);
    await service.open({fileKey: 'src/app.ts'}, trip);
    await service.open({fileKey: 'src/app.ts'}, trip);
    expect(reviews).toHaveLength(3);
    expect(new URL(surface.shown[3]!).pathname).toBe(new URL(surface.shown[2]!).pathname);
    expect(pageFiles(dir).length).toBeLessThanOrEqual(3);
    // At most a few follow-ups for one review, however often its page comes back partial.
    partial = true;
    service.setReview(review([diffFile('a\n', 'c\n', 'src/app.ts')]), CTX);
    await service.page();
    for (let wait = 0; wait < 10; wait += 1) await clock.advance(1_000);
    expect(reviews.length).toBeLessThanOrEqual(3 + 1 + 3);
  });

  it('keeps the newest page, the one before it and those shown lately on disk as a code-only review is edited', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, trip, dir} = openingService(backend, {live: false});
    for (let edit = 0; edit < 6; edit += 1) {
      service.setReview(review([diffFile('a\n', `b${edit}\n`, 'src/app.ts')]), CTX);
      await service.open({fileKey: 'src/app.ts'}, trip);
      await clock.advance(3 * 60_000);
    }
    expect(pageFiles(dir)).toHaveLength(2);
  });
});

describe('live refreshes of the split', () => {
  it('sends the split the newest page at the card the press opened, with no glow, when an edit writes one, at most once a second', async () => {
    const {backend, reviews} = scriptedBackend();
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    expect(surface.refreshed).toEqual([]);

    // The agent rewrites a paragraph: a new page.
    service.setReview(review([edited('README.md'), edited('docs/guide.md', 'One.\n', 'One, edited again.\n')]), CTX);
    await clock.advance(250);
    expect(surface.refreshed.map(hashOf)).toEqual(['file-1&m=1&n=2&l=1']);
    const first = surface.refreshed[0]!.split('#')[0]!;
    expect(first).not.toBe(surface.shown[0]!.split('#')[0]);
    expect(fs.readFileSync(new URL(first).pathname, 'utf8')).toBe(`<p>${reviews.at(-1)!.key}</p>`);

    // Two more rewrites inside the second: the newest goes once the second is up.
    service.setReview(review([edited('README.md'), edited('docs/guide.md', 'One.\n', 'One, third.\n')]), CTX);
    await clock.advance(250);
    service.setReview(review([edited('README.md'), edited('docs/guide.md', 'One.\n', 'One, fourth.\n')]), CTX);
    await clock.advance(250);
    expect(surface.refreshed).toHaveLength(1);
    // A second after the first refresh, which went at 2250 ms.
    await clock.advance(499);
    expect(surface.refreshed).toHaveLength(1);
    await clock.advance(1);
    expect(surface.refreshed.map(hashOf)).toEqual(['file-1&m=1&n=2&l=1', 'file-1&m=1&n=3&l=1']);
    expect(fs.readFileSync(new URL(surface.refreshed[1]!.split('#')[0]!).pathname, 'utf8')).toBe(`<p>${reviews.at(-1)!.key}</p>`);
    await clock.advance(5_000);
    expect(surface.refreshed).toHaveLength(2);
  });

  it('refreshes the page R opened at its top, and a code-only review\'s page too', async () => {
    const {backend} = scriptedBackend();
    const overview = openingService(backend);
    overview.service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await overview.clock.advance(2_000);
    await overview.service.openOverview(overview.trip);
    overview.service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited twice.\n')]), CTX);
    await overview.clock.advance(250);
    expect(overview.surface.refreshed.map(hashOf)).toEqual(['top&m=1&n=2&l=1']);

    const code = openingService(backend);
    code.service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts')]), CTX);
    await code.service.open({fileKey: 'src/app.ts'}, code.trip);
    code.service.setReview(review([diffFile('a\n', 'c\n', 'src/app.ts')]), CTX);
    await code.clock.advance(250);
    expect(code.surface.refreshed.map(hashOf)).toEqual(['file-0&m=1&n=2&l=1']);
  });

  it('sends no live refresh for a page in the browser, nor once the split is gone', async () => {
    const {backend} = scriptedBackend();
    const edit = async (each: ReturnType<typeof openingService>, next: string) => {
      each.service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await each.clock.advance(2_000);
    };

    const browser = openingService(backend, {surface: recordingSurface({kind: 'browser', answer: {where: 'browser', message: 'opened in your browser'}})});
    await edit(browser, 'One, edited.\n');
    await browser.service.open({fileKey: 'docs/guide.md'}, browser.trip);
    await edit(browser, 'One, edited twice.\n');
    expect(browser.surface.refreshed).toEqual([]);

    const closed = openingService(backend, {surface: recordingSurface({refreshes: false})});
    await edit(closed, 'One, edited.\n');
    await closed.service.open({fileKey: 'docs/guide.md'}, closed.trip);
    await edit(closed, 'One, edited twice.\n');
    await edit(closed, 'One, edited three times.\n');
    // The split was closed: the first refresh says so, and none follows.
    expect(closed.surface.refreshed).toHaveLength(1);
  });

  it('sends no live refresh while a press is on its way, and sends one after a press that placed nothing', async () => {
    const {backend} = scriptedBackend();
    const surface = recordingSurface();
    const answers: Array<Deferred<Awaited<ReturnType<Surface['show']>>>> = [];
    const held = {
      ...surface,
      async show(url: string) {
        surface.shown.push(url);
        const answer = deferred<Awaited<ReturnType<Surface['show']>>>();
        answers.push(answer);
        return answer.promise;
      },
    };
    const {service, clock, trip} = openingService(backend, {surface: held as unknown as ReturnType<typeof recordingSurface>});
    const asked = async (count: number) => {
      for (let turn = 0; turn < 50 && answers.length < count; turn += 1) await clock.advance(0);
      return answers[count - 1]!;
    };
    const edit = async (next: string) => {
      service.setReview(review([edited('docs/guide.md', 'One.\n', next), edited('README.md')]), CTX);
      await clock.advance(2_000);
    };
    await edit('One, edited.\n');
    const first = service.open({fileKey: 'docs/guide.md'}, trip);
    (await asked(1)).resolve({where: 'cmux-new', message: 'opened in the browser split'});
    await first;

    // The reader presses r on README.md while a pass writes a new page.
    const press = service.open({fileKey: 'README.md'}, trip);
    const pressed = await asked(2);
    await edit('One, edited again.\n');
    expect(surface.refreshed).toEqual([]);
    pressed.resolve({where: 'cmux-reuse', message: 'opened in the browser split'});
    await press;
    await clock.advance(1_000);
    // The press showed the page that was newest as it went; the newer one goes after it.
    expect(surface.refreshed.map(hashOf)).toEqual(['file-1&m=1&n=3&l=1']);

    // A press that places nothing leaves the split as it was, and the
    // refresh due goes once it is over.
    const refused = service.open({fileKey: 'docs/guide.md'}, trip);
    const refusing = await asked(3);
    await edit('One, edited a third time.\n');
    expect(surface.refreshed).toHaveLength(1);
    refusing.resolve({refused: 'no browser opener found · branch-review --export-html <dir> writes the pages'});
    await refused;
    await clock.advance(1_000);
    expect(surface.refreshed.map(hashOf)).toEqual(['file-1&m=1&n=3&l=1', 'file-1&m=1&n=5&l=1']);
  });

  it('sends the split to the card the press opened at its place on the newest page, after a file came in above it', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    expect(hashOf(surface.shown[0]!)).toBe('file-1&m=1&n=1');
    service.setReview(review([edited('CHANGELOG.md'), edited('README.md'), edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(250);
    expect(surface.refreshed.map(hashOf)).toEqual(['file-2&m=1&n=2&l=1']);
  });

  it('moves no split for a page written again for what it left out, while the review and its refs stay the same', async () => {
    const {backend, reviews} = scriptedBackend(undefined, (request) => ({ok: true, html: `<p>${request.key}</p>`, ...(reviews.length < 3 ? {partial: true as const} : {})}));
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts')]), CTX);
    await service.open({fileKey: 'src/app.ts'}, trip);
    for (let wait = 0; wait < 6; wait += 1) await clock.advance(1_000);
    // The follow-ups wrote the page again, and the split kept what the reader did on it.
    expect(reviews.length).toBeGreaterThan(1);
    expect(surface.refreshed).toEqual([]);
    // An edit still moves it.
    service.setReview(review([diffFile('a\n', 'c\n', 'src/app.ts')]), CTX);
    await clock.advance(250);
    expect(surface.refreshed.map(hashOf)).toEqual([expect.stringMatching(/^file-0&m=1&n=\d+&l=1$/)]);
  });

  it('sends no live refresh when a refresh leaves the page as it was', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    service.setReview(review([edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    expect(surface.refreshed).toEqual([]);
  });

  it('sends no live refresh without watch mode', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface, trip} = openingService(backend, {live: false});
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    // A review refreshed without watch mode: a background pass writes a new page, and the split stays.
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited again.\n')]), CTX);
    await clock.advance(5_000);
    expect(surface.refreshed).toEqual([]);
  });

  it('refreshes the split when an edit to another file breaks a link a rich view shows', async () => {
    let guideAnchors = ['user-content-setup'];
    const {backend} = scriptedBackend((request) => (request.path === 'README.md'
      ? {ok: true, summary: summary({links: [{href: 'docs/guide.md#setup', status: 'ok', line: 1, ref: {path: 'docs/guide.md', anchor: 'setup', index: 0}}], anchors: []})}
      : {ok: true, summary: summary({anchors: guideAnchors})}));
    const {service, clock, surface, trip} = openingService(backend);
    const files = (guide: string) => [edited('README.md', 'A.\n', 'B.\n'), edited('docs/guide.md', '# Setup\n', guide)];
    service.setReview(review(files('# Setup\n\nMore.\n')), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'README.md'}, trip);
    const opened = new URL(surface.shown[0]!).pathname;
    // The guide's heading is renamed: README.md's link to it is broken now.
    guideAnchors = ['user-content-installation'];
    service.setReview(review(files('# Installation\n\nMore.\n')), CTX);
    await clock.advance(5_000);
    const now = await service.page();
    expect(now.ok && new URL(now.url).pathname).not.toBe(opened);
    expect(surface.refreshed).toHaveLength(1);
    expect(new URL(surface.refreshed[0]!).pathname).toBe(now.ok && new URL(now.url).pathname);
  });

  it('names the pages the split may show for a live refresh, and tries again after one the split skipped', async () => {
    const {backend} = scriptedBackend();
    const surface = recordingSurface({refreshes: 'skipped'});
    const {service, clock, trip} = openingService(backend, {surface});
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    const shownName = new URL(surface.shown[0]!).pathname.split('/').at(-1)!;

    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited again.\n')]), CTX);
    await clock.advance(250);
    expect(surface.refreshed).toHaveLength(1);
    // The page the press opened, by its own name or the page's stable name.
    expect(surface.showing[0]).toEqual([shownName, `${REVIEW_ALIAS}.html`]);

    // The split showed another page: the next change tries again.
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, third.\n')]), CTX);
    await clock.advance(1_000);
    expect(surface.refreshed.map(hashOf)).toEqual(['file-0&m=1&n=2&l=1', 'file-0&m=1&n=3&l=1']);
    expect(surface.showing[1]).toEqual(surface.showing[0]);
  });

  it('keeps refreshing the split after a refresh gave way to a newer one while cmux was slow to say what it shows', async () => {
    const {backend, reviews} = scriptedBackend();
    // cmux with an open split: it shows the page it was last sent, and the
    // first time it is asked which, it takes its time to say.
    let showing = '';
    let firstUrl: Deferred<void> | null = deferred<void>();
    const gotos: string[] = [];
    const run: RunTool = async (_command, args) => {
      if (args.includes('open-split')) {
        showing = args[args.indexOf('open-split') + 1]!;
        return {ok: true, stdout: JSON.stringify({created_split: true, surface_ref: 'surface:9'})};
      }
      if (args.at(-2) === 'goto') {
        showing = args.at(-1)!;
        gotos.push(showing);
        return {ok: true, stdout: ''};
      }
      if (args.at(-1) === 'url') {
        if (firstUrl) {
          const wait = firstUrl;
          firstUrl = null;
          await wait.promise;
        }
        return {ok: true, stdout: `${showing}\n`};
      }
      return {ok: false, timedOut: false, reason: 'exit 1'};
    };
    const surface = createSurface({env: {CMUX_WORKSPACE_ID: 'workspace:3'}, run, findTool: () => '/fake/bin/cmux', opener: () => undefined, platform: 'darwin'});
    const {service, clock, trip} = openingService(backend, {surface: surface as unknown as ReturnType<typeof recordingSurface>});
    const edit = async (next: string) => {
      service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await clock.advance(1_100);
    };
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    const wait = firstUrl!;
    // The first refresh waits on cmux; a second edit's refresh comes in behind it.
    await edit('One, edited twice.\n');
    await edit('One, edited three times.\n');
    wait.resolve();
    for (let turn = 0; turn < 20; turn += 1) await clock.advance(0);
    expect(gotos).toHaveLength(1);
    expect(gotos[0]).toContain(reviews.at(-1)!.key);
    // A later edit still goes: the split is compared with the page it shows.
    await edit('One, edited four times.\n');
    for (let turn = 0; turn < 20; turn += 1) await clock.advance(0);
    expect(gotos).toHaveLength(2);
    expect(gotos[1]).toContain(reviews.at(-1)!.key);
  });
});

describe('live refreshes behind a goto cmux is slow to finish', () => {
  // cmux with an open split, whose first goto takes its time: the page it
  // sends lands once the goto ends. `movedTo`: where the reader takes the
  // split as the slow goto ends.
  function slowGotoCmux(movedTo?: string) {
    let showing = '';
    let firstGoto: Deferred<void> | null = deferred<void>();
    const held = firstGoto;
    const gotos: string[] = [];
    const run: RunTool = async (_command, args) => {
      if (args.includes('open-split')) {
        showing = args[args.indexOf('open-split') + 1]!;
        return {ok: true, stdout: JSON.stringify({created_split: true, surface_ref: 'surface:9'})};
      }
      if (args.at(-2) === 'goto') {
        if (firstGoto) {
          const wait = firstGoto;
          firstGoto = null;
          await wait.promise;
          showing = args.at(-1)!;
          gotos.push(showing);
          if (movedTo) showing = movedTo;
          return {ok: true, stdout: ''};
        }
        showing = args.at(-1)!;
        gotos.push(showing);
        return {ok: true, stdout: ''};
      }
      if (args.at(-1) === 'url') return {ok: true, stdout: `${showing}\n`};
      return {ok: false, timedOut: false, reason: 'exit 1'};
    };
    const surface = createSurface({env: {CMUX_WORKSPACE_ID: 'workspace:3'}, run, findTool: () => '/fake/bin/cmux', opener: () => undefined, platform: 'darwin'});
    return {surface, gotos, release: () => held.resolve()};
  }

  async function editing(movedTo?: string) {
    const {backend, reviews} = scriptedBackend();
    const cmux = slowGotoCmux(movedTo);
    const {service, clock, trip, dir} = openingService(backend, {surface: cmux.surface as unknown as ReturnType<typeof recordingSurface>});
    const settle = async () => {
      for (let turn = 0; turn < 40; turn += 1) await clock.advance(0);
    };
    // Each edit writes a new page; `edits` names each by its key.
    const edits: string[] = [];
    const edit = async (next: string, wait = 1_100) => {
      service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await clock.advance(wait);
      edits.push(reviews.at(-1)!.key);
    };
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    // Which edit each goto sent the split to.
    const sent = () => cmux.gotos.map((url) => edits.findIndex((key) => url.includes(key)));
    return {...cmux, clock, edit, settle, sent, dir};
  }

  it('sends the newest edit after the refresh whose goto was slow lands', async () => {
    const {release, edit, settle, clock, sent} = await editing();
    await edit('One, edited twice.\n');
    // The first refresh's goto is held; a second edit's refresh queues behind it.
    await edit('One, edited three times.\n');
    release();
    await settle();
    await clock.advance(3_000);
    await settle();
    expect(sent()).toEqual([0, 1]);
  });

  it('keeps the split on the newest edit as more edits come in behind the slow goto', async () => {
    const {release, edit, settle, sent} = await editing();
    await edit('One, edited twice.\n');
    await edit('One, edited three times.\n');
    release();
    await settle();
    await edit('One, edited four times.\n');
    await settle();
    expect(sent()).toEqual([0, 1, 2]);
  });

  it('sends nothing more when the edit behind the slow goto leaves the page as the goto sent it', async () => {
    const {release, edit, settle, clock, sent} = await editing();
    await edit('One, edited twice.\n');
    // The same text again: the same page as the one the held goto carries.
    await edit('One, edited twice.\n');
    release();
    await settle();
    await clock.advance(3_000);
    await settle();
    expect(sent()).toEqual([0]);
  });

  it('keeps the page a refresh is about to show on disk until its goto ends, though newer pages came since', async () => {
    const {release, edit, settle, clock, gotos, dir} = await editing();
    const onDisk = (url: string) => fs.existsSync(fileURLToPath(url.replace(/#.*$/, '')));
    // The first refresh's goto is held; the second waits behind it, its page
    // named only once it goes.
    await edit('One, edited twice.\n');
    await edit('One, edited three times.\n');
    await settle();
    // Two more edits inside the second: each a newer page, whose refresh
    // waits for the gap, and whose write prunes the pages no one shows.
    await edit('One, edited four times.\n', 300);
    await settle();
    await edit('One, edited five times.\n', 300);
    await settle();
    release();
    await settle();
    expect(gotos).toHaveLength(2);
    expect(gotos.map((url) => path.dirname(fileURLToPath(url.replace(/#.*$/, ''))))).toEqual([dir, dir]);
    expect(gotos.map(onDisk)).toEqual([true, true]);
    // The newest page goes once the gap is up, and is on disk too.
    await clock.advance(1_500);
    await settle();
    expect(gotos).toHaveLength(3);
    expect(onDisk(gotos.at(-1)!)).toBe(true);
  });

  it('still skips the refresh when the reader moved the split to another page as the slow goto ended', async () => {
    const {gotos, release, edit, settle} = await editing('file:///elsewhere/notes.html');
    await edit('One, edited twice.\n');
    await edit('One, edited three times.\n');
    // The goto lands, and the reader follows a link inside the split: the
    // split shows a page that is none of ours, and the refresh behind is skipped.
    release();
    await settle();
    expect(gotos).toHaveLength(1);
  });
});

describe('the whole branch', () => {
  const hero = () => imageFile(pngFixture(3, 2), pngFixture(4, 5), 'docs/hero.png');
  const embed = (imagePath: string, line: number) => ({path: imagePath, url: path.posix.basename(imagePath), line, status: 'embed' as const});

  it('finds markdown outside the review that shows a changed image, renders it marked by its images, and gives those that do a card', async () => {
    const embedders: EmbeddersRequest[] = [];
    const {backend, fragments, reviews} = scriptedBackend((request) => ({ok: true, summary: request.kind
      ? summary({kind: 'image', changes: {changed: 0, removed: 0}})
      : request.path === 'CONTRIBUTING.md' ? summary({images: [embed('docs/hero.png', 3)]})
        : request.path === 'docs/other.md' ? summary({changes: {changed: 0, removed: 0}, images: [embed('docs/other.png', 1)]})
          : summary()}));
    backend.embedders = async (request) => {
      embedders.push(request);
      return {ok: true, files: [{path: 'CONTRIBUTING.md', oid: 'abc1234'}, {path: 'docs/other.md', oid: 'def5678'}]};
    };
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md'), hero()]), CTX);
    await clock.advance(2_000);

    expect(embedders).toHaveLength(1);
    expect(embedders[0]).toMatchObject({cwd: '/repo/project', names: ['hero.png'], skip: ['README.md', 'docs/hero.png']});
    expect(fragments.find((each) => each.request.path === 'CONTRIBUTING.md')!.request).toMatchObject({textUnchanged: true, status: 'modified', source: {kind: 'blob', id: 'abc1234'}, groups: []});
    // The file whose render marked nothing shows no changed image: no card.
    const page = reviews.at(-1)!;
    expect(page.cards.map((card) => [card.path, card.also ?? null])).toEqual([['README.md', null], ['docs/hero.png', null], ['CONTRIBUTING.md', ['docs/hero.png']]]);
    expect(cardOf(page, 'CONTRIBUTING.md').fragment).toMatchObject({textUnchanged: true});
  });

  it('searches for a moved image by its old name too, and gives a card to the markdown that still names it there', async () => {
    const embedders: EmbeddersRequest[] = [];
    const {backend, reviews} = scriptedBackend((request) => ({ok: true, summary: request.kind
      ? summary({kind: 'image', changes: {changed: 0, removed: 0}})
      : request.path === 'README.md' ? summary({images: [embed('docs/old.png', 3)]}) : summary()}));
    backend.embedders = async (request) => {
      embedders.push(request);
      return {ok: true, files: [{path: 'README.md', oid: 'abc1234'}]};
    };
    const {service, clock} = serviceWith(backend);
    const moved: ReviewFile = {...imageFile(pngFixture(3, 2), pngFixture(4, 5), 'docs/new.png'), status: 'renamed', oldPath: 'docs/old.png'};
    service.setReview(review([moved]), CTX);
    await clock.advance(2_000);
    expect(embedders.map((request) => [...request.names].sort())).toEqual([['new.png', 'old.png']]);
    expect(cardOf(reviews.at(-1)!, 'README.md').also).toEqual(['docs/old.png']);
  });

  it('never searches for a file the review lists, by its new name or the one it moved from', async () => {
    const embedders: EmbeddersRequest[] = [];
    const {backend} = scriptedBackend((request) => ({ok: true, summary: request.kind ? summary({kind: 'image', changes: {changed: 0, removed: 0}}) : summary()}));
    backend.embedders = async (request) => {
      embedders.push(request);
      return {ok: true, files: []};
    };
    const {service, clock} = serviceWith(backend);
    const moved: ReviewFile = {...edited('docs/new.md'), status: 'renamed', oldPath: 'docs/old.md'};
    service.setReview(review([moved, hero()]), CTX);
    await clock.advance(2_000);
    expect(embedders.map((request) => [...request.skip].sort())).toEqual([['docs/hero.png', 'docs/new.md', 'docs/old.md']]);
  });

  it('renders the files outside the review only in what the 40-file prerender has left', async () => {
    const answer = (request: FragmentRequest): FragmentResult => ({ok: true, summary: request.kind ? summary({kind: 'image', changes: {changed: 0, removed: 0}}) : summary({images: [embed('docs/hero.png', 1)]})});
    const candidates = ['a.md', 'b.md', 'c.md'].map((file, index) => ({path: `outside/${file}`, oid: `abc12${index}`}));
    const run = async (count: number) => {
      const {backend, fragments} = scriptedBackend(answer);
      let searched = 0;
      backend.embedders = async () => {
        searched += 1;
        return {ok: true, files: candidates};
      };
      const {service, clock} = serviceWith(backend);
      service.setReview(review([...Array.from({length: count}, (_, index) => edited(`docs/page-${index}.md`)), hero()]), CTX);
      await clock.advance(2_000);
      return {searched, outside: [...new Set(fragments.map((each) => each.request.path).filter((file) => file.startsWith('outside/')))]};
    };
    // 38 pages and the hero leave room for one; 39 and the hero fill it.
    expect(await run(38)).toEqual({searched: 1, outside: ['outside/a.md']});
    expect(await run(39)).toEqual({searched: 0, outside: []});
  });

  it('searches for no markdown outside the review when the review changed no image', async () => {
    const {backend} = scriptedBackend();
    let searched = 0;
    backend.embedders = async () => {
      searched += 1;
      return {ok: true, files: []};
    };
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md')]), CTX);
    await clock.advance(2_000);
    expect(searched).toBe(0);
  });

  it('sends the page every finding of the link report, and each card the links its rich view draws broken', async () => {
    const guideLinks = [{href: 'README.md#nope', status: 'ok' as const, line: 4, ref: {path: 'README.md', anchor: 'user-content-nope', index: 0}}];
    const readmeLinks = [{href: 'gone.md', status: 'missing' as const, line: 2}];
    const {backend, reviews} = scriptedBackend((request) => ({ok: true, summary: summary(request.path === 'README.md'
      ? {links: readmeLinks, anchors: ['user-content-readme'], images: [{path: 'Logo.png', url: 'Logo.png', line: 6, status: 'caseMismatch', hint: 'Logo.png vs logo.png'}]}
      : {links: guideLinks, anchors: []})}));
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    const page = reviews.at(-1)!;
    expect(cardOf(page, 'docs/guide.md').brokenRefs).toEqual([0]);
    expect(page.findings!.map((finding) => [finding.path, finding.line, finding.kind])).toEqual([['README.md', 2, 'missing'], ['README.md', 6, 'caseMismatch'], ['docs/guide.md', 4, 'badAnchor']]);
  });
});

describe('the order of the beam and the split', () => {
  async function pressWith(opensSplit: boolean) {
    const {backend} = scriptedBackend();
    const surface = recordingSurface({opensSplit: () => opensSplit});
    const {service, clock} = openingService(backend, {surface});
    service.setReview(review([edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    const crossing = deferred<void>();
    const trip = {cross: () => crossing.promise, waiting: () => undefined};
    const opening = service.open({fileKey: 'docs/guide.md'}, trip);
    await clock.advance(0);
    const duringBeam = surface.shown.length;
    crossing.resolve();
    await opening;
    return {duringBeam, after: surface.shown.length};
  }

  it('opens a new split once the beam has ended, since the split narrows the pane the beam crosses', async () => {
    expect(await pressWith(true)).toEqual({duringBeam: 0, after: 1});
  });

  it('sends an open split to the page while the beam plays', async () => {
    expect(await pressWith(false)).toEqual({duringBeam: 1, after: 1});
  });

  it('opens a new split once the beam has ended on the press after a live refresh found the split closed', async () => {
    let text = 'One, edited.\n';
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: [{id: `b-${(text.length % 16).toString(16).padStart(8, '0')}-0`, kind: 'p', lines: [1, 1] as const}]})}));
    // cmux as the lab found it: a split opens, then the reader closes it, and
    // every call to it fails at once.
    const calls: string[] = [];
    const run: RunTool = async (_command, args) => {
      calls.push(args.join(' '));
      return args.includes('open-split') ? {ok: true, stdout: `${JSON.stringify({created_split: true, surface_ref: 'surface:4'})}\n`} : {ok: false, timedOut: false, reason: 'exit 1'};
    };
    const surface = createSurface({env: {CMUX_WORKSPACE_ID: 'workspace:3'}, run, findTool: () => '/fake/bin/cmux', opener: () => undefined, platform: 'darwin'});
    const {service, clock} = openingService(backend, {surface: surface as unknown as ReturnType<typeof recordingSurface>});
    const edit = async (next: string) => {
      text = next;
      service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await clock.advance(2_000);
    };
    await edit('One, edited.\n');
    await service.open({fileKey: 'docs/guide.md'}, {cross: async () => undefined, waiting: () => undefined});
    await edit('One, edited twice.\n');
    await edit('One, edited three times.\n');
    // One question, which found the split gone, and none after it.
    expect(calls.map((call) => call.split(' ').at(-1))).toEqual(['false', 'url']);

    const crossing = deferred<void>();
    const opening = service.open({fileKey: 'docs/guide.md'}, {cross: () => crossing.promise, waiting: () => undefined});
    await clock.advance(0);
    const duringBeam = calls.length;
    crossing.resolve();
    await opening;
    expect(duringBeam).toBe(2);
    expect(calls.slice(2)).toEqual([expect.stringMatching(/^--json browser open-split file:\/\/.+ --workspace workspace:3 --focus false$/)]);
  });
});

// A review entry for an image file, with the patch real git prints for it.
function imageFile(before: Buffer | null, after: Buffer | null, filePath: string): ReviewFile {
  const dir = makeTempDir('branch-review-rendered-image-');
  const left = path.join(dir, `before${path.extname(filePath)}`);
  const right = path.join(dir, `after${path.extname(filePath)}`);
  if (before) fs.writeFileSync(left, before);
  if (after) fs.writeFileSync(right, after);
  const rawDiff = spawnSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--full-index', before ? left : '/dev/null', after ? right : '/dev/null'], {encoding: 'utf8'}).stdout
    .replaceAll(`a${left}`, `a/${filePath}`).replaceAll(`b${right}`, `b/${filePath}`).replaceAll(left, filePath).replaceAll(right, filePath);
  return {path: filePath, status: before === null ? 'added' : after === null ? 'deleted' : 'modified', metrics: {path: filePath, additions: 0, deletions: 0, changedLines: 0}, rawDiff, renderedLines: [], blocks: []};
}

// The in-pane view rides on the service: it draws the review's markdown
// pages from the same fragments the pages get, and a link to another page
// of the review names that page's file.
describe('the rendered service with the in-pane view', () => {
  it('lays out the review\'s markdown from its fragment, and nothing else', async () => {
    const {backend} = scriptedBackend();
    const layouts: Array<{source: {fragment: FragmentRequest; base: string}}> = [];
    const withPane: RenderedBackend = {...backend, layout: async (request) => {
      layouts.push(request);
      return {ok: true, layout: {heightCss: 100, blocks: [], removed: [], links: [], anchors: []}, document: 'doc-1'};
    }, tile: async () => ({ok: false, state: 'error', reason: 'unused'})};
    const session = makeTempDir('branch-review-media-service-');
    const writes: string[] = [];
    const service = createRenderedService({
      backend: withPane,
      site: createRenderedSite({tempDir: () => session}),
      pane: {
        registry: createImageRegistry({write: (sequence) => writes.push(sequence)}),
        caps: {...KITTY_CAPS, bg: '#101418', scheme: 'dark'},
        env: {BRANCH_REVIEW_PREVIEW: 'on'},
        chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      },
    });
    const image = {...edited('docs/hero.png'), rawDiff: 'diff --git a/docs/hero.png b/docs/hero.png\nindex 1111111..2222222 100644\nBinary files a/docs/hero.png and b/docs/hero.png differ', blocks: []};
    service.setReview(review([edited('docs/guide.md'), edited('README.md'), image]), CTX);
    const pane = service.pane!;
    expect(pane.offered()).toBe(true);
    expect(pane.covers('docs/guide.md')).toBe(true);
    expect(pane.covers('docs/hero.png')).toBe(false);
    expect(pane.covers('src/app.ts')).toBe(false);
    pane.enter();
    pane.rows('docs/guide.md', {innerCols: 200, viewportRows: 30});
    expect(layouts).toHaveLength(1);
    expect(layouts[0]!.source.fragment).toMatchObject({path: 'docs/guide.md', cwd: '/repo/project'});
    expect(layouts[0]!.source.base).toBe('main');
    service.dispose();
  });

  it('draws the links its file page draws broken, once the report finds them', async () => {
    const guideLinks = [{href: 'README.md#nope', status: 'ok' as const, line: 4, ref: {path: 'README.md', anchor: 'user-content-nope', index: 0}}];
    const {backend} = scriptedBackend((request) => ({ok: true, summary: summary(request.path === 'README.md' ? {links: [], anchors: ['user-content-readme']} : {links: guideLinks, anchors: []})}));
    const layouts: LayoutRequest[] = [];
    const withPane: RenderedBackend = {...backend, layout: async (request) => {
      layouts.push(request);
      return {ok: true, layout: {heightCss: 100, blocks: [], removed: [], links: [], anchors: []}, document: 'doc-1'};
    }, tile: async () => ({ok: false, state: 'error', reason: 'unused'})};
    const clock = fakeTimers();
    const session = makeTempDir('branch-review-media-service-');
    const service = createRenderedService({
      backend: withPane,
      site: createRenderedSite({tempDir: () => session, now: clock.now}),
      now: clock.now,
      setTimer: clock.setTimer,
      pane: {
        registry: createImageRegistry({write: () => undefined}),
        caps: {...KITTY_CAPS, bg: '#101418', scheme: 'dark'},
        env: {BRANCH_REVIEW_PREVIEW: 'on'},
        chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      },
    });
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    const pane = service.pane!;
    pane.enter();
    pane.rows('docs/guide.md', {innerCols: 200, viewportRows: 30});
    pane.rows('README.md', {innerCols: 200, viewportRows: 30});
    const sourceOf = (file: string) => layouts.find((request) => request.source.fragment.path === file)!.source;
    expect(sourceOf('docs/guide.md').brokenRefs).toEqual([0]);
    expect(sourceOf('README.md').brokenRefs).toBeUndefined();
    service.dispose();
  });

  it('plans a page in the pane again when the report finds a broken link after it was laid out', async () => {
    const guideLinks = [{href: 'README.md#nope', status: 'ok' as const, line: 4, ref: {path: 'README.md', anchor: 'user-content-nope', index: 0}}];
    const {backend} = scriptedBackend((request) => ({ok: true, summary: summary(request.path === 'README.md' ? {links: [], anchors: ['user-content-readme']} : {links: guideLinks, anchors: []})}));
    const layouts: LayoutRequest[] = [];
    const withPane: RenderedBackend = {...backend, layout: async (request) => {
      layouts.push(request);
      return {ok: true, layout: {heightCss: 100, blocks: [], removed: [], links: [], anchors: []}, document: `doc-${layouts.length}`};
    }, tile: async () => ({ok: false, state: 'error', reason: 'unused'})};
    const clock = fakeTimers();
    const session = makeTempDir('branch-review-media-service-');
    const service = createRenderedService({
      backend: withPane,
      site: createRenderedSite({tempDir: () => session, now: clock.now}),
      now: clock.now,
      setTimer: clock.setTimer,
      pane: {
        registry: createImageRegistry({write: () => undefined}),
        caps: {...KITTY_CAPS, bg: '#101418', scheme: 'dark'},
        env: {BRANCH_REVIEW_PREVIEW: 'on'},
        chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
      },
    });
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    const pane = service.pane!;
    // `v` before the prerender's fragments land: the page has no broken link yet.
    pane.enter();
    pane.rows('docs/guide.md', {innerCols: 200, viewportRows: 30});
    expect(layouts.map((request) => request.source.brokenRefs)).toEqual([undefined]);
    await clock.advance(0);
    const planned = pane.planVersion();
    await clock.advance(2_000);
    // Nothing else asks for the rows again: the pane says its plan changed.
    expect(pane.planVersion()).toBeGreaterThan(planned);
    pane.rows('docs/guide.md', {innerCols: 200, viewportRows: 30});
    expect(layouts.map((request) => request.source.brokenRefs)).toEqual([undefined, [0]]);
    service.dispose();
  });
});

describe('the service the CLI runs, over SSH', () => {
  it('names v in the refusal of r only once the pane can draw there, with a Chromium found', async () => {
    const outside = makeTempDir('branch-review-chrome-');
    const chrome = path.join(outside, 'chrome-headless-shell');
    fs.writeFileSync(chrome, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(chrome, 0o755);
    const said = async (browser: string) => {
      const session = makeTempDir('branch-review-session-');
      const service = startRenderedService({
        tempDir: () => session,
        env: {SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22', BRANCH_REVIEW_CHROME: browser},
        cwd: session,
        opener: () => undefined,
        pane: {registry: createImageRegistry({write: () => undefined}), caps: KITTY_CAPS},
      });
      service.setReview(review([edited('README.md')]), CTX);
      const outcome = await service.open({fileKey: 'README.md'});
      service.dispose();
      return outcome;
    };
    expect(await said(path.join(outside, 'missing'))).toEqual({kind: 'error', message: "open isn't available over SSH · branch-review --export-html <dir> writes the pages"});
    expect(await said(chrome)).toEqual({kind: 'error', message: "open isn't available over SSH · v previews it"});
  });

  it('names v in the refusal only on a file whose page the pane draws, and the Preview toasts name --export-html in place of r', async () => {
    const outside = makeTempDir('branch-review-chrome-');
    const chrome = path.join(outside, 'chrome-headless-shell');
    fs.writeFileSync(chrome, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(chrome, 0o755);
    const headless = 'branch-review --export-html <dir> writes the pages';
    const started = (browser: string) => {
      const session = makeTempDir('branch-review-session-');
      const service = startRenderedService({
        tempDir: () => session,
        env: {SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22', BRANCH_REVIEW_CHROME: browser},
        cwd: session,
        opener: () => undefined,
        pane: {registry: createImageRegistry({write: () => undefined}), caps: KITTY_CAPS},
      });
      service.setReview(review([edited('README.md'), imageFile(pngFixture(3, 2), pngFixture(4, 5), 'docs/hero.png')]), CTX);
      return service;
    };
    const drawn = started(chrome);
    expect(drawn.pane!.advertised()).toBe(true);
    // An image keeps its media meaning for v, and the overview is no one file's page.
    expect(await drawn.open({fileKey: 'docs/hero.png'})).toEqual({kind: 'error', message: `open isn't available over SSH · ${headless}`});
    expect(await drawn.openOverview()).toEqual({kind: 'error', message: `open isn't available over SSH · ${headless}`});
    expect(await drawn.open({fileKey: 'README.md'})).toEqual({kind: 'error', message: "open isn't available over SSH · v previews it"});
    drawn.dispose();

    const missing = started(path.join(outside, 'missing'));
    expect(missing.pane!.enter()).toEqual({ok: false, message: `✗ Preview isn't available: no Chrome found · set BRANCH_REVIEW_CHROME or install chrome-headless-shell · ${headless}`});
    missing.dispose();
  });
});
