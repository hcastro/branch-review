import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {afterEach, describe, expect, it} from 'vitest';
import {createWorkerBackend} from '../src/media/workerClient.js';
import {createWorkerHandler} from '../src/media/worker/handler.js';
import {createSideReader} from '../src/media/worker/read.js';
import {sniffImage} from '../src/media/worker/sniff.js';
import {fitBox, planMedia} from '../src/media/layout.js';
import type {ReviewFile, ReviewModel} from '../src/review/model.js';
import {createMediaService} from '../src/media/service.js';
import type {MediaBackend, RenderRequest} from '../src/media/backend.js';
import type {MediaFormat, SideRef} from '../src/media/types.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir} from './core-helpers.js';
import {KITTY_CAPS, parseApc, pngFixture, pngHeaderOnly} from './media-helpers.js';
import {binaryMediaFile, buildFixture, frameLines, gutter, renderFixture} from './ui-fixtures.js';

// The media worker: a separate process that reads, verifies, sniffs and
// decodes untrusted image bytes, so a crash or a hang there never takes the
// terminal down with it.

const backends: MediaBackend[] = [];
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
  cleanupTempDirs();
});

const CELL = {w: 10, h: 20};

function backendFor(options: Partial<Parameters<typeof createWorkerBackend>[0]> = {}) {
  const tempDir = makeTempDir('branch-review-media-test-');
  const backend = createWorkerBackend({tempDir: () => tempDir, ...options});
  backends.push(backend);
  return {backend, tempDir};
}

function blobSide(cwd: string, file: string): SideRef {
  const abbrevId = git(cwd, 'rev-parse', '--short', `HEAD:${file}`).trim();
  return {side: 'after', source: 'blob', path: file, abbrevId, key: `blob|${file}|${abbrevId}`};
}

function fitRequest(cwd: string, side: SideRef, px: {w: number; h: number}, maxCols = 60, maxRows = 20): RenderRequest {
  const box = fitBox(px, maxCols, maxRows, KITTY_CAPS);
  return {cwd, op: 'fit', sides: [side], kind: 'raster', checker: false, target: {cols: box.cols, rows: box.rows, cellPx: CELL, drawPx: box.drawPx, nearest: box.nearest}};
}

const never = new AbortController().signal;

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function encoded(format: MediaFormat, width: number, height: number) {
  const base = sharp({create: {width, height, channels: 4, background: {r: 30, g: 120, b: 200, alpha: 1}}});
  if (format === 'png') return base.png().toBuffer();
  if (format === 'jpeg') return base.jpeg().toBuffer();
  if (format === 'webp') return base.webp().toBuffer();
  if (format === 'avif') return base.avif().toBuffer();
  const red = await sharp({create: {width, height, channels: 4, background: '#ff0000'}}).png().toBuffer();
  const green = await sharp({create: {width, height, channels: 4, background: '#00ff00'}}).png().toBuffer();
  return sharp([red, green], {join: {animated: true}}).gif({delay: [100, 100]}).toBuffer();
}

describe('sniffing image headers', () => {
  it('reads the size, frames and alpha of each format without decoding', async () => {
    expect(sniffImage(await encoded('png', 120, 80), 'png')).toEqual({ok: true, format: 'png', width: 120, height: 80, frames: 1, hasAlpha: true});
    expect(sniffImage(await encoded('jpeg', 64, 33), 'jpeg')).toMatchObject({ok: true, width: 64, height: 33, hasAlpha: false});
    expect(sniffImage(await encoded('webp', 50, 70), 'webp')).toMatchObject({ok: true, width: 50, height: 70});
    expect(sniffImage(await sharp({create: {width: 9, height: 4, channels: 4, background: '#ffffff'}}).webp({lossless: true}).toBuffer(), 'webp')).toMatchObject({ok: true, width: 9, height: 4});
    expect(sniffImage(await encoded('avif', 48, 30), 'avif')).toMatchObject({ok: true, width: 48, height: 30});
    expect(sniffImage(await encoded('gif', 16, 12), 'gif')).toMatchObject({ok: true, width: 16, height: 12, frames: 2});
  });

  it('refuses bytes whose magic does not match the extension', async () => {
    expect(sniffImage(await encoded('jpeg', 8, 8), 'png')).toEqual({ok: false, reason: 'not a PNG image'});
    expect(sniffImage(Buffer.from('version https://git-lfs.github.com/spec/v1\n'), 'gif')).toEqual({ok: false, reason: 'not a GIF image'});
  });

  it('refuses a giant size from the header before any decode', () => {
    expect(sniffImage(pngHeaderOnly(100_000, 100_000), 'png')).toEqual({ok: false, reason: 'image too large to preview (100000 × 100000)'});
    expect(sniffImage(pngHeaderOnly(10_000, 10_000), 'png')).toEqual({ok: false, reason: 'image too large to preview (10000 × 10000)'});
  });
});

