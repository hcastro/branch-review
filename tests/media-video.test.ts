import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {openVerifiedVideoFd, writeBlobToFile} from '../src/git.js';
import {createWorkerHandler} from '../src/media/worker/handler.js';
import {createWorkerBackend} from '../src/media/workerClient.js';
import {findTool} from '../src/media/worker/tools.js';
import {parseProbe} from '../src/media/worker/video.js';
import {createRenderer} from '../src/media/worker/render.js';
import type {ExportResult, InspectResult, VideoRequest, VideoResult} from '../src/media/backend.js';
import type {MediaFormat, SideRef} from '../src/media/types.js';
import {cleanupTempDirs, commitAll, fakeMediaTools, git, initRepo, makeTempDir, snapshotTree, writeExecutable} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';

// Video in the media worker: ffprobe and ffmpeg come from PATH, never from
// inside the repo, and read the video only through a verified file
// descriptor or a verified temp copy, with the demuxer forced and every
// protocol but plain files refused. Without them a video shows its size,
// and a hint where its frames would be.

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const recordedPids: number[] = [];
afterEach(() => {
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

// An MP4's first box, as every MP4 and MOV file starts, then filler.
function mp4Bytes(fill = 7) {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp42', 'latin1')]);
  return Buffer.concat([ftyp, Buffer.alloc(200, fill)]);
}

// A WebM's EBML header naming its doc type, then filler.
function webmBytes() {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), Buffer.alloc(200, 3)]);
}

