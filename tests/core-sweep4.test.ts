import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {NAME_NOT_UTF8, getReviewFingerprint, resolveRefs} from '../src/git.js';
import {buildReviewModel, refreshReview} from '../src/review/build.js';
import {
  cleanupTempDirs,
  commitAll,
  git,
  gitSpy,
  initRepo,
  makeTempDir,
  snapshotTree,
  withEnvAsync,
  writeExecutable,
  writeFiles,
} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times on a loaded machine.
vi.setConfig({testTimeout: 120_000});

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
// Absolute, so a child started in a temp repo still resolves tsx from this checkout.
const tsxLoader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

function prependPath(dir: string) {
  return `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
}

function refreshOptions(cwd: string, previousFingerprint: string | null) {
  return {cwd, requestedBranch: 'HEAD', requestedBase: 'main', width: 100, previousFingerprint};
}

// A superproject on branch `feature` whose submodule `sub` is checked out at
// the commit main records.
function repoWithSubmodule() {
  const lib = initRepo({'inner.txt': 'inner\n'});
  const cwd = initRepo({'a.txt': 'a\n'});
  git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub');
  commitAll(cwd, 'add submodule');
  git(cwd, 'checkout', '-q', '-b', 'feature');
  const sub = path.join(cwd, 'sub');
  git(sub, 'config', 'user.name', 'Test User');
  git(sub, 'config', 'user.email', 'test@example.com');
  git(sub, 'config', 'commit.gpgsign', 'false');
  return {cwd, sub};
}

function subprojectLines(rawDiff: string | undefined) {
  return (rawDiff ?? '').split('\n').filter((line) => line.startsWith('+Subproject') || line.startsWith('-Subproject'));
}

describe('a submodule in a worktree review', () => {
  it('changes the fingerprint and rebuilds each time its commit moves or it becomes dirty', async () => {
    const {cwd, sub} = repoWithSubmodule();
    const start = await refreshReview(refreshOptions(cwd, null));

    writeFiles(sub, {'inner.txt': 'second\n'});
    commitAll(sub, 'second');
    const firstMove = await refreshReview(refreshOptions(cwd, start.fingerprint));
    expect(firstMove.fingerprint).not.toBe(start.fingerprint);
    const firstHead = git(sub, 'rev-parse', 'HEAD').trim();
    expect(subprojectLines(firstMove.review?.files.find((file) => file.path === 'sub')?.rawDiff))
      .toEqual([expect.stringMatching(/^-Subproject commit /), `+Subproject commit ${firstHead}`]);

    writeFiles(sub, {'inner.txt': 'third\n'});
    commitAll(sub, 'third');
    const secondMove = await refreshReview(refreshOptions(cwd, firstMove.fingerprint));
    expect(secondMove.fingerprint).not.toBe(firstMove.fingerprint);
    const secondHead = git(sub, 'rev-parse', 'HEAD').trim();
    expect(subprojectLines(secondMove.review?.files.find((file) => file.path === 'sub')?.rawDiff)[1])
      .toBe(`+Subproject commit ${secondHead}`);

    writeFiles(sub, {'inner.txt': 'dirty\n'});
    const dirty = await refreshReview(refreshOptions(cwd, secondMove.fingerprint));
    expect(dirty.fingerprint).not.toBe(secondMove.fingerprint);
    expect(subprojectLines(dirty.review?.files.find((file) => file.path === 'sub')?.rawDiff)[1])
      .toBe(`+Subproject commit ${secondHead}-dirty`);
    expect(dirty.fingerprint).toBe(getReviewFingerprint(cwd, dirty.range));
  });

  it('keeps the fingerprint while the shown submodule line stays the same, and leaves .git unchanged', async () => {
    const {cwd, sub} = repoWithSubmodule();
    writeFiles(sub, {'inner.txt': 'second\n'});
    commitAll(sub, 'second');
    writeFiles(sub, {'inner.txt': 'dirty\n'});
    const first = await refreshReview(refreshOptions(cwd, null));
    expect(first.review?.files.map((file) => file.path)).toEqual(['sub']);

    const before = snapshotTree(path.join(cwd, '.git'));
    const again = await refreshReview(refreshOptions(cwd, first.fingerprint));
    expect(again.fingerprint).toBe(first.fingerprint);
    expect('review' in again).toBe(false);

    // Still dirty, so the diff still says `-dirty` and nothing shown changed.
    writeFiles(sub, {'inner.txt': 'dirty again\n', 'other.txt': 'new inside the submodule\n'});
    const stillDirty = await refreshReview(refreshOptions(cwd, first.fingerprint));
    expect(stillDirty.fingerprint).toBe(first.fingerprint);
    expect('review' in stillDirty).toBe(false);

    const after = snapshotTree(path.join(cwd, '.git'));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, stat] of before) {
      expect({file, ...after.get(file)}).toEqual({file, ...stat});
    }
  });
});

describe('the fingerprint and file modes', () => {
  it('changes when the owner exec bit changes, and not for the group or other bits', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const script = path.join(cwd, 'run.sh');
    writeExecutable(script, 'echo hi\n');
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const executable = getReviewFingerprint(cwd, range);

    fs.chmodSync(script, 0o754);
    expect(getReviewFingerprint(cwd, range)).toBe(executable);

    fs.chmodSync(script, 0o655);
    expect(buildReviewModel({cwd, range, width: 100}).files.find((file) => file.path === 'run.sh')?.rawDiff)
      .toContain('new file mode 100644');
    expect(getReviewFingerprint(cwd, range)).not.toBe(executable);
  });
});

function gitWithInput(cwd: string, args: string[], input: Buffer | string) {
  return execFileSync('git', args, {cwd, input, encoding: 'utf8'}).trim();
}

// Commits files whose names are raw bytes on top of HEAD as branch `name`,
// with plumbing, so it works on filesystems that reject such names.
function commitRawNames(cwd: string, name: string, files: Array<{name: Buffer; contents: string}>) {
  const tree = execFileSync('git', ['ls-tree', '-z', 'HEAD'], {cwd});
  const entries = files.map(({name: fileName, contents}) => {
    const blob = gitWithInput(cwd, ['hash-object', '-w', '--stdin'], contents);
    return Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), fileName, Buffer.from([0])]);
  });
  const newTree = gitWithInput(cwd, ['mktree', '-z'], Buffer.concat([tree, ...entries]));
  const commit = gitWithInput(cwd, ['commit-tree', newTree, '-p', 'HEAD', '-m', 'raw names'], '');
  git(cwd, 'update-ref', `refs/heads/${name}`, commit);
}

// `caf` + byte 0xE9 + `.txt`: Latin-1 for café, which decodes to the escaped
// stand-in `caf\351.txt`.
const latin1Cafe = Buffer.from([...Buffer.from('caf'), 0xE9, ...Buffer.from('.txt')]);
// A real UTF-8 name holding a backslash and the digits 351.
const literalCafe = 'caf\\351.txt';

describe('a name that is not UTF-8 next to a real file with the same escaped text', () => {
  it('shows both rows in a branch review, each with its own line counts', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    commitRawNames(cwd, 'feat', [
      {name: latin1Cafe, contents: 'one\n'},
      {name: Buffer.from(literalCafe), contents: 'one\ntwo\nthree\n'},
    ]);
    const range = resolveRefs(cwd, 'feat', 'main');

    const model = buildReviewModel({cwd, range, width: 100});
    const rows = model.files.map((file) => ({path: file.path, pathError: file.pathError, additions: file.metrics.additions}));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      {path: literalCafe, pathError: NAME_NOT_UTF8, additions: 1},
      {path: literalCafe, pathError: undefined, additions: 3},
    ]));
    const real = model.files.find((file) => file.pathError === undefined)!;
    expect(real.error).toBeUndefined();
    expect(real.blocks[0]?.addedCode).toBe('one\ntwo\nthree');
    expect(model.metrics.additions).toBe(4);

    const refreshed = await refreshReview({cwd, requestedBranch: 'feat', requestedBase: 'main', width: 100, previousFingerprint: null});
    expect(refreshed.review).toEqual(model);
  });

  it('keeps an untracked stand-in from hiding a tracked file or its line counts in a worktree review', async () => {
    // APFS refuses the Latin-1 name on disk, so a git wrapper lists it as
    // untracked the way git would on a filesystem that allows it.
    const cwd = initRepo({[literalCafe]: 'one\n'});
    writeFiles(cwd, {[literalCafe]: 'one\ntwo\nthree\n'});
    const bin = makeTempDir('branch-review-latin1-git-');
    writeExecutable(path.join(bin, 'git'), [
      '#!/bin/sh',
      `case "$*" in *ls-files*--others*) '${realGit}' "$@" || exit $?; printf 'caf\\351.txt\\000'; exit 0;; esac`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));

    await withEnvAsync({PATH: prependPath(bin)}, async () => {
      const range = resolveRefs(cwd, 'HEAD', 'main');
      const model = buildReviewModel({cwd, range, width: 100});
      const rows = model.files.map((file) => ({path: file.path, status: file.status, pathError: file.pathError, additions: file.metrics.additions}));
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        {path: literalCafe, status: 'untracked', pathError: NAME_NOT_UTF8, additions: 0},
        {path: literalCafe, status: 'modified', pathError: undefined, additions: 2},
      ]));
      const real = model.files.find((file) => file.status === 'modified')!;
      expect(real.error).toBeUndefined();
      // Diffed as the tracked change it is, not as a new file.
      expect(real.rawDiff).not.toContain('new file mode');
      expect(real.blocks[0]?.addedCode).toBe('two\nthree');

      const refreshed = await refreshReview(refreshOptions(cwd, null));
      expect(refreshed.review).toEqual(model);
    });
  });
});

describe('a delta that exits before reading its input', () => {
  it('reports delta\'s own reason from both drivers', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    // Larger than a pipe buffer, so writing it blocks until delta has exited.
    fs.writeFileSync(path.join(cwd, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(20_000));
    const bin = makeTempDir('branch-review-exiting-delta-');
    writeExecutable(path.join(bin, 'delta'), ['#!/bin/sh', `echo 'boom: bad input' >&2`, 'exit 3', ''].join('\n'));

    await withEnvAsync({PATH: prependPath(bin)}, async () => {
      const range = resolveRefs(cwd, 'HEAD', 'main');
      const syncModel = buildReviewModel({cwd, range, width: 100});
      const asyncModel = (await refreshReview(refreshOptions(cwd, null))).review;

      expect(syncModel.files.map((file) => file.error)).toEqual(['delta failed: boom: bad input']);
      expect(asyncModel).toEqual(syncModel);
    });
  });
});

describe('aborting a refresh whose git started a long-lived child', () => {
  it('rejects and lets the process exit at once, with the grandchild still running', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'a.txt': 'a\nb\n'});
    const bin = makeTempDir('branch-review-forking-git-');
    const pidLog = path.join(bin, 'pids.log');
    // The grandchild keeps git's stdout and stderr open after git is killed.
    writeExecutable(path.join(bin, 'git'), [
      '#!/bin/sh',
      `case "$*" in *--numstat*) echo $$ >> '${pidLog}'; sleep 60 & echo $! >> '${pidLog}'; wait; exit 0;; esac`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));
    const buildModule = fileURLToPath(new URL('../src/review/build.ts', import.meta.url));
    const script = `
      import fs from 'node:fs';
      import {refreshReview} from ${JSON.stringify(buildModule)};
      const controller = new AbortController();
      const refresh = refreshReview({
        cwd: ${JSON.stringify(cwd)}, requestedBranch: 'HEAD', requestedBase: 'main', width: 100,
        previousFingerprint: null, signal: controller.signal,
      });
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(pidLog)}) && fs.readFileSync(${JSON.stringify(pidLog)}, 'utf8').trim().split('\\n').length >= 2) {
          clearInterval(timer);
          controller.abort();
        }
      }, 25);
      refresh.then(() => console.log('resolved'), (error) => console.log('rejected ' + error.constructor.name));
    `;
    const child = spawn(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
      cwd,
      env: {...process.env, PATH: prependPath(bin)},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) recordedPids.push(child.pid);
    let stdout = '';
    let stderr = '';
    let settledAt = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (!settledAt && /resolved|rejected/.test(stdout)) settledAt = Date.now();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exitedAt = await new Promise<number>((resolve) => child.once('exit', () => resolve(Date.now())));
    recordedPids.push(...fs.readFileSync(pidLog, 'utf8').trim().split('\n').map(Number));

    expect(stdout.trim(), stderr).toBe('rejected AbortedError');
    // The grandchild sleeps for 60 s; the process must not wait for it.
    expect(exitedAt - settledAt).toBeLessThan(10_000);
    const grandchild = recordedPids[recordedPids.length - 1]!;
    expect(() => process.kill(grandchild, 0)).not.toThrow();
  });
});

describe('the asynchronous driver\'s git environment', () => {
  it('runs every git call without optional locks or prompts, and on the private index after its lookup', async () => {
    const cwd = initRepo({'a.txt': 'a\n', 'b.txt': 'b\n'});
    writeFiles(cwd, {'a.txt': 'a2\n', 'new.txt': 'new\n'});
    const spy = gitSpy();

    const result = await withEnvAsync(
      {PATH: spy.pathValue, GIT_OPTIONAL_LOCKS: undefined, GIT_TERMINAL_PROMPT: undefined, GIT_INDEX_FILE: undefined},
      () => refreshReview(refreshOptions(cwd, null)),
    );
    expect(result.review?.files.map((file) => file.path)).toEqual(['a.txt', 'new.txt']);

    const calls = spy.calls();
    for (const call of calls) {
      expect({args: call.args, optionalLocks: call.optionalLocks, terminalPrompt: call.terminalPrompt})
        .toEqual({args: call.args, optionalLocks: '0', terminalPrompt: '0'});
    }
    const lookup = calls.findIndex((call) => call.args.endsWith('rev-parse --git-path index'));
    expect(lookup).toBeGreaterThanOrEqual(0);
    const afterLookup = calls.slice(lookup + 1);
    expect(afterLookup.length).toBeGreaterThan(5);
    for (const call of afterLookup) {
      expect({args: call.args, dir: path.basename(path.dirname(call.indexFile))})
        .toEqual({args: call.args, dir: expect.stringMatching(/^branch-review-index-/)});
    }
  });

  it('leaves every file under .git unchanged, submodule index included, for a stat-dirty submodule file', async () => {
    const {cwd, sub} = repoWithSubmodule();
    writeFiles(cwd, {'a.txt': 'a changed\n', 'untracked.txt': 'u\n'});
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(sub, 'inner.txt'), later, later);
    fs.utimesSync(path.join(cwd, 'a.txt'), later, later);

    const gitDir = path.join(cwd, '.git');
    expect(fs.existsSync(path.join(gitDir, 'modules', 'sub', 'index'))).toBe(true);
    const before = snapshotTree(gitDir);

    const result = await refreshReview(refreshOptions(cwd, null));

    expect(result.review?.files.map((file) => file.path)).toEqual(['a.txt', 'untracked.txt']);
    const after = snapshotTree(gitDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, stat] of before) {
      expect({file, ...after.get(file)}).toEqual({file, ...stat});
    }
  });
});

describe('the asynchronous driver\'s file loops', () => {
  it('let timers run while tens of thousands of untracked files are counted and hashed', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const untracked: Record<string, string> = {};
    // Enough that one unsliced pass over them blocks for most of a second
    // (about 850 ms here), against about 40 ms with slicing.
    for (let index = 0; index < 20_000; index += 1) untracked[`new/file-${index}.txt`] = `line ${index}\n`;
    writeFiles(cwd, untracked);
    const range = resolveRefs(cwd, 'HEAD', 'main');
    // The build is skipped: only the line counts and the hashing loop over every file.
    const fingerprint = getReviewFingerprint(cwd, range);

    // The longest gap between timer ticks during one refresh.
    const longestGap = async () => {
      let longest = 0;
      let last = Date.now();
      const timer = setInterval(() => {
        const now = Date.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 5);
      try {
        last = Date.now();
        const result = await refreshReview(refreshOptions(cwd, fingerprint));
        expect('review' in result).toBe(false);
      } finally {
        clearInterval(timer);
      }
      return longest;
    };

    // A loaded machine can stall the process for a moment in any one run, so
    // a second run gets a chance; an unsliced loop blocks in every run.
    const gaps = [await longestGap()];
    if (gaps[0]! >= 300) gaps.push(await longestGap());
    expect(Math.min(...gaps), `longest gaps ${gaps.join(', ')} ms`).toBeLessThan(300);
  });
});
