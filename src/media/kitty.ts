import {KITTY_DIACRITICS} from './kittyDiacritics.js';

// Kitty graphics protocol sequences, Unicode placeholder flavour. An image is
// transmitted once out of band and given a virtual placement of c × r cells;
// the app then draws it as ordinary text: one U+10EEEE per cell, its row and
// column carried by two combining marks and the image id by the cell's
// 256-colour foreground. Ink lays those cells out, clips and scrolls them
// like any other text, and a full-screen repaint redraws them without
// re-sending pixels.
//
// Every control key is a number this module checks; the only payload is the
// base64 of PNG bytes the media worker produced. No repo string ever reaches
// an escape.

const ESC = '\x1B';
const ST = `${ESC}\\`;
// The protocol's recommended chunk size for base64 payloads.
const CHUNK = 4096;
// The 256-colour foreground carries the id, so 0 (no id) and 256+ are out.
const MAX_ID = 255;
const MAX_CELLS = KITTY_DIACRITICS.length;
const MIN_FRAME_DELAY_MS = 20;

export const PLACEHOLDER = '\u{10EEEE}';

/** Asks whether the terminal speaks the protocol, with a 1×1 RGB image it does not keep. */
export const KITTY_QUERY = `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`;

function checkInteger(name: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${value}`);
  }
}

const checkId = (id: number) => checkInteger('image id', id, 1, MAX_ID);

export function apc(control: string, payload?: string) {
  return `${ESC}_G${control}${payload ? `;${payload}` : ''}${ST}`;
}

// The first command carries every key; the rest carry only `m` (more chunks
// follow) and `q`, so the terminal never answers any of them.
function chunked(firstKeys: string, data: Uint8Array) {
  const base64 = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
  let out = '';
  for (let offset = 0; offset === 0 || offset < base64.length; offset += CHUNK) {
    const more = offset + CHUNK < base64.length ? 1 : 0;
    const keys = offset === 0 ? `${firstKeys},q=2,m=${more}` : `m=${more},q=2`;
    out += apc(keys, base64.slice(offset, offset + CHUNK));
  }
  return out;
}

/** Transmits a PNG (the terminal decodes it, `f=100`), every chunk in one string for one write. */
export function transmitPng(id: number, png: Uint8Array) {
  checkId(id);
  return chunked(`a=t,f=100,t=d,i=${id}`, png);
}

/** A virtual placement of `cols` × `rows` cells, drawn wherever placeholder cells name the id. */
export function placeVirtual(id: number, cols: number, rows: number) {
  checkId(id);
  checkInteger('columns', cols, 1, MAX_CELLS);
  checkInteger('rows', rows, 1, MAX_CELLS);
  return apc(`a=p,U=1,i=${id},c=${cols},r=${rows},q=2`);
}

/** Deletes the image and frees its data. Uppercase `I`: never `d=A`, which would delete other programs' images. */
export function deleteImage(id: number) {
  checkId(id);
  return apc(`a=d,d=I,i=${id},q=2`);
}

/** One more animation frame for an image already transmitted. */
export function transmitFrame(id: number, png: Uint8Array, delayMs: number) {
  checkId(id);
  const delay = Math.max(MIN_FRAME_DELAY_MS, Math.round(Number.isFinite(delayMs) ? delayMs : 0));
  return chunked(`a=f,i=${id},f=100,z=${delay}`, png);
}

/** How long frame `frame` (1 is the first, the one `transmitPng` sent) shows before the next. */
export function frameGap(id: number, frame: number, delayMs: number) {
  checkId(id);
  checkInteger('frame', frame, 1, Number.MAX_SAFE_INTEGER);
  const delay = Math.max(MIN_FRAME_DELAY_MS, Math.round(Number.isFinite(delayMs) ? delayMs : 0));
  return apc(`a=a,i=${id},r=${frame},z=${delay},q=2`);
}

/** Runs the image's frames in a loop, driven by the terminal. */
export function startLoop(id: number) {
  checkId(id);
  return apc(`a=a,i=${id},s=3,v=1,q=2`);
}

/**
 * `cols` placeholder cells of image `id`'s row `row`, starting at column
 * `col0`. Both marks go on every cell, so cutting the run anywhere leaves
 * every remaining cell addressed.
 */
export function placeholderRun(id: number, row: number, col0: number, cols: number) {
  checkId(id);
  checkInteger('row', row, 0, MAX_CELLS - 1);
  checkInteger('first column', col0, 0, MAX_CELLS - 1);
  checkInteger('columns', cols, 1, MAX_CELLS - col0);
  const rowMark = KITTY_DIACRITICS[row]!;
  let cells = '';
  for (let column = col0; column < col0 + cols; column += 1) {
    cells += PLACEHOLDER + rowMark + KITTY_DIACRITICS[column]!;
  }
  return `${ESC}[38;5;${id}m${cells}${ESC}[39m`;
}

/** tmux passthrough: a DCS that tmux forwards to the outer terminal, with every ESC doubled. */
export function tmuxWrap(sequence: string) {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`;
}

const APC = /\x1B_G[^\x1B]*\x1B\\/g;

/**
 * Every graphics command in `sequence` wrapped for tmux on its own. tmux
 * caps the length of one passthrough, so a transmit of many chunks is sent
 * as many passthroughs, each one chunk long.
 */
export function tmuxPassthrough(sequence: string) {
  return sequence.replace(APC, (command) => tmuxWrap(command));
}
