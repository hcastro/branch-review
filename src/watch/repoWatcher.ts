import fs from 'node:fs';
import path from 'node:path';
import {execFile, execFileSync, spawn, type ChildProcess} from 'node:child_process';
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
  const lines = text.split('\n').map((line) => line.trim());
  const reason = lines.find((line) => /^(fatal|error):/.test(line))
    ?? lines.find(Boolean)
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

// Adds a running git to `children` until it exits, so its owner can kill it.
function track(child: ChildProcess, children: Set<ChildProcess> | undefined) {
  if (!children) return;
  children.add(child);
  child.once('close', () => children.delete(child));
}

function listIgnoredPathsAsync(repoRoot: string, children?: Set<ChildProcess>) {
  return new Promise<string[]>((resolve, reject) => {
    const child = execFile('git', [...GIT_ARGS, ...IGNORED_LIST_ARGS], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv(),
      maxBuffer: GIT_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      // execFile's error does not carry stderr, where git's reason is.
      if (error) reject(Object.assign(error, {stderr}));
      else resolve(parseNulList(stdout));
    });
    track(child, children);
  });
}

type CheckIgnoreRun = {code: number | null; records: string[]; stderr: string};

function runCheckIgnore(repoRoot: string, queries: string[], children?: Set<ChildProcess>) {
  return new Promise<CheckIgnoreRun>((resolve, reject) => {
    // -v -n prints one record per answered path, matched or not, so a run
    // that git stops part way through still says which paths it answered.
    const child = spawn('git', [...GIT_ARGS, 'check-ignore', '-z', '-v', '-n', '--stdin'], {
      cwd: repoRoot,
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    track(child, children);
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
 * are asked again. Each git it runs is in `children` while it runs.
 */
export async function checkIgnored(repoRoot: string, relativePaths: string[], children?: Set<ChildProcess>) {
  const ignored = new Set<string>();
  let remaining = relativePaths;

  while (remaining.length > 0) {
    const queries = remaining.map((entry) => `./${entry}`);
    const {code, records, stderr} = await runCheckIgnore(repoRoot, queries, children);
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
    isRepoDir,
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
    /** Drops the cached answer for one directory and returns it. */
    forget(relativeDir: string) {
      const previous = cache.get(relativeDir);
      cache.delete(relativeDir);
      return previous;
    },
  };
}

// The Git dir of a checked-out submodule: its `.git` directory, or the one a
// `.git` file (`gitdir: <path>`) points to.
function submoduleGitDir(submoduleDir: string) {
  const dotGit = path.join(submoduleDir, '.git');
  try {
    if (fs.lstatSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    return pointer ? path.resolve(submoduleDir, pointer) : null;
  } catch {
    return null;
  }
}

// HEAD and logs/HEAD of each submodule's own Git dir, from `git ls-files
// -z --stage` output: a commit or checkout inside a submodule moves the
// gitlink the review shows without touching anything else the watcher sees.
function gitlinkStatePaths(repoRoot: string, staged: string) {
  const paths: string[] = [];
  for (const record of parseNulList(staged)) {
    // <mode> SP <object> SP <stage> TAB <path>; 160000 is a gitlink.
    if (!record.startsWith('160000 ')) continue;
    const tab = record.indexOf('\t');
    const gitDir = tab >= 0 ? submoduleGitDir(path.join(repoRoot, record.slice(tab + 1))) : null;
    if (gitDir) paths.push(path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD'));
  }
  return paths;
}

const STAGED_LIST_ARGS = ['ls-files', '-z', '--stage'];

function submoduleStatePaths(repoRoot: string) {
  try {
    return gitlinkStatePaths(repoRoot, execFileSync('git', [...GIT_ARGS, ...STAGED_LIST_ARGS], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv(),
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch {
    return [];
  }
}

function submoduleStatePathsAsync(repoRoot: string, children: Set<ChildProcess>) {
  return new Promise<string[]>((resolve, reject) => {
    const child = execFile('git', [...GIT_ARGS, ...STAGED_LIST_ARGS], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: gitEnv(),
      maxBuffer: GIT_MAX_BUFFER,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(gitlinkStatePaths(repoRoot, stdout));
    });
    track(child, children);
  });
}

type GitDirs = {gitDir: string; commonGitDir: string};

function resolveGitDirs(repoRoot: string): GitDirs | null {
  const gitDirRaw = tryRunGit(repoRoot, ['rev-parse', '--git-dir']);
  if (!gitDirRaw) return null;
  return {
    gitDir: path.resolve(repoRoot, gitDirRaw),
    commonGitDir: path.resolve(repoRoot, tryRunGit(repoRoot, ['rev-parse', '--git-common-dir']) ?? gitDirRaw),
  };
}

// Paths in the repo's own Git dirs whose changes can move the reviewed range
// or what git ignores.
function repoStatePaths({gitDir, commonGitDir}: GitDirs) {
  return [
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'FETCH_HEAD'),
    path.join(gitDir, 'index'),
    path.join(gitDir, 'logs', 'HEAD'),
    path.join(commonGitDir, 'packed-refs'),
    path.join(commonGitDir, 'refs'),
    path.join(commonGitDir, 'logs', 'refs'),
    path.join(commonGitDir, 'reftable'),
    path.join(commonGitDir, 'info', 'exclude'),
  ];
}

/**
 * Files and directories under the Git dir whose changes can move the reviewed
 * range or what git ignores, plus each submodule's HEAD and logs/HEAD.
 * Directories (`refs`, `logs/refs`, `reftable`) cover everything below them.
 * Paths that do not exist yet are included, so the watcher picks them up when
 * git creates them.
 */
export function getGitStateWatchPaths(repoRoot: string) {
  const gitDirs = resolveGitDirs(repoRoot);
  if (!gitDirs) return [];
  return [...new Set([...repoStatePaths(gitDirs), ...submoduleStatePaths(repoRoot)])].sort();
}

/**
 * Decides which paths at or below `<common git dir>/modules` the watcher
 * covers. Each submodule has its own Git dir there, named after the
 * submodule (so possibly a few directories deep); a nested submodule's sits
 * under its parent's own `modules`. Inside a Git dir only HEAD and logs/HEAD
 * can move a gitlink, so only they, `logs` and `modules` are covered there;
 * objects, refs and hooks get no handle or poll timer. Everything on the way
 * to a Git dir is covered.
 */
function createModulesMatcher(modulesDir: string) {
  // A directory holding HEAD is a Git dir. Only yes answers are kept: a
  // submodule's Git dir is created a moment before its HEAD.
  const gitDirs = new Set<string>();
  const isGitDir = (directory: string) => {
    if (gitDirs.has(directory)) return true;
    if (!fs.existsSync(path.join(directory, 'HEAD'))) return false;
    gitDirs.add(directory);
    return true;
  };

  return (target: string) => {
    const segments = path.relative(modulesDir, target).split(path.sep).filter(Boolean);
    let current = modulesDir;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const remaining = segments.length - index - 1;
      // `modules` itself is never a Git dir.
      if (index > 0 && isGitDir(current)) {
        if (segment === 'HEAD') return remaining === 0;
        if (segment === 'logs') return remaining === 0 || (remaining === 1 && segments[index + 1] === 'HEAD');
        if (segment !== 'modules') return false;
      }
      current = path.join(current, segment);
    }
    return true;
  };
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
  /**
   * Decides again how to watch a directory and what is below it, after it
   * became or stopped being a nested repo. Resolves once that is in place.
   */
  rewatch: (directory: string) => Promise<void>;
  close: () => Promise<void>;
};

type TreeWatcherOptions = {
  root: string;
  /** Whether to watch a directory and walk into it. Never sees symlinks. */
  shouldWatchDir: (directory: string) => boolean;
  /**
   * A directory watched for its own entries but never walked into: a nested
   * repo's directory, so its `.git` coming or going is seen. `fresh` asks
   * the disk again rather than a cached answer.
   */
  isBoundary: (directory: string, fresh?: boolean) => boolean;
  /**
   * Of directories that appeared after the watcher started, the ones git does
   * not ignore. The startup ignore listing knows nothing about them.
   */
  visibleNewDirs: (directories: string[]) => Promise<string[]>;
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
    rewatch: async () => undefined,
    async close() {
      clearTimeout(readyTimer);
      watcher?.close();
    },
  };
}

function watchTreeByDirectory({
  root,
  shouldWatchDir,
  isBoundary,
  visibleNewDirs,
  onEvent,
  onError,
  onReady,
}: TreeWatcherOptions): TreeWatcher {
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

  const wanted = (directory: string) => shouldWatchDir(directory) || isBoundary(directory);

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
      if (wanted(filePath)) {
        // Adding watches can lose events that arrive meanwhile (seen with
        // macOS FSEvents), so a walk that added any reports an unnamed change
        // and the refresh after it reads whatever those events were about.
        void walk(filePath, true).then((added) => onEvent(added > 0 ? null : filePath));
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

  // Walks one level at a time. The watch on a directory is set before its
  // entries are read, so an entry created during the walk is either listed or
  // reported by the watch. A tree that is new since startup is unknown to the
  // ignore listing, so each level is shown to git before it is watched: a new
  // ignored tree (a build output, a dependency install) opens no handles.
  // Resolves to the number of directories it started watching.
  const walk = async (start: string, isNew: boolean) => {
    let added = 0;
    let level = isNew ? await visibleNewDirs([start]) : [start];
    while (level.length > 0 && !closed) {
      const next: string[] = [];
      for (const directory of level) {
        if (closed) return added;
        // Ignore rules and nested repos may have changed since it was queued.
        if (!wanted(directory)) continue;
        let ino: number;
        try {
          const stat = fs.lstatSync(directory);
          if (!stat.isDirectory()) continue;
          ino = stat.ino;
        } catch {
          continue;
        }
        if (!watchDirectory(directory, ino)) continue;
        added += 1;
        // Asked again once the watch is set: a `.git` made or removed before
        // that is reported by no event.
        if (isBoundary(directory, true)) continue;

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
          if (wanted(child)) next.push(child);
        }
      }
      level = isNew && next.length > 0 ? await visibleNewDirs(next) : next;
    }
    return added;
  };

  void walk(root, false).then(() => {
    if (!closed) onReady();
  });

  return {
    add(directories) {
      for (const directory of directories) {
        if (!watched.has(directory) && wanted(directory)) void walk(directory, false);
      }
    },
    remove(paths) {
      for (const target of paths) unwatchTree(target);
    },
    async rewatch(directory) {
      unwatchTree(directory);
      // What was inside a nested repo was never in the ignore listing.
      await walk(directory, true);
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
    async rewatch(directory) {
      // chokidar decided what to skip below the directory when it first read
      // it, so drop and re-add it to have it decide again.
      watcher.unwatch(directory);
      watcher.add(directory);
    },
    close: () => watcher.close(),
  };
}

type PathState = {mtimeMs: number; ctimeMs: number; size: number; ino: number} | 'missing';

function readPathState(filePath: string): PathState {
  try {
    const stat = fs.lstatSync(filePath);
    return {mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino};
  } catch {
    return 'missing';
  }
}

function samePathState(left: PathState | undefined, right: PathState) {
  if (left === undefined) return false;
  if (left === 'missing' || right === 'missing') return left === right;
  return left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.size === right.size
    && left.ino === right.ino;
}

// A ctime in whole seconds may come from a file system that stores no finer
// time (HFS+, ext3, many network mounts). There a second write of the same
// size in the same second leaves lstat unchanged, so an unchanged state proves
// nothing until that second is well past. A ctime in the future (clock skew,
// a network mount) never counts, or every repeated event would pass.
function mayHideAWrite(state: Exclude<PathState, 'missing'>, nowMs: number) {
  const ageMs = nowMs - state.ctimeMs;
  return state.ctimeMs % 1000 === 0 && ageMs >= 0 && ageMs < TIMESTAMP_SLACK_MS;
}

/**
 * Drops events for a path whose own mtime, ctime, size and inode (lstat, so a
 * symlink is judged by the link, never its target) have not moved since its
 * last event. Reads, which only touch atime, then never refresh; any write,
 * rename or re-pointed link moves ctime. On a file system with whole-second
 * times an unchanged state counts as a change while its ctime is recent. A
 * path first reported with a ctime from before the watcher started has not
 * changed since: the event came from a read, or from a symlink's target, and
 * only records the baseline.
 */
export function createEventDeduper(startedAtMs: number, now: () => number = Date.now) {
  const states = new Map<string, PathState>();
  return (filePath: string) => {
    const next = readPathState(filePath);
    const previous = states.get(filePath);
    states.set(filePath, next);
    if (previous === undefined) return next === 'missing' || next.ctimeMs >= startedAtMs;
    if (!samePathState(previous, next)) return true;
    return next !== 'missing' && mayHideAWrite(next, now());
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
  // The ignore listings and checks running now; close() stops them.
  const gitChildren = new Set<ChildProcess>();
  let closed = false;
  let pendingReady = 0;
  const handleReady = () => {
    pendingReady -= 1;
    if (pendingReady === 0 && !closed) {
      onReady?.();
    }
  };

  // A tree created after startup (`late`) does not hold back onReady; once
  // it is ready it refreshes, for whatever changed before it was listening.
  const createTree = (
    options: Omit<TreeWatcherOptions, 'onReady' | 'onError' | 'isBoundary' | 'visibleNewDirs'>
      & Partial<Pick<TreeWatcherOptions, 'isBoundary' | 'visibleNewDirs'>>
      & {ignored: (filePath: string) => boolean; atomic: boolean},
    late = false,
  ) => {
    if (!late) pendingReady += 1;
    const full: PollingOptions = {
      isBoundary: () => false,
      visibleNewDirs: async (directories) => directories,
      ...options,
      onEvent: (filePath) => {
        if (!closed) options.onEvent(filePath);
      },
      onError: reportError,
      onReady: late ? () => {
        if (!closed) notify();
      } : handleReady,
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
  // New directories waiting to be shown to git, each list with the walk
  // waiting on it. One check-ignore answers a whole batch and one batch runs
  // at a time, so a checkout that adds many directories starts few gits.
  let dirCheckQueue: Array<{directories: string[]; resolve: (visible: string[]) => void}> = [];
  let dirCheckTimer: NodeJS.Timeout | null = null;
  let dirCheckRunning = false;
  let ignoreGeneration = 0;

  // Skipped entirely: .git, what git ignores, and other repositories nested
  // in the worktree (submodules, clones), which their own git reports on.
  const isOutsideReview = (filePath: string) => {
    if (matcher.isIgnored(filePath)) return true;
    const relative = toRelative(repoRoot, filePath);
    return relative !== null && nestedRepos.isInside(relative);
  };

  // Whether a directory itself is in review or is the top of a nested repo
  // that is: not ignored, and not inside another nested repo.
  const isReviewedOrNestedTop = (relativeDir: string) => {
    if (matcher.isIgnored(path.join(repoRoot, relativeDir))) return false;
    const parent = path.posix.dirname(relativeDir);
    return parent === '.' || !nestedRepos.isInside(parent);
  };

  // The top directory of a nested repo, watched only for its `.git` entry.
  const isNestedRepoTop = (filePath: string, fresh = false) => {
    const relative = toRelative(repoRoot, filePath);
    if (relative === null) return false;
    if (fresh) nestedRepos.forget(relative);
    return isReviewedOrNestedTop(relative) && nestedRepos.isRepoDir(relative);
  };

  // The `.git` entry of a directory in review, which makes it a nested repo.
  const isNestedGitEntry = (filePath: string) => {
    const relative = toRelative(repoRoot, filePath);
    if (relative === null || path.posix.basename(relative) !== '.git') return false;
    const directory = path.posix.dirname(relative);
    return directory !== '.' && isReviewedOrNestedTop(directory);
  };

  let handleWorktreeEvent: (filePath: string | null) => void = () => undefined;
  let visibleNewDirs: (directories: string[]) => Promise<string[]> = async (directories) => directories;
  const worktree = createTree({
    root: repoRoot,
    ignored: (filePath) => isOutsideReview(filePath) && !isNestedRepoTop(filePath) && !isNestedGitEntry(filePath),
    // Editor backup and swap names are left to git's ignore rules.
    atomic: false,
    shouldWatchDir: (directory) => !isOutsideReview(directory),
    isBoundary: isNestedRepoTop,
    visibleNewDirs: (directories) => visibleNewDirs(directories),
    onEvent: (filePath) => handleWorktreeEvent(filePath),
  });

  // Re-reads which gitlinks the index holds; set up with the Git state trees.
  let rescanSubmodules: () => Promise<void> = async () => undefined;

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
      const nextList = await listIgnoredPathsAsync(repoRoot, gitChildren);
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
      // close() kills a running listing; that is no watcher fault.
      if (!closed) reportError(gitFailure('could not list ignored files', error));
    } finally {
      rescanRunning = false;
      if (rescanAgain && !closed) {
        rescanAgain = false;
        void rescanIgnored();
      }
    }
  };

  // Asks git which of these new paths it ignores and remembers the answers,
  // unless the rules were re-listed meanwhile. Without an answer every path
  // counts as visible, so a real change is never missed.
  const askGitWhichIgnored = async (relativePaths: string[]) => {
    const generation = ignoreGeneration;
    let ignored: Set<string>;
    try {
      ignored = await checkIgnored(repoRoot, relativePaths, gitChildren);
    } catch (error) {
      if (!closed) reportError(gitFailure('could not check ignored files', error));
      ignored = new Set();
    }
    if (closed || generation !== ignoreGeneration) return ignored;

    if (ignored.size > 0) {
      matcher.add(ignored);
      for (const entry of ignored) currentIgnored.add(entry);
      worktree.remove([...ignored].map((entry) => path.join(repoRoot, entry)));
    }
    for (const entry of relativePaths) {
      if (!ignored.has(entry)) knownVisible.add(entry);
    }
    return ignored;
  };

  const unknownDirs = (directories: string[]) => directories
    .map((directory) => toRelative(repoRoot, directory))
    .filter((relative): relative is string => relative !== null && !knownVisible.has(relative));

  const scheduleDirChecks = () => {
    if (dirCheckTimer || dirCheckRunning || dirCheckQueue.length === 0 || closed) return;
    dirCheckTimer = setTimeout(() => void flushDirChecks(), IGNORE_CHECK_DELAY_MS);
  };

  const flushDirChecks = async () => {
    dirCheckTimer = null;
    const batch = dirCheckQueue;
    dirCheckQueue = [];
    const unknown = [...new Set(batch.flatMap(({directories}) => unknownDirs(directories)))];
    dirCheckRunning = true;
    // askGitWhichIgnored never rejects.
    const ignored = unknown.length > 0 ? await askGitWhichIgnored(unknown) : new Set<string>();
    dirCheckRunning = false;
    for (const {directories, resolve} of batch) {
      resolve(directories.filter((directory) => !ignored.has(toRelative(repoRoot, directory) ?? '')));
    }
    scheduleDirChecks();
  };

  visibleNewDirs = async (directories) => {
    if (closed || unknownDirs(directories).length === 0) return directories;
    return new Promise((resolve) => {
      dirCheckQueue.push({directories, resolve});
      scheduleDirChecks();
    });
  };

  const flushIgnoreChecks = async () => {
    ignoreCheckTimer = null;
    const batch = [...ignoreCheckQueue];
    ignoreCheckQueue = new Set();
    if (batch.length === 0 || closed) return;

    const ignoredInBatch = await askGitWhichIgnored(batch);
    if (closed) return;
    if (batch.some((entry) => !ignoredInBatch.has(entry))) notify();
  };

  // A `.git` entry appearing or vanishing makes or unmakes a nested repo. Its
  // files leave or join the review, so refresh, re-list what git ignores
  // there, and watch the directory the new way.
  const handleNestedGitChange = (relativeDir: string) => {
    const before = nestedRepos.forget(relativeDir);
    if (!isReviewedOrNestedTop(relativeDir)) return;
    if (nestedRepos.isRepoDir(relativeDir) === before) return;
    void worktree.rewatch(path.join(repoRoot, relativeDir)).then(() => {
      if (!closed) notify();
    });
    void rescanIgnored();
    notify();
  };

  // Checked after the cheap filters, so busy ignored paths cost no lstat.
  const worktreeIsNew = createEventDeduper(startedAtMs);
  handleWorktreeEvent = (filePath) => {
    const relative = filePath ? toRelative(repoRoot, filePath) : null;
    if (relative) {
      // Events below a nested `.git` can stand for the entry itself: a stream
      // may fold a removed directory into events for what was inside it.
      const segments = relative.split('/');
      const gitSegment = segments.indexOf('.git');
      if (gitSegment > 0) handleNestedGitChange(segments.slice(0, gitSegment).join('/'));
    }
    if (filePath && (isOutsideReview(filePath) || !worktreeIsNew(filePath))) return;
    if (!relative) {
      notify();
      // Whatever changed may have staged a new gitlink (a clone `git add`ed),
      // and its index event may be one of those lost while watches were added.
      void rescanSubmodules();
      return;
    }

    if (path.posix.basename(relative) === '.gitignore') {
      void rescanIgnored();
    }
    if (relative === '.gitmodules') void rescanSubmodules();

    if (knownVisible.has(relative)) {
      notify();
      return;
    }

    // A path not seen since startup may be a new ignored file (a log, a build
    // output directory); ask git before refreshing for it.
    ignoreCheckQueue.add(relative);
    ignoreCheckTimer ??= setTimeout(() => void flushIgnoreChecks(), IGNORE_CHECK_DELAY_MS);
  };

  // Git state lives outside the worktree tree: the repo's own Git dirs, each
  // submodule's Git dir under `<common git dir>/modules`, and the Git dir of
  // any other gitlink (a clone staged with `git add`), wherever it is.
  const gitDirs = resolveGitDirs(repoRoot);
  if (gitDirs) {
    const fixedStatePaths = repoStatePaths(gitDirs);
    const indexPath = path.join(gitDirs.gitDir, 'index');
    const modulesDir = path.join(gitDirs.commonGitDir, 'modules');
    const isCoveredInModules = createModulesMatcher(modulesDir);
    let submodulePaths = submoduleStatePaths(repoRoot);
    // Any path on the way to a state path, or below one.
    const isGitStatePath = (filePath: string) => {
      if (isWithin(modulesDir, filePath)) return isCoveredInModules(filePath);
      return [...fixedStatePaths, ...submodulePaths].some((statePath) => (
        isWithin(statePath, filePath) || isWithin(filePath, statePath)
      ));
    };

    const gitStateIsNew = createEventDeduper(startedAtMs);
    // Watch the Git directories themselves, filtered down to the state paths,
    // so state files and ref directories created later are still seen.
    const stateTrees = new Map<string, TreeWatcher>();
    const syncStateTrees = (late: boolean) => {
      const statePaths = [...fixedStatePaths, ...submodulePaths];
      const roots = [...new Set(statePaths.map((statePath) => path.dirname(statePath)))]
        .filter((root, _index, all) => !all.some((other) => other !== root && isWithin(other, root)));
      for (const [root, tree] of stateTrees) {
        if (roots.includes(root)) continue;
        stateTrees.delete(root);
        trees.splice(trees.indexOf(tree), 1);
        void tree.close();
      }
      for (const root of roots) {
        if (stateTrees.has(root)) continue;
        stateTrees.set(root, createTree({
          root,
          ignored: (filePath) => !isGitStatePath(filePath),
          atomic: true,
          shouldWatchDir: isGitStatePath,
          onEvent: (filePath) => {
            if (filePath && (!isGitStatePath(filePath) || !gitStateIsNew(filePath))) return;
            notify();
            void rescanIgnored();
            // A gitlink added or removed changes which Git dirs to watch.
            if (!filePath || filePath === indexPath) void rescanSubmodules();
          },
        }, late));
      }
    };

    let submoduleRescanRunning = false;
    let submoduleRescanAgain = false;
    rescanSubmodules = async () => {
      if (closed) return;
      if (submoduleRescanRunning) {
        submoduleRescanAgain = true;
        return;
      }
      submoduleRescanRunning = true;
      try {
        const next = await submoduleStatePathsAsync(repoRoot, gitChildren);
        if (closed || next.join('\0') === submodulePaths.join('\0')) return;
        submodulePaths = next;
        syncStateTrees(true);
      } catch {
        // Keep watching the Git dirs found before, as at startup when the
        // listing fails.
      } finally {
        submoduleRescanRunning = false;
        if (submoduleRescanAgain && !closed) {
          submoduleRescanAgain = false;
          void rescanSubmodules();
        }
      }
    };

    syncStateTrees(false);
  }

  return {
    async close() {
      closed = true;
      notify.cancel();
      if (ignoreCheckTimer) clearTimeout(ignoreCheckTimer);
      if (dirCheckTimer) clearTimeout(dirCheckTimer);
      // Walks waiting on a check stop there.
      for (const {resolve} of dirCheckQueue.splice(0)) resolve([]);
      // Their answers would be dropped anyway; quitting must not wait for them.
      for (const child of gitChildren) child.kill('SIGKILL');
      gitChildren.clear();
      await Promise.all(trees.map((tree) => tree.close()));
    },
  };
}
