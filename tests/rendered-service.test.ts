import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import type {DiffRange} from '../src/git.js';
import type {ReviewFile, ReviewModel} from '../src/review/model.js';
import type {EmbeddersRequest, FragmentRequest, FragmentResult, FragmentSummary, LayoutRequest, PageRequest, PageResult, RenderedBackend} from '../src/rendered/backend.js';
import {createRenderedService, startRenderedService} from '../src/rendered/service.js';
import type {RunTool} from '../src/rendered/run.js';
import {createSurface, type Surface} from '../src/rendered/surface.js';
import {createRenderedSite} from '../src/rendered/site.js';
import {createRenderedBackend} from '../src/rendered/workerClient.js';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';
import {KITTY_CAPS, pngFixture} from './media-helpers.js';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import {diffFile} from './rendered-helpers.js';

// The rendered service on its own, over a scripted backend and a fake
// clock: which fragments it asks for and in what order, which pages it
// writes, and what it says when the worker can't answer.

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
// test lets it go) and each page from `page` (by default HTML naming the
// request's key, at once). Records every fragment asked for, and every
// fragment moved to another priority.
function scriptedBackend(
  answer: (request: FragmentRequest) => FragmentResult | Promise<FragmentResult> = () => ({ok: true, summary: summary()}),
  page: (request: PageRequest) => PageResult | Promise<PageResult> = (request) => {
    const body = 'body' in request.content ? request.content.body : null;
    return {ok: true, html: `<p>${request.key}</p>`, summary: body ? summary({kind: body.kind, changes: {changed: 0, removed: 0}}) : summary()};
  },
) {
  const fragments: Array<{request: FragmentRequest; priority: number | undefined; signal: AbortSignal}> = [];
  const prioritized: Array<{path: string; priority: number}> = [];
  const pages: PageRequest[] = [];
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
    async page(request): Promise<PageResult> {
      pages.push(request);
      if (off) return {ok: false, state: 'unavailable', reason: off};
      return page(request);
    },
    dispose: () => undefined,
    disabledReason: () => off,
  };
  return {backend, fragments, prioritized, pages, turnOff: (reason: string) => {
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
const aliasFiles = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('f-')) : []);

