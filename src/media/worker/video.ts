import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {escapeHiddenCharacters} from '../../controlChars.js';
import {
  FileTooLargeError,
  MAX_BLOB_VIDEO_BYTES,
  MAX_WORKTREE_VIDEO_BYTES,
  blobFactsOperation,
  hashWorktreeFile,
  objectFormatOperation,
  openVerifiedVideoFd,
  openWorktreeFile,
  readBlobHead,
  runOperationAsync,
  sameFileState,
  writeBlobToFile,
  type ObjectFormat,
} from '../../git.js';
import type {ExportResult, InspectRequest, InspectResult, JobFailure, VideoRequest, VideoResult} from '../backend.js';
import {formatLabel} from '../layout.js';
import {createLru} from '../lru.js';
import type {MediaFormat, SideRef, VideoMeta} from '../types.js';
import {FILTER_REASON, STALE_REASON} from './read.js';
import type {Renderer} from './render.js';
import {createToolFinder, searchDirs} from './tools.js';

// Video for the media worker: metadata from ffprobe and a strip of frames
// from ffmpeg, both found on PATH outside the repo and optional. A repo file
// must never steer them, so the container comes from the file's magic
// bytes and is forced with `-f` (no playlist or concat tricks), only plain
// files may be opened, MP4 data references are off, and the input is never
// the repo path: a work tree video goes in as a descriptor of the file whose
// hash was verified, a committed one as a verified temp copy named from its
// id. Each call has a deadline and is killed past it; one ffmpeg runs at a
// time.

const PROBE_TIMEOUT_MS = 5_000;
const FRAME_TIMEOUT_MS = 8_000;
// The client kills a video job at 30 s, and the calls' own timeouts add up
// past that (5 s, then 8 s for each of four frames) with no single call
// timing out. So the job keeps a budget of its own, counted from its start:
// each call gets at most the time left, and frames past it are drawn as
// failed. The rest of the 30 s is for drawing the strip and the answer.
const JOB_BUDGET_MS = 25_000;
const PROBE_STDOUT_BYTES = 1024 * 1024;
const FRAME_STDOUT_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 48 * 1024 * 1024;
const REREAD_DELAY_MS = 500;
const MAX_TEXT = 16;
// A work tree file that is no longer the one checked, as an open says it.
const CHANGED_REASON = 'the file changed on disk';
// `stream_side_data=rotation` is the display matrix's rotation, side data
// rather than a tag: tags are never requested.
const PROBE_FIELDS = 'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,channels:stream_side_data=rotation';

type Container = 'mov' | 'matroska';

const VIDEO_EXTENSIONS: Partial<Record<MediaFormat, string>> = {mp4: 'mp4', mov: 'mov', webm: 'webm'};

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/** The demuxer for a video's bytes, when they are the container its name says. */
export function containerFor(head: Uint8Array, format: MediaFormat): Container | null {
  if (format === 'mp4' || format === 'mov') {
    if (head.length < 12 || ascii(head, 4, 4) !== 'ftyp') return null;
    // An AVIF still starts with `ftyp` too.
    const brand = ascii(head, 8, 4);
    return brand === 'avif' || brand === 'avis' ? null : 'mov';
  }
  if (format === 'webm') {
    if (head.length < 4 || head[0] !== 0x1a || head[1] !== 0x45 || head[2] !== 0xdf || head[3] !== 0xa3) return null;
    const header = ascii(head, 4, Math.min(64, head.length - 4));
    return header.includes('webm') || header.includes('matroska') ? 'matroska' : null;
  }
  return null;
}

/** What a video whose bytes are not the container its name says reads. */
export function notVideoReason(format: MediaFormat) {
  return `not ${format === 'mp4' ? 'an' : 'a'} ${formatLabel(format)} video`;
}

// Text from ffprobe is the file's own: escaped, and short.
function cleanText(value: unknown) {
  if (typeof value !== 'string') return '';
  return escapeHiddenCharacters(value).slice(0, MAX_TEXT);
}

function count(value: unknown) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined;
}

