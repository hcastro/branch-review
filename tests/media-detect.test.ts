import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {decideCaps, parseReplies, startGraphicsDetection} from '../src/media/detect.js';
import {KITTY_QUERY} from '../src/media/kitty.js';
import {NO_GRAPHICS} from '../src/media/types.js';

// Detection asks the terminal what it can draw before Ink takes stdin: the
// Kitty graphics query, XTVERSION, the cell and text-area size in pixels, and
// DA1 last, whose reply ends the window. Nothing here touches the real stdin.

const ESC = '\x1B';
const OK = `${ESC}_Gi=31;OK${ESC}\\`;
const DA1 = `${ESC}[?62;22c`;
const CELL = `${ESC}[6;20;10t`;
const AREA = `${ESC}[4;800;1200t`;
const xtversion = (text: string) => `${ESC}P>|${text}${ESC}\\`;
const FULL_QUERY = `${KITTY_QUERY}${ESC}[>0q${ESC}[16t${ESC}[14t${ESC}[c`;

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  unshifted: string[] = [];
  paused = 0;
  resumed = 0;
  setRawMode = (mode: boolean) => {
    this.raw.push(mode);
    return this;
  };
  pause = () => {
    this.paused += 1;
    return this;
  };
  resume = () => {
    this.resumed += 1;
    return this;
  };
  unshift = (chunk: Buffer | string) => {
    this.unshifted.push(Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk);
  };
  reply(text: string) {
    this.emit('data', Buffer.from(text, 'latin1'));
  }
}

function setup(env: NodeJS.ProcessEnv, options: {images: 'auto' | 'off'} = {images: 'auto'}, overrides: {stdin?: FakeStdin | null; stdoutTTY?: boolean} = {}) {
  const stdin = overrides.stdin === null ? undefined : overrides.stdin ?? new FakeStdin();
  const writes: string[] = [];
  const onInterrupt = vi.fn();
  const detection = startGraphicsDetection({
    stdin,
    stdout: {isTTY: overrides.stdoutTTY ?? true, columns: 120, rows: 40, write: (text: string) => writes.push(text)},
    env,
    options,
    onInterrupt,
  });
  return {stdin: stdin as FakeStdin, writes, onInterrupt, detection};
}

