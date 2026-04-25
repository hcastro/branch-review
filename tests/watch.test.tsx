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
  getRepoWatchPaths,
  isIgnoredWatchPath,
  type CreateRepoWatcherOptions,
} from '../src/watch/repoWatcher.js';
import {formatWatchFooterStatus, ReviewController} from '../src/ui/ReviewController.js';

const tempDirs: string[] = [];

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

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('watch helpers', () => {
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

  it('ignores generated and dependency paths', () => {
    expect(isIgnoredWatchPath('/repo/.git/index', '/repo')).toBe(true);
    expect(isIgnoredWatchPath('/repo/node_modules/react/index.js', '/repo')).toBe(true);
    expect(isIgnoredWatchPath('/repo/dist/cli.js', '/repo')).toBe(true);
    expect(isIgnoredWatchPath('/repo/src/cli.tsx', '/repo')).toBe(false);
    expect(isIgnoredWatchPath('/repo/packages/app/lib/source.ts', '/repo')).toBe(false);
  });

  it('builds shallow watch paths from tracked repo directories', () => {
    const cwd = createRepo();

    expect(getRepoWatchPaths(cwd)).toEqual(expect.arrayContaining([
      cwd,
      path.join(cwd, 'src'),
      path.join(cwd, 'packages', 'app', 'lib'),
    ]));
  });

  it('includes narrow Git state paths for commit and index refreshes', () => {
    const cwd = createRepo();

    expect(getGitStateWatchPaths(cwd)).toEqual(expect.arrayContaining([
      path.join(cwd, '.git', 'HEAD'),
      path.join(cwd, '.git', 'index'),
      path.join(cwd, '.git', 'logs', 'HEAD'),
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
    fs.writeFileSync(path.join(cwd, 'packages', 'app', 'lib', 'cold.ts'), 'export const cold = 2;\n');

    await expect(Promise.race([
      changed.then(() => 'changed'),
      flush(1000).then(() => 'timeout'),
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
      flush(1000).then(() => 'timeout'),
    ])).resolves.toBe('changed');

    await watcher.close();
  });
});

describe('ReviewController watch refresh', () => {
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
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain('watching');

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
    expect(frame).not.toContain('watching');

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
});