describe('the rendered service', () => {
  it('does nothing for a review with no markdown, and waits two seconds after the first review before rendering', async () => {
    const {backend, fragments} = scriptedBackend();
    const {service, clock, dir} = serviceWith(backend);

    service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts')]), CTX);
    await clock.advance(5_000);
    expect(fragments).toHaveLength(0);
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

  it('writes every page once its fragments are back, each file under a stable name its links use', async () => {
    const {backend, fragments, pages} = scriptedBackend((request) => ({ok: true, summary: summary({changes: {changed: request.path === 'README.md' ? 2 : 1, removed: 1}})}));
    const {service, clock, dir} = serviceWith(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md'), diffFile('Old.\n', null, 'docs/old.md')]), CTX);
    await clock.advance(2_000);

    expect(pages).toHaveLength(3);
    expect(pageFiles(dir)).toHaveLength(3);
    expect(aliasFiles(dir)).toHaveLength(3);
    const readme = fragments.find((each) => each.request.path === 'README.md')!.request;
    const guideAlias = pages.find((page) => page.file.path === 'docs/guide.md')!.rail.find((entry) => entry.current)!.href;
    expect(readme.links['docs/guide.md']).toEqual({kind: 'inReview', href: guideAlias});
    expect(guideAlias).toMatch(/^f-[0-9a-f]{20}\.html$/);
    // A deleted file has a page, but a link to it is broken on GitHub.
    expect(readme.links['docs/old.md']).toEqual({kind: 'missing'});
    // The rail counts what each fragment marked.
    expect(pages[0]!.rail.map((entry) => [entry.path, entry.label])).toEqual([['README.md', '3'], ['docs/guide.md', '2'], ['docs/old.md', '−']]);
    // The fragment request goes along, so the worker can render it again.
    expect(pages.every((page) => 'fragment' in page.content)).toBe(true);

    const outcome = await service.page('docs/guide.md');
    expect(outcome).toMatchObject({ok: true});
    expect(outcome.ok && outcome.url).toBe(`file://${path.join(dir, `${pages.find((page) => page.file.path === 'docs/guide.md')!.key}.html`)}`);
    expect(pages).toHaveLength(3);
  });

  it('waits for a watch refresh to settle, asks every fragment again, and writes only pages that changed', async () => {
    const {backend, fragments, pages} = scriptedBackend((request) => ({ok: true, summary: summary({assets: request.path === 'README.md' && request.assets.epoch > 2 ? 'new-logo' : ''})}));
    const {service, clock, dir} = serviceWith(backend);
    const files = [edited('README.md'), edited('docs/guide.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    expect(pages).toHaveLength(2);

    // The same files again: the worker checks each one's images, and nothing changed.
    service.setReview(review(files), CTX);
    await clock.advance(249);
    expect(fragments).toHaveLength(2);
    await clock.advance(1);
    expect(fragments).toHaveLength(4);
    expect(pages).toHaveLength(2);

    // An image README.md embeds changed: its page gets a new key, the old one stays as its previous.
    service.setReview(review(files), CTX);
    await clock.advance(250);
    expect(pages.map((page) => page.file.path)).toEqual(['README.md', 'docs/guide.md', 'README.md']);
    expect(pageFiles(dir)).toHaveLength(3);
    const alias = path.join(dir, pages[2]!.rail.find((entry) => entry.current)!.href);
    expect(fs.readFileSync(alias, 'utf8')).toBe(`<p>${pages[2]!.key}</p>`);
  });

  it('keeps a file\'s newest page and the one before it, and drops older pages nobody opened', async () => {
    const {backend, pages} = scriptedBackend((request) => ({ok: true, summary: summary({assets: `logo-${request.assets.epoch}`})}));
    const {service, clock, dir} = serviceWith(backend);
    const files = [edited('README.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    for (let refresh = 0; refresh < 2; refresh += 1) {
      service.setReview(review(files), CTX);
      await clock.advance(250);
    }
    expect(pages).toHaveLength(3);
    // Written in the background, never shown: the first page goes at once.
    expect(pageFiles(dir).sort()).toEqual([`${pages[1]!.key}.html`, `${pages[2]!.key}.html`].sort());

    // A page someone opened stays for two minutes after it was shown.
    const opened = await service.page('README.md');
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

  it('renders a file on demand past the prerender limit, ahead of the rest', async () => {
    const {backend, fragments} = scriptedBackend();
    const {service, clock} = serviceWith(backend);
    const files = Array.from({length: 42}, (_, index) => edited(`doc-${String(index).padStart(2, '0')}.md`));
    service.setReview(review(files), CTX);
    // Asked for before the prerender started: the worker starts at once.
    const outcome = await service.page('doc-41.md');
    expect(outcome).toMatchObject({ok: true});
    expect(fragments[0]).toMatchObject({request: {path: 'doc-41.md'}, priority: 0});
    await clock.advance(2_000);
    expect(fragments.filter((each) => each.request.path === 'doc-41.md')).toHaveLength(1);
  });

  it('gives a file whose render timed out a page saying so, without asking the worker to render it again', async () => {
    const {backend, pages} = scriptedBackend((request) => (request.path === 'slow.md' ? {ok: false, state: 'error', reason: 'timed out'} : {ok: true, summary: summary()}));
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md'), edited('slow.md')]), CTX);
    await clock.advance(2_000);
    const slow = pages.find((page) => page.file.path === 'slow.md')!;
    expect(slow.content).toEqual({body: {kind: 'failed', reason: 'timed out', source: ''}});
    expect(slow.rail.find((entry) => entry.path === 'slow.md')!.label).toBe('·');
  });

  it('says the rendered view is off once, and refuses pages with the reason', async () => {
    const {backend, turnOff} = scriptedBackend();
    const {service, clock} = serviceWith(backend);
    turnOff('Preview and Review in browser turned off: timed out');
    service.setReview(review([edited('README.md')]), CTX);
    await clock.advance(2_000);
    expect(await service.page('README.md')).toEqual({ok: false, reason: 'Preview and Review in browser turned off: timed out'});
    expect(service.takeNotices()).toEqual(['✗ Preview and Review in browser turned off: timed out']);
    await service.page('README.md');
    expect(service.takeNotices()).toEqual([]);
  });

  it('moves a fragment already queued to the front when its page is asked for, and when its file gets the focus', async () => {
    const {backend, fragments, prioritized} = scriptedBackend(() => new Promise<FragmentResult>(() => undefined));
    const {service, clock} = serviceWith(backend);
    const files = Array.from({length: 30}, (_, index) => edited(`doc-${String(index).padStart(2, '0')}.md`));
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    expect(fragments.find((each) => each.request.path === 'doc-29.md')!.priority).toBe(2);

    void service.page('doc-29.md');
    await clock.advance(0);
    expect(prioritized).toEqual([{path: 'doc-29.md', priority: 0}]);
    // Moved, not asked again.
    expect(fragments.filter((each) => each.request.path === 'doc-29.md')).toHaveLength(1);

    service.focus('doc-15.md');
    expect(prioritized.slice(1).sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      {path: 'doc-12.md', priority: 1}, {path: 'doc-13.md', priority: 1}, {path: 'doc-14.md', priority: 1},
      {path: 'doc-15.md', priority: 0},
      {path: 'doc-16.md', priority: 1}, {path: 'doc-17.md', priority: 1}, {path: 'doc-18.md', priority: 1},
    ]);
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
    expect(scripted.pages).toHaveLength(0);
  });

  it('writes again only the page of a file whose change count moved', async () => {
    let readmeChanges = 1;
    const {backend, pages} = scriptedBackend((request) => ({ok: true, summary: summary({
      changes: {changed: request.path === 'README.md' ? readmeChanges : 1, removed: 0},
      // README.md's fragment says something new when its count moves.
      assets: request.path === 'README.md' ? `count-${readmeChanges}` : '',
    })}));
    const {service, clock} = serviceWith(backend);
    const files = [edited('README.md'), edited('docs/a.md'), edited('docs/b.md'), edited('docs/c.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    expect(pages).toHaveLength(4);

    readmeChanges = 3;
    service.setReview(review(files), CTX);
    await clock.advance(250);
    expect(pages.slice(4).map((page) => page.file.path)).toEqual(['README.md']);
  });

  it('gives a new file that timed out once its rendered page on the next pass', async () => {
    let asked = 0;
    const {backend, pages} = scriptedBackend(() => {
      asked += 1;
      return asked === 1 ? {ok: false, state: 'error', reason: 'timed out'} : {ok: true, summary: summary({changes: {changed: 0, removed: 0}})};
    });
    const {service, clock, dir} = serviceWith(backend);
    const files = [diffFile(null, '# New doc\n', 'docs/new.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    const failed = await service.page('docs/new.md');
    expect(pages.at(-1)!.content).toEqual({body: {kind: 'failed', reason: 'timed out', source: ''}});

    service.setReview(review(files), CTX);
    await clock.advance(250);
    const rendered = await service.page('docs/new.md');
    expect(asked).toBe(2);
    expect(rendered.ok && failed.ok && rendered.key).not.toBe(failed.ok && failed.key);
    expect('fragment' in pages.at(-1)!.content).toBe(true);
    expect(fs.readFileSync(path.join(dir, `${rendered.ok && rendered.key}.html`), 'utf8')).toBe(`<p>${rendered.ok && rendered.key}</p>`);
  });

  it('keeps a file\'s stable name on its newest page when an older review\'s write lands last', async () => {
    const held: Array<Deferred<PageResult>> = [];
    const {backend, pages} = scriptedBackend(
      (request) => ({ok: true, summary: summary({assets: `logo-${request.assets.epoch}`})}),
      () => {
        const answer = deferred<PageResult>();
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
    expect(pages).toHaveLength(2);
    const [older, newer] = pages;
    // The newer review's page comes back first, then the older one's.
    held[1]!.resolve({ok: true, html: `<p>${newer!.key}</p>`, summary: summary()});
    await clock.advance(0);
    held[0]!.resolve({ok: true, html: `<p>${older!.key}</p>`, summary: summary()});
    await clock.advance(0);

    const alias = path.join(dir, newer!.rail.find((entry) => entry.current)!.href);
    expect(fs.readFileSync(alias, 'utf8')).toBe(`<p>${newer!.key}</p>`);
    expect(await service.page('README.md')).toMatchObject({ok: true, key: newer!.key});
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
    // Opening its page asks again.
    await service.page('hang.md');
    expect(fragments.filter((each) => each.request.path === 'hang.md')).toHaveLength(2);
  });

  it('gives every file past the prerender limit a page under its stable name, and points it at the newest review', async () => {
    const {backend, pages} = scriptedBackend();
    const {service, clock, dir} = serviceWith(backend);
    const files = Array.from({length: 45}, (_, index) => edited(`doc-${String(index).padStart(2, '0')}.md`));
    service.setReview(review(files), CTX);
    await clock.advance(2_000);
    expect(aliasFiles(dir)).toHaveLength(45);
    const aliasOf = (name: string) => path.join(dir, pages.find((page) => page.file.path === name)!.rail.find((entry) => entry.current)!.href);
    const waiting = pages.filter((page) => 'body' in page.content);
    expect(waiting.map((page) => page.file.path)).toEqual(['doc-40.md', 'doc-41.md', 'doc-42.md', 'doc-43.md', 'doc-44.md']);
    expect(waiting.every((page) => 'body' in page.content && page.content.body.kind === 'pending')).toBe(true);
    for (const page of waiting) expect(fs.readFileSync(aliasOf(page.file.path), 'utf8')).toBe(`<p>${page.key}</p>`);

    // Rendered once on demand, then changed: its stable name leaves the old page.
    const opened = await service.page('doc-44.md');
    expect(fs.readFileSync(aliasOf('doc-44.md'), 'utf8')).toBe(`<p>${opened.ok && opened.key}</p>`);
    files[44] = edited('doc-44.md', 'One.\n', 'One, edited again.\n');
    service.setReview(review(files), CTX);
    await clock.advance(250);
    const latest = pages.filter((page) => page.file.path === 'doc-44.md').at(-1)!;
    expect(latest.content).toEqual({body: {kind: 'pending'}});
    expect(fs.readFileSync(aliasOf('doc-44.md'), 'utf8')).toBe(`<p>${latest.key}</p>`);
  });

  it('points a file\'s stable name at the page its newest review wants, when that page\'s write began for an older review', async () => {
    const held: Array<Deferred<PageResult>> = [];
    const {backend, pages} = scriptedBackend(undefined, () => {
      const answer = deferred<PageResult>();
      held.push(answer);
      return answer.promise;
    });
    const {service, clock, dir} = serviceWith(backend);
    const first = edited('README.md', 'One.\n', 'One, edited.\n');
    service.setReview(review([first]), CTX);
    await clock.advance(2_000);
    service.setReview(review([edited('README.md', 'One.\n', 'One, edited twice.\n')]), CTX);
    await clock.advance(250);
    const [older, newer] = pages;
    held[1]!.resolve({ok: true, html: `<p>${newer!.key}</p>`, summary: summary()});
    await clock.advance(0);
    // Back to the first text, while the first review's write still runs: it is shared, not sent again.
    service.setReview(review([first]), CTX);
    await clock.advance(250);
    expect(pages).toHaveLength(2);
    held[0]!.resolve({ok: true, html: `<p>${older!.key}</p>`, summary: summary()});
    await clock.advance(0);

    const alias = path.join(dir, older!.rail.find((entry) => entry.current)!.href);
    expect(fs.readFileSync(alias, 'utf8')).toBe(`<p>${older!.key}</p>`);
    expect(pageFiles(dir)).toContain(`${older!.key}.html`);
    expect(await service.page('README.md')).toMatchObject({ok: true, key: older!.key});
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
    expect(await service.page('README.md')).toEqual({ok: false, reason: "can't write the page: not a directory"});
  });

  it('refuses a file with no markdown page', async () => {
    const {backend} = scriptedBackend();
    const {service} = serviceWith(backend);
    service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts')]), CTX);
    expect(await service.page('src/app.ts')).toEqual({ok: false, reason: 'no page for this file'});
  });
});

const CRASHING_WORKER = fileURLToPath(new URL('./fixtures/crashing-rendered-worker.mjs', import.meta.url));

// The service with a surface that records what it was asked to show and a
// motion the test picks. `cross` records the crossing the TUI was asked to
// play, which ends a turn of the event loop later, as a real one ends
// 320 ms after it starts. `live`: watch mode, on here unless a test says.
function openingService(backend: RenderedBackend, {
  surface = recordingSurface(),
  motion = 'full' as const,
  site,
  colors,
  animations,
  live = true,
}: {surface?: ReturnType<typeof recordingSurface>; motion?: 'full' | 'reduced' | 'off'; site?: ReturnType<typeof createRenderedSite>; colors?: {fg?: string; bg?: string}; animations?: boolean; live?: boolean} = {}) {
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
    ...(colors ? {colors} : {}),
    ...(animations !== undefined ? {animations} : {}),
    live,
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
    showing,
    kind,
    refusal,
    destination: kind === 'cmux' ? 'in a browser split' : kind === 'browser' ? 'in your browser' : null,
    shown,
    refreshed,
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

describe('opening pages', () => {
  it('shows the file\'s page after the crossing, and says where it opened, the same way each time', async () => {
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

    expect(await service.open({fileKey: 'docs/guide.md'}, trip)).toEqual({kind: 'info', message: '⇗ guide.md opened in the browser split'});
  });

  it('opens the first rendered file when the active file has no page, and says which', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts'), edited('docs/setup.md'), edited('README.md')]), CTX);
    await clock.advance(2_000);
    expect(await service.open({fileKey: 'src/app.ts'}, trip)).toEqual({kind: 'info', message: '⇗ docs/setup.md opened in the browser split · the first file with a page'});
    expect(surface.shown).toHaveLength(1);
  });

  it('throws nothing toward a page that will not open', async () => {
    const {backend, turnOff} = scriptedBackend();
    const nothing = openingService(backend);
    nothing.service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts')]), CTX);
    expect(await nothing.service.open({fileKey: 'src/app.ts'}, nothing.trip)).toEqual({kind: 'info', message: 'nothing to open in the browser · no markdown, images or SVG on this branch'});
    expect(await nothing.service.openOverview(nothing.trip)).toEqual({kind: 'info', message: 'nothing to open in the browser · no markdown, images or SVG on this branch'});

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

  it('says it is rendering when the page is not ready by the end of the crossing, then opens it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const {backend} = scriptedBackend(async () => {
      await held;
      return {ok: true, summary: summary()};
    });
    const {service, surface, trip, events} = openingService(backend);
    service.setReview(review([edited('docs/slow.md')]), CTX);
    const opening = service.open({fileKey: 'docs/slow.md'}, trip);
    for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['cross full', 'waiting preparing slow.md…']);
    expect(surface.shown).toEqual([]);
    release();
    expect(await opening).toMatchObject({kind: 'info', message: expect.stringMatching(/^⇗ slow\.md opened in the browser split/)});
    expect(surface.shown).toHaveLength(1);
  });

  it('gives up after 5 s with an error, and opens nothing late', async () => {
    const held = deferred<FragmentResult>();
    const {backend} = scriptedBackend(() => held.promise);
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('docs/stuck.md')]), CTX);
    const opening = service.open({fileKey: 'docs/stuck.md'}, trip);
    await clock.advance(4_999);
    await clock.advance(1);
    expect(await opening).toEqual({kind: 'error', message: 'stuck.md took too long to prepare'});
    // The render finishes after all, and its page is written: it still
    // opens nowhere, since the footer already said it wouldn't.
    held.resolve({ok: true, summary: summary()});
    await clock.advance(0);
    expect(pageFiles(path.dirname(new URL((await service.page('docs/stuck.md') as {url: string}).url).pathname))).toHaveLength(1);
    expect(surface.shown).toEqual([]);
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

  it('opens an overview of every page, whose rows open pages on disk, and keeps it through a prune', async () => {
    const {backend} = scriptedBackend((request) => ({ok: true, summary: summary({changes: {changed: request.path === 'README.md' ? 2 : 0, removed: request.path === 'README.md' ? 1 : 0}, differences: request.path === 'README.md' ? [{kind: 'mermaid', count: 1}] : []})}));
    const {service, clock, surface, trip, events, dir} = openingService(backend);
    service.setReview(review([edited('README.md'), diffFile(null, 'New.\n', 'docs/new.md'), diffFile('Old.\n', null, 'docs/old.md')]), CTX);

    // Before the background render starts: the overview renders what it lists.
    const outcome = await service.openOverview(trip);
    expect(outcome).toEqual({kind: 'info', message: '⇗ all files opened in the browser split'});
    expect(events).toEqual(['cross full']);
    const file = new URL(surface.shown[0]!).pathname;
    const html = fs.readFileSync(file, 'utf8');
    expect(html).toContain('<title>All files · branch-review</title>');
    expect(html).toContain('2 changed · 1 removed');
    expect(html).toContain('new file');
    expect(html).toContain('shown dimmed from main');
    expect(html).toContain('1 Mermaid diagram shown as code');
    const hrefs = [...html.matchAll(/<a class="br-row[^"]*" href="([^"]+)"/g)].map((match) => match[1]!);
    expect(hrefs).toHaveLength(3);
    for (const href of hrefs) expect(fs.existsSync(path.join(path.dirname(file), href))).toBe(true);

    // A refresh's prune keeps the overview, under its key and its stable
    // name, long after it was shown, and it says the same thing again.
    await clock.advance(3 * 60_000);
    service.setReview(review([edited('README.md'), diffFile(null, 'New.\n', 'docs/new.md'), diffFile('Old.\n', null, 'docs/old.md')]), CTX);
    await clock.advance(5_000);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('f-'))).toHaveLength(4);
    expect(await service.openOverview(trip)).toEqual({kind: 'info', message: '⇗ all files opened in the browser split'});
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.html')).length).toBeGreaterThan(0);
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

  it('never shows an older press\'s page over a newer one, however late its render lands', async () => {
    const held = deferred<void>();
    const {backend} = scriptedBackend(async (request) => {
      if (request.path === 'docs/slow.md') await held.promise;
      return {ok: true, summary: summary()};
    });
    const {service, surface, trip, events} = openingService(backend);
    service.setReview(review([edited('docs/slow.md'), edited('docs/fast.md')]), CTX);
    const older = service.open({fileKey: 'docs/slow.md'}, trip);
    const newer = service.open({fileKey: 'docs/fast.md'}, trip);
    expect(await newer).toMatchObject({kind: 'info', message: expect.stringMatching(/^⇗ fast\.md opened in the browser split/)});
    // The page fast.md opened with, while slow.md's count was still unknown.
    const fast = await service.page('docs/fast.md');
    held.resolve();
    expect(await older).toBeNull();
    // The second press, and fast.md's first visit.
    expect(surface.shown).toEqual([`${fast.ok && fast.url}#d=full&m=1&n=2`]);
    // Nor does it say it is still rendering once a newer press took its place.
    expect(events.filter((event) => event.startsWith('waiting'))).toEqual([]);
  });

  it('gives an overview row whose page could not be written no link, and says it isn\'t rendered', async () => {
    const {backend} = scriptedBackend(undefined, (request) => (request.file.path === 'docs/broken.md'
      ? {ok: false, state: 'error', reason: 'renderer crashed'}
      : {ok: true, html: `<p>${request.key}</p>`, summary: summary()}));
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/broken.md')]), CTX);
    await clock.advance(2_000);
    expect(await service.openOverview(trip)).toMatchObject({kind: 'info'});
    const html = fs.readFileSync(new URL(surface.shown[0]!).pathname, 'utf8');
    const row = (name: string) => [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]!).find((each) => each.includes(name))!;
    expect(row('README.md')).toMatch(/^<a class="br-row br-row-modified" href="f-[0-9a-f]{20}\.html">/);
    expect(row('docs/broken.md')).toMatch(/^<div class="br-row br-row-modified br-row-none">/);
    expect(row('docs/broken.md')).not.toContain('href=');
    expect(row('docs/broken.md')).toContain('not ready yet');
  });

  it('asks the worker for no fragment again on R once this review\'s are in', async () => {
    const {backend, fragments} = scriptedBackend();
    const {service, clock, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/a.md'), edited('docs/b.md')]), CTX);
    await clock.advance(2_000);
    expect(fragments).toHaveLength(3);
    await service.openOverview(trip);
    await service.openOverview(trip);
    await clock.advance(0);
    expect(fragments).toHaveLength(3);
    // A file that left the review and came back counts as new: a new review asks again.
    service.setReview(review([edited('README.md'), edited('docs/a.md'), edited('docs/b.md')]), CTX);
    await clock.advance(250);
    expect(fragments).toHaveLength(6);
  });

  it('lists what is done when the background pass runs long, inside the open deadline', async () => {
    const held = deferred<FragmentResult>();
    const {backend} = scriptedBackend((request) => (request.path === 'docs/cold.md' ? held.promise : {ok: true, summary: summary()}));
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/cold.md')]), CTX);
    let toast: unknown = null;
    void service.openOverview(trip).then((outcome) => {
      toast = outcome;
    });
    await clock.advance(3_000);
    await clock.advance(2_000);
    expect(toast).toMatchObject({kind: 'info', message: expect.stringMatching(/^⇗ all files opened in the browser split/)});
    const html = fs.readFileSync(new URL(surface.shown[0]!).pathname, 'utf8');
    expect(html).toContain('<span class="br-row-path">docs/cold.md</span><span class="br-row-note">not ready yet</span>');
    held.resolve({ok: true, summary: summary()});
  });

  it('asks again for a render whose image lookups ran out of time, so every rail counts what its page marks', async () => {
    // README's first render ran out of time on a changed image and marked
    // 13 blocks; rendered again with the image answered, it marks 14.
    let readme = 0;
    const {backend, fragments, pages} = scriptedBackend((request) => {
      if (request.path !== 'README.md') return {ok: true, summary: summary()};
      readme += 1;
      return {ok: true, summary: readme === 1 ? summary({changes: {changed: 13, removed: 0}, assets: 'late', late: true}) : summary({changes: {changed: 14, removed: 0}, assets: 'with-image'})};
    });
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('docs/guide.md'), edited('README.md'), edited('docs/new-api.md')]), CTX);
    await clock.advance(2_000);
    expect(fragments.filter((each) => each.request.path === 'README.md')).toHaveLength(2);
    const label = (request: PageRequest) => request.rail.find((entry) => entry.path === 'README.md')!.label;
    expect(pages.map(label)).toEqual(['14', '14', '14']);
    await service.openOverview(trip);
    expect(fs.readFileSync(new URL(surface.shown[0]!).pathname, 'utf8')).toContain('<span class="br-row-path">README.md</span><span class="br-row-note">14 changed</span>');
  });

  it('takes the count a page\'s own render marked, for its rail, the overview and the pages after it', async () => {
    // The worker no longer held README's fragment and rendered it again for
    // the page, this time with its image: 14 marks where the fragment said 13.
    const counted = (changed: number) => summary({changes: {changed, removed: 0}, assets: changed === 14 ? 'with-image' : 'late'});
    const {backend, fragments, pages} = scriptedBackend(
      (request) => ({ok: true, summary: request.path === 'README.md' ? counted(13) : summary()}),
      (request) => ('fragment' in request.content && request.file.path === 'README.md'
        ? {ok: true, html: `<p>${request.key}</p>`, summary: counted(14), rerendered: true}
        : {ok: true, html: `<p>${request.key}</p>`, summary: summary()}),
    );
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    expect(await service.open({fileKey: 'README.md'}, trip)).toMatchObject({kind: 'info'});
    const label = (request: PageRequest) => request.rail.find((entry) => entry.path === 'README.md')!.label;
    // The page shown is written again with a rail that says 14.
    const shown = new URL(surface.shown[0]!).pathname;
    const key = path.basename(shown, '.html');
    expect(label(pages.find((request) => request.key === key)!)).toBe('14');
    await clock.advance(2_000);
    expect(label(pages.filter((request) => request.file.path === 'docs/guide.md').at(-1)!)).toBe('14');
    // The background pass sends only the fragment this review has no answer for.
    expect(fragments.map((each) => each.request.path)).toEqual(['README.md', 'docs/guide.md']);
    await service.openOverview(trip);
    expect(fs.readFileSync(new URL(surface.shown.at(-1)!).pathname, 'utf8')).toContain('<span class="br-row-path">README.md</span><span class="br-row-note">14 changed</span>');
  });

  it('keeps the home dir and stack lines of a crashing worker out of every toast, notice, page and overview', async () => {
    const session = makeTempDir('branch-review-open-crash-');
    const backend = createRenderedBackend({tempDir: () => session, cwd: session, modulePath: CRASHING_WORKER, backoffMs: [10, 10, 10]});
    try {
      const site = createRenderedSite({tempDir: () => session});
      const {service, trip} = openingService(backend, {site});
      const files = [edited('README.md'), edited('docs/guide.md')];
      service.setReview(review(files), CTX);
      const said = [
        await service.open({fileKey: 'README.md'}, trip),
        await service.open({fileKey: 'docs/guide.md'}, trip),
        await service.openOverview(trip),
      ];
      // A new review asks again, and the third crash in a minute turns the view off.
      service.setReview(review(files), CTX);
      said.push(await service.open({fileKey: 'README.md'}, trip));
      const notices = service.takeNotices();
      const dir = path.join(session, 'rendered');
      const written = fs.readdirSync(dir).filter((name) => name.endsWith('.html')).map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));

      // Every place a reason shows was reached.
      expect(said.at(-1)).toMatchObject({kind: 'error', message: expect.stringMatching(/^Preview and Review in browser turned off: page worker exited \(code 1\): Error: ENOENT/)});
      expect(notices).toEqual([`✗ ${said.at(-1)!.message}`]);
      expect(written.some((html) => html.includes('"kind":"failed"'))).toBe(true);
      expect(written.some((html) => html.includes('<title>All files · branch-review</title>') && html.includes("couldn't show · page worker exited"))).toBe(true);
      for (const text of [...said.map((outcome) => JSON.stringify(outcome)), ...notices, ...written]) {
        expect(text).not.toContain(os.homedir());
        expect(text).not.toMatch(/\/Users\/|\/home\/| {4}at /);
      }
      expect(said.at(-1)!.message).toContain("open '~/Projects/secret/notes.md'");
    } finally {
      backend.dispose();
    }
  }, 30_000);

  it('says nothing when an older press gives up after a newer page opened', async () => {
    const held = deferred<void>();
    const {backend} = scriptedBackend(async (request) => {
      if (request.path === 'docs/slow.md') await held.promise;
      return {ok: true, summary: summary()};
    });
    const {service, clock, trip} = openingService(backend);
    service.setReview(review([edited('docs/slow.md'), edited('docs/fast.md')]), CTX);
    let older: unknown = 'unsettled';
    void service.open({fileKey: 'docs/slow.md'}, trip).then((outcome) => {
      older = outcome;
    });
    expect(await service.open({fileKey: 'docs/fast.md'}, trip)).toMatchObject({kind: 'info', message: expect.stringMatching(/^⇗ fast\.md opened in the browser split/)});
    // slow.md's 5 s run out while fast.md's toast and page are on screen.
    await clock.advance(5_000);
    expect(older).toBeNull();
    held.resolve();
  });

  it('links an overview row only to a page written for the review as it is now', async () => {
    let round = 1;
    const held = deferred<FragmentResult>();
    const {backend} = scriptedBackend(
      (request) => (request.path === 'README.md' && round === 2 ? held.promise : {ok: true, summary: summary()}),
      (request) => (request.file.path === 'README.md' && round === 3
        ? {ok: false, state: 'error', reason: 'renderer crashed'}
        : {ok: true, html: `<p>${request.key} round ${round}</p>`, summary: summary()}),
    );
    const {service, clock, surface, trip} = openingService(backend);
    const row = (name: string) => {
      const html = fs.readFileSync(new URL(surface.shown.at(-1)!).pathname, 'utf8');
      return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]!).find((each) => each.includes(`>${name}<`))!;
    };
    const files = [edited('README.md'), edited('docs/guide.md')];
    service.setReview(review(files), CTX);
    await clock.advance(2_000);

    // A refresh with nothing new: every row still opens its page.
    service.setReview(review(files), CTX);
    await clock.advance(250);
    await service.openOverview(trip);
    expect(row('README.md')).toMatch(/^<a class="br-row br-row-modified" href="f-[0-9a-f]{20}\.html">/);
    expect(row('docs/guide.md')).toMatch(/^<a class="br-row br-row-modified" href="f-[0-9a-f]{20}\.html">/);

    // README is edited again, and its new render is still on its way: its
    // stable name still opens the first review's page, so its row has no link.
    round = 2;
    const edits = [edited('README.md', 'One.\n', 'One, edited again.\n'), edited('docs/guide.md')];
    service.setReview(review(edits), CTX);
    const waiting = service.openOverview(trip);
    await clock.advance(3_000);
    await waiting;
    expect(row('README.md')).toMatch(/^<div class="br-row br-row-modified br-row-none">/);
    expect(row('README.md')).not.toContain('href=');
    expect(row('README.md')).toContain('<span class="br-row-note">not ready yet</span>');
    held.resolve({ok: true, summary: summary()});
    await clock.advance(0);

    // The next review's page for README can't be written: its row says why,
    // and never opens the page an older review wrote.
    round = 3;
    service.setReview(review([edited('README.md', 'One.\n', 'One, edited a third time.\n'), edited('docs/guide.md')]), CTX);
    await clock.advance(250);
    await service.openOverview(trip);
    expect(row('README.md')).toMatch(/^<div class="br-row br-row-modified br-row-none">/);
    expect(row('README.md')).toContain('<span class="br-row-note">not ready yet · renderer crashed</span>');
    expect(row('docs/guide.md')).toMatch(/^<a class="br-row br-row-modified" href="f-[0-9a-f]{20}\.html">/);
  });

  it('writes a page opened before the other files rendered again once they have, so its rail counts them', async () => {
    const held = deferred<FragmentResult>();
    const {backend, pages} = scriptedBackend((request) => (request.path === 'docs/b.md' ? held.promise : {ok: true, summary: summary()}));
    const {service, clock} = openingService(backend);
    service.setReview(review([edited('docs/a.md'), edited('docs/b.md')]), CTX);
    // `r` on a.md in the first two seconds, before the background pass.
    const opened = await service.page('docs/a.md');
    const label = (request: PageRequest, file: string) => request.rail.find((entry) => entry.path === file)!.label;
    // b.md has no count yet, so the rail shows none: never `·`, which says it has no changes.
    expect(label(pages[0]!, 'docs/b.md')).toBe('');
    held.resolve({ok: true, summary: summary({changes: {changed: 12, removed: 0}})});
    await clock.advance(2_000);
    const newest = pages.filter((request) => request.file.path === 'docs/a.md').at(-1)!;
    expect(label(newest, 'docs/b.md')).toBe('12');
    // a.md's stable name opens the page with the count.
    const again = await service.page('docs/a.md');
    expect(again.ok && again.url).not.toBe(opened.ok && opened.url);
    expect(fs.readFileSync(new URL((again as {url: string}).url).pathname, 'utf8')).toBe(`<p>${newest.key}</p>`);
  });

  it('places nothing once disposed, and stops the surface', async () => {
    const held = deferred<FragmentResult>();
    const {backend} = scriptedBackend(() => held.promise);
    const {service, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md')]), CTX);
    const opening = service.open({fileKey: 'README.md'}, trip);
    await new Promise((resolve) => setImmediate(resolve));
    // `q` while the page renders: the session dir is about to go.
    service.dispose();
    expect(surface.disposed.count).toBe(1);
    held.resolve({ok: true, summary: summary()});
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

describe('the trip\'s hash', () => {
  const hashOf = (url: string) => url.slice(url.indexOf('#') + 1);
  const blocks = (...ids: string[]) => ids.map((id, index) => ({id, kind: 'p', lines: [index * 2 + 1, index * 2 + 1] as const}));

  it('opens a file\'s first visit with the full develop at the line under the reader\'s eyes, and a later one with the short revisit', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface, trip} = openingService(backend, {colors: {fg: '#e6e6e6', bg: '#000000'}});
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);

    await service.open({fileKey: 'docs/guide.md', line: 12, fraction: 0.35}, trip);
    await service.open({fileKey: 'docs/guide.md', line: 30, fraction: 0}, trip);
    await service.open({fileKey: 'README.md', line: 1, fraction: 0.5}, trip);
    expect(surface.shown.map(hashOf)).toEqual([
      'at=L12&f=0.35&d=full&m=1&bg=000000&fg=e6e6e6&n=1',
      'at=L30&f=0&d=short&m=1&bg=000000&fg=e6e6e6&n=2',
      'at=L1&f=0.5&d=full&m=1&bg=000000&fg=e6e6e6&n=3',
    ]);
    // The hash rides on the page the file names; the page is the same file.
    expect(new Set(surface.shown.slice(0, 2).map((url) => url.split('#')[0])).size).toBe(1);
  });

  it('counts a visit only once the page opened, and sends m=0 with --no-animations', async () => {
    const {backend} = scriptedBackend();
    const refused = openingService(backend, {surface: recordingSurface({answer: {refused: 'no browser opener found · branch-review --export-html <dir> writes the pages'}}), animations: false});
    refused.service.setReview(review([edited('README.md')]), CTX);
    await refused.clock.advance(2_000);
    await refused.service.open({fileKey: 'README.md'}, refused.trip);
    await refused.service.open({fileKey: 'README.md'}, refused.trip);
    expect(refused.surface.shown.map(hashOf)).toEqual(['d=full&m=0&n=1', 'd=full&m=0&n=2']);
  });

  it('sends no line to the review\'s first page when the active file has none', async () => {
    const {backend} = scriptedBackend();
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([diffFile('a\n', 'b\n', 'src/app.ts'), edited('docs/setup.md')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'src/app.ts', line: 40, fraction: 0.2}, trip);
    expect(surface.shown.map(hashOf)).toEqual(['d=full&m=1&n=1']);
  });

  it('sends the split a live refresh with the new blocks when the page shown changes, keeping its place, at most once a second', async () => {
    let ids = ['b-0000000a-0', 'b-0000000b-0'];
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(...ids)})}));
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md', line: 3, fraction: 0.25}, trip);
    expect(surface.refreshed).toEqual([]);

    // The agent rewrites a paragraph: one block is new.
    ids = ['b-0000000a-0', 'b-0000000c-0'];
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited again.\n')]), CTX);
    await clock.advance(250);
    expect(surface.refreshed.map(hashOf)).toEqual(['at=L3&f=0.25&d=none&m=1&g=b-0000000c-0&n=2']);
    const first = surface.refreshed[0]!.split('#')[0]!;
    expect(first).not.toBe(surface.shown[0]!.split('#')[0]);
    expect(fs.existsSync(new URL(first).pathname)).toBe(true);

    // Two more rewrites inside the second: the newest goes once the second is up.
    ids = ['b-0000000a-0', 'b-0000000c-0', 'b-0000000d-0'];
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, third.\n')]), CTX);
    await clock.advance(250);
    ids = ['b-0000000a-0', 'b-0000000c-0', 'b-0000000e-0'];
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, fourth.\n')]), CTX);
    await clock.advance(250);
    expect(surface.refreshed).toHaveLength(1);
    // A second after the first refresh, which went at 2250 ms.
    await clock.advance(499);
    expect(surface.refreshed).toHaveLength(1);
    await clock.advance(1);
    expect(surface.refreshed.map(hashOf)).toEqual(['at=L3&f=0.25&d=none&m=1&g=b-0000000c-0&n=2', 'at=L3&f=0.25&d=none&m=1&g=b-0000000e-0&n=3']);
    await clock.advance(5_000);
    expect(surface.refreshed).toHaveLength(2);
  });

  it('sends no live refresh for a page in the browser, nor after the overview took the split, nor once the split is gone', async () => {
    let text = 'One, edited.\n';
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(`b-${(text.length % 16).toString(16).padStart(8, '0')}-0`)})}));
    const edit = async (each: ReturnType<typeof openingService>, next: string) => {
      text = next;
      each.service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await each.clock.advance(2_000);
    };

    const browser = openingService(backend, {surface: recordingSurface({kind: 'browser', answer: {where: 'browser', message: 'opened in your browser'}})});
    await edit(browser, 'One, edited.\n');
    await browser.service.open({fileKey: 'docs/guide.md'}, browser.trip);
    await edit(browser, 'One, edited twice.\n');
    expect(browser.surface.refreshed).toEqual([]);

    const overview = openingService(backend);
    await edit(overview, 'One, edited.\n');
    await overview.service.open({fileKey: 'docs/guide.md'}, overview.trip);
    await overview.service.openOverview(overview.trip);
    await edit(overview, 'One, edited twice.\n');
    expect(overview.surface.refreshed).toEqual([]);

    const closed = openingService(backend, {surface: recordingSurface({refreshes: false})});
    await edit(closed, 'One, edited.\n');
    await closed.service.open({fileKey: 'docs/guide.md'}, closed.trip);
    await edit(closed, 'One, edited twice.\n');
    await edit(closed, 'One, edited three times.\n');
    // The split was closed: the first refresh says so, and none follows.
    expect(closed.surface.refreshed).toHaveLength(1);
  });

  it('sends no live refresh while a press is on its way, and sends one after it when the split still shows the old page', async () => {
    let ids = ['b-0000000a-0'];
    const {backend} = scriptedBackend((request) => ({ok: true, summary: summary({blocks: blocks(...(request.path === 'docs/guide.md' ? ids : ['b-0000000f-0']))})}));
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
    // The show the surface was asked for, once the page is written.
    const asked = async (count: number) => {
      for (let turn = 0; turn < 50 && answers.length < count; turn += 1) await clock.advance(0);
      return answers[count - 1]!;
    };
    const edit = async (next: string) => {
      service.setReview(review([edited('docs/guide.md', 'One.\n', next), edited('README.md')]), CTX);
      await clock.advance(2_000);
    };
    await edit('One, edited.\n');
    const first = service.open({fileKey: 'docs/guide.md', line: 1, fraction: 0}, trip);
    (await asked(1)).resolve({where: 'cmux-new', message: 'opened in the browser split'});
    await first;

    // The reader presses r on README.md while a pass rewrites the page in the split.
    const press = service.open({fileKey: 'README.md'}, trip);
    const pressed = await asked(2);
    ids = ['b-0000000b-0'];
    await edit('One, edited again.\n');
    expect(surface.refreshed).toEqual([]);
    pressed.resolve({where: 'cmux-reuse', message: 'opened in the browser split'});
    await press;
    await clock.advance(1_000);
    // The split shows README.md now: the old page's refresh is moot.
    expect(surface.refreshed).toEqual([]);
    expect(surface.shown.at(-1)).toMatch(/#d=full&m=1&n=2$/);

    // A press that places nothing leaves the split on the old page, and
    // the refresh due goes once it is over.
    const back = service.open({fileKey: 'docs/guide.md', line: 1, fraction: 0}, trip);
    (await asked(3)).resolve({where: 'cmux-reuse', message: 'opened in the browser split'});
    await back;
    const refused = service.open({fileKey: 'README.md'}, trip);
    const refusing = await asked(4);
    ids = ['b-0000000c-0'];
    await edit('One, edited a third time.\n');
    expect(surface.refreshed).toEqual([]);
    refusing.resolve({refused: 'no browser opener found · branch-review --export-html <dir> writes the pages'});
    await refused;
    await clock.advance(1_000);
    expect(surface.refreshed.map((url) => url.slice(url.indexOf('#') + 1))).toEqual(['at=L1&f=0&d=none&m=1&g=b-0000000c-0&n=5']);
  });

  it('sends no live refresh when a refresh leaves the page shown as it was', async () => {
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks('b-0000000a-0')})}));
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    service.setReview(review([edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);
    expect(surface.refreshed).toEqual([]);
  });

  it('sends no live refresh without watch mode', async () => {
    let ids = ['b-0000000a-0'];
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(...ids)})}));
    const {service, clock, surface, trip} = openingService(backend, {live: false});
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    // A review refreshed without watch mode: a background pass rewrites the page, and the split stays.
    ids = ['b-0000000a-0', 'b-0000000b-0'];
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited again.\n')]), CTX);
    await clock.advance(5_000);
    expect(surface.refreshed).toEqual([]);
  });

  it('sends no live refresh when only the rail of the page shown changed, after another file did', async () => {
    // README.md's render is slow: the guide's page opens while README.md is
    // still pending on its rail, and is written again once it answers.
    const slow = deferred<FragmentResult>();
    const {backend} = scriptedBackend((request) => (request.path === 'README.md' ? slow.promise : {ok: true, summary: summary({blocks: blocks('b-0000000a-0')})}));
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n'), edited('README.md', 'A.\n', 'B.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    const opened = new URL(surface.shown[0]!).pathname;
    slow.resolve({ok: true, summary: summary({changes: {changed: 3, removed: 0}})});
    await clock.advance(5_000);
    const now = await service.page('docs/guide.md');
    // The guide's page is another page now, its rail no longer pending; the guide didn't change.
    expect(now.ok && new URL(now.url).pathname).not.toBe(opened);
    expect(surface.refreshed).toEqual([]);
  });

  it('refreshes the split when an edit to another file breaks a link the page shows', async () => {
    let guideAnchors = ['user-content-setup'];
    const {backend} = scriptedBackend((request) => (request.path === 'README.md'
      ? {ok: true, summary: summary({blocks: blocks('b-0000000a-0'), links: [{href: 'docs/guide.md#setup', status: 'ok', line: 1, ref: {path: 'docs/guide.md', anchor: 'setup', index: 0}}], anchors: []})}
      : {ok: true, summary: summary({blocks: blocks('b-0000000b-0'), anchors: guideAnchors})}));
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md', 'A.\n', 'B.\n'), edited('docs/guide.md', '# Setup\n', '# Setup\n\nMore.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'README.md'}, trip);
    const opened = new URL(surface.shown[0]!).pathname;
    // The guide's heading is renamed: README.md's link to it is broken now.
    guideAnchors = ['user-content-installation'];
    service.setReview(review([edited('README.md', 'A.\n', 'B.\n'), edited('docs/guide.md', '# Setup\n', '# Installation\n\nMore.\n')]), CTX);
    await clock.advance(5_000);
    const now = await service.page('README.md');
    expect(now.ok && new URL(now.url).pathname).not.toBe(opened);
    expect(surface.refreshed).toHaveLength(1);
    expect(new URL(surface.refreshed[0]!).pathname).toBe(now.ok && new URL(now.url).pathname);
  });

  it('keeps refreshing the split after a refresh gave way to a newer one while cmux was slow to say what it shows', async () => {
    let ids = ['b-0000000a-0'];
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(...ids)})}));
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
    const edit = async (next: string, block: string) => {
      ids = ['b-0000000a-0', block];
      service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await clock.advance(1_100);
    };
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    const wait = firstUrl!;
    // The first refresh waits on cmux; a second edit's refresh comes in behind it.
    await edit('One, edited twice.\n', 'b-0000000b-0');
    await edit('One, edited three times.\n', 'b-0000000c-0');
    wait.resolve();
    for (let turn = 0; turn < 20; turn += 1) await clock.advance(0);
    expect(gotos).toHaveLength(1);
    expect(gotos[0]).toContain('g=b-0000000c-0&');
    // A later edit still goes: the split is compared with the page it shows.
    await edit('One, edited four times.\n', 'b-0000000d-0');
    for (let turn = 0; turn < 20; turn += 1) await clock.advance(0);
    expect(gotos).toHaveLength(2);
    expect(gotos[1]).toContain('g=b-0000000d-0');
  });

  it('names the pages the split may show for a live refresh, and tries again after one the split skipped', async () => {
    let ids = ['b-0000000a-0'];
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(...ids)})}));
    const surface = recordingSurface({refreshes: 'skipped'});
    const {service, clock, trip} = openingService(backend, {surface});
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md', line: 1, fraction: 0}, trip);
    const shownName = new URL(surface.shown[0]!).pathname.split('/').at(-1)!;
    const alias = (await service.page('docs/guide.md'));
    expect(alias.ok).toBe(true);

    ids = ['b-0000000a-0', 'b-0000000b-0'];
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited again.\n')]), CTX);
    await clock.advance(250);
    expect(surface.refreshed).toHaveLength(1);
    // The page the trip opened, by its own name or by the file's stable name.
    expect(surface.showing[0]).toEqual([shownName, expect.stringMatching(/^f-[0-9a-f]{20}\.html$/)]);

    // The split showed another page: the next change tries again, with
    // every block new since the page the split was sent.
    ids = ['b-0000000a-0', 'b-0000000b-0', 'b-0000000c-0'];
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, third.\n')]), CTX);
    await clock.advance(1_000);
    expect(surface.refreshed.map((url) => url.slice(url.indexOf('#') + 1))).toEqual([
      'at=L1&f=0&d=none&m=1&g=b-0000000b-0&n=2',
      'at=L1&f=0&d=none&m=1&g=b-0000000b-0,b-0000000c-0&n=3',
    ]);
    expect(surface.showing[1]).toEqual(surface.showing[0]);
  });
});

