import fs from 'node:fs';
import path from 'node:path';

// Finding the programs media previews run: ffprobe and ffmpeg in the worker,
// xdg-open for the viewer. Only PATH is searched, only absolute entries
// outside the reviewed repo count, and no shell or `which` is ever asked, so
// a repo can never plant a program that we run.

// Whether `dir` is the directory `root` names, or inside it: the same device
// and inode as `dir` or one of its ancestors. Spelling does not matter, so a
// case-insensitive file system cannot pass a repo dir off as another. True on
// a stat error, so a dir that cannot be checked is never used.
function insideRoot(dir: string, root: {dev: number; ino: number}) {
  let current = dir;
  for (;;) {
    try {
      const stat = fs.statSync(current);
      if (stat.dev === root.dev && stat.ino === root.ino) return true;
    } catch {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * The entries of a search path such as PATH or LD_LIBRARY_PATH that are safe
 * to search: absolute, existing, and outside the repo, each with symlinks
 * resolved. Empty and relative entries, which name the cwd, and any entry in
 * the repo are dropped, so a repo can never plant a program or a library.
 */
export function searchDirs(value: string | undefined, repoRoot: string) {
  let root: string;
  let rootId: {dev: number; ino: number} | null = null;
  try {
    root = fs.realpathSync.native(repoRoot);
    const stat = fs.statSync(root);
    rootId = {dev: stat.dev, ino: stat.ino};
  } catch {
    root = path.resolve(repoRoot);
  }
  const dirs: string[] = [];
  for (const entry of (value ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    let dir: string;
    try {
      dir = fs.realpathSync.native(entry);
    } catch {
      continue;
    }
    if (dir === root || dir.startsWith(`${root}${path.sep}`)) continue;
    if (rootId && insideRoot(dir, rootId)) continue;
    dirs.push(dir);
  }
  return dirs;
}

/**
 * The first regular executable named `name` on PATH, skipping relative
 * entries and any inside the repo (after resolving symlinks), or null.
 */
export function findTool(name: string, env: NodeJS.ProcessEnv, repoRoot: string) {
  for (const dir of searchDirs(env.PATH, repoRoot)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

export type VideoTools = {ffprobe: string | null; ffmpeg: string | null};

/**
 * ffprobe and ffmpeg for a repo, looked up once and fixed from then on: a
 * tool installed or removed mid-session counts from the next session.
 */
export function createToolFinder(env: NodeJS.ProcessEnv) {
  const found = new Map<string, VideoTools>();
  return (repoRoot: string): VideoTools => {
    let tools = found.get(repoRoot);
    if (!tools) {
      tools = {ffprobe: findTool('ffprobe', env, repoRoot), ffmpeg: findTool('ffmpeg', env, repoRoot)};
      found.set(repoRoot, tools);
    }
    return tools;
  };
}