function frameRate(value: unknown) {
  if (typeof value !== 'string') return 0;
  const [top, bottom] = value.split('/').map(Number);
  const rate = bottom ? top! / bottom : top!;
  return Number.isFinite(rate) && rate >= 0 ? rate : 0;
}

/** ffprobe's JSON as metadata, every number checked; null without a video stream. */
export function parseProbe(json: string): VideoMeta | null {
  let parsed: {streams?: Array<Record<string, unknown>>; format?: Record<string, unknown>};
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (!video) return null;
  const audio = streams.find((stream) => stream?.codec_type === 'audio');
  const seconds = count(parsed.format?.duration) ?? 0;
  const bitRate = count(parsed.format?.bit_rate);
  const coded = {width: Math.round(count(video.width) ?? 0), height: Math.round(count(video.height) ?? 0)};
  // A display matrix turning the picture a quarter shows it with width and
  // height swapped, as players and ffmpeg's own frames do.
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list as Array<Record<string, unknown>> : [];
  const rotation = sideData.map((entry) => (typeof entry?.rotation === 'number' ? entry.rotation : typeof entry?.rotation === 'string' ? Number(entry.rotation) : NaN)).find(Number.isFinite);
  const quarterTurn = rotation !== undefined && Math.abs(Math.round(rotation)) % 180 === 90;
  return {
    durationMs: Math.round(seconds * 1000),
    width: quarterTurn ? coded.height : coded.width,
    height: quarterTurn ? coded.width : coded.height,
    codec: cleanText(video.codec_name),
    fps: frameRate(video.avg_frame_rate),
    ...(bitRate === undefined ? {} : {bitRate: Math.round(bitRate)}),
    ...(audio ? {audio: cleanText(audio.codec_name)} : {}),
  };
}

// `opened: false`: the verified file could not be opened again, so the tool
// never ran. `machine: true`: the tool failed to start or to load its
// libraries, a fact about this machine that says nothing about the file.
type ToolRun = {ok: true; stdout: Buffer} | {ok: false; reason: string; opened?: false; machine?: true};

// The only variables ffprobe and ffmpeg see. Everything else is dropped:
// FFREPORT would make ffmpeg write a log file into its cwd, and AV_LOG_FORCE_*
// and FFMPEG_* change what it does. The loader paths stay, since some ffmpeg
// installs (a self-built prefix, an environment module) find their libav*
// libraries only through them, but only their entries findTool would search:
// absolute and outside the repo, so a library the work tree holds never loads.
const TOOL_ENV_KEYS = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;
const LOADER_PATH_KEYS = ['LD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH'] as const;

// What a tool that could not load prints: the Linux loader's message, or
// dyld's on macOS.
const LOAD_FAILURE = /error while loading shared libraries|Library not loaded|^dyld(\[\d+\])?:/m;

function toolEnv(env: NodeJS.ProcessEnv, repoRoot: string): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const key of TOOL_ENV_KEYS) {
    if (env[key] !== undefined) kept[key] = env[key];
  }
  for (const key of LOADER_PATH_KEYS) {
    const dirs = searchDirs(env[key], repoRoot);
    if (dirs.length > 0) kept[key] = dirs.join(path.delimiter);
  }
  return kept;
}

// Where the tools run: the worker's temp dir in the session dir, so nothing
// they write lands in the repo, which is the worker's own cwd. The OS temp
// dir when the worker runs outside a session (forked directly in tests).
function toolCwd(env: NodeJS.ProcessEnv) {
  const session = env.BRANCH_REVIEW_MEDIA_TMP || process.env.BRANCH_REVIEW_MEDIA_TMP;
  const dir = session ? path.join(session, 'worker') : '';
  return dir && path.isAbsolute(dir) && fs.existsSync(dir) ? dir : os.tmpdir();
}

