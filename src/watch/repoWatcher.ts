import path from 'node:path';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {watch, type FSWatcher} from 'chokidar';
import {debounce} from './debounce.js';

// Ignored listings can be large (one line per ignored file in a tracked
// directory); a short buffer would fail and silently shrink what is watched.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const GIT_ARGS = ['-c', 'core.fsmonitor=false'];
const IGNORE_CHECK_DELAY_MS = 10;
// Used only when git cannot list ignored paths, so the watcher does not walk
// the usual dependency directory.
const FALLBACK_IGNORED = ['node_modules/'];

export type RepoWatcher = {
  close: () => Promise<void>;
};

export type CreateRepoWatcherOptions = {
  repoRoot: string;
  debounceMs?: number;
  usePolling?: boolean;
  onChange: () => void;
  onError?: (error: Error) => void;
  onReady?: () => void;
};

export type WatchIgnoreMatcher = {
  isIgnored: (filePath: string) => boolean;
  add: (relativePaths: Iterable<string>) => void;
};

// No call here passes a pathspec, and check-ignore rejects
// GIT_LITERAL_PATHSPECS, so only optional locks are turned off.
function gitEnv() {
  return {...process.env, GIT_OPTIONAL_LOCKS: '0'};
}

function tryRunGit(repoRoot: string, args: string[]) {
  try {
    return execFileSync('git', [...GIT_ARGS, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function gitFailure(action: string, error: unknown) {
  const stderr = (error as {stderr?: unknown}).stderr;
  const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  const reason = text.split('\n').map((line) => line.trim()).find(Boolean)
    ?? (error instanceof Error ? error.message.split('\n')[0] : String(error));
  return new Error(`${action}: ${reason}`);
}

const IGNORED_LIST_ARGS = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'];

function parseNulList(output: string) {
  return output.split('\0').filter(Boolean);
}

/**
 * Paths git ignores, relative to the repo root with `/` separators. A wholly
 * ignored directory is listed once with a trailing `/`; tracked files are
 * never listed, whatever the ignore rules say.
 */
export function listIgnoredPaths(repoRoot: string) {
  return parseNulList(execFileSync('git', [...GIT_ARGS, ...IGNORED_LIST_ARGS], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

function listIgnoredPathsAsync(repoRoot: string) {
  return new Promise<string[]>((resolve, reject) => {
    execFile('git', [...GIT_ARGS, ...IGNORED_LIST_ARGS], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv(),
      maxBuffer: GIT_MAX_BUFFER,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(parseNulList(stdout));
    });
  });
}

// Resolves to the subset of `relativePaths` that git ignores.
function checkIgnored(repoRoot: string, relativePaths: string[]) {
  return new Promise<Set<string>>((resolve, reject) => {
    const child = spawn('git', [...GIT_ARGS, 'check-ignore', '-z', '--stdin'], {
      cwd: repoRoot,
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // check-ignore exits 1 when nothing matched.
      if (code === 0 || code === 1) resolve(new Set(parseNulList(stdout)));
      else reject(Object.assign(new Error(`git check-ignore exited with code ${code}`), {stderr}));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(relativePaths.map((entry) => `${entry}\0`).join(''));
  });
}

function toRelative(repoRoot: string, filePath: string) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * Decides which worktree paths the watcher skips: anything inside a `.git`
 * directory (Git state has its own watcher) and anything git ignores.
 */
export function createWatchIgnoreMatcher(repoRoot: string, ignoredPaths: Iterable<string>): WatchIgnoreMatcher {
  const ignored = new Set<string>();
  const add = (relativePaths: Iterable<string>) => {
    for (const entry of relativePaths) {
      const normalized = entry.replace(/\/+$/, '');
      if (normalized) ignored.add(normalized);
    }
  };
  add(ignoredPaths);

  return {
    add,
    isIgnored(filePath) {
      const relative = toRelative(repoRoot, filePath);
      if (!relative) return false;

      const segments = relative.split('/');
      let prefix = '';
      for (const segment of segments) {
        if (segment === '.git') return true;
        prefix = prefix ? `${prefix}/${segment}` : segment;
        if (ignored.has(prefix)) return true;
      }

      return false;
    },
  };
}

/**
 * Files and directories under the Git dir whose changes can move the reviewed
 * range or what git ignores. Directories (`refs`, `logs/refs`, `reftable`)
 * cover everything below them. Paths that do not exist yet are included, so
 * the watcher picks them up when git creates them.
 */
export function getGitStateWatchPaths(repoRoot: string) {
  const gitDirRaw = tryRunGit(repoRoot, ['rev-parse', '--git-dir']);
  if (!gitDirRaw) return [];

  const gitDir = path.resolve(repoRoot, gitDirRaw);
  const commonGitDir = path.resolve(repoRoot, tryRunGit(repoRoot, ['rev-parse', '--git-common-dir']) ?? gitDirRaw);

  return [...new Set([
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'FETCH_HEAD'),
    path.join(gitDir, 'index'),
    path.join(gitDir, 'logs', 'HEAD'),
    path.join(commonGitDir, 'packed-refs'),
    path.join(commonGitDir, 'refs'),
    path.join(commonGitDir, 'logs', 'refs'),
    path.join(commonGitDir, 'reftable'),
    path.join(commonGitDir, 'info', 'exclude'),
  ])].sort();
}

function isWithin(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function createRepoWatcher({
  repoRoot,
  debounceMs = 200,
  usePolling = false,
  onChange,
  onError,
  onReady,
}: CreateRepoWatcherOptions): RepoWatcher {
  const notify = debounce(onChange, debounceMs);
  const reportError = (error: unknown) => onError?.(error instanceof Error ? error : new Error(String(error)));
  const watchers: FSWatcher[] = [];
  let closed = false;
  let pendingReady = 0;
  const handleReady = () => {
    pendingReady -= 1;
    if (pendingReady === 0) {
      onReady?.();
    }
  };
  const attach = (watcher: FSWatcher, onEvent: (filePath: string) => void) => {
    pendingReady += 1;
    watchers.push(watcher);
    watcher.on('all', (_event, filePath) => onEvent(filePath));
    watcher.on('error', reportError);
    watcher.on('ready', handleReady);
  };

  let initialIgnored: string[];
  let ignoreListFailed = false;
  try {
    initialIgnored = listIgnoredPaths(repoRoot);
  } catch (error) {
    ignoreListFailed = true;
    initialIgnored = FALLBACK_IGNORED;
    reportError(gitFailure('could not list ignored files', error));
  }

  let matcher = createWatchIgnoreMatcher(repoRoot, initialIgnored);
  let currentIgnored = new Set(initialIgnored.map((entry) => entry.replace(/\/+$/, '')));
  // Paths that appeared after startup and that git says it does not ignore.
  let knownVisible = new Set<string>();
  let ignoreCheckQueue = new Set<string>();
  let ignoreCheckTimer: NodeJS.Timeout | null = null;
  let ignoreGeneration = 0;

  const worktreeWatcher = watch(repoRoot, {
    ignored: (filePath) => matcher.isIgnored(filePath),
    ignoreInitial: true,
    persistent: true,
    usePolling,
    interval: usePolling ? 300 : 100,
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  // Ignore rules can change with any .gitignore, info/exclude, or a checkout,
  // so re-list them and start or stop watching whatever moved.
  let rescanRunning = false;
  let rescanAgain = false;
  const rescanIgnored = async () => {
    if (closed || ignoreListFailed) return;
    if (rescanRunning) {
      rescanAgain = true;
      return;
    }

    rescanRunning = true;
    try {
      const nextList = await listIgnoredPathsAsync(repoRoot);
      if (closed) return;
      const next = new Set(nextList.map((entry) => entry.replace(/\/+$/, '')));
      const noLongerIgnored = [...currentIgnored].filter((entry) => !next.has(entry));
      const newlyIgnored = [...next].filter((entry) => !currentIgnored.has(entry));
      currentIgnored = next;
      matcher = createWatchIgnoreMatcher(repoRoot, next);
      knownVisible = new Set();
      ignoreGeneration += 1;
      if (newlyIgnored.length > 0) {
        worktreeWatcher.unwatch(newlyIgnored.map((entry) => path.join(repoRoot, entry)));
      }
      if (noLongerIgnored.length > 0) {
        worktreeWatcher.add(noLongerIgnored.map((entry) => path.join(repoRoot, entry)));
      }
    } catch (error) {
      reportError(gitFailure('could not list ignored files', error));
    } finally {
      rescanRunning = false;
      if (rescanAgain && !closed) {
        rescanAgain = false;
        void rescanIgnored();
      }
    }
  };

  const flushIgnoreChecks = async () => {
    ignoreCheckTimer = null;
    const batch = [...ignoreCheckQueue];
    ignoreCheckQueue = new Set();
    if (batch.length === 0 || closed) return;

    const generation = ignoreGeneration;
    let ignoredInBatch: Set<string>;
    try {
      ignoredInBatch = await checkIgnored(repoRoot, batch);
    } catch (error) {
      // Without an answer, refresh rather than risk missing a real change.
      reportError(gitFailure('could not check ignored files', error));
      ignoredInBatch = new Set();
    }
    if (closed) return;

    if (generation === ignoreGeneration && ignoredInBatch.size > 0) {
      matcher.add(ignoredInBatch);
      for (const entry of ignoredInBatch) currentIgnored.add(entry);
      worktreeWatcher.unwatch([...ignoredInBatch].map((entry) => path.join(repoRoot, entry)));
    }

    const visible = batch.filter((entry) => !ignoredInBatch.has(entry));
    if (generation === ignoreGeneration) {
      for (const entry of visible) knownVisible.add(entry);
    }
    if (visible.length > 0) notify();
  };

  attach(worktreeWatcher, (filePath) => {
    if (matcher.isIgnored(filePath)) return;
    const relative = toRelative(repoRoot, filePath);
    if (!relative) {
      notify();
      return;
    }

    if (path.posix.basename(relative) === '.gitignore') {
      void rescanIgnored();
    }

    if (knownVisible.has(relative)) {
      notify();
      return;
    }

    // A path not seen since startup may be a new ignored file (a log, a build
    // output directory); ask git before refreshing for it.
    ignoreCheckQueue.add(relative);
    ignoreCheckTimer ??= setTimeout(() => void flushIgnoreChecks(), IGNORE_CHECK_DELAY_MS);
  });

  const gitStatePaths = getGitStateWatchPaths(repoRoot);
  if (gitStatePaths.length > 0) {
    // Watch the Git directories themselves, filtered down to the state paths,
    // so state files and ref directories created later are still seen.
    const roots = [...new Set(gitStatePaths.map((statePath) => path.dirname(statePath)))]
      .filter((root, _index, all) => !all.some((other) => other !== root && isWithin(other, root)));
    const isGitStatePath = (filePath: string) => gitStatePaths.some((statePath) => (
      isWithin(statePath, filePath) || isWithin(filePath, statePath)
    ));

    attach(watch(roots, {
      ignored: (filePath) => !isGitStatePath(filePath),
      ignoreInitial: true,
      persistent: true,
      usePolling,
      interval: usePolling ? 300 : 100,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    }), (filePath) => {
      if (!isGitStatePath(filePath)) return;
      notify();
      void rescanIgnored();
    });
  }

  return {
    async close() {
      closed = true;
      notify.cancel();
      if (ignoreCheckTimer) clearTimeout(ignoreCheckTimer);
      await Promise.all(watchers.map((watcher) => watcher.close()));
    },
  };
}