describe('live refreshes behind a goto cmux is slow to finish', () => {
  const blocks = (...ids: string[]) => ids.map((id, index) => ({id, kind: 'p', lines: [index * 2 + 1, index * 2 + 1] as const}));
  // cmux with an open split, whose first goto takes its time: the page it
  // sends lands once the goto ends.
  // `movedTo`: where the reader takes the split as the slow goto ends.
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
    let ids = ['b-0000000a-0'];
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(...ids)})}));
    const cmux = slowGotoCmux(movedTo);
    const {service, clock, trip} = openingService(backend, {surface: cmux.surface as unknown as ReturnType<typeof recordingSurface>});
    const settle = async () => {
      for (let turn = 0; turn < 40; turn += 1) await clock.advance(0);
    };
    const edit = async (next: string, block: string) => {
      ids = ['b-0000000a-0', block];
      service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await clock.advance(1_100);
    };
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    return {...cmux, clock, edit, settle};
  }

  it('sends the newest edit after the refresh whose goto was slow lands', async () => {
    const {gotos, release, edit, settle, clock} = await editing();
    await edit('One, edited twice.\n', 'b-0000000b-0');
    // The first refresh's goto is held; a second edit's refresh queues behind it.
    await edit('One, edited three times.\n', 'b-0000000c-0');
    release();
    await settle();
    await clock.advance(3_000);
    await settle();
    expect(gotos.map((url) => /g=([^&]*)/.exec(url)?.[1])).toEqual(['b-0000000b-0', 'b-0000000c-0']);
  });

  it('keeps the split on the newest edit as more edits come in behind the slow goto', async () => {
    const {gotos, release, edit, settle} = await editing();
    await edit('One, edited twice.\n', 'b-0000000b-0');
    await edit('One, edited three times.\n', 'b-0000000c-0');
    release();
    await settle();
    await edit('One, edited four times.\n', 'b-0000000d-0');
    await settle();
    expect(gotos.map((url) => /g=([^&]*)/.exec(url)?.[1])).toEqual(['b-0000000b-0', 'b-0000000c-0', 'b-0000000d-0']);
  });

  // Edits that keep each block they add: the page grows by one block an edit.
  async function growing() {
    let ids = ['b-0000000a-0'];
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(...ids)})}));
    const cmux = slowGotoCmux();
    const {service, clock, trip} = openingService(backend, {surface: cmux.surface as unknown as ReturnType<typeof recordingSurface>});
    const settle = async () => {
      for (let turn = 0; turn < 40; turn += 1) await clock.advance(0);
    };
    const edit = async (next: string, ...more: string[]) => {
      ids = ['b-0000000a-0', ...more];
      service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await clock.advance(1_100);
    };
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    return {...cmux, clock, edit, settle};
  }

  it('pulses only the blocks new since the slow goto\'s page when the edit behind it keeps that page\'s blocks', async () => {
    const {gotos, release, edit, settle, clock} = await growing();
    await edit('One, edited twice.\n', 'b-0000000b-0');
    // The second edit keeps b and adds c; its refresh queues behind the held goto.
    await edit('One, edited three times.\n', 'b-0000000b-0', 'b-0000000c-0');
    release();
    await settle();
    await clock.advance(3_000);
    await settle();
    expect(gotos.map((url) => /g=([^&]*)/.exec(url)?.[1])).toEqual(['b-0000000b-0', 'b-0000000c-0']);
  });

  it('still pulses every block new since the page the split shows when the refresh ahead of it was skipped', async () => {
    let ids = ['b-0000000a-0'];
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(...ids)})}));
    // cmux with an open split, whose first answer to which page it shows
    // takes its time and names a page of none of ours, while the split shows
    // the page the trip sent by the time it is asked again.
    let showing = '';
    let firstUrl: Deferred<void> | null = deferred<void>();
    const held = firstUrl;
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
          firstUrl = null;
          await held.promise;
          return {ok: true, stdout: 'file:///elsewhere/notes.html\n'};
        }
        return {ok: true, stdout: `${showing}\n`};
      }
      return {ok: false, timedOut: false, reason: 'exit 1'};
    };
    const surface = createSurface({env: {CMUX_WORKSPACE_ID: 'workspace:3'}, run, findTool: () => '/fake/bin/cmux', opener: () => undefined, platform: 'darwin'});
    const {service, clock, trip} = openingService(backend, {surface: surface as unknown as ReturnType<typeof recordingSurface>});
    const edit = async (next: string, ...more: string[]) => {
      ids = ['b-0000000a-0', ...more];
      service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await clock.advance(1_100);
    };
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    // The first refresh (b) is held while cmux says what the split shows; the
    // second (b and c) waits behind it, then the first is skipped.
    await edit('One, edited twice.\n', 'b-0000000b-0');
    await edit('One, edited three times.\n', 'b-0000000b-0', 'b-0000000c-0');
    held.resolve();
    for (let turn = 0; turn < 40; turn += 1) await clock.advance(0);
    expect(gotos.map((url) => /g=([^&]*)/.exec(url)?.[1])).toEqual(['b-0000000b-0,b-0000000c-0']);
  });

  it('keeps the page a refresh is about to show on disk until its goto ends, though newer pages of the file came since', async () => {
    let ids = ['b-0000000a-0'];
    const {backend} = scriptedBackend(() => ({ok: true, summary: summary({blocks: blocks(...ids)})}));
    const cmux = slowGotoCmux();
    const {service, clock, trip, dir} = openingService(backend, {surface: cmux.surface as unknown as ReturnType<typeof recordingSurface>});
    const settle = async () => {
      for (let turn = 0; turn < 40; turn += 1) await clock.advance(0);
    };
    const edit = async (next: string, wait: number, ...more: string[]) => {
      ids = ['b-0000000a-0', ...more];
      service.setReview(review([edited('docs/guide.md', 'One.\n', next)]), CTX);
      await clock.advance(wait);
      await settle();
    };
    const onDisk = (url: string) => fs.existsSync(fileURLToPath(url.replace(/#.*$/, '')));
    service.setReview(review([edited('docs/guide.md', 'One.\n', 'One, edited.\n')]), CTX);
    await clock.advance(2_000);
    await service.open({fileKey: 'docs/guide.md'}, trip);
    // The first refresh's goto is held; the second waits behind it, its page
    // named only once it goes.
    await edit('One, edited twice.\n', 1_100, 'b-0000000b-0');
    await edit('One, edited three times.\n', 1_100, 'b-0000000b-0', 'b-0000000c-0');
    // Two more edits inside the second: each a newer page, whose refresh
    // waits for the gap, and whose pass prunes the pages no one shows.
    await edit('One, edited four times.\n', 300, 'b-0000000d-0');
    await edit('One, edited five times.\n', 300, 'b-0000000e-0');
    cmux.release();
    await settle();
    expect(cmux.gotos).toHaveLength(2);
    expect(cmux.gotos.map((url) => path.dirname(fileURLToPath(url.replace(/#.*$/, ''))))).toEqual([dir, dir]);
    expect(cmux.gotos.map(onDisk)).toEqual([true, true]);
    // The newest page goes once the gap is up, and is on disk too.
    await clock.advance(1_500);
    await settle();
    expect(cmux.gotos).toHaveLength(3);
    expect(onDisk(cmux.gotos.at(-1)!)).toBe(true);
  });

  it('still skips the refresh when the reader moved the split to another page as the slow goto ended', async () => {
    const {gotos, release, edit, settle} = await editing('file:///elsewhere/notes.html');
    await edit('One, edited twice.\n', 'b-0000000b-0');
    await edit('One, edited three times.\n', 'b-0000000c-0');
    // The goto lands, and the reader follows a link inside the split: the
    // split shows a page that is none of ours, and the refresh behind is skipped.
    release();
    await settle();
    expect(gotos).toHaveLength(1);
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

describe('the whole branch', () => {
  const hero = () => imageFile(pngFixture(3, 2), pngFixture(4, 5), 'docs/hero.png');
  const embed = (imagePath: string, line: number) => ({path: imagePath, url: path.posix.basename(imagePath), line, status: 'embed' as const});

  it('gives an image a page of its own, shows where the review\'s markdown shows it, and names it img in the rail', async () => {
    const {backend, fragments, pages} = scriptedBackend((request) => ({ok: true, summary: request.kind
      ? summary({kind: 'image', changes: {changed: 0, removed: 0}, image: {before: {width: 3, height: 2, bytes: 70}, after: {width: 4, height: 5, bytes: 80}}})
      : summary({images: [embed('docs/hero.png', 18)]})}));
    const {service, clock} = serviceWith(backend);
    service.setReview(review([edited('README.md'), hero()]), CTX);
    expect(service.renderable('docs/hero.png')).toBe(true);
    await clock.advance(2_000);

    expect(fragments.find((each) => each.request.path === 'docs/hero.png')!.request).toMatchObject({kind: 'raster', groups: []});
    const imagePage = pages.find((page) => page.file.path === 'docs/hero.png')!;
    const readmeAlias = pages.find((page) => page.file.path === 'README.md')!.rail.find((entry) => entry.current)!.href;
    expect(imagePage.appears).toEqual([{path: 'README.md', line: 18, href: readmeAlias}]);
    expect(imagePage.rail.map((entry) => [entry.path, entry.label])).toEqual([['README.md', '1'], ['docs/hero.png', 'img']]);
    // A link to the image opens its page.
    expect(fragments.find((each) => each.request.path === 'README.md')!.request.links['docs/hero.png']).toEqual({kind: 'inReview', href: imagePage.rail.find((entry) => entry.current)!.href});
  });

  it('finds markdown outside the review that shows a changed image, renders it marked by its images, and lists those that do', async () => {
    const embedders: EmbeddersRequest[] = [];
    const {backend, fragments, pages} = scriptedBackend((request) => ({ok: true, summary: request.kind
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
    // The file whose render marked nothing shows no changed image: no page.
    expect(pages.map((page) => page.file.path)).toEqual(['README.md', 'docs/hero.png', 'CONTRIBUTING.md']);
    const contributing = pages.find((page) => page.file.path === 'CONTRIBUTING.md')!;
    expect(contributing.file.also).toEqual({embeds: ['docs/hero.png']});
    expect(contributing.rail.map((entry) => [entry.path, entry.label, entry.also ?? false])).toEqual([['README.md', '1', false], ['docs/hero.png', 'img', false], ['CONTRIBUTING.md', 'img', true]]);
    // The image's page says the page outside the review shows it.
    expect(pages.find((page) => page.file.path === 'docs/hero.png')!.appears).toEqual([{path: 'CONTRIBUTING.md', line: 3, href: contributing.rail.find((entry) => entry.current)!.href}]);

    // The overview lists it under its own heading.
    const overview = await service.openOverview();
    expect(overview).toEqual({kind: 'error', message: 'pages open only in the full app'});
  });

  it('lists a page that also looks different in the overview under its own heading', async () => {
    const {backend} = scriptedBackend((request) => ({ok: true, summary: request.kind
      ? summary({kind: 'image', changes: {changed: 0, removed: 0}})
      : request.path === 'CONTRIBUTING.md' ? summary({images: [embed('docs/hero.png', 3)]}) : summary()}));
    backend.embedders = async () => ({ok: true, files: [{path: 'CONTRIBUTING.md', oid: 'abc1234'}]});
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), hero()]), CTX);
    await clock.advance(2_000);

    expect(await service.openOverview(trip)).toMatchObject({kind: 'info'});
    const html = fs.readFileSync(new URL(surface.shown.at(-1)!).pathname, 'utf8');
    expect(html).toContain('<h2 class="br-group-title">Also looks different</h2>');
    expect(html).toMatch(/<span class="br-row-path">CONTRIBUTING\.md<\/span><span class="br-row-note">text unchanged · embeds docs\/hero\.png<\/span>/);
    expect(html).toContain('1 also looks different');
  });

  it('searches for a moved image by its old name too, and lists the markdown that still names it there', async () => {
    const embedders: EmbeddersRequest[] = [];
    const {backend, pages} = scriptedBackend((request) => ({ok: true, summary: request.kind
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
    expect(pages.find((page) => page.file.path === 'README.md')!.file.also).toEqual({embeds: ['docs/old.png']});
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

  it('renders the pages outside the review only in what the 40-file prerender has left', async () => {
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

  it('sends each page its part of the link report, and the overview every finding with its page', async () => {
    const guideLinks = [{href: 'README.md#nope', status: 'ok' as const, line: 4, ref: {path: 'README.md', anchor: 'user-content-nope', index: 0}}];
    const readmeLinks = [{href: 'gone.md', status: 'missing' as const, line: 2}];
    const {backend, pages} = scriptedBackend((request) => ({ok: true, summary: summary(request.path === 'README.md'
      ? {links: readmeLinks, anchors: ['user-content-readme'], images: [{path: 'Logo.png', url: 'Logo.png', line: 6, status: 'caseMismatch', hint: 'Logo.png vs logo.png'}]}
      : {links: guideLinks, anchors: []})}));
    const {service, clock, surface, trip} = openingService(backend);
    service.setReview(review([edited('README.md'), edited('docs/guide.md')]), CTX);
    await clock.advance(2_000);

    const guide = [...pages].reverse().find((page) => page.file.path === 'docs/guide.md')!;
    expect(guide.brokenRefs).toEqual([0]);
    expect(guide.report).toEqual({
      own: [{path: 'docs/guide.md', line: 4, target: 'README.md#nope', what: 'link', kind: 'badAnchor', reason: 'anchor not found'}],
      notes: ['2 links won\'t resolve', '1 image: case mismatch'],
    });
    const readme = [...pages].reverse().find((page) => page.file.path === 'README.md')!;
    expect(readme.brokenRefs).toBeUndefined();
    expect(readme.report!.own.map((finding) => finding.kind)).toEqual(['missing', 'caseMismatch']);

    await service.openOverview(trip);
    const html = fs.readFileSync(new URL(surface.shown.at(-1)!).pathname, 'utf8');
    expect(html).toContain('<h2 class="br-group-title">Won\'t render on GitHub</h2>');
    expect(html).toContain(`href="${readme.rail.find((entry) => entry.current)!.href}#at=L2&#x26;d=short"`);
    expect(html).toContain('<a class="br-findings" href="#br-findings" data-short="✗ 3">2 broken links · 1 image won\'t render</a>');
  });
});

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