const PROBE = {
  streams: [
    {codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1'},
    {codec_type: 'audio', codec_name: 'aac', channels: 2},
  ],
  format: {duration: '42.000000', size: '4100000', bit_rate: '800000'},
};

const CELL = {w: 10, h: 20};

function videoRequest(cwd: string, side: SideRef, format: MediaFormat = 'mp4', frameCount: 2 | 4 = 4): VideoRequest {
  // Four frames of 12 columns with a 1-column gap: 51 columns, 3 rows.
  const frameCols = 12;
  return {
    cwd,
    side,
    format,
    frameCount,
    framePx: {w: frameCols * CELL.w, h: 3 * CELL.h},
    stripCellPx: CELL,
    stripCols: frameCount * frameCols + (frameCount - 1),
    stripRows: 3,
    gapCols: 1,
  };
}

function worktreeSide(cwd: string, file: string): SideRef {
  const abbrevId = git(cwd, 'hash-object', file).trim().slice(0, 12);
  return {side: 'after', source: 'worktree', path: file, abbrevId, key: `worktree|${file}|${abbrevId}`};
}

function blobSide(cwd: string, file: string, side: 'before' | 'after' = 'after'): SideRef {
  const abbrevId = git(cwd, 'rev-parse', '--short', `HEAD:${file}`).trim();
  return {side, source: 'blob', path: file, abbrevId, key: `blob|${file}|${abbrevId}`};
}

// A handler whose ffprobe and ffmpeg are the fakes, its temp files in a
// fresh session dir.
function handlerWith(tools: {dir: string} | null, options: {probeTimeoutMs?: number; frameTimeoutMs?: number; jobBudgetMs?: number} = {}) {
  const tempDir = makeTempDir('branch-review-media-session-');
  const pathValue = tools ? `${tools.dir}${path.delimiter}/usr/bin${path.delimiter}/bin` : `/usr/bin${path.delimiter}/bin`;
  const handler = createWorkerHandler({video: {env: {...process.env, PATH: pathValue}, tempDir: () => tempDir, platform: 'darwin', ...options}});
  return {handler, tempDir};
}

const videoJob = async (handler: ReturnType<typeof createWorkerHandler>, request: VideoRequest) => await handler.handle({type: 'video', ...request}) as VideoResult;

describe('finding ffprobe and ffmpeg', () => {
  it('takes the first executable on PATH, skipping relative entries and anything inside the repo', () => {
    const cwd = initRepo();
    const planted = path.join(cwd, 'bin');
    fs.mkdirSync(planted);
    writeExecutable(path.join(planted, 'ffprobe'), '#!/bin/sh\nexit 0\n');
    const real = makeTempDir('branch-review-tools-');
    writeExecutable(path.join(real, 'ffprobe'), '#!/bin/sh\nexit 0\n');
    // A relative entry that does name a directory with an ffprobe in it,
    // from where this process runs: it is still skipped, since what it
    // names depends on the directory a program is run from.
    const relative = path.relative(process.cwd(), real);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(fs.existsSync(path.join(relative, 'ffprobe'))).toBe(true);
    const env = {PATH: [planted, relative, real].join(path.delimiter)};
    expect(findTool('ffprobe', env, cwd)).toBe(path.join(fs.realpathSync(real), 'ffprobe'));
    expect(findTool('ffprobe', {PATH: [planted, relative].join(path.delimiter)}, cwd)).toBeNull();
    expect(findTool('ffprobe', {PATH: relative}, cwd)).toBeNull();
    // A planted one through a symlinked PATH entry is still inside the repo.
    const link = path.join(makeTempDir('branch-review-link-'), 'bin');
    fs.symlinkSync(planted, link);
    expect(findTool('ffprobe', {PATH: link}, cwd)).toBeNull();
  });
});

describe('the video job with fake ffprobe and ffmpeg', {timeout: 60_000}, () => {
  it('reads a work tree MP4 through fd 3 with the demuxer forced and only files allowed, never by its repo path', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE, framePng: pngFixture(160, 90, [200, 40, 40, 255])});
    const {handler} = handlerWith(tools);
    const result = await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'clip.mp4')));
    if (!result.ok) throw new Error(result.reason);

    expect(result.meta).toEqual({durationMs: 42_000, width: 1920, height: 1080, codec: 'h264', fps: 30, bitRate: 800_000, audio: 'aac'});
    expect(result.times).toEqual([5250, 15_750, 26_250, 36_750]);
    const calls = tools.calls();
    expect(calls.map((call) => call.tool)).toEqual(['ffprobe', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg']);
    for (const call of calls) {
      const argv = call.argv;
      expect(argv.slice(argv.indexOf('-protocol_whitelist'), argv.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file']);
      expect(argv.slice(argv.indexOf('-enable_drefs'), argv.indexOf('-enable_drefs') + 2)).toEqual(['-enable_drefs', '0']);
      // The demuxer is forced right before the input.
      expect(argv.slice(argv.indexOf('-i') - 2, argv.indexOf('-i') + 2)).toEqual(['-f', 'mov', '-i', 'file:/dev/fd/3']);
      expect(call.fd3Bytes).toBe(mp4Bytes().length);
      for (const arg of argv) {
        expect(arg).not.toContain(cwd);
        expect(arg).not.toContain('clip.mp4');
      }
    }
    // ffprobe has no -nostdin (it never reads stdin, which is closed); every
    // ffmpeg call has it.
    for (const call of calls.filter((each) => each.tool === 'ffmpeg')) {
      expect(call.argv[0]).toBe('-nostdin');
      expect(call.argv).toContain('-ss');
      // One frame, scaled to the frame box's width, as a PNG on stdout.
      expect(call.argv.slice(call.argv.indexOf('-i') + 2)).toEqual(['-frames:v', '1', '-vf', 'scale=120:-2', '-threads', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
    }
    expect(calls.filter((each) => each.tool === 'ffmpeg').map((call) => call.argv[call.argv.indexOf('-ss') + 1])).toEqual(['5.250', '15.750', '26.250', '36.750']);
    // The strip is exactly the box's cell size, one frame per slot.
    const meta = await sharp(result.strip!).metadata();
    expect([meta.width, meta.height]).toEqual([51 * CELL.w, 3 * CELL.h]);
  });

  it('extracts a blob MP4 to a verified temp copy named from its id, reads that, and removes it after', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    commitAll(cwd, 'add clip');
    const before = snapshotTree(cwd);
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE, framePng: pngFixture(160, 90)});
    const {handler, tempDir} = handlerWith(tools);
    const side = blobSide(cwd, 'clip.mp4');
    const oid = git(cwd, 'rev-parse', `HEAD:clip.mp4`).trim();
    const result = await videoJob(handler, videoRequest(cwd, side));
    if (!result.ok) throw new Error(result.reason);

    const calls = tools.calls();
    expect(calls).toHaveLength(5);
    const expectedPath = path.join(tempDir, `${oid.slice(0, 12)}-after.mp4`);
    for (const call of calls) {
      expect(call.argv[call.argv.indexOf('-i') + 1]).toBe(`file:${expectedPath}`);
      // The copy existed while ffprobe and ffmpeg read it.
      expect(call.inputExists).toBe(true);
      expect(call.fd3Bytes).toBeNull();
    }
    expect(fs.existsSync(expectedPath)).toBe(false);
    expect(snapshotTree(cwd)).toEqual(before);
  });

  it('forces the Matroska demuxer for WebM, without the MP4-only drefs option', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.webm'), webmBytes());
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE, framePng: pngFixture(160, 90)});
    const {handler} = handlerWith(tools);
    const result = await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'clip.webm'), 'webm', 2));
    expect(result.ok).toBe(true);
    const calls = tools.calls();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.argv.slice(call.argv.indexOf('-i') - 2, call.argv.indexOf('-i'))).toEqual(['-f', 'matroska']);
      expect(call.argv).not.toContain('-enable_drefs');
    }
  });

  it('refuses a video whose bytes are not the container its name says, running nothing', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), webmBytes());
    fs.writeFileSync(path.join(cwd, 'other.webm'), mp4Bytes());
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE});
    const {handler} = handlerWith(tools);
    expect(await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'clip.mp4')))).toEqual({ok: false, state: 'error', reason: 'not an MP4 video'});
    expect(await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'other.webm'), 'webm'))).toEqual({ok: false, state: 'error', reason: 'not a WebM video'});
    const inspected = await handler.handle({type: 'inspect', cwd, side: worktreeSide(cwd, 'clip.mp4'), kind: 'video', format: 'mp4'}) as InspectResult;
    expect(inspected).toEqual({ok: false, state: 'error', reason: 'not an MP4 video'});
    expect(tools.calls()).toEqual([]);
  });

  it('inspects a video for its size and verified id without running ffprobe or ffmpeg', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    commitAll(cwd, 'add clip');
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes(9));
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE});
    const {handler} = handlerWith(tools);
    const oid = git(cwd, 'rev-parse', 'HEAD:clip.mp4').trim();
    const blob = await handler.handle({type: 'inspect', cwd, side: blobSide(cwd, 'clip.mp4', 'before'), kind: 'video', format: 'mp4'}) as InspectResult;
    expect(blob).toEqual({ok: true, info: {oid, bytes: mp4Bytes().length, format: 'mp4', width: 0, height: 0, frames: 1, hasAlpha: false}});
    const worktree = await handler.handle({type: 'inspect', cwd, side: worktreeSide(cwd, 'clip.mp4'), kind: 'video', format: 'mp4'}) as InspectResult;
    expect(worktree).toMatchObject({ok: true, info: {oid: git(cwd, 'hash-object', 'clip.mp4').trim(), bytes: mp4Bytes().length}});
    expect(tools.calls()).toEqual([]);
  });

  it('says a work tree video changed on disk when its bytes no longer match the id', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    const side = worktreeSide(cwd, 'clip.mp4');
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes(1));
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE});
    const tempDir = makeTempDir('branch-review-media-session-');
    // Written again during the wait before the second read, so the two reads
    // differ: a write in progress.
    const rewriting = createWorkerHandler({video: {
      env: {...process.env, PATH: `${tools.dir}${path.delimiter}/usr/bin${path.delimiter}/bin`},
      tempDir: () => tempDir,
      sleep: async () => fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes(2)),
    }});
    expect(await videoJob(rewriting, videoRequest(cwd, side))).toMatchObject({ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true});
    // The same bytes on both reads: a filter turns them into what git stores.
    const steady = createWorkerHandler({video: {env: {PATH: tools.dir}, tempDir: () => tempDir, sleep: async () => undefined}});
    expect(await videoJob(steady, videoRequest(cwd, side))).toEqual({ok: false, state: 'error', reason: 'preview unavailable: a git filter changes this file (shown as text)'});
    expect(tools.calls()).toEqual([]);
  });

  it('kills an ffprobe that hangs and shows that video without metadata or frames, while the next video still works', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'slow.mp4'), mp4Bytes(1));
    fs.writeFileSync(path.join(cwd, 'fast.mp4'), mp4Bytes(2));
    commitAll(cwd, 'add clips');
    const slowId = git(cwd, 'rev-parse', 'HEAD:slow.mp4').trim();
    // Only the call reading the slow video's temp copy hangs.
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE, framePng: pngFixture(160, 90), hangMs: 30_000, hangWhen: slowId.slice(0, 12)});
    // Long enough for the fake, a Node script, to start and log its call
    // on a loaded machine before it is killed.
    const {handler} = handlerWith(tools, {probeTimeoutMs: 3000, frameTimeoutMs: 3000});
    const started = Date.now();
    const slow = await videoJob(handler, videoRequest(cwd, blobSide(cwd, 'slow.mp4')));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(slow).toMatchObject({ok: true, meta: null, strip: null, note: 'could not read the video (ffprobe timed out)'});
    const hung = tools.calls().find((call) => call.tool === 'ffprobe')!;
    recordedPids.push(hung.pid);
    expect(isAlive(hung.pid)).toBe(false);

    const fast = await videoJob(handler, videoRequest(cwd, blobSide(cwd, 'fast.mp4')));
    expect(fast).toMatchObject({ok: true, meta: {durationMs: 42_000}});
    expect((fast as Extract<VideoResult, {ok: true}>).strip).not.toBeNull();
  });

  it('stops asking for frames after one hangs, drawing the rest as failed tiles within the job\'s deadline', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    // Every frame hangs; ffprobe answers.
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE, framePng: pngFixture(160, 90), hangMs: 30_000, hangWhen: '-ss'});
    const {handler} = handlerWith(tools, {frameTimeoutMs: 3000});
    const result = await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'clip.mp4')));
    if (!result.ok) throw new Error(result.reason);
    expect(result.meta).toMatchObject({durationMs: 42_000});
    expect(result.strip).not.toBeNull();
    const frames = tools.calls().filter((call) => call.tool === 'ffmpeg');
    expect(frames).toHaveLength(1);
    recordedPids.push(frames[0]!.pid);
    expect(isAlive(frames[0]!.pid)).toBe(false);
  });

  it('keeps the whole job inside its budget when every frame is slow but none times out', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    // Each frame takes 1.5 s, well inside its own 10 s timeout, but four of
    // them pass the job's 4 s budget.
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE, framePng: pngFixture(160, 90), hangMs: 1500, hangWhen: '-ss'});
    const {handler} = handlerWith(tools, {frameTimeoutMs: 10_000, jobBudgetMs: 4000});
    const started = Date.now();
    const result = await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'clip.mp4')));
    const elapsed = Date.now() - started;
    const frames = tools.calls().filter((call) => call.tool === 'ffmpeg');
    for (const call of frames) recordedPids.push(call.pid);
    if (!result.ok) throw new Error(result.reason);
    // The frames past the budget are drawn as failed tiles, never asked for.
    expect(result.strip).not.toBeNull();
    expect(frames.length).toBeLessThan(4);
    // The budget, plus drawing the strip on a loaded machine.
    expect(elapsed).toBeLessThan(4000 + 2500);
  });

  it('drops the strip as stale when the work tree file is rewritten while ffmpeg reads it', async () => {
    const cwd = initRepo();
    const file = path.join(cwd, 'clip.mp4');
    fs.writeFileSync(file, mp4Bytes());
    // Saved again, longer, while the last frame is read: every frame before
    // it read the verified bytes, so only the check after the frames sees it.
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {
      probeJson: PROBE,
      framePng: pngFixture(160, 90),
      rewrite: {when: '-ss 36.750', file, bytes: Buffer.concat([mp4Bytes(), Buffer.alloc(16, 1)])},
    });
    const {handler} = handlerWith(tools);
    const result = await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'clip.mp4')));
    expect(tools.calls().filter((call) => call.tool === 'ffmpeg')).toHaveLength(4);
    expect(result).toEqual({ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true});
  });

  it('gives no metadata and a hint in place of frames without ffmpeg on PATH', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    const {handler} = handlerWith(null);
    const result = await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'clip.mp4')));
    expect(result).toEqual({ok: true, meta: null, strip: null, times: [], note: 'frames need ffmpeg · brew install ffmpeg · o plays the file'});
  });

  it('opens a work tree video at its real path, and a committed one from a temp copy', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'old.mp4'), mp4Bytes(4));
    commitAll(cwd, 'add old');
    fs.writeFileSync(path.join(cwd, 'new.mp4'), mp4Bytes(5));
    const {handler, tempDir} = handlerWith(null);
    const worktree = await handler.handle({type: 'exportCopy', cwd, side: worktreeSide(cwd, 'new.mp4'), format: 'mp4', dir: tempDir}) as ExportResult;
    expect(worktree).toEqual({ok: true, path: path.join(cwd, 'new.mp4')});
    const blob = await handler.handle({type: 'exportCopy', cwd, side: blobSide(cwd, 'old.mp4', 'before'), format: 'mp4', dir: tempDir}) as ExportResult;
    expect(blob).toEqual({ok: true, path: path.join(tempDir, 'open-1', 'before.mp4')});
    expect(fs.readFileSync(path.join(tempDir, 'open-1', 'before.mp4'))).toEqual(mp4Bytes(4));
    // A symlink in the work tree is never handed to a player.
    fs.symlinkSync('/etc/hosts', path.join(cwd, 'link.mp4'));
    const linked = await handler.handle({type: 'exportCopy', cwd, side: {...worktreeSide(cwd, 'new.mp4'), path: 'link.mp4'}, format: 'mp4', dir: tempDir}) as ExportResult;
    expect(linked).toMatchObject({ok: false});
  });
});

