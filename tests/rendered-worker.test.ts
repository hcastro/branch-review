import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {createWorkerBackend} from '../src/media/workerClient.js';
import type {MediaBackend} from '../src/media/backend.js';
import type {SideRef} from '../src/media/types.js';
import type {FragmentRequest, RenderedBackend} from '../src/rendered/backend.js';
import {createRenderedBackend} from '../src/rendered/workerClient.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir, writeFiles} from './core-helpers.js';

// The rendered worker is supervised the way the media worker is, with its
// own deadlines and its own three strikes: one worker turning off leaves the
// other serving.

const backends: Array<MediaBackend | RenderedBackend> = [];
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
  cleanupTempDirs();
});

const SCRIPTED_RENDERED = fileURLToPath(new URL('./fixtures/scripted-rendered-worker.mjs', import.meta.url));
const SCRIPTED_MEDIA = fileURLToPath(new URL('./fixtures/scripted-media-worker.mjs', import.meta.url));
const HANGING_MEDIA = fileURLToPath(new URL('./fixtures/hanging-media-worker.mjs', import.meta.url));

const never = new AbortController().signal;

function sessionDir() {
  return makeTempDir('branch-review-media-test-');
}

function renderedFor(tempDir: string, options: Partial<Parameters<typeof createRenderedBackend>[0]> = {}) {
  const backend = createRenderedBackend({tempDir: () => tempDir, ...options});
  backends.push(backend);
  return backend;
}

function mediaFor(tempDir: string, options: Partial<Parameters<typeof createWorkerBackend>[0]> = {}) {
  const backend = createWorkerBackend({tempDir: () => tempDir, ...options});
  backends.push(backend);
  return backend;
}

function fragmentOf(cwd: string, file: string, overrides: Partial<FragmentRequest> = {}): FragmentRequest {
  return {
    cwd,
    key: `key-${file}`,
    path: file,
    status: 'modified',
    source: {kind: 'blob', id: 'abcdef1'},
    groups: [],
    links: {},
    assets: {base: null, after: {tree: 'HEAD'}, epoch: 0},
    ...overrides,
  };
}

const mediaSide = (file: string): SideRef => ({side: 'after', source: 'blob', path: file, abbrevId: 'abcdef1', key: `blob|${file}|abcdef1`});
const inspectOf = (cwd: string, file: string) => ({cwd, side: mediaSide(file), kind: 'raster' as const, format: 'png' as const});

