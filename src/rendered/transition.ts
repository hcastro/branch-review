import {renderStyledCells, toStyledCells} from '../ui/text.js';
import type {Motion} from './motion.js';

// The in-pane crossing, as pure frames of one screen row at a time, from the
// time since `v`: the diff's text dissolves in its own colors, top to bottom
// (0 to 120 ms); each cell then takes the page's mean color there, and the
// glyphs thicken as the page's silhouette arrives (120 to 280 ms); an accent
// scanline sweeps down with the page's placeholder cells above it (280 to
// 520 ms); then the gutter's bars glow and settle (520 to 760 ms). Text
// cells only until the scanline passes, so nothing is drawn over a tile
// before the terminal has it. Over a slow link (SSH or tmux) there is no
// mosaic: the dissolved text holds in neutral shade.

export const DISSOLVE_END_MS = 120;
/** Where the crossing holds when the tiles on screen are not in the terminal yet. */
export const HOLD_MS = 280;
export const DEVELOP_END_MS = 520;
export const CROSSING_MS = 760;
const FRAME_MS = 40;
const GLOW_SETTLES_MS = 640;
const DISSOLVE = ['▓', '▒', '░'];
const DENSITY = ['░', '▒', '▒', '▓'];
const SCANLINE = '▀';
// A cell this close to the page background, summed over the channels, is background.
const BACKGROUND_DISTANCE = 36;

export type Rgb = readonly [number, number, number];
export type CrossingLink = 'local' | 'slow';

/** The row the page puts on this screen row: as it is drawn, and its tile's mean colors per cell, if it is a tile row. */
export type ArrivingRow = {drawn: string; mosaic: ReadonlyArray<Rgb | null> | null};

export type CrossingStyle = {width: number; rows: number; link: CrossingLink; accent: string; bg: Rgb; depth: 2 | 3};

/** Whether `v` plays the crossing: full motion with color on. Anything else swaps at once. */
export function crossingPlays(motion: Motion, color: boolean) {
  return motion === 'full' && color;
}

// How far a row has dissolved at `t`: 0 is its text, 3 the lightest shade.
// The wave crosses the screen in one frame, so the bottom row starts a
// frame after the top.
function dissolveStep(t: number, row: number, rows: number) {
  const offset = rows > 1 ? (row / (rows - 1)) * FRAME_MS : 0;
  return Math.max(0, Math.min(3, Math.floor((t - offset) / FRAME_MS) + 1));
}

// Every non-blank cell of `line` as the shade for `step`, in its own style,
// as wide as it was.
function dissolved(line: string, step: number) {
  if (step === 0) return line;
  const glyph = DISSOLVE[step - 1]!;
  return renderStyledCells(toStyledCells(line).flatMap((cell) => (cell.char.trim() === '' || cell.width === 0 ? [cell] : Array.from({length: cell.width}, () => ({char: glyph, width: 1, style: cell.style})))));
}

// The 256-color cube's nearest entry, for a terminal without 24-bit color.
function cube([r, g, b]: Rgb) {
  const step = (value: number) => Math.round((value / 255) * 5);
  return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

function mosaic(colors: ReadonlyArray<Rgb | null>, glyph: string, {width, bg, depth}: CrossingStyle) {
  let out = '';
  let last = '';
  for (let col = 0; col < width; col += 1) {
    const color = colors[col] ?? null;
    const blank = !color || Math.abs(color[0] - bg[0]) + Math.abs(color[1] - bg[1]) + Math.abs(color[2] - bg[2]) < BACKGROUND_DISTANCE;
    if (blank) {
      out += ' ';
      continue;
    }
    const code = depth === 3 ? `\u001B[38;2;${color[0]};${color[1]};${color[2]}m` : `\u001B[38;5;${cube(color)}m`;
    if (code !== last) out += code;
    last = code;
    out += glyph;
  }
  return `${out}\u001B[0m`;
}

function easeOutCubic(progress: number) {
  return 1 - (1 - progress) ** 3;
}

/** The screen row the scanline is on at `t`, from 0 at 280 ms down to `rows` at 520. */
export function scanRow(t: number, rows: number) {
  const progress = Math.max(0, Math.min(1, (t - HOLD_MS) / (DEVELOP_END_MS - HOLD_MS)));
  return Math.round(easeOutCubic(progress) * rows);
}

// Below the scanline, and while it waits: the page's own colors on a tile
// row, thickening, or the dissolved text in neutral shade.
function arriving(t: number, departing: string, row: ArrivingRow, style: CrossingStyle) {
  if (style.link === 'local' && row.mosaic) {
    const frame = Math.max(0, Math.min(DENSITY.length - 1, Math.floor((Math.min(t, HOLD_MS - 1) - DISSOLVE_END_MS) / FRAME_MS)));
    return mosaic(row.mosaic, DENSITY[frame]!, style);
  }
  return dissolved(departing, 3);
}

/**
 * Screen row `row` at `t`: `departing` is what it showed in the diff,
 * `arriving` what the page shows there.
 */
export function crossingLine(t: number, row: number, departing: string, arrivingRow: ArrivingRow, style: CrossingStyle): string {
  if (t < DISSOLVE_END_MS) return dissolved(departing, dissolveStep(t, row, style.rows));
  if (t < HOLD_MS) return arriving(t, departing, arrivingRow, style);
  if (t < DEVELOP_END_MS) {
    const scan = scanRow(t, style.rows);
    if (row < scan) return arrivingRow.drawn;
    if (row === scan) return `${style.accent}${SCANLINE.repeat(style.width)}\u001B[0m`;
    return arriving(t, departing, arrivingRow, style);
  }
  return arrivingRow.drawn;
}

/** How the gutter's bars draw at `t`: the accent, then their own bright color, then at rest (null). */
export function glowTone(t: number): 'accent' | 'bright' | null {
  if (t < DEVELOP_END_MS || t >= CROSSING_MS) return null;
  return t < GLOW_SETTLES_MS ? 'accent' : 'bright';
}