describe('reading ffprobe\'s answer', () => {
  it('escapes the codec names the file gives and keeps them short', () => {
    const codec = `h264\x1B[31m\u{10EEEE}${'x'.repeat(40)}`;
    const meta = parseProbe(JSON.stringify({
      streams: [
        {codec_type: 'video', codec_name: codec, width: 16, height: 9, avg_frame_rate: '30/1'},
        {codec_type: 'audio', codec_name: `\x1B]52;c;aGk=\x07${'y'.repeat(40)}`},
      ],
      format: {duration: '1.0'},
    }))!;
    for (const text of [meta.codec, meta.audio!]) {
      expect(text.length).toBeLessThanOrEqual(16);
      expect(text).not.toMatch(/[\x00-\x1F\x7F\u{10EEEE}]/u);
    }
    expect(meta.codec.startsWith('h264')).toBe(true);
  });
});

describe('drawing the strip', {timeout: 60_000}, () => {
  it('draws a strip past 4 MiB again smaller, so every transmit stays under the cap', async () => {
    // A wide pane with large cells: four noisy 976 × 549 frames, which do not
    // compress, make a strip PNG of about 6 MB at full size.
    const frameW = 976;
    const frameH = 549;
    const noise = async () => {
      const raw = randomBytes(frameW * frameH * 3);
      return sharp(raw, {raw: {width: frameW, height: frameH, channels: 3}}).png({compressionLevel: 1}).toBuffer();
    };
    const frames = [await noise(), await noise(), await noise(), await noise()];
    const strip = {cols: 249, rows: 17, cellPx: {w: 16, h: 34}, framePx: {w: frameW, h: frameH}, gapCols: 1};

    const result = await createRenderer().videoStrip(frames, strip, false);
    if (!result.ok || !('png' in result)) throw new Error('no strip');
    expect(result.png.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    // The whole canvas shrinks, so the terminal scales it back into the same
    // cells with each frame where its timestamp is.
    const meta = await sharp(result.png).metadata();
    expect(meta.width).toBeLessThan(strip.cols * strip.cellPx.w);
    expect(meta.width! / meta.height!).toBeCloseTo((strip.cols * strip.cellPx.w) / (strip.rows * strip.cellPx.h), 1);
  });
});

describe('the work tree and blob readers behind the video job', {timeout: 30_000}, () => {
  it('opens the verified file again only while it is still that file', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    fs.writeFileSync(path.join(cwd, 'other.mp4'), mp4Bytes());
    const verified = fs.statSync(path.join(cwd, 'clip.mp4'));
    const handle = await openVerifiedVideoFd(cwd, 'clip.mp4', verified);
    await handle.close();
    // Another file, even with the same size and bytes, is not the one hashed.
    await expect(openVerifiedVideoFd(cwd, 'other.mp4', verified)).rejects.toThrow('changed on disk');
    // Nor is the same file once it is written again.
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), Buffer.concat([mp4Bytes(), Buffer.alloc(4)]));
    await expect(openVerifiedVideoFd(cwd, 'clip.mp4', verified)).rejects.toThrow('changed on disk');
  });

  it('removes a blob copy whose bytes are not what its facts name', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    commitAll(cwd, 'add clip');
    const oid = git(cwd, 'rev-parse', 'HEAD:clip.mp4').trim();
    const dir = makeTempDir('branch-review-media-session-');
    const good = path.join(dir, 'good.mp4');
    await writeBlobToFile(cwd, {oid, size: mp4Bytes().length}, good, 'sha1');
    expect(fs.readFileSync(good)).toEqual(mp4Bytes());
    // Shorter and longer than the object: neither copy is kept.
    for (const size of [mp4Bytes().length + 1, mp4Bytes().length - 1]) {
      const dest = path.join(dir, `bad-${size}.mp4`);
      await expect(writeBlobToFile(cwd, {oid, size}, dest, 'sha1')).rejects.toThrow('object bytes do not match their id');
      expect(fs.existsSync(dest)).toBe(false);
    }
  });

  it('fails a blob copy whose write fails with that error, removing the copy, and leaves no rejection unhandled', async () => {
    const cwd = initRepo();
    // Large enough to arrive from git in several chunks.
    const bytes = Buffer.concat([mp4Bytes(), Buffer.alloc(2 * 1024 * 1024, 5)]);
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), bytes);
    commitAll(cwd, 'add clip');
    const oid = git(cwd, 'rev-parse', 'HEAD:clip.mp4').trim();
    const dest = path.join(makeTempDir('branch-review-media-session-'), 'clip.mp4');
    // The temp dir's disk is full: every write fails.
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      if (args[0] === dest) {
        const full = async () => {
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'});
        };
        Object.assign(handle, {write: full, writev: full});
      }
      return handle;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(writeBlobToFile(cwd, {oid, size: bytes.length}, dest, 'sha1')).rejects.toThrow('ENOSPC');
      // Give a stray rejection the turns of the loop it needs to be reported.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('the video job in the real media worker', {timeout: 60_000}, () => {
  it('finds the tools on the worker\'s PATH, extracts into the session dir, and sends the strip back over IPC', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4Bytes());
    commitAll(cwd, 'add clip');
    const tools = fakeMediaTools(makeTempDir('branch-review-fake-tools-'), {probeJson: PROBE, framePng: pngFixture(160, 90)});
    const tempDir = makeTempDir('branch-review-media-session-');
    const backend = createWorkerBackend({tempDir: () => tempDir, env: {...process.env, PATH: `${tools.dir}${path.delimiter}${process.env.PATH ?? ''}`}});
    try {
      const result = await backend.video!(videoRequest(cwd, blobSide(cwd, 'clip.mp4')), new AbortController().signal);
      if (!result.ok) throw new Error(result.reason);
      expect(result.strip).toBeInstanceOf(Uint8Array);
      expect((await sharp(result.strip!).metadata()).width).toBe(51 * CELL.w);
      const oid = git(cwd, 'rev-parse', 'HEAD:clip.mp4').trim();
      for (const call of tools.calls()) expect(call.argv[call.argv.indexOf('-i') + 1]).toBe(`file:${path.join(tempDir, `${oid.slice(0, 12)}-after.mp4`)}`);
      expect(fs.existsSync(path.join(tempDir, `${oid.slice(0, 12)}-after.mp4`))).toBe(false);
    } finally {
      backend.dispose();
    }
  });
});

