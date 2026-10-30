import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The session's one temp dir for media: the worker's own temp files, copies
// handed to a viewer. Made on first need, private to the user, removed at
// exit. Every file in it is named from object ids and an allow-listed
// extension, never from a repo file name.

export const MEDIA_TEMP_PREFIX = 'branch-review-media-';
const OWNER_FILE = 'owner.pid';

function tempParent(env: NodeJS.ProcessEnv) {
  return env.BRANCH_REVIEW_TMPDIR ?? os.tmpdir();
}

export function createMediaTempDir({env = process.env, pid = process.pid}: {env?: NodeJS.ProcessEnv; pid?: number} = {}) {
  let dir: string | null = null;

  return {
    /** The dir, made the first time it is asked for. */
    get() {
      if (dir) return dir;
      const made = fs.mkdtempSync(path.join(tempParent(env), MEDIA_TEMP_PREFIX));
      fs.chmodSync(made, 0o700);
      fs.writeFileSync(path.join(made, OWNER_FILE), `${pid}\n`, {flag: 'wx', mode: 0o600});
      fs.mkdirSync(path.join(made, 'worker'), {mode: 0o700});
      dir = made;
      return made;
    },
    remove() {
      if (!dir) return;
      try {
        fs.rmSync(dir, {recursive: true, force: true});
      } catch {
        // Best effort: the next startup's sweep takes what is left.
      }
      dir = null;
    },
  };
}

function processIsGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Removes media temp dirs left by sessions that died without cleaning up
 * (SIGKILL). Only dirs this user owns whose owner process no longer exists:
 * a reused pid only means a stale dir survives, never that a live session's
 * dir goes.
 */
export function sweepStaleMediaDirs({env = process.env, isGone = processIsGone}: {env?: NodeJS.ProcessEnv; isGone?: (pid: number) => boolean} = {}) {
  const parent = tempParent(env);
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!name.startsWith(MEDIA_TEMP_PREFIX)) continue;
    const dir = path.join(parent, name);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
      const pid = Number.parseInt(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), 10);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isGone(pid)) continue;
      fs.rmSync(dir, {recursive: true, force: true});
    } catch {
      // Unreadable or racing another sweep: leave it.
    }
  }
}
