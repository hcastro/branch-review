import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getReviewFingerprint} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {prepareStartup} from '../src/startup.js';
import {TERMINAL_RESTORE_SEQUENCE, createTerminalSession, runInkApp} from '../src/terminalSession.js';
import {cleanupTempDirs, git, initRepo, makeTempDir, pathWithOnly, writeFiles} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

const cliEntry = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
// Absolute, so the child resolves tsx from this checkout rather than from its cwd.
const tsxLoader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ['--import', tsxLoader, cliEntry, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('startup', () => {
  it('reviews the whole repo when started from a subdirectory', () => {
    const root = initRepo({'pkg/tracked.txt': 'one\n', 'top.txt': 'top\n'});
    git(root, 'checkout', '-q', '-b', 'feature');
    writeFiles(root, {'pkg/tracked.txt': 'one\ntwo\n', 'pkg/new.txt': 'new\n', 'outside.txt': 'outside\n'});

    const startup = prepareStartup({
      cwd: path.join(root, 'pkg'),
      options: {requestedBranch: 'HEAD', requestedBase: 'main', watch: false, watchPoll: false, animations: false},
      width: 100,
    });

    expect(startup.cwd).toBe(root);
    expect(startup.review.files.map((file) => file.path)).toEqual(['outside.txt', 'pkg/new.txt', 'pkg/tracked.txt']);
    expect(startup.review.files.find((file) => file.path === 'pkg/tracked.txt')?.blocks[0]?.addedCode).toBe('two');
  });

  it('takes the fingerprint before the build so a write during the build is picked up', () => {
    const root = initRepo({'a.txt': 'one\n'});
    writeFiles(root, {'a.txt': 'one\ntwo\n'});

    const startup = prepareStartup({
      cwd: root,
      options: {requestedBranch: 'HEAD', requestedBase: 'main', watch: true, watchPoll: false, animations: false},
      width: 100,
      buildReview: (options) => {
        const review = buildReviewModel(options);
        writeFiles(root, {'a.txt': 'one\ntwo\nthree\n'});
        return review;
      },
    });

    expect(startup.initialFingerprint).toBeDefined();
    expect(startup.initialFingerprint).not.toBe(getReviewFingerprint(root, startup.range));
  });

  it('keeps the fingerprint equal to a fresh one when nothing changes during the build', () => {
    const root = initRepo({'a.txt': 'one\n'});
    writeFiles(root, {'a.txt': 'one\ntwo\n'});

    const startup = prepareStartup({
      cwd: root,
      options: {requestedBranch: 'HEAD', requestedBase: 'main', watch: true, watchPoll: false, animations: false},
      width: 100,
    });

    expect(startup.initialFingerprint).toBe(getReviewFingerprint(root, startup.range));
  });
});

describe('cli startup errors', () => {
  it('says "not a git repository" in one line outside a repo', () => {
    const dir = makeTempDir('branch-review-norepo-');
    const result = runCli(dir, ['--no-watch']);

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toMatch(/not a git repository/);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  }, 40_000);

  it('says git was not found when git is missing', () => {
    const dir = makeTempDir('branch-review-nogit-');
    const bin = pathWithOnly([]);
    const result = runCli(dir, ['--no-watch'], {...process.env, PATH: bin});

    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toMatch(/git not found/);
  }, 40_000);

  it('prints a missing base ref as one line', () => {
    const root = initRepo({'a.txt': 'one\n'});
    const result = runCli(root, ['HEAD', 'no-such-base', '--no-watch']);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('branch-review: Base ref not found: no-such-base');
  }, 40_000);

  it('still exits 0 with a message when there are no changes', () => {
    const root = initRepo({'a.txt': 'one\n'});
    const result = runCli(root, ['HEAD', 'main', '--no-watch']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No file changes between main and HEAD.');
  }, 40_000);
});

class FakeProcess extends EventEmitter {
  exitCode: number | undefined;
  exits: number[] = [];
  exit = (code?: number) => {
    this.exits.push(code ?? 0);
    this.emit('exit', code ?? 0);
  };
}

function fakeTerminal() {
  const writes: string[] = [];
  const errors: string[] = [];
  const proc = new FakeProcess();
  const session = createTerminalSession({
    stdout: {isTTY: true, write: (text: string) => writes.push(text)},
    stderr: {write: (text: string) => errors.push(text)},
    proc,
  });
  return {writes, errors, proc, session};
}

const ENTER = '\x1B[?1049h\x1B[H';

describe('terminal restore', () => {
  it('restores mouse, cursor and the main screen on SIGTERM, after Ink unmounts', () => {
    const {writes, proc, session} = fakeTerminal();
    session.install();
    session.enter();
    session.setUnmount(() => writes.push('FINAL-FRAME'));

    proc.emit('SIGTERM');

    expect(writes).toEqual([ENTER, 'FINAL-FRAME', TERMINAL_RESTORE_SEQUENCE]);
    expect(proc.exits).toEqual([143]);
  });

  it('restores on SIGINT with exit code 130', () => {
    const {writes, proc, session} = fakeTerminal();
    session.install();
    session.enter();

    proc.emit('SIGINT');

    expect(writes).toEqual([ENTER, TERMINAL_RESTORE_SEQUENCE]);
    expect(proc.exits).toEqual([130]);
  });

  it('restores on process exit and only once', () => {
    const {writes, proc, session} = fakeTerminal();
    session.install();
    session.enter();

    proc.emit('exit', 0);
    proc.emit('exit', 0);

    expect(writes).toEqual([ENTER, TERMINAL_RESTORE_SEQUENCE]);
  });

  it('restores and prints one line on an uncaught exception', () => {
    const {writes, errors, proc, session} = fakeTerminal();
    session.install();
    session.enter();

    proc.emit('uncaughtException', new Error('kaboom\nwith detail'));

    expect(writes).toEqual([ENTER, TERMINAL_RESTORE_SEQUENCE]);
    expect(errors).toEqual(['branch-review: kaboom\n']);
    expect(proc.exits).toEqual([1]);
  });

  it('writes nothing when stdout is not a terminal', () => {
    const writes: string[] = [];
    const proc = new FakeProcess();
    const session = createTerminalSession({
      stdout: {isTTY: false, write: (text: string) => writes.push(text)},
      stderr: {write: () => true},
      proc,
    });
    session.install();
    session.enter();
    proc.emit('SIGTERM');

    expect(writes).toEqual([]);
    expect(proc.exits).toEqual([143]);
  });

  it('turns every mouse mode off and shows the cursor', () => {
    for (const mode of ['?1000l', '?1002l', '?1003l', '?1006l', '?1015l', '?25h', '?1049l']) {
      expect(TERMINAL_RESTORE_SEQUENCE).toContain(`\x1B[${mode}`);
    }

    expect(TERMINAL_RESTORE_SEQUENCE.endsWith('\x1B[?1049l')).toBe(true);
  });
});

describe('runInkApp', () => {
  it('restores and reports a render error that rejects waitUntilExit', async () => {
    const {writes, errors, proc, session} = fakeTerminal();
    session.install();

    await runInkApp(session, () => ({
      waitUntilExit: () => Promise.reject(new Error('render failed')),
      unmount: () => writes.push('UNMOUNT'),
    }));

    expect(writes).toEqual([ENTER, 'UNMOUNT', TERMINAL_RESTORE_SEQUENCE]);
    expect(errors).toEqual(['branch-review: render failed\n']);
    expect(proc.exitCode).toBe(1);
  });

  it('restores and reports a throw during the first mount', async () => {
    const {writes, errors, proc, session} = fakeTerminal();
    session.install();

    await runInkApp(session, () => {
      throw new Error('first mount failed');
    });

    expect(writes).toEqual([ENTER, TERMINAL_RESTORE_SEQUENCE]);
    expect(errors).toEqual(['branch-review: first mount failed\n']);
    expect(proc.exitCode).toBe(1);
  });

  it('restores without an error on a clean exit', async () => {
    const {writes, errors, proc, session} = fakeTerminal();
    session.install();

    await runInkApp(session, () => ({
      waitUntilExit: () => Promise.resolve(),
      unmount: () => writes.push('UNMOUNT'),
    }));

    expect(writes).toEqual([ENTER, 'UNMOUNT', TERMINAL_RESTORE_SEQUENCE]);
    expect(errors).toEqual([]);
    expect(proc.exitCode).toBeUndefined();
  });
});
