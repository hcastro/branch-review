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

    expect(await surface.show(URL_A)).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(calls).toEqual([
      // An open-split runs to its own kill; the page goes elsewhere after 1500 ms.
      {command: CMUX, args: ['--json', 'browser', 'open-split', URL_A, '--workspace', 'workspace:3', '--focus', 'false'], timeoutMs: 10_000},
      {command: CMUX, args: ['browser', '--surface', 'surface:17', 'goto', URL_B], timeoutMs: 1500},
    ]);
    expect(opened).toEqual([]);
  });

  it('takes the split from surface_id when cmux answers with no surface_ref', async () => {
    const {run, calls} = recordingRun(split({created_split: true, opened_externally: false, surface_id: 'surface:8'}), {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin'});
    expect(await surface.show(URL_A)).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(calls[1]!.args).toEqual(['browser', '--surface', 'surface:8', 'goto', URL_B]);
  });

  it('opens a new split without comment when the old one is gone', async () => {
    const {run, calls} = recordingRun(SPLIT, {ok: false, timedOut: false, reason: 'exit 1'}, split({created_split: true, surface_ref: 'surface:21'}), {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin'});
    await surface.show(URL_A);
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
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
      expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "opened in your browser · cmux didn't answer"});
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

  it('refuses over SSH and without any opener, naming --export-html', async () => {
    const {run, calls} = recordingRun(SPLIT);
    const {opener, opened} = recordingOpener();
    const ssh = createSurface({env: {...CMUX_ENV, SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    expect(ssh.kind).toBe('none');
    expect(ssh.refusal).toBe("open isn't available over SSH · branch-review --export-html <dir> writes the pages");
    expect(await ssh.show(URL_A)).toEqual({refused: ssh.refusal});

    const bare = createSurface({env: {}, run, findTool: found({}), opener, platform: 'linux'});
    expect(bare.kind).toBe('none');
    expect(await bare.show(URL_A)).toEqual({refused: 'no browser opener found · branch-review --export-html <dir> writes the pages'});
    expect(calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('names v over SSH when the pane draws pages there', async () => {
    const {run, calls} = recordingRun(SPLIT);
    const ssh = createSurface({env: {...CMUX_ENV, SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}, run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin', inPane: true});
    expect(ssh.refusal).toBe("open isn't available over SSH · v previews it");
    expect(await ssh.show(URL_A)).toEqual({refused: ssh.refusal});
    expect(calls).toEqual([]);
  });

  it('names v over SSH only while the pane can draw there, asked when the refusal is read', async () => {
    const {run} = recordingRun(SPLIT);
    let draws = false;
    let asked = 0;
    const ssh = createSurface({env: {...CMUX_ENV, SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}, run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin', inPane: () => {
      asked += 1;
      return draws;
    }});
    expect(asked).toBe(0);
    expect(ssh.kind).toBe('none');
    expect(ssh.refusal).toBe("open isn't available over SSH · branch-review --export-html <dir> writes the pages");
    draws = true;
    expect(ssh.refusal).toBe("open isn't available over SSH · v previews it");
    expect(await ssh.show(URL_A)).toEqual({refused: "open isn't available over SSH · v previews it"});
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
    expect(await first).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
    expect(await second).toEqual({superseded: true});
    expect(await third).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(calls.map((call) => call.args.at(-1))).toEqual(['false', URL_A]);
  });
});

describe('the time cmux has to answer', () => {
  it('gives every cmux call the time the surface was made with, 1500 ms unless it says, and an open-split its own 10 s', async () => {
    const {run, calls} = recordingRun(SPLIT, {ok: true, stdout: `${URL_A}\n`}, {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin', timeoutMs: 4_000});
    await surface.show(URL_A);
    await surface.refresh(URL_B, ['aaaaaaaaaaaaaaaaaaaa.html']);
    expect(calls.map((call) => [call.args.at(-1) === 'url' ? 'url' : call.args.includes('goto') ? 'goto' : 'open-split', call.timeoutMs])).toEqual([['open-split', 10_000], ['url', 4_000], ['goto', 4_000]]);
    const plain = recordingRun(SPLIT, {ok: true, stdout: ''});
    const usual = createSurface({env: CMUX_ENV, run: plain.run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin'});
    await usual.show(URL_A);
    await usual.show(URL_B);
    expect(plain.calls.map((call) => call.timeoutMs)).toEqual([10_000, 1500]);
  });

  it('waits for an open-split answer the time the surface was made with before the page goes to the browser', async () => {
    // cmux makes the split 200 ms after it is asked.
    const late = () => recordingRun(() => new Promise<RunResult>((resolve) => setTimeout(() => resolve(SPLIT), 200)));
    const hasty = createSurface({env: CMUX_ENV, run: late().run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin', timeoutMs: 50});
    expect(await hasty.show(URL_A)).toEqual({where: 'browser', message: "opened in your browser · cmux didn't answer"});
    const usual = createSurface({env: CMUX_ENV, run: late().run, findTool: found({cmux: CMUX}), opener: () => undefined, platform: 'darwin'});
    expect(await usual.show(URL_A)).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
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

// A fake cmux run by the real runner that answers gets time enough on a
// loaded machine; the tests of the timeout itself keep cmux's 1500 ms.
const ANSWERS_MS = 10_000;

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
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener, platform: 'darwin', timeoutMs: ANSWERS_MS});
    expect(await surface.show(URL_A)).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(cmux.calls()).toEqual([
      `--json browser open-split ${URL_A} --workspace workspace:9 --focus false`,
      `browser --surface surface:4 goto ${URL_B}`,
    ]);
    expect(opened).toEqual([]);
    expect(fs.readFileSync(path.join(cmux.bin, 'stdin.log'), 'utf8').trim().split('\n')).toEqual(['null', 'null']);
  });

  it('gives up on a cmux that hangs after 1.5 s, opens the browser, and kills it at its own 10 s', async () => {
    // The script becomes the sleep, so its pid is the hung program's.
    const cmux = fakeCmux('echo $$ > "${0%/*}/pid"\nexec /bin/sleep 30');
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener, platform: 'darwin'});
    const started = Date.now();
    expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "opened in your browser · cmux didn't answer"});
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(4000);
    expect(opened).toEqual([['/usr/bin/open', [URL_A]]]);
    const pid = Number(fs.readFileSync(path.join(cmux.bin, 'pid'), 'utf8'));
    // Still running: a split it names late would be kept.
    expect(alive(pid)).toBe(true);
    // Killed at 10 s, not left to sleep out its 30: gone once Node reaps it.
    const deadline = started + 12_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (alive(pid)) fakePids.push(pid);
    expect(alive(pid)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
    // The next press asks cmux for a split again.
    await surface.show(URL_B);
    expect(cmux.calls().filter((call) => call.includes('open-split'))).toHaveLength(2);
  });

  it('keeps a split cmux names after the browser opened, and sends the next press there', async () => {
    // cmux takes 2 s to open its split, then names it.
    const cmux = fakeCmux('case "$1" in --json) /bin/sleep 2; echo \'{"created_split":true,"opened_externally":false,"surface_ref":"surface:5"}\' ;; esac');
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener, platform: 'darwin'});
    expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "opened in your browser · cmux didn't answer"});
    // While cmux still works on it, a press opens the browser and asks for no second split.
    expect(await surface.show(URL_B)).toEqual({where: 'browser', message: "opened in your browser · cmux didn't answer"});
    expect(cmux.calls()).toEqual([`--json browser open-split ${URL_A} --workspace workspace:9 --focus false`]);
    const deadline = Date.now() + 5_000;
    while (surface.opensSplit() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(surface.opensSplit()).toBe(false);
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(cmux.calls()).toEqual([
      `--json browser open-split ${URL_A} --workspace workspace:9 --focus false`,
      `browser --surface surface:5 goto ${URL_B}`,
    ]);
    expect(opened).toEqual([['/usr/bin/open', [URL_A]], ['/usr/bin/open', [URL_B]]]);
  });

  it('kills an open-split still running past its 1.5 s when the app exits', async () => {
    const cmux = fakeCmux('echo $$ > "${0%/*}/pid"\nexec /bin/sleep 30');
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener: recordingOpener().opener, platform: 'darwin'});
    expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "opened in your browser · cmux didn't answer"});
    const pid = Number(fs.readFileSync(path.join(cmux.bin, 'pid'), 'utf8'));
    surface.dispose();
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (alive(pid)) fakePids.push(pid);
    expect(alive(pid)).toBe(false);
  });

  it('takes cmux\'s word that its browser is off when it says so late', async () => {
    const cmux = fakeCmux('case "$1" in --json) /bin/sleep 2; echo \'{"browser_disabled":true,"created_split":false,"opened_externally":true,"surface_ref":null}\' ;; esac');
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener: recordingOpener().opener, platform: 'darwin'});
    await surface.show(URL_A);
    expect(surface.opensSplit()).toBe(true);
    const deadline = Date.now() + 5_000;
    while (surface.opensSplit() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(surface.opensSplit()).toBe(false);
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

  it('opens a new split without comment when cmux says the old one is gone, and a live refresh then opens nothing', async () => {
    // What cmux prints for a goto on a closed split: plain text, even with --json.
    const closed = 'case "$1" in --json) echo \'{"created_split":true,"opened_externally":false,"surface_ref":"surface:4"}\' ;; *) echo "Error: invalid_params: Browser operation failed"; exit 1 ;; esac';
    const pressed = fakeCmux(closed);
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: pressed.env, run: runTool, findTool: (name) => findTool(name, pressed.env, pressed.cwd), opener, platform: 'darwin', timeoutMs: ANSWERS_MS});
    expect(await surface.show(URL_A)).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
    expect(pressed.calls()).toEqual([
      `--json browser open-split ${URL_A} --workspace workspace:9 --focus false`,
      `browser --surface surface:4 goto ${URL_B}`,
      `--json browser open-split ${URL_B} --workspace workspace:9 --focus false`,
    ]);

    const live = fakeCmux(closed);
    const watched = createSurface({env: live.env, run: runTool, findTool: (name) => findTool(name, live.env, live.cwd), opener, platform: 'darwin', timeoutMs: ANSWERS_MS});
    await watched.show(URL_A);
    expect(await watched.refresh(URL_B)).toBe(false);
    expect(await watched.refresh(URL_B)).toBe(false);
    expect(live.calls()).toEqual([
      `--json browser open-split ${URL_A} --workspace workspace:9 --focus false`,
      `browser --surface surface:4 goto ${URL_B}`,
    ]);
    expect(opened).toEqual([]);
  });

  it('falls back to the browser when cmux exits with an error', async () => {
    const cmux = fakeCmux('echo "Error: socket not found" >&2; exit 1');
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: cmux.env, run: runTool, findTool: (name) => findTool(name, cmux.env, cmux.cwd), opener, platform: 'darwin', timeoutMs: ANSWERS_MS});
    expect(await surface.show(URL_A)).toEqual({where: 'browser', message: "opened in your browser · cmux didn't answer"});
    expect(opened).toEqual([['/usr/bin/open', [URL_A]]]);
  });
});

