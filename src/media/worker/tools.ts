import fs from 'node:fs';
import path from 'node:path';

// Finding the programs media previews run: ffprobe and ffmpeg in the worker,
// xdg-open for the viewer. Only PATH is searched, only absolute entries
// outside the reviewed repo count, and no shell or `which` is ever asked, so
// a repo can never plant a program that we run.

/**
 * The first regular executable named `name` on PATH, skipping relative
 * entries and any inside the repo (after resolving symlinks), or null.
 */
export function findTool(name: string, env: NodeJS.ProcessEnv, repoRoot: string) {
  let root: string;
  try {
    root = fs.realpathSync(repoRoot);
  } catch {
    root = path.resolve(repoRoot);
  }
  for (const entry of (env.PATH ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    let dir: string;
    try {
      dir = fs.realpathSync(entry);
    } catch {
      continue;
    }
    if (dir === root || dir.startsWith(`${root}${path.sep}`)) continue;
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
