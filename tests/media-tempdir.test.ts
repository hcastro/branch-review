import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {claimKittyTmux, createMediaTempDir, mediaTempParent, processStartTime, sweepStaleMediaDirs, tmuxServerHash, type PsRunner} from '../src/media/tempDir.js';
import {createWorkerBackend} from '../src/media/workerClient.js';
import {openMedia} from '../src/media/openExternal.js';
import type {MediaRef, SideRef} from '../src/media/types.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir, snapshotTree} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';

// The session's media temp dir: made on first use, private, removed at exit,
// and swept at the next start when a session died without removing it.

afterEach(cleanupTempDirs);

describe('media temp dir', {timeout: 30_000}, () => {
  it('is made only when first asked for, private, with its owner pid and the worker dir', () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    const env = {BRANCH_REVIEW_TMPDIR: parent};
    const tempDir = createMediaTempDir({env, pid: 4242});
    expect(fs.readdirSync(parent)).toEqual([]);

    const dir = tempDir.get();
    expect(tempDir.get()).toBe(dir);
    expect(path.dirname(dir)).toBe(parent);
    expect(path.basename(dir)).toMatch(/^branch-review-media-/);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, 'owner.pid'), 'utf8')).toBe('4242\n');
    expect(fs.statSync(path.join(dir, 'worker')).isDirectory()).toBe(true);

    tempDir.remove();
    expect(fs.existsSync(dir)).toBe(false);
    tempDir.remove();
  });

  it('removing a dir never made does nothing', () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    createMediaTempDir({env: {BRANCH_REVIEW_TMPDIR: parent}}).remove();
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('sweeps dirs whose owner process is gone and keeps live ones and anything else', () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    const env = {BRANCH_REVIEW_TMPDIR: parent};
    const dead = createMediaTempDir({env, pid: 999_001}).get();
    const alive = createMediaTempDir({env, pid: 999_002}).get();
    const mine = createMediaTempDir({env}).get();
    const unrelated = path.join(parent, 'branch-review-refresh-x');
    fs.mkdirSync(unrelated);
    const noOwner = path.join(parent, 'branch-review-media-noowner');
    fs.mkdirSync(noOwner);
    const target = makeTempDir('branch-review-link-target-');
    fs.writeFileSync(path.join(target, 'owner.pid'), '999001\n');
    const link = path.join(parent, 'branch-review-media-link');
    fs.symlinkSync(target, link);

    sweepStaleMediaDirs({env, isGone: (pid) => pid === 999_001});

    expect(fs.existsSync(dead)).toBe(false);
    for (const kept of [alive, mine, unrelated, noOwner, link, target]) expect(fs.existsSync(kept), kept).toBe(true);
  });

  it('resolves BRANCH_REVIEW_TMPDIR to an absolute dir, and reads an empty one as unset', () => {
    const start = process.cwd();
    const elsewhere = makeTempDir('branch-review-tmp-cwd-');
    fs.mkdirSync(path.join(elsewhere, 'rel', 'x'), {recursive: true});
    try {
      process.chdir(elsewhere);
      expect(mediaTempParent({BRANCH_REVIEW_TMPDIR: ''})).toBe(path.resolve(os.tmpdir()));
      expect(mediaTempParent({})).toBe(path.resolve(os.tmpdir()));
      expect(mediaTempParent({BRANCH_REVIEW_TMPDIR: 'rel/x'})).toBe(path.resolve('rel/x'));

      const empty = createMediaTempDir({env: {BRANCH_REVIEW_TMPDIR: ''}});
      const inTmp = empty.get();
      expect(path.isAbsolute(inTmp)).toBe(true);
      expect(path.dirname(inTmp)).toBe(path.resolve(os.tmpdir()));
      empty.remove();

      const relative = createMediaTempDir({env: {BRANCH_REVIEW_TMPDIR: 'rel/x'}});
      const inRel = relative.get();
      expect(path.dirname(inRel)).toBe(path.resolve('rel/x'));
      expect(path.basename(inRel)).toMatch(/^branch-review-media-/);
      relative.remove();
      // Nothing is made in the cwd itself.
      expect(fs.readdirSync(elsewhere)).toEqual(['rel']);
    } finally {
      process.chdir(start);
    }
  });

  it('sweeps with an empty BRANCH_REVIEW_TMPDIR without throwing', () => {
    expect(() => sweepStaleMediaDirs({env: {BRANCH_REVIEW_TMPDIR: ''}, isGone: () => false})).not.toThrow();
  });

  it('leaves the reviewed repo as it was after a preview and an open, with an empty or relative BRANCH_REVIEW_TMPDIR', async () => {
    const start = process.cwd();
    const elsewhere = makeTempDir('branch-review-tmp-cwd-');
    fs.mkdirSync(path.join(elsewhere, 'rel', 'x'), {recursive: true});
    // An empty value with the shell in the repo; a relative one elsewhere.
    for (const [value, uiCwd] of [['', 'repo'], ['rel/x', elsewhere]] as const) {
      const repo = initRepo();
      fs.writeFileSync(path.join(repo, 'logo.png'), pngFixture(4, 2));
      commitAll(repo, 'add logo');
      const status = git(repo, 'status', '--porcelain');
      const tree = [...snapshotTree(repo)].filter(([name]) => !name.startsWith('.git'));
      const env = {...process.env, BRANCH_REVIEW_TMPDIR: value};
      const opened: string[][] = [];
      try {
        process.chdir(uiCwd === 'repo' ? repo : uiCwd);
        const tempDir = createMediaTempDir({env});
        const backend = createWorkerBackend({tempDir: tempDir.get, env, cwd: repo});
        try {
          const abbrevId = git(repo, 'rev-parse', '--short', 'HEAD:logo.png').trim();
          const side: SideRef = {side: 'after', source: 'blob', path: 'logo.png', abbrevId, key: `blob|logo.png|${abbrevId}`};
          expect(await backend.inspect({cwd: repo, side, kind: 'raster', format: 'png'}, new AbortController().signal), value).toMatchObject({ok: true});
          const ref = {fileKey: 'logo.png', kind: 'raster', format: 'png', after: side} as unknown as MediaRef;
          const outcome = await openMedia({backend, cwd: repo, tempDir: tempDir.get, env, opener: (command, args) => opened.push([command, ...args]), platform: 'darwin'}, ref, 'after', 'open');
          expect(outcome, value).toEqual({message: 'opened logo.png (after)', kind: 'info'});
          expect(opened, value).toHaveLength(1);
          expect(opened[0]![1]!.startsWith(`${mediaTempParent(env)}${path.sep}branch-review-media-`), value).toBe(true);
        } finally {
          backend.dispose();
          tempDir.remove();
        }
      } finally {
        process.chdir(start);
      }
      expect(git(repo, 'status', '--porcelain'), value).toBe(status);
      expect([...snapshotTree(repo)].filter(([name]) => !name.startsWith('.git')), value).toEqual(tree);
    }
  }, 30_000);

  it('hands a viewer nothing when asked to write a copy into a relative dir', async () => {
    const {createWorkerHandler} = await import('../src/media/worker/handler.js');
    const side: SideRef = {side: 'after', source: 'blob', path: 'logo.png', abbrevId: 'abcdef1', key: 'blob|logo.png|abcdef1'};
    expect(await createWorkerHandler().handle({type: 'exportCopy', cwd: '/', side, format: 'png', dir: 'rel/x'})).toEqual({ok: false, state: 'error', reason: 'the session temp dir is not an absolute path'});
  });
});