describe('a live refresh', () => {
  it('sends the split it opened to the new page, and opens nothing where there is no split', async () => {
    const {run, calls} = recordingRun(SPLIT, {ok: true, stdout: ''});
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    // Nothing is open yet: there is nowhere to refresh, and nothing opens.
    expect(await surface.refresh(URL_A)).toBe(false);
    expect(calls).toEqual([]);

    await surface.show(URL_A);
    expect(await surface.refresh(`${URL_B}#d=none&n=2`)).toBe(true);
    expect(calls.at(-1)).toEqual({command: CMUX, args: ['browser', '--surface', 'surface:17', 'goto', `${URL_B}#d=none&n=2`], timeoutMs: 1500});
    expect(opened).toEqual([]);
  });

  it('keeps the split when a goto only timed out, so the next press goes to it and opens no second one', async () => {
    const slow: RunResult = {ok: false, timedOut: true, reason: 'timed out'};
    const {run, calls} = recordingRun(SPLIT, slow, slow, {ok: true, stdout: ''});
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    await surface.show(URL_A);
    // cmux may still carry out a goto it was slow to answer: the split stays
    // the place to send pages, and live refreshes go on.
    expect(await surface.refresh(URL_B)).toBe(true);
    expect(await surface.show(URL_A)).toEqual({where: 'cmux-reuse', message: 'opened in the browser split · cmux was slow to answer'});
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(calls.map((call) => call.args.slice(0, 4).join(' '))).toEqual([
      `--json browser open-split ${URL_A}`,
      'browser --surface surface:17 goto',
      'browser --surface surface:17 goto',
      'browser --surface surface:17 goto',
    ]);
    expect(opened).toEqual([]);
  });

  it('gives up on a split that was closed, without opening a new one or a browser tab', async () => {
    const {run, calls} = recordingRun(SPLIT, {ok: false, timedOut: false, reason: 'no such surface'});
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    await surface.show(URL_A);
    expect(await surface.refresh(URL_B)).toBe(false);
    expect(await surface.refresh(URL_B)).toBe(false);
    // One goto, refused; after it nothing is tried.
    expect(calls.map((call) => call.args[0])).toEqual(['--json', 'browser']);
    expect(opened).toEqual([]);
  });

  it('never refreshes outside cmux, nor when cmux opened the page in the browser itself', async () => {
    const {opener, opened} = recordingOpener();
    const browser = createSurface({env: {}, run: recordingRun().run, findTool: found({}), opener, platform: 'darwin'});
    await browser.show(URL_A);
    expect(await browser.refresh(URL_B)).toBe(false);
    expect(opened).toEqual([['/usr/bin/open', [URL_A]]]);

    const {run, calls} = recordingRun(split({browser_disabled: true, created_split: false, opened_externally: true, surface_ref: null}));
    const off = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    await off.show(URL_A);
    expect(await off.refresh(URL_B)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('never lands after a press in flight, nor takes the place of one waiting', async () => {
    const hold = () => {
      let release!: () => void;
      const held = new Promise<RunResult>((resolve) => {
        release = () => resolve({ok: true, stdout: ''});
      });
      return {held, release: () => release()};
    };
    // A press runs; a refresh of the page it is leaving asks to go after it.
    const first = hold();
    const one = recordingRun(SPLIT, () => first.held, {ok: true, stdout: ''});
    const after = createSurface({env: CMUX_ENV, run: one.run, findTool: found({cmux: CMUX}), opener: recordingOpener().opener, platform: 'darwin'});
    await after.show(URL_A);
    const press = after.show(URL_B);
    const refresh = after.refresh(`${URL_A}#d=none&n=3`);
    first.release();
    expect(await press).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(await refresh).toBe('superseded');
    expect(one.calls.map((call) => call.args.at(-1))).toEqual(['false', URL_B]);

    // A press runs and another waits; a refresh asked for then must not
    // supersede the waiting press.
    const second = hold();
    const two = recordingRun(SPLIT, () => second.held, {ok: true, stdout: ''});
    const behind = createSurface({env: CMUX_ENV, run: two.run, findTool: found({cmux: CMUX}), opener: recordingOpener().opener, platform: 'darwin'});
    await behind.show(URL_A);
    const running = behind.show(`${URL_B}#c`);
    const waiting = behind.show(URL_B);
    const late = behind.refresh(`${URL_A}#d=none&n=4`);
    second.release();
    expect(await running).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(await waiting).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(await late).toBe('superseded');
    expect(two.calls.map((call) => call.args.at(-1))).toEqual(['false', `${URL_B}#c`, URL_B]);
  });

  it('waits behind a press in flight, and gives way to a newer one', async () => {
    let release!: () => void;
    const held = new Promise<RunResult>((resolve) => {
      release = () => resolve({ok: true, stdout: ''});
    });
    const {run, calls} = recordingRun(SPLIT, () => held, {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: recordingOpener().opener, platform: 'darwin'});
    await surface.show(URL_A);
    const press = surface.show(URL_B);
    const refresh = surface.refresh(`${URL_A}#live`);
    const newer = surface.show(`${URL_B}#newer`);
    release();
    expect(await press).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(await refresh).toBe('superseded');
    expect(await newer).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(calls.map((call) => call.args.at(-1))).toEqual(['false', URL_B, `${URL_B}#newer`]);
  });
});


describe('whether a press opens a new split', () => {
  it('says so while no split is known to be open, so the TUI can finish its beam before cmux resizes it', async () => {
    const gone: RunResult = {ok: false, timedOut: false, reason: 'exit 1'};
    const {run} = recordingRun(SPLIT, gone, split({created_split: true, surface_ref: 'surface:21'}));
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: recordingOpener().opener, platform: 'darwin'});
    expect(surface.opensSplit()).toBe(true);
    await surface.show(URL_A);
    expect(surface.opensSplit()).toBe(false);
    // The goto finds the split closed and opens a new one; that one is open.
    await surface.show(URL_B);
    expect(surface.opensSplit()).toBe(false);
  });

  it('opens no split outside cmux, nor once cmux said its browser is off', async () => {
    const browser = createSurface({env: {}, run: recordingRun().run, findTool: found({}), opener: recordingOpener().opener, platform: 'darwin'});
    expect(browser.opensSplit()).toBe(false);
    const {run} = recordingRun(split({browser_disabled: true, created_split: false, opened_externally: true, surface_ref: null}));
    const off = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: recordingOpener().opener, platform: 'darwin'});
    expect(off.opensSplit()).toBe(true);
    await off.show(URL_A);
    expect(off.opensSplit()).toBe(false);
  });
});

