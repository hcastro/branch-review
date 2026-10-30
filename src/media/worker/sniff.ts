import {formatLabel} from '../layout.js';
import type {MediaFormat} from '../types.js';

// What an image is, from its header bytes alone: format by magic (for an SVG,
// its root element), pixel size, frame count and whether it can be
// transparent. Nothing is decoded, so a hostile header is refused before any
// decoder sees it. Pure.

export type Sniffed = {ok: true; format: MediaFormat; width: number; height: number; frames: number; hasAlpha: boolean; durationMs?: number};
export type SniffResult = Sniffed | {ok: false; reason: string};

// Larger sides or pixel counts are refused before decoding.
export const MAX_SIDE_PX = 16_384;
export const MAX_PIXELS = 64_000_000;
// Frame counts past this are not worth scanning for.
const MAX_FRAMES = 256;
// Headers that hold the size sit near the start; scans stop here.
const HEADER_SCAN_BYTES = 64 * 1024;

const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
const u32le = (bytes: Uint8Array, at: number) => (u16le(bytes, at) + u16le(bytes, at + 2) * 65536);
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Header = {width: number; height: number; frames: number; hasAlpha: boolean; durationMs?: number} | null;

// Browsers show a GIF frame of 10 ms or less for 100 ms, and so do we.
const MIN_GIF_DELAY_MS = 20;
const SHORT_GIF_DELAY_MS = 100;

// An animation's total duration, from per-frame delays; none for a still.
function withDuration(header: NonNullable<Header>, delays: number[]): NonNullable<Header> {
  return header.frames > 1 ? {...header, durationMs: delays.reduce((sum, delay) => sum + delay, 0)} : header;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]) {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** The image format the bytes start with, or null. */
export function magicFormat(bytes: Uint8Array): MediaFormat | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'gif';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const boxSize = Math.min(u32be(bytes, 0), bytes.length, 256);
    for (let at = 8; at + 4 <= boxSize; at += 4) {
      if (at === 12) continue; // minor version
      const brand = ascii(bytes, at, 4);
      if (brand === 'avif' || brand === 'avis') return 'avif';
    }
  }
  return null;
}

function png(bytes: Uint8Array): Header {
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  const colorType = bytes[25]!;
  let hasAlpha = colorType === 4 || colorType === 6;
  let frames = 1;
  // Chunks before the image data: `acTL` makes an APNG, `tRNS` adds alpha.
  let at = 8;
  while (at + 8 <= Math.min(bytes.length, HEADER_SCAN_BYTES)) {
    const length = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'acTL' && at + 12 <= bytes.length) frames = Math.max(1, Math.min(MAX_FRAMES, u32be(bytes, at + 8)));
    if (type === 'tRNS') hasAlpha = true;
    at += 12 + length;
  }
  return {width: u32be(bytes, 16), height: u32be(bytes, 20), frames, hasAlpha};
}

// Skips GIF data sub-blocks from `at`; returns the offset after the terminator.
function skipSubBlocks(bytes: Uint8Array, at: number) {
  let offset = at;
  while (offset < bytes.length) {
    const size = bytes[offset]!;
    offset += 1;
    if (size === 0) return offset;
    offset += size;
  }
  return -1;
}

function gif(bytes: Uint8Array): Header {
  if (bytes.length < 13) return null;
  const flags = bytes[10]!;
  let at = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  let frames = 0;
  let hasAlpha = false;
  // The delay the last graphic control extension set, for the next frame.
  let delay = 0;
  const delays: number[] = [];
  while (at >= 0 && at < bytes.length && frames < MAX_FRAMES) {
    const introducer = bytes[at]!;
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      // Graphic control extension: its transparency flag and frame delay,
      // in hundredths of a second.
      if (bytes[at + 1] === 0xf9) {
        if (bytes[at + 3]! & 1) hasAlpha = true;
        if (at + 5 < bytes.length) delay = u16le(bytes, at + 4) * 10;
      }
      at = skipSubBlocks(bytes, at + 2);
    } else if (introducer === 0x2c) {
      frames += 1;
      delays.push(delay < MIN_GIF_DELAY_MS ? SHORT_GIF_DELAY_MS : delay);
      delay = 0;
      const local = bytes[at + 9] ?? 0;
      at += 10 + (local & 0x80 ? 3 * (1 << ((local & 7) + 1)) : 0) + 1;
      at = skipSubBlocks(bytes, at);
    } else {
      break;
    }
  }
  return withDuration({width: u16le(bytes, 6), height: u16le(bytes, 8), frames: Math.max(1, frames), hasAlpha}, delays);
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(bytes: Uint8Array): Header {
  let at = 2;
  for (let segments = 0; segments < 4096 && at + 4 <= bytes.length; segments += 1) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // Start of scan before any frame header: no size to read.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = u16be(bytes, at + 2);
    if (SOF_MARKERS.has(marker)) {
      if (at + 9 > bytes.length) return null;
      return {width: u16be(bytes, at + 7), height: u16be(bytes, at + 5), frames: 1, hasAlpha: false};
    }
    at += 2 + length;
  }
  return null;
}

