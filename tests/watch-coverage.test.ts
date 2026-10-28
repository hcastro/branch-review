import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as base from 'vitest';
import {afterEach, describe, expect} from 'vitest';
import {createRepoWatcher, type CreateRepoWatcherOptions} from '../src/watch/repoWatcher.js';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function runGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string, text: string) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, text);
}

function createRepo(files: Record<string, string> = {}) {
  const cwd = makeTempDir('branch-review-watch-cover-');
  runGit(cwd, 'init', '-q', '-b', 'main');
  writeFile(cwd, 'src/one.ts', 'export const value = 1;\n');
  for (const [relativePath, text] of Object.entries(files)) {
    writeFile(cwd, relativePath, text);
  }
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-q', '-m', 'initial');
  return cwd;
}

function installFakeGit(script: string) {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {encoding: 'utf8'}).trim();
  const binDir = makeTempDir('branch-review-fake-git-');
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\n${script.replaceAll('$REAL_GIT', realGit)}\n`, {mode: 0o755});
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
}

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function startWatcher(repoRoot: string, options: Partial<CreateRepoWatcherOptions> = {}) {
  let changes = 0;
  const errors: Error[] = [];
  const waiters: Array<() => void> = [];
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const watcher = createRepoWatcher({
    repoRoot,
    debounceMs: 20,
    ...options,
    onReady: resolveReady,
    onChange: () => {
      changes += 1;
      for (const waiter of waiters.splice(0)) waiter();
    },
    onError: (error) => errors.push(error),
  });

  await ready;
  // FSEvents can fold a write made right after a stream starts into the
  // creation event, so let the streams settle before editing.
  await flush(200);

  return {
    errors,
    get changes() {
      return changes;
    },
    reset() {
      changes = 0;
    },
    // Returns as soon as a change arrives; the bound only caps the wait.
    async waitForChange(timeoutMs = 10_000) {
      if (changes > 0) return true;
      return Promise.race([
        new Promise<boolean>((resolve) => waiters.push(() => resolve(true))),
        flush(timeoutMs).then(() => false),
      ]);
    },
    // Wait for in-flight events to land, then start counting from zero.
    async settle(ms = 500) {
      await flush(ms);
      changes = 0;
    },
    close: () => watcher.close(),
  };
}

// Some sandboxes refuse fs.watch on directories (EMFILE) while polling still
// works; the native variant only runs where fs.watch is usable.
async function nativeDirectoryWatchWorks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-watch-probe-'));
  try {
    const watcher = fs.watch(dir);
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

const watchModes = [
  {name: 'fs.watch', usePolling: false, available: await nativeDirectoryWatchWorks()},
  {name: 'polling', usePolling: true, available: true},
];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe.each(watchModes)('repo watcher coverage ($name)', {timeout: 60_000}, ({usePolling, available}) => {
  const it = available ? base.it : base.it.skip;

  it('fires for edits under tracked top-level lib/ and dist/ directories', async () => {
    const cwd = createRepo({'lib/index.js': 'module.exports = 1;\n', 'dist/keep.js': 'keep\n'});
    const watcher = await startWatcher(cwd, {usePolling});

    fs.writeFileSync(path.join(cwd, 'lib', 'index.js'), 'module.exports = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.settle();
    fs.writeFileSync(path.join(cwd, 'dist', 'keep.js'), 'keep 2\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('fires for edits inside directories created after the watcher started', async () => {
    const cwd = createRepo();
    const watcher = await startWatcher(cwd, {usePolling});

    fs.mkdirSync(path.join(cwd, 'src', 'feature', 'deep'), {recursive: true});
    await flush(300);
    fs.writeFileSync(path.join(cwd, 'src', 'feature', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(cwd, 'src', 'feature', 'deep', 'b.ts'), 'export const b = 1;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.settle();
    fs.writeFileSync(path.join(cwd, 'src', 'feature', 'deep', 'b.ts'), 'export const b = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.settle();
    fs.writeFileSync(path.join(cwd, 'src', 'feature', 'a.ts'), 'export const a = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('keeps watching a directory that a checkout removed and re-created', async () => {
    const cwd = createRepo();
    runGit(cwd, 'checkout', '-q', '-b', 'feat');
    writeFile(cwd, 'pkg/x.ts', 'export const x = 1;\n');
    runGit(cwd, 'add', '.');
    runGit(cwd, 'commit', '-q', '-m', 'add pkg');
    const watcher = await startWatcher(cwd, {usePolling});

    runGit(cwd, 'checkout', '-q', 'main');
    expect(fs.existsSync(path.join(cwd, 'pkg'))).toBe(false);
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle();

    runGit(cwd, 'checkout', '-q', 'feat');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle();

    fs.writeFileSync(path.join(cwd, 'pkg', 'x.ts'), 'export const x = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('does not fire for writes to gitignored files, but still fires for a tracked file beside them', async () => {
    const cwd = createRepo({'.gitignore': '*.log\nout/\n'});
    fs.writeFileSync(path.join(cwd, 'dev.log'), 'start\n');
    const watcher = await startWatcher(cwd, {usePolling});

    for (let index = 0; index < 5; index += 1) {
      fs.appendFileSync(path.join(cwd, 'dev.log'), `line ${index}\n`);
      await flush(80);
    }

    // Ignored paths that appear only after startup.
    fs.writeFileSync(path.join(cwd, 'src', 'new.log'), 'new\n');
    fs.mkdirSync(path.join(cwd, 'out'));
    fs.writeFileSync(path.join(cwd, 'out', 'bundle.js'), 'bundle\n');
    await flush(400);
    fs.appendFileSync(path.join(cwd, 'src', 'new.log'), 'more\n');
    fs.appendFileSync(path.join(cwd, 'out', 'bundle.js'), 'more\n');
    await flush(600);
    expect(watcher.changes).toBe(0);

    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('starts watching a file once .gitignore stops ignoring it', async () => {
    const cwd = createRepo({'.gitignore': '*.log\n'});
    fs.writeFileSync(path.join(cwd, 'dev.log'), 'start\n');
    const watcher = await startWatcher(cwd, {usePolling});

    fs.writeFileSync(path.join(cwd, '.gitignore'), '# nothing ignored\n');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(800);

    fs.appendFileSync(path.join(cwd, 'dev.log'), 'now visible\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('reports a failed ignore listing through onError and still watches the repo', async () => {
    const cwd = createRepo();
    installFakeGit('case "$*" in *ls-files*) echo "fatal: simulated ls-files failure" >&2; exit 128;; esac\nexec "$REAL_GIT" "$@"');
    const watcher = await startWatcher(cwd, {usePolling});
    process.env.PATH = originalPath;

    expect(watcher.errors.map((error) => error.message).join('\n')).toContain('fatal: simulated ls-files failure');

    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

});

describe('repo watcher with large listings', () => {
  base.it('watches subdirectories when git file listings pass 1 MiB', async () => {
    // Long nested names push both the tracked and the ignored listing past
    // execFileSync's 1 MiB default buffer with a modest file count.
    const deepDir = path.join('d'.repeat(200), 'e'.repeat(200), 'f'.repeat(200));
    const cwd = makeTempDir('branch-review-watch-big-');
    runGit(cwd, 'init', '-q', '-b', 'main');
    writeFile(cwd, 'src/one.ts', 'export const value = 1;\n');
    writeFile(cwd, '.gitignore', '*.tmp\n');
    fs.mkdirSync(path.join(cwd, deepDir), {recursive: true});
    const longName = 'n'.repeat(180);
    for (let index = 0; index < 1400; index += 1) {
      fs.writeFileSync(path.join(cwd, deepDir, `${longName}${index}.txt`), '');
      fs.writeFileSync(path.join(cwd, deepDir, `${longName}${index}.tmp`), '');
    }
    runGit(cwd, 'add', '.');
    runGit(cwd, 'commit', '-q', '-m', 'big');
    expect(runGit(cwd, 'ls-files', '-z').length).toBeGreaterThan(1024 * 1024);

    const watcher = await startWatcher(cwd, {usePolling: true});
    expect(watcher.errors).toEqual([]);

    fs.appendFileSync(path.join(cwd, deepDir, `${longName}7.tmp`), 'ignored\n');
    await flush(900);
    expect(watcher.changes).toBe(0);

    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  }, 60_000);
});

describe.each(watchModes)('repo watcher Git state coverage ($name)', {timeout: 60_000}, ({usePolling, available}) => {
  const it = available ? base.it : base.it.skip;

  it('fires when another worktree commits to a branch that is not checked out here', async () => {
    const cwd = createRepo();
    runGit(cwd, 'branch', 'feature/agent');
    runGit(cwd, 'checkout', '-q', '-b', 'hc/wip');
    const agentWorktree = path.join(makeTempDir('branch-review-agent-'), 'wt');
    runGit(cwd, 'worktree', 'add', '-q', agentWorktree, 'feature/agent');
    const watcher = await startWatcher(cwd, {usePolling});

    fs.writeFileSync(path.join(agentWorktree, 'agent.txt'), 'agent\n');
    runGit(agentWorktree, 'add', 'agent.txt');
    runGit(agentWorktree, 'commit', '-q', '-m', 'agent work');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('fires when a branch moves while HEAD is detached', async () => {
    const cwd = createRepo();
    runGit(cwd, 'branch', 'side');
    runGit(cwd, 'checkout', '-q', '--detach');
    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
    runGit(cwd, 'commit', '-q', '-am', 'detached work');
    const watcher = await startWatcher(cwd, {usePolling});

    runGit(cwd, 'update-ref', 'refs/heads/side', 'HEAD');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('fires when FETCH_HEAD is written for the first time', async () => {
    const upstream = createRepo();
    const cwd = createRepo();
    expect(fs.existsSync(path.join(cwd, '.git', 'FETCH_HEAD'))).toBe(false);
    const watcher = await startWatcher(cwd, {usePolling});

    runGit(cwd, 'fetch', '-q', upstream, 'main');
    expect(fs.existsSync(path.join(cwd, '.git', 'FETCH_HEAD'))).toBe(true);
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });
});
