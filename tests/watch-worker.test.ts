import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {getReviewFingerprint, resolveRefs} from '../src/git.js';
import {refreshReviewInWorker} from '../src/review/workerRefresh.js';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalNodeOptions = process.env.NODE_OPTIONS;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function createRepo() {
  const cwd = makeTempDir('branch-review-worker-');
  runGit(cwd, 'init', '-q', '-b', 'development');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 1;\n');
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-q', '-m', 'initial');
  runGit(cwd, 'checkout', '-q', '-b', 'feature/watch');
  fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
  runGit(cwd, 'commit', '-q', '-am', 'change one');
  return cwd;
}

function fakeGitBinDir(script: string) {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {encoding: 'utf8'}).trim();
  const binDir = makeTempDir('branch-review-fake-git-');
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\n${script.replaceAll('$REAL_GIT', realGit)}\n`, {mode: 0o755});
  return binDir;
}

// The refresh process reads PATH when it starts, so the fake only has to be
// in place while refreshReviewInWorker spawns it.
function withPath<T>(binDir: string, start: () => T): T {
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  try {
    return start();
  } finally {
    process.env.PATH = originalPath;
  }
}

function currentFingerprint(cwd: string) {
  return getReviewFingerprint(cwd, resolveRefs(cwd, 'HEAD', 'development'));
}

async function settleWithin<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise.then(
      (value) => ({state: 'resolved' as const, value}),
      (error: unknown) => ({state: 'rejected' as const, error: error as Error}),
    ),
    new Promise<{state: 'pending'}>((resolve) => setTimeout(() => resolve({state: 'pending'}), ms)),
  ]);
}

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalNodeOptions === undefined) {
    delete process.env.NODE_OPTIONS;
  } else {
    process.env.NODE_OPTIONS = originalNodeOptions;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('refreshReviewInWorker', () => {
  it('loads the refresh worker from the source tree and skips the rebuild when nothing changed', async () => {
    const cwd = createRepo();
    const fingerprint = currentFingerprint(cwd);

    const result = await settleWithin(refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      previousFingerprint: fingerprint,
    }), 15_000);

    expect(result.state === 'rejected' ? result.error.message : result.state).toBe('resolved');
    if (result.state !== 'resolved') return;
    expect(result.value.fingerprint).toBe(fingerprint);
    expect(result.value.review).toBeUndefined();
    expect(result.value.branchName).toBe('feature/watch');
  }, 20_000);

  it('rejects with a timeout when the refresh never finishes', async () => {
    const cwd = createRepo();
    // Each git call takes 10 s, so anything that settles well before that
    // came from the timeout.
    const binDir = fakeGitBinDir('sleep 10\nexec "$REAL_GIT" "$@"');

    const startedAt = Date.now();
    const result = await settleWithin(withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      timeoutMs: 500,
    })), 7000);

    expect(result.state).toBe('rejected');
    if (result.state !== 'rejected') return;
    expect(result.error.message).toMatch(/refresh timed out/);
    expect(Date.now() - startedAt).toBeLessThan(7000);
  }, 20_000);

  it('lets a slow refresh that finishes under the timeout land', async () => {
    const cwd = createRepo();
    const fingerprint = currentFingerprint(cwd);
    const binDir = fakeGitBinDir('sleep 0.1\nexec "$REAL_GIT" "$@"');

    const startedAt = Date.now();
    const result = await settleWithin(withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      previousFingerprint: fingerprint,
      timeoutMs: 20_000,
    })), 20_000);

    expect(result.state === 'rejected' ? result.error.message : result.state).toBe('resolved');
    if (result.state !== 'resolved') return;
    expect(result.value.fingerprint).toBe(fingerprint);
    // Slower than the timeout in the test above, so that timeout is not what
    // a normal slow refresh runs into.
    expect(Date.now() - startedAt).toBeGreaterThan(500);
  }, 30_000);

  it('rejects when the refresh process exits without answering', async () => {
    const cwd = createRepo();
    const preloadDir = makeTempDir('branch-review-preload-');
    const preload = path.join(preloadDir, 'exit.cjs');
    fs.writeFileSync(preload, 'process.exit(3);\n');

    process.env.NODE_OPTIONS = `--require ${preload}`;
    let pending: Promise<unknown>;
    try {
      pending = refreshReviewInWorker({cwd, requestedBranch: 'HEAD', requestedBase: 'development', width: 100});
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions;
      }
    }

    const result = await settleWithin(pending, 5000);
    expect(result.state).toBe('rejected');
    if (result.state !== 'rejected') return;
    expect(result.error.message).toMatch(/refresh worker exited with code 3/);
  }, 10_000);

  it('passes git stderr through on failure', async () => {
    const cwd = createRepo();
    const binDir = fakeGitBinDir('for arg in "$@"; do case "$arg" in merge-base) echo "fatal: simulated merge-base failure" >&2; exit 128;; esac; done\nexec "$REAL_GIT" "$@"');

    const result = await settleWithin(withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
    })), 15_000);

    expect(result.state).toBe('rejected');
    if (result.state !== 'rejected') return;
    expect(String((result.error as Error & {stderr?: string}).stderr)).toContain('fatal: simulated merge-base failure');
  }, 20_000);

  it('stops the refresh when aborted', async () => {
    const cwd = createRepo();
    const binDir = fakeGitBinDir('sleep 10\nexec "$REAL_GIT" "$@"');
    const controller = new AbortController();

    const pending = withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      signal: controller.signal,
    }));
    setTimeout(() => controller.abort(), 300);

    const startedAt = Date.now();
    const result = await settleWithin(pending, 7000);
    expect(result.state).toBe('rejected');
    expect(Date.now() - startedAt).toBeLessThan(7000);
  }, 20_000);

  it('does not keep the process alive after an aborted refresh', () => {
    const cwd = createRepo();
    const binDir = fakeGitBinDir('sleep 20\nexec "$REAL_GIT" "$@"');
    const probeDir = makeTempDir('branch-review-probe-');
    const probe = path.join(probeDir, 'probe.mjs');
    const workerRefreshUrl = new URL('../src/review/workerRefresh.ts', import.meta.url).href;
    fs.writeFileSync(probe, [
      `const {refreshReviewInWorker} = await import(${JSON.stringify(workerRefreshUrl)});`,
      'const controller = new AbortController();',
      `const pending = refreshReviewInWorker({cwd: ${JSON.stringify(cwd)}, requestedBranch: 'HEAD', requestedBase: 'development', width: 100, signal: controller.signal});`,
      'setTimeout(() => controller.abort(), 300);',
      'await pending.catch(() => undefined);',
      '',
    ].join('\n'));

    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ['--import', 'tsx', probe], {
      cwd: projectRoot,
      env: {...process.env, PATH: `${binDir}${path.delimiter}${originalPath ?? ''}`},
      encoding: 'utf8',
      timeout: 30_000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // Without the fix the process waits for the pending 20 s git call to
    // finish; the bound leaves room for tsx startup on a loaded machine.
    expect(elapsed).toBeLessThan(12_000);
  }, 40_000);
});
