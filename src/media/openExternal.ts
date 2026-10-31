import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {escapeHiddenCharacters} from '../controlChars.js';
import {findTool} from './worker/tools.js';
import type {MediaBackend} from './backend.js';
import type {MediaRef, SideName} from './types.js';

// Opening a media file in the system viewer or player. A viewer gets a temp
// copy of the verified bytes, never the repo path, so it shows exactly what
// the pane shows and its autosave can never touch the repo. A work tree MP4
// or MOV on macOS is one exception: copying gigabytes would be slow, so
// QuickTime gets the file itself, by bundle id, so the path is only ever a
// document and a file swapped in for it can never pick the program. Quick
// Look only previews, so on macOS it is the other: it gets any work tree
// video as itself.
// Right before either starts, the path is checked to still be the regular
// file the worker checked. Every other open of a work tree video uses a
// verified copy. The command is a fixed absolute program with
// an argument array: no shell, and the only argument is an absolute path.

/** Starts a program and forgets it. Injected, so tests never open a real viewer. */
export type Opener = (command: string, args: string[]) => void;

export const defaultOpener: Opener = (command, args) => {
  const child = spawn(command, args, {detached: true, stdio: 'ignore'});
  child.on('error', () => undefined);
  child.unref();
};

export type OpenOutcome = {message: string; kind: 'info' | 'error'};

type OpenDeps = {
  backend: MediaBackend;
  cwd: string;
  tempDir: () => string;
  env: NodeJS.ProcessEnv;
  opener: Opener;
  platform?: NodeJS.Platform;
  // Copies exported this session, by side key, opened again without a new
  // export while each is still the read-only file the export wrote.
  copies?: Map<string, ExportedCopy>;
};

/** A copy handed to a viewer, and the file state it was written in. */
export type ExportedCopy = {path: string; size: number; mtimeMs: number; ino: number};

const VIDEO_FORMATS = new Set(['mp4', 'mov', 'webm']);
// QuickTime plays these, and opens a file only as a document.
const QUICKTIME_FORMATS = new Set(['mp4', 'mov']);
const QUICKTIME_BUNDLE = 'com.apple.QuickTimePlayerX';
const CHANGED = "can't open: the file changed on disk";

/** The side `o` opens: `which`, or the other side when the file has none. */
export function sideToOpen(ref: MediaRef, which: SideName): SideName {
  return ref[which] ? which : which === 'after' ? 'before' : 'after';
}

function viewerCommand(how: 'open' | 'quickLook', file: string, deps: OpenDeps, realVideo: boolean): [string, string[]] | null {
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') {
    if (how === 'quickLook') return ['/usr/bin/qlmanage', ['-p', file]];
    return realVideo ? ['/usr/bin/open', ['-b', QUICKTIME_BUNDLE, file]] : ['/usr/bin/open', [file]];
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    const xdgOpen = findTool('xdg-open', deps.env, deps.cwd);
    return xdgOpen ? [xdgOpen, [file]] : null;
  }
  return null;
}

// The work tree file at `file` is still the regular file with `dev` and
// `ino`, in a directory inside the repo.
function stillTheCheckedFile(file: string, checked: {dev: number; ino: number}, repoRoot: string) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== checked.dev || stat.ino !== checked.ino) return false;
    const root = fs.realpathSync(repoRoot);
    const parent = fs.realpathSync(path.dirname(file));
    return parent === root || parent.startsWith(`${root}${path.sep}`);
  } catch {
    return false;
  }
}

// A copy exported earlier in this session, still the read-only regular file
// in the session dir that the export wrote: same size, modification time and
// inode. A viewer that saved over it, in place or by replacing it, changed
// one of them, so the side is exported again rather than shown edited.
function reusableCopy(copy: ExportedCopy | undefined, dir: string) {
  if (!copy) return undefined;
  try {
    const stat = fs.lstatSync(copy.path);
    const inside = path.resolve(copy.path).startsWith(`${path.resolve(dir)}${path.sep}`);
    const same = stat.size === copy.size && stat.mtimeMs === copy.mtimeMs && stat.ino === copy.ino;
    return stat.isFile() && !stat.isSymbolicLink() && inside && same && (stat.mode & 0o777) === 0o400 ? copy.path : undefined;
  } catch {
    return undefined;
  }
}

// The state of a copy just exported, to check it against on reuse.
function copyState(file: string): ExportedCopy | undefined {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? {path: file, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino} : undefined;
  } catch {
    return undefined;
  }
}

/** Opens `which` side of a media file (the other side when it has none). */
export async function openMedia(deps: OpenDeps, ref: MediaRef, which: SideName, how: 'open' | 'quickLook'): Promise<OpenOutcome> {
  if (deps.env.SSH_CONNECTION) return {message: 'open is not available over SSH', kind: 'error'};
  const sideName = sideToOpen(ref, which);
  const side = ref[sideName];
  if (!side) return {message: "can't open: no file on either side", kind: 'error'};

  let dir: string;
  try {
    dir = deps.tempDir();
  } catch (error) {
    return {message: `can't open: ${escapeHiddenCharacters((error instanceof Error ? error.message : String(error)).split('\n')[0]!)}`, kind: 'error'};
  }
  const platform = deps.platform ?? process.platform;
  // A work tree video goes to the player as itself only where the player
  // takes it as a document; anywhere else it is copied out first.
  const worktreeVideo = side.source === 'worktree' && VIDEO_FORMATS.has(ref.format);
  const copy = worktreeVideo && !(platform === 'darwin' && (how === 'quickLook' || QUICKTIME_FORMATS.has(ref.format)));
  // An open that takes the work tree file as itself never takes a copy
  // kept from an earlier `o`, so `O` after `o` still previews the file.
  let file = worktreeVideo && !copy ? undefined : reusableCopy(deps.copies?.get(side.key), dir);
  let checked: {dev: number; ino: number} | undefined;
  if (!file) {
    let exported;
    try {
      exported = await deps.backend.exportCopy({cwd: deps.cwd, side, format: ref.format, dir, ...(copy ? {copy: true as const} : {})}, new AbortController().signal);
    } catch (error) {
      return {message: `can't open: ${error instanceof Error ? error.message : String(error)}`, kind: 'error'};
    }
    if (!exported.ok) return {message: `can't open: ${escapeHiddenCharacters(exported.reason)}`, kind: 'error'};
    // An absolute path never starts with `-`, so no viewer reads it as a flag.
    if (!path.isAbsolute(exported.path)) return {message: "can't open: the copy has no absolute path", kind: 'error'};
    file = exported.path;
    if (exported.dev !== undefined && exported.ino !== undefined) checked = {dev: exported.dev, ino: exported.ino};
    // The work tree file itself is never kept: it is checked again each time.
    else {
      const state = copyState(file);
      if (state) deps.copies?.set(side.key, state);
    }
  }

  const command = viewerCommand(how, file, deps, Boolean(checked));
  if (!command) return {message: 'no program to open media found', kind: 'error'};
  if (checked && !stillTheCheckedFile(file, checked, deps.cwd)) return {message: CHANGED, kind: 'error'};
  try {
    deps.opener(command[0], command[1]);
  } catch (error) {
    return {message: `can't open: ${escapeHiddenCharacters((error instanceof Error ? error.message : String(error)).split('\n')[0]!)}`, kind: 'error'};
  }
  const name = escapeHiddenCharacters(path.posix.basename(side.path));
  return {message: `${how === 'quickLook' ? 'quick look' : 'opened'} ${name} (${sideName})`, kind: 'info'};
}
