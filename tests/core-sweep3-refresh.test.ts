import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AbortedError, getCurrentBranchName, getReviewFingerprint, resolveRefs} from '../src/git.js';
import {buildReviewModel, refreshReview} from '../src/review/build.js';
import {cleanupTempDirs, commitAll, git, gitSpy, initRepo, makeTempDir, withEnvAsync, writeExecutable, writeFiles} from './core-helpers.js';

// These tests build large repos and run git and delta hundreds of times on a
// loaded machine.
vi.setConfig({testTimeout: 300_000});

const recordedPids: number[] = [];

afterEach(() => {
  // Only processes this file's fake tools recorded themselves.
  for (const pid of recordedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  cleanupTempDirs();
});

const realGit = execFileSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).trim();

function prependPath(dir: string) {
  return `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Every onProgress call's time, and the longest stretch without one.
function progressLog() {
  const times: number[] = [];
  return {
    times,
    onProgress: () => times.push(Date.now()),
    maxGap(from: number, to: number) {
      const points = [from, ...times.filter((time) => time >= from && time <= to), to];
      let gap = 0;
      for (let index = 1; index < points.length; index += 1) gap = Math.max(gap, points[index]! - points[index - 1]!);
      return gap;
    },
  };
}

describe('refreshReview progress', () => {
  it('reports progress through the per-file numstat fallback, the fingerprint and the build, and counts lines once', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 300; index += 1) files[`src/file-${String(index).padStart(3, '0')}.txt`] = `line ${index}\n`;
    const cwd = initRepo(files);
    const changed: Record<string, string> = {};
    for (const name of Object.keys(files)) changed[name] = `${files[name]}more\n`;
    writeFiles(cwd, changed);
    // git can't hash it, so whole-range numstat fails and every file is counted on its own.
    fs.chmodSync(path.join(cwd, 'src/file-150.txt'), 0o000);
    const spy = gitSpy();
    const progress = progressLog();

    const started = Date.now();
    const result = await withEnvAsync({PATH: spy.pathValue}, () => refreshReview({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'main',
      width: 100,
      previousFingerprint: null,
      onProgress: progress.onProgress,
    }));
    const finished = Date.now();
    fs.chmodSync(path.join(cwd, 'src/file-150.txt'), 0o644);

    expect(result.review?.files).toHaveLength(300);
    expect(result.review?.files.filter((file) => file.error !== undefined).map((file) => file.path)).toEqual(['src/file-150.txt']);
    // Per-file numstat, fingerprint hashing and the build each report every file.
    expect(progress.times.length).toBeGreaterThanOrEqual(900);
    expect(progress.maxGap(started, finished)).toBeLessThan(5000);
    // Line counts are read once and shared: one whole-range numstat, then one per file.
    expect(spy.calls().filter((call) => call.args.includes('--numstat'))).toHaveLength(301);
  });

  it('reports each untracked file while counting its lines and hashing it, even when the build is skipped', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const untracked: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1) untracked[`new/file-${index}.txt`] = `line ${index}\n`;
    writeFiles(cwd, untracked);
    const options = {cwd, requestedBranch: 'HEAD', requestedBase: 'main', width: 100};
    const first = await refreshReview({...options, previousFingerprint: null});
    const progress = progressLog();

    const unchanged = await refreshReview({...options, previousFingerprint: first.fingerprint, onProgress: progress.onProgress});

    expect('review' in unchanged).toBe(false);
    // One tick per file for the line counts and one for the hashing.
    expect(progress.times.length).toBeGreaterThanOrEqual(400);
  });

  it('reports progress while delta renders a 20 MB added file', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const line = `${'x'.repeat(79)}\n`;
    fs.writeFileSync(path.join(cwd, 'big.txt'), line.repeat(Math.ceil((20 * 1024 * 1024) / line.length)));
    // A delta that reads the whole patch, then prints its output in slow
    // chunks, logging when it started and finished.
    const bin = makeTempDir('branch-review-slow-delta-');
    const log = path.join(bin, 'times.log');
    writeExecutable(path.join(bin, 'delta'), [
      `#!${process.execPath}`,
      `const fs = require('node:fs');`,
      `fs.appendFileSync(${JSON.stringify(log)}, 'start ' + Date.now() + ' ' + process.pid + '\\n');`,
      `process.stdin.resume();`,
      `process.stdin.on('end', () => {`,
      `  let sent = 0;`,
      `  const timer = setInterval(() => {`,
      `    process.stdout.write('rendered chunk ' + sent + '\\n');`,
      `    sent += 1;`,
      `    if (sent === 8) {`,
      `      clearInterval(timer);`,
      `      fs.appendFileSync(${JSON.stringify(log)}, 'end ' + Date.now() + '\\n');`,
      `    }`,
      `  }, 250);`,
      `});`,
      '',
    ].join('\n'));
    const progress = progressLog();

    const result = await withEnvAsync({PATH: prependPath(bin)}, () => refreshReview({
      cwd,
      requestedBranch: 'HEAD',
      requestedBase: 'main',
      width: 100,
      previousFingerprint: null,
      onProgress: progress.onProgress,
    }));

    const [startLine, endLine] = fs.readFileSync(log, 'utf8').trim().split('\n');
    const deltaStart = Number(startLine!.split(' ')[1]);
    const deltaEnd = Number(endLine!.split(' ')[1]);
    expect(result.review?.files[0]?.renderedLines).toHaveLength(8);
    expect(result.review?.files[0]?.metrics.additions).toBe(Math.ceil((20 * 1024 * 1024) / line.length));
    const during = progress.times.filter((time) => time >= deltaStart && time <= deltaEnd);
    // Input chunks while delta reads, then each output chunk.
    expect(during.length).toBeGreaterThanOrEqual(8);
    expect(progress.maxGap(deltaStart + 500, deltaEnd)).toBeLessThan(1500);
  });
});

