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
import {cleanupTempDirs, git, initRepo, makeTempDir, writeExecutable, writeFiles} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';

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

// A render error after mount, in a child so React's production build can be
// chosen. Prints every write the session sent to stderr.
function runLateErrorProbe(nodeEnv: string) {
  const sessionModule = fileURLToPath(new URL('../src/terminalSession.ts', import.meta.url));
  const script = `
    import React, {useEffect, useState} from 'react';
    import {EventEmitter} from 'node:events';
    import {render, Text} from 'ink';
    import {INK_RENDER_OPTIONS, createTerminalSession, runInkApp} from ${JSON.stringify(sessionModule)};
    function LateThrower() {
      const [broken, setBroken] = useState(false);
      useEffect(() => { const timer = setTimeout(() => setBroken(true), 20); return () => clearTimeout(timer); }, []);
      if (broken) throw new Error('late failure');
      return React.createElement(Text, null, 'fine');
    }
    const stream = Object.assign(new EventEmitter(), {isTTY: true, columns: 80, rows: 24, write() { return true; }});
    const stdin = Object.assign(new EventEmitter(), {isTTY: false, setRawMode() {}, setEncoding() {}, ref() {}, unref() {}, read() { return null; }, resume() {}, pause() {}});
    const errors = [];
    const proc = Object.assign(new EventEmitter(), {exit() {}});
    const session = createTerminalSession({stdout: stream, stderr: {write: (text) => { errors.push(text); return true; }}, proc});
    await runInkApp(session, (guard) => render(guard(React.createElement(LateThrower)), {...INK_RENDER_OPTIONS, stdout: stream, stderr: stream, stdin, exitOnCtrlC: false}));
    process.stdout.write(JSON.stringify({errors, exitCode: proc.exitCode}));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {...process.env, NODE_ENV: nodeEnv},
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as {errors: string[]; exitCode: number};
}

describe('a render error after mount', () => {
  for (const nodeEnv of ['development', 'production']) {
    it(`leaves exactly one stderr line, without React's own report of the error (${nodeEnv})`, () => {
      const {errors, exitCode} = runLateErrorProbe(nodeEnv);

      expect(errors).toEqual(['branch-review: late failure\n']);
      expect(exitCode).toBe(1);
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
    let markRendered!: () => void;
    // The startup build is asynchronous, so the render comes after runCli returns.
    const rendered = new Promise<void>((resolve) => {
      markRendered = resolve;
    });

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
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => writes.push('UNMOUNT')};
      },
    });
    await withTimeout(rendered, 20_000);

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

  it('escapes hidden characters in the ref names of the "No file changes" line', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    const branch = 'ev\u202Eil\u009Bx';
    git(cwd, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
    git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
    const writes: string[] = [];
    const proc = new FakeProcess();

    await runCli({
      argv: ['--no-watch'],
      cwd,
      proc,
      stdout: {isTTY: true, columns: 120, write: (text: string) => writes.push(text)},
      stderr: {write: () => true},
      render: () => {
        throw new Error('must not render');
      },
    });

    expect(writes).toEqual(['No file changes between origin/ev<U+202E>il<U+009B>x and HEAD.\n']);
    expect(proc.exits).toEqual([0]);
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

// A terminal stdin for runCli's graphics detection. It answers the query
// the way `reply` says once the query is written, and records raw mode and
// every `data` listener added, the only way this process could take keys.
function detectingTerminal(reply: (stdin: EventEmitter) => void, onQuery: (stdin: EventEmitter) => void = () => {}) {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const unshifted: string[] = [];
  const readers: string[] = [];
  let markQueried!: () => void;
  const queried = new Promise<void>((resolve) => {
    markQueried = resolve;
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      raw.push(mode);
      writes.push(`RAW:${mode}`);
    },
    resume: () => {},
    pause: () => {},
    unshift: (chunk: Buffer) => {
      unshifted.push(chunk.toString('latin1'));
    },
  });
  const stdout = {
    isTTY: true,
    columns: 120,
    rows: 40,
    write: (text: string) => {
      writes.push(text);
      if (text.includes('\x1B[c')) {
        onQuery(stdin);
        setImmediate(() => reply(stdin));
        markQueried();
      }
      return true;
    },
  };
  stdin.on('newListener', (event: string) => {
    if (event === 'data') readers.push(event);
  });
  return {writes, raw, unshifted, readers, queried, stdin, stdout, stderr: {write: (text: string) => writes.push(text)}};
}

// Answers `ms` after the query, the way a terminal over SSH does, and logs
// whether detection was still listening when the answer came. The answer's
// clock starts at the query write, as a real terminal's does, so a loop
// held up after the write still finds the answer due before the timeout.
function lateTerminal(ms: number) {
  const terminal = detectingTerminal(() => {}, (stdin) => {
    setTimeout(() => {
      terminal.writes.push(stdin.listenerCount('data') > 0 ? 'REPLY:read' : 'REPLY:LEFT-FOR-SHELL');
      stdin.emit('data', Buffer.from('\x1B_Gi=31;OK\x1B\\\x1B[?62;22c', 'latin1'));
    }, ms);
  });
  return terminal;
}

const SSH_ENV = {...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.3.2', NO_COLOR: undefined, FORCE_COLOR: undefined, TMUX: undefined, SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 50000', BRANCH_REVIEW_IMAGES: undefined};

const GRAPHICS_QUERY = '\x1B_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1B\\\x1B[>0q\x1B[16t\x1B[14t\x1B[c';
const GHOSTTY_ENV = {...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.3.2', NO_COLOR: undefined, FORCE_COLOR: undefined, TMUX: undefined, SSH_CONNECTION: undefined, BRANCH_REVIEW_IMAGES: undefined};

describe('runCli graphics detection', () => {
  it('asks the terminal before the UI mounts, with raw mode off again, and hands the answer down', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
    const terminal = detectingTerminal((stdin) => stdin.emit('data', Buffer.from('\x1B_Gi=31;OK\x1B\\\x1B[6;18;9t\x1B[?62c', 'latin1')));
    const proc = new FakeProcess();
    let tree: React.ReactElement | undefined;
    let markRendered!: () => void;
    const rendered = new Promise<void>((resolve) => {
      markRendered = resolve;
    });

    void runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: GHOSTTY_ENV,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: {write: () => true},
      render: (next) => {
        tree = next;
        terminal.writes.push('RENDER');
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => {}};
      },
    });
    await withTimeout(rendered, 20_000);

    expect(terminal.writes).toEqual([`RAW:true`, GRAPHICS_QUERY, 'RAW:false', ENTER, 'RENDER']);
    const controller = (tree!.props as {children: React.ReactElement<{graphics?: {protocol: string; cellPx: unknown}}>}).children;
    expect(controller.props.graphics).toMatchObject({protocol: 'kitty', cellPx: {w: 9, h: 18}});
    proc.emit('exit', 0);
  });

  it('exits 130 on Ctrl-C during detection without mounting the UI', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
    const terminal = detectingTerminal((stdin) => stdin.emit('data', Buffer.from('\x03', 'latin1')));
    const proc = new FakeProcess();
    let rendered = false;

    const done = runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: GHOSTTY_ENV,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: {write: () => true},
      render: () => {
        rendered = true;
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => {}};
      },
    });
    await withTimeout(done, 20_000);

    expect(proc.exits[0]).toBe(130);
    expect(rendered).toBe(false);
    expect(terminal.raw).toEqual([true, false]);
    expect(terminal.writes).toEqual(['RAW:true', GRAPHICS_QUERY, 'RAW:false']);
  });

  it('lets a slow terminal finish answering before the UI mounts', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
    // Well before the 1 s SSH timeout.
    const terminal = lateTerminal(250);
    const proc = new FakeProcess();
    let markRendered!: () => void;
    const rendered = new Promise<void>((resolve) => {
      markRendered = resolve;
    });

    void runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: SSH_ENV,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      render: () => {
        terminal.writes.push('RENDER');
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => {}};
      },
    });
    await withTimeout(rendered, 20_000);

    expect(terminal.writes).toEqual(['RAW:true', GRAPHICS_QUERY, 'REPLY:read', 'RAW:false', ENTER, 'RENDER']);
    proc.emit('exit', 0);
  });

  // Raw mode would move keys typed ahead out of the terminal into this
  // process, which exits without reading them.
  it('asks nothing before a startup error, so keys typed ahead stay with the shell', async () => {
    const cwd = makeTempDir('branch-review-not-a-repo-');
    const terminal = lateTerminal(50);
    const proc = new FakeProcess();

    const done = runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: SSH_ENV,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      render: () => {
        throw new Error('must not render');
      },
    });
    terminal.stdin.emit('data', Buffer.from('echo hi', 'latin1'));
    await withTimeout(done, 20_000);

    expect(proc.exits).toEqual([1]);
    expect(terminal.writes).toHaveLength(1);
    expect(terminal.writes[0]).toMatch(/^branch-review: not a git repository/);
    expect(terminal.raw).toEqual([]);
    expect(terminal.readers).toEqual([]);
  });

  it('asks nothing before "No file changes", so keys typed ahead stay with the shell', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    const terminal = lateTerminal(50);
    const proc = new FakeProcess();

    const done = runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: GHOSTTY_ENV,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      render: () => {
        throw new Error('must not render');
      },
    });
    terminal.stdin.emit('data', Buffer.from('echo hi', 'latin1'));
    await withTimeout(done, 20_000);

    expect(proc.exits).toEqual([0]);
    expect(terminal.writes).toEqual(['No file changes between main and HEAD.\n']);
    expect(terminal.raw).toEqual([]);
    expect(terminal.readers).toEqual([]);
  });

  it('turns raw mode off when the process exits mid-detection', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
    const terminal = detectingTerminal(() => {});
    const proc = new FakeProcess();

    const done = runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: GHOSTTY_ENV,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      render: () => ({waitUntilExit: () => Promise.resolve(), unmount: () => {}}),
    });
    await withTimeout(terminal.queried, 20_000);
    expect(terminal.raw).toEqual([true]);
    proc.emit('exit', 143);

    expect(terminal.raw).toEqual([true, false]);
    expect(terminal.stdin.listenerCount('data')).toBe(0);
    await withTimeout(done, 20_000);
  });

  it('after a timeout, keeps raw mode on into the UI and hands down a reply cut off mid-way', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
    // Starts DA1's reply and never finishes it.
    const terminal = detectingTerminal((stdin) => stdin.emit('data', Buffer.from('j\x1B[?62;22', 'latin1')));
    const proc = new FakeProcess();
    let tree: React.ReactElement | undefined;
    let listening = -1;
    let markRendered!: () => void;
    const rendered = new Promise<void>((resolve) => {
      markRendered = resolve;
    });

    void runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: GHOSTTY_ENV,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: terminal.stderr,
      render: (next) => {
        tree = next;
        listening = terminal.stdin.listenerCount('data');
        terminal.writes.push('RENDER');
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => {}};
      },
    });
    await withTimeout(rendered, 20_000);

    // No RAW:false before the UI: a reply arriving now must not be echoed.
    expect(terminal.writes).toEqual(['RAW:true', GRAPHICS_QUERY, ENTER, 'RENDER']);
    expect(listening).toBe(0);
    expect(terminal.unshifted).toEqual(['j']);
    const controller = (tree!.props as {children: React.ReactElement<{graphics?: {protocol: string; detectionTimedOut: boolean; replyHead?: string; keysBeforeReply?: string}}>}).children;
    expect(controller.props.graphics).toMatchObject({protocol: 'none', detectionTimedOut: true, replyHead: '\x1B[?62;22', keysBeforeReply: 'j'});

    proc.emit('exit', 0);
    expect(terminal.raw).toEqual([true, false]);
  });

  it('asks nothing with --no-images, and the UI gets no graphics', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
    const terminal = detectingTerminal(() => {});
    const proc = new FakeProcess();
    let tree: React.ReactElement | undefined;
    let markRendered!: () => void;
    const rendered = new Promise<void>((resolve) => {
      markRendered = resolve;
    });

    void runCli({
      argv: ['HEAD', 'main', '--no-watch', '--no-images'],
      cwd,
      proc,
      env: GHOSTTY_ENV,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: {write: () => true},
      render: (next) => {
        tree = next;
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => {}};
      },
    });
    await withTimeout(rendered, 20_000);

    expect(terminal.writes).toEqual([ENTER]);
    expect(terminal.raw).toEqual([]);
    const controller = (tree!.props as {children: React.ReactElement<{graphics?: {protocol: string}}>}).children;
    expect(controller.props.graphics?.protocol).toBe('none');
    proc.emit('exit', 0);
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

  it('SIGTERM during a stalled git exits 143 within about a second, kills git, and never mounts the UI', async () => {
    const {cwd, bin, pidLog, tmp, env} = stalledGitRepo();
    const child = spawn(process.execPath, ['--import', tsxLoader, cliEntry, 'HEAD', 'main', '--no-watch'], {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve) => {
      child.once('exit', (code, signal) => resolve({code, signal}));
    });

    const gitPid = await waitForPid(pidLog, 30_000);
    expect(leakedIndexDirs(tmp)).toHaveLength(1);
    const sentAt = Date.now();
    child.kill('SIGTERM');
    const exit = await exited;
    const elapsed = Date.now() - sentAt;

    expect(exit).toEqual({code: 143, signal: null});
    expect(elapsed).toBeLessThan(1500);
    expect(output).toBe('');
    expect(leakedIndexDirs(tmp)).toEqual([]);
    await waitFor(() => !isAlive(gitPid), 2000);
    void bin;
  });

  it('a signal during the startup build in-process exits, writes nothing to the terminal and never renders', async () => {
    const {cwd, pidLog, tmp, env} = stalledGitRepo();
    const writes: string[] = [];
    const proc = new FakeProcess();
    let rendered = false;

    const previous = {PATH: process.env.PATH, BRANCH_REVIEW_TMPDIR: process.env.BRANCH_REVIEW_TMPDIR};
    process.env.PATH = env.PATH;
    process.env.BRANCH_REVIEW_TMPDIR = tmp;
    let done: Promise<void>;
    let gitPid: number;
    try {
      done = runCli({
        argv: ['HEAD', 'main', '--no-watch'],
        cwd,
        proc,
        stdout: {isTTY: true, columns: 120, write: (text: string) => writes.push(text)},
        stderr: {write: (text: string) => writes.push(text)},
        render: () => {
          rendered = true;
          return {waitUntilExit: () => new Promise(() => {}), unmount: () => {}};
        },
      });
      gitPid = await waitForPid(pidLog, 30_000);
    } finally {
      process.env.PATH = previous.PATH;
      if (previous.BRANCH_REVIEW_TMPDIR === undefined) delete process.env.BRANCH_REVIEW_TMPDIR;
      else process.env.BRANCH_REVIEW_TMPDIR = previous.BRANCH_REVIEW_TMPDIR;
    }
    expect(leakedIndexDirs(tmp)).toHaveLength(1);

    proc.emit('SIGTERM');
    await withTimeout(done, 2000);

    expect(proc.exits).toEqual([143]);
    expect(rendered).toBe(false);
    expect(writes).toEqual([]);
    expect(leakedIndexDirs(tmp)).toEqual([]);
    await waitFor(() => !isAlive(gitPid), 2000);
  });
});

