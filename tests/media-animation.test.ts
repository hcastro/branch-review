import sharp from 'sharp';
import {afterEach, describe, expect, it} from 'vitest';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import {fitBox, planMedia, planRowText} from '../src/media/layout.js';
import {createWorkerHandler} from '../src/media/worker/handler.js';
import {sniffImage} from '../src/media/worker/sniff.js';
import type {RenderRequest, RenderResult} from '../src/media/backend.js';
import type {MediaRef, SideRef} from '../src/media/types.js';
import {cleanupTempDirs, commitAll, git, initRepo} from './core-helpers.js';
import {KITTY_CAPS, BLOCKS_CAPS, parseApc, pngFixture, sideInfo} from './media-helpers.js';
import {binaryMediaFile, buildFixture, fakeMediaService, flush, frameLines, renderFixture} from './ui-fixtures.js';
import fs from 'node:fs';
import path from 'node:path';

// Animated GIF and WebP in Kitty terminals that run animations: the first
// frame is transmitted as the image, every further frame follows as an
// animation frame with its own delay, and the terminal runs the loop. Every
// other terminal, and --no-animations, shows the first frame.

afterEach(() => {
  cleanupTempDirs();
});

const ANIMATING = {...KITTY_CAPS, animation: true, terminal: 'kitty'};
const CELL = {w: 10, h: 20};
const never = new AbortController().signal;

const RED = [255, 0, 0] as const;
const GREEN = [0, 255, 0] as const;
const BLUE = [0, 0, 255] as const;

// Three solid frames, red, green and blue, shown 100, 200 and 300 ms.
async function animated(format: 'gif' | 'webp', width = 40, height = 20, colors: ReadonlyArray<readonly [number, number, number]> = [RED, GREEN, BLUE]) {
  const raw = Buffer.alloc(width * height * colors.length * 4);
  for (const [page, color] of colors.entries()) {
    for (let pixel = 0; pixel < width * height; pixel += 1) raw.set([...color, 255], (page * width * height + pixel) * 4);
  }
  const input = sharp(raw, {raw: {width, height: height * colors.length, channels: 4, pageHeight: height}});
  const delay = colors.map((_, index) => (index + 1) * 100);
  return format === 'gif' ? input.gif({delay, loop: 0}).toBuffer() : input.webp({delay, loop: 0, lossless: true}).toBuffer();
}

describe('sniffing an animation', () => {
  it('reads the frame count and the total duration of an animated GIF and WebP', async () => {
    expect(sniffImage(await animated('gif'), 'gif')).toMatchObject({ok: true, frames: 3, durationMs: 600});
    expect(sniffImage(await animated('webp'), 'webp')).toMatchObject({ok: true, frames: 3, durationMs: 600});
  });

  it('gives a still image no duration', async () => {
    const still = await sharp({create: {width: 4, height: 4, channels: 4, background: '#ffffff'}}).gif().toBuffer();
    expect(sniffImage(still, 'gif')).not.toHaveProperty('durationMs');
  });
});

function blobSide(cwd: string, file: string): SideRef {
  const abbrevId = git(cwd, 'rev-parse', '--short', `HEAD:${file}`).trim();
  return {side: 'after', source: 'blob', path: file, abbrevId, key: `blob|${file}|${abbrevId}`};
}

function animatedRequest(cwd: string, side: SideRef, format: 'gif' | 'webp', frames?: RenderRequest['frames']): RenderRequest {
  const box = fitBox({w: 40, h: 20}, 60, 20, KITTY_CAPS);
  return {
    cwd, op: 'fit', sides: [side], kind: 'raster', format, checker: false,
    target: {cols: box.cols, rows: box.rows, cellPx: CELL, drawPx: box.drawPx, nearest: box.nearest},
    ...(frames ? {frames} : {}),
  };
}

async function centerPixel(png: Uint8Array) {
  const {data, info} = await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
  return [data[at], data[at + 1], data[at + 2]];
}