const SCRIPTED_WORKER = fileURLToPath(new URL('./fixtures/scripted-media-worker.mjs', import.meta.url));

describe('video jobs in the media worker client', {timeout: 30_000}, () => {
  it('sends one video job at a time, so a queued one never waits out its deadline in the worker, and runs other jobs beside it', async () => {
    const cwd = initRepo();
    const tempDir = makeTempDir('branch-review-media-session-');
    const backend = createWorkerBackend({tempDir: () => tempDir, modulePath: SCRIPTED_WORKER, deadlinesMs: {video: 20_000, inspect: 20_000}});
    const ignore = () => undefined;
    const side = (file: string): SideRef => ({side: 'after', source: 'blob', path: file, abbrevId: 'abcdef1', key: `blob|${file}|abcdef1`});
    try {
      const first = backend.video!(videoRequest(cwd, side('answer-1.mp4')), new AbortController().signal);
      void backend.video!(videoRequest(cwd, side('hang-2.mp4')), new AbortController().signal).then(ignore, ignore);
      void backend.inspect({cwd, side: side('hang-3.png'), kind: 'raster', format: 'png'}, new AbortController().signal).then(ignore, ignore);
      const jobs = () => {
        const file = path.join(tempDir, 'scripted.log');
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {event: string; path?: string}).filter((entry) => entry.event === 'job').map((entry) => entry.path);
      };
      // The first video answers; only then does the second go out.
      expect(await first).toEqual({ok: false, state: 'error', reason: 'answered answer-1.mp4'});
      const deadline = Date.now() + 10_000;
      while (jobs().length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(jobs()).toEqual(['answer-1.mp4', 'hang-3.png', 'hang-2.mp4']);
    } finally {
      backend.dispose();
    }
  });
});

