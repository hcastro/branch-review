import fs from 'node:fs';
import path from 'node:path';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {watch as chokidarWatch, type FSWatcher as ChokidarWatcher} from 'chokidar';
import {debounce} from './debounce.js';

// Ignored listings can be large (one line per ignored file in a tracked
// directory); a short buffer would fail and silently shrink what is watched.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const GIT_ARGS = ['-c', 'core.fsmonitor=false'];
const IGNORE_CHECK_DELAY_MS = 10;
// A steady stream of writes (a build, a log) still refreshes this often.
const MAX_NOTIFY_WAIT_MS = 1000;
// fs.watch has no ready event, and a recursive stream on macOS starts
// delivering a moment after it is created.
const NATIVE_READY_DELAY_MS = 100;
const TIMESTAMP_SLACK_MS = 2000;
// Used only when git cannot list ignored paths, so the watcher does not walk
// the usual dependency directory.
const FALLBACK_IGNORED = ['node_modules/'];

export type RepoWatcher = {
  close: () => Promise<void>;
};

/**
 * How the worktree is watched without polling. `recursive` is one
 * `fs.watch(root, {recursive: true})` stream (macOS and Windows);
 * `directories` is one non-recursive `fs.watch` per directory (the Linux
 * default), so handles grow with the directory count, never the file count.
 */
export type NativeWatchMode = 'recursive' | 'directories';

export type CreateRepoWatcherOptions = {
  repoRoot: string;
  debounceMs?: number;
  usePolling?: boolean;
  /** Defaults to `recursive` on macOS and Windows, else `directories`. */
  nativeMode?: NativeWatchMode;
  onChange: () => void;
  onError?: (error: Error) => void;
  onReady?: () => void;
};

export type WatchIgnoreMatcher = {
  isIgnored: (filePath: string) => boolean;
  add: (relativePaths: Iterable<string>) => void;
};

export function defaultNativeWatchMode(platform: NodeJS.Platform = process.platform): NativeWatchMode {
  return platform === 'darwin' || platform === 'win32' ? 'recursive' : 'directories';
}

