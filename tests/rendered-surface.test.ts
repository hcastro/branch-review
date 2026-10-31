import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {findTool} from '../src/media/worker/tools.js';
import {runTool, type RunResult, type RunTool} from '../src/rendered/run.js';
import {createSurface} from '../src/rendered/surface.js';
import {cleanupTempDirs, makeTempDir, writeExecutable} from './core-helpers.js';

// Where a rendered page opens: a cmux browser split that later presses
// reuse, else the default browser, else nowhere, with a reason. Nothing here
// runs the real cmux or opens a real browser: `run`, `findTool` and the
// opener are fakes, or the real runner finds a fake cmux on PATH.

// A hung fake cmux a test found still running, ended once the test is over.
const fakePids: number[] = [];
afterEach(() => {
  for (const pid of fakePids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  cleanupTempDirs();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const URL_A = 'file:///tmp/session/rendered/aaaaaaaaaaaaaaaaaaaa.html';
const URL_B = 'file:///tmp/session/rendered/bbbbbbbbbbbbbbbbbbbb.html';
const CMUX = '/fake/bin/cmux';
const CMUX_ENV = {CMUX_WORKSPACE_ID: 'workspace:3'};

type Call = {command: string; args: string[]; timeoutMs: number};

// Answers each cmux call from `answers` in turn, the last one again once
// they run out.
function recordingRun(...answers: Array<RunResult | (() => Promise<RunResult>)>) {
  const calls: Call[] = [];
  const run: RunTool = async (command, args, options) => {
    calls.push({command, args, timeoutMs: options.timeoutMs});
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    return typeof answer === 'function' ? answer() : answer;
  };
  return {run, calls};
}

function recordingOpener() {
  const opened: Array<[string, string[]]> = [];
  return {opened, opener: (command: string, args: string[]) => opened.push([command, args])};
}

const split = (fields: Record<string, unknown>): RunResult => ({ok: true, stdout: `${JSON.stringify(fields)}\n`});
const SPLIT = split({created_split: true, opened_externally: false, surface_ref: 'surface:17', placement_strategy: 'right'});
const found = (tools: Record<string, string>) => (name: string) => tools[name] ?? null;

describe('createSurface', () => {
  it('opens a split to the right without taking focus, then reuses it with goto', async () => {
    const {run, calls} = recordingRun(SPLIT, {ok: true, stdout: ''});
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    expect(surface.kind).toBe('cmux');

    expect(await surface.show(URL_A)).toEqual({where: 'cmux-new', message: 'in the split →'});
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'in the split →'});
    expect(calls).toEqual([
      {command: CMUX, args: ['--json', 'browser', 'open-split', URL_A, '--workspace', 'workspace:3', '--focus', 'false'], timeoutMs: 1500},
      {command: CMUX, args: ['browser', '--surface', 'surface:17', 'goto', URL_B], timeoutMs: 1500},
    ]);
    expect(opened).toEqual([]);
  });

  it('takes the split from surface_id when cmux answers with no surface_ref', async () => {
    const {run, calls} = recordingRun(split({created_split: true, opened_externally: false, surface_id: 'surface:8'}), {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin'});
    expect(await surface.show(URL_A)).toEqual({where: 'cmux-new', message: 'in the split →'});
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'in the split →'});
    expect(calls[1]!.args).toEqual(['browser', '--surface', 'surface:8', 'goto', URL_B]);
  });

  it('opens a new split without comment when the old one is gone', async () => {
    const {run, calls} = recordingRun(SPLIT, {ok: false, timedOut: false, reason: 'exit 1'}, split({created_split: true, surface_ref: 'surface:21'}), {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin'});
    await surface.show(URL_A);
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-new', message: 'in the split →'});
    await surface.show(URL_A);
    expect(calls.map((call) => call.args.slice(0, 4))).toEqual([
      ['--json', 'browser', 'open-split', URL_A],
      ['browser', '--surface', 'surface:17', 'goto'],
      ['--json', 'browser', 'open-split', URL_B],
      ['browser', '--surface', 'surface:21', 'goto'],
    ]);
  });

  it('says so when cmux opened the page in the browser itself, and never goes to a split it has none of', async () => {
    // What cmux answers with its browser turned off in its settings.
    const disabled = split({browser_disabled: true, created_split: false, opened_externally: true, surface_ref: null, placement_strategy: 'external_browser_disabled', url: URL_A});
    const {run, calls} = recordingRun(disabled);
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "opened in your browser · cmux's browser is off"});
    expect(await surface.show(URL_B)).toEqual({where: 'browser', message: "opened in your browser · cmux's browser is off"});
    expect(calls.every((call) => call.args.includes('open-split'))).toBe(true);
    expect(calls.some((call) => call.args.includes('goto'))).toBe(false);
    expect(opened).toEqual([]);
  });

  it('opens the default browser by absolute path when cmux fails, times out or answers nonsense', async () => {
    for (const answer of [
      {ok: false, timedOut: true, reason: 'timed out'} as RunResult,
      {ok: false, timedOut: false, reason: 'exit 2'} as RunResult,
      {ok: true, stdout: 'not json'} as RunResult,
      split({created_split: true, surface_ref: '--bad ref; rm'}),
    ]) {
      const {run} = recordingRun(answer);
      const {opener, opened} = recordingOpener();
      const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
      expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "cmux didn't answer · opened in your browser"});
      expect(opened).toEqual([['/usr/bin/open', [URL_A]]]);
    }
  });

  it('opens a new tab in the default browser outside cmux, with xdg-open from PATH off macOS', async () => {
    const mac = recordingOpener();
    // cmux on PATH counts only inside a cmux workspace.
    const outside = createSurface({env: {}, run: recordingRun(SPLIT).run, findTool: found({cmux: CMUX}), opener: mac.opener, platform: 'darwin'});
    expect(outside.kind).toBe('browser');
    expect(await outside.show(URL_A)).toEqual({where: 'browser', message: 'opened in your browser'});
    expect(mac.opened).toEqual([['/usr/bin/open', [URL_A]]]);

    const linux = recordingOpener();
    const onLinux = createSurface({env: {}, run: recordingRun(SPLIT).run, findTool: found({'xdg-open': '/usr/bin/xdg-open'}), opener: linux.opener, platform: 'linux'});
    await onLinux.show(URL_A);
    expect(linux.opened).toEqual([['/usr/bin/xdg-open', [URL_A]]]);
  });

  it('refuses over SSH and without any opener, naming --render-out', async () => {
    const {run, calls} = recordingRun(SPLIT);
    const {opener, opened} = recordingOpener();
    const ssh = createSurface({env: {...CMUX_ENV, SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    expect(ssh.kind).toBe('none');
    expect(ssh.refusal).toBe("open isn't available over SSH · branch-review --render-out <dir> writes the pages");
    expect(await ssh.show(URL_A)).toEqual({refused: ssh.refusal});

    const bare = createSurface({env: {}, run, findTool: found({}), opener, platform: 'linux'});
    expect(bare.kind).toBe('none');
    expect(await bare.show(URL_A)).toEqual({refused: 'no browser opener found · branch-review --render-out <dir> writes the pages'});
    expect(calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('keeps one cmux call in flight, and of the presses waiting behind it runs only the newest', async () => {
    let release!: () => void;
    const held = new Promise<RunResult>((resolve) => {
      release = () => resolve(SPLIT);
    });
    const {run, calls} = recordingRun(() => held, {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin'});
    const first = surface.show(URL_A);
    const second = surface.show(URL_B);
    const third = surface.show(URL_A);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    release();
    expect(await first).toEqual({where: 'cmux-new', message: 'in the split →'});
    expect(await second).toEqual({superseded: true});
    expect(await third).toEqual({where: 'cmux-reuse', message: 'in the split →'});
    expect(calls.map((call) => call.args.at(-1))).toEqual(['false', URL_A]);
  });
});

describe('createSurface at exit', () => {
  it('stops a cmux call still running once disposed, and opens nothing after', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    // cmux takes its time over the split, and answers only once it is stopped.
    const run: RunTool = (_command, _args, options) => new Promise((resolve) => {
      signals.push(options.signal);
      const stopped = () => resolve({ok: false, timedOut: false, reason: 'stopped'});
      if (options.signal?.aborted) stopped();
      options.signal?.addEventListener('abort', stopped);
    });
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    const showing = surface.show(URL_A);
    await Promise.resolve();
    expect(signals).toHaveLength(1);
    surface.dispose();
    expect(signals[0]!.aborted).toBe(true);
    // Neither the split nor the browser fallback: the page is about to be removed.
    expect(await showing).toEqual({superseded: true});
    expect(await surface.show(URL_B)).toEqual({superseded: true});
    expect(signals).toHaveLength(1);
    expect(opened).toEqual([]);

    // Outside cmux, a disposed surface opens no browser tab either.
    const browser = recordingOpener();
    const outside = createSurface({env: {}, run, findTool: found({}), opener: browser.opener, platform: 'darwin'});
    outside.dispose();
    expect(await outside.show(URL_A)).toEqual({superseded: true});
    expect(browser.opened).toEqual([]);
  });
});

describe('createSurface with the real runner and a fake cmux on PATH', () => {
  function fakeCmux(body: string) {
    const bin = makeTempDir('branch-review-fake-cmux-');
    const log = path.join(bin, 'calls.log');
    writeExecutable(path.join(bin, 'cmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${body}\n`);
    const env = {PATH: bin, CMUX_WORKSPACE_ID: 'workspace:9'};
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
    return {env, calls, bin, cwd: makeTempDir('branch-review-surface-repo-')};
  }

  it('reads the split cmux opened, and goes to it on the next press, with the terminal\'s stdin kept from it', async () => {
    // Each call says what its stdin is: the terminal's would be a TTY or a
    // pipe, and runTool hands it /dev/null.
    const probe = `if [ -t 0 ]; then echo tty; elif [ /dev/stdin -ef /dev/null ]; then echo null; else echo other; fi >> "\${0%/*}/stdin.log"`;
    const cmux = fakeCmux(`${probe}\ncase "$1" in --json) echo '{"created_split":true,"opened_externally":false,"surface_ref":"surface:4"}' ;; esac`);
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener, platform: 'darwin'});
    expect(await surface.show(URL_A)).toEqual({where: 'cmux-new', message: 'in the split →'});
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'in the split →'});
    expect(cmux.calls()).toEqual([
      `--json browser open-split ${URL_A} --workspace workspace:9 --focus false`,
      `browser --surface surface:4 goto ${URL_B}`,
    ]);
    expect(opened).toEqual([]);
    expect(fs.readFileSync(path.join(cmux.bin, 'stdin.log'), 'utf8').trim().split('\n')).toEqual(['null', 'null']);
  });

  it('gives up on a cmux that hangs after 1.5 s, ends it, and opens the browser', async () => {
    // The script becomes the sleep, so its pid is the hung program's.
    const cmux = fakeCmux('echo $$ > "${0%/*}/pid"\nexec /bin/sleep 10');
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener, platform: 'darwin'});
    const started = Date.now();
    expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "cmux didn't answer · opened in your browser"});
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(4000);
    expect(opened).toEqual([['/usr/bin/open', [URL_A]]]);
    const pid = Number(fs.readFileSync(path.join(cmux.bin, 'pid'), 'utf8'));
    // Killed, not left to sleep out its 10 s: gone once Node reaps it.
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (alive(pid)) fakePids.push(pid);
    expect(alive(pid)).toBe(false);
  });

  it('kills a cmux call still running when the app exits, and opens no browser for it', async () => {
    const cmux = fakeCmux('echo $$ > "${0%/*}/pid"\nexec /bin/sleep 10');
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener, platform: 'darwin'});
    const started = Date.now();
    const showing = surface.show(URL_A);
    const pidFile = path.join(cmux.bin, 'pid');
    while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8').trim() === '') await new Promise((resolve) => setTimeout(resolve, 10));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    surface.dispose();
    expect(await showing).toEqual({superseded: true});
    // At once, not after the 1.5 s timeout.
    expect(Date.now() - started).toBeLessThan(1400);
    expect(opened).toEqual([]);
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (alive(pid)) fakePids.push(pid);
    expect(alive(pid)).toBe(false);
  });

  it('falls back to the browser when cmux exits with an error', async () => {
    const cmux = fakeCmux('echo "Error: socket not found" >&2; exit 1');
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener, platform: 'darwin'});
    expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "cmux didn't answer · opened in your browser"});
    expect(opened).toEqual([['/usr/bin/open', [URL_A]]]);
  });
});