const GHOSTTY = {TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.3.2-HEAD-+cb1ef70'};
const TMUX_ENV = {TERM: 'tmux-256color', TMUX: '/tmp/tmux-501/default,1,0', TERM_PROGRAM: 'tmux'};

// The timeout settles one setImmediate after its timer, so a check that it
// has not fired yet needs a real macrotask to pass first.
const turn = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('startGraphicsDetection', () => {
  it('chooses Kitty for Ghostty answering OK, with the cell size from CSI 16 t', async () => {
    const {stdin, writes, detection} = setup(GHOSTTY);
    expect(writes).toEqual([FULL_QUERY]);
    expect(stdin.raw).toEqual([true]);

    stdin.reply(`${OK}${xtversion('ghostty 1.3.2')}${CELL}${AREA}${DA1}`);
    const caps = await detection.result;

    expect(caps).toMatchObject({
      protocol: 'kitty',
      cellPx: {w: 10, h: 20},
      cellPxSource: 'csi16',
      colorDepth: 3,
      animation: false,
      tmux: false,
      detectionTimedOut: false,
    });
    expect(caps.terminal).toMatch(/^ghostty/);
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.unshifted).toEqual([]);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('chooses Kitty for kitty itself, with animation', async () => {
    const {stdin, detection} = setup({TERM: 'xterm-kitty'});
    stdin.reply(`${OK}${xtversion('kitty(0.35.2)')}${CELL}${DA1}`);
    expect(await detection.result).toMatchObject({protocol: 'kitty', terminal: 'kitty', animation: true, colorDepth: 3});
  });

  it('chooses blocks when only DA1 answers in a 256-colour terminal', async () => {
    const {stdin, detection} = setup({TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal'});
    stdin.reply(DA1);
    expect(await detection.result).toMatchObject({protocol: 'blocks', colorDepth: 2, terminal: 'Apple_Terminal', cellPxSource: 'default', cellPx: {w: 10, h: 20}});
  });

  for (const [name, env] of [
    ['WezTerm', {TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm'}],
    ['Warp', {TERM: 'xterm-256color', TERM_PROGRAM: 'WarpTerminal'}],
    ['VS Code', {TERM: 'xterm-256color', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor'}],
    ['Konsole', {TERM: 'xterm-256color', KONSOLE_VERSION: '230800'}],
  ] as const) {
    it(`chooses blocks for ${name}, which answers OK but has no placeholders`, async () => {
      const {stdin, detection} = setup(env);
      stdin.reply(`${OK}${DA1}`);
      expect((await detection.result).protocol).toBe('blocks');
    });
  }

  // Started from a Ghostty, cmux or kitty shell, these inherit the variables
  // that name an allowed terminal; the deny list must still win.
  for (const [name, env] of [
    ['WezTerm', {TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm', GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources/ghostty'}],
    ['WezTerm by its executable', {TERM: 'xterm-256color', WEZTERM_EXECUTABLE: '/usr/local/bin/wezterm-gui', TERM_PROGRAM: 'ghostty'}],
    ['Warp', {TERM: 'xterm-256color', TERM_PROGRAM: 'WarpTerminal', KITTY_WINDOW_ID: '3'}],
    ['VS Code', {TERM: 'xterm-256color', TERM_PROGRAM: 'vscode', COLORTERM: 'truecolor', GHOSTTY_RESOURCES_DIR: '/x'}],
    ['Konsole', {TERM: 'xterm-256color', KONSOLE_VERSION: '230800', TERM_PROGRAM: 'ghostty'}],
  ] as const) {
    it(`chooses blocks for ${name} even with an allowed terminal's variable inherited`, async () => {
      const {stdin, detection} = setup(env);
      stdin.reply(`${OK}${DA1}`);
      expect((await detection.result).protocol).toBe('blocks');
    });
  }

  it('denies a terminal by its XTVERSION reply too', async () => {
    const {stdin, detection} = setup({TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty'});
    stdin.reply(`${OK}${xtversion('WezTerm 20240203')}${DA1}`);
    expect((await detection.result).protocol).toBe('blocks');
  });

  it('gives up with no graphics when nothing answers by the timeout', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {stdin, detection} = setup(GHOSTTY);
    let settled = false;
    void detection.result.then(() => {
      settled = true;
    });

    vi.advanceTimersByTime(299);
    await turn();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    const caps = await detection.result;

    expect(caps).toMatchObject({protocol: 'none', detectionTimedOut: true});
    // Still raw and listening: the terminal may be answering late.
    expect(stdin.raw).toEqual([true]);
    expect(stdin.listenerCount('data')).toBe(1);

    expect(detection.handOff()).toEqual({keys: '', replyHead: ''});
    expect(stdin.listenerCount('data')).toBe(0);
    // Left raw for the app, which turns it on again as it mounts.
    expect(stdin.raw).toEqual([true]);
    detection.cancel();
    expect(stdin.raw).toEqual([true, false]);
  });

  it('after a timeout, swallows late replies with echo still off and hands keys to the app', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {stdin, detection} = setup(GHOSTTY);
    stdin.reply('j');
    vi.advanceTimersByTime(300);
    expect(await detection.result).toMatchObject({protocol: 'none', detectionTimedOut: true});

    stdin.reply(`${OK}${xtversion('ghostty 1.3.2')}`);
    stdin.reply(`k${CELL}${DA1}`);
    expect(stdin.raw).toEqual([true]);
    expect(stdin.unshifted).toEqual([]);

    expect(detection.handOff()).toEqual({keys: 'jk', replyHead: ''});
    expect(stdin.unshifted).toEqual(['jk']);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.paused).toBeGreaterThanOrEqual(1);
    // A second hand-off has nothing left to give.
    expect(detection.handOff()).toEqual({keys: '', replyHead: ''});
    expect(stdin.unshifted).toEqual(['jk']);
  });

  it('keeps a reply cut by the timeout whole when the rest arrives before the app takes stdin', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {stdin, detection} = setup(GHOSTTY);
    stdin.reply(`${ESC}[?62;22`);
    vi.advanceTimersByTime(300);
    expect(await detection.result).toMatchObject({protocol: 'none', detectionTimedOut: true});
    // Still ours, so the rest lands in the buffer instead of the app.
    expect(stdin.listenerCount('data')).toBe(1);
    stdin.reply('c');

    expect(detection.handOff()).toEqual({keys: '', replyHead: ''});
    expect(stdin.unshifted).toEqual([]);
  });

  it('calls onInterrupt on Ctrl-C after a timeout too, since raw mode is still on', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {stdin, onInterrupt, detection} = setup(GHOSTTY);
    vi.advanceTimersByTime(300);
    await detection.result;
    stdin.reply('\x03');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(detection.handOff()).toEqual({keys: '', replyHead: ''});
  });

  it('still reads a reply that arrived while the event loop was blocked past the timeout', async () => {
    // The startup build runs synchronous git, so the timer and the terminal's
    // reply can both be due when the loop next turns; the timer phase comes
    // first. A child process stands in for the terminal: its write is real
    // I/O, read in the poll phase like stdin.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-detect-'));
    const marker = path.join(dir, 'written');
    const {stdin, detection} = setup(GHOSTTY);
    const terminal = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(`${OK}${DA1}`)}, () => require('fs').writeFileSync(${JSON.stringify(marker)}, ''))`], {stdio: ['ignore', 'pipe', 'ignore']});
    terminal.stdout.on('data', (chunk: Buffer) => stdin.reply(chunk.toString('latin1')));
    try {
      const started = Date.now();
      while (!fs.existsSync(marker) || Date.now() - started < 400) {
        // Busy: neither the timer nor the reply can run.
        if (Date.now() - started > 20_000) throw new Error('the stand-in terminal never wrote');
      }
      expect(await detection.result).toMatchObject({protocol: 'kitty', detectionTimedOut: false});
    } finally {
      terminal.kill();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }, 30_000);

  it('waits a second over SSH or tmux, where replies take longer', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {stdin, detection} = setup({...GHOSTTY, SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 50000'});
    let settled = false;
    void detection.result.then(() => {
      settled = true;
    });
    vi.advanceTimersByTime(999);
    await turn();
    expect(settled).toBe(false);
    stdin.reply(`${OK}${DA1}`);
    expect((await detection.result).protocol).toBe('kitty');

    const late = setup({...GHOSTTY, SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 50000'});
    vi.advanceTimersByTime(1000);
    await turn();
    expect(await late.detection.result).toMatchObject({protocol: 'none', detectionTimedOut: true});

    const tmux = setup(TMUX_ENV);
    let tmuxSettled = false;
    void tmux.detection.result.then(() => {
      tmuxSettled = true;
    });
    vi.advanceTimersByTime(999);
    await turn();
    expect(tmuxSettled).toBe(false);
    vi.advanceTimersByTime(1);
    await turn();
    expect(tmuxSettled).toBe(true);
    expect(await tmux.detection.result).toMatchObject({protocol: 'blocks', tmux: true, detectionTimedOut: true});
  });

  it('reads replies split across chunks, mid-sequence', async () => {
    const {stdin, detection} = setup(GHOSTTY);
    const all = `${OK}${CELL}${DA1}`;
    for (const piece of [all.slice(0, 1), all.slice(1, 9), all.slice(9, 15), all.slice(15, -3), all.slice(-3)]) stdin.reply(piece);
    expect(await detection.result).toMatchObject({protocol: 'kitty', cellPxSource: 'csi16'});
    expect(stdin.unshifted).toEqual([]);
  });

  it('falls back to the text area divided by the grid when CSI 16 t is not answered', async () => {
    const {stdin, detection} = setup(GHOSTTY);
    stdin.reply(`${OK}${AREA}${DA1}`);
    expect(await detection.result).toMatchObject({cellPx: {w: 10, h: 20}, cellPxSource: 'csi14'});

    // 1080 × 720 px over the 120 × 40 grid: a size the default cannot pass for.
    const other = setup(GHOSTTY);
    other.stdin.reply(`${OK}${ESC}[4;720;1080t${DA1}`);
    expect(await other.detection.result).toMatchObject({cellPx: {w: 9, h: 18}, cellPxSource: 'csi14'});
  });

  it('calls onInterrupt on Ctrl-C, since raw mode stops it raising SIGINT', async () => {
    const {stdin, onInterrupt, detection} = setup(GHOSTTY);
    stdin.reply('\x03');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(stdin.raw).toEqual([true, false]);
    expect(await detection.result).toEqual(NO_GRAPHICS);
  });

  it('pushes keys typed during the window back for the app, without the replies', async () => {
    const {stdin, detection} = setup(GHOSTTY);
    stdin.reply(`j${OK}`);
    stdin.reply(`k${ESC}[A${DA1}`);
    await detection.result;
    expect(stdin.unshifted).toEqual([`jk${ESC}[A`]);
    // Raw mode goes off and the stream is paused before the bytes go back,
    // so no listener of ours sees them again.
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.paused).toBeGreaterThanOrEqual(1);
  });

  it('keeps an unfinished reply out of the keys it hands to the app, and names it instead', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {stdin, detection} = setup(GHOSTTY);
    stdin.reply(`q${ESC}_Gi=31;O`);
    vi.advanceTimersByTime(300);
    await detection.result;
    expect(detection.handOff()).toEqual({keys: 'q', replyHead: `${ESC}_Gi=31;O`});
    expect(stdin.unshifted).toEqual(['q']);
  });

  it('hands a lone Esc typed after the timeout to the app as a key, not as a reply head', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {stdin, detection} = setup(GHOSTTY);
    vi.advanceTimersByTime(300);
    await detection.result;
    stdin.reply(ESC);
    expect(detection.handOff()).toEqual({keys: ESC, replyHead: ''});
    expect(stdin.unshifted).toEqual([ESC]);

    const after = setup(GHOSTTY);
    after.stdin.reply('j');
    vi.advanceTimersByTime(300);
    await after.detection.result;
    after.stdin.reply(ESC);
    expect(after.detection.handOff()).toEqual({keys: `j${ESC}`, replyHead: ''});
    expect(after.stdin.unshifted).toEqual([`j${ESC}`]);
  });

  it('pushes back keys left unfinished after the DA1 reply, since no reply can follow it', async () => {
    const {stdin, detection} = setup(GHOSTTY);
    stdin.reply(`j${OK}${DA1}${ESC}`);
    await detection.result;
    expect(stdin.unshifted).toEqual([`j${ESC}`]);

    const arrow = setup(GHOSTTY);
    arrow.stdin.reply(`${OK}${DA1}${ESC}[`);
    await arrow.detection.result;
    expect(arrow.stdin.unshifted).toEqual([`${ESC}[`]);
  });

  it('cancel() ends the window at once and leaves raw mode off', async () => {
    const {stdin, detection} = setup(GHOSTTY);
    detection.cancel();
    detection.cancel();
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(await detection.result).toEqual(NO_GRAPHICS);
    stdin.reply(`${OK}${DA1}`);
    expect(stdin.unshifted).toEqual([]);
  });

  it('cancel() after a timeout ends the hold, with raw mode off', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {stdin, detection} = setup(GHOSTTY);
    vi.advanceTimersByTime(300);
    await detection.result;
    detection.cancel();
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(detection.handOff()).toEqual({keys: '', replyHead: ''});
  });

  it('hands nothing off and leaves raw mode alone once the terminal answered', async () => {
    const {stdin, detection} = setup(GHOSTTY);
    stdin.reply(`${OK}${DA1}`);
    await detection.result;
    expect(detection.handOff()).toEqual({keys: '', replyHead: ''});
    detection.cancel();
    expect(stdin.raw).toEqual([true, false]);
  });

  it('chooses blocks under tmux, and leaves the graphics query out', async () => {
    const {stdin, writes, detection} = setup(TMUX_ENV);
    expect(writes).toEqual([`${ESC}[>0q${ESC}[16t${ESC}[14t${ESC}[c`]);
    stdin.reply(`${xtversion('tmux 3.4')}${DA1}`);
    expect(await detection.result).toMatchObject({protocol: 'blocks', tmux: true});
  });

  it('chooses blocks under tmux with TERM=screen, which tmux sets by default', async () => {
    const {stdin, writes, detection} = setup({TERM: 'screen', TMUX: '/tmp/tmux-501/default,1,0'});
    expect(writes).toEqual([`${ESC}[>0q${ESC}[16t${ESC}[14t${ESC}[c`]);
    stdin.reply(DA1);
    expect(await detection.result).toMatchObject({protocol: 'blocks', tmux: true});
  });

  it('honours BRANCH_REVIEW_IMAGES=kitty and =blocks, still reading the cell size', async () => {
    const forcedKitty = setup({TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', BRANCH_REVIEW_IMAGES: 'kitty'});
    forcedKitty.stdin.reply(`${CELL}${DA1}`);
    expect(await forcedKitty.detection.result).toMatchObject({protocol: 'kitty', cellPxSource: 'csi16'});

    const forcedBlocks = setup({...GHOSTTY, BRANCH_REVIEW_IMAGES: 'blocks'});
    forcedBlocks.stdin.reply(`${OK}${DA1}`);
    expect((await forcedBlocks.detection.result).protocol).toBe('blocks');
  });

  it('gives blocks for BRANCH_REVIEW_IMAGES=kitty under tmux, whose APCs are not wrapped yet', async () => {
    const {stdin, detection} = setup({TERM: 'tmux-256color', TMUX: '/tmp/tmux-501/default,1,0', TERM_PROGRAM: 'tmux', BRANCH_REVIEW_IMAGES: 'kitty'});
    stdin.reply(DA1);
    expect(await detection.result).toMatchObject({protocol: 'blocks', tmux: true});
  });

  const silentCases: Array<[string, Parameters<typeof setup>]> = [
    ['--no-images', [GHOSTTY, {images: 'off'}]],
    ['BRANCH_REVIEW_IMAGES=off', [{...GHOSTTY, BRANCH_REVIEW_IMAGES: 'off'}]],
    ['BRANCH_REVIEW_IMAGES=0', [{...GHOSTTY, BRANCH_REVIEW_IMAGES: '0'}]],
    ['BRANCH_REVIEW_IMAGES=false', [{...GHOSTTY, BRANCH_REVIEW_IMAGES: 'false'}]],
    ['BRANCH_REVIEW_IMAGES=none', [{...GHOSTTY, BRANCH_REVIEW_IMAGES: 'none'}]],
    ['NO_COLOR', [{...GHOSTTY, NO_COLOR: '1'}]],
    ['NO_COLOR with a forced protocol', [{...GHOSTTY, NO_COLOR: '1', BRANCH_REVIEW_IMAGES: 'kitty'}]],
    ['FORCE_COLOR=0', [{...GHOSTTY, FORCE_COLOR: '0'}]],
    ['TERM=linux', [{TERM: 'linux'}]],
    ['TERM=dumb', [{TERM: 'dumb'}]],
    ['TERM=screen without tmux', [{TERM: 'screen-256color'}]],
    ['no stdin', [GHOSTTY, {images: 'auto'}, {stdin: null}]],
    ['stdout not a terminal', [GHOSTTY, {images: 'auto'}, {stdoutTTY: false}]],
  ];
  for (const [name, args] of silentCases) {
    it(`writes nothing and touches no terminal mode with ${name}`, async () => {
      const {stdin, writes, detection} = setup(...args);
      expect(await detection.result).toEqual(NO_GRAPHICS);
      expect(writes).toEqual([]);
      if (stdin) {
        expect(stdin.raw).toEqual([]);
        expect(stdin.listenerCount('data')).toBe(0);
      }
    });
  }

  it('writes nothing when stdin is not a terminal', async () => {
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    const {writes, detection} = setup(GHOSTTY, {images: 'auto'}, {stdin});
    expect(await detection.result).toEqual(NO_GRAPHICS);
    expect(writes).toEqual([]);
    expect(stdin.raw).toEqual([]);
  });

  it('gives no graphics, with raw mode back off, when raw mode cannot be set', async () => {
    const stdin = new FakeStdin();
    stdin.setRawMode = () => {
      throw new Error('EIO');
    };
    const {writes, detection} = setup(GHOSTTY, {images: 'auto'}, {stdin});
    expect(await detection.result).toEqual(NO_GRAPHICS);
    expect(writes).toEqual([]);
  });
});

describe('parseReplies', () => {
  it('recognises each reply and keeps everything else as stray input', () => {
    const parsed = parseReplies(`a${OK}${xtversion('kitty(0.35.2)')}b${CELL}${AREA}${DA1}c`);
    expect(parsed).toMatchObject({
      graphics: 'OK',
      xtversion: 'kitty(0.35.2)',
      cellPx: {w: 10, h: 20},
      textAreaPx: {w: 1200, h: 800},
      da1: true,
      stray: 'abc',
    });
  });

  it('keeps the start of an unfinished reply apart from the keys', () => {
    expect(parseReplies(`j${OK}k${ESC}[?62;22`)).toMatchObject({graphics: 'OK', da1: false, stray: 'jk', partial: `${ESC}[?62;22`});
    expect(parseReplies(`j${ESC}[A`)).toMatchObject({stray: `j${ESC}[A`, partial: ''});
  });

  it('reports a graphics error reply as not OK', () => {
    expect(parseReplies(`${ESC}_Gi=31;EINVAL:bad${ESC}\\${DA1}`).graphics).toBe('EINVAL:bad');
  });

  it('ignores a graphics reply for an image id that is not ours', () => {
    const parsed = parseReplies(`${ESC}_Gi=7;OK${ESC}\\${DA1}`);
    expect(parsed.graphics).toBeUndefined();
    expect(parsed).toMatchObject({da1: true, stray: '', partial: ''});
  });
});

describe('decideCaps', () => {
  const answered = (extra = '') => parseReplies(`${extra}${DA1}`);

  it('needs a colour depth of at least 256 for blocks', () => {
    expect(decideCaps(answered(), {TERM: 'xterm'}, {}).protocol).toBe('none');
    expect(decideCaps(answered(), {TERM: 'xterm', COLORTERM: 'truecolor'}, {})).toMatchObject({protocol: 'blocks', colorDepth: 3});
    // Apple Terminal draws 256 colours even when TERM says otherwise.
    expect(decideCaps(answered(), {TERM: 'xterm', TERM_PROGRAM: 'Apple_Terminal'}, {})).toMatchObject({protocol: 'blocks', colorDepth: 2});
  });

  // Each source on its own, with every other one absent, so none of them is
  // covered by another in the test.
  for (const [name, env, extra] of [
    ['TERM=xterm-kitty', {TERM: 'xterm-kitty'}, ''],
    ['KITTY_WINDOW_ID', {TERM: 'xterm-256color', KITTY_WINDOW_ID: '1'}, ''],
    ['TERM_PROGRAM=ghostty', {TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty'}, ''],
    ['GHOSTTY_RESOURCES_DIR', {TERM: 'xterm-256color', GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources/ghostty'}, ''],
    ['XTVERSION kitty', {TERM: 'xterm-256color'}, xtversion('kitty(0.35.2)')],
    ['XTVERSION ghostty', {TERM: 'xterm-256color'}, xtversion('ghostty 1.3.2')],
  ] as const) {
    it(`allows Kitty mode from ${name} alone`, () => {
      expect(decideCaps(answered(`${OK}${extra}`), env, {}).protocol).toBe('kitty');
    });
  }

  it('does not allow Kitty mode with no identity source at all', () => {
    expect(decideCaps(answered(OK), {TERM: 'xterm-256color'}, {}).protocol).toBe('blocks');
    expect(decideCaps(answered(`${OK}${xtversion('XTerm(388)')}`), {TERM: 'xterm-256color'}, {}).protocol).toBe('blocks');
  });

  it('gives blocks whenever TMUX is set, until APCs are wrapped for passthrough', () => {
    const tmux = '/tmp/tmux-501/default,1,0';
    expect(decideCaps(answered(), {TERM: 'screen', TMUX: tmux}, {})).toMatchObject({protocol: 'blocks', tmux: true});
    expect(decideCaps(parseReplies(''), {TERM: 'tmux-256color', TMUX: tmux}, {})).toMatchObject({protocol: 'blocks', tmux: true, detectionTimedOut: true});
    expect(decideCaps(answered(OK), {...GHOSTTY, TMUX: tmux}, {}).protocol).toBe('blocks');
  });

  it('does not choose Kitty for an OK from a terminal it cannot name', () => {
    expect(decideCaps(answered(OK), {TERM: 'xterm-256color'}, {}).protocol).toBe('blocks');
  });

  it('turns animation on for Ghostty 1.4.0 and later only', () => {
    const ok = answered(OK);
    expect(decideCaps(ok, {...GHOSTTY, TERM_PROGRAM_VERSION: '1.4.0'}, {}).animation).toBe(true);
    expect(decideCaps(ok, {...GHOSTTY, TERM_PROGRAM_VERSION: '1.10.1'}, {}).animation).toBe(true);
    expect(decideCaps(ok, {...GHOSTTY, TERM_PROGRAM_VERSION: '1.3.9'}, {}).animation).toBe(false);
    expect(decideCaps(answered(`${OK}${xtversion('ghostty 1.4.2')}`), {TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty'}, {}).animation).toBe(true);
  });

  it('ignores a cell size that is zero or absurd', () => {
    const caps = decideCaps(answered(`${OK}${ESC}[6;0;0t`), GHOSTTY, {columns: 0, rows: 0});
    expect(caps).toMatchObject({cellPx: {w: 10, h: 20}, cellPxSource: 'default'});
  });
});