type LogEntry = {event: 'start' | 'job'; pid: number; tmpdir?: string; type?: string; path?: string};
function renderedLog(tempDir: string): LogEntry[] {
  const file = path.join(tempDir, 'rendered-scripted.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the rendered worker client', {timeout: 60_000}, () => {
  it('turns the rendered view off after three missed deadlines, while the media worker keeps answering', async () => {
    const cwd = initRepo();
    const tempDir = sessionDir();
    const offReasons: string[] = [];
    const rendered = renderedFor(tempDir, {modulePath: SCRIPTED_RENDERED, deadlinesMs: {fragment: 300}, backoffMs: [50, 50, 50], onDisabled: (reason) => offReasons.push(reason)});
    const media = mediaFor(tempDir, {modulePath: SCRIPTED_MEDIA});

    for (let strike = 0; strike < 3; strike += 1) {
      expect(await rendered.fragment(fragmentOf(cwd, `hang-${strike}.md`), never)).toEqual({ok: false, state: 'error', reason: 'timed out'});
    }
    expect(rendered.disabledReason()).toBe('rendered view turned off: timed out');
    expect(offReasons).toEqual(['timed out']);
    // Off: answered at once, with no fourth worker.
    expect(await rendered.fragment(fragmentOf(cwd, 'answer.md'), never)).toEqual({ok: false, state: 'unavailable', reason: 'rendered view turned off: timed out'});
    expect(await rendered.page({key: 'k', title: {repo: 'r', base: 'main', branch: 'b', worktree: false, renderedAt: 0}, file: {path: 'answer.md', status: 'modified'}, rail: [], content: {body: {kind: 'empty'}}}, never))
      .toEqual({ok: false, state: 'unavailable', reason: 'rendered view turned off: timed out'});
    expect(renderedLog(tempDir).filter((entry) => entry.event === 'start')).toHaveLength(3);

    // The media worker never saw a strike and still answers.
    expect(await media.inspect(inspectOf(cwd, 'answer.png'), never)).toEqual({ok: false, state: 'error', reason: 'answered answer.png'});
    expect(media.disabledReason?.()).toBeNull();
  });

  it('keeps rendering after the media worker turned itself off', async () => {
    const cwd = initRepo();
    const tempDir = sessionDir();
    const media = mediaFor(tempDir, {modulePath: HANGING_MEDIA, deadlinesMs: {inspect: 300}, backoffMs: [50, 50, 50]});
    const rendered = renderedFor(tempDir, {modulePath: SCRIPTED_RENDERED});

    for (let strike = 0; strike < 3; strike += 1) await media.inspect(inspectOf(cwd, `hang-${strike}.png`), never);
    expect(media.disabledReason?.()).toBe('previews turned off: timed out');

    expect(await rendered.fragment(fragmentOf(cwd, 'answer.md'), never)).toMatchObject({ok: true, summary: {kind: 'rendered'}});
    expect(rendered.disabledReason()).toBeNull();
  });

  it('counts each worker\'s strikes on its own: two in each leaves both serving', async () => {
    const cwd = initRepo();
    const tempDir = sessionDir();
    const media = mediaFor(tempDir, {modulePath: HANGING_MEDIA, deadlinesMs: {inspect: 300}, backoffMs: [50, 50, 50]});
    const rendered = renderedFor(tempDir, {modulePath: SCRIPTED_RENDERED, deadlinesMs: {fragment: 300}, backoffMs: [50, 50, 50]});
    for (let strike = 0; strike < 2; strike += 1) {
      await media.inspect(inspectOf(cwd, `hang-${strike}.png`), never);
      await rendered.fragment(fragmentOf(cwd, `hang-${strike}.md`), never);
    }
    expect(media.disabledReason?.()).toBeNull();
    expect(rendered.disabledReason()).toBeNull();
    expect(await rendered.fragment(fragmentOf(cwd, 'answer.md'), never)).toMatchObject({ok: true});
  });

  it('sends a page ahead of queued fragments', async () => {
    const cwd = initRepo();
    const tempDir = sessionDir();
    const rendered = renderedFor(tempDir, {modulePath: SCRIPTED_RENDERED, deadlinesMs: {fragment: 20_000}});
    const ignore = () => undefined;
    // Both slots taken; the first frees when its answer comes back.
    const first = rendered.fragment(fragmentOf(cwd, 'answer-1.md'), never, 0);
    void rendered.fragment(fragmentOf(cwd, 'hang-2.md'), never, 0).then(ignore, ignore);
    void rendered.fragment(fragmentOf(cwd, 'hang-queued.md'), never, 0).then(ignore, ignore);
    const page = rendered.page({key: 'k', title: {repo: 'r', base: 'main', branch: 'b', worktree: false, renderedAt: 0}, file: {path: 'answer-page.md', status: 'modified'}, rail: [], content: {body: {kind: 'empty'}}}, never);

    await first;
    expect(await page).toMatchObject({ok: true, html: '<p>answer-page.md</p>'});
    const jobs = renderedLog(tempDir).filter((entry) => entry.event === 'job').map((entry) => entry.path);
    expect(jobs.slice(0, 3)).toEqual(['answer-1.md', 'hang-2.md', 'answer-page.md']);
  });

  it('sends a queued fragment next once it is moved to the front', async () => {
    const cwd = initRepo();
    const tempDir = sessionDir();
    const rendered = renderedFor(tempDir, {modulePath: SCRIPTED_RENDERED, deadlinesMs: {fragment: 20_000}});
    const ignore = () => undefined;
    const first = rendered.fragment(fragmentOf(cwd, 'answer-1.md'), never, 0);
    void rendered.fragment(fragmentOf(cwd, 'hang-2.md'), never, 0).then(ignore, ignore);
    void rendered.fragment(fragmentOf(cwd, 'hang-near.md'), never, 1).then(ignore, ignore);
    const late = new AbortController();
    const wanted = rendered.fragment(fragmentOf(cwd, 'answer-far.md'), late.signal, 2);
    rendered.prioritize(late.signal, 0);

    await first;
    expect(await wanted).toMatchObject({ok: true});
    const jobs = renderedLog(tempDir).filter((entry) => entry.event === 'job').map((entry) => entry.path);
    expect(jobs.slice(0, 3)).toEqual(['answer-1.md', 'hang-2.md', 'answer-far.md']);
  });

  it('points the rendered worker\'s temp files at its own dir in the session dir', async () => {
    const cwd = initRepo();
    const tempDir = sessionDir();
    const rendered = renderedFor(tempDir, {modulePath: SCRIPTED_RENDERED});
    await rendered.fragment(fragmentOf(cwd, 'answer.md'), never);
    expect(renderedLog(tempDir).find((entry) => entry.event === 'start')?.tmpdir).toBe(path.join(tempDir, 'rendered-worker'));
  });

  it('runs the rendered worker from the published bundle', async () => {
    // A bundle built fresh next to the repo's packages, as the CLI ships.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const build = makeTempDir('branch-review-bundle-');
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(build, 'node_modules'));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(build, 'package.json'));
    const tsup = spawnSync(path.join(root, 'node_modules/.bin/tsup'), ['--out-dir', path.join(build, 'dist'), '--silent'], {cwd: root, encoding: 'utf8', timeout: 60_000});
    expect(tsup.status, tsup.stderr).toBe(0);

    const cwd = initRepo({'doc.md': '# Bundled\n'});
    const id = git(cwd, 'rev-parse', 'HEAD:doc.md').trim();
    const rendered = renderedFor(sessionDir(), {modulePath: path.join(build, 'dist/renderedWorker.js')});
    const result = await rendered.fragment(fragmentOf(cwd, 'doc.md', {source: {kind: 'blob', id}}), never);
    expect(result).toMatchObject({ok: true, summary: {kind: 'rendered', headings: [{depth: 1, text: 'Bundled'}]}});
  });

  it('runs the real rendered worker from source, which renders a committed file', async () => {
    const cwd = initRepo({'doc.md': '# Title\n\nHello.\n'});
    writeFiles(cwd, {'doc.md': '# Title\n\nHello, edited.\n'});
    commitAll(cwd, 'edit');
    const id = git(cwd, 'rev-parse', 'HEAD:doc.md').trim();
    const rendered = renderedFor(sessionDir());
    const groups = [{id: 'g0', kind: 'modified' as const, after: [3, 3] as const, base: [3, 3] as const, anchorLine: 3, removedLines: ['Hello.']}];
    const result = await rendered.fragment(fragmentOf(cwd, 'doc.md', {source: {kind: 'blob', id}, groups, assets: {base: 'HEAD~1', after: {tree: 'HEAD'}, epoch: 0}}), never);
    expect(result).toMatchObject({ok: true, summary: {kind: 'rendered', changes: {changed: 1, removed: 0}, headings: [{depth: 1, text: 'Title'}]}});
  });
});