// One ffprobe or ffmpeg call: an argument array, no shell, stdin closed,
// the input descriptor (if any) as fd 3, killed at its deadline or when its
// output passes the cap.
function runTool(command: string, args: string[], {fd, timeoutMs, maxStdout, env, repoRoot}: {fd?: number; timeoutMs: number; maxStdout: number; env: NodeJS.ProcessEnv; repoRoot: string}): Promise<ToolRun> {
  return new Promise((resolve) => {
    const name = path.basename(command);
    const stdio: Array<'ignore' | 'pipe' | number> = ['ignore', 'pipe', 'pipe'];
    if (fd !== undefined) stdio.push(fd);
    let child;
    try {
      child = spawn(command, args, {stdio, env: toolEnv(env, repoRoot), cwd: toolCwd(env)});
    } catch (error) {
      resolve({ok: false, reason: `${name} failed to start (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`, machine: true});
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = '';
    let failure: string | null = null;
    let startFailed = false;
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(`${name} timed out`), timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxStdout) stop(`${name} output is too large`);
      else chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2048);
    });
    child.on('error', (error) => {
      if (failure === null) startFailed = true;
      failure ??= `${name} failed to start (${error.message.split('\n')[0]})`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) resolve({ok: false, reason: failure, ...(startFailed ? {machine: true as const} : {})});
      else if (code !== 0) {
        // 126 and 127: the shell's codes for a program that could not run.
        const machine = code === 126 || code === 127 || LOAD_FAILURE.test(stderr);
        resolve({ok: false, reason: `${name} failed (${escapeHiddenCharacters(stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? `exit code ${code}`).slice(0, 120)})`, ...(machine ? {machine: true as const} : {})});
      }
      else resolve({ok: true, stdout: Buffer.concat(chunks, total)});
    });
  });
}

function reasonOf(error: unknown) {
  return escapeHiddenCharacters((error instanceof Error ? error.message : String(error)).split('\n')[0] || 'could not read the file');
}

// Where the bytes for ffprobe and ffmpeg come from: `arg` is the input
// argument, `open` gives each call its descriptor, `done` checks the file
// is still the one verified, `cleanup` removes a temp copy.
type VideoInput = {
  arg: string;
  container: Container;
  oid: string;
  bytes: number;
  open?: () => Promise<fs.promises.FileHandle>;
  done(): Promise<boolean>;
  cleanup(): Promise<void>;
};

export type VideoOptions = {
  env?: NodeJS.ProcessEnv;
  // The session's media temp dir, for committed videos copied out of git.
  tempDir?: () => string;
  probeTimeoutMs?: number;
  frameTimeoutMs?: number;
  jobBudgetMs?: number;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
};

