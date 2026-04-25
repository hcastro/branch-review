import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  findExecutable,
  MISSING_CLIPBOARD_MESSAGE,
  resolveClipboardCommand,
  writeClipboard,
  type ClipboardCommand,
} from '../src/clipboard/write.js';

function existsAt(paths: string[]) {
  const allowed = new Set(paths);
  return (filePath: string) => allowed.has(filePath);
}

describe('clipboard writer', () => {
  it('finds executables on the provided PATH', () => {
    const bin = path.join('/usr', 'local', 'bin', 'pbcopy');

    expect(findExecutable('pbcopy', {
      pathValue: '/bin:/usr/local/bin',
      platform: 'darwin',
      exists: existsAt([bin]),
    })).toBe(bin);
  });

  it('resolves platform-specific clipboard commands', () => {
    expect(resolveClipboardCommand({
      pathValue: '/usr/bin',
      platform: 'darwin',
      exists: existsAt([path.join('/usr', 'bin', 'pbcopy')]),
    })).toEqual({
      command: path.join('/usr', 'bin', 'pbcopy'),
      args: [],
      displayName: 'pbcopy',
    });

    expect(resolveClipboardCommand({
      pathValue: '/usr/bin',
      platform: 'linux',
      env: {WAYLAND_DISPLAY: 'wayland-0'},
      exists: existsAt([path.join('/usr', 'bin', 'wl-copy')]),
    })).toEqual({
      command: path.join('/usr', 'bin', 'wl-copy'),
      args: [],
      displayName: 'wl-copy',
    });

    expect(resolveClipboardCommand({
      pathValue: '/mnt/c/Windows/System32',
      platform: 'linux',
      env: {WSL_DISTRO_NAME: 'Ubuntu'},
      exists: existsAt([path.join('/mnt/c/Windows/System32', 'clip.exe')]),
    })).toEqual({
      command: path.join('/mnt/c/Windows/System32', 'clip.exe'),
      args: [],
      displayName: 'clip.exe',
    });

    expect(resolveClipboardCommand({
      pathValue: '/usr/bin',
      platform: 'linux',
      env: {},
      exists: existsAt([path.join('/usr', 'bin', 'xclip')]),
    })).toEqual({
      command: path.join('/usr', 'bin', 'xclip'),
      args: ['-selection', 'clipboard'],
      displayName: 'xclip',
    });
  });

  it('returns a friendly result when no clipboard command exists', async () => {
    await expect(writeClipboard('hello', {
      platform: 'linux',
      pathValue: '/missing',
      exists: () => false,
    })).resolves.toEqual({
      ok: false,
      message: MISSING_CLIPBOARD_MESSAGE,
    });
  });

  it('writes through an injected clipboard process', async () => {
    const command: ClipboardCommand = {
      command: '/usr/bin/pbcopy',
      args: [],
      displayName: 'pbcopy',
    };
    const writes: string[] = [];

    await expect(writeClipboard('hello', {
      command,
      spawnProcess: async (_command, text) => {
        writes.push(text);
        return {ok: true, command};
      },
    })).resolves.toEqual({ok: true, command});
    expect(writes).toEqual(['hello']);
  });
});