function webp(bytes: Uint8Array): Header {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff, frames: 1, hasAlpha: false};
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const bits = u32le(bytes, 21);
    return {width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, frames: 1, hasAlpha: Boolean((bits >>> 28) & 1)};
  }
  if (chunk === 'VP8X') {
    const flags = bytes[20]!;
    let frames = 1;
    const delays: number[] = [];
    if (flags & 0x02) {
      frames = 0;
      let at = 12;
      while (at + 8 <= bytes.length && frames < MAX_FRAMES) {
        const size = u32le(bytes, at + 4);
        if (ascii(bytes, at, 4) === 'ANMF') {
          frames += 1;
          // The frame's duration in ms follows its offset and size.
          if (at + 23 <= bytes.length) delays.push(u24le(bytes, at + 20));
        }
        at += 8 + size + (size & 1);
      }
      frames = Math.max(1, frames);
    }
    return withDuration({width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1, frames, hasAlpha: Boolean(flags & 0x10)}, delays);
  }
  return null;
}

function indexOfAscii(bytes: Uint8Array, text: string, from = 0, end = bytes.length) {
  const first = text.charCodeAt(0);
  outer: for (let at = from; at + text.length <= end; at += 1) {
    if (bytes[at] !== first) continue;
    for (let index = 1; index < text.length; index += 1) {
      if (bytes[at + index] !== text.charCodeAt(index)) continue outer;
    }
    return at;
  }
  return -1;
}

function avif(bytes: Uint8Array): Header {
  // Every item (the picture, an alpha plane, a thumbnail) has an `ispe`
  // size; the picture is the largest.
  const end = Math.min(bytes.length, HEADER_SCAN_BYTES);
  let width = 0;
  let height = 0;
  for (let at = indexOfAscii(bytes, 'ispe', 0, end); at >= 0 && at + 16 <= end; at = indexOfAscii(bytes, 'ispe', at + 4, end)) {
    const w = u32be(bytes, at + 8);
    const h = u32be(bytes, at + 12);
    if (w * h > width * height) {
      width = w;
      height = h;
    }
  }
  if (!width || !height) return null;
  const hasAlpha = indexOfAscii(bytes, 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha', 0, end) >= 0;
  return {width, height, frames: 1, hasAlpha};
}

// The size a browser gives an SVG that states none.
const SVG_DEFAULT = {width: 300, height: 150};
// The root element must start this close to the beginning of the file.
const SVG_ROOT_WITHIN = 4096;

// Skips what may come before an SVG's root element: a byte order mark,
// white space, an XML declaration or other processing instruction, comments
// and a doctype (with its internal subset). The offset of the root's `<`, or
// -1 when something else comes first.
function svgRootAt(text: string) {
  let at = text.startsWith('\u00ef\u00bb\u00bf') ? 3 : 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at]!)) at += 1;
    if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end < 0) return -1;
      at = end + 2;
    } else if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0) return -1;
      at = end + 3;
    } else if (text.startsWith('<!DOCTYPE', at)) {
      const subset = text.indexOf('[', at);
      const close = text.indexOf('>', at);
      const subsetEnd = subset >= 0 && subset < close ? text.indexOf(']', subset) : -1;
      if (subset >= 0 && subset < close && subsetEnd < 0) return -1;
      const end = subsetEnd >= 0 ? text.indexOf('>', subsetEnd) : close;
      if (end < 0) return -1;
      at = end + 1;
    } else {
      return at;
    }
  }
}

// The root tag's attributes, up to its closing `>` (quotes respected). One
// pass over the tag, so a long hostile one costs no more than its length.
function svgRootAttributes(text: string, from: number) {
  const attributes = new Map<string, string>();
  let at = from;
  while (at < text.length) {
    const char = text[at]!;
    if (char === '>') return attributes;
    if (char === '"' || char === "'") {
      // A quoted value with no name before it: skipped whole, so a `>` in
      // it never ends the tag.
      const close = text.indexOf(char, at + 1);
      if (close < 0) return null;
      at = close + 1;
      continue;
    }
    const nameStart = at;
    while (at < text.length && /[\w:.-]/.test(text[at]!)) at += 1;
    if (at === nameStart) {
      at += 1;
      continue;
    }
    const name = text.slice(nameStart, at);
    let next = at;
    while (next < text.length && /\s/.test(text[next]!)) next += 1;
    if (text[next] !== '=') continue;
    next += 1;
    while (next < text.length && /\s/.test(text[next]!)) next += 1;
    const quote = text[next];
    // An unquoted value is not XML; what follows is read as more names.
    if (quote !== '"' && quote !== "'") {
      at = next;
      continue;
    }
    const close = text.indexOf(quote, next + 1);
    if (close < 0) return null;
    attributes.set(name, text.slice(next + 1, close));
    at = close + 1;
  }
  return null;
}

