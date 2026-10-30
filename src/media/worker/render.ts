import type {Animation, JobFailure, RenderResult, RenderTarget} from '../backend.js';
import {CLEAR_PIXEL} from '../blocks.js';
import type {Sniffed} from './sniff.js';
import {MAX_PIXELS, svgSize} from './sniff.js';

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
// The difference view: a pixel changed when any channel moved by more than
// this, so a lossy re-encode's noise does not light up the whole picture.
const CHANGE_THRESHOLD = 8;
// The after image under the marks keeps 45% of its brightness, and a
// changed pixel is 60% of this tint over it.
const DIFF_KEEP = 0.45;
const DIFF_TINT = [0xd2, 0xa8, 0xff] as const;
const DIFF_TINT_WEIGHT = 0.6;
const MAX_SVG_DENSITY = 2400;
// Every frame of an animation is decoded at once, so their pixels together
// stay under this.
const MAX_ANIMATION_PIXELS = 16_000_000;
// A frame shown 10 ms or less is shown for 100 ms, as browsers do.
const SHORT_FRAME_MS = 10;
const SHORT_FRAME_SHOWN_MS = 100;
export const ANIMATION_TOO_LARGE = 'animation too large';
// Block previews show transparency over the dark pane colour of the
// mockups; a terminal cell has one colour per half, with no alpha.
const BLOCK_BACKGROUND = [0x0d, 0x11, 0x17] as const;

// An SVG is drawn at a density (dots per inch, where 72 is its own size) that
// makes it `drawW` pixels wide, so it is never drawn small and scaled up;
// within librsvg's range. libvips applies the density to a physical size
// twice, as librsvg's dots per inch and again as a zoom, so that size grows
// with the density's square: a linear density would overshoot the box many
// times over and can pass the pixel cap.
export function svgDensity(info: Partial<Pick<Sniffed, 'format' | 'width'>> & {physical?: boolean}, drawW: number): {density?: number} {
  if (info.format !== 'svg' || !info.width) return {};
  const ratio = drawW / info.width;
  return {density: Math.min(MAX_SVG_DENSITY, Math.max(1, 72 * (info.physical ? Math.sqrt(ratio) : ratio)))};
}

// Imported on first use, in the worker only: the library is large, slow to
// load, and native.
const defaultLoader: SharpLoader = async () => (await import('sharp')).default;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

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

type RawImage = {data: Buffer; width: number; height: number};