// A repo with every kind of change the review shows.
function variedRepo() {
  const cwd = initRepo({
    'modified.txt': 'one\ntwo\n',
    'deleted.txt': 'gone\n',
    'old-name.txt': 'line 1\nline 2\nline 3\nline 4\nline 5\n',
    'mode.sh': 'echo hi\n',
    'locked.txt': 'secret\n',
  });
  git(cwd, 'checkout', '-q', '-b', 'feat');
  writeFiles(cwd, {'committed.txt': 'on the branch\n'});
  commitAll(cwd, 'branch commit');
  writeFiles(cwd, {'modified.txt': 'one\ntwo\nthree\n', 'staged.txt': 'staged\n', 'untracked.txt': 'new\n'});
  fs.rmSync(path.join(cwd, 'deleted.txt'));
  fs.renameSync(path.join(cwd, 'old-name.txt'), path.join(cwd, 'new-name.txt'));
  fs.writeFileSync(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  fs.symlinkSync('modified.txt', path.join(cwd, 'link'));
  fs.chmodSync(path.join(cwd, 'mode.sh'), 0o755);
  git(cwd, 'add', 'staged.txt', 'new-name.txt', 'old-name.txt');
  writeFiles(cwd, {'locked.txt': 'secret\nchanged\n'});
  fs.chmodSync(path.join(cwd, 'locked.txt'), 0o000);
  return cwd;
}

describe('refreshReview and the synchronous functions', () => {
  it('produce the same range, fingerprint, branch and model for a worktree review and a branch review', async () => {
    const cwd = variedRepo();
    try {
      for (const [requestedBranch, requestedBase] of [['HEAD', 'main'], ['feat', 'main']] as const) {
        const range = resolveRefs(cwd, requestedBranch, requestedBase);
        const syncModel = buildReviewModel({cwd, range, width: 120});
        const result = await refreshReview({
          cwd,
          requestedBranch,
          requestedBase,
          width: 120,
          previousFingerprint: null,
          signal: new AbortController().signal,
        });

        expect(result.range).toEqual(range);
        expect(result.fingerprint).toBe(getReviewFingerprint(cwd, range));
        expect(result.branchName).toBe(getCurrentBranchName(cwd));
        expect(result.review).toEqual(syncModel);
        expect(syncModel.files.length).toBeGreaterThan(0);
      }
      const headModel = buildReviewModel({cwd, range: resolveRefs(cwd, 'HEAD', 'main'), width: 120});
      expect(headModel.files.find((file) => file.path === 'locked.txt')?.error).toBeDefined();
      expect(headModel.files.map((file) => file.path)).toEqual(expect.arrayContaining(['binary.bin', 'link', 'mode.sh', 'new-name.txt']));
    } finally {
      fs.chmodSync(path.join(cwd, 'locked.txt'), 0o644);
    }
  });

  it('skips the build while the fingerprint matches and builds once it changes', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'a.txt': 'a\nb\n'});
    const options = {cwd, requestedBranch: 'HEAD', requestedBase: 'main', width: 100};

    const first = await refreshReview({...options, previousFingerprint: null});
    const same = await refreshReview({...options, previousFingerprint: first.fingerprint});
    expect(same.fingerprint).toBe(first.fingerprint);
    expect('review' in same).toBe(false);

    writeFiles(cwd, {'a.txt': 'a\nb\nc\n'});
    const changed = await refreshReview({...options, previousFingerprint: first.fingerprint});
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(changed.review?.files[0]?.blocks[0]?.addedCode).toBe('b\nc');
  });

  it('rejects with the same message and attached stderr as the synchronous path', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const bin = makeTempDir('branch-review-failing-git-');
    writeExecutable(path.join(bin, 'git'), [
      '#!/bin/sh',
      `case "$*" in *--name-status*) echo 'warning: first'; echo 'fatal: name-status broke' >&2; exit 128;; esac`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));

    await withEnvAsync({PATH: prependPath(bin)}, async () => {
      let syncError: (Error & {stderr?: string}) | undefined;
      try {
        getReviewFingerprint(cwd, range);
      } catch (error) {
        syncError = error as Error & {stderr?: string};
      }
      const asyncError = await refreshReview({
        cwd, requestedBranch: 'HEAD', requestedBase: 'main', width: 100, previousFingerprint: null,
      }).then(() => undefined, (error: Error & {stderr?: string}) => error);

      expect(syncError?.message).toBe('git diff failed: fatal: name-status broke');
      expect(asyncError?.message).toBe(syncError?.message);
      expect(asyncError?.stderr).toBe(syncError?.stderr);
      expect(asyncError?.stderr).toContain('fatal: name-status broke');
    });

    await expect(refreshReview({
      cwd, requestedBranch: 'HEAD', requestedBase: 'no-such-base', width: 100, previousFingerprint: null,
    })).rejects.toThrow('Base ref not found: no-such-base');
  });
});

