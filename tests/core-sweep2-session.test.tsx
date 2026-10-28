import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import React, {useEffect, useState} from 'react';
import {render, Text} from 'ink';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {runCli} from '../src/startup.js';
import {INK_RENDER_OPTIONS, TERMINAL_RESTORE_SEQUENCE, createTerminalSession, runInkApp} from '../src/terminalSession.js';
import {cleanupTempDirs, initRepo, makeTempDir, writeExecutable, writeFiles} from './core-helpers.js';

// Each test builds real repos or spawns the CLI.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

const ENTER = '\x1B[?1049h\x1B[H';
const cliEntry = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
const tsxLoader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

class FakeProcess extends EventEmitter {
  exitCode: number | undefined;
  exits: number[] = [];
  exit = (code?: number) => {
    this.exits.push(code ?? 0);
    this.emit('exit', code ?? 0);
  };
}

// A terminal-like stream for a real Ink render: everything Ink, the session
// and the console capture write lands in `writes`, in order.
function fakeTerminal() {
  const writes: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (text: string) => {
      writes.push(text);
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: false,
    setRawMode: () => {},
    setEncoding: () => {},
    ref: () => {},
    unref: () => {},
    read: () => null,
    resume: () => {},
    pause: () => {},
  });
  return {writes, stream, stdin};
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)),
  ]);
}

describe('SIGHUP', () => {
  it('restores the terminal after Ink unmounts and exits 129', () => {
    const writes: string[] = [];
    const proc = new FakeProcess();
    const session = createTerminalSession({
      stdout: {isTTY: true, write: (text: string) => writes.push(text)},
      stderr: {write: () => true},
      proc,
    });
    session.install();
    session.enter();
    session.setUnmount(() => writes.push('FINAL-FRAME'));

    proc.emit('SIGHUP');

    expect(writes).toEqual([ENTER, 'FINAL-FRAME', TERMINAL_RESTORE_SEQUENCE]);
    expect(proc.exits).toEqual([129]);
  });
});

function Thrower({message}: {message: string}): React.ReactElement {
  throw new Error(message);
}

function LateThrower() {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setBroken(true), 20);
    return () => clearTimeout(timer);
  }, []);
  if (broken) throw new Error('late failure');
  return <Text>fine</Text>;
}

describe('render errors with the real Ink render', () => {
  it('fails with one line and exit code 1 when the first render throws', async () => {
    const terminal = fakeTerminal();
    const errors: string[] = [];
    const proc = new FakeProcess();
    const session = createTerminalSession({stdout: terminal.stream, stderr: {write: (text: string) => errors.push(text)}, proc});
    session.install();

    await withTimeout(runInkApp(session, (guard) => render(guard(<Thrower message="first render failed"/>), {
      ...INK_RENDER_OPTIONS,
      stdout: terminal.stream as unknown as NodeJS.WriteStream,
      stderr: terminal.stream as unknown as NodeJS.WriteStream,
      stdin: terminal.stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
    })), 5000);

    expect(errors).toEqual(['branch-review: first render failed\n']);
    expect(proc.exitCode).toBe(1);
    expect(terminal.writes[0]).toBe(ENTER);
    expect(terminal.writes.at(-1)).toBe(TERMINAL_RESTORE_SEQUENCE);
  });

  it('fails with one line and exit code 1 when a later render throws', async () => {
    const terminal = fakeTerminal();
    const errors: string[] = [];
    const proc = new FakeProcess();
    const session = createTerminalSession({stdout: terminal.stream, stderr: {write: (text: string) => errors.push(text)}, proc});
    session.install();

    await withTimeout(runInkApp(session, (guard) => render(guard(<LateThrower/>), {
      ...INK_RENDER_OPTIONS,
      stdout: terminal.stream as unknown as NodeJS.WriteStream,
      stderr: terminal.stream as unknown as NodeJS.WriteStream,
      stdin: terminal.stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
    })), 5000);

    expect(errors).toEqual(['branch-review: late failure\n']);
    expect(proc.exitCode).toBe(1);
    expect(terminal.writes.at(-1)).toBe(TERMINAL_RESTORE_SEQUENCE);
  });

  it('runs a clean session to the end without an error', async () => {
    const terminal = fakeTerminal();
    const errors: string[] = [];
    const proc = new FakeProcess();
    const session = createTerminalSession({stdout: terminal.stream, stderr: {write: (text: string) => errors.push(text)}, proc});
    session.install();

    let instance: {unmount(): void} | undefined;
    const done = runInkApp(session, (guard) => {
      instance = render(guard(<Text>hello</Text>), {
        ...INK_RENDER_OPTIONS,
        stdout: terminal.stream as unknown as NodeJS.WriteStream,
        stdin: terminal.stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
      });
      return instance as never;
    });
    setTimeout(() => instance!.unmount(), 20);
    await withTimeout(done, 5000);

    expect(errors).toEqual([]);
    expect(proc.exitCode).toBeUndefined();
    expect(terminal.writes.join('')).toContain('hello');
  });
});

