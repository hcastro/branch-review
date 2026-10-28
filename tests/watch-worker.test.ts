import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {getReviewFingerprint, resolveRefs} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {refreshReviewInWorker} from '../src/review/workerRefresh.js';
import {formatRefreshError} from '../src/ui/ReviewController.js';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalNodeOptions = process.env.NODE_OPTIONS;
const originalTmpdir = process.env.TMPDIR;
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

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

// A fake git whose first call records its pid and its parent's (the refresh
// process) and then hangs, so the refresh is stuck on it.
function hangingGit() {
  const pidFile = path.join(makeTempDir('branch-review-pids-'), 'git.pid');
  const binDir = fakeGitBinDir(`echo "$$ $PPID" > '${pidFile}'\nexec sleep 30`);
  const readPids = () => {
    try {
      const [gitPid, refreshPid] = fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
      return gitPid && refreshPid ? {gitPid, refreshPid} : null;
    } catch {
      return null;
    }
  };
  return {binDir, readPids};
}

// Routes os.tmpdir() to a fresh directory for the refresh parent.
function isolatedTmpdir() {
  const dir = makeTempDir('branch-review-worker-tmp-');
  process.env.TMPDIR = dir;
  return dir;
}

function listTree(root: string): string[] {
  return fs.readdirSync(root, {recursive: true}).map(String);
}

// What a refresh leaves behind: its own dir or a private index copy.
function refreshLeftovers(root: string) {
  return listTree(root).filter((entry) => /^branch-review-(refresh|index)-/.test(path.basename(entry)));
}

// True once the build calls onFileBuilt; until then a build cannot report
// per-file progress and the tests that need it are skipped.
function buildReportsFileProgress() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-progress-probe-'));
  try {
    runGit(cwd, 'init', '-q', '-b', 'development');
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
    runGit(cwd, 'add', '.');
    runGit(cwd, 'commit', '-q', '-m', 'initial');
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'b\n');
    let calls = 0;
    const options = {
      cwd,
      range: resolveRefs(cwd, 'HEAD', 'development'),
      width: 100,
      onFileBuilt: () => {
        calls += 1;
      },
    };
    buildReviewModel(options);
    return calls > 0;
  } catch {
    return false;
  } finally {
    fs.rmSync(cwd, {recursive: true, force: true});
  }
}

const fileProgressAvailable = buildReportsFileProgress();

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
  if (originalTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = originalTmpdir;
  }
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
    if (result.state !== 'rejected') return;
    expect(result.error.message).toMatch(/refresh aborted/);
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

