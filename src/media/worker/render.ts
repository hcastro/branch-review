import type {RenderResult, RenderTarget} from '../backend.js';
import type {Sniffed} from './sniff.js';
import {MAX_PIXELS} from './sniff.js';

// Decodes and scales an image into the PNG the terminal is sent. The PNG is
// exactly cols × cell width by rows × cell height, the picture centred on
// transparent padding, so the terminal draws it at its aspect ratio whatever
// rule it uses to fit an image into its cells.

type SharpFactory = typeof import('sharp').default;
export type SharpLoader = () => Promise<SharpFactory>;

// Larger PNGs are drawn again smaller; the terminal scales them back up into
// the same cells.
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const SHRINK = 0.75;
const MAX_SHRINKS = 2;
const DECODE_TIMEOUT_S = 6;
const CHECK_PX = 8;
const CHECK_TONES = [[0x1b, 0x21, 0x29], [0x14, 0x19, 0x20]] as const;

// Imported on first use, in the worker only: the library is large, slow to
// load, and native.
const defaultLoader: SharpLoader = async () => (await import('sharp')).default;

function firstLine(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.trim() || 'unknown error';
}

function checkerboard(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tone = CHECK_TONES[(Math.floor(x / CHECK_PX) + Math.floor(y / CHECK_PX)) % 2]!;
      const at = (y * width + x) * 4;
      pixels[at] = tone[0];
      pixels[at + 1] = tone[1];
      pixels[at + 2] = tone[2];
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

export function createRenderer({loadSharp = defaultLoader}: {loadSharp?: SharpLoader} = {}) {
  // Loaded once, on first use; a failed load is remembered for the worker's
  // life rather than retried per image.
  let loading: Promise<SharpFactory> | null = null;

  const sharpOrReason = async (): Promise<{sharp: SharpFactory} | {reason: string}> => {
    loading ??= loadSharp().then((sharp) => {
      sharp.cache(false);
      sharp.concurrency(2);
      return sharp;
    });
    try {
      return {sharp: await loading};
    } catch (error) {
      return {reason: `image library failed to load (${firstLine(error)})`};
    }
  };

  async function fitOnce(sharp: SharpFactory, bytes: Buffer, info: Sniffed, target: RenderTarget, checker: boolean, scale: number) {
    const canvasW = Math.max(1, Math.round(target.cols * target.cellPx.w * scale));
    const canvasH = Math.max(1, Math.round(target.rows * target.cellPx.h * scale));
    const drawW = Math.min(canvasW, Math.max(1, Math.round(target.drawPx.w * scale)));
    const drawH = Math.min(canvasH, Math.max(1, Math.round(target.drawPx.h * scale)));

    // The input is always a buffer, never a path; one page, so an animation
    // shows its first frame.
    const resized = await sharp(bytes, {limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1})
      .timeout({seconds: DECODE_TIMEOUT_S})
      .resize(drawW, drawH, {fit: 'fill', kernel: target.nearest ? 'nearest' : 'lanczos3'})
      .ensureAlpha()
      .raw()
      .toBuffer();

    const raw = {width: drawW, height: drawH, channels: 4 as const};
    let picture = resized;
    if (checker && info.hasAlpha) {
      picture = await sharp(checkerboard(drawW, drawH), {raw})
        .composite([{input: resized, raw}])
        .raw()
        .toBuffer();
    }

    const left = Math.floor((canvasW - drawW) / 2);
    const top = Math.floor((canvasH - drawH) / 2);
    return sharp(picture, {raw})
      .extend({top, bottom: canvasH - drawH - top, left, right: canvasW - drawW - left, background: {r: 0, g: 0, b: 0, alpha: 0}})
      .png({compressionLevel: 6})
      .toBuffer();
  }

  /** The image fitted into its box as a padded PNG. */
  async function fit(bytes: Buffer, info: Sniffed, target: RenderTarget, checker: boolean): Promise<RenderResult> {
    const loaded = await sharpOrReason();
    if ('reason' in loaded) return {ok: false, state: 'unavailable', reason: loaded.reason};

    try {
      let scale = 1;
      let png = await fitOnce(loaded.sharp, bytes, info, target, checker, scale);
      for (let shrink = 0; shrink < MAX_SHRINKS && png.byteLength > MAX_PNG_BYTES; shrink += 1) {
        scale *= SHRINK;
        png = await fitOnce(loaded.sharp, bytes, info, target, checker, scale);
      }
      return {ok: true, png};
    } catch {
      // A corrupt file, or one caught half-written: tried again only when its
      // content id changes.
      return {ok: false, state: 'error', reason: 'could not decode image'};
    }
  }

  return {fit, available: async () => !('reason' in await sharpOrReason())};
}

export type Renderer = ReturnType<typeof createRenderer>;
