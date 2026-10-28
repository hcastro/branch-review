import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export type ClipboardCommand = {
  command: string;
  args: string[];
  displayName: string;
};

export type ClipboardWriteResult =
  | {ok: true; command: ClipboardCommand}
  | {ok: false; message: string; hint?: string};

type FindExecutableOptions = {
  pathValue?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  exists?: (filePath: string) => boolean;
};

type ResolveClipboardOptions = FindExecutableOptions & {
  env?: NodeJS.ProcessEnv;
};

type WriteClipboardOptions = ResolveClipboardOptions & {
  command?: ClipboardCommand | null;
  spawnProcess?: (command: ClipboardCommand, text: string) => Promise<ClipboardWriteResult>;
  timeoutMs?: number;
};

const CLIPBOARD_TIMEOUT_MS = 5000;
// After a failing tool exits, how long to wait for the rest of its stderr.
const STDERR_GRACE_MS = 200;

export const MISSING_CLIPBOARD_MESSAGE = 'No clipboard tool found. Install xclip or wl-clipboard.';

let cachedCommand: ClipboardCommand | null | undefined;

function canAccessExecutable(filePath: string, platform: NodeJS.Platform) {
  try {
    fs.accessSync(filePath, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(pathExt: string | undefined) {
  return (pathExt || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.toLowerCase())
    .filter(Boolean);
}

function executableCandidates(name: string, platform: NodeJS.Platform, pathExt: string | undefined) {
  if (platform !== 'win32' || path.extname(name)) {
    return [name];
  }

  return windowsExtensions(pathExt).map((extension) => `${name}${extension}`);
}

function pathDelimiter(platform: NodeJS.Platform) {
  return platform === 'win32' ? ';' : ':';
}

export function findExecutable(name: string, options: FindExecutableOptions = {}) {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((filePath: string) => canAccessExecutable(filePath, platform));
  const pathValue = options.pathValue ?? process.env.PATH ?? '';

  if (name.includes('/') || name.includes('\\')) {
    return exists(name) ? name : null;
  }

  for (const directory of pathValue.split(pathDelimiter(platform)).filter(Boolean)) {
    for (const candidate of executableCandidates(name, platform, options.pathExt ?? process.env.PATHEXT)) {
      const fullPath = path.join(directory, candidate);
      if (exists(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

function isWsl(env: NodeJS.ProcessEnv) {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

function candidateCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardCommand[] {
  if (platform === 'darwin') {
    return [{command: 'pbcopy', args: [], displayName: 'pbcopy'}];
  }

  if (platform === 'win32') {
    return [{command: 'clip.exe', args: [], displayName: 'clip.exe'}];
  }

  if (platform === 'linux') {
    const linuxCandidates: ClipboardCommand[] = [];

    if (isWsl(env)) {
      linuxCandidates.push({command: 'clip.exe', args: [], displayName: 'clip.exe'});
    }

    if (env.WAYLAND_DISPLAY) {
      linuxCandidates.push({command: 'wl-copy', args: [], displayName: 'wl-copy'});
    }

    linuxCandidates.push(
      {command: 'xclip', args: ['-selection', 'clipboard'], displayName: 'xclip'},
      {command: 'xsel', args: ['-ib'], displayName: 'xsel'},
    );

    if (!env.WAYLAND_DISPLAY) {
      linuxCandidates.push({command: 'wl-copy', args: [], displayName: 'wl-copy'});
    }

    return linuxCandidates;
  }

  return [
    {command: 'pbcopy', args: [], displayName: 'pbcopy'},
    {command: 'wl-copy', args: [], displayName: 'wl-copy'},
    {command: 'xclip', args: ['-selection', 'clipboard'], displayName: 'xclip'},
    {command: 'xsel', args: ['-ib'], displayName: 'xsel'},
    {command: 'clip.exe', args: [], displayName: 'clip.exe'},
  ];
}

export function resolveClipboardCommand(options: ResolveClipboardOptions = {}): ClipboardCommand | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  for (const candidate of candidateCommands(platform, env)) {
    const resolved = findExecutable(candidate.command, options);
    if (resolved) {
      return {
        ...candidate,
        command: resolved,
      };
    }
  }

  return null;
}

export function getClipboardCommand(options: ResolveClipboardOptions = {}) {
  const hasCustomOptions = Boolean(options.env || options.pathValue || options.platform || options.pathExt || options.exists);
  if (hasCustomOptions) {
    return resolveClipboardCommand(options);
  }

  if (cachedCommand !== undefined) {
    return cachedCommand;
  }

  cachedCommand = resolveClipboardCommand(options);
  return cachedCommand;
}

export function resetClipboardCommandCache() {
  cachedCommand = undefined;
}

// Resolves on 'exit' rather than 'close': xclip and similar tools fork a child
// that keeps serving the selection and holds the inherited stderr pipe open,
// so 'close' can come seconds later or never.
function spawnClipboardProcess(
  command: ClipboardCommand,
  text: string,
  timeoutMs = CLIPBOARD_TIMEOUT_MS,
): Promise<ClipboardWriteResult> {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (result: ClipboardWriteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Drop our end of stderr so a forked child holding it can't keep this
      // process alive.
      child.stderr?.destroy();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        message: `Clipboard write failed using ${command.displayName}.`,
        hint: `clipboard tool timed out after ${Math.round(timeoutMs / 100) / 10}s`,
      });
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.stdin.on('error', () => {
      // The child may exit before consuming stdin. The exit/error handlers
      // below produce the user-facing result.
    });

    child.on('error', (error) => {
      finish({
        ok: false,
        message: `Clipboard write failed using ${command.displayName}.`,
        hint: error.message,
      });
    });

    child.on('exit', (code) => {
      if (code === 0) {
        finish({ok: true, command});
        return;
      }

      const report = () => {
        const hint = Buffer.concat(stderr).toString('utf8').trim();
        finish({
          ok: false,
          message: `Clipboard write failed using ${command.displayName}.`,
          hint: hint || `Process exited with code ${code ?? 'unknown'}.`,
        });
      };

      // stderr can still be in flight when 'exit' fires.
      if (!child.stderr || child.stderr.readableEnded) {
        report();
        return;
      }
      child.stderr.once('end', report);
      setTimeout(report, STDERR_GRACE_MS);
    });

    child.stdin.end(text);
  });
}

export async function writeClipboard(text: string, options: WriteClipboardOptions = {}): Promise<ClipboardWriteResult> {
  const command = options.command === undefined ? getClipboardCommand(options) : options.command;
  if (!command) {
    return {
      ok: false,
      message: MISSING_CLIPBOARD_MESSAGE,
    };
  }

  if (options.spawnProcess) {
    return options.spawnProcess(command, text);
  }

  return spawnClipboardProcess(command, text, options.timeoutMs);
}