describe('aborting refreshReview', () => {
  it('kills the git it is waiting on, rejects at once and removes the private index copy', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'a.txt': 'a\nb\n'});
    const bin = makeTempDir('branch-review-hanging-git-');
    const pidLog = path.join(bin, 'pids.log');
    writeExecutable(path.join(bin, 'git'), [
      '#!/bin/sh',
      `case "$*" in *--numstat*) echo $$ >> '${pidLog}'; exec sleep 60;; esac`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));
    const tmp = makeTempDir('branch-review-abort-tmp-');
    const controller = new AbortController();

    const refresh = withEnvAsync({PATH: prependPath(bin), BRANCH_REVIEW_TMPDIR: tmp}, () => refreshReview({
      cwd, requestedBranch: 'HEAD', requestedBase: 'main', width: 100, previousFingerprint: null, signal: controller.signal,
    }));
    const outcome = refresh.then(() => 'resolved', (error: unknown) => error);

    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(pidLog) || fs.readFileSync(pidLog, 'utf8').trim() === '') {
      if (Date.now() > deadline) throw new Error('the fake git never started');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const pid = Number(fs.readFileSync(pidLog, 'utf8').trim().split('\n')[0]);
    recordedPids.push(pid);
    expect(isAlive(pid)).toBe(true);
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith('branch-review-index-'))).toHaveLength(1);

    const abortedAt = Date.now();
    controller.abort();
    const error = await outcome;

    expect(error).toBeInstanceOf(AbortedError);
    expect(Date.now() - abortedAt).toBeLessThan(1500);
    expect(isAlive(pid)).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('rejects without running git when the signal is already aborted', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const spy = gitSpy();
    const controller = new AbortController();
    controller.abort();

    await withEnvAsync({PATH: spy.pathValue}, async () => {
      await expect(refreshReview({
        cwd, requestedBranch: 'HEAD', requestedBase: 'main', width: 100, previousFingerprint: null, signal: controller.signal,
      })).rejects.toBeInstanceOf(AbortedError);
    });
    expect(spy.calls()).toEqual([]);
  });
});
