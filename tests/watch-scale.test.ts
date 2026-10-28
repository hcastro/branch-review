import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import * as base from 'vitest';
import {afterAll, beforeAll, describe, expect} from 'vitest';
import {createRepoWatcher, defaultNativeWatchMode, type NativeWatchMode} from '../src/watch/repoWatcher.js';

// More files than macOS allows open file descriptors per process by default,
// so a watcher that holds one handle per file breaks every later spawn.
const FILE_COUNT = 10_500;
const DIRECTORY_COUNT = 21;

let repoRoot = '';

function runGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function spawnSucceeds() {
  return new Promise<string>((resolve) => {
    execFile('git', ['--version'], (error, stdout) => resolve(error ? `failed: ${error.message}` : stdout.trim()));
  });
}

async function nativeWatchWorks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-watch-probe-'));
  try {
    const watcher = fs.watch(dir, {recursive: defaultNativeWatchMode() === 'recursive'});
    const failed = await new Promise<boolean>((resolve) => {
      watcher.once('error', () => resolve(true));
      setTimeout(() => resolve(false), 100);
    });
    watcher.close();
    return !failed;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// CI must run these; elsewhere a sandbox that refuses fs.watch skips them.
const available = Boolean(process.env.CI) || await nativeWatchWorks();
const modes: NativeWatchMode[] = [...new Set<NativeWatchMode>([defaultNativeWatchMode(), 'directories'])];

beforeAll(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-watch-scale-'));
  runGit(repoRoot, 'init', '-q', '-b', 'main');
  for (let dirIndex = 0; dirIndex < DIRECTORY_COUNT; dirIndex += 1) {
    const dir = path.join(repoRoot, 'pkg', `d${dirIndex}`);
    fs.mkdirSync(dir, {recursive: true});
    for (let fileIndex = 0; fileIndex < FILE_COUNT / DIRECTORY_COUNT; fileIndex += 1) {
      fs.writeFileSync(path.join(dir, `f${fileIndex}.txt`), `${fileIndex}\n`);
    }
  }
  runGit(repoRoot, 'add', '.');
  runGit(repoRoot, 'commit', '-q', '-m', 'many files');
}, 120_000);

afterAll(() => {
  if (repoRoot) fs.rmSync(repoRoot, {recursive: true, force: true});
});

describe.each(modes)('repo watcher in a repo with %s-mode native watching and more than 10,240 files', (nativeMode) => {
  const it = available ? base.it : base.it.skip;

  it('still spawns child processes and still reports an edit after ready', async () => {
    expect(Number(runGit(repoRoot, 'ls-files').split('\n').length)).toBeGreaterThan(10_240);

    let changes = 0;
    const errors: Error[] = [];
    let resolveChange: () => void = () => {};
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const watcher = createRepoWatcher({
      repoRoot,
      debounceMs: 20,
      nativeMode,
      onReady: resolveReady,
      onChange: () => {
        changes += 1;
        resolveChange();
      },
      onError: (error) => errors.push(error),
    });

    try {
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(await spawnSucceeds()).toMatch(/^git version/);
      expect(errors.map((error) => error.message)).toEqual([]);

      fs.appendFileSync(path.join(repoRoot, 'pkg', 'd7', 'f3.txt'), 'edited\n');
      await Promise.race([changed, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      expect(changes).toBeGreaterThan(0);
      expect(await spawnSucceeds()).toMatch(/^git version/);
    } finally {
      await watcher.close();
    }
  }, 120_000);
});
