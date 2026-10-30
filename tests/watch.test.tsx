import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import stripAnsi from 'strip-ansi';
import {render} from 'ink-testing-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {resolveRefs, getReviewFingerprint, type DiffRange} from '../src/git.js';
import type {ReviewModel} from '../src/review/model.js';
import {debounce} from '../src/watch/debounce.js';
import {
  createRepoWatcher,
  getGitStateWatchPaths,
  type CreateRepoWatcherOptions,
} from '../src/watch/repoWatcher.js';
import {formatWatchFooterStatus, getModelWidth, ReviewController} from '../src/ui/ReviewController.js';
import {buildFixture, decodePlaceholders, fakeMediaService, KITTY_CAPS, parseApc, pngFixture, sideInfo, svgMediaFile} from './ui-fixtures.js';
import type {MediaBackend} from '../src/media/backend.js';
import {createMediaService} from '../src/media/service.js';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function runGit(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-watch-'));
  tempDirs.push(cwd);

  runGit(cwd, 'init', '-b', 'development');
  runGit(cwd, 'config', 'user.name', 'Test User');
  runGit(cwd, 'config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 1;\n');
  fs.mkdirSync(path.join(cwd, 'packages', 'app', 'lib'), {recursive: true});
  fs.writeFileSync(path.join(cwd, 'packages', 'app', 'lib', 'cold.ts'), 'export const cold = 1;\n');
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-m', 'initial');

  runGit(cwd, 'checkout', '-b', 'feature/watch');
  fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-m', 'change one');

  return cwd;
}

function reviewModel(files: Array<{path: string; text: string}>): ReviewModel {
  return {
    base: 'development',
    branch: 'HEAD + worktree',
    label: 'development...HEAD + worktree',
    metrics: {
      filesChanged: files.length,
      additions: files.length,
      deletions: 0,
      changedLines: files.length,
    },
    files: files.map((file) => ({
      path: file.path,
      status: 'modified',
      metrics: {path: file.path, additions: 1, deletions: 0, changedLines: 1},
      rawDiff: '',
      renderedLines: [file.text],
      blocks: [],
    })),
  };
}

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFrame(instance: {lastFrame: () => string | undefined}, predicate: (frame: string) => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let frame = stripAnsi(instance.lastFrame() ?? '');
  while (!predicate(frame) && Date.now() < deadline) {
    await flush(25);
    frame = stripAnsi(instance.lastFrame() ?? '');
  }
  return frame;
}

function fakeWatcherFactory() {
  const watchers: Array<{options: CreateRepoWatcherOptions; close: ReturnType<typeof vi.fn>}> = [];
  const createWatcher = vi.fn((options: CreateRepoWatcherOptions) => {
    const close = vi.fn(async () => undefined);
    watchers.push({options, close});
    return {close};
  });
  return {
    createWatcher,
    watchers,
    get current() {
      const latest = watchers.at(-1);
      if (!latest) throw new Error('no watcher created');
      return latest;
    },
  };
}