describe('a live refresh that checks what the split shows', () => {
  const SHOWS_A = ['aaaaaaaaaaaaaaaaaaaa.html', 'f-00000000000000000000.html'];

  it('asks cmux for the split\'s URL first, and goes only when it shows the page last opened', async () => {
    const {run, calls} = recordingRun(SPLIT, {ok: true, stdout: `${URL_A}#at=L3&d=full&n=1\n`}, {ok: true, stdout: ''}, {ok: true, stdout: JSON.stringify({url: 'file:///tmp/session/rendered/f-00000000000000000000.html'})}, {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: recordingOpener().opener, platform: 'darwin'});
    await surface.show(URL_A);
    expect(await surface.refresh(`${URL_B}#d=none&n=2`, SHOWS_A)).toBe(true);
    expect(await surface.refresh(`${URL_B}#d=none&n=3`, SHOWS_A)).toBe(true);
    expect(calls.slice(1).map((call) => [call.args, call.timeoutMs])).toEqual([
      [['browser', '--surface', 'surface:17', 'url'], 1500],
      [['browser', '--surface', 'surface:17', 'goto', `${URL_B}#d=none&n=2`], 1500],
      [['browser', '--surface', 'surface:17', 'url'], 1500],
      [['browser', '--surface', 'surface:17', 'goto', `${URL_B}#d=none&n=3`], 1500],
    ]);
  });

  it('skips the refresh, keeping the split, when it shows another page, or cmux is slow to say', async () => {
    const {run, calls} = recordingRun(
      SPLIT,
      {ok: true, stdout: 'file:///tmp/session/rendered/cccccccccccccccccccc.html#d=full\n'},
      {ok: true, stdout: 'not a url\n'},
      {ok: false, timedOut: true, reason: 'timed out'},
      {ok: true, stdout: ''},
    );
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener, platform: 'darwin'});
    await surface.show(URL_A);
    for (let each = 0; each < 3; each += 1) expect(await surface.refresh(URL_B, SHOWS_A)).toBe('skipped');
    expect(calls.slice(1).every((call) => call.args.at(-1) === 'url')).toBe(true);
    // The split is still the place pages go.
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(opened).toEqual([]);
  });

  it('works out a refresh\'s URL only as its goto is sent, once the call ahead of it has ended, and never for one it skips', async () => {
    let answer!: () => void;
    const asked = new Promise<RunResult>((resolve) => {
      answer = () => resolve({ok: true, stdout: `${URL_A}\n`});
    });
    const {run, calls} = recordingRun(SPLIT, () => asked, {ok: true, stdout: `${URL_B}\n`}, {ok: true, stdout: ''}, {ok: true, stdout: 'file:///elsewhere/notes.html\n'});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: recordingOpener().opener, platform: 'darwin'});
    await surface.show(URL_A);
    // Each URL worked out, with the cmux calls made by then.
    const worked: Array<[string, number]> = [];
    const refresh = surface.refresh(() => {
      worked.push(['first', calls.length]);
      return `${URL_B}#d=none&n=2`;
    }, SHOWS_A);
    const behind = surface.refresh(() => {
      worked.push(['second', calls.length]);
      return `${URL_B}#d=none&n=3`;
    }, [...SHOWS_A, 'bbbbbbbbbbbbbbbbbbbb.html']);
    // The first gives way to the second, so its URL is never worked out;
    // the second's is, after both questions and before its goto.
    answer();
    expect(await refresh).toBe('superseded');
    expect(await behind).toBe(true);
    expect(worked).toEqual([['second', 3]]);
    expect(calls.slice(1).map((call) => call.args.slice(3))).toEqual([['url'], ['url'], ['goto', `${URL_B}#d=none&n=3`]]);
    // A refresh the split skips works out nothing.
    expect(await surface.refresh(() => {
      worked.push(['skipped', calls.length]);
      return URL_B;
    }, SHOWS_A)).toBe('skipped');
    expect(worked).toEqual([['second', 3]]);
  });

  it('gives way to a press made while cmux says what the split shows, so the press goes next', async () => {
    let answer!: () => void;
    const asked = new Promise<RunResult>((resolve) => {
      answer = () => resolve({ok: true, stdout: `${URL_A}\n`});
    });
    const {run, calls} = recordingRun(SPLIT, () => asked, {ok: true, stdout: ''});
    const surface = createSurface({env: CMUX_ENV, run, findTool: found({cmux: CMUX}), opener: recordingOpener().opener, platform: 'darwin'});
    await surface.show(URL_A);
    const refresh = surface.refresh(`${URL_A}#d=none&n=2`, SHOWS_A);
    // The reader presses r on another file while cmux is still answering.
    const press = surface.show(URL_B);
    answer();
    expect(await refresh).toBe('superseded');
    expect(await press).toEqual({where: 'cmux-reuse', message: 'opened in the browser split'});
    expect(calls.slice(1).map((call) => call.args.slice(3))).toEqual([['url'], ['goto', URL_B]]);
  });

  it('forgets the split without a word when a fake cmux on PATH prints that it is gone, so the next press opens a new one', async () => {
    const bin = makeTempDir('branch-review-fake-cmux-');
    const log = path.join(bin, 'calls.log');
    writeExecutable(path.join(bin, 'cmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in --json) echo '{"created_split":true,"opened_externally":false,"surface_ref":"surface:4"}' ;; *) echo "Error: invalid_params: Browser operation failed"; exit 1 ;; esac\n`);
    const env = {PATH: bin, CMUX_WORKSPACE_ID: 'workspace:9'};
    const cwd = makeTempDir('branch-review-surface-repo-');
    const {opener, opened} = recordingOpener();
    const surface = createSurface({env, run: runTool, findTool: (name) => findTool(name, env, cwd), opener, platform: 'darwin', timeoutMs: ANSWERS_MS});
    await surface.show(URL_A);
    expect(surface.opensSplit()).toBe(false);
    expect(await surface.refresh(URL_B, SHOWS_A)).toBe(false);
    // Nothing is sent to it again: no refresh, and the press opens a split.
    expect(surface.opensSplit()).toBe(true);
    expect(await surface.refresh(URL_B, SHOWS_A)).toBe(false);
    expect(await surface.show(URL_B)).toEqual({where: 'cmux-new', message: 'opened in the browser split'});
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `--json browser open-split ${URL_A} --workspace workspace:9 --focus false`,
      'browser --surface surface:4 url',
      `--json browser open-split ${URL_B} --workspace workspace:9 --focus false`,
    ]);
    expect(opened).toEqual([]);
  });
});