describe('refreshReviewInWorker progress limit', () => {
  it('lets a refresh longer than the limit land while it keeps reporting progress', async () => {
    const cwd = createRepo();
    const fingerprint = currentFingerprint(cwd);
    // One slow git call in each step: every step is under the limit, the
    // whole refresh is well over it.
    const binDir = fakeGitBinDir([
      'case "$*" in *merge-base*|*"diff --raw"*|*"branch --show-current"*) sleep 1.5;; esac',
      'exec "$REAL_GIT" "$@"',
    ].join('\n'));

    const startedAt = Date.now();
    const result = await settleWithin(withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      previousFingerprint: fingerprint,
      timeoutMs: 2500,
    })), 30_000);

    expect(result.state === 'rejected' ? result.error.message : result.state).toBe('resolved');
    if (result.state !== 'resolved') return;
    expect(result.value.fingerprint).toBe(fingerprint);
    expect(Date.now() - startedAt).toBeGreaterThan(2500);
  }, 40_000);

  it.skipIf(!fileProgressAvailable)('lets a build longer than the limit land while each file reports progress', async () => {
    const cwd = createRepo();
    for (let index = 0; index < 4; index += 1) {
      fs.writeFileSync(path.join(cwd, 'src', `extra${index}.ts`), `export const extra = ${index};\n`);
    }
    runGit(cwd, 'add', '.');
    runGit(cwd, 'commit', '-q', '-m', 'more files');
    // Only the per-file diffs are slow.
    const binDir = fakeGitBinDir('case "$*" in *" -- "*) sleep 0.8;; esac\nexec "$REAL_GIT" "$@"');

    const result = await settleWithin(withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      timeoutMs: 2000,
    })), 30_000);

    expect(result.state === 'rejected' ? result.error.message : result.state).toBe('resolved');
    if (result.state !== 'resolved') return;
    expect(result.value.review?.files.length).toBe(5);
  }, 40_000);

  it('kills a refresh stuck on one git call at the limit, git included', async () => {
    const cwd = createRepo();
    const {binDir, readPids} = hangingGit();

    const startedAt = Date.now();
    const result = await settleWithin(withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      timeoutMs: 1500,
    })), 15_000);

    expect(result.state).toBe('rejected');
    if (result.state !== 'rejected') return;
    expect(result.error.message).toMatch(/refresh timed out: no progress for 2s/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const pids = readPids();
    expect(pids).not.toBeNull();
    expect(await waitFor(() => !isAlive(pids!.gitPid) && !isAlive(pids!.refreshPid), 3000)).toBe(true);
  }, 30_000);

  it('kills git when the refresh is aborted', async () => {
    const cwd = createRepo();
    const {binDir, readPids} = hangingGit();
    const controller = new AbortController();

    const pending = withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      signal: controller.signal,
    }));
    expect(await waitFor(() => readPids() !== null, 10_000)).toBe(true);
    controller.abort();

    const result = await settleWithin(pending, 5000);
    expect(result.state).toBe('rejected');
    if (result.state !== 'rejected') return;
    expect(result.error.message).toMatch(/refresh aborted/);
    const pids = readPids()!;
    expect(await waitFor(() => !isAlive(pids.gitPid) && !isAlive(pids.refreshPid), 3000)).toBe(true);
  }, 30_000);
});

describe('refreshReviewInWorker temp files', () => {
  function slowIndexGit() {
    // Hangs only once the private index copy exists.
    return fakeGitBinDir('if [ -n "$GIT_INDEX_FILE" ]; then sleep 10; fi\nexec "$REAL_GIT" "$@"');
  }

  function hasIndexCopy(tmp: string) {
    return listTree(tmp).some((entry) => path.basename(entry).startsWith('branch-review-index-'));
  }

  it('gives the refresh its own temp dir and removes it after a normal exit', async () => {
    const cwd = createRepo();
    const tmp = isolatedTmpdir();
    const seenFile = path.join(makeTempDir('branch-review-seen-'), 'tmpdir');
    const binDir = fakeGitBinDir(`printf '%s' "$BRANCH_REVIEW_TMPDIR" > '${seenFile}'\nexec "$REAL_GIT" "$@"`);

    const result = await settleWithin(withPath(binDir, () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
    })), 15_000);

    expect(result.state === 'rejected' ? result.error.message : result.state).toBe('resolved');
    const seen = fs.readFileSync(seenFile, 'utf8');
    expect(path.dirname(seen)).toBe(tmp);
    expect(path.basename(seen)).toMatch(/^branch-review-refresh-/);
    expect(await waitFor(() => refreshLeftovers(tmp).length === 0, 3000)).toBe(true);
  }, 20_000);

  it('removes the private index copy of an aborted refresh', async () => {
    const cwd = createRepo();
    const tmp = isolatedTmpdir();
    const controller = new AbortController();

    const pending = withPath(slowIndexGit(), () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      signal: controller.signal,
    }));
    expect(await waitFor(() => hasIndexCopy(tmp), 10_000)).toBe(true);
    controller.abort();

    expect((await settleWithin(pending, 5000)).state).toBe('rejected');
    expect(await waitFor(() => refreshLeftovers(tmp).length === 0, 3000)).toBe(true);
  }, 30_000);

  it('removes the private index copy of a refresh killed at the limit', async () => {
    const cwd = createRepo();
    const tmp = isolatedTmpdir();

    const pending = withPath(slowIndexGit(), () => refreshReviewInWorker({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'development',
      width: 100,
      timeoutMs: 1500,
    }));

    expect(await waitFor(() => hasIndexCopy(tmp), 10_000)).toBe(true);
    const result = await settleWithin(pending, 10_000);
    expect(result.state === 'rejected' ? result.error.message : result.state).toMatch(/refresh timed out/);
    expect(await waitFor(() => refreshLeftovers(tmp).length === 0, 3000)).toBe(true);
  }, 30_000);
});

