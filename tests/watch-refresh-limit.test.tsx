import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {render} from 'ink-testing-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {DiffRange} from '../src/git.js';
import type {ReviewModel} from '../src/review/model.js';
import {refreshReviewInWorker} from '../src/review/workerRefresh.js';
import type {CreateRepoWatcherOptions} from '../src/watch/repoWatcher.js';
import {ReviewController} from '../src/ui/ReviewController.js';

// Refreshes through the real refresh process, under the default 30 s
// no-progress limit unless a test sets one, and checks that a forced rebuild
// stays owed until one lands. The per-file and many-files cases are covered
// with a tighter limit in watch-worker.test.ts.

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function runGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createRepo(files: Record<string, string>) {
  const cwd = makeTempDir('branch-review-limit-');
  runGit(cwd, 'init', '-q', '-b', 'development');
  for (const [relativePath, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, relativePath)), {recursive: true});
    fs.writeFileSync(path.join(cwd, relativePath), text);
  }
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-q', '-m', 'initial');
  runGit(cwd, 'checkout', '-q', '-b', 'feature/limit');
  return cwd;
}

function fakeGitBinDir(script: string) {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {encoding: 'utf8'}).trim();
  const binDir = makeTempDir('branch-review-fake-git-');
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\n${script.replaceAll('$REAL_GIT', realGit)}\n`, {mode: 0o755});
  return binDir;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await flush(50);
  }
  return check();
}

const placeholderReview: ReviewModel = {
  base: 'development',
  branch: 'HEAD + worktree',
  label: 'development...HEAD + worktree',
  metrics: {filesChanged: 0, additions: 0, deletions: 0, changedLines: 0},
  files: [],
};

type Outcome = {previousFingerprint: string | null | undefined; result?: {fingerprint: string; built: boolean}; error?: string};

/**
 * Mounts the controller on `cwd` with the real refresh process, and records
 * what each refresh was asked and how it ended.
 */
function mountController(cwd: string, timeoutMs?: number) {
  const outcomes: Outcome[] = [];
  let watcher: CreateRepoWatcherOptions | null = null;
  const createWatcher = vi.fn((options: CreateRepoWatcherOptions) => {
    watcher = options;
    return {close: async () => undefined};
  });
  const refreshInWorker: typeof refreshReviewInWorker = async (options) => {
    const outcome: Outcome = {previousFingerprint: options.previousFingerprint};
    outcomes.push(outcome);
    try {
      const result = await refreshReviewInWorker({...options, ...(timeoutMs === undefined ? {} : {timeoutMs})});
      outcome.result = {fingerprint: result.fingerprint, built: result.review !== undefined};
      return result;
    } catch (error) {
      outcome.error = (error as Error).message;
      throw error;
    }
  };
  const range: DiffRange = {base: 'development', branch: 'HEAD', diffArg: 'development', includeWorktree: true};

  const instance = render(
    <ReviewController
      cwd={cwd}
      range={range}
      initialReview={placeholderReview}
      initialFingerprint="before the change"
      watch
      requestedBranch="HEAD"
      requestedBase="development"
      refreshInWorker={refreshInWorker}
      createWatcher={createWatcher}
    />,
  );

  return {
    outcomes,
    // A new width makes the next refresh a full rebuild.
    resize(columns: number) {
      Object.defineProperty(instance.stdout, 'columns', {value: columns, configurable: true});
      instance.stdout.emit('resize');
    },
    change() {
      watcher!.onChange();
    },
    async settled(count: number, timeoutMs: number) {
      return waitFor(() => outcomes.length >= count && outcomes.slice(0, count).every((outcome) => outcome.result || outcome.error), timeoutMs);
    },
    unmount: () => instance.unmount(),
  };
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

describe('refresh progress limit on large reviews', () => {
  it('lands a forced rebuild with one 20 MB added file, then trusts the fingerprint', async () => {
    const cwd = createRepo({'a.txt': 'a\n'});
    let body = '';
    for (let index = 0; index < 250_000; index += 1) {
      body += `export const value${index} = { id: ${index}, name: "item ${index}", tags: ["a", "b"] };\n`;
    }
    fs.writeFileSync(path.join(cwd, 'big.ts'), body);
    expect(body.length).toBeGreaterThan(20_000_000);

    const controller = mountController(cwd);
    await flush();
    controller.resize(200);
    expect(await controller.settled(1, 240_000)).toBe(true);
    expect(controller.outcomes[0]).toMatchObject({previousFingerprint: null, result: {built: true}});

    controller.change();
    expect(await controller.settled(2, 240_000)).toBe(true);
    expect(controller.outcomes[1]).toMatchObject({
      previousFingerprint: controller.outcomes[0].result!.fingerprint,
      result: {built: false},
    });

    controller.unmount();
  }, 600_000);

  it('kills a git that hangs with no output at the limit, and still rebuilds on the next change', async () => {
    const cwd = createRepo({'src/one.ts': 'export const one = 1;\n', 'src/hang.ts': 'export const hang = 1;\n'});
    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const one = 2;\n');
    fs.writeFileSync(path.join(cwd, 'src', 'hang.ts'), 'export const hang = 2;\n');
    const pidFile = path.join(makeTempDir('branch-review-pids-'), 'git.pid');
    // Any git call that names hang.ts records its pid and hangs silently.
    const binDir = fakeGitBinDir(`case "$*" in *hang.ts*) echo $$ > '${pidFile}'; exec sleep 60;; esac\nexec "$REAL_GIT" "$@"`);

    const controller = mountController(cwd, 5000);
    await flush();
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
    controller.resize(200);
    let gitPid = 0;
    try {
      expect(await controller.settled(1, 60_000)).toBe(true);
      expect(controller.outcomes[0]).toEqual({previousFingerprint: null, error: 'refresh timed out: no progress for 5s'});
      gitPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(await waitFor(() => !isAlive(gitPid), 3000)).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (gitPid && isAlive(gitPid)) process.kill(gitPid, 'SIGKILL');
    }

    // The failed rebuild is still owed.
    controller.change();
    expect(await controller.settled(2, 60_000)).toBe(true);
    expect(controller.outcomes[1]).toMatchObject({previousFingerprint: null, result: {built: true}});

    controller.change();
    expect(await controller.settled(3, 60_000)).toBe(true);
    expect(controller.outcomes[2]).toMatchObject({
      previousFingerprint: controller.outcomes[1].result!.fingerprint,
      result: {built: false},
    });

    controller.unmount();
  }, 300_000);
});