describe('rendering an animation in the media worker', {timeout: 60_000}, () => {
  for (const format of ['gif', 'webp'] as const) {
    it(`draws every frame of an animated ${format.toUpperCase()} at the box's padded size, each with its delay`, async () => {
      const cwd = initRepo();
      fs.writeFileSync(path.join(cwd, `spin.${format}`), await animated(format));
      commitAll(cwd, 'add animation');
      const handler = createWorkerHandler();
      const request = animatedRequest(cwd, blobSide(cwd, `spin.${format}`), format, {max: 100, maxBytes: 32 * 1024 * 1024});
      const result = await handler.handle({type: 'render', ...request}) as RenderResult;
      if (!result.ok || !('png' in result)) throw new Error(JSON.stringify(result));

      expect(result.animation).toBeDefined();
      expect(result.animation!.firstDelayMs).toBe(100);
      expect(result.animation!.frames.map((frame) => frame.delayMs)).toEqual([200, 300]);
      expect(await centerPixel(result.png)).toEqual([...RED]);
      const pngs = result.animation!.frames.map((frame) => frame.png);
      expect(await centerPixel(pngs[0]!)).toEqual([...GREEN]);
      expect(await centerPixel(pngs[1]!)).toEqual([...BLUE]);
      for (const png of [result.png, ...pngs]) {
        const meta = await sharp(png).metadata();
        expect([meta.width, meta.height]).toEqual([request.target.cols * CELL.w, request.target.rows * CELL.h]);
      }
    });
  }

  it('draws the first frame alone, saying why, past the frame or byte cap', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'spin.gif'), await animated('gif'));
    commitAll(cwd, 'add animation');
    const handler = createWorkerHandler();
    const side = blobSide(cwd, 'spin.gif');
    for (const frames of [{max: 2, maxBytes: 32 * 1024 * 1024}, {max: 100, maxBytes: 64}]) {
      const result = await handler.handle({type: 'render', ...animatedRequest(cwd, side, 'gif', frames)}) as RenderResult;
      if (!result.ok || !('png' in result)) throw new Error(JSON.stringify(result));
      expect(result.animation, JSON.stringify(frames)).toBeUndefined();
      expect(result.note).toBe('animation too large');
      expect(await centerPixel(result.png)).toEqual([...RED]);
    }
  });

  it('draws the first frame alone when no frames are asked for', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'spin.webp'), await animated('webp'));
    commitAll(cwd, 'add animation');
    const result = await createWorkerHandler().handle({type: 'render', ...animatedRequest(cwd, blobSide(cwd, 'spin.webp'), 'webp')}) as RenderResult;
    if (!result.ok || !('png' in result)) throw new Error(JSON.stringify(result));
    expect(result.animation).toBeUndefined();
    expect(result.note).toBeUndefined();
  });
});

describe('sending an animation to the terminal', () => {
  it('writes the frames, the first frame\'s gap and the loop in the same write as the transmit', () => {
    const writes: string[] = [];
    const registry = createImageRegistry({write: (sequence) => writes.push(sequence), random: () => 0});
    const first = pngFixture(20, 20, [255, 0, 0, 255]);
    const frames = [{png: pngFixture(20, 20, [0, 255, 0, 255]), delayMs: 200}, {png: pngFixture(20, 20, [0, 0, 255, 255]), delayMs: 300}];
    const id = registry.acquire('spin', first, 2, 1, {frames, firstDelayMs: 100})!;
    expect(writes).toHaveLength(1);
    const commands = parseApc(writes);
    expect(commands.map((command) => command.a)).toEqual(['t', 'p', 'f', 'f', 'a', 'a']);
    expect(commands.every((command) => command.i === id || command.i === undefined)).toBe(true);
    expect(writes[0]).toContain(`\u001B_Ga=f,i=${id},f=100,z=200,q=2,m=0;`);
    expect(writes[0]).toContain(`\u001B_Ga=f,i=${id},f=100,z=300,q=2,m=0;`);
    expect(writes[0]).toContain(`\u001B_Ga=a,i=${id},r=1,z=100,q=2\u001B\\`);
    expect(writes[0]!.endsWith(`\u001B_Ga=a,i=${id},s=3,v=1,q=2\u001B\\`)).toBe(true);
    // The frames count against the byte budget too.
    expect(registry.fits(new Uint8Array(96 * 1024 * 1024 * 0.75 - 100))).toBe(false);
  });
});

// An added animated GIF of 24 frames, 2.4 s in all.
const SPIN = binaryMediaFile('docs/spin.gif', 'added', ['0000000', '5a1e7c0']);
const SPIN_SIDES = {'5a1e7c0': sideInfo({oid: '5a1e7c0'.padEnd(40, '0'), format: 'gif', width: 200, height: 100, frames: 24, durationMs: 2400})};
const SIZE = {columns: 120, rows: 30};

function animationRender(request: RenderRequest): RenderResult {
  const {cols, rows, cellPx} = request.target;
  const png = pngFixture(cols * cellPx.w, rows * cellPx.h, [255, 0, 0, 255]);
  if (!request.frames) return {ok: true, png};
  return {ok: true, png, animation: {firstDelayMs: 100, frames: [{png: pngFixture(cols * cellPx.w, rows * cellPx.h, [0, 255, 0, 255]), delayMs: 100}]}};
}

async function spinApp(caps: typeof KITTY_CAPS, animations: boolean) {
  const fixture = buildFixture([SPIN]);
  const fake = fakeMediaService({caps, sides: SPIN_SIDES, review: fixture.review, render: animationRender, animations});
  const instance = renderFixture({...fixture, media: fake.service}, SIZE, []);
  await flush(8);
  return {...fake, instance};
}