const recordedPids: number[] = [];

afterEach(() => {
  // Only processes the fake git recorded itself.
  for (const pid of recordedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A git whose numstat call inside the startup build never returns. It logs
// its pid (the sleep it becomes) so the test can check it was killed.
function stalledGitRepo() {
  const cwd = initRepo({'a.txt': 'one\n'});
  writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
  const bin = makeTempDir('branch-review-stalledgit-');
  const pidLog = path.join(bin, 'pids.log');
  const realGit = spawnSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).stdout.trim();
  writeExecutable(path.join(bin, 'git'), [
    '#!/bin/sh',
    `case "$*" in *--numstat*) echo $$ >> '${pidLog}'; exec sleep 60;; esac`,
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'));
  const tmp = makeTempDir('branch-review-clitmp-');
  return {cwd, bin, pidLog, tmp, env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TMPDIR: tmp}};
}

async function waitForPid(pidLog: string, ms: number) {
  await waitFor(() => fs.existsSync(pidLog) && fs.readFileSync(pidLog, 'utf8').trim() !== '', ms);
  const pid = Number(fs.readFileSync(pidLog, 'utf8').trim().split('\n')[0]);
  recordedPids.push(pid);
  return pid;
}

describe('runCli media previews', () => {
  const KITTY_REPLY = '\x1B_Gi=31;OK\x1B\\\x1B[6;20;10t\x1B[?62c';

  function controllerOf(tree: React.ReactElement | undefined) {
    return (tree!.props as {children: React.ReactElement<Record<string, unknown>>}).children;
  }

  it('starts media for a Kitty terminal, deletes its images in the restore write, and removes its temp dir', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    const png = pngFixture(4, 2);
    fs.writeFileSync(path.join(cwd, 'logo.png'), png);
    const tmpParent = makeTempDir('branch-review-media-parent-');
    const terminal = detectingTerminal((stdin) => stdin.emit('data', Buffer.from(KITTY_REPLY, 'latin1')));
    const proc = new FakeProcess();
    let tree: React.ReactElement | undefined;
    let markRendered!: () => void;
    const rendered = new Promise<void>((resolve) => {
      markRendered = resolve;
    });

    void runCli({
      argv: ['HEAD', '--no-watch'],
      cwd,
      proc,
      env: {...GHOSTTY_ENV, BRANCH_REVIEW_TMPDIR: tmpParent},
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: {write: () => true},
      render: (next) => {
        tree = next;
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => {}};
      },
    });
    await withTimeout(rendered, 20_000);

    const props = controllerOf(tree).props as {media?: import('../src/media/service.js').MediaService; initialReview: import('../src/review/model.js').ReviewModel; range: import('../src/git.js').DiffRange};
    const media = props.media!;
    expect(media.caps).toMatchObject({protocol: 'kitty', cellPx: {w: 10, h: 20}});

    // Draw the PNG the way the pane would, through the real worker.
    media.setReview(props.initialReview, {cwd, range: props.range});
    const file = props.initialReview.files.find((entry) => entry.path === 'logo.png')!;
    const ref = media.refFor(file)!;
    expect(ref).toMatchObject({kind: 'raster', after: {source: 'worktree'}});
    const {planMedia} = await import('../src/media/layout.js');
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 20_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitFor(() => media.sideState(ref, 'after').status !== 'pending');
    expect(media.sideState(ref, 'after')).toMatchObject({status: 'ready', info: {width: 4, height: 2}});
    const plan = planMedia(ref, {after: media.sideState(ref, 'after')}, media.viewState(ref.fileKey), {innerWidth: 80, viewportRows: 30, caps: media.caps});
    const box = plan.rows.flatMap((row) => row.type === 'box' ? row.boxes : [])[0]!;
    const keys = new Set([box.imageKey]);
    media.want([{fileKey: ref.fileKey, box}], keys);
    media.sweep(keys, keys);
    await waitFor(() => media.boxState(box).status !== 'loading');
    const state = media.boxState(box);
    expect(state.status).toBe('kitty');
    const id = (state as {id: number}).id;

    const enterAt = terminal.writes.indexOf(ENTER);
    const transmitAt = terminal.writes.findIndex((write) => write.includes(`\x1B_Ga=t,f=100,t=d,i=${id},`));
    expect(enterAt).toBeGreaterThanOrEqual(0);
    expect(transmitAt).toBeGreaterThan(enterAt);
    const [sessionDir] = fs.readdirSync(tmpParent);
    expect(sessionDir).toMatch(/^branch-review-media-/);

    proc.emit('exit', 0);
    expect(terminal.writes.at(-1)).toBe(`\x1B_Ga=d,d=I,i=${id},q=2\x1B\\${TERMINAL_RESTORE_SEQUENCE}`);
    expect(fs.readdirSync(tmpParent)).toEqual([]);
  }, 40_000);

  // A runCli session with a live media worker. The worker's git goes
  // through a shim that logs its parent, the worker, so the test records
  // the worker's pid itself. `quit` ends the UI the way q does.
  async function mediaSession() {
    const cwd = initRepo({'a.txt': 'one\n'});
    fs.writeFileSync(path.join(cwd, 'logo.png'), pngFixture(4, 2));
    const tmpParent = makeTempDir('branch-review-media-parent-');
    const bin = makeTempDir('branch-review-mediagit-');
    const pidLog = path.join(bin, 'worker.pid');
    const realGit = spawnSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).stdout.trim();
    writeExecutable(path.join(bin, 'git'), [
      '#!/bin/sh',
      `case "$*" in *--show-object-format*) echo $PPID >> '${pidLog}';; esac`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));
    const terminal = detectingTerminal((stdin) => stdin.emit('data', Buffer.from(KITTY_REPLY, 'latin1')));
    const proc = new FakeProcess();
    let tree: React.ReactElement | undefined;
    let quit!: () => void;
    const exited = new Promise<void>((resolve) => {
      quit = resolve;
    });
    let markRendered!: () => void;
    const rendered = new Promise<void>((resolve) => {
      markRendered = resolve;
    });
    const run = runCli({
      argv: ['HEAD', '--no-watch'],
      cwd,
      proc,
      // Only the media worker runs git with this env; the build uses the
      // test process's own.
      env: {...GHOSTTY_ENV, BRANCH_REVIEW_TMPDIR: tmpParent, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`},
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      stderr: {write: () => true},
      render: (next) => {
        tree = next;
        markRendered();
        return {waitUntilExit: () => exited, unmount: () => {}};
      },
    });
    await withTimeout(rendered, 20_000);

    const props = controllerOf(tree).props as {media?: import('../src/media/service.js').MediaService; initialReview: import('../src/review/model.js').ReviewModel; range: import('../src/git.js').DiffRange};
    const media = props.media!;
    // --no-watch: a file that changes on disk says a restart shows it.
    expect(media.watching).toBe(false);
    media.setReview(props.initialReview, {cwd, range: props.range});
    const ref = media.refFor(props.initialReview.files.find((entry) => entry.path === 'logo.png')!)!;
    await waitFor(() => media.sideState(ref, 'after').status === 'ready', 20_000);
    const pid = Number(fs.readFileSync(pidLog, 'utf8').trim().split('\n')[0]);
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);
    recordedPids.push(pid);
    expect(isAlive(pid)).toBe(true);
    return {pid, proc, quit, run};
  }

  it('ends the media worker as soon as the UI exits, without waiting for an exit event', async () => {
    const {pid, proc, quit, run} = await mediaSession();
    quit();
    await withTimeout(run, 10_000);
    // q never calls exit: the process ends when its event loop drains, so
    // nothing of the worker may still be running to hold it up.
    await waitFor(() => !isAlive(pid), 3_000);
    expect(proc.exits).toEqual([]);
  }, 40_000);

  it('kills the media worker at exit', async () => {
    const {pid, proc} = await mediaSession();
    proc.emit('exit', 0);
    await waitFor(() => !isAlive(pid), 3_000);
  }, 40_000);

  it('starts no media for a terminal without Kitty placeholders, or with --no-images', async () => {
    for (const [argv, reply] of [[['HEAD', 'main', '--no-watch'], '\x1B[?62c'], [['HEAD', 'main', '--no-watch', '--no-images'], KITTY_REPLY]] as const) {
      const cwd = initRepo({'a.txt': 'one\n'});
      writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
      const terminal = detectingTerminal((stdin) => stdin.emit('data', Buffer.from(reply, 'latin1')));
      const proc = new FakeProcess();
      let tree: React.ReactElement | undefined;
      let markRendered!: () => void;
      const rendered = new Promise<void>((resolve) => {
        markRendered = resolve;
      });
      void runCli({
        argv: [...argv],
        cwd,
        proc,
        env: GHOSTTY_ENV,
        stdin: terminal.stdin,
        stdout: terminal.stdout,
        stderr: {write: () => true},
        render: (next) => {
          tree = next;
          markRendered();
          return {waitUntilExit: () => new Promise(() => {}), unmount: () => {}};
        },
      });
      await withTimeout(rendered, 20_000);
      expect(controllerOf(tree).props.media, argv.join(' ')).toBeUndefined();
      proc.emit('exit', 0);
      expect(terminal.writes.at(-1)).toBe(TERMINAL_RESTORE_SEQUENCE);
    }
  }, 40_000);
});
