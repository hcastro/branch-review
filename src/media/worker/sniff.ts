import {formatLabel} from '../layout.js';
import type {MediaFormat} from '../types.js';

// What an image is, from its header bytes alone: format by magic, pixel size,
// frame count and whether it can be transparent. Nothing is decoded, so a
// hostile header is refused before any decoder sees it. Pure.

export type Sniffed = {ok: true; format: MediaFormat; width: number; height: number; frames: number; hasAlpha: boolean};
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

type Header = {width: number; height: number; frames: number; hasAlpha: boolean} | null;

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
  while (at >= 0 && at < bytes.length && frames < MAX_FRAMES) {
    const introducer = bytes[at]!;
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      // Graphic control extension: its transparency flag.
      if (bytes[at + 1] === 0xf9 && (bytes[at + 3]! & 1)) hasAlpha = true;
      at = skipSubBlocks(bytes, at + 2);
    } else if (introducer === 0x2c) {
      frames += 1;
      const local = bytes[at + 9] ?? 0;
      at += 10 + (local & 0x80 ? 3 * (1 << ((local & 7) + 1)) : 0) + 1;
      at = skipSubBlocks(bytes, at);
    } else {
      break;
    }
  }
  return {width: u16le(bytes, 6), height: u16le(bytes, 8), frames: Math.max(1, frames), hasAlpha};
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
    if (flags & 0x02) {
      frames = 0;
      let at = 12;
      while (at + 8 <= bytes.length && frames < MAX_FRAMES) {
        const size = u32le(bytes, at + 4);
        if (ascii(bytes, at, 4) === 'ANMF') frames += 1;
        at += 8 + size + (size & 1);
      }
      frames = Math.max(1, frames);
    }
    return {width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1, frames, hasAlpha: Boolean(flags & 0x10)};
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

const READERS: Partial<Record<MediaFormat, (bytes: Uint8Array) => Header>> = {png, gif, jpeg, webp, avif};

/**
 * The header facts of a raster the extension says is `expected`. Bytes of
 * another format are refused, never guessed at, and so is a size too large
 * to decode safely.
 */
export function sniffImage(bytes: Uint8Array, expected: MediaFormat): SniffResult {
  const read = READERS[expected];
  if (!read || magicFormat(bytes) !== expected) return {ok: false, reason: `not a ${formatLabel(expected)} image`};
  const header = read(bytes);
  if (!header || header.width < 1 || header.height < 1) return {ok: false, reason: 'could not read the image size'};
  if (header.width > MAX_SIDE_PX || header.height > MAX_SIDE_PX || header.width * header.height > MAX_PIXELS) {
    return {ok: false, reason: `image too large to preview (${header.width} × ${header.height})`};
  }
  return {ok: true, format: expected, ...header};
}
