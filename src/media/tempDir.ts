import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The session's one temp dir for media: the worker's own temp files, copies
// handed to a viewer. Made on first need, private to the user, removed at
// exit. Every file in it is named from object ids and an allow-listed
// extension, never from a repo file name.

export const MEDIA_TEMP_PREFIX = 'branch-review-media-';
const OWNER_FILE = 'owner.pid';
// Names the tmux server a session draws Kitty images in.
const KITTY_TMUX_FILE = 'kitty-tmux';

/**
 * Where session dirs go: BRANCH_REVIEW_TMPDIR, resolved to an absolute path,
 * else the OS temp dir. An empty value counts as unset, so a dir is never
 * made in the cwd, which is the reviewed repo.
 */
export function mediaTempParent(env: NodeJS.ProcessEnv) {
  return path.resolve(env.BRANCH_REVIEW_TMPDIR || os.tmpdir());
}

export function createMediaTempDir({env = process.env, pid = process.pid}: {env?: NodeJS.ProcessEnv; pid?: number} = {}) {
  let dir: string | null = null;

  return {
    /** The dir, made the first time it is asked for. */
    get() {
      if (dir) return dir;
      const made = fs.mkdtempSync(path.join(mediaTempParent(env), MEDIA_TEMP_PREFIX));
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
    // EPERM: alive, and someone else's.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// Every session dir under the parent this user owns, with the pid its
// owner.pid names (NaN when unreadable).
function* sessionDirs(env: NodeJS.ProcessEnv) {
  const parent = mediaTempParent(env);
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
      yield {dir, pid: Number.parseInt(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), 10)};
    } catch {
      // Unreadable or racing another sweep: leave it.
    }
  }
}

/**
 * Removes media temp dirs left by sessions that died without cleaning up
 * (SIGKILL). Only dirs this user owns whose owner process no longer exists:
 * a reused pid only means a stale dir survives, never that a live session's
 * dir goes.
 */
export function sweepStaleMediaDirs({env = process.env, isGone = processIsGone}: {env?: NodeJS.ProcessEnv; isGone?: (pid: number) => boolean} = {}) {
  for (const {dir, pid} of sessionDirs(env)) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isGone(pid)) continue;
    try {
      fs.rmSync(dir, {recursive: true, force: true});
    } catch {
      // Racing another sweep: leave it.
    }
  }
}

/** Runs `ps` with exactly `env`. Injected, so tests can stand in for the system clock and zone. */
export type PsRunner = (command: string, args: string[], env: NodeJS.ProcessEnv) => {status: number | null; stdout: string};

const runPs: PsRunner = (command, args, env) => spawnSync(command, args, {encoding: 'utf8', env, timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore']});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Epoch seconds of a C-locale `lstart` read in UTC, such as
// `Sat Oct 31 01:02:37 2026`, or null for anything else.
function utcSeconds(lstart: string) {
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(lstart);
  const month = match ? MONTHS.indexOf(match[1]!) : -1;
  if (!match || month < 0) return null;
  const [day, hour, minute, second, year] = match.slice(2).map(Number) as [number, number, number, number, number];
  return Date.UTC(year, month, day, hour, minute, second) / 1000;
}

/**
 * When process `pid` started, as the system reports it, or null when that
 * cannot be read. With the pid it names one process for its whole life: a
 * pid the system hands to another process later comes with another start
 * time. Linux: the start field of /proc/<pid>/stat. Elsewhere: `ps -o
 * lstart=`, run as a fixed absolute program in the C locale and UTC, as
 * epoch seconds. Neither depends on the time zone.
 */
export function processStartTime(pid: number, {run = runPs}: {run?: PsRunner} = {}): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name, in parentheses, may hold spaces: fields count from
    // the last `)`. The start time is field 22, the 20th after it.
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (start) return `proc:${start}`;
  } catch {
    // No /proc: macOS and the BSDs.
  }
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    if (!fs.existsSync(ps)) continue;
    // ps prints local time. In UTC, and kept as epoch seconds, one start
    // reads the same however the system zone changes between two reads.
    const result = run(ps, ['-o', 'lstart=', '-p', String(pid)], {LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC'});
    const seconds = result.status === 0 ? utcSeconds(result.stdout.trim()) : null;
    return seconds === null ? null : `ps:${seconds}`;
  }
  return null;
}

/** The tmux server a `TMUX` value names, as a short hash of its socket path. */
export function tmuxServerHash(tmux: string) {
  return createHash('sha256').update(tmux.split(',')[0] ?? '').digest('hex').slice(0, 16);
}

/**
 * Claims Kitty drawing in one tmux server for the session dir `dir`. Every
 * pane of a tmux server draws on one outer terminal, which has one table of
 * image ids, so two sessions drawing there would overwrite or delete each
 * other's images. The claim is a `kitty-tmux` file naming the server and its
 * owner's start time; false, with the file gone again, when another live
 * session's dir already claims the same server. A claim whose pid now
 * belongs to a process that started at another time was left by a session
 * that was killed (SIGKILL skips cleanup), and is ignored. A start time that
 * cannot be read counts as a match, so an unreadable claim still gives way.
 * Two sessions starting at once may both give way, never both draw.
 */
export function claimKittyTmux(dir: string, tmux: string, {env = process.env, pid = process.pid, isGone = processIsGone, startTime = processStartTime}: {env?: NodeJS.ProcessEnv; pid?: number; isGone?: (pid: number) => boolean; startTime?: (pid: number) => string | null} = {}) {
  const hash = tmuxServerHash(tmux);
  const marker = path.join(dir, KITTY_TMUX_FILE);
  const started = startTime(pid);
  fs.writeFileSync(marker, started ? `${hash}\n${started}\n` : `${hash}\n`, {flag: 'wx', mode: 0o600});
  const self = path.resolve(dir);
  for (const sibling of sessionDirs(env)) {
    if (path.resolve(sibling.dir) === self) continue;
    if (!Number.isInteger(sibling.pid) || sibling.pid <= 0 || sibling.pid === pid || isGone(sibling.pid)) continue;
    let claimed: string[];
    try {
      claimed = fs.readFileSync(path.join(sibling.dir, KITTY_TMUX_FILE), 'utf8').split('\n');
    } catch {
      continue;
    }
    if (claimed[0]?.trim() !== hash) continue;
    const recorded = claimed[1]?.trim();
    if (recorded) {
      const now = startTime(sibling.pid);
      if (now !== null && now !== recorded) continue;
    }
    fs.rmSync(marker, {force: true});
    return false;
  }
  return true;
}