describe('animations in the diff pane', () => {
  it('runs the animation in a terminal that animates, with animations on', async () => {
    const {instance, calls, graphicsWrites} = await spinApp(ANIMATING, true);
    const renders = calls.flatMap((call) => call.type === 'render' ? [call.request] : []);
    expect(renders).toHaveLength(1);
    expect(renders[0]!.frames).toEqual({max: 100, maxBytes: 32 * 1024 * 1024});
    const commands = parseApc(graphicsWrites);
    expect(commands.filter((command) => command.a === 'f')).toHaveLength(1);
    expect(commands.filter((command) => command.a === 'a').map((command) => command.r ?? 'loop')).toHaveLength(2);
    expect(graphicsWrites.join('')).toContain(',s=3,v=1,q=2');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('after · animated · 24 frames · 2.4 s');
    instance.unmount();
  });

  for (const [name, caps, animations] of [
    ['with --no-animations', ANIMATING, false],
    ['in a terminal that does not animate', KITTY_CAPS, true],
  ] as const) {
    it(`shows the first frame ${name}, and sends no frames`, async () => {
      const {instance, calls, graphicsWrites} = await spinApp(caps, animations);
      const renders = calls.flatMap((call) => call.type === 'render' ? [call.request] : []);
      expect(renders).toHaveLength(1);
      expect(renders[0]).not.toHaveProperty('frames');
      const commands = parseApc(graphicsWrites);
      expect(commands.map((command) => command.a)).toEqual(['t', 'p']);
      const text = frameLines(instance.lastFrame()).join('\n');
      expect(text).toContain('after · first frame of 24');
      expect(text).not.toContain('animated');
      instance.unmount();
    });
  }

  it('shows the first frame in a block preview, saying so', async () => {
    const {instance, calls} = await spinApp({...BLOCKS_CAPS, animation: false}, true);
    expect(calls.flatMap((call) => call.type === 'render' ? [call.request] : [])[0]).not.toHaveProperty('frames');
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('first frame of 24');
    instance.unmount();
  });

  it('says the animation was too large when the worker drew its first frame alone', async () => {
    const fixture = buildFixture([SPIN]);
    const fake = fakeMediaService({
      caps: ANIMATING,
      sides: SPIN_SIDES,
      review: fixture.review,
      animations: true,
      render: (request) => ({ok: true, png: pngFixture(request.target.cols * 10, request.target.rows * 20), note: 'animation too large'}),
    });
    const instance = renderFixture({...fixture, media: fake.service}, SIZE, []);
    await flush(8);
    expect(frameLines(instance.lastFrame()).join('\n')).toContain('after · first frame of 24 · animation too large');
    expect(parseApc(fake.graphicsWrites).map((command) => command.a)).toEqual(['t', 'p']);
    instance.unmount();
  });

  it('says only the side whose animation was too large shows its first frame', async () => {
    // A changed GIF: the before side runs, the after side has too many frames.
    const file = binaryMediaFile('docs/spin.gif', 'modified', ['1a2b3c4', '5d6e7f8']);
    const fixture = buildFixture([file]);
    const sides = {
      '1a2b3c4': sideInfo({oid: '1a2b3c4'.padEnd(40, '0'), format: 'gif', width: 200, height: 100, frames: 50, durationMs: 5000}),
      '5d6e7f8': sideInfo({oid: '5d6e7f8'.padEnd(40, '0'), format: 'gif', width: 200, height: 100, frames: 150, durationMs: 15_000}),
    };
    const fake = fakeMediaService({
      caps: ANIMATING,
      sides,
      review: fixture.review,
      animations: true,
      render: (request) => request.sides[0]!.side === 'after'
        ? {ok: true, png: pngFixture(request.target.cols * 10, request.target.rows * 20), note: 'animation too large'}
        : animationRender(request),
    });
    const instance = renderFixture({...fixture, media: fake.service}, {columns: 260, rows: 30}, []);
    await flush(8);
    const text = frameLines(instance.lastFrame()).join('\n');
    expect(text).toContain('first frame of 150 · animation too large');
    expect(text).toContain('animated · 50 frames · 5 s');
    expect(text).not.toContain('first frame of 50');
    instance.unmount();
  });

  it('labels an APNG with its first frame, never asking for frames', () => {
    const ref: MediaRef = {
      fileKey: 'a.png', kind: 'raster', format: 'png', hasSourceBlocks: false, contentKey: 'png|-|x',
      after: {side: 'after', source: 'blob', path: 'a.png', abbrevId: 'abcdef1', key: 'blob|a.png|abcdef1'},
    };
    const plan = planMedia(ref, {after: {status: 'ready', info: sideInfo({frames: 8, durationMs: 800})}}, {compare: 'sideBySide', flipSide: 'after', textView: false}, {innerWidth: 100, viewportRows: 30, caps: ANIMATING, animate: true});
    expect(planRowText(plan.rows[0]!, 100)).toContain('after · first frame of 8');
  });
});