// Runs a session in a child so React's production build can be chosen. The
// child prints what reached the terminal before and after the restore.
function runConsoleProbe(nodeEnv: string) {
  const sessionModule = fileURLToPath(new URL('../src/terminalSession.ts', import.meta.url));
  const script = `
    import React from 'react';
    import {EventEmitter} from 'node:events';
    import {render, Text} from 'ink';
    import {INK_RENDER_OPTIONS, TERMINAL_RESTORE_SEQUENCE, createTerminalSession, runInkApp} from ${JSON.stringify(sessionModule)};
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = {error: null}; }
      static getDerivedStateFromError(error) { return {error}; }
      render() { return this.state.error ? React.createElement(Text, null, 'caught') : this.props.children; }
    }
    function Thrower() { throw new Error('boom \\x1B]0;PWNED\\x07 tail'); }
    const writes = [];
    const stream = Object.assign(new EventEmitter(), {isTTY: true, columns: 80, rows: 24, write: (text) => { writes.push(text); return true; }});
    const stdin = Object.assign(new EventEmitter(), {isTTY: false, setRawMode() {}, setEncoding() {}, ref() {}, unref() {}, read() { return null; }, resume() {}, pause() {}});
    const proc = Object.assign(new EventEmitter(), {exit() {}});
    const session = createTerminalSession({stdout: stream, stderr: stream, proc});
    let instance;
    const done = runInkApp(session, (guard) => {
      instance = render(guard(React.createElement(Boundary, null, React.createElement(Thrower))), {...INK_RENDER_OPTIONS, stdout: stream, stderr: stream, stdin, exitOnCtrlC: false});
      console.error('direct \\x1B[2J clear');
      console.warn('warned \\u202E here');
      return instance;
    });
    setTimeout(() => instance.unmount(), 50);
    await done;
    const all = writes.join('');
    const cut = all.indexOf(TERMINAL_RESTORE_SEQUENCE);
    process.stdout.write(JSON.stringify({before: all.slice(0, cut), after: all.slice(cut + TERMINAL_RESTORE_SEQUENCE.length)}));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {...process.env, NODE_ENV: nodeEnv},
  });
  expect(child.error).toBeUndefined();
  // Ink's cursor helper shows the cursor on stderr as the process exits.
  expect(child.stderr.replace('\x1B[?25h', '')).toBe('');
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as {before: string; after: string};
}

describe('console output during the Ink session', () => {
  for (const nodeEnv of ['development', 'production']) {
    it(`never reaches the TUI raw and is written escaped after the restore (${nodeEnv})`, () => {
      const {before, after} = runConsoleProbe(nodeEnv);

      expect(before).not.toContain('PWNED');
      expect(before).not.toContain('direct');
      expect(before).not.toContain('\x1B]0;');
      expect(before).not.toContain('\x1B[2J');
      expect(before).toContain('caught');

      expect(after).toContain('direct ␛[2J clear');
      expect(after).toContain('warned <U+202E> here');
      expect(after).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F\u202E]/);
      if (nodeEnv === 'production') {
        // React's production build reports the caught error object itself.
        expect(after).toContain('boom ␛]0;PWNED^G tail');
      }
    }, 30_000);
  }
});

describe('runCli', () => {
  it('installs the restore handlers before rendering and restores on SIGTERM after unmount', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    writeFiles(cwd, {'a.txt': 'one\ntwo\n'});

    const writes: string[] = [];
    const errors: string[] = [];
    const proc = new FakeProcess();
    const listenersAtRender: Record<string, number> = {};
    let renderOptions: unknown;

    const done = runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      stdout: {isTTY: true, columns: 120, write: (text: string) => writes.push(text)},
      stderr: {write: (text: string) => errors.push(text)},
      render: (_tree, options) => {
        renderOptions = options;
        for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit', 'uncaughtException']) {
          listenersAtRender[event] = proc.listenerCount(event);
        }
        writes.push('RENDER');
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => writes.push('UNMOUNT')};
      },
    });

    for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit', 'uncaughtException']) {
      expect(listenersAtRender[event], event).toBeGreaterThanOrEqual(1);
    }
    expect(renderOptions).toMatchObject({patchConsole: false});

    proc.emit('SIGTERM');
    expect(writes).toEqual([ENTER, 'RENDER', 'UNMOUNT', TERMINAL_RESTORE_SEQUENCE]);
    expect(proc.exits).toEqual([143]);
    expect(errors).toEqual([]);
    void done;
  });

  it('prints a startup error as one line and exits 1 without touching the terminal', async () => {
    const dir = makeTempDir('branch-review-norepo-');
    const writes: string[] = [];
    const errors: string[] = [];
    const proc = new FakeProcess();

    await runCli({
      argv: ['--no-watch'],
      cwd: dir,
      proc,
      stdout: {isTTY: true, columns: 120, write: (text: string) => writes.push(text)},
      stderr: {write: (text: string) => errors.push(text)},
      render: () => {
        throw new Error('must not render');
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^branch-review: not a git repository/);
    expect(proc.exits).toEqual([1]);
    expect(writes).toEqual([]);
  });
});

// A git that stalls on the numstat call inside the startup build, after the
// private index copy exists, and leaves a marker so the test knows when.
function slowGitRepo() {
  const cwd = initRepo({'a.txt': 'one\n'});
  writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
  const bin = makeTempDir('branch-review-slowgit-');
  const marker = path.join(bin, 'stalled');
  const realGit = spawnSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).stdout.trim();
  writeExecutable(path.join(bin, 'git'), [
    '#!/bin/sh',
    `case "$*" in *--numstat*) touch '${marker}'; sleep 4;; esac`,
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'));
  const tmp = makeTempDir('branch-review-clitmp-');
  return {cwd, marker, tmp, env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: tmp}};
}

async function waitFor(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function leakedIndexDirs(tmp: string) {
  return fs.readdirSync(tmp).filter((name) => name.startsWith('branch-review-index-'));
}

describe('signals during the startup build', () => {
  it('SIGTERM leaves no private index copy behind', async () => {
    const {cwd, marker, tmp, env} = slowGitRepo();
    const child = spawn(process.execPath, ['--import', tsxLoader, cliEntry, 'HEAD', 'main', '--no-watch'], {cwd, env, stdio: 'ignore'});
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve) => {
      child.once('exit', (code, signal) => resolve({code, signal}));
    });

    await waitFor(() => fs.existsSync(marker), 20_000);
    expect(leakedIndexDirs(tmp)).toHaveLength(1);
    child.kill('SIGTERM');

    const exit = await exited;
    expect(leakedIndexDirs(tmp)).toEqual([]);
    expect(exit).toEqual({code: 143, signal: null});
  });

  it('Ctrl-C stops the build promptly, exits 130 and leaves no private index copy', async () => {
    const {cwd, marker, tmp, env} = slowGitRepo();
    // Its own process group, like a foreground job, so the signal reaches git too.
    const child = spawn(process.execPath, ['--import', tsxLoader, cliEntry, 'HEAD', 'main', '--no-watch'], {cwd, env, stdio: 'ignore', detached: true});
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve) => {
      child.once('exit', (code, signal) => resolve({code, signal}));
    });

    await waitFor(() => fs.existsSync(marker), 20_000);
    const sentAt = Date.now();
    process.kill(-child.pid!, 'SIGINT');

    const exit = await exited;
    expect(leakedIndexDirs(tmp)).toEqual([]);
    expect(exit).toEqual({code: 130, signal: null});
    expect(Date.now() - sentAt).toBeLessThan(3000);
  });
});