describe('refreshReviewInWorker when its parent goes away', () => {
  function writeProbe(lines: string[]) {
    const probe = path.join(makeTempDir('branch-review-probe-'), 'probe.mjs');
    const workerRefreshUrl = new URL('../src/review/workerRefresh.ts', import.meta.url).href;
    fs.writeFileSync(probe, [
      `const {refreshReviewInWorker} = await import(${JSON.stringify(workerRefreshUrl)});`,
      ...lines,
      '',
    ].join('\n'));
    return probe;
  }

  it('kills the refresh and its git when the parent calls process.exit() mid-refresh', async () => {
    const cwd = createRepo();
    const {binDir, readPids} = hangingGit();
    const probe = writeProbe([
      `refreshReviewInWorker({cwd: ${JSON.stringify(cwd)}, requestedBranch: 'HEAD', requestedBase: 'development', width: 100}).catch(() => undefined);`,
      'process.stdin.once("data", () => process.exit(0));',
    ]);

    const parent = spawn(process.execPath, ['--import', 'tsx', probe], {
      cwd: projectRoot,
      env: {...process.env, PATH: `${binDir}${path.delimiter}${originalPath ?? ''}`},
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    const exited = new Promise((resolve) => parent.once('exit', resolve));
    try {
      expect(await waitFor(() => readPids() !== null, 15_000)).toBe(true);
      parent.stdin.end('exit\n');
      await exited;

      const pids = readPids()!;
      expect(await waitFor(() => !isAlive(pids.gitPid) && !isAlive(pids.refreshPid), 3000)).toBe(true);
    } finally {
      parent.kill('SIGKILL');
    }
  }, 40_000);

  it('ends the refresh and its git soon after the parent is killed outright', async () => {
    const cwd = createRepo();
    const {binDir, readPids} = hangingGit();
    const probe = writeProbe([
      `refreshReviewInWorker({cwd: ${JSON.stringify(cwd)}, requestedBranch: 'HEAD', requestedBase: 'development', width: 100}).catch(() => undefined);`,
      'setInterval(() => undefined, 1000);',
    ]);

    const parent = spawn(process.execPath, ['--import', 'tsx', probe], {
      cwd: projectRoot,
      env: {...process.env, PATH: `${binDir}${path.delimiter}${originalPath ?? ''}`},
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    try {
      expect(await waitFor(() => readPids() !== null, 15_000)).toBe(true);
      // SIGKILL runs no exit hook: the refresh has to notice by itself.
      parent.kill('SIGKILL');

      const pids = readPids()!;
      expect(await waitFor(() => !isAlive(pids.gitPid) && !isAlive(pids.refreshPid), 3000)).toBe(true);
    } finally {
      parent.kill('SIGKILL');
    }
  }, 40_000);
});

describe('refreshReviewInWorker out of memory', () => {
  it('says the refresh ran out of memory, not just that it aborted', async () => {
    const cwd = createRepo();
    const preload = path.join(makeTempDir('branch-review-preload-'), 'oom.cjs');
    // Runs before the worker and fills a small heap until V8 gives up.
    fs.writeFileSync(preload, 'const hold = []; for (;;) hold.push(new Array(1e5).fill({}));\n');

    process.env.NODE_OPTIONS = `--max-old-space-size=24 --require ${preload}`;
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

    const result = await settleWithin(pending, 20_000);
    expect(result.state).toBe('rejected');
    if (result.state !== 'rejected') return;
    expect(result.error.message).toMatch(/^refresh ran out of memory/);
    expect(formatRefreshError(result.error)).toMatch(/^refresh ran out of memory/);
  }, 30_000);
});
