import path from 'node:path';
import {spawn} from 'node:child_process';
import {escapeHiddenCharacters} from '../controlChars.js';
import {findTool} from './worker/tools.js';
import type {MediaBackend} from './backend.js';
import type {MediaRef, SideName} from './types.js';

// Opening a media file in the system viewer or player. A viewer gets a temp
// copy of the verified bytes, never the repo path, so it shows exactly what
// the pane shows and its autosave can never touch the repo. A video in the
// work tree is the one exception: players never write to it, and copying
// gigabytes would be slow, so the player gets the file itself after the
// worker's regular-file and container checks. The command is a fixed
// absolute program with an argument array: no shell, and the only argument
// is an absolute path.

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
};

function viewerCommand(how: 'open' | 'quickLook', file: string, deps: OpenDeps): [string, string[]] | null {
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') return how === 'quickLook' ? ['/usr/bin/qlmanage', ['-p', file]] : ['/usr/bin/open', [file]];
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    const xdgOpen = findTool('xdg-open', deps.env, deps.cwd);
    return xdgOpen ? [xdgOpen, [file]] : null;
  }
  return null;
}

/** Opens `which` side of a media file (the other side when it has none). */
export async function openMedia(deps: OpenDeps, ref: MediaRef, which: SideName, how: 'open' | 'quickLook'): Promise<OpenOutcome> {
  if (deps.env.SSH_CONNECTION) return {message: 'open is not available over SSH', kind: 'error'};
  const sideName: SideName = ref[which] ? which : which === 'after' ? 'before' : 'after';
  const side = ref[sideName];
  if (!side) return {message: "can't open: no file on either side", kind: 'error'};

  let dir: string;
  try {
    dir = deps.tempDir();
  } catch (error) {
    return {message: `can't open: ${escapeHiddenCharacters((error instanceof Error ? error.message : String(error)).split('\n')[0]!)}`, kind: 'error'};
  }
  let exported;
  try {
    exported = await deps.backend.exportCopy({cwd: deps.cwd, side, format: ref.format, dir}, new AbortController().signal);
  } catch (error) {
    return {message: `can't open: ${error instanceof Error ? error.message : String(error)}`, kind: 'error'};
  }
  if (!exported.ok) return {message: `can't open: ${escapeHiddenCharacters(exported.reason)}`, kind: 'error'};
  // An absolute path never starts with `-`, so no viewer reads it as a flag.
  if (!path.isAbsolute(exported.path)) return {message: "can't open: the copy has no absolute path", kind: 'error'};

  const command = viewerCommand(how, exported.path, deps);
  if (!command) return {message: 'no program to open media found', kind: 'error'};
  try {
    deps.opener(command[0], command[1]);
  } catch (error) {
    return {message: `can't open: ${escapeHiddenCharacters((error instanceof Error ? error.message : String(error)).split('\n')[0]!)}`, kind: 'error'};
  }
  const name = escapeHiddenCharacters(path.posix.basename(side.path));
  return {message: `${how === 'quickLook' ? 'quick look' : 'opened'} ${name} (${sideName})`, kind: 'info'};
}
