import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as base from 'vitest';
import {afterEach, describe, expect} from 'vitest';
import {createRepoWatcher, defaultNativeWatchMode, type CreateRepoWatcherOptions, type NativeWatchMode} from '../src/watch/repoWatcher.js';

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

function openFdCount() {
  for (const fdDir of ['/proc/self/fd', '/dev/fd']) {
    try {
      return fs.readdirSync(fdDir).length;
    } catch {
      // Not on this platform.
    }
  }
  return null;
}

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await flush(50);
  }
  return check();
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
// works; there the native variants are skipped. CI must have native watching,
// so a failing probe fails the run there instead of skipping.
async function nativeWatchProbe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-watch-probe-'));
  try {
    const watchers = [fs.watch(dir), fs.watch(dir, {recursive: defaultNativeWatchMode() === 'recursive'})];
    const failure = await new Promise<Error | null>((resolve) => {
      for (const watcher of watchers) watcher.once('error', resolve);
      setTimeout(() => resolve(null), 100);
    });
    for (const watcher of watchers) watcher.close();
    return failure;
  } catch (error) {
    return error as Error;
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const nativeProbeFailure = await nativeWatchProbe();
const requireNative = Boolean(process.env.CI);
const nativeModes: NativeWatchMode[] = [...new Set<NativeWatchMode>([defaultNativeWatchMode(), 'directories'])];
const watchModes = [
  ...nativeModes.map((nativeMode) => ({
    name: `fs.watch ${nativeMode}`,
    usePolling: false,
    nativeMode,
    available: requireNative || nativeProbeFailure === null,
  })),
  {name: 'polling', usePolling: true, nativeMode: undefined, available: true},
];

base.it.runIf(requireNative)('can watch natively in CI', () => {
  expect(nativeProbeFailure?.message ?? null).toBeNull();
});

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe.each(watchModes)('repo watcher coverage ($name)', {timeout: 60_000}, ({usePolling, nativeMode, available}) => {
  const it = available ? base.it : base.it.skip;

  it('fires for edits under tracked top-level lib/ and dist/ directories', async () => {
    const cwd = createRepo({'lib/index.js': 'module.exports = 1;\n', 'dist/keep.js': 'keep\n'});
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    fs.writeFileSync(path.join(cwd, 'lib', 'index.js'), 'module.exports = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.settle();
    fs.writeFileSync(path.join(cwd, 'dist', 'keep.js'), 'keep 2\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('fires for edits inside directories created after the watcher started', async () => {
    const cwd = createRepo();
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

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
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

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
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

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
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    fs.writeFileSync(path.join(cwd, '.gitignore'), '# nothing ignored\n');
    expect(await watcher.waitForChange()).toBe(true);
    watcher.reset();

    // Written whether or not the re-listing has finished: either the write
    // is seen, or the re-listing refreshes once dev.log counts.
    fs.appendFileSync(path.join(cwd, 'dev.log'), 'now visible\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('refreshes after a re-listing un-ignores a path that was written while it ran', async () => {
    const cwd = createRepo({'.gitignore': '*.log\n'});
    fs.writeFileSync(path.join(cwd, 'dev.log'), 'start\n');
    const slowFlag = path.join(makeTempDir('branch-review-slow-flag-'), 'on');
    installFakeGit(`case "$*" in *ls-files*) [ -f '${slowFlag}' ] && sleep 1.5;; esac\nexec "$REAL_GIT" "$@"`);
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    fs.writeFileSync(slowFlag, '');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '# nothing ignored\n');
    expect(await watcher.waitForChange()).toBe(true);
    // The .gitignore refresh has fired; the re-listing is still asleep.
    await watcher.settle(usePolling ? 700 : 300);

    fs.appendFileSync(path.join(cwd, 'dev.log'), 'written while git was listing\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('fires for tracked files with editor backup and swap names', async () => {
    const cwd = createRepo({'notes~': 'one\n', '.session.vim.swp': 'one\n'});
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    fs.writeFileSync(path.join(cwd, 'notes~'), 'two\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.settle();
    fs.writeFileSync(path.join(cwd, '.session.vim.swp'), 'two\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('fires for a new file whose name starts with pathspec magic, without a watch error', async () => {
    const cwd = createRepo();
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    fs.writeFileSync(path.join(cwd, ':!x.ts'), 'export const x = 1;\n');
    expect(await watcher.waitForChange()).toBe(true);
    await flush(300);
    expect(watcher.errors.map((error) => error.message)).toEqual([]);

    await watcher.close();
  });

  it('does not go into a submodule, and writes to its ignored files raise no error', async () => {
    const subSource = createRepo({'.gitignore': 'node_modules/\n'});
    const cwd = createRepo();
    runGit(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub');
    runGit(cwd, 'commit', '-q', '-m', 'add submodule');
    writeFile(cwd, 'sub/node_modules/dep/index.js', 'dep\n');
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    for (let index = 0; index < 3; index += 1) {
      fs.appendFileSync(path.join(cwd, 'sub', 'node_modules', 'dep', 'index.js'), `line ${index}\n`);
      writeFile(cwd, `sub/node_modules/dep/new${index}.js`, 'new\n');
      await flush(150);
    }
    await flush(600);
    expect(watcher.changes).toBe(0);
    expect(watcher.errors.map((error) => error.message)).toEqual([]);

    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('does not follow tracked symlinks out of the repo or into a loop', async () => {
    const outside = makeTempDir('branch-review-watch-outside-');
    writeFile(outside, 'deep/file.txt', 'outside\n');
    const cwd = createRepo();
    fs.symlinkSync(outside, path.join(cwd, 'linkout'));
    fs.symlinkSync('..', path.join(cwd, 'src', 'up'));
    runGit(cwd, 'add', '.');
    runGit(cwd, 'commit', '-q', '-m', 'add links');
    const fdsBefore = openFdCount();
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});
    const fdsAfter = openFdCount();

    if (fdsBefore !== null && fdsAfter !== null) expect(fdsAfter - fdsBefore).toBeLessThan(100);
    expect(watcher.errors.map((error) => error.message)).toEqual([]);

    fs.writeFileSync(path.join(outside, 'deep', 'file.txt'), 'outside 2\n');
    fs.writeFileSync(path.join(outside, 'new.txt'), 'new\n');
    await flush(900);
    expect(watcher.changes).toBe(0);

    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  // Reading a file only moves its atime; with an mtime in the future some
  // watchers report every read as a change.
  (usePolling ? base.it.skip : it)('does not fire when a file with a future mtime is only read', async () => {
    const cwd = createRepo({'future.ts': 'export const f = 1;\n'});
    const filePath = path.join(cwd, 'future.ts');
    const future = new Date(Date.now() + 60 * 60 * 1000);
    fs.utimesSync(filePath, future, future);
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    fs.writeFileSync(filePath, 'export const f = 2;\n');
    fs.utimesSync(filePath, future, future);
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle();

    // What a refresh does: other processes read the file.
    for (let index = 0; index < 8; index += 1) {
      execFileSync('cat', [filePath]);
      runGit(cwd, 'diff', 'HEAD');
      await flush(400);
    }
    await flush(500);
    expect(watcher.changes).toBe(0);

    await watcher.close();
  });

  (usePolling ? base.it.skip : it)('refreshes at least once a second during a continuous write stream', async () => {
    const cwd = createRepo();
    const watcher = await startWatcher(cwd, {usePolling, nativeMode, debounceMs: 200});

    const startedAt = Date.now();
    let firstChangeAt: number | null = null;
    for (let index = 0; index < 40; index += 1) {
      fs.appendFileSync(path.join(cwd, 'src', 'one.ts'), `// ${index}\n`);
      await flush(60);
      if (firstChangeAt === null && watcher.changes > 0) firstChangeAt = Date.now() - startedAt;
    }

    expect(firstChangeAt).not.toBeNull();
    expect(firstChangeAt!).toBeLessThan(1800);

    await watcher.close();
  });

  it('stops refreshing for a file once .git/info/exclude ignores it', async () => {
    const cwd = createRepo();
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    // Seen once while visible, so the watcher remembers it as visible.
    fs.writeFileSync(path.join(cwd, 'scratch.tmp'), 'one\n');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle();

    fs.appendFileSync(path.join(cwd, '.git', 'info', 'exclude'), '*.tmp\n');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(800);

    fs.appendFileSync(path.join(cwd, 'scratch.tmp'), 'two\n');
    await flush(900);
    expect(watcher.changes).toBe(0);

    await watcher.close();
  });

  it('reports a failed ignore listing through onError and still watches the repo', async () => {
    const cwd = createRepo();
    installFakeGit('case "$*" in *ls-files*) echo "fatal: simulated ls-files failure" >&2; exit 128;; esac\nexec "$REAL_GIT" "$@"');
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});
    process.env.PATH = originalPath;

    expect(watcher.errors.map((error) => error.message).join('\n')).toContain('fatal: simulated ls-files failure');

    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it("keeps git's reason when a re-listing of ignored files fails after startup", async () => {
    const cwd = createRepo({'.gitignore': '*.log\n'});
    const failFlag = path.join(makeTempDir('branch-review-fail-flag-'), 'on');
    installFakeGit(`case "$*" in *ls-files*) [ -f '${failFlag}' ] && { echo "fatal: simulated re-listing failure" >&2; exit 128; };; esac\nexec "$REAL_GIT" "$@"`);
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});
    expect(watcher.errors).toEqual([]);

    fs.writeFileSync(failFlag, '');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '*.tmp\n');
    expect(await waitUntil(() => watcher.errors.length > 0, 10_000)).toBe(true);
    expect(watcher.errors.map((error) => error.message)).toEqual([
      'could not list ignored files: fatal: simulated re-listing failure',
    ]);

    await watcher.close();
  });

  it("reports git's fatal line, not a warning printed before it, when the ignore listing fails", async () => {
    const cwd = createRepo();
    installFakeGit('case "$*" in *--ignored*) echo "warning: a warning first" >&2; echo "fatal: the real reason" >&2; exit 128;; esac\nexec "$REAL_GIT" "$@"');
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});
    process.env.PATH = originalPath;

    expect(watcher.errors.map((error) => error.message)).toEqual([
      'could not list ignored files: fatal: the real reason',
    ]);

    await watcher.close();
  });

  it('refreshes when a cloned directory loses its .git, and sees later edits there', async () => {
    const lib = createRepo({'lib/m.ts': 'export const m = 1;\n'});
    const cwd = createRepo();
    fs.mkdirSync(path.join(cwd, 'vendor'));
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    runGit(cwd, 'clone', '-q', lib, 'vendor/lib');
    await watcher.settle(1500);

    fs.rmSync(path.join(cwd, 'vendor', 'lib', '.git'), {recursive: true, force: true});
    expect(runGit(cwd, 'status', '--porcelain', '-uall')).toContain('vendor/lib/lib/m.ts');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(usePolling ? 1000 : 500);

    fs.writeFileSync(path.join(cwd, 'vendor', 'lib', 'lib', 'm.ts'), 'export const m = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('refreshes when git init turns a directory into a nested repo, then stops refreshing for its files', async () => {
    const cwd = createRepo();
    writeFile(cwd, 'app/a.txt', 'untracked\n');
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    runGit(cwd, 'init', '-q', 'app');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(800);

    fs.appendFileSync(path.join(cwd, 'app', 'a.txt'), 'inside the nested repo now\n');
    await flush(900);
    expect(watcher.changes).toBe(0);

    fs.rmSync(path.join(cwd, 'app', '.git'), {recursive: true, force: true});
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(usePolling ? 1000 : 500);

    fs.appendFileSync(path.join(cwd, 'app', 'a.txt'), 'visible again\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('refreshes when a submodule commits or checks out another commit', async () => {
    const subSource = createRepo();
    const cwd = createRepo();
    runGit(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub');
    runGit(cwd, 'commit', '-q', '-m', 'add submodule');
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    runGit(path.join(cwd, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'inside the submodule');
    expect(runGit(cwd, 'diff', '--name-only')).toBe('sub');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle();

    runGit(path.join(cwd, 'sub'), 'checkout', '-q', '--detach', 'HEAD~1');
    expect(runGit(cwd, 'diff', '--name-only')).toBe('');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('refreshes when a submodule added after the watcher started commits or checks out another commit', async () => {
    const subSource = createRepo();
    const cwd = createRepo();
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    runGit(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(1500);

    runGit(path.join(cwd, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'inside the late submodule');
    expect(runGit(cwd, 'diff', '--name-only')).toBe('sub');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle();

    runGit(path.join(cwd, 'sub'), 'checkout', '-q', '--detach', 'HEAD~1');
    expect(runGit(cwd, 'diff', '--name-only')).toBe('');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('does not refresh for a file edit inside a submodule added after the watcher started', async () => {
    const subSource = createRepo();
    const cwd = createRepo();
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    runGit(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(1500);

    fs.appendFileSync(path.join(cwd, 'sub', 'src', 'one.ts'), 'export const inside = 1;\n');
    writeFile(cwd, 'sub/src/new.ts', 'export const added = 1;\n');
    await flush(1000);
    expect(watcher.changes).toBe(0);

    fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('refreshes when a clone staged as a gitlink after the watcher started commits', async () => {
    const lib = createRepo();
    const cwd = createRepo();
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    // Its Git dir stays inside the worktree, outside .git/modules.
    runGit(cwd, 'clone', '-q', lib, 'vendored');
    runGit(cwd, '-c', 'advice.addEmbeddedRepo=false', 'add', 'vendored');
    expect(runGit(cwd, 'ls-files', '--stage', 'vendored')).toMatch(/^160000 /);
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(1500);

    runGit(path.join(cwd, 'vendored'), 'commit', '-q', '--allow-empty', '-m', 'inside the clone');
    expect(runGit(cwd, 'diff', '--name-only')).toBe('vendored');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('refreshes when a gitlink staged after the watcher started, with its Git dir inside .git, commits', async () => {
    const lib = createRepo();
    // The CLI watches git's toplevel, a real path, as git's own paths are.
    const cwd = fs.realpathSync(createRepo());
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    // The Git dir lands inside the already-watched .git, outside .git/modules,
    // and exists before anything says it belongs to a gitlink.
    runGit(cwd, 'clone', '-q', '--separate-git-dir', path.join(cwd, '.git', 'vendored-git'), lib, 'vendored');
    await flush(1000);
    runGit(cwd, '-c', 'advice.addEmbeddedRepo=false', 'add', 'vendored');
    expect(runGit(cwd, 'ls-files', '--stage', 'vendored')).toMatch(/^160000 /);
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(1500);

    runGit(path.join(cwd, 'vendored'), 'commit', '-q', '--allow-empty', '-m', 'inside the clone');
    expect(runGit(cwd, 'diff', '--name-only')).toBe('vendored');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('refreshes for a commit in a gitlink Git dir inside .git that lands before the watcher adds the dir', async () => {
    const lib = createRepo();
    // The CLI watches git's toplevel, a real path, as git's own paths are.
    const cwd = fs.realpathSync(createRepo());
    // Once armed, the gitlink listing takes long enough for a commit to land
    // between the index change and the watcher adding the new Git dir.
    const slowFlag = path.join(makeTempDir('branch-review-slow-flag-'), 'on');
    installFakeGit(`case "$*" in *"ls-files -z --stage"*) [ -f '${slowFlag}' ] && sleep 2;; esac\nexec "$REAL_GIT" "$@"`);
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    runGit(cwd, 'clone', '-q', '--separate-git-dir', path.join(cwd, '.git', 'vendored-git'), lib, 'vendored');
    await flush(1000);
    fs.writeFileSync(slowFlag, '');
    runGit(cwd, '-c', 'advice.addEmbeddedRepo=false', 'add', 'vendored');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(500);

    runGit(path.join(cwd, 'vendored'), 'commit', '-q', '--allow-empty', '-m', 'inside the clone');
    expect(runGit(cwd, 'diff', '--name-only')).toBe('vendored');
    expect(await watcher.waitForChange(8000)).toBe(true);

    await watcher.close();
  });

  // A linked worktree keeps its submodules' Git dirs under its own Git dir
  // (`<common git dir>/worktrees/<name>/modules`), apart from the main
  // checkout's.
  function createLinkedWorktree(main: string) {
    const linked = path.join(makeTempDir('branch-review-watch-linked-'), 'linked');
    runGit(main, 'worktree', 'add', '-q', linked, '-b', 'linked-work');
    // The CLI watches git's toplevel, a real path, as git's own paths are.
    return fs.realpathSync(linked);
  }

  it('refreshes when a submodule added in a linked worktree after the watcher started commits or checks out', async () => {
    const subSource = createRepo();
    const main = createRepo();
    const linked = createLinkedWorktree(main);
    const watcher = await startWatcher(linked, {usePolling, nativeMode});

    runGit(linked, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub');
    expect(runGit(linked, 'rev-parse', '--git-path', 'modules')).toContain(`${path.sep}worktrees${path.sep}`);
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle(1500);

    runGit(path.join(linked, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'inside the late submodule');
    expect(runGit(linked, 'diff', '--name-only')).toBe('sub');
    expect(await watcher.waitForChange()).toBe(true);
    await watcher.settle();

    runGit(path.join(linked, 'sub'), 'checkout', '-q', '--detach', 'HEAD~1');
    expect(runGit(linked, 'diff', '--name-only')).toBe('');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('refreshes when a submodule initialized in a linked worktree after the watcher started commits', async () => {
    const subSource = createRepo();
    const main = createRepo();
    runGit(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub');
    runGit(main, 'commit', '-q', '-m', 'add submodule');
    // A new worktree leaves its submodules uninitialized.
    const linked = createLinkedWorktree(main);
    expect(fs.existsSync(path.join(linked, 'sub', '.git'))).toBe(false);
    const watcher = await startWatcher(linked, {usePolling, nativeMode});

    runGit(linked, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init');
    expect(fs.existsSync(path.join(linked, 'sub', '.git'))).toBe(true);
    await watcher.settle(1500);

    runGit(path.join(linked, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'inside the initialized submodule');
    expect(runGit(linked, 'diff', '--name-only')).toBe('sub');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it("does not refresh a linked worktree's review when the main checkout's submodule commits", async () => {
    const subSource = createRepo();
    const main = createRepo();
    runGit(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub');
    runGit(main, 'commit', '-q', '-m', 'add submodule');
    const linked = createLinkedWorktree(main);
    const watcher = await startWatcher(linked, {usePolling, nativeMode});
    await watcher.settle();

    runGit(path.join(main, 'sub'), 'commit', '-q', '--allow-empty', '-m', 'inside the main checkout submodule');
    expect(runGit(main, 'diff', '--name-only')).toBe('sub');
    await flush(1500);
    expect(watcher.changes).toBe(0);

    fs.writeFileSync(path.join(linked, 'src', 'one.ts'), 'export const value = 2;\n');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('stops a running ignore re-listing and ignore check when closed', async () => {
    const cwd = createRepo({'.gitignore': '*.log\n'});
    const flagDir = makeTempDir('branch-review-slow-git-');
    const slowFlag = path.join(flagDir, 'on');
    // Once the flag exists, each ls-files or check-ignore call records its
    // pid and sleeps in place of answering.
    installFakeGit(`case "$*" in *ls-files*|*check-ignore*) [ -f '${slowFlag}' ] && { echo $$ >> '${flagDir}/pids'; exec sleep 8; };; esac\nexec "$REAL_GIT" "$@"`);
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    fs.writeFileSync(slowFlag, '');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '*.tmp\n');
    fs.writeFileSync(path.join(cwd, 'src', 'new.ts'), 'export const n = 1;\n');
    const readPids = () => {
      try {
        return fs.readFileSync(path.join(flagDir, 'pids'), 'utf8').trim().split('\n').map(Number).filter(Boolean);
      } catch {
        return [];
      }
    };
    expect(await waitUntil(() => readPids().length >= 2, 10_000)).toBe(true);
    const pids = readPids();
    try {
      const closedAt = Date.now();
      await watcher.close();
      expect(Date.now() - closedAt).toBeLessThan(1000);
      expect(await waitUntil(() => pids.every((pid) => !isAlive(pid)), 1000)).toBe(true);
      expect(watcher.errors).toEqual([]);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });

});

describe.each(watchModes.filter((mode) => mode.nativeMode === 'directories'))('repo watcher handle count ($name)', {timeout: 60_000}, ({usePolling, nativeMode, available}) => {
  const it = available ? base.it : base.it.skip;

  // Counts the fs.watch handles that are open at once.
  function countWatchHandles() {
    const originalWatch = fs.watch;
    let live = 0;
    let peak = 0;
    // Every path ever watched, and the paths watched now.
    const everWatched = new Set<string>();
    const openPaths = new Map<string, number>();
    const spy = base.vi.spyOn(fs, 'watch').mockImplementation(((...args: Parameters<typeof fs.watch>) => {
      const watcher = originalWatch(...args);
      const watchedPath = String(args[0]);
      live += 1;
      peak = Math.max(peak, live);
      everWatched.add(watchedPath);
      openPaths.set(watchedPath, (openPaths.get(watchedPath) ?? 0) + 1);
      const close = watcher.close.bind(watcher);
      let open = true;
      watcher.close = () => {
        if (open) {
          live -= 1;
          openPaths.set(watchedPath, (openPaths.get(watchedPath) ?? 1) - 1);
        }
        open = false;
        close();
      };
      return watcher;
    }) as typeof fs.watch);
    return {
      everWatched,
      isOpen: (watchedPath: string) => (openPaths.get(watchedPath) ?? 0) > 0,
      get live() {
        return live;
      },
      get peak() {
        return peak;
      },
      resetPeak() {
        peak = live;
      },
      restore: () => spy.mockRestore(),
    };
  }

  // Builds the tree elsewhere and renames it in, so it appears at once.
  function moveTreeIn(cwd: string, name: string, build: (dir: string) => void) {
    const staging = path.join(makeTempDir('branch-review-staging-'), name);
    fs.mkdirSync(staging);
    build(staging);
    fs.renameSync(staging, path.join(cwd, name));
  }

  it('asks git about a new directory before walking it, so a new ignored tree opens no handles', async () => {
    const cwd = createRepo({'.gitignore': 'build/\nnode_modules/\n'});
    const handles = countWatchHandles();
    try {
      const watcher = await startWatcher(cwd, {usePolling, nativeMode});
      const visibleHandles = handles.live;
      handles.resetPeak();

      moveTreeIn(cwd, 'build', (dir) => {
        for (let index = 0; index < 600; index += 1) fs.mkdirSync(path.join(dir, `out${index}`));
      });
      // A visible new directory with an ignored tree inside it.
      moveTreeIn(cwd, 'pkg', (dir) => {
        writeFile(dir, 'src/a.ts', 'export const a = 1;\n');
        for (let index = 0; index < 600; index += 1) fs.mkdirSync(path.join(dir, 'node_modules', `dep${index}`), {recursive: true});
      });
      expect(await watcher.waitForChange()).toBe(true);
      await watcher.settle(800);

      expect(handles.peak - visibleHandles).toBeLessThan(20);

      // The visible part of the new tree is watched.
      fs.writeFileSync(path.join(cwd, 'pkg', 'src', 'a.ts'), 'export const a = 2;\n');
      expect(await watcher.waitForChange()).toBe(true);

      await watcher.close();
    } finally {
      handles.restore();
    }
  });

  it('opens no handle for a new directory that git ignores', async () => {
    const cwd = createRepo({'.gitignore': 'build/\n'});
    const handles = countWatchHandles();
    try {
      const watcher = await startWatcher(cwd, {usePolling, nativeMode});
      const buildDir = path.join(cwd, 'build');

      fs.mkdirSync(buildDir);
      await flush(800);
      writeFile(cwd, 'build/out.js', 'output\n');
      await flush(500);

      expect(handles.everWatched.has(buildDir)).toBe(false);
      expect(watcher.changes).toBe(0);

      fs.writeFileSync(path.join(cwd, 'src', 'one.ts'), 'export const value = 2;\n');
      expect(await watcher.waitForChange()).toBe(true);

      await watcher.close();
    } finally {
      handles.restore();
    }
  });

  it('skips a queued directory that became ignored while git was asked about it', async () => {
    const cwd = createRepo({'.gitignore': '*.log\n'});
    const flags = makeTempDir('branch-review-held-check-');
    const on = path.join(flags, 'on');
    const held = path.join(flags, 'held');
    const listed = path.join(flags, 'listed');
    const release = path.join(flags, 'release');
    // Once `on` exists, a check-ignore asking about pkg/inner answers at
    // once but holds its answer until `release` exists, and each ignore
    // re-listing leaves `listed` behind when it is done.
    installFakeGit([
      `if [ -f '${on}' ]; then case "$*" in`,
      `  *check-ignore*) work=$(mktemp -d '${flags}/run.XXXXXX'); cat > "$work/in"`,
      `    "$REAL_GIT" "$@" < "$work/in" > "$work/out"; code=$?`,
      `    if grep -q 'pkg/inner' "$work/in"; then : > '${held}'; while [ ! -f '${release}' ]; do sleep 0.05; done; fi`,
      `    cat "$work/out"; exit $code;;`,
      `  *--ignored*) "$REAL_GIT" "$@"; code=$?; : > '${listed}'; exit $code;;`,
      'esac; fi',
      'exec "$REAL_GIT" "$@"',
    ].join('\n'));
    const handles = countWatchHandles();
    try {
      const watcher = await startWatcher(cwd, {usePolling, nativeMode});
      fs.writeFileSync(on, '');

      // pkg/a.ts keeps pkg itself visible once pkg/inner is ignored.
      moveTreeIn(cwd, 'pkg', (dir) => {
        writeFile(dir, 'a.ts', 'export const a = 1;\n');
        writeFile(dir, 'inner/deep/x.txt', 'x\n');
      });
      expect(await waitUntil(() => fs.existsSync(held), 10_000)).toBe(true);
      // The answer git is holding was computed under the old rules.
      fs.writeFileSync(path.join(cwd, '.gitignore'), '*.log\npkg/inner/\n');
      expect(await waitUntil(() => fs.existsSync(listed), 10_000)).toBe(true);
      await flush(300);
      fs.writeFileSync(release, '');
      await flush(800);

      expect(handles.isOpen(path.join(cwd, 'pkg'))).toBe(true);
      expect(handles.everWatched.has(path.join(cwd, 'pkg', 'inner'))).toBe(false);

      await watcher.close();
    } finally {
      fs.writeFileSync(release, '');
      handles.restore();
    }
  });

  it('asks git about the directories a checkout adds in a few runs, and watches them', async () => {
    const cwd = createRepo({'.gitignore': 'build/\n'});
    runGit(cwd, 'checkout', '-q', '-b', 'many');
    for (let index = 0; index < 60; index += 1) writeFile(cwd, `src/d${index}/f.ts`, `export const v = ${index};\n`);
    runGit(cwd, 'add', '.');
    runGit(cwd, 'commit', '-q', '-m', 'sixty directories');
    runGit(cwd, 'checkout', '-q', 'main');
    const runs = path.join(makeTempDir('branch-review-check-ignore-runs-'), 'runs');
    installFakeGit(`case "$*" in *check-ignore*) echo run >> '${runs}';; esac\nexec "$REAL_GIT" "$@"`);
    const countRuns = () => {
      try {
        return fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    const handles = countWatchHandles();
    try {
      const watcher = await startWatcher(cwd, {usePolling, nativeMode});
      const runsBefore = countRuns();

      runGit(cwd, 'checkout', '-q', 'many');
      expect(await watcher.waitForChange()).toBe(true);
      await watcher.settle(1500);

      expect(countRuns() - runsBefore).toBeLessThanOrEqual(10);
      // New directories are watched once git has checked them for ignore
      // rules, which can outlast the settle window on a slow machine.
      expect(await waitUntil(() => handles.isOpen(path.join(cwd, 'src', 'd59')), 10_000)).toBe(true);

      fs.writeFileSync(path.join(cwd, 'src', 'd59', 'f.ts'), 'export const v = -1;\n');
      expect(await watcher.waitForChange()).toBe(true);
      await watcher.settle();

      // An ignored directory made now is still never watched.
      fs.mkdirSync(path.join(cwd, 'build'));
      writeFile(cwd, 'build/nested/out.js', 'output\n');
      await flush(800);
      expect(handles.everWatched.has(path.join(cwd, 'build'))).toBe(false);
      expect(watcher.changes).toBe(0);

      await watcher.close();
    } finally {
      handles.restore();
    }
  });

  it("watches a submodule's Git dir for HEAD and logs/HEAD without opening its objects or refs", async () => {
    const subSource = createRepo();
    const cwd = createRepo();
    const handles = countWatchHandles();
    try {
      const watcher = await startWatcher(cwd, {usePolling, nativeMode});
      runGit(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'sub');
      expect(await watcher.waitForChange()).toBe(true);
      await watcher.settle(1500);

      const subGitDir = path.join(cwd, '.git', 'modules', 'sub');
      expect(handles.isOpen(subGitDir)).toBe(true);
      expect(handles.isOpen(path.join(subGitDir, 'logs'))).toBe(true);
      const internals = [...handles.everWatched].filter((watched) => (
        ['objects', 'refs', 'hooks', 'info'].includes(path.relative(subGitDir, watched).split(path.sep)[0] ?? '')
      ));
      expect(internals).toEqual([]);

      await watcher.close();
    } finally {
      handles.restore();
    }
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

describe.each(watchModes)('repo watcher Git state coverage ($name)', {timeout: 60_000}, ({usePolling, nativeMode, available}) => {
  const it = available ? base.it : base.it.skip;

  it('fires when another worktree commits to a branch that is not checked out here', async () => {
    const cwd = createRepo();
    runGit(cwd, 'branch', 'feature/agent');
    runGit(cwd, 'checkout', '-q', '-b', 'hc/wip');
    const agentWorktree = path.join(makeTempDir('branch-review-agent-'), 'wt');
    runGit(cwd, 'worktree', 'add', '-q', agentWorktree, 'feature/agent');
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

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
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    runGit(cwd, 'update-ref', 'refs/heads/side', 'HEAD');
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });

  it('fires when FETCH_HEAD is written for the first time', async () => {
    const upstream = createRepo();
    const cwd = createRepo();
    expect(fs.existsSync(path.join(cwd, '.git', 'FETCH_HEAD'))).toBe(false);
    const watcher = await startWatcher(cwd, {usePolling, nativeMode});

    runGit(cwd, 'fetch', '-q', upstream, 'main');
    expect(fs.existsSync(path.join(cwd, '.git', 'FETCH_HEAD'))).toBe(true);
    expect(await watcher.waitForChange()).toBe(true);

    await watcher.close();
  });
});
