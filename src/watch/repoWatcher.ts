import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {watch, type FSWatcher} from 'chokidar';
import {debounce} from './debounce.js';

const IGNORED_ROOTS = new Set([
  '.cache',
  '.git',
  '.next',
  '.pnpm-store',
  '.turbo',
  'coverage',
  'dist',
  'lib',
  'node_modules',
]);

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

function runGitFiles(repoRoot: string) {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .split('\0')
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function isIgnoredWatchPath(filePath: string, repoRoot = process.cwd()) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  const [root] = relative.split(path.sep);
  return root ? IGNORED_ROOTS.has(root) : false;
}

export function getRepoWatchPaths(repoRoot: string) {
  const directories = new Set<string>([repoRoot]);

  for (const filePath of runGitFiles(repoRoot)) {
    if (isIgnoredWatchPath(filePath, repoRoot)) continue;

    const dirname = path.dirname(filePath);
    directories.add(path.resolve(repoRoot, dirname === '.' ? '' : dirname));
  }

  return [...directories].sort();
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
  const watcher: FSWatcher = watch(getRepoWatchPaths(repoRoot), {
    ignored: (filePath) => isIgnoredWatchPath(filePath, repoRoot),
    ignoreInitial: true,
    persistent: true,
    usePolling,
    interval: usePolling ? 300 : 100,
    depth: 0,
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on('all', () => notify());
  watcher.on('error', (error) => onError?.(error instanceof Error ? error : new Error(String(error))));
  watcher.on('ready', () => onReady?.());

  return {
    async close() {
      notify.cancel();
      await watcher.close();
    },
  };
}
