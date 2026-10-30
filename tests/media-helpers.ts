import zlib from 'node:zlib';
import {KITTY_DIACRITICS} from '../src/media/kittyDiacritics.js';
import {NO_GRAPHICS, type GraphicsCaps, type SideInfo} from '../src/media/types.js';

// Media fixtures shared by the core and UI media tests: PNG bytes written by
// hand, Kitty caps, and readers for what the app sent to the terminal.

type Rgba = readonly [number, number, number, number];

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A valid RGBA PNG of `width` × `height`, one colour or a colour per pixel. */
export function pngFixture(width: number, height: number, rgba: Rgba | ((x: number, y: number) => Rgba) = [200, 40, 40, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = typeof rgba === 'function' ? rgba(x, y) : rgba;
      raw.set(pixel, row + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Just a PNG signature and an IHDR claiming `width` × `height`, with no pixels. */
export function pngHeaderOnly(width: number, height: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]);
}

export const KITTY_CAPS: GraphicsCaps = {
  ...NO_GRAPHICS,
  protocol: 'kitty',
  cellPx: {w: 10, h: 20},
  cellPxSource: 'csi16',
  colorDepth: 3,
  terminal: 'ghostty 1.3.2',
};

// A colour terminal without Kitty placeholders (Apple Terminal, say):
// pictures draw as coloured half blocks.
export const BLOCKS_CAPS: GraphicsCaps = {
  ...NO_GRAPHICS,
  protocol: 'blocks',
  cellPx: {w: 10, h: 20},
  cellPxSource: 'csi16',
  colorDepth: 3,
  terminal: 'Apple_Terminal',
};

export function sideInfo(overrides: Partial<SideInfo> = {}): SideInfo {
  return {oid: '97fa3ee'.padEnd(40, '0'), bytes: 232_000, format: 'png', width: 200, height: 100, frames: 1, hasAlpha: false, ...overrides};
}

/**
 * The codes of one SGR's parameter string, in order, each as its parameter
 * list: an extended colour (`38`, `48` or `58` with `5;N` or `2;r;g;b`) is one
 * code that carries its arguments, so `38;5;39` is a foreground of 39, never
 * a `39` reset. A colon form such as `48:2::r:g:b` is one code too, named by
 * its leading number.
 */
export function sgrCodes(params: string): string[][] {
  const parts = params.split(';');
  const codes: string[][] = [];
  for (let at = 0; at < parts.length; at += 1) {
    const part = parts[at]!;
    if (part.includes(':')) {
      codes.push(part.split(':'));
      continue;
    }
    const mode = parts[at + 1];
    if ((part === '38' || part === '48' || part === '58') && (mode === '5' || mode === '2')) {
      const length = mode === '5' ? 2 : 4;
      codes.push(parts.slice(at, at + 1 + length));
      at += length;
      continue;
    }
    codes.push([part]);
  }
  return codes;
}

/** The leading code of every SGR sequence in `text`, extended-colour arguments left out. */
export function sgrCodeNames(text: string): string[] {
  return [...text.matchAll(/\u001B\[([0-9;:]*)m/g)].flatMap((match) => sgrCodes(match[1]!).map((code) => code[0]!));
}

export type PlaceholderCell = {id: number; row: number; col: number; line: number; column: number};

const DIACRITIC_INDEX = new Map(KITTY_DIACRITICS.map((mark, index) => [mark, index]));

/**
 * Every Kitty placeholder cell in a frame: the image id from the active
 * `38;5;N` foreground, and the image row and column from the two marks.
 * `line` and `column` are where the cell sits on screen.
 */
export function decodePlaceholders(frame: string | undefined): PlaceholderCell[] {
  const cells: PlaceholderCell[] = [];
  for (const [lineIndex, line] of (frame ?? '').split('\n').entries()) {
    let id = 0;
    let column = 0;
    const chars = [...line];
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index]!;
      if (char === '\u001B') {
        const rest = chars.slice(index).join('');
        const match = /^\u001B\[([0-9;:]*)m/.exec(rest);
        if (match) {
          for (const [code, mode, value] of sgrCodes(match[1]!)) {
            if (code === '38') id = mode === '5' ? Number(value) : 0;
            else if (code === '39' || code === '0' || code === '') id = 0;
          }
          index += [...match[0]].length - 1;
          continue;
        }
        const other = /^\u001B(?:\[[0-9;:?]*[A-Za-z]|\][^\u0007]*\u0007)/.exec(rest);
        if (other) {
          index += [...other[0]].length - 1;
          continue;
        }
      }
      if (char === '\u{10EEEE}') {
        const row = DIACRITIC_INDEX.get(chars[index + 1] ?? '');
        const col = DIACRITIC_INDEX.get(chars[index + 2] ?? '');
        cells.push({id, row: row ?? -1, col: col ?? -1, line: lineIndex, column});
        index += 2;
        column += 1;
        continue;
      }
      if (/\p{Mn}/u.test(char)) continue;
      column += 1;
    }
  }
  return cells;
}

export type ApcCommand = {a?: string; i?: number; f?: number; q?: number; U?: number; c?: number; r?: number; m?: number; d?: string; t?: string; payloadBytes: number};

/** Every Kitty graphics command in the writes, with its keys and payload size. */
export function parseApc(writes: readonly string[]): ApcCommand[] {
  const commands: ApcCommand[] = [];
  for (const write of writes) {
    for (const match of write.matchAll(/\u001B_G([^;\u001B]*)(?:;([^\u001B]*))?\u001B\\/g)) {
      const command: ApcCommand = {payloadBytes: match[2]?.length ?? 0};
      for (const pair of match[1]!.split(',')) {
        const [key, value = ''] = pair.split('=');
        if (key === 'a' || key === 'd' || key === 't') command[key] = value;
        else if (key === 'i' || key === 'f' || key === 'q' || key === 'U' || key === 'c' || key === 'r' || key === 'm') command[key] = Number(value);
      }
      commands.push(command);
    }
  }
  return commands;
}
