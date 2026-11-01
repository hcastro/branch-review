// What the worker does to a tile Chromium drew before it goes to the
// terminal: cut it to exactly the pixels its cells hold, since Chromium
// rounds a fractional clip to whole device pixels and a tile a pixel off
// would be scaled, and so blurred, by the terminal. With it, when asked, the
// mosaic: each cell's mean color, which the pane paints in shade glyphs
// while the page arrives. Both need sharp; without it a tile goes as
// Chromium drew it and there is no mosaic.

type SharpFactory = typeof import('sharp').default;
export type SharpLoader = () => Promise<SharpFactory>;

const defaultLoader: SharpLoader = async () => (await import('sharp')).default;

/**
 * The mean color of each of `cols` × `rows` cells of an RGBA image, as RGB
 * triples row by row. Pure.
 */
export function mosaicOf(raw: Uint8Array, width: number, height: number, cols: number, rows: number): Uint8Array {
  const sums = new Float64Array(cols * rows * 3);
  const counts = new Uint32Array(cols * rows);
  // Which cell each pixel column and row falls in, from the absolute
  // position, so a cell is never a pixel narrower than its neighbor's sum.
  const cellX = Uint32Array.from({length: width}, (_, x) => Math.min(cols - 1, Math.floor((x * cols) / width)));
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x += 1) {
      const cell = row * cols + cellX[x]!;
      const at = (y * width + x) * 4;
      sums[cell * 3] += raw[at]!;
      sums[cell * 3 + 1] += raw[at + 1]!;
      sums[cell * 3 + 2] += raw[at + 2]!;
      counts[cell] += 1;
    }
  }
  const out = new Uint8Array(cols * rows * 3);
  for (let cell = 0; cell < cols * rows; cell += 1) {
    const count = counts[cell] || 1;
    for (let channel = 0; channel < 3; channel += 1) out[cell * 3 + channel] = Math.round(sums[cell * 3 + channel]! / count);
  }
  return out;
}

function hexRgb(hex: string) {
  const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '111318';
  return {r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16)};
}

export function createTileFinisher(loadSharp: SharpLoader = defaultLoader) {
  let loading: Promise<SharpFactory | null> | null = null;
  const sharpOrNull = () => (loading ??= loadSharp().then((sharp) => {
    sharp.cache(false);
    return sharp;
  }, () => null));

  /**
   * The tile cut or padded to `width` × `height` from its top left, padding
   * in `bg`, and its mosaic of `cells` when asked. Rows and columns are
   * never scaled.
   */
  return async function finishTile(png: Uint8Array, {width, height, bg, cells}: {width: number; height: number; bg: string; cells?: {cols: number; rows: number}}): Promise<{png: Uint8Array; mosaic?: Uint8Array}> {
    const sharp = await sharpOrNull();
    if (!sharp) return {png};
    const meta = await sharp(png).metadata();
    let image = sharp(png).ensureAlpha();
    const cutW = Math.min(width, meta.width ?? width);
    const cutH = Math.min(height, meta.height ?? height);
    if (cutW !== meta.width || cutH !== meta.height) image = image.extract({left: 0, top: 0, width: cutW, height: cutH});
    const exact = cutW === width && cutH === height ? image : image.extend({right: width - cutW, bottom: height - cutH, background: {...hexRgb(bg), alpha: 1}});
    const raw = await exact.raw().toBuffer();
    const out = new Uint8Array(await sharp(raw, {raw: {width, height, channels: 4}}).png({compressionLevel: 6}).toBuffer());
    return cells ? {png: out, mosaic: mosaicOf(raw, width, height, cells.cols, cells.rows)} : {png: out};
  };
}