describe('the real media worker', {timeout: 60_000}, () => {
  it('inspects and renders PNG, JPEG, WebP, AVIF and a GIF\'s first frame at the padded cell size', async () => {
    const cwd = initRepo();
    const sizes: Record<string, [MediaFormat, number, number]> = {
      'a.png': ['png', 300, 120],
      'b.jpg': ['jpeg', 200, 200],
      'c.webp': ['webp', 90, 160],
      'd.avif': ['avif', 128, 64],
      'e.gif': ['gif', 40, 30],
    };
    for (const [file, [format, width, height]] of Object.entries(sizes)) {
      fs.writeFileSync(path.join(cwd, file), await encoded(format, width, height));
    }
    commitAll(cwd, 'add images');
    const {backend} = backendFor();

    for (const [file, [format, width, height]] of Object.entries(sizes)) {
      const side = blobSide(cwd, file);
      const info = await backend.inspect({cwd, side, kind: 'raster', format}, never);
      expect(info, file).toMatchObject({ok: true, info: {format, width, height}});

      const request = fitRequest(cwd, side, {w: width, h: height});
      const result = await backend.render(request, never);
      expect(result, file).toMatchObject({ok: true});
      if (!result.ok || !('png' in result)) throw new Error(`${file}: no png`);
      const meta = await sharp(result.png).metadata();
      expect(meta.format, file).toBe('png');
      expect([meta.width, meta.height], file).toEqual([request.target.cols * CELL.w, request.target.rows * CELL.h]);
      if (format === 'gif') {
        // Red is the first frame; the picture sits centred in the padding.
        const {data, info: raw} = await sharp(result.png).raw().toBuffer({resolveWithObject: true});
        const centre = ((raw.height >> 1) * raw.width + (raw.width >> 1)) * raw.channels;
        expect([...data.subarray(centre, centre + 4)]).toEqual([255, 0, 0, 255]);
        // Near the bottom of the drawn picture: still red. Both frames
        // stacked and squashed into the box would put the green one here.
        const top = Math.floor((raw.height - request.target.drawPx.h) / 2);
        const low = ((top + request.target.drawPx.h - 2) * raw.width + (raw.width >> 1)) * raw.channels;
        expect([...data.subarray(low, low + 4)]).toEqual([255, 0, 0, 255]);
      }
    }
  });

  it('upscales a tiny icon with nearest neighbour, keeping hard edges', async () => {
    const cwd = initRepo();
    // 4 × 4 checks of black and white.
    fs.writeFileSync(path.join(cwd, 'tiny.png'), pngFixture(4, 4, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])));
    commitAll(cwd, 'add tiny');
    const {backend} = backendFor();
    const request = fitRequest(cwd, blobSide(cwd, 'tiny.png'), {w: 4, h: 4});
    expect(request.target.nearest).toBe(true);
    const factor = request.target.drawPx.w / 4;
    expect(factor).toBeGreaterThan(1);

    const result = await backend.render(request, never);
    if (!result.ok || !('png' in result)) throw new Error('no png');
    const {data, info} = await sharp(result.png).raw().toBuffer({resolveWithObject: true});
    const left = Math.floor((info.width - request.target.drawPx.w) / 2);
    const top = Math.floor((info.height - request.target.drawPx.h) / 2);
    const values = new Set<number>();
    for (let y = 0; y < request.target.drawPx.h; y += 1) {
      for (let x = 0; x < request.target.drawPx.w; x += 1) {
        const at = ((top + y) * info.width + left + x) * 4;
        const expected = (Math.floor(x / factor) + Math.floor(y / factor)) % 2 ? 255 : 0;
        expect(data[at]).toBe(expected);
        values.add(data[at]!);
      }
    }
    expect(values).toEqual(new Set([0, 255]));
  });

  it('renders again at three quarters when the PNG would pass 4 MiB', async () => {
    const cwd = initRepo();
    const width = 1400;
    const height = 1000;
    // Noise does not compress: about 5.6 MB of PNG at full size.
    const raw = randomBytes(width * height * 4);
    for (let index = 3; index < raw.length; index += 4) raw[index] = 255;
    fs.writeFileSync(path.join(cwd, 'noise.png'), await sharp(raw, {raw: {width, height, channels: 4}}).png({compressionLevel: 1}).toBuffer());
    commitAll(cwd, 'add noise');
    const {backend} = backendFor();
    const request = fitRequest(cwd, blobSide(cwd, 'noise.png'), {w: width, h: height}, 140, 50);
    expect(request.target.drawPx).toEqual({w: width, h: height});

    const result = await backend.render(request, {aborted: false, addEventListener() {}, removeEventListener() {}} as unknown as AbortSignal);
    if (!result.ok || !('png' in result)) throw new Error('no png');
    expect(result.png.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    const meta = await sharp(result.png).metadata();
    // The canvas shrinks with the picture; the terminal scales it back into
    // the same cells.
    expect(meta.width).toBeLessThan(request.target.cols * CELL.w);
    expect(meta.width! / (request.target.cols * CELL.w)).toBeCloseTo(0.75, 1);
  });

  it('rejects a 100000 × 100000 header without decoding it', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'bomb.png'), pngHeaderOnly(100_000, 100_000));
    commitAll(cwd, 'add bomb');
    const {backend} = backendFor();
    const side = blobSide(cwd, 'bomb.png');

    expect(await backend.inspect({cwd, side, kind: 'raster', format: 'png'}, never)).toEqual({ok: false, state: 'error', reason: 'image too large to preview (100000 × 100000)'});
    const render = await backend.render(fitRequest(cwd, side, {w: 100_000, h: 100_000}), never);
    expect(render).toEqual({ok: false, state: 'error', reason: 'image too large to preview (100000 × 100000)'});
  });

  it('writes an export copy of the verified bytes into the session temp dir', async () => {
    const cwd = initRepo();
    const png = pngFixture(3, 2);
    fs.writeFileSync(path.join(cwd, 'shot.png'), png);
    commitAll(cwd, 'add shot');
    const {backend, tempDir} = backendFor();

    const result = await backend.exportCopy({cwd, side: blobSide(cwd, 'shot.png'), format: 'png', dir: tempDir}, never);
    expect(result).toMatchObject({ok: true});
    if (!result.ok) return;
    expect(path.isAbsolute(result.path)).toBe(true);
    expect(result.path.startsWith(`${tempDir}${path.sep}`)).toBe(true);
    expect(path.basename(result.path)).toBe('after.png');
    expect(Buffer.compare(fs.readFileSync(result.path), png)).toBe(0);
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it('hands a viewer nothing when the bytes are not the format the name says', async () => {
    const cwd = initRepo();
    // A JPEG committed under a .png name.
    fs.writeFileSync(path.join(cwd, 'shot.png'), await encoded('jpeg', 8, 8));
    commitAll(cwd, 'add shot');
    const dir = makeTempDir('branch-review-media-export-');
    const handler = createWorkerHandler();

    const result = await handler.handle({type: 'exportCopy', cwd, side: blobSide(cwd, 'shot.png'), format: 'png', dir});
    expect(result).toEqual({ok: false, state: 'error', reason: 'not a PNG image'});
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// A failure tagged `disk` is asked again on the next review; any other is
// kept until the content changes. Only the work tree file's state at read
// time earns the tag, never the content the id names.
describe('which worker failures describe the file on disk', {timeout: 60_000}, () => {
  const worktreeSide = (file: string, abbrevId: string): SideRef => ({side: 'after', source: 'worktree', path: file, abbrevId, key: `worktree|${file}|${abbrevId}`});
  const inspectJob = (cwd: string, side: SideRef) => ({type: 'inspect' as const, cwd, side, kind: 'raster' as const, format: 'png' as const});

  it('tags a work tree file that went away or changed between reads, in inspect and render', async () => {
    const cwd = initRepo();
    const gone = worktreeSide('gone.png', 'abcdef1');
    const handler = createWorkerHandler();
    expect(await handler.handle(inspectJob(cwd, gone))).toEqual({ok: false, state: 'error', reason: 'gone.png no longer exists', disk: true});
    expect(await handler.handle({type: 'render', ...fitRequest(cwd, gone, {w: 4, h: 4})})).toEqual({ok: false, state: 'error', reason: 'gone.png no longer exists', disk: true});

    fs.writeFileSync(path.join(cwd, 'live.png'), pngFixture(4, 4, [1, 2, 3, 255]));
    const id = git(cwd, 'hash-object', 'live.png').trim().slice(0, 7);
    fs.writeFileSync(path.join(cwd, 'live.png'), pngFixture(4, 4, [9, 9, 9, 255]));
    // Rewritten again while the reader waits to read it a second time.
    let writes = 0;
    const reader = createSideReader({
      sleep: async () => {
        writes += 1;
        fs.writeFileSync(path.join(cwd, 'live.png'), pngFixture(4, 4, [writes, 7, 7, 255]));
      },
    });
    const live = worktreeSide('live.png', id);
    const changing = createWorkerHandler({reader});
    expect(await changing.handle(inspectJob(cwd, live))).toEqual({ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true});
    expect(await changing.handle({type: 'render', ...fitRequest(cwd, live, {w: 4, h: 4})})).toEqual({ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true});
  });

  it('leaves a git filter, the size cap, a bad header and a missing blob untagged', async () => {
    const cwd = initRepo({'.gitattributes': '*.png text eol=crlf\n'});
    // Lone line feeds, which a CRLF checkout rewrites.
    const png = Buffer.concat([pngFixture(4, 4), Buffer.from('\n\n')]);
    fs.writeFileSync(path.join(cwd, 'crlf.png'), png);
    fs.writeFileSync(path.join(cwd, 'fake.png'), await encoded('jpeg', 8, 8));
    commitAll(cwd, 'add images');
    fs.rmSync(path.join(cwd, 'crlf.png'));
    git(cwd, 'checkout', '--', 'crlf.png');
    expect(Buffer.compare(fs.readFileSync(path.join(cwd, 'crlf.png')), png)).not.toBe(0);
    fs.writeFileSync(path.join(cwd, 'huge.png'), Buffer.alloc(16 * 1024 * 1024 + 1, 7));
    const handler = createWorkerHandler({reader: createSideReader({sleep: async () => undefined})});

    const filtered = worktreeSide('crlf.png', git(cwd, 'hash-object', 'crlf.png').trim().slice(0, 7));
    const filterReason = {ok: false, state: 'error', reason: 'preview unavailable: a git filter changes this file (shown as text)'};
    expect(await handler.handle(inspectJob(cwd, filtered))).toEqual(filterReason);
    expect(await handler.handle({type: 'render', ...fitRequest(cwd, filtered, {w: 4, h: 4})})).toEqual(filterReason);
    expect(await handler.handle(inspectJob(cwd, worktreeSide('huge.png', 'abcdef1')))).toEqual({ok: false, state: 'error', reason: 'huge.png is larger than 16 MB'});
    const fake = worktreeSide('fake.png', git(cwd, 'hash-object', 'fake.png').trim().slice(0, 7));
    expect(await handler.handle(inspectJob(cwd, fake))).toEqual({ok: false, state: 'error', reason: 'not a PNG image'});

    const missing = await handler.handle(inspectJob(cwd, {...blobSide(cwd, 'fake.png'), abbrevId: 'abcdef1', key: 'blob|fake.png|abcdef1'}));
    expect(missing).toMatchObject({ok: false, state: 'error'});
    expect(missing).not.toHaveProperty('disk');
  });
});

describe('without the image library', () => {
  const failing = () => Promise.reject(new Error('dlopen failed: libvips-cpp.dylib\nmore detail'));

  it('reports unavailable for formats the terminal cannot decode, and passes a small PNG through as it is', async () => {
    const cwd = initRepo();
    const png = pngFixture(30, 20);
    fs.writeFileSync(path.join(cwd, 'a.png'), png);
    fs.writeFileSync(path.join(cwd, 'b.jpg'), await encoded('jpeg', 30, 20));
    commitAll(cwd, 'add');
    const handler = createWorkerHandler({loadSharp: failing});

    const jpeg = await handler.handle({type: 'render', ...fitRequest(cwd, blobSide(cwd, 'b.jpg'), {w: 30, h: 20})});
    expect(jpeg).toEqual({ok: false, state: 'unavailable', reason: 'image library failed to load (dlopen failed: libvips-cpp.dylib)'});
    const passed = await handler.handle({type: 'render', ...fitRequest(cwd, blobSide(cwd, 'a.png'), {w: 30, h: 20})});
    expect(passed).toMatchObject({ok: true, passthrough: true});
    if (passed.ok && 'png' in passed) expect(Buffer.compare(Buffer.from(passed.png), png)).toBe(0);
  });

  it('still transmits the PNG to the terminal through the service', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'a.png'), pngFixture(30, 20));
    commitAll(cwd, 'add');
    const handler = createWorkerHandler({loadSharp: failing});
    const backend: MediaBackend = {
      inspect: (req) => handler.handle({type: 'inspect', ...req}) as never,
      render: (req) => handler.handle({type: 'render', ...req}) as never,
      exportCopy: (req) => handler.handle({type: 'exportCopy', ...req}) as never,
      dispose() {},
    };
    const writes: string[] = [];
    const service = createMediaService({caps: KITTY_CAPS, backend, sink: {write: (seq) => writes.push(seq)}, env: {}, opener: () => undefined});
    const id = git(cwd, 'rev-parse', '--short', 'HEAD:a.png').trim();
    const file: ReviewFile = {
      path: 'a.png',
      status: 'added',
      metrics: {path: 'a.png', additions: 0, deletions: 0, changedLines: 0},
      rawDiff: `diff --git a/a.png b/a.png\nnew file mode 100644\nindex 0000000..${id}\nBinary files /dev/null and b/a.png differ\n`,
      renderedLines: ['binary file changed'],
      blocks: [],
    };
    const review: ReviewModel = {base: 'main', branch: 'HEAD', label: 'main...HEAD', metrics: {filesChanged: 1, additions: 0, deletions: 0, changedLines: 0}, files: [file]};
    service.setReview(review, {cwd, range: {includeWorktree: false}});
    const ref = service.refFor(file)!;
    await waitFor(() => service.sideState(ref, 'after').status === 'ready');

    const plan = planMedia(ref, {after: service.sideState(ref, 'after')}, service.viewState(ref.fileKey), {innerWidth: 60, viewportRows: 20, caps: KITTY_CAPS});
    const boxes = plan.rows.flatMap((row) => row.type === 'box' && row.boxRow === 0 ? row.boxes : []);
    expect(boxes).toHaveLength(1);
    const keys = new Set(boxes.map((box) => box.imageKey));
    service.want(boxes.map((box) => ({fileKey: ref.fileKey, box})), keys);
    service.sweep(keys, keys);
    await waitFor(() => service.boxState(boxes[0]!).status !== 'loading');

    expect(service.boxState(boxes[0]!)).toMatchObject({status: 'kitty'});
    const commands = parseApc(writes);
    expect(commands.map((command) => command.a).slice(0, 2)).toEqual(['t', 'p']);
    expect(commands[1]).toMatchObject({c: boxes[0]!.cols, r: boxes[0]!.rows});
    expect(service.takeNotices()).toEqual(['image previews unavailable: image library failed to load']);
  });
});

const HANGING_WORKER = fileURLToPath(new URL('./fixtures/hanging-media-worker.mjs', import.meta.url));

describe('a media worker that hangs', {timeout: 30_000}, () => {
  it('is killed with its process group at the deadline, respawned with backoff, and turned off after three failures', async () => {
    const cwd = initRepo();
    // Fork times on this side: the deadline starts when the job is sent,
    // right after the fork, so the worker's own boot time is not in them.
    const forks: number[] = [];
    const {backend, tempDir} = backendFor({
      modulePath: HANGING_WORKER,
      deadlinesMs: {inspect: 400},
      backoffMs: [150, 300, 600],
      onSpawn: () => forks.push(Date.now()),
    });
    const side: SideRef = {side: 'after', source: 'blob', path: 'a.png', abbrevId: 'abcdef1', key: 'blob|a.png|abcdef1'};

    const startedAt = Date.now();
    const results = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      results.push(await backend.inspect({cwd, side, kind: 'raster', format: 'png'}, never));
    }
    expect(results).toEqual([
      {ok: false, state: 'error', reason: 'timed out'},
      {ok: false, state: 'error', reason: 'timed out'},
      {ok: false, state: 'error', reason: 'timed out'},
    ]);

    const log = fs.readFileSync(path.join(tempDir, 'hanging.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {at: number; pid: number; childPid: number});
    expect(log).toHaveLength(3);
    expect(forks).toHaveLength(3);
    // Each start after a failure waits out the deadline and then the
    // backoff. Timers and Date.now() round to whole milliseconds on
    // different clocks, hence the small margin.
    expect(forks[1]! - forks[0]!).toBeGreaterThanOrEqual(400 + 150 - 20);
    expect(forks[2]! - forks[1]!).toBeGreaterThanOrEqual(400 + 300 - 20);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    // The worker and the process it started are gone: the whole group was
    // killed. A killed process lingers until its parent reaps it.
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(() => log.every((entry) => !alive(entry.pid) && !alive(entry.childPid)), 5_000);

    // Turned off: answered at once, and no fourth process.
    const off = await backend.inspect({cwd, side, kind: 'raster', format: 'png'}, never);
    expect(off).toEqual({ok: false, state: 'unavailable', reason: 'previews turned off: timed out'});
    expect(fs.readFileSync(path.join(tempDir, 'hanging.log'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('leaves the UI taking keys while it hangs, then says previews are off', async () => {
    const cwd = initRepo();
    const {backend} = backendFor({modulePath: HANGING_WORKER, deadlinesMs: {inspect: 300}, backoffMs: [100, 100, 100]});
    const lines = Array.from({length: 40}, (_, index) => `${gutter(index + 1)}notes line ${index}`);
    // Three images: three jobs that time out turn previews off.
    const fixture = buildFixture([
      binaryMediaFile('docs/logo.png', 'added', ['0000000', 'abcdef1']),
      binaryMediaFile('docs/logo2.png', 'added', ['0000000', 'abcdef2']),
      binaryMediaFile('docs/logo3.png', 'added', ['0000000', 'abcdef3']),
      {path: 'notes.md', rawDiff: `@@ -0,0 +1,40 @@\n${lines.map((_, index) => `+notes line ${index}`).join('\n')}`, rendered: ['• notes.md:1: ', ...lines]},
    ]);
    const service = createMediaService({caps: KITTY_CAPS, backend, sink: {write: () => undefined}, env: {}, opener: () => undefined});
    service.setReview(fixture.review, {cwd, range: {includeWorktree: false}});
    const instance = renderFixture({...fixture, media: service}, {columns: 120, rows: 20});

    // The diff pane's lines, which every scroll moves.
    const top = () => frameLines(instance.lastFrame()).slice(6, 18).map((line) => line.slice(34)).join('\n');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('loading preview…');
    const seen: Array<string | undefined> = [];
    for (let press = 0; press < 6; press += 1) {
      instance.stdin.write('j');
      await new Promise((resolve) => setTimeout(resolve, 120));
      seen.push(top());
    }
    // Every press moved the view while the worker sat on the job.
    expect(new Set(seen).size).toBe(seen.length);

    instance.stdin.write('g');
    // The rows say it in the same commit that turns previews off; the toast
    // follows from an effect one frame later, so wait for the footer itself.
    await waitFor(() => (frameLines(instance.lastFrame()).at(-2) ?? '').includes('previews turned off: timed out'), 15_000);
    const shown = frameLines(instance.lastFrame());
    expect(shown.join('\n')).not.toContain('loading preview…');
    // In each file's rows, and once in the footer.
    expect(shown.slice(0, -3).filter((line) => line.includes('previews turned off: timed out')).length).toBeGreaterThanOrEqual(2);
    expect(shown.at(-2)).toContain('previews turned off: timed out');
    instance.stdin.write('k');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(top()).not.toBe(seen.at(-1));
    instance.unmount();
  });

  it('fails a job in flight when the worker dies, and re-queues nothing it did not have to', async () => {
    const cwd = initRepo();
    const {backend} = backendFor({modulePath: HANGING_WORKER, env: {...process.env, HANGING_WORKER_EXIT: '1'}, backoffMs: [50, 50, 50]});
    const side: SideRef = {side: 'after', source: 'blob', path: 'a.png', abbrevId: 'abcdef1', key: 'blob|a.png|abcdef1'};
    const result = await backend.inspect({cwd, side, kind: 'raster', format: 'png'}, never);
    expect(result).toEqual({ok: false, state: 'error', reason: 'media worker exited (code 3)'});
  });

  it('rejects an aborted job at once', async () => {
    const cwd = initRepo();
    const {backend} = backendFor({modulePath: HANGING_WORKER, deadlinesMs: {inspect: 5000}});
    const side: SideRef = {side: 'after', source: 'blob', path: 'a.png', abbrevId: 'abcdef1', key: 'blob|a.png|abcdef1'};
    const controller = new AbortController();
    const pending = backend.inspect({cwd, side, kind: 'raster', format: 'png'}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow('aborted');
  });
});

const SCRIPTED_WORKER = fileURLToPath(new URL('./fixtures/scripted-media-worker.mjs', import.meta.url));

type ScriptedEntry = {at: number; pid: number; event: 'start' | 'job'; tmpdir?: string; id?: number; type?: string; path?: string};

function scriptedLog(tempDir: string): ScriptedEntry[] {
  const file = path.join(tempDir, 'scripted.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ScriptedEntry);
}

const jobPaths = (tempDir: string) => scriptedLog(tempDir).filter((entry) => entry.event === 'job').map((entry) => entry.path);

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the media worker client', {timeout: 30_000}, () => {
  const sideFor = (file: string): SideRef => ({side: 'after', source: 'blob', path: file, abbrevId: 'abcdef1', key: `blob|${file}|abcdef1`});
  const inspectOf = (cwd: string, file: string) => ({cwd, side: sideFor(file), kind: 'raster' as const, format: 'png' as const});
  // Jobs left hanging are settled by dispose after each test.
  const ignore = () => undefined;

  it('runs two jobs at a time and queues the rest', async () => {
    const cwd = initRepo();
    const {backend, tempDir} = backendFor({modulePath: SCRIPTED_WORKER, deadlinesMs: {inspect: 20_000}});
    for (const file of ['hang-1.png', 'hang-2.png', 'hang-3.png']) void backend.inspect(inspectOf(cwd, file), never).then(ignore, ignore);

    await waitFor(() => jobPaths(tempDir).length >= 2);
    await pause(300);
    expect(jobPaths(tempDir)).toEqual(['hang-1.png', 'hang-2.png']);
  });

  it('sends the jobs on screen first', async () => {
    const cwd = initRepo();
    const {backend, tempDir} = backendFor({modulePath: SCRIPTED_WORKER, deadlinesMs: {inspect: 20_000}});
    // Both slots taken; one frees when its answer comes back.
    const first = backend.inspect(inspectOf(cwd, 'answer-1.png'), never, 1);
    void backend.inspect(inspectOf(cwd, 'hang-2.png'), never, 1).then(ignore, ignore);
    // Queued behind them: one off screen, then one on screen.
    void backend.inspect(inspectOf(cwd, 'hang-off-screen.png'), never, 1).then(ignore, ignore);
    void backend.inspect(inspectOf(cwd, 'hang-on-screen.png'), never, 0).then(ignore, ignore);

    expect(await first).toEqual({ok: false, state: 'error', reason: 'answered answer-1.png'});
    await waitFor(() => jobPaths(tempDir).length >= 3);
    await pause(300);
    expect(jobPaths(tempDir)).toEqual(['answer-1.png', 'hang-2.png', 'hang-on-screen.png']);
  });

  it('gives the job beside one that missed its deadline one more try, then fails it', async () => {
    const cwd = initRepo();
    // Renders get a long deadline, so only an inspect's deadline ends a worker.
    const {backend, tempDir} = backendFor({modulePath: SCRIPTED_WORKER, deadlinesMs: {inspect: 400, render: 20_000}, backoffMs: [50, 50, 50]});
    const startedAt = Date.now();
    const first = backend.inspect(inspectOf(cwd, 'hang-a.png'), never);
    const beside = backend.render({...fitRequest(cwd, sideFor('hang-b.png'), {w: 20, h: 20}), format: 'png'}, never);
    const third = backend.inspect(inspectOf(cwd, 'hang-c.png'), never);

    expect(await first).toEqual({ok: false, state: 'error', reason: 'timed out'});
    expect(await third).toEqual({ok: false, state: 'error', reason: 'timed out'});
    // Failed when the second worker was killed, long before its own deadline.
    expect(await beside).toEqual({ok: false, state: 'error', reason: 'timed out'});
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const log = scriptedLog(tempDir);
    const pids = [...new Set(log.filter((entry) => entry.event === 'start').map((entry) => entry.pid))];
    expect(pids).toHaveLength(2);
    const jobsIn = (pid: number) => log.filter((entry) => entry.event === 'job' && entry.pid === pid).map((entry) => entry.path);
    expect(jobsIn(pids[0]!)).toEqual(['hang-a.png', 'hang-b.png']);
    expect(jobsIn(pids[1]!)).toEqual(['hang-b.png', 'hang-c.png']);
  });

  it('stops a worker left idle', async () => {
    const cwd = initRepo();
    const pids: number[] = [];
    const {backend} = backendFor({modulePath: SCRIPTED_WORKER, idleMs: 200, onSpawn: (pid) => pids.push(pid)});
    expect(await backend.inspect(inspectOf(cwd, 'answer.png'), never)).toMatchObject({ok: false, reason: 'answered answer.png'});
    expect(pids).toHaveLength(1);
    await waitFor(() => !alive(pids[0]!), 5_000);
  });

  it('points the worker\'s temp files at the session dir', async () => {
    const cwd = initRepo();
    const {backend, tempDir} = backendFor({modulePath: SCRIPTED_WORKER});
    await backend.inspect(inspectOf(cwd, 'answer.png'), never);
    expect(scriptedLog(tempDir).find((entry) => entry.event === 'start')?.tmpdir).toBe(path.join(tempDir, 'worker'));
  });

  it('never keeps the process alive once its jobs are answered', async () => {
    const tempDir = makeTempDir('branch-review-media-test-');
    const probe = fileURLToPath(new URL('./fixtures/backend-exit-probe.ts', import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    // The worker's idle stop is 30 s in the probe; it must not be what ends it.
    const child = spawn(process.execPath, ['--import', tsx, probe, tempDir, SCRIPTED_WORKER], {cwd: initRepo(), stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    let answeredAt = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!answeredAt && output.includes('answered')) answeredAt = Date.now();
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    clearTimeout(killer);
    expect(output).toContain('answered answer.png');
    expect(code).toBe(0);
    expect(Date.now() - answeredAt).toBeLessThan(10_000);
  }, 60_000);
});

// The difference view: both sides decoded in the worker onto one canvas,
// changed pixels counted and marked, then fitted into the box like any
// picture.
describe('the difference view in the real media worker', {timeout: 60_000}, () => {
  const BLUE = [30, 120, 200, 255] as const;
  const RED = [220, 40, 40, 255] as const;

  async function differenceOf(beforePng: Buffer, afterPng: Buffer, maxCols = 40, maxRows = 20) {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'before.png'), beforePng);
    fs.writeFileSync(path.join(cwd, 'after.png'), afterPng);
    commitAll(cwd, 'add both sides');
    const before: SideRef = {...blobSide(cwd, 'before.png'), side: 'before'};
    const after = blobSide(cwd, 'after.png');
    const [a, b] = await Promise.all([sharp(beforePng).metadata(), sharp(afterPng).metadata()]);
    const canvas = {w: Math.max(a.width!, b.width!), h: Math.max(a.height!, b.height!)};
    const box = fitBox(canvas, maxCols, maxRows, KITTY_CAPS);
    const request: RenderRequest = {
      cwd,
      op: 'difference',
      sides: [before, after],
      kind: 'raster',
      format: 'png',
      checker: false,
      target: {cols: box.cols, rows: box.rows, cellPx: CELL, drawPx: box.drawPx, nearest: box.nearest},
    };
    const {backend} = backendFor();
    const result = await backend.render(request, never);
    return {result, request};
  }

  async function pixelAt(png: Uint8Array, request: RenderRequest, x: number, y: number) {
    const {data, info} = await sharp(png).raw().toBuffer({resolveWithObject: true});
    const left = Math.floor((info.width - request.target.drawPx.w) / 2);
    const top = Math.floor((info.height - request.target.drawPx.h) / 2);
    const at = ((top + y) * info.width + left + x) * info.channels;
    return [...data.subarray(at, at + 4)];
  }

  it('counts the changed pixels, marks them, and darkens the rest, at the padded cell size', async () => {
    // The left quarter of a 100 × 40 picture turns red.
    const before = pngFixture(100, 40, BLUE);
    const after = pngFixture(100, 40, (x) => (x < 25 ? RED : BLUE));
    const {result, request} = await differenceOf(before, after);
    if (!result.ok || !('png' in result)) throw new Error(`no png: ${JSON.stringify(result)}`);
    expect(result.changedRatio).toBe(0.25);
    const meta = await sharp(result.png).metadata();
    expect([meta.width, meta.height]).toEqual([request.target.cols * CELL.w, request.target.rows * CELL.h]);
    expect(request.target.drawPx).toEqual({w: 100, h: 40});

    // A changed pixel is tinted towards #d2a8ff; an unchanged one is the
    // after image darkened by 55%.
    const changed = await pixelAt(result.png, request, 10, 20);
    expect(changed[3]).toBe(255);
    expect(changed[0]).toBeGreaterThan(150);
    expect(changed[2]).toBeGreaterThan(150);
    const kept = await pixelAt(result.png, request, 70, 20);
    expect(kept).toEqual([Math.round(30 * 0.45), Math.round(120 * 0.45), Math.round(200 * 0.45), 255]);
  });

  it('finds no visible change in a re-encode of the same pixels', async () => {
    const pixels = (x: number, y: number) => [(x * 7) % 256, (y * 13) % 256, 90, 255] as const;
    const raw = Buffer.alloc(64 * 48 * 4);
    for (let y = 0; y < 48; y += 1) for (let x = 0; x < 64; x += 1) raw.set(pixels(x, y), (y * 64 + x) * 4);
    const before = await sharp(raw, {raw: {width: 64, height: 48, channels: 4}}).png({compressionLevel: 0}).toBuffer();
    const after = await sharp(raw, {raw: {width: 64, height: 48, channels: 4}}).png({compressionLevel: 9}).toBuffer();
    expect(Buffer.compare(before, after)).not.toBe(0);
    const {result} = await differenceOf(before, after);
    expect(result).toMatchObject({ok: true, changedRatio: 0});
  });

  it('ignores a channel moving by 8 levels or less, and counts one moving by 9', async () => {
    const shifted = (by: number) => pngFixture(20, 10, [BLUE[0] + by, BLUE[1], BLUE[2], 255]);
    expect((await differenceOf(pngFixture(20, 10, BLUE), shifted(8))).result).toMatchObject({ok: true, changedRatio: 0});
    expect((await differenceOf(pngFixture(20, 10, BLUE), shifted(9))).result).toMatchObject({ok: true, changedRatio: 1});
  });

  it('aligns sides of different sizes top-left on the larger canvas, counting the area only one side covers', async () => {
    const {result, request} = await differenceOf(pngFixture(100, 40, BLUE), pngFixture(100, 80, BLUE), 60, 20);
    if (!result.ok || !('png' in result)) throw new Error('no png');
    expect(result.changedRatio).toBe(0.5);
    // The box is fitted to the 100 × 80 canvas.
    expect(request.target.drawPx).toEqual({w: 100, h: 80});
    const meta = await sharp(result.png).metadata();
    expect([meta.width, meta.height]).toEqual([request.target.cols * CELL.w, request.target.rows * CELL.h]);
  });

  it('compares the smaller side against the larger one from the top-left corner', async () => {
    // A 40 × 20 red before; an 80 × 40 after, red in its top-left 40 × 20
    // and blue elsewhere. Aligned top-left, only the area the before side
    // never covered changed.
    const before = pngFixture(40, 20, RED);
    const after = pngFixture(80, 40, (x, y) => (x < 40 && y < 20 ? RED : BLUE));
    const {result, request} = await differenceOf(before, after);
    if (!result.ok || !('png' in result)) throw new Error(`no png: ${JSON.stringify(result)}`);
    expect(request.target.drawPx).toEqual({w: 80, h: 40});
    expect(result.changedRatio).toBe(0.75);
    const kept = [Math.round(220 * 0.45), Math.round(40 * 0.45), Math.round(40 * 0.45), 255];
    // The before side's corners line up with the after side's red corner.
    expect(await pixelAt(result.png, request, 0, 0)).toEqual(kept);
    expect(await pixelAt(result.png, request, 39, 0)).toEqual(kept);
    expect(await pixelAt(result.png, request, 0, 19)).toEqual(kept);
    // Right of it and below it is change, down to the bottom edge: the tint
    // over the darkened blue.
    const marked = [0, 1, 2].map((channel) => Math.round(BLUE[channel]! * 0.45 * 0.4 + [0xd2, 0xa8, 0xff][channel]! * 0.6));
    for (const [x, y] of [[40, 0], [79, 0], [0, 20], [0, 39], [79, 39]] as const) {
      expect(await pixelAt(result.png, request, x, y)).toEqual([...marked, 255]);
    }
  });

  it('counts a change of alpha alone', async () => {
    const faded = pngFixture(20, 10, [BLUE[0], BLUE[1], BLUE[2], 200]);
    expect((await differenceOf(pngFixture(20, 10, BLUE), faded)).result).toMatchObject({ok: true, changedRatio: 1});
  });

  it('ignores the colour of pixels transparent on both sides', async () => {
    // An optimizer rewrote the colour under the transparent right half.
    const hidden = (rgb: number) => pngFixture(40, 20, (x) => (x < 20 ? BLUE : [rgb, rgb, rgb, 0]));
    expect((await differenceOf(hidden(255), hidden(0))).result).toMatchObject({ok: true, changedRatio: 0});
    // The same holds where only the larger side covers the canvas.
    expect((await differenceOf(pngFixture(20, 20, BLUE), hidden(255))).result).toMatchObject({ok: true, changedRatio: 0});
    // A transparent pixel turning visible still counts.
    expect((await differenceOf(hidden(255), pngFixture(40, 20, BLUE))).result).toMatchObject({ok: true, changedRatio: 0.5});
  });

  it('refuses a combined canvas over the pixel cap before drawing the difference', async () => {
    // Each side passes the cap; together they span 16384 × 16384.
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'before.png'), pngFixture(16_384, 100, BLUE));
    fs.writeFileSync(path.join(cwd, 'after.png'), pngFixture(100, 16_384, BLUE));
    commitAll(cwd, 'add both sides');
    const handler = createWorkerHandler();
    const result = await handler.handle({
      type: 'render',
      cwd,
      op: 'difference',
      sides: [{...blobSide(cwd, 'before.png'), side: 'before'}, blobSide(cwd, 'after.png')],
      kind: 'raster',
      format: 'png',
      checker: false,
      target: {cols: 20, rows: 10, cellPx: CELL, drawPx: {w: 200, h: 200}, nearest: false},
    });
    expect(result).toEqual({ok: false, state: 'error', reason: 'image too large to preview (16384 × 16384)'});
  });

  it('says the image library is missing rather than passing either side through', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'before.png'), pngFixture(8, 8, BLUE));
    fs.writeFileSync(path.join(cwd, 'after.png'), pngFixture(8, 8, RED));
    commitAll(cwd, 'add both sides');
    const handler = createWorkerHandler({loadSharp: async () => {
      throw new Error('Cannot find module sharp');
    }});
    const result = await handler.handle({
      type: 'render',
      cwd,
      op: 'difference',
      sides: [{...blobSide(cwd, 'before.png'), side: 'before'}, blobSide(cwd, 'after.png')],
      kind: 'raster',
      format: 'png',
      checker: false,
      target: {cols: 1, rows: 1, cellPx: CELL, drawPx: {w: 8, h: 8}, nearest: false},
    });
    expect(result).toEqual({ok: false, state: 'unavailable', reason: 'image library failed to load (Cannot find module sharp)'});
  });

  it('refuses a difference without exactly two sides', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'after.png'), pngFixture(8, 8, RED));
    commitAll(cwd, 'add one side');
    const handler = createWorkerHandler();
    const result = await handler.handle({
      type: 'render', cwd, op: 'difference', sides: [blobSide(cwd, 'after.png')], kind: 'raster', format: 'png', checker: false,
      target: {cols: 1, rows: 1, cellPx: CELL, drawPx: {w: 8, h: 8}, nearest: false},
    });
    expect(result).toMatchObject({ok: false, state: 'error'});
  });
});