describe('one Kitty-drawing session per tmux server', () => {
  const TMUX = '/tmp/tmux-501/default,1,0';

  it('names the server by its socket path alone', () => {
    expect(tmuxServerHash(TMUX)).toMatch(/^[0-9a-f]{16}$/);
    expect(tmuxServerHash('/tmp/tmux-501/default,99,3')).toBe(tmuxServerHash(TMUX));
    expect(tmuxServerHash('/tmp/tmux-501/other,1,0')).not.toBe(tmuxServerHash(TMUX));
  });

  it('claims a server no live session claims, and gives way to one that does', () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    const env = {BRANCH_REVIEW_TMPDIR: parent};
    const first = createMediaTempDir({env, pid: 999_101}).get();
    const alive = (pid: number) => pid !== 999_101 && pid !== 999_102;
    expect(claimKittyTmux(first, TMUX, {env, pid: 999_101, isGone: (pid) => !alive(pid)})).toBe(true);
    expect(fs.readFileSync(path.join(first, 'kitty-tmux'), 'utf8')).toBe(`${tmuxServerHash(TMUX)}\n`);
    expect(fs.statSync(path.join(first, 'kitty-tmux')).mode & 0o777).toBe(0o600);

    // The first session is alive: the second gives way and keeps no claim.
    const second = createMediaTempDir({env, pid: 999_103}).get();
    expect(claimKittyTmux(second, TMUX, {env, pid: 999_103, isGone: (pid) => pid === 999_102})).toBe(false);
    expect(fs.existsSync(path.join(second, 'kitty-tmux'))).toBe(false);

    // Once the first is gone, its stale claim counts for nothing.
    const third = createMediaTempDir({env, pid: 999_104}).get();
    expect(claimKittyTmux(third, TMUX, {env, pid: 999_104, isGone: (pid) => pid === 999_101})).toBe(true);

    // A claim on another server never counts.
    const fourth = createMediaTempDir({env, pid: 999_105}).get();
    expect(claimKittyTmux(fourth, '/tmp/tmux-501/other,1,0', {env, pid: 999_105, isGone: () => false})).toBe(true);
  });

  it('counts a session another user\'s process might own as alive (EPERM)', () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    const env = {BRANCH_REVIEW_TMPDIR: parent};
    // pid 1 runs as root: kill(1, 0) fails with EPERM, which means alive.
    const rootOwned = createMediaTempDir({env, pid: 1}).get();
    fs.writeFileSync(path.join(rootOwned, 'kitty-tmux'), `${tmuxServerHash(TMUX)}\n`);
    const mine = createMediaTempDir({env}).get();
    expect(claimKittyTmux(mine, TMUX, {env})).toBe(false);
  });

  // A live process this test started and records, killed at the end.
  async function withLiveProcess(run: (pid: number) => void | Promise<void>) {
    const child = spawn('/bin/sleep', ['30'], {stdio: 'ignore'});
    const pid = child.pid!;
    try {
      await run(pid);
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  it('reads one start time for a live process, and none for a pid with no process', async () => {
    await withLiveProcess((pid) => {
      const start = processStartTime(pid);
      expect(start).toMatch(/^(proc|ps):\S/);
      expect(processStartTime(pid)).toBe(start);
      expect(processStartTime(process.pid)).not.toBe(start);
    });
    expect(processStartTime(0)).toBeNull();
    expect(processStartTime(2 ** 22 + 12_345)).toBeNull();
  });

  // What `ps -o lstart=` prints in the C locale for a process that started
  // at `started`: local time in `zone`, the day of the month space-padded.
  function lstart(started: number, zone: string) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', year: 'numeric', hourCycle: 'h23'})
      .formatToParts(new Date(started)).map((part) => [part.type, part.value]));
    return `${parts.weekday} ${parts.month} ${parts.day!.padStart(2, ' ')} ${parts.hour}:${parts.minute}:${parts.second} ${parts.year}`;
  }

  it('reads the same start time for one process when the time zone changes between reads', () => {
    const started = Date.UTC(2026, 9, 31, 1, 2, 37);
    // A stand-in for ps: it prints in TZ when it gets one, else in the
    // system zone, which a laptop may change while it travels.
    let systemZone = 'America/New_York';
    const ps = (at: number): PsRunner => (_command, _args, env) => ({status: 0, stdout: `${lstart(at, env.TZ ?? systemZone)}    \n`});
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const first = processStartTime(process.pid, {run: ps(started)});
      systemZone = 'Asia/Tokyo';
      process.env.TZ = 'Asia/Tokyo';
      const second = processStartTime(process.pid, {run: ps(started)});
      expect(second).toBe(first);
      expect(first).toMatch(/^(proc|ps):\d+$/);
      if (first!.startsWith('ps:')) {
        expect(first).toBe(`ps:${started / 1000}`);
        // A process that started at another time still reads another start,
        // so a reused pid is still told apart.
        expect(processStartTime(process.pid, {run: ps(started + 1_000)})).toBe(`ps:${started / 1000 + 1}`);
        // Output that is not a start time reads as none.
        expect(processStartTime(process.pid, {run: () => ({status: 0, stdout: 'not a time\n'})})).toBeNull();
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('ignores a claim left by a killed session whose pid now belongs to another process', async () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    const env = {BRANCH_REVIEW_TMPDIR: parent};
    await withLiveProcess((pid) => {
      // The killed session's claim: its pid is live again, as an unrelated
      // process that started after it.
      const killed = createMediaTempDir({env, pid}).get();
      fs.writeFileSync(path.join(killed, 'kitty-tmux'), `${tmuxServerHash(TMUX)}\nps:Thu Jan  1 00:00:00 1970\n`);
      const mine = createMediaTempDir({env}).get();
      // Fixed start times, so no ps call under load decides the outcome.
      const startTime = (each: number) => (each === pid ? 'ps:1767225600' : each === process.pid ? 'ps:1767139200' : null);
      expect(claimKittyTmux(mine, TMUX, {env, startTime})).toBe(true);
      expect(fs.readFileSync(path.join(mine, 'kitty-tmux'), 'utf8')).toBe(`${tmuxServerHash(TMUX)}\nps:1767139200\n`);
    });
  });

  it('still gives way to a live claim whose owner started when it recorded, or whose start cannot be read now', async () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    const env = {BRANCH_REVIEW_TMPDIR: parent};
    await withLiveProcess((pid) => {
      const live = createMediaTempDir({env, pid}).get();
      expect(claimKittyTmux(live, TMUX, {env, pid})).toBe(true);
      const mine = createMediaTempDir({env}).get();
      expect(claimKittyTmux(mine, TMUX, {env})).toBe(false);
      expect(fs.existsSync(path.join(mine, 'kitty-tmux'))).toBe(false);
    });
    // A recorded start that cannot be checked now counts as the same owner.
    const other = createMediaTempDir({env, pid: 999_201}).get();
    fs.writeFileSync(path.join(other, 'kitty-tmux'), `${tmuxServerHash(TMUX)}\nps:Thu Jan  1 00:00:00 1970\n`);
    const next = createMediaTempDir({env, pid: 999_202}).get();
    expect(claimKittyTmux(next, TMUX, {env, pid: 999_202, isGone: (pid) => pid !== 999_201, startTime: () => null})).toBe(false);
  });
});