// No call here passes a pathspec, and check-ignore rejects
// GIT_LITERAL_PATHSPECS, so only optional locks and prompts are turned off.
function gitEnv() {
  return {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'};
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

type CheckIgnoreRun = {code: number | null; records: string[]; stderr: string};

function runCheckIgnore(repoRoot: string, queries: string[]) {
  return new Promise<CheckIgnoreRun>((resolve, reject) => {
    // -v -n prints one record per answered path, matched or not, so a run
    // that git stops part way through still says which paths it answered.
    const child = spawn('git', [...GIT_ARGS, 'check-ignore', '-z', '-v', '-n', '--stdin'], {
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
    child.on('close', (code) => resolve({code, records: stdout.split('\0'), stderr}));
    child.stdin.on('error', () => undefined);
    child.stdin.end(queries.map((entry) => `${entry}\0`).join(''));
  });
}

/**
 * Resolves to the subset of `relativePaths` that git ignores. Each path goes
 * to git as `./<path>` so a name such as `:!x.ts` is not read as pathspec
 * magic. git refuses some paths outright (inside a submodule, beyond a
 * symlink) and stops there; such a path counts as not ignored and the rest
 * are asked again.
 */
export async function checkIgnored(repoRoot: string, relativePaths: string[]) {
  const ignored = new Set<string>();
  let remaining = relativePaths;

  while (remaining.length > 0) {
    const queries = remaining.map((entry) => `./${entry}`);
    const {code, records, stderr} = await runCheckIgnore(repoRoot, queries);
    // Each answer is <source> NUL <line> NUL <pattern> NUL <path> NUL; an
    // empty source means no pattern matched, and a `!` pattern re-includes.
    const answered = Math.min(Math.floor(records.length / 4), remaining.length);
    for (let index = 0; index < answered; index += 1) {
      const [source, , pattern] = records.slice(index * 4, index * 4 + 4);
      if (source && !pattern.startsWith('!')) ignored.add(remaining[index]);
    }

    // check-ignore exits 1 when nothing matched.
    if (code === 0 || code === 1) break;
    const refused = queries[answered];
    if (code === 128 && refused !== undefined && stderr.includes(refused)) {
      remaining = remaining.slice(answered + 1);
      continue;
    }

    throw Object.assign(new Error(`git check-ignore exited with code ${code}`), {stderr});
  }

  return ignored;
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
 * Finds paths inside another repository nested in the worktree: a submodule
 * (gitlink) or a separate clone. Its directory holds a `.git` file or
 * directory. Answers are cached per directory; `forget` drops one when its
 * `.git` entry appears or goes away.
 */
function createNestedRepoMatcher(repoRoot: string) {
  const cache = new Map<string, boolean>();
  const isRepoDir = (relativeDir: string) => {
    let answer = cache.get(relativeDir);
    if (answer === undefined) {
      answer = fs.existsSync(path.join(repoRoot, relativeDir, '.git'));
      cache.set(relativeDir, answer);
    }
    return answer;
  };

  return {
    /** True for a nested repo's directory and everything below it. */
    isInside(relative: string) {
      const segments = relative.split('/');
      let prefix = '';
      for (const segment of segments) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        if (isRepoDir(prefix)) return true;
      }
      return false;
    },
    forget(relativeDir: string) {
      cache.delete(relativeDir);
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

/** Watches a directory tree; which handles it uses depends on the mode. */
type TreeWatcher = {
  /** Starts watching directories that were skipped until now. */
  add: (directories: string[]) => void;
  /** Stops watching these paths and everything below them. */
  remove: (paths: string[]) => void;
  close: () => Promise<void>;
};

type TreeWatcherOptions = {
  root: string;
  /** Whether to watch a directory and walk into it. Never sees symlinks. */
  shouldWatchDir: (directory: string) => boolean;
  /** A path that changed; null when the platform did not say which. */
  onEvent: (filePath: string | null) => void;
  onError: (error: Error) => void;
  onReady: () => void;
};

function watchTreeRecursive({root, onEvent, onError, onReady}: TreeWatcherOptions): TreeWatcher {
  let watcher: fs.FSWatcher | null = null;
  try {
    // A recursive stream reports what happens on disk below the root; it does
    // not follow symlinks out of the tree.
    watcher = fs.watch(root, {recursive: true, persistent: true}, (_eventType, filename) => {
      onEvent(filename ? path.join(root, filename.toString()) : null);
    });
    watcher.on('error', onError);
  } catch (error) {
    onError(error as Error);
  }

  const readyTimer = setTimeout(onReady, NATIVE_READY_DELAY_MS);
  return {
    add: () => undefined,
    remove: () => undefined,
    async close() {
      clearTimeout(readyTimer);
      watcher?.close();
    },
  };
}

function watchTreeByDirectory({root, shouldWatchDir, onEvent, onError, onReady}: TreeWatcherOptions): TreeWatcher {
  // Directory path -> its watcher and inode, so a directory deleted and made
  // again under the same name is seen as new.
  const watched = new Map<string, {watcher: fs.FSWatcher; ino: number}>();
  let closed = false;

  const unwatchTree = (target: string) => {
    for (const [directory, entry] of watched) {
      if (!isWithin(target, directory)) continue;
      entry.watcher.close();
      watched.delete(directory);
    }
  };

  const handleEvent = (directory: string, filename: string | Buffer | null) => {
    if (closed) return;
    if (!filename) {
      onEvent(directory);
      return;
    }

    const filePath = path.join(directory, filename.toString());
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      // Gone: drop any watchers below it.
    }

    const existing = watched.get(filePath);
    if (!stat?.isDirectory()) {
      if (existing) unwatchTree(filePath);
    } else if (!existing || existing.ino !== stat.ino) {
      if (existing) unwatchTree(filePath);
      if (shouldWatchDir(filePath)) {
        void walk(filePath).then(() => onEvent(filePath));
        return;
      }
    }

    onEvent(filePath);
  };

  const watchDirectory = (directory: string, ino: number) => {
    if (closed || watched.has(directory)) return false;
    try {
      const watcher = fs.watch(directory, {persistent: true}, (_eventType, filename) => handleEvent(directory, filename));
      watcher.on('error', (error) => {
        unwatchTree(directory);
        // A directory removed under the watcher is not a watcher fault.
        if (fs.existsSync(directory)) onError(error);
      });
      watched.set(directory, {watcher, ino});
      return true;
    } catch (error) {
      if (fs.existsSync(directory)) onError(error as Error);
      return false;
    }
  };

  // The watch on a directory is set before its entries are read, so an entry
  // created during the walk is either listed or reported by the watch.
  const walk = async (start: string) => {
    const pending = [start];
    while (pending.length > 0 && !closed) {
      const directory = pending.pop()!;
      let ino: number;
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory()) continue;
        ino = stat.ino;
      } catch {
        continue;
      }
      if (!watchDirectory(directory, ino)) continue;

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, {withFileTypes: true});
      } catch {
        continue;
      }
      for (const entry of entries) {
        // Dirent types come from lstat, so a symlink to a directory is never
        // walked.
        if (!entry.isDirectory()) continue;
        const child = path.join(directory, entry.name);
        if (shouldWatchDir(child)) pending.push(child);
      }
    }
  };

  void walk(root).then(() => {
    if (!closed) onReady();
  });

  return {
    add(directories) {
      for (const directory of directories) {
        if (!watched.has(directory) && shouldWatchDir(directory)) void walk(directory);
      }
    },
    remove(paths) {
      for (const target of paths) unwatchTree(target);
    },
    async close() {
      closed = true;
      for (const {watcher} of watched.values()) watcher.close();
      watched.clear();
    },
  };
}

type PollingOptions = TreeWatcherOptions & {ignored: (filePath: string) => boolean; atomic: boolean};

// Polling uses stat timers, not file handles, so watching every file is safe.
function watchTreeByPolling({root, ignored, atomic, onEvent, onError, onReady}: PollingOptions): TreeWatcher {
  const watcher: ChokidarWatcher = chokidarWatch(root, {
    ignored,
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 300,
    followSymlinks: false,
    atomic,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });
  // The initial scan reports symlinks as added even with ignoreInitial.
  // Anything that changes before ready is the ready refresh's job.
  let ready = false;
  watcher.on('all', (_event, filePath) => {
    if (ready) onEvent(filePath);
  });
  watcher.on('error', (error) => onError(error instanceof Error ? error : new Error(String(error))));
  watcher.on('ready', () => {
    ready = true;
    onReady();
  });

  return {
    add: (directories) => void watcher.add(directories),
    remove: (paths) => void watcher.unwatch(paths),
    close: () => watcher.close(),
  };
}

type PathState = {mtimeMs: number; ctimeMs: number; size: number} | 'missing';

function readPathState(filePath: string): PathState {
  try {
    const stat = fs.lstatSync(filePath);
    return {mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size};
  } catch {
    return 'missing';
  }
}

function samePathState(left: PathState | undefined, right: PathState) {
  if (left === undefined) return false;
  if (left === 'missing' || right === 'missing') return left === right;
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.size === right.size;
}

/**
 * Drops events for a path whose own mtime, ctime and size (lstat, so a
 * symlink is judged by the link, never its target) have not moved since its
 * last event. Reads, which only touch atime, then never refresh; any write,
 * rename or re-pointed link moves ctime. A path first reported with a ctime
 * from before the watcher started has not changed since: the event came from
 * a read, or from a symlink's target, and only records the baseline.
 */
export function createEventDeduper(startedAtMs: number) {
  const states = new Map<string, PathState>();
  return (filePath: string) => {
    const next = readPathState(filePath);
    const previous = states.get(filePath);
    states.set(filePath, next);
    if (previous === undefined) return next === 'missing' || next.ctimeMs >= startedAtMs;
    return !samePathState(previous, next);
  };
}

export function createRepoWatcher({
  repoRoot,
  debounceMs = 200,
  usePolling = false,
  nativeMode = defaultNativeWatchMode(),
  onChange,
  onError,
  onReady,
}: CreateRepoWatcherOptions): RepoWatcher {
  // Changes made before this point are the ready refresh's job. Pushed back
  // because some file systems store times in whole seconds (two on FAT).
  const startedAtMs = Date.now() - TIMESTAMP_SLACK_MS;
  const notify = debounce(onChange, debounceMs, {maxWaitMs: MAX_NOTIFY_WAIT_MS});
  const reportError = (error: unknown) => onError?.(error instanceof Error ? error : new Error(String(error)));
  const trees: TreeWatcher[] = [];
  let closed = false;
  let pendingReady = 0;
  const handleReady = () => {
    pendingReady -= 1;
    if (pendingReady === 0 && !closed) {
      onReady?.();
    }
  };

  const createTree = (
    options: Omit<TreeWatcherOptions, 'onReady' | 'onError'> & {ignored: (filePath: string) => boolean; atomic: boolean},
  ) => {
    pendingReady += 1;
    const full: PollingOptions = {
      ...options,
      onEvent: (filePath) => {
        if (!closed) options.onEvent(filePath);
      },
      onError: reportError,
      onReady: handleReady,
    };
    const tree = usePolling
      ? watchTreeByPolling(full)
      : nativeMode === 'recursive' ? watchTreeRecursive(full) : watchTreeByDirectory(full);
    trees.push(tree);
    return tree;
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
  const nestedRepos = createNestedRepoMatcher(repoRoot);
  // Paths that appeared after startup and that git says it does not ignore.
  let knownVisible = new Set<string>();
  let ignoreCheckQueue = new Set<string>();
  let ignoreCheckTimer: NodeJS.Timeout | null = null;
  let ignoreGeneration = 0;

  // Skipped entirely: .git, what git ignores, and other repositories nested
  // in the worktree (submodules, clones), which their own git reports on.
  const isOutsideReview = (filePath: string) => {
    if (matcher.isIgnored(filePath)) return true;
    const relative = toRelative(repoRoot, filePath);
    return relative !== null && nestedRepos.isInside(relative);
  };

  let handleWorktreeEvent: (filePath: string | null) => void = () => undefined;
  const worktree = createTree({
    root: repoRoot,
    ignored: isOutsideReview,
    // Editor backup and swap names are left to git's ignore rules.
    atomic: false,
    shouldWatchDir: (directory) => !isOutsideReview(directory),
    onEvent: (filePath) => handleWorktreeEvent(filePath),
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
        worktree.remove(newlyIgnored.map((entry) => path.join(repoRoot, entry)));
      }
      if (noLongerIgnored.length > 0) {
        worktree.add(noLongerIgnored.map((entry) => path.join(repoRoot, entry)));
        // A write to one of these paths before the matcher changed was
        // dropped as ignored, so refresh once they count.
        notify();
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
      worktree.remove([...ignoredInBatch].map((entry) => path.join(repoRoot, entry)));
    }

    const visible = batch.filter((entry) => !ignoredInBatch.has(entry));
    if (generation === ignoreGeneration) {
      for (const entry of visible) knownVisible.add(entry);
    }
    if (visible.length > 0) notify();
  };

  // Checked after the cheap filters, so busy ignored paths cost no lstat.
  const worktreeIsNew = createEventDeduper(startedAtMs);
  handleWorktreeEvent = (filePath) => {
    const relative = filePath ? toRelative(repoRoot, filePath) : null;
    if (relative) {
      // A `.git` entry appearing or vanishing makes or unmakes a nested repo.
      const segments = relative.split('/');
      const gitSegment = segments.indexOf('.git');
      if (gitSegment > 0) nestedRepos.forget(segments.slice(0, gitSegment).join('/'));
    }
    if (filePath && (isOutsideReview(filePath) || !worktreeIsNew(filePath))) return;
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
  };

  const gitStatePaths = getGitStateWatchPaths(repoRoot);
  if (gitStatePaths.length > 0) {
    // Watch the Git directories themselves, filtered down to the state paths,
    // so state files and ref directories created later are still seen.
    const roots = [...new Set(gitStatePaths.map((statePath) => path.dirname(statePath)))]
      .filter((root, _index, all) => !all.some((other) => other !== root && isWithin(other, root)));
    const isGitStatePath = (filePath: string) => gitStatePaths.some((statePath) => (
      isWithin(statePath, filePath) || isWithin(filePath, statePath)
    ));

    const gitStateIsNew = createEventDeduper(startedAtMs);
    for (const root of roots) {
      createTree({
        root,
        ignored: (filePath) => !isGitStatePath(filePath),
        atomic: true,
        shouldWatchDir: isGitStatePath,
        onEvent: (filePath) => {
          if (filePath && (!isGitStatePath(filePath) || !gitStateIsNew(filePath))) return;
          notify();
          void rescanIgnored();
        },
      });
    }
  }

  return {
    async close() {
      closed = true;
      notify.cancel();
      if (ignoreCheckTimer) clearTimeout(ignoreCheckTimer);
      await Promise.all(trees.map((tree) => tree.close()));
    },
  };
}
