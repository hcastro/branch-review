import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  findExecutable,
  MISSING_CLIPBOARD_MESSAGE,
  resolveClipboardCommand,
  writeClipboard,
  type ClipboardCommand,
} from '../src/clipboard/write.js';
import {cleanupTempDirs, makeTempDir, writeExecutable} from './core-helpers.js';

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

describe('clipboard process lifecycle', () => {
  afterEach(cleanupTempDirs);

  function fakeTool(body: string): {command: ClipboardCommand; output: string} {
    const dir = makeTempDir('branch-review-clip-');
    const output = path.join(dir, 'clipboard.txt');
    const script = writeExecutable(path.join(dir, 'fake-copy'), `#!/bin/sh\n${body.replaceAll('$OUT', `'${output}'`)}\n`);
    return {command: {command: script, args: [], displayName: 'fake-copy'}, output};
  }

  it('resolves when the tool exits even if a forked child keeps stderr open', async () => {
    const {command, output} = fakeTool('cat > $OUT\n( sleep 8 ) &\nexit 0');
    const started = Date.now();

    await expect(writeClipboard('hello', {command, timeoutMs: 5000})).resolves.toEqual({ok: true, command});
    expect(Date.now() - started).toBeLessThan(3000);
    expect(fs.readFileSync(output, 'utf8')).toBe('hello');
  });

  it('reports a tool that never exits as timed out', async () => {
    const {command} = fakeTool('cat > /dev/null\nexec sleep 30');
    const started = Date.now();

    const result = await writeClipboard('hello', {command, timeoutMs: 300});
    expect(result).toMatchObject({ok: false, hint: expect.stringMatching(/clipboard tool timed out/)});
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('lets a slow tool that finishes inside the timeout succeed', async () => {
    const {command, output} = fakeTool('sleep 0.4\ncat > $OUT');

    await expect(writeClipboard('slow', {command, timeoutMs: 5000})).resolves.toEqual({ok: true, command});
    expect(fs.readFileSync(output, 'utf8')).toBe('slow');
  });

  it('still reports stderr from a failing tool', async () => {
    const {command} = fakeTool('cat > /dev/null\necho "no display" >&2\nexit 1');

    await expect(writeClipboard('x', {command, timeoutMs: 5000})).resolves.toEqual({
      ok: false,
      message: 'Clipboard write failed using fake-copy.',
      hint: 'no display',
    });
  });
});