// librsvg's pixels per unit at its own density (72 dots to the inch).
const SVG_UNITS: Record<string, number> = {'': 1, px: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1, pc: 12};

// A length in librsvg's pixels: a plain number, px, or a physical unit, and
// whether it was physical. Relative units say nothing about pixels, so they
// count as unset. A value can be as long as the header scan, so it is trimmed
// and capped first, and the pattern has one way to match any string: a
// pattern with two, such as `\d*\.?\d+`, backtracks quadratically on a long
// run of digits.
const MAX_SVG_LENGTH_CHARS = 64;
function svgLength(value: string | undefined) {
  const trimmed = value?.trim();
  const match = trimmed === undefined || trimmed.length > MAX_SVG_LENGTH_CHARS
    ? null
    : /^\+?(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)\s*(px|in|cm|mm|pt|pc)?$/.exec(trimmed);
  const unit = match?.[2] ?? '';
  const number = match ? Number(match[1]) * SVG_UNITS[unit]! : NaN;
  return Number.isFinite(number) && number > 0 ? {px: number, physical: unit !== '' && unit !== 'px'} : undefined;
}

function svgViewBox(value: string | undefined) {
  const parts = value?.trim().split(/[\s,]+/).map(Number) ?? [];
  if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2]! <= 0 || parts[3]! <= 0) return undefined;
  return {width: parts[2]!, height: parts[3]!};
}

/**
 * The pixel size an SVG states on its root element, from width and height,
 * else the viewBox, else the browser default; never by parsing the document,
 * so nothing in it (entities, links) is read here. `physical` says the width
 * comes from a physical unit, which librsvg scales differently. Null when the
 * bytes are not an SVG.
 */
export function svgSize(bytes: Uint8Array) {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, HEADER_SCAN_BYTES)).toString('latin1');
  const root = svgRootAt(text.slice(0, SVG_ROOT_WITHIN));
  if (root < 0 || !/^<svg[\s/>]/.test(text.slice(root, root + 5))) return null;
  const attributes = svgRootAttributes(text, root + 4);
  if (!attributes) return null;

  const statedWidth = svgLength(attributes.get('width'));
  const statedHeight = svgLength(attributes.get('height'));
  let width = statedWidth?.px;
  let height = statedHeight?.px;
  const viewBox = svgViewBox(attributes.get('viewBox'));
  if (viewBox && width === undefined && height === undefined) {
    ({width, height} = viewBox);
  } else if (viewBox && height === undefined) {
    height = (width! * viewBox.height) / viewBox.width;
  } else if (viewBox && width === undefined) {
    width = (height! * viewBox.width) / viewBox.height;
  }
  return {
    width: Math.max(1, Math.round(width ?? SVG_DEFAULT.width)),
    height: Math.max(1, Math.round(height ?? SVG_DEFAULT.height)),
    physical: Boolean(statedWidth ? statedWidth.physical : width !== undefined && statedHeight?.physical),
  };
}

function svg(bytes: Uint8Array): Header {
  const size = svgSize(bytes);
  if (!size) return null;
  // Whatever the document does not paint is transparent.
  return {width: size.width, height: size.height, frames: 1, hasAlpha: true};
}

const READERS: Partial<Record<MediaFormat, (bytes: Uint8Array) => Header>> = {png, gif, jpeg, webp, avif, svg};

/** What a file whose bytes are not the format its name says reads. */
export function notFormatReason(format: MediaFormat) {
  return `not ${format === 'svg' ? 'an' : 'a'} ${formatLabel(format)} image`;
}

/** Whether the bytes are the format the name says: magic bytes, or an SVG root near the start. */
export function isFormat(bytes: Uint8Array, format: MediaFormat) {
  return format === 'svg' ? svg(bytes) !== null : magicFormat(bytes) === format;
}

/**
 * The header facts of a raster the extension says is `expected`. Bytes of
 * another format are refused, never guessed at, and so is a size too large
 * to decode safely.
 */
export function sniffImage(bytes: Uint8Array, expected: MediaFormat): SniffResult {
  const read = READERS[expected];
  if (!read || (expected !== 'svg' && magicFormat(bytes) !== expected)) return {ok: false, reason: notFormatReason(expected)};
  const header = read(bytes);
  // An SVG has no magic bytes: its root element is the proof.
  if (!header && expected === 'svg') return {ok: false, reason: notFormatReason(expected)};
  if (!header || header.width < 1 || header.height < 1) return {ok: false, reason: 'could not read the image size'};
  if (header.width > MAX_SIDE_PX || header.height > MAX_SIDE_PX || header.width * header.height > MAX_PIXELS) {
    return {ok: false, reason: `image too large to preview (${header.width} × ${header.height})`};
  }
  return {ok: true, format: expected, ...header};
}