const hasFfmpeg = spawnSync('/bin/sh', ['-c', 'command -v ffmpeg && command -v ffprobe'], {encoding: 'utf8'}).status === 0;

describe('the video job with the real ffmpeg', {timeout: 120_000}, () => {
  it.runIf(hasFfmpeg)('reads the metadata and draws four distinct frames of a generated test video', async () => {
    const cwd = initRepo();
    const video = path.join(os.tmpdir(), `branch-review-testsrc-${process.pid}.mp4`);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2', '-pix_fmt', 'yuv420p', '-y', video]);
    fs.copyFileSync(video, path.join(cwd, 'clip.mp4'));
    fs.rmSync(video, {force: true});
    const handler = createWorkerHandler({video: {tempDir: () => makeTempDir('branch-review-media-session-')}});
    const result = await videoJob(handler, videoRequest(cwd, worktreeSide(cwd, 'clip.mp4')));
    if (!result.ok) throw new Error(result.reason);
    expect(result.meta).toMatchObject({durationMs: 2000, width: 320, height: 180, codec: 'h264', fps: 30});
    const {data, info} = await sharp(result.strip!).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    expect([info.width, info.height]).toEqual([510, 60]);
    // testsrc counts up in a corner, so no two frames are the same.
    const frames = [0, 1, 2, 3].map((index) => {
      const left = index * 13 * CELL.w;
      const pixels: number[] = [];
      for (let y = 0; y < info.height; y += 1) for (let x = left; x < left + 12 * CELL.w; x += 1) pixels.push(data[(y * info.width + x) * 4]!);
      return pixels.join(',');
    });
    expect(new Set(frames).size).toBe(4);
  });
});