// The difference of two decoded RGBA images aligned top-left on a canvas of
// the larger width and height. A pixel only one side covers counts against
// transparency, so sizes that differ show as change. Two pixels that are both
// transparent, or within the threshold of it, look the same whatever colour
// they hold, and PNG optimizers rewrite that colour freely, so only their
// alpha is compared.
export function differenceImage(before: RawImage, after: RawImage): RawImage & {changedRatio: number; hasAlpha: boolean} {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const data = Buffer.alloc(width * height * 4);
  const empty = [0, 0, 0, 0];
  let changed = 0;
  let hasAlpha = false;
  const channelOf = (at: number, pixels: Buffer, channel: number) => (at < 0 ? empty[channel]! : pixels[at + channel]!);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = x < before.width && y < before.height ? (y * before.width + x) * 4 : -1;
      const b = x < after.width && y < after.height ? (y * after.width + x) * 4 : -1;
      const invisible = channelOf(a, before.data, 3) <= CHANGE_THRESHOLD && channelOf(b, after.data, 3) <= CHANGE_THRESHOLD;
      let differs = false;
      for (let channel = invisible ? 3 : 0; channel < 4 && !differs; channel += 1) {
        differs = Math.abs(channelOf(a, before.data, channel) - channelOf(b, after.data, channel)) > CHANGE_THRESHOLD;
      }
      const at = (y * width + x) * 4;
      const alpha = b < 0 ? 0 : after.data[b + 3]!;
      for (let channel = 0; channel < 3; channel += 1) {
        const dark = (b < 0 ? 0 : after.data[b + channel]!) * DIFF_KEEP;
        // Marked over the darkened pixel as it shows on black, so a mark on
        // a transparent pixel is the tint itself.
        data[at + channel] = Math.round(differs ? dark * (alpha / 255) * (1 - DIFF_TINT_WEIGHT) + DIFF_TINT[channel]! * DIFF_TINT_WEIGHT : dark);
      }
      data[at + 3] = differs ? 255 : alpha;
      if (differs) changed += 1;
      else if (alpha < 255) hasAlpha = true;
    }
  }
  return {data, width, height, changedRatio: changed / (width * height), hasAlpha};
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

  // The source is encoded bytes, or a raw RGBA image made here (the
  // difference view).
  type Source = {bytes: Buffer} | {raw: RawImage};
  type SourceInfo = Pick<Sniffed, 'hasAlpha'> & Partial<Pick<Sniffed, 'format' | 'width'>> & {physical?: boolean};

  // The source drawn at its picture size as RGBA, the first step of both a
  // PNG and a block preview. An SVG is drawn at the size the box needs, so
  // its edges stay sharp.
  async function drawPicture(sharp: SharpFactory, source: Source, info: SourceInfo, drawW: number, drawH: number, nearest: boolean) {
    // The input is always a buffer, never a path; one page, so an animation
    // shows its first frame.
    const input = 'bytes' in source
      ? sharp(source.bytes, {limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1, ...svgDensity(info, drawW)})
      : sharp(source.raw.data, {limitInputPixels: MAX_PIXELS, raw: {width: source.raw.width, height: source.raw.height, channels: 4}});
    // An SVG whose stated size the sniff could not read (em, say) draws at
    // another shape than its box: it keeps its own, letterboxed on clear
    // pixels, rather than being stretched.
    const fit = info.format === 'svg' ? {fit: 'contain' as const, background: {r: 0, g: 0, b: 0, alpha: 0}} : {fit: 'fill' as const};
    return input
      .timeout({seconds: DECODE_TIMEOUT_S})
      .resize(drawW, drawH, {...fit, kernel: nearest ? 'nearest' : 'lanczos3'})
      .ensureAlpha()
      .raw()
      .toBuffer();
  }

  async function fitOnce(sharp: SharpFactory, source: Source, info: SourceInfo, target: RenderTarget, checker: boolean, scale: number) {
    const canvasW = Math.max(1, Math.round(target.cols * target.cellPx.w * scale));
    const canvasH = Math.max(1, Math.round(target.rows * target.cellPx.h * scale));
    const drawW = Math.min(canvasW, Math.max(1, Math.round(target.drawPx.w * scale)));
    const drawH = Math.min(canvasH, Math.max(1, Math.round(target.drawPx.h * scale)));

    const resized = await drawPicture(sharp, source, info, drawW, drawH, target.nearest);

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

  /**
   * The source as block preview cells: one pixel per column and two per row
   * of `target`'s cols × rows, the picture centred at `drawPx` and the rest
   * clear, transparency flattened onto the pane colour.
   */
  async function blockCells(sharp: SharpFactory, source: Source, info: SourceInfo, target: RenderTarget) {
    const cols = Math.max(1, target.cols);
    const rows = Math.max(1, target.rows);
    const drawW = Math.min(cols, Math.max(1, Math.round(target.drawPx.w)));
    const drawH = Math.min(rows * 2, Math.max(1, Math.round(target.drawPx.h)));
    const picture = await drawPicture(sharp, source, info, drawW, drawH, target.nearest);

    const cells = new Uint32Array(cols * rows * 2).fill(CLEAR_PIXEL);
    const left = Math.floor((cols - drawW) / 2);
    const top = Math.floor((rows * 2 - drawH) / 2);
    for (let y = 0; y < drawH; y += 1) {
      for (let x = 0; x < drawW; x += 1) {
        const at = (y * drawW + x) * 4;
        const alpha = picture[at + 3]! / 255;
        let rgb = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          rgb = (rgb << 8) | Math.round(picture[at + channel]! * alpha + BLOCK_BACKGROUND[channel]! * (1 - alpha));
        }
        const py = top + y;
        cells[((py >> 1) * cols + left + x) * 2 + (py & 1)] = rgb;
      }
    }
    return {ok: true as const, cells, cols, rows};
  }

  async function fitSource(sharp: SharpFactory, source: Source, info: SourceInfo, target: RenderTarget, checker: boolean) {
    let scale = 1;
    let png = await fitOnce(sharp, source, info, target, checker, scale);
    for (let shrink = 0; shrink < MAX_SHRINKS && png.byteLength > MAX_PNG_BYTES; shrink += 1) {
      scale *= SHRINK;
      png = await fitOnce(sharp, source, info, target, checker, scale);
    }
    return png;
  }

  /** The image fitted into its box as a padded PNG. */
  async function fit(bytes: Buffer, info: Sniffed, target: RenderTarget, checker: boolean): Promise<RenderResult> {
    const loaded = await sharpOrReason();
    if ('reason' in loaded) return {ok: false, state: 'unavailable', reason: loaded.reason};

    try {
      const physical = info.format === 'svg' && Boolean(svgSize(bytes)?.physical);
      return {ok: true, png: await fitSource(loaded.sharp, {bytes}, {...info, physical}, target, checker)};
    } catch {
      // A corrupt file, or one caught half-written: tried again only when its
      // content id changes.
      return {ok: false, state: 'error', reason: 'could not decode image'};
    }
  }

  /**
   * An animated image fitted into its box frame by frame, every frame the
   * same padded size, with each frame's delay. Past `limits` (frames, PNG
   * bytes) or the decoded pixel cap, the first frame alone with a note.
   */
  async function fitAnimated(bytes: Buffer, info: Sniffed, target: RenderTarget, checker: boolean, limits: {max: number; maxBytes: number}): Promise<RenderResult> {
    const loaded = await sharpOrReason();
    if ('reason' in loaded) return {ok: false, state: 'unavailable', reason: loaded.reason};
    const {sharp} = loaded;
    const still = async () => {
      const first = await fit(bytes, info, target, checker);
      return first.ok ? {...first, note: ANIMATION_TOO_LARGE} : first;
    };

    try {
      const meta = await sharp(bytes, {limitInputPixels: MAX_PIXELS, failOn: 'error', pages: -1}).metadata();
      const pages = meta.pages ?? 1;
      const width = meta.width ?? 0;
      const pageHeight = meta.pageHeight ?? meta.height ?? 0;
      if (pages < 2) return await fit(bytes, info, target, checker);
      if (pages > limits.max || pages * width * pageHeight > MAX_ANIMATION_PIXELS) return await still();

      const {data} = await sharp(bytes, {limitInputPixels: MAX_ANIMATION_PIXELS, failOn: 'error', pages: -1})
        .timeout({seconds: DECODE_TIMEOUT_S})
        .ensureAlpha()
        .raw()
        .toBuffer({resolveWithObject: true});
      const frameBytes = width * pageHeight * 4;
      const delays = meta.delay ?? [];
      const delayOf = (page: number) => {
        const delay = delays[page] ?? SHORT_FRAME_SHOWN_MS;
        return delay <= SHORT_FRAME_MS ? SHORT_FRAME_SHOWN_MS : delay;
      };
      const drawn: Uint8Array[] = [];
      let total = 0;
      for (let page = 0; page < pages; page += 1) {
        const raw = {data: data.subarray(page * frameBytes, (page + 1) * frameBytes), width, height: pageHeight};
        // Every frame at full scale, so all of them share the first one's
        // size; a frame too large to send makes the whole animation so.
        const png = await fitOnce(sharp, {raw}, {hasAlpha: info.hasAlpha}, target, checker, 1);
        total += png.byteLength;
        if (png.byteLength > MAX_PNG_BYTES || total > limits.maxBytes) return await still();
        drawn.push(png);
      }
      const animation: Animation = {
        firstDelayMs: delayOf(0),
        frames: drawn.slice(1).map((png, index) => ({png, delayMs: delayOf(index + 1)})),
      };
      return {ok: true, png: drawn[0]!, animation};
    } catch {
      return {ok: false, state: 'error', reason: 'could not decode image'};
    }
  }

  /**
   * The image drawn at its own sniffed size as a plain PNG, with no padding
   * or checkerboard: the copy a viewer opens in place of an SVG.
   */
  async function picture(bytes: Buffer, info: Sniffed): Promise<{ok: true; png: Buffer} | JobFailure> {
    const loaded = await sharpOrReason();
    if ('reason' in loaded) return {ok: false, state: 'unavailable', reason: loaded.reason};

    try {
      const physical = info.format === 'svg' && Boolean(svgSize(bytes)?.physical);
      const size = {w: info.width, h: info.height};
      const target = {cols: size.w, rows: size.h, cellPx: {w: 1, h: 1}, drawPx: size, nearest: false};
      return {ok: true, png: await fitOnce(loaded.sharp, {bytes}, {...info, physical}, target, false, 1)};
    } catch {
      return {ok: false, state: 'error', reason: 'could not decode image'};
    }
  }

  // Both sides decoded and compared, or why they could not be.
  async function decodedDifference(sharp: SharpFactory, before: Buffer, after: Buffer): Promise<ReturnType<typeof differenceImage> | JobFailure> {
    const decode = async (bytes: Buffer): Promise<RawImage> => {
      const {data, info} = await sharp(bytes, {limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1})
        .timeout({seconds: DECODE_TIMEOUT_S})
        .ensureAlpha()
        .raw()
        .toBuffer({resolveWithObject: true});
      return {data, width: info.width, height: info.height};
    };
    const [left, right] = await Promise.all([decode(before), decode(after)]);
    // Each side passed the pixel cap; their combined canvas must too.
    const width = Math.max(left.width, right.width);
    const height = Math.max(left.height, right.height);
    if (width * height > MAX_PIXELS) return {ok: false, state: 'error', reason: `image too large to preview (${width} × ${height})`};
    return differenceImage(left, right);
  }

  /**
   * The two sides' difference fitted into its box, with the share of the
   * canvas that changed. `target` is fitted to the larger canvas.
   */
  async function difference(before: Buffer, after: Buffer, target: RenderTarget, checker: boolean): Promise<RenderResult> {
    const loaded = await sharpOrReason();
    if ('reason' in loaded) return {ok: false, state: 'unavailable', reason: loaded.reason};

    try {
      const diff = await decodedDifference(loaded.sharp, before, after);
      if ('ok' in diff) return diff;
      const png = await fitSource(loaded.sharp, {raw: diff}, diff, target, checker);
      return {ok: true, png, changedRatio: diff.changedRatio};
    } catch {
      // A corrupt file, or one caught half-written: tried again only when its
      // content id changes.
      return {ok: false, state: 'error', reason: 'could not decode image'};
    }
  }

  /** The image as block preview cells. */
  async function blocks(bytes: Buffer, info: Sniffed, target: RenderTarget): Promise<RenderResult> {
    const loaded = await sharpOrReason();
    if ('reason' in loaded) return {ok: false, state: 'unavailable', reason: loaded.reason};

    try {
      const physical = info.format === 'svg' && Boolean(svgSize(bytes)?.physical);
      return await blockCells(loaded.sharp, {bytes}, {...info, physical}, target);
    } catch {
      return {ok: false, state: 'error', reason: 'could not decode image'};
    }
  }

  /** The two sides' difference as block preview cells, with the share that changed. */
  async function blocksDifference(before: Buffer, after: Buffer, target: RenderTarget): Promise<RenderResult> {
    const loaded = await sharpOrReason();
    if ('reason' in loaded) return {ok: false, state: 'unavailable', reason: loaded.reason};

    try {
      const diff = await decodedDifference(loaded.sharp, before, after);
      if ('ok' in diff) return diff;
      return {...await blockCells(loaded.sharp, {raw: diff}, diff, target), changedRatio: diff.changedRatio};
    } catch {
      return {ok: false, state: 'error', reason: 'could not decode image'};
    }
  }

  /**
   * A strip past the transmit cap, drawn again smaller the way `fitSource`
   * does: the whole canvas shrinks, so the terminal scales it back into the
   * same cells and every frame keeps its place.
   */
  async function underTransmitCap(sharp: SharpFactory, png: Buffer, width: number, height: number) {
    let scale = 1;
    let smaller = png;
    for (let shrink = 0; shrink < MAX_SHRINKS && smaller.byteLength > MAX_PNG_BYTES; shrink += 1) {
      scale *= SHRINK;
      smaller = await sharp(png)
        .resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), {fit: 'fill', kernel: 'lanczos3'})
        .png({compressionLevel: 6})
        .toBuffer();
    }
    return smaller;
  }

  /**
   * A video's frames side by side as one strip: each letterboxed on black
   * into its `framePx` box, `gapCols` cells apart, on a clear canvas of
   * exactly `cols` × `rows` cells. A frame that could not be read (null, or
   * bytes that are not a PNG) is a dim tile with an ×. As block cells when
   * `blocks`, with `cellPx` then one pixel by two.
   */
  async function videoStrip(
    frames: ReadonlyArray<Uint8Array | null>,
    strip: {cols: number; rows: number; cellPx: {w: number; h: number}; framePx: {w: number; h: number}; gapCols: number},
    blocks: boolean,
  ): Promise<{ok: true; png: Buffer} | {ok: true; cells: Uint32Array; cols: number; rows: number} | JobFailure> {
    const loaded = await sharpOrReason();
    if ('reason' in loaded) return {ok: false, state: 'unavailable', reason: loaded.reason};
    const {sharp} = loaded;
    const width = Math.max(1, strip.cols * strip.cellPx.w);
    const height = Math.max(1, strip.rows * strip.cellPx.h);
    const frameW = Math.max(1, Math.min(width, Math.round(strip.framePx.w)));
    const frameH = Math.max(1, Math.min(height, Math.round(strip.framePx.h)));

    const failedTile = () => {
      const size = Math.max(2, Math.floor(Math.min(frameW, frameH) / 4));
      const [x0, y0] = [Math.floor((frameW - size) / 2), Math.floor((frameH - size) / 2)];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frameW}" height="${frameH}"><rect width="${frameW}" height="${frameH}" fill="#1b2129"/>`
        + `<path d="M${x0} ${y0}L${x0 + size} ${y0 + size}M${x0 + size} ${y0}L${x0} ${y0 + size}" stroke="#6e7681" stroke-width="${Math.max(1, Math.round(size / 8))}"/></svg>`;
      return sharp(Buffer.from(svg)).png().toBuffer();
    };
    const tileOf = async (png: Uint8Array | null) => {
      if (!png || !isPng(png)) return failedTile();
      try {
        return await sharp(png, {limitInputPixels: MAX_PIXELS, failOn: 'error'})
          .timeout({seconds: DECODE_TIMEOUT_S})
          .resize(frameW, frameH, {fit: 'contain', background: {r: 0, g: 0, b: 0, alpha: 1}})
          .png()
          .toBuffer();
      } catch {
        return failedTile();
      }
    };

    try {
      const layers = [];
      for (const [index, png] of frames.entries()) {
        const left = index * (frameW + strip.gapCols * strip.cellPx.w);
        if (left + frameW > width) break;
        layers.push({input: await tileOf(png), left, top: 0});
      }
      const png = await sharp({create: {width, height, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}})
        .composite(layers)
        .png({compressionLevel: 6})
        .toBuffer();
      if (!blocks) return {ok: true, png: await underTransmitCap(sharp, png, width, height)};
      return await blockCells(sharp, {bytes: png}, {hasAlpha: true, format: 'png'}, {cols: strip.cols, rows: strip.rows, cellPx: strip.cellPx, drawPx: {w: width, h: height}, nearest: false});
    } catch {
      return {ok: false, state: 'error', reason: 'could not draw the frames'};
    }
  }

  return {fit, fitAnimated, videoStrip, picture, difference, blocks, blocksDifference, available: async () => !('reason' in await sharpOrReason())};
}

export type Renderer = ReturnType<typeof createRenderer>;