export function createVideoRunner(renderer: Renderer, {
  env = process.env,
  tempDir = () => process.env.BRANCH_REVIEW_MEDIA_TMP ?? os.tmpdir(),
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  frameTimeoutMs = FRAME_TIMEOUT_MS,
  jobBudgetMs = JOB_BUDGET_MS,
  platform = process.platform,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: VideoOptions = {}) {
  const tools = createToolFinder(env);
  const formats = new Map<string, Promise<ObjectFormat>>();
  // Results by side key (which names the content), frame count and strip
  // geometry; probes by side key alone.
  const results = createLru<Extract<VideoResult, {ok: true}>>(CACHE_BYTES, (result) => (result.strip?.byteLength ?? 0) + (result.cells?.byteLength ?? 0) + 256);
  const probes = new Map<string, VideoMeta | null>();
  // Verified work tree files by side key: what hashing found, and the file
  // state it found it in. The same file in the same state is not hashed
  // again: inspect hashes it, and the strip job after it need not.
  const verifiedFiles = new Map<string, {oid: string; head: Buffer; stat: fs.Stats}>();
  // Video jobs one at a time, so one ffmpeg runs at a time and two jobs
  // never extract the same blob at once. The client sends one at a time,
  // so a job never waits here with its deadline running; inspects and
  // exports never wait behind one.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };

  const formatFor = (cwd: string) => {
    let format = formats.get(cwd);
    if (!format) {
      format = runOperationAsync(objectFormatOperation(cwd));
      formats.set(cwd, format);
      format.catch(() => formats.delete(cwd));
    }
    return format;
  };

  const ffmpegHint = `frames need ffmpeg · ${platform === 'darwin' ? 'brew install ffmpeg' : 'install ffmpeg'} · o plays the file`;

  // A work tree video hashed whole and checked against its id; a mismatch
  // is read again once, as for images, to tell a write in progress from a
  // filter.
  async function verifyWorktree(cwd: string, side: SideRef): Promise<{ok: true; oid: string; head: Buffer; stat: fs.Stats} | JobFailure> {
    try {
      const known = verifiedFiles.get(side.key);
      if (known) {
        const {handle, stat} = await openWorktreeFile(cwd, side.path);
        await handle.close();
        if (sameFileState(stat, known.stat)) return {ok: true, ...known};
        verifiedFiles.delete(side.key);
      }
      const format = await formatFor(cwd);
      const first = await hashWorktreeFile(cwd, side.path, format, MAX_WORKTREE_VIDEO_BYTES);
      if (first.oid.startsWith(side.abbrevId)) {
        verifiedFiles.set(side.key, first);
        return {ok: true, ...first};
      }
      await sleep(REREAD_DELAY_MS);
      const again = await hashWorktreeFile(cwd, side.path, format, MAX_WORKTREE_VIDEO_BYTES);
      if (again.oid.startsWith(side.abbrevId)) {
        verifiedFiles.set(side.key, again);
        return {ok: true, ...again};
      }
      // A filter is a verdict on the file as it is on disk, not on the
      // content the id names: asked again on the next review.
      return again.oid === first.oid
        ? {ok: false, state: 'error', reason: FILTER_REASON, disk: true, filter: true}
        : {ok: false, state: 'stale', reason: STALE_REASON, disk: true};
    } catch (error) {
      if (error instanceof FileTooLargeError) return {ok: false, state: 'error', reason: reasonOf(error)};
      return {ok: false, state: 'error', reason: reasonOf(error), disk: true};
    }
  }

  async function blobFacts(cwd: string, side: SideRef) {
    return runOperationAsync(blobFactsOperation(cwd, side.abbrevId));
  }

  async function inspect(request: InspectRequest): Promise<InspectResult> {
    const {cwd, side, format} = request;
    const still = {format, width: 0, height: 0, frames: 1, hasAlpha: false};
    if (side.source === 'worktree') {
      const verified = await verifyWorktree(cwd, side);
      if (!verified.ok) return verified;
      if (!containerFor(verified.head, format)) return {ok: false, state: 'error', reason: notVideoReason(format)};
      return {ok: true, info: {oid: verified.oid, bytes: verified.stat.size, ...still}};
    }
    try {
      const facts = await blobFacts(cwd, side);
      if (!containerFor(await readBlobHead(cwd, facts.oid), format)) return {ok: false, state: 'error', reason: notVideoReason(format)};
      return {ok: true, info: {oid: facts.oid, bytes: facts.size, ...still}};
    } catch (error) {
      return {ok: false, state: 'error', reason: reasonOf(error)};
    }
  }

  async function openInput(request: VideoRequest): Promise<VideoInput | JobFailure> {
    const {cwd, side, format} = request;
    if (side.source === 'worktree') {
      const verified = await verifyWorktree(cwd, side);
      if (!verified.ok) return verified;
      const container = containerFor(verified.head, format);
      if (!container) return {ok: false, state: 'error', reason: notVideoReason(format)};
      return {
        arg: 'file:/dev/fd/3',
        container,
        oid: verified.oid,
        bytes: verified.stat.size,
        open: () => openVerifiedVideoFd(cwd, side.path, verified.stat),
        async done() {
          // Still the file that was hashed, so what was drawn is its content.
          try {
            const {handle, stat} = await openWorktreeFile(cwd, side.path);
            await handle.close();
            return sameFileState(stat, verified.stat);
          } catch {
            return false;
          }
        },
        cleanup: async () => undefined,
      };
    }

    let facts: {oid: string; size: number};
    try {
      facts = await blobFacts(cwd, side);
    } catch (error) {
      return {ok: false, state: 'error', reason: reasonOf(error)};
    }
    if (facts.size > MAX_BLOB_VIDEO_BYTES) return {ok: false, state: 'error', reason: 'too large to preview'};
    const extension = VIDEO_EXTENSIONS[format];
    if (!extension) return {ok: false, state: 'error', reason: notVideoReason(format)};
    // Named from the id and an extension from the allow list, never from
    // the repo.
    const dest = path.join(tempDir(), `${facts.oid.slice(0, 12)}-${side.side}.${extension}`);
    try {
      await fs.promises.rm(dest, {force: true});
      await writeBlobToFile(cwd, facts, dest, await formatFor(cwd));
    } catch (error) {
      return {ok: false, state: 'error', reason: reasonOf(error)};
    }
    const cleanup = () => fs.promises.rm(dest, {force: true});
    const head = Buffer.alloc(64);
    const handle = await fs.promises.open(dest, 'r');
    await handle.read(head, 0, head.length, 0).finally(() => handle.close());
    const container = containerFor(head, format);
    if (!container) {
      await cleanup();
      return {ok: false, state: 'error', reason: notVideoReason(format)};
    }
    return {arg: `file:${dest}`, container, oid: facts.oid, bytes: facts.size, done: async () => true, cleanup};
  }

  // The options every call starts with: no stdin reads (ffmpeg), no banner,
  // only plain files, no MP4 data references, then the forced demuxer
  // right before the input.
  const common = (input: VideoInput) => ['-hide_banner', '-v', 'error', '-protocol_whitelist', 'file', ...(input.container === 'mov' ? ['-enable_drefs', '0'] : [])];

  async function callWith(input: VideoInput, repoRoot: string, command: string, args: string[], timeoutMs: number, maxStdout: number): Promise<ToolRun> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      if (input.open) handle = await input.open();
    } catch (error) {
      return {ok: false, reason: reasonOf(error), opened: false};
    }
    try {
      return await runTool(command, args, {fd: handle?.fd, timeoutMs, maxStdout, env, repoRoot});
    } finally {
      await handle?.close();
    }
  }

  async function probe(input: VideoInput, repoRoot: string, ffprobe: string, timeoutMs: number): Promise<{meta: VideoMeta | null; reason?: string; opened?: false; machine?: true}> {
    const args = [...common(input), '-show_entries', PROBE_FIELDS, '-of', 'json', '-f', input.container, '-i', input.arg];
    const run = await callWith(input, repoRoot, ffprobe, args, timeoutMs, PROBE_STDOUT_BYTES);
    if (!run.ok) return {meta: null, reason: run.reason, ...(run.opened === false ? {opened: false as const} : {}), ...(run.machine ? {machine: true as const} : {})};
    const meta = parseProbe(run.stdout.toString('utf8'));
    return meta ? {meta} : {meta: null, reason: 'no video stream'};
  }

  async function frame(input: VideoInput, repoRoot: string, ffmpeg: string, atMs: number, width: number, timeoutMs: number): Promise<{png: Buffer | null; timedOut: boolean}> {
    const args = [
      '-nostdin', ...common(input),
      '-ss', (atMs / 1000).toFixed(3),
      '-f', input.container, '-i', input.arg,
      '-frames:v', '1', '-vf', `scale=${Math.max(2, Math.round(width))}:-2`, '-threads', '1',
      '-f', 'image2pipe', '-c:v', 'png', 'pipe:1',
    ];
    const run = await callWith(input, repoRoot, ffmpeg, args, timeoutMs, FRAME_STDOUT_BYTES);
    if (!run.ok) return {png: null, timedOut: run.reason.endsWith('timed out')};
    return {png: run.stdout.length > 0 ? run.stdout : null, timedOut: false};
  }

  async function video(request: VideoRequest): Promise<VideoResult> {
    const cacheKey = [request.side.key, request.frameCount, `${request.framePx.w}x${request.framePx.h}`, `${request.stripCols}x${request.stripRows}`, `${request.stripCellPx.w}x${request.stripCellPx.h}`, request.blocks ? 'blocks' : 'png'].join('|');
    const cached = results.get(cacheKey);
    if (cached) return cached;
    const started = Date.now();
    const timeLeft = () => started + jobBudgetMs - Date.now();

    // Homebrew and Linux packages ship the two together; with either one
    // missing the table keeps the size and the strip says what to install.
    const {ffprobe, ffmpeg} = tools(request.cwd);
    if (!ffprobe || !ffmpeg) return {ok: true, meta: null, strip: null, times: [], note: ffmpegHint};

    const input = await openInput(request);
    if ('ok' in input) return input;
    try {

      let meta = probes.get(request.side.key);
      let probeReason: string | undefined;
      if (meta === undefined) {
        const probed = await probe(input, request.cwd, ffprobe, Math.max(1, Math.min(probeTimeoutMs, timeLeft())));
        meta = probed.meta;
        probeReason = probed.reason;
        if (!meta) {
          // A failure is a fact about the content only when ffprobe read the
          // verified file and the file is still that file: one that changed
          // on disk is asked again on the next review.
          if (probed.opened === false || !(await input.done())) return {ok: false, state: 'stale', reason: STALE_REASON, disk: true};
          // A timeout may be the machine's load, and a tool that could not
          // start or load is the machine's setup, not the file: both asked
          // again next time.
          if (!probed.reason?.endsWith('timed out') && !probed.machine) probes.set(request.side.key, null);
        } else {
          probes.set(request.side.key, meta);
        }
      }
      if (!meta || meta.durationMs <= 0) {
        return {ok: true, meta, strip: null, times: [], note: `could not read the video (${probeReason ?? 'no duration'})`};
      }

      const times = Array.from({length: request.frameCount}, (_, index) => Math.round((meta!.durationMs * (index + 0.5)) / request.frameCount));
      const frames: Array<Buffer | null> = [];
      let gaveUp = false;
      for (const at of times) {
        // A frame that hung means the rest would too, and frames past the
        // budget would miss the job's deadline: they are drawn as failed.
        const left = timeLeft();
        if (gaveUp || left <= 0) {
          frames.push(null);
          continue;
        }
        const drawn = await frame(input, request.cwd, ffmpeg, at, request.framePx.w, Math.min(frameTimeoutMs, left));
        if (drawn.timedOut) gaveUp = true;
        frames.push(drawn.png);
      }

      const strip = await renderer.videoStrip(frames, {
        cols: request.stripCols,
        rows: request.stripRows,
        cellPx: request.stripCellPx,
        framePx: request.framePx,
        gapCols: request.gapCols,
      }, Boolean(request.blocks));
      if (!(await input.done())) return {ok: false, state: 'stale', reason: STALE_REASON, disk: true};
      if (!strip.ok) return {ok: true, meta, strip: null, times, note: strip.reason};
      const result = 'cells' in strip
        ? {ok: true as const, meta, strip: null, cells: strip.cells, times}
        : {ok: true as const, meta, strip: strip.png, times};
      results.set(cacheKey, result);
      return result;
    } finally {
      await input.cleanup();
    }
  }

  // A work tree video copied out of the verified file into `dir()`, for a
  // player that must not be handed the repo path. The copy is the bytes that
  // hashed to the id: the descriptor is the verified file, and its size and
  // modification time must not change while it is read.
  async function copyWorktreeVideo(cwd: string, side: SideRef, format: MediaFormat, extension: string, dir: () => string): Promise<ExportResult> {
    try {
      const {handle, stat} = await openWorktreeFile(cwd, side.path);
      await handle.close();
      if (stat.size > MAX_BLOB_VIDEO_BYTES) return {ok: false, state: 'error', reason: `too large to open safely (over ${Math.floor(MAX_BLOB_VIDEO_BYTES / (1024 * 1024))} MB)`};
    } catch (error) {
      return {ok: false, state: 'error', reason: reasonOf(error), disk: true};
    }
    const verified = await verifyWorktree(cwd, side);
    if (!verified.ok) return verified;
    if (!containerFor(verified.head, format)) return {ok: false, state: 'error', reason: notVideoReason(format)};
    if (verified.stat.size > MAX_BLOB_VIDEO_BYTES) return {ok: false, state: 'error', reason: `too large to open safely (over ${Math.floor(MAX_BLOB_VIDEO_BYTES / (1024 * 1024))} MB)`};
    let source: fs.promises.FileHandle;
    try {
      source = await openVerifiedVideoFd(cwd, side.path, verified.stat);
    } catch {
      return {ok: false, state: 'stale', reason: CHANGED_REASON, disk: true};
    }
    // Named from the id and an extension from the allow list.
    const target = path.join(dir(), `${verified.oid.slice(0, 12)}-${side.side}.${extension}`);
    let out: fs.promises.FileHandle | undefined;
    try {
      // Read-only, as every copy a viewer gets.
      out = await fs.promises.open(target, 'wx', 0o400);
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < verified.stat.size) {
        const {bytesRead} = await source.read(chunk, 0, Math.min(chunk.length, verified.stat.size - position), position);
        if (bytesRead === 0) break;
        await out.write(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await source.stat();
      if (position !== verified.stat.size || after.size !== verified.stat.size || after.mtimeMs !== verified.stat.mtimeMs) {
        throw new Error(CHANGED_REASON);
      }
      await out.close();
      out = undefined;
      return {ok: true, path: target};
    } catch (error) {
      await out?.close().catch(() => undefined);
      await fs.promises.rm(target, {force: true});
      const changed = error instanceof Error && error.message === CHANGED_REASON;
      return changed ? {ok: false, state: 'stale', reason: CHANGED_REASON, disk: true} : {ok: false, state: 'error', reason: reasonOf(error)};
    } finally {
      await source.close();
    }
  }

  /**
   * The file a player opens. A work tree video is the file itself, after the
   * regular file and container checks, with the dev and ino checked (players
   * never write, and copying gigabytes would be slow), or with `copy` a
   * verified copy; a committed one is always a verified copy in `dir`.
   */
  async function exportCopy(request: {cwd: string; side: SideRef; format: MediaFormat; copy?: true}, dir: () => string): Promise<ExportResult> {
    const {cwd, side, format} = request;
    const extension = VIDEO_EXTENSIONS[format];
    if (!extension) return {ok: false, state: 'error', reason: 'cannot open this file type'};
    if (side.source === 'worktree') {
      if (request.copy) return copyWorktreeVideo(cwd, side, format, extension, dir);
      try {
        const {handle, absolutePath} = await openWorktreeFile(cwd, side.path);
        const head = Buffer.alloc(64);
        let opened: fs.Stats;
        try {
          await handle.read(head, 0, head.length, 0);
          opened = await handle.stat();
        } finally {
          await handle.close();
        }
        if (!containerFor(head, format)) return {ok: false, state: 'error', reason: notVideoReason(format)};
        return {ok: true, path: absolutePath, dev: opened.dev, ino: opened.ino};
      } catch (error) {
        return {ok: false, state: 'error', reason: reasonOf(error), disk: true};
      }
    }
    try {
      const facts = await blobFacts(cwd, side);
      if (facts.size > MAX_BLOB_VIDEO_BYTES) return {ok: false, state: 'error', reason: 'too large to open'};
      if (!containerFor(await readBlobHead(cwd, facts.oid), format)) return {ok: false, state: 'error', reason: notVideoReason(format)};
      const target = path.join(dir(), `${side.side}.${extension}`);
      await writeBlobToFile(cwd, facts, target, await formatFor(cwd));
      // Read-only, as every copy a viewer gets.
      await fs.promises.chmod(target, 0o400);
      return {ok: true, path: target};
    } catch (error) {
      return {ok: false, state: 'error', reason: reasonOf(error)};
    }
  }

  return {
    inspect,
    video: (request: VideoRequest) => serial(() => video(request)),
    exportCopy,
  };
}

export type VideoRunner = ReturnType<typeof createVideoRunner>;