function installFakeGit(script: string) {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {encoding: 'utf8'}).trim();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-fake-git-'));
  tempDirs.push(binDir);
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\n${script.replaceAll('$REAL_GIT', realGit)}\n`, {mode: 0o755});
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
}

async function hoverFrameText(frame: string, text: string) {
  const lines = frame.split('\n');
  const row = lines.findIndex((line) => line.includes(text));
  expect(row).toBeGreaterThanOrEqual(0);
  const column = lines[row]?.indexOf(text) ?? -1;
  expect(column).toBeGreaterThanOrEqual(0);

  for (const delta of [-1, 1, 2, 0]) {
    process.stdin.emit('data', `\u001B[<35;${column + delta + 1};${row + 1}M`);
    await flush();
  }
}

afterEach(() => {
  vi.useRealTimers();
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('watch helpers', {timeout: 20_000}, () => {
  it('debounces bursty events into one callback', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 200);

    debounced();
    debounced();
    debounced();
    vi.advanceTimersByTime(199);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('includes narrow Git state paths for commit and index refreshes', () => {
    const cwd = createRepo();

    expect(getGitStateWatchPaths(cwd)).toEqual(expect.arrayContaining([
      path.join(cwd, '.git', 'HEAD'),
      path.join(cwd, '.git', 'index'),
      path.join(cwd, '.git', 'logs', 'HEAD'),
    ]));
  });

  it('includes remote ref paths for push and fetch refreshes', () => {
    const cwd = createRepo();
    runGit(cwd, 'update-ref', 'refs/remotes/origin/development', 'development');

    // The whole refs and logs/refs trees are watched, which covers
    // refs/remotes and logs/refs/remotes along with every local branch.
    expect(getGitStateWatchPaths(cwd)).toEqual(expect.arrayContaining([
      path.join(cwd, '.git', 'refs'),
      path.join(cwd, '.git', 'logs', 'refs'),
    ]));
  });

  it('formats quiet footer state', () => {
    expect(formatWatchFooterStatus({state: 'watching'}, 1000)).toBeUndefined();
    expect(formatWatchFooterStatus({state: 'refreshing'}, 1000)).toBe('refreshing...');
    expect(formatWatchFooterStatus({state: 'watching', lastUpdatedAt: 1000}, 1000)).toBe('updated now');
    expect(formatWatchFooterStatus({state: 'watching', lastUpdatedAt: 1000}, 2200)).toBe('updated 1s ago');
    expect(formatWatchFooterStatus({state: 'watching', lastUpdatedAt: 1000}, 3200)).toBeUndefined();
  });

  it('changes the Git fingerprint when an existing worktree file changes', () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const before = getReviewFingerprint(cwd, range);

    fs.writeFileSync(path.join(cwd, 'packages', 'app', 'lib', 'cold.ts'), 'export const cold = 2;\n');

    expect(getReviewFingerprint(cwd, range)).not.toBe(before);
  });

  it('fires when an unchanged tracked file is edited under a nested lib folder', async () => {
    const cwd = createRepo();
    let resolveReady: () => void = () => {};
    let resolveChange: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = createRepoWatcher({
      repoRoot: cwd,
      debounceMs: 20,
      onReady: resolveReady,
      onChange: resolveChange,
    });

    await ready;
    // FSEvents can fold a write made right after the stream starts into the
    // file's creation event, so let the stream settle before editing.
    await flush(150);
    fs.writeFileSync(path.join(cwd, 'packages', 'app', 'lib', 'cold.ts'), 'export const cold = 2;\n');

    await expect(Promise.race([
      changed.then(() => 'changed'),
      flush(5000).then(() => 'timeout'),
    ])).resolves.toBe('changed');

    await watcher.close();
  });

  it('fires when a staged worktree change is committed', async () => {
    const cwd = createRepo();
    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 3;\n');
    runGit(cwd, 'add', 'src/one.ts');

    let resolveReady: () => void = () => {};
    let resolveChange: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = createRepoWatcher({
      repoRoot: cwd,
      debounceMs: 20,
      onReady: resolveReady,
      onChange: resolveChange,
    });

    await ready;
    runGit(cwd, 'commit', '-m', 'commit watched change');

    await expect(Promise.race([
      changed.then(() => 'changed'),
      flush(5000).then(() => 'timeout'),
    ])).resolves.toBe('changed');

    await watcher.close();
  });

  it('fires when a remote-tracking ref moves', async () => {
    const cwd = createRepo();
    runGit(cwd, 'update-ref', 'refs/remotes/origin/development', 'development');

    let resolveReady: () => void = () => {};
    let resolveChange: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = createRepoWatcher({
      repoRoot: cwd,
      debounceMs: 20,
      onReady: resolveReady,
      onChange: resolveChange,
    });

    await ready;
    runGit(cwd, 'update-ref', 'refs/remotes/origin/development', 'HEAD');

    await expect(Promise.race([
      changed.then(() => 'changed'),
      flush(5000).then(() => 'timeout'),
    ])).resolves.toBe('changed');

    await watcher.close();
  });
});

// These build temp repos and run git synchronously, which can pass vitest's
// 5 s default on a loaded machine.
describe('ReviewController watch refresh', {timeout: 20_000}, () => {
  it('skips rebuilds when Git fingerprint is unchanged and refreshes after repo changes', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const initialReview = reviewModel([{path: 'src/one.ts', text: 'initial one'}]);
    const refreshedReview = reviewModel([
      {path: 'src/one.ts', text: 'initial one'},
      {path: 'src/two.ts', text: 'refreshed two'},
    ]);
    const buildReview = vi.fn(() => refreshedReview);
    let triggerChange: (() => void) | undefined;
    const createWatcher = vi.fn((options: CreateRepoWatcherOptions) => {
      triggerChange = options.onChange;
      return {close: vi.fn(async () => undefined)};
    });

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range as DiffRange}
        initialReview={initialReview}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        buildReview={buildReview}
        createWatcher={createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toMatch(/refreshing|updated|watch error/);

    triggerChange?.();
    await flush(10);
    expect(buildReview).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(cwd, 'src', 'two.ts'), 'export const two = true;\n');
    triggerChange?.();
    await flush(10);

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(buildReview).toHaveBeenCalledTimes(1);
    expect(frame).toContain('two.ts');
    expect(frame).toContain('refreshed two');
    expect(frame).toContain('updated');
    expect(frame).not.toContain('refreshing...');

    instance.unmount();
  });

  it('re-resolves HEAD ranges so commits shrink worktree review', async () => {
    const cwd = createRepo();
    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 3;\n');

    const initialRange = resolveRefs(cwd, 'HEAD', 'HEAD');
    const initialReview = reviewModel([{path: 'src/one.ts', text: 'worktree change'}]);
    const emptyReview = reviewModel([]);
    const buildReview = vi.fn((_options: {cwd: string; range: DiffRange; width: number}) => emptyReview);
    let refreshedRange: DiffRange | undefined;
    let triggerChange: (() => void) | undefined;
    const createWatcher = vi.fn((options: CreateRepoWatcherOptions) => {
      triggerChange = options.onChange;
      return {close: vi.fn(async () => undefined)};
    });

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={initialRange}
        resolveRange={() => resolveRefs(cwd, 'HEAD', 'HEAD')}
        initialReview={initialReview}
        initialFingerprint={getReviewFingerprint(cwd, initialRange)}
        watch
        buildReview={(options) => {
          refreshedRange = options.range;
          return buildReview(options);
        }}
        createWatcher={createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('worktree change');

    runGit(cwd, 'add', 'src/one.ts');
    runGit(cwd, 'commit', '-m', 'commit watched change');
    triggerChange?.();
    await flush(10);

    expect(buildReview).toHaveBeenCalledTimes(1);
    expect(refreshedRange?.diffArg).toBe(runGit(cwd, 'rev-parse', 'HEAD'));
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('No changes to review');

    instance.unmount();
  });

  it('re-resolves remote bases so pushed changes leave the default review', async () => {
    const cwd = createRepo();
    runGit(cwd, 'update-ref', 'refs/remotes/origin/development', 'development');

    const initialRange = resolveRefs(cwd, 'HEAD', 'origin/development');
    const initialReview = reviewModel([{path: 'src/one.ts', text: 'unpushed branch change'}]);
    const emptyReview = reviewModel([]);
    const buildReview = vi.fn((_options: {cwd: string; range: DiffRange; width: number}) => emptyReview);
    let refreshedRange: DiffRange | undefined;
    let triggerChange: (() => void) | undefined;
    const createWatcher = vi.fn((options: CreateRepoWatcherOptions) => {
      triggerChange = options.onChange;
      return {close: vi.fn(async () => undefined)};
    });

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={initialRange}
        resolveRange={() => resolveRefs(cwd, 'HEAD', 'origin/development')}
        initialReview={initialReview}
        initialFingerprint={getReviewFingerprint(cwd, initialRange)}
        watch
        buildReview={(options) => {
          refreshedRange = options.range;
          return buildReview(options);
        }}
        createWatcher={createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('unpushed branch change');

    runGit(cwd, 'update-ref', 'refs/remotes/origin/development', 'HEAD');
    triggerChange?.();
    await flush(10);

    expect(buildReview).toHaveBeenCalledTimes(1);
    expect(refreshedRange?.diffArg).toBe(runGit(cwd, 'rev-parse', 'HEAD'));
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('No changes to review');

    instance.unmount();
  });

  it('runs one refresh when the watcher is ready, to catch changes made before it was listening', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const initialFingerprint = getReviewFingerprint(cwd, range);
    fs.writeFileSync(path.join(cwd, 'src', 'two.ts'), 'export const two = true;\n');
    const buildReview = vi.fn(() => reviewModel([
      {path: 'src/one.ts', text: 'initial one'},
      {path: 'src/two.ts', text: 'written before ready'},
    ]));
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={initialFingerprint}
        watch
        buildReview={buildReview}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    expect(buildReview).not.toHaveBeenCalled();

    watchers.current.options.onReady?.();
    await flush(10);

    expect(buildReview).toHaveBeenCalledTimes(1);
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('written before ready');

    instance.unmount();
  });

  it('rebuilds on the first change when started without a fingerprint', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    // The initial review was built before this file appeared.
    fs.writeFileSync(path.join(cwd, 'src', 'two.ts'), 'export const two = true;\n');
    const buildReview = vi.fn(() => reviewModel([
      {path: 'src/one.ts', text: 'initial one'},
      {path: 'src/two.ts', text: 'written during startup'},
    ]));
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        watch
        buildReview={buildReview}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    watchers.current.options.onChange();
    await flush(10);

    expect(buildReview).toHaveBeenCalledTimes(1);
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('written during startup');

    instance.unmount();
  });

  it('keeps the watcher and rebuilds at the new width when the terminal resizes', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const buildReview = vi.fn((_options: {cwd: string; range: DiffRange; width: number}) => reviewModel([
      {path: 'src/one.ts', text: 'rebuilt one'},
    ]));
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        buildReview={buildReview}
        createWatcher={watchers.createWatcher}
      />,
    );

    await flush();
    expect(watchers.createWatcher).toHaveBeenCalledTimes(1);

    Object.defineProperty(instance.stdout, 'columns', {value: 200, configurable: true});
    instance.stdout.emit('resize');
    const deadline = Date.now() + 5000;
    while (buildReview.mock.calls.length === 0 && Date.now() < deadline) await flush(25);
    // Let any second, unwanted rebuild or watcher recreation show up.
    await flush(300);

    expect(watchers.createWatcher).toHaveBeenCalledTimes(1);
    expect(watchers.current.close).not.toHaveBeenCalled();
    expect(buildReview).toHaveBeenCalledTimes(1);
    expect(buildReview.mock.calls[0]?.[0].width).toBe(getModelWidth(200));

    instance.unmount();
  });

  it('rebuilds at the new width through the refresh worker when the terminal resizes, keeping the watcher', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const fingerprint = getReviewFingerprint(cwd, range);
    const refreshInWorker = vi.fn(async (_options: {width: number; previousFingerprint?: string | null}) => ({
      range,
      fingerprint,
      branchName: 'feature/watch',
      review: reviewModel([{path: 'src/one.ts', text: 'rebuilt one'}]),
    }));
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={fingerprint}
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        refreshInWorker={refreshInWorker}
        createWatcher={watchers.createWatcher}
      />,
    );

    await flush();
    expect(watchers.createWatcher).toHaveBeenCalledTimes(1);

    Object.defineProperty(instance.stdout, 'columns', {value: 200, configurable: true});
    instance.stdout.emit('resize');
    const frame = await waitForFrame(instance, (text) => text.includes('rebuilt one'), 5000);
    // Let any second, unwanted rebuild or watcher recreation show up.
    await flush(300);

    expect(frame).toContain('rebuilt one');
    expect(watchers.createWatcher).toHaveBeenCalledTimes(1);
    expect(watchers.current.close).not.toHaveBeenCalled();
    expect(refreshInWorker).toHaveBeenCalledTimes(1);
    // The fingerprint did not move, so only a forced rebuild picks up the width.
    expect(refreshInWorker.mock.calls[0]?.[0]).toMatchObject({width: getModelWidth(200), previousFingerprint: null});

    instance.unmount();
  });

  it('keeps the last view when a worker refresh fails and refreshes again on the next change', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const fingerprint = getReviewFingerprint(cwd, range);
    const calls: Array<string | null | undefined> = [];
    const refreshInWorker = vi.fn(async (options: {previousFingerprint?: string | null}) => {
      calls.push(options.previousFingerprint);
      if (calls.length === 1) {
        throw Object.assign(new Error('Command failed: git diff'), {stderr: 'fatal: simulated diff failure\n'});
      }
      return {
        range,
        fingerprint: 'after-error',
        branchName: 'feature/watch',
        review: reviewModel([{path: 'src/two.ts', text: 'recovered two'}]),
      };
    });
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={fingerprint}
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        refreshInWorker={refreshInWorker}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    watchers.current.options.onChange();
    let frame = await waitForFrame(instance, (text) => text.includes('watch error'), 5000);
    expect(frame).toContain('watch error: fatal: simulated diff failure');
    expect(frame).toContain('initial one');

    watchers.current.options.onChange();
    frame = await waitForFrame(instance, (text) => text.includes('recovered two') && !text.includes('refreshing'), 5000);
    expect(frame).toContain('recovered two');
    expect(frame).toContain('updated');
    expect(frame).not.toContain('watch error');
    expect(calls).toEqual([fingerprint, fingerprint]);

    instance.unmount();
  });

  it('starts a fresh refresh for a change that arrived while a refresh failed', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const refreshInWorker = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('refresh timed out after 30s')), 50);
      }))
      .mockImplementationOnce(async () => ({
        range,
        fingerprint: 'after-timeout',
        branchName: 'feature/watch',
        review: reviewModel([{path: 'src/two.ts', text: 'landed after timeout'}]),
      }));
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        refreshInWorker={refreshInWorker}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    watchers.current.options.onChange();
    await flush(10);
    for (let index = 0; index < 5; index += 1) watchers.current.options.onChange();

    const frame = await waitForFrame(instance, (text) => text.includes('landed after timeout'), 10_000);
    expect(refreshInWorker).toHaveBeenCalledTimes(2);
    expect(frame).toContain('landed after timeout');
    expect(frame).not.toContain('watch error');

    instance.unmount();
  });

  it('aborts the in-flight refresh on unmount', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    let refreshSignal: AbortSignal | undefined;
    const refreshInWorker = vi.fn((options: {signal?: AbortSignal}) => {
      refreshSignal = options.signal;
      return new Promise<never>(() => {});
    });
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        refreshInWorker={refreshInWorker}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    watchers.current.options.onChange();
    await flush(10);
    expect(refreshInWorker).toHaveBeenCalledTimes(1);
    expect(refreshSignal?.aborted).toBe(false);

    instance.unmount();
    await flush();
    expect(refreshSignal?.aborted).toBe(true);
  });

  it('starts no refresh process when unmounted right after a change', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const refreshInWorker = vi.fn(() => new Promise<never>(() => {}));
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        refreshInWorker={refreshInWorker}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    // Unmount inside the refresh's start-up yield.
    watchers.current.options.onChange();
    instance.unmount();
    await flush(50);

    expect(refreshInWorker).not.toHaveBeenCalled();
  });

  it('keeps asking for a full rebuild after a resize refresh fails, and stops once one lands', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const fingerprint = getReviewFingerprint(cwd, range);
    const calls: Array<string | null | undefined> = [];
    let failNext = true;
    const refreshInWorker = vi.fn(async (options: {previousFingerprint?: string | null}) => {
      calls.push(options.previousFingerprint);
      if (failNext) {
        failNext = false;
        throw new Error('refresh timed out: no progress for 30s');
      }
      return {
        range,
        fingerprint,
        branchName: 'feature/watch',
        review: reviewModel([{path: 'src/one.ts', text: 'rebuilt one'}]),
      };
    });
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={fingerprint}
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        refreshInWorker={refreshInWorker}
        createWatcher={watchers.createWatcher}
      />,
    );

    await flush();
    Object.defineProperty(instance.stdout, 'columns', {value: 200, configurable: true});
    instance.stdout.emit('resize');
    await waitForFrame(instance, (text) => text.includes('refresh timed out'), 5000);
    expect(calls).toEqual([null]);

    // The width still differs from the last build, so the next refresh must
    // rebuild rather than trust the fingerprint.
    watchers.current.options.onChange();
    await waitForFrame(instance, (text) => text.includes('rebuilt one'), 5000);
    expect(calls).toEqual([null, null]);

    watchers.current.options.onChange();
    const deadline = Date.now() + 5000;
    while (calls.length < 3 && Date.now() < deadline) await flush(25);
    expect(calls).toEqual([null, null, fingerprint]);

    instance.unmount();
  });

  it("shows git's reason when a refresh fails", async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const buildReview = vi.fn(() => {
      runGit(cwd, 'rev-parse', '--verify', 'no-such-ref');
      return reviewModel([]);
    });
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        buildReview={buildReview}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    fs.writeFileSync(path.join(cwd, 'src', 'two.ts'), 'export const two = true;\n');
    watchers.current.options.onChange();
    await flush(10);

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('watch error: fatal: Needed a single revision');
    expect(frame).toContain('initial one');

    instance.unmount();
  });

  it('keeps the last view on a failed refresh and recovers on the next change', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const buildReview = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('delta: simulated failure');
      })
      .mockImplementationOnce(() => reviewModel([{path: 'src/two.ts', text: 'recovered two'}]));
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        buildReview={buildReview}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    fs.writeFileSync(path.join(cwd, 'src', 'two.ts'), 'export const two = true;\n');
    watchers.current.options.onChange();
    await flush(10);

    let frame = stripAnsi(instance.lastFrame() ?? '');
    expect(frame).toContain('watch error: delta: simulated failure');
    expect(frame).toContain('initial one');

    watchers.current.options.onChange();
    await flush(10);

    frame = stripAnsi(instance.lastFrame() ?? '');
    expect(buildReview).toHaveBeenCalledTimes(2);
    expect(frame).toContain('recovered two');
    expect(frame).not.toContain('watch error');

    instance.unmount();
  });

  it('keeps a watcher error on screen after a successful refresh', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const buildReview = vi.fn(() => reviewModel([{path: 'src/two.ts', text: 'refreshed two'}]));
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        buildReview={buildReview}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 16}}
      />,
    );

    await flush();
    watchers.current.options.onError?.(new Error('EMFILE: attach failed'));
    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('watch error: EMFILE: attach failed');

    fs.writeFileSync(path.join(cwd, 'src', 'two.ts'), 'export const two = true;\n');
    watchers.current.options.onChange();
    await flush(10);

    const frame = stripAnsi(instance.lastFrame() ?? '');
    expect(buildReview).toHaveBeenCalledTimes(1);
    expect(frame).toContain('refreshed two');
    expect(frame).toContain('watch error: EMFILE: attach failed');

    instance.unmount();
  });

  it('updates the current-branch tooltip after a checkout', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        buildReview={vi.fn(() => reviewModel([{path: 'src/one.ts', text: 'initial one'}]))}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 160, rows: 16}}
      />,
    );

    await flush();
    runGit(cwd, 'checkout', '-b', 'feature/renamed');
    watchers.current.options.onChange();
    await flush(10);

    await hoverFrameText(stripAnsi(instance.lastFrame() ?? ''), 'worktree');
    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).toContain('current branch feature/renamed');

    instance.unmount();
  });
});

describe('ReviewController with the real refresh worker', () => {
  it('refreshes through the worker process against a real repo', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 30}}
      />,
    );

    await flush();
    fs.writeFileSync(path.join(cwd, 'src', 'worker-made.ts'), 'export const fromWorker = true;\n');
    watchers.current.options.onChange();

    const frame = await waitForFrame(instance, (text) => text.includes('worker-made.ts') && !text.includes('refreshing'));
    expect(frame).toContain('worker-made.ts');
    expect(frame).toContain('fromWorker');
    expect(frame).not.toContain('watch error');

    instance.unmount();
  }, 30_000);

  it('keeps the last view when the worker fails and recovers on the next change', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const watchers = fakeWatcherFactory();

    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviewModel([{path: 'src/one.ts', text: 'initial one'}])}
        initialFingerprint={getReviewFingerprint(cwd, range)}
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 30}}
      />,
    );

    await flush();
    installFakeGit('for arg in "$@"; do case "$arg" in merge-base) echo "fatal: simulated merge-base failure" >&2; exit 128;; esac; done\nexec "$REAL_GIT" "$@"');
    watchers.current.options.onChange();
    let frame = await waitForFrame(instance, (text) => text.includes('watch error'));
    process.env.PATH = originalPath;
    expect(frame).toContain('watch error: fatal: simulated merge-base failure');
    expect(frame).toContain('initial one');

    fs.writeFileSync(path.join(cwd, 'src', 'worker-made.ts'), 'export const fromWorker = true;\n');
    watchers.current.options.onChange();
    frame = await waitForFrame(instance, (text) => text.includes('worker-made.ts') && !text.includes('refreshing'));
    expect(frame).toContain('worker-made.ts');
    expect(frame).not.toContain('watch error');

    instance.unmount();
  }, 30_000);
});

// A review with one added PNG (content id `pngId`) and a text file whose drawn
// line names the review's version, so a frame tells which review it shows.
function mediaReview(pngId: string | null, version: string): ReviewModel {
  const files: ReviewModel['files'] = [{
    path: 'src/one.ts',
    status: 'modified',
    metrics: {path: 'src/one.ts', additions: 1, deletions: 0, changedLines: 1},
    rawDiff: '',
    renderedLines: [`review ${version}`],
    blocks: [],
  }];
  if (pngId) {
    files.push({
      path: 'docs/logo.png',
      status: 'added',
      metrics: {path: 'docs/logo.png', additions: 0, deletions: 0, changedLines: 0},
      rawDiff: `diff --git a/docs/logo.png b/docs/logo.png\nnew file mode 100644\nindex 0000000..${pngId}\nBinary files /dev/null and b/docs/logo.png differ\n`,
      renderedLines: ['binary file changed'],
      blocks: [],
    });
  }
  return {base: 'development', branch: 'HEAD', label: 'development...HEAD', metrics: {filesChanged: files.length, additions: 1, deletions: 0, changedLines: 1}, files};
}

describe('ReviewController with media previews', {timeout: 20_000}, () => {
  async function mediaController(reviews: ReviewModel[], sides: NonNullable<Parameters<typeof fakeMediaService>[0]>['sides'], options: NonNullable<Parameters<typeof fakeMediaService>[0]> = {}) {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const watchers = fakeWatcherFactory();
    let refreshes = 0;
    const refreshInWorker = vi.fn(async () => {
      refreshes += 1;
      return {range, fingerprint: `media-${refreshes}`, branchName: 'feature/watch', review: reviews[refreshes]!};
    });
    const media = fakeMediaService({sides, ...options});
    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={reviews[0]!}
        initialFingerprint="media-0"
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        refreshInWorker={refreshInWorker}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 30}}
        media={media.service}
      />,
    );
    return {instance, watchers, media};
  }

  const idsIn = (frame: string | undefined) => [...new Set(decodePlaceholders(frame).map((cell) => cell.id))];

  it('gives a rewritten PNG a new id, never shows the old id with the new review, and deletes the old one', async () => {
    const sides = {aaaaaaa: sideInfo({width: 200, height: 100}), bbbbbbb: sideInfo({width: 200, height: 100})};
    const {instance, watchers, media} = await mediaController([mediaReview('aaaaaaa', 'v1'), mediaReview('bbbbbbb', 'v2'), mediaReview(null, 'v3')], sides);

    await waitForFrame(instance, () => idsIn(instance.lastFrame()).length === 1);
    const [first] = idsIn(instance.lastFrame());

    watchers.current.options.onChange();
    await waitForFrame(instance, (text) => text.includes('review v2') && idsIn(instance.lastFrame()).length === 1 && idsIn(instance.lastFrame())[0] !== first);
    const [second] = idsIn(instance.lastFrame());
    expect(second).not.toBe(first);
    for (const frame of instance.frames) {
      if (stripAnsi(frame).includes('review v2')) expect(idsIn(frame)).not.toContain(first);
    }
    const deletes = () => parseApc(media.graphicsWrites).filter((command) => command.a === 'd');
    expect(deletes()).toEqual([{a: 'd', d: 'I', i: first, q: 2, payloadBytes: 0}]);
    expect(parseApc(media.graphicsWrites).filter((command) => command.a === 't').map((command) => command.i)).toEqual([first, second]);

    // The file leaves the review: its id is deleted too.
    watchers.current.options.onChange();
    await waitForFrame(instance, (text) => text.includes('review v3') && !text.includes('refreshing'));
    await flush(20);
    expect(deletes().map((command) => command.i)).toEqual([first, second]);
    expect(idsIn(instance.lastFrame())).toEqual([]);

    instance.unmount();
  });

  it('sends nothing new when a refresh leaves the PNG unchanged', async () => {
    const sides = {aaaaaaa: sideInfo({width: 200, height: 100})};
    const {instance, watchers, media} = await mediaController([mediaReview('aaaaaaa', 'v1'), mediaReview('aaaaaaa', 'v2')], sides);
    await waitForFrame(instance, () => idsIn(instance.lastFrame()).length === 1);
    const [id] = idsIn(instance.lastFrame());
    const sent = media.graphicsWrites.length;

    watchers.current.options.onChange();
    await waitForFrame(instance, (text) => text.includes('review v2') && !text.includes('refreshing'));
    await flush(20);
    expect(idsIn(instance.lastFrame())).toEqual([id]);
    expect(media.graphicsWrites).toHaveLength(sent);
    expect(media.calls.filter((call) => call.type === 'inspect')).toHaveLength(1);

    instance.unmount();
  });

  it('asks again about a picture caught mid-write when a refresh finds the same fingerprint', async () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const watchers = fakeWatcherFactory();
    const model = mediaReview('aaaaaaa', 'v1');
    // The file was rewritten with the bytes it had: same id, same fingerprint.
    const refreshInWorker = vi.fn(async () => ({range, fingerprint: 'media-0', branchName: 'feature/watch', review: model}));
    let inspects = 0;
    const backend: MediaBackend = {
      async inspect() {
        inspects += 1;
        return inspects === 1
          ? {ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true}
          : {ok: true, info: sideInfo({width: 200, height: 100})};
      },
      async render(request) {
        const {cols, rows, cellPx} = request.target;
        return {ok: true, png: pngFixture(cols * cellPx.w, rows * cellPx.h)};
      },
      exportCopy: async () => ({ok: false, state: 'error', reason: 'not used'}),
      dispose() {},
    };
    const media = createMediaService({caps: KITTY_CAPS, backend, sink: {write: () => undefined}, opener: () => undefined, env: {}});
    const instance = render(
      <ReviewController
        cwd={cwd}
        range={range}
        initialReview={model}
        initialFingerprint="media-0"
        watch
        requestedBranch="HEAD"
        requestedBase="development"
        refreshInWorker={refreshInWorker}
        createWatcher={watchers.createWatcher}
        dimensions={{columns: 120, rows: 30}}
        media={media}
      />,
    );
    await waitForFrame(instance, (text) => text.includes('changed on disk · refreshing'));

    watchers.current.options.onChange();
    await waitForFrame(instance, () => idsIn(instance.lastFrame()).length === 1);
    expect(refreshInWorker).toHaveBeenCalledTimes(1);
    expect(inspects).toBe(2);
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain('changed on disk');

    instance.unmount();
    media.dispose();
  });

  it('keeps the compare mode and the flip side through a refresh of the file on screen', async () => {
    const modifiedReview = (afterId: string, version: string): ReviewModel => {
      const model = mediaReview(null, version);
      model.files.unshift({
        path: 'docs/logo.png',
        status: 'modified',
        metrics: {path: 'docs/logo.png', additions: 0, deletions: 0, changedLines: 0},
        rawDiff: `diff --git a/docs/logo.png b/docs/logo.png\nindex aaaaaaa..${afterId} 100644\nBinary files a/docs/logo.png and b/docs/logo.png differ\n`,
        renderedLines: ['binary file changed'],
        blocks: [],
      });
      return model;
    };
    const sides = {aaaaaaa: sideInfo({width: 100, height: 100}), bbbbbbb: sideInfo({width: 200, height: 100}), ccccccc: sideInfo({width: 200, height: 100})};
    const {instance, watchers} = await mediaController([modifiedReview('bbbbbbb', 'v1'), modifiedReview('ccccccc', 'v2')], sides);
    await waitForFrame(instance, (text) => text.includes('[1 Side by side]') && idsIn(instance.lastFrame()).length === 2);

    instance.stdin.write('2');
    await waitForFrame(instance, (text) => text.includes('after · 2 or click swaps'));
    instance.stdin.write('2');
    await waitForFrame(instance, (text) => text.includes('before · 2 or click swaps'));

    watchers.current.options.onChange();
    const frame = await waitForFrame(instance, (text) => text.includes('review v2') && !text.includes('refreshing') && idsIn(instance.lastFrame()).length === 1);
    expect(frame).toContain('[2 Flip]');
    expect(frame).toContain('before · 2 or click swaps');

    instance.unmount();
  });

  it('keeps the view and the flip side on a swapped picture when a refresh adds lines to the file above it', async () => {
    const reviewWith = (lines: number, version: string): ReviewModel => {
      const model = mediaReview(null, version);
      model.files[0]!.renderedLines = [`review ${version}`, ...Array.from({length: lines - 1}, (_, index) => `review ${version} line ${index + 1}`)];
      // The top bar shows the count, so a test can see the refresh land.
      model.metrics.additions = lines;
      model.files.push({
        path: 'docs/logo.png',
        status: 'modified',
        metrics: {path: 'docs/logo.png', additions: 0, deletions: 0, changedLines: 0},
        rawDiff: 'diff --git a/docs/logo.png b/docs/logo.png\nindex aaaaaaa..bbbbbbb 100644\nBinary files a/docs/logo.png and b/docs/logo.png differ\n',
        renderedLines: ['binary file changed'],
        blocks: [],
      });
      return model;
    };
    const sides = {aaaaaaa: sideInfo({width: 100, height: 100}), bbbbbbb: sideInfo({width: 200, height: 100})};
    const {instance, watchers} = await mediaController([reviewWith(3, 'v1'), reviewWith(20, 'v2')], sides);
    await waitForFrame(instance, (text) => text.includes('file 1/2') && idsIn(instance.lastFrame()).length === 2);

    instance.stdin.write('\u001B[B');
    await waitForFrame(instance, (text) => text.includes('file 2/2') && text.includes('[1 Side by side]'));
    // Keys read the active file from the handler the drawn frame installs.
    await flush(5);
    instance.stdin.write('2');
    await waitForFrame(instance, (text) => text.includes('after · 2 or click swaps'));
    instance.stdin.write('2');
    await waitForFrame(instance, (text) => text.includes('before · 2 or click swaps'));

    // The lines above shift the picture down; the view follows it, and a
    // refresh is no move to another file, so the picture stays swapped.
    watchers.current.options.onChange();
    const frame = await waitForFrame(instance, (text) => text.includes('• +20 •') && !text.includes('refreshing'), 5_000);
    expect(frame).toContain('• +20 •');
    await flush(20);
    const last = stripAnsi(instance.lastFrame() ?? '');
    expect(last).toContain('file 2/2');
    expect(last).toContain('[2 Flip]');
    expect(last).toContain('before · 2 or click swaps');

    instance.unmount();
  });

  it('ignores 2 again while flip shows one side alone, so the after side shows once both draw', async () => {
    const modifiedReview = (afterId: string, version: string): ReviewModel => {
      const model = mediaReview(null, version);
      model.files.unshift({
        path: 'docs/logo.png',
        status: 'modified',
        metrics: {path: 'docs/logo.png', additions: 0, deletions: 0, changedLines: 0},
        rawDiff: `diff --git a/docs/logo.png b/docs/logo.png\nindex aaaaaaa..${afterId} 100644\nBinary files a/docs/logo.png and b/docs/logo.png differ\n`,
        renderedLines: ['binary file changed'],
        blocks: [],
      });
      return model;
    };
    const sides = {aaaaaaa: sideInfo({width: 100, height: 100}), bbbbbbb: {error: 'could not decode image'}, ccccccc: sideInfo({width: 200, height: 100})};
    const {instance, watchers} = await mediaController([modifiedReview('bbbbbbb', 'v1'), modifiedReview('ccccccc', 'v2')], sides);
    await waitForFrame(instance, (text) => text.includes('before · after: could not decode image') && idsIn(instance.lastFrame()).length === 1);

    instance.stdin.write('2');
    await waitForFrame(instance, (text) => text.includes('[2 Flip]'));
    // The before side shows alone: 2 again has nothing to swap.
    instance.stdin.write('2');

    // The after side is fixed on disk; flip opens on it, as it would have
    // had both sides drawn from the start.
    watchers.current.options.onChange();
    const frame = await waitForFrame(instance, (text) => text.includes('review v2') && !text.includes('refreshing') && text.includes('2 or click swaps'));
    expect(frame).toContain('after · 2 or click swaps');

    instance.unmount();
  });

  it('shows a failing backend as a reason row while the refresh status stays fine', async () => {
    const {instance, watchers} = await mediaController(
      [mediaReview('aaaaaaa', 'v1'), mediaReview('bbbbbbb', 'v2')],
      {aaaaaaa: sideInfo(), bbbbbbb: {error: 'media worker exited (signal SIGSEGV)'}},
    );
    await waitForFrame(instance, () => idsIn(instance.lastFrame()).length === 1);

    watchers.current.options.onChange();
    const frame = await waitForFrame(instance, (text) => text.includes('review v2') && text.includes('media worker exited (signal SIGSEGV)') && !text.includes('refreshing'));
    expect(frame).toContain('updated');
    expect(frame).not.toContain('watch error');
    expect(idsIn(instance.lastFrame())).toEqual([]);

    instance.unmount();
  });

  // A review with an added SVG with one source hunk of three lines, then a
  // text file whose one line names the version.
  function svgReview(version: string, svgId: string, tag = '') {
    return buildFixture([
      svgMediaFile('docs/flow.svg', {ids: ['0000000', svgId], tag, size: 3}),
      {path: 'src/one.ts', rawDiff: '', rendered: [`review ${version}`]},
    ]).review;
  }
  const svgSides = {aaaa111: sideInfo({format: 'svg', width: 200, height: 100, hasAlpha: true}), bbbb222: sideInfo({format: 'svg', width: 200, height: 100, hasAlpha: true})};

  it('keeps an SVG source block the reader unfolded open through three refreshes of other files', async () => {
    const reviews = ['v1', 'v2', 'v3', 'v4'].map((version) => svgReview(version, 'aaaa111'));
    const {instance, watchers} = await mediaController(reviews, svgSides);
    await waitForFrame(instance, (text) => text.includes('▸ docs/flow.svg:1 · 3 lines folded') && decodePlaceholders(instance.lastFrame()).length > 0);
    instance.stdin.write('\r');
    await waitForFrame(instance, (text) => text.includes('▾ docs/flow.svg:1:'));

    for (const version of ['v2', 'v3', 'v4']) {
      watchers.current.options.onChange();
      await waitForFrame(instance, (text) => text.includes(`review ${version}`) && !text.includes('refreshing'));
      await flush(10);
      const text = stripAnsi(instance.lastFrame() ?? '');
      expect(text, version).toContain(`review ${version}`);
      expect(text, version).toContain('▾ docs/flow.svg:1:');
      expect(text, version).toContain('h0-2');
      expect(text, version).not.toContain('lines folded');
    }
    instance.unmount();
  });

  it('folds an SVG source block again when the SVG changes', async () => {
    const {instance, watchers} = await mediaController([svgReview('v1', 'aaaa111'), svgReview('v2', 'bbbb222', 'b')], svgSides);
    await waitForFrame(instance, (text) => text.includes('▸ docs/flow.svg:1 · 3 lines folded'));
    await flush(5);
    instance.stdin.write('\r');
    await waitForFrame(instance, (text) => text.includes('h0-2'));

    watchers.current.options.onChange();
    const text = await waitForFrame(instance, (frame) => frame.includes('review v2') && !frame.includes('refreshing'));
    expect(text).toContain('▸ docs/flow.svg:1 · 3 lines folded');
    expect(text).not.toContain('h0-2');
    instance.unmount();
  });
});
