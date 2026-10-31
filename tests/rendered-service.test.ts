import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {DiffRange} from '../src/git.js';
import type {ReviewFile, ReviewModel} from '../src/review/model.js';
import type {FragmentRequest, FragmentResult, FragmentSummary, PageRequest, PageResult, RenderedBackend} from '../src/rendered/backend.js';
import {createRenderedService} from '../src/rendered/service.js';
import {createRenderedSite} from '../src/rendered/site.js';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';
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
    turnOff('rendered view turned off: timed out');
    service.setReview(review([edited('README.md')]), CTX);
    await clock.advance(2_000);
    expect(await service.page('README.md')).toEqual({ok: false, reason: 'rendered view turned off: timed out'});
    expect(service.takeNotices()).toEqual(['✗ rendered view turned off: timed out']);
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
      scripted.turnOff('rendered view turned off: timed out');
      return {ok: false, state: 'error', reason: 'timed out'};
    });
    const {service, clock} = serviceWith(scripted.backend);
    service.setReview(review([edited('a.md'), edited('b.md'), edited('c.md')]), CTX);
    await clock.advance(2_000);
    expect(service.takeNotices()).toEqual(['✗ rendered view turned off: timed out']);
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
    expect(await service.page('src/app.ts')).toEqual({ok: false, reason: 'no rendered page for this file'});
  });
});
