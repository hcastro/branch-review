import {renderStyledCells, toStyledCells, type StyledCell} from '../ui/text.js';
import type {Motion} from './motion.js';

// The TUI half of the trip to a rendered page: the press on the button,
// then a shade band that sweeps the visible diff rows toward the split on
// the right. Pure frames of one row at a time, from the time since the
// press: text cells only, so the beam runs in any terminal and never
// touches a picture's placeholder rows. The caller draws the row as it is
// when a frame is null.

/** The band's whole sweep: eight frames of 40 ms. */
export const BEAM_MS = 320;
const FRAME_MS = 40;
const FRAMES = BEAM_MS / FRAME_MS;
/** How long the button shows it was pressed. */
export const PRESS_MS = 120;

const BAND = ['░', '▒', '▓', '▓', '▒', '░'];
const INVERSE = '\u001B[7m';
const RESET = '\u001B[0m';

// Each row starts up to three columns off its neighbors, so the band's
// edge reads as a wave. The same row always gets the same offset.
function rowOffset(row: number) {
  return (Math.imul(row + 1, 0x9e3779b1) >>> 30) % 4;
}

function easeInOutCubic(progress: number) {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

// Repaints the cells of `line` in columns [from, to) with `paint`, which
// gets each cell and its first column and returns the cells to draw there,
// as wide as it was. A wide character the range only partly covers goes to
// `paint` too, so no cell is ever left half drawn. With a `width`, the line
// is padded or cut to it first, and padding the range covers is painted.
function overlay(line: string, width: number | null, from: number, to: number, paint: (cell: StyledCell, column: number) => StyledCell[]) {
  const out: StyledCell[] = [];
  let column = 0;
  for (const cell of toStyledCells(line)) {
    if (width !== null && column + cell.width > width) break;
    const end = column + cell.width;
    out.push(...(end <= from || column >= to || cell.width === 0 ? [cell] : paint(cell, column)));
    column = end;
  }
  for (; width !== null && column < width; column += 1) {
    const blank = {char: ' ', width: 1, style: ''};
    out.push(...(column >= from && column < to ? paint(blank, column) : [blank]));
  }
  return renderStyledCells(restyle(out));
}

// renderStyledCells writes only what a cell's style adds to the one before
// it, which suits a parsed line, whose styles only grow until a reset. A
// painted cell breaks that: the cells after it would keep its inverse or
// its accent. So a cell whose style doesn't extend the one before starts
// over from a reset.
function restyle(cells: StyledCell[]) {
  let before = '';
  let written = '';
  return cells.map((cell) => {
    if (cell.style !== before) {
      const grows = cell.style === '' || cell.style.startsWith(RESET) || cell.style.startsWith(before);
      written = grows ? cell.style : `${RESET}${cell.style}`;
      before = cell.style;
    }
    return {...cell, style: written};
  });
}

/**
 * Row `row` of the diff, `tMs` after the press, with the band over it, or
 * null when there is no band to draw: before the press, after 320 ms, or
 * with no accent color (NO_COLOR).
 */
export function beamFrame(line: string, row: number, tMs: number, width: number, accent: string | null): string | null {
  if (accent === null || tMs < 0 || tMs >= BEAM_MS) return null;
  // The first frame has the band entering at the left edge, the last has
  // it leaving at the right.
  const frame = Math.floor(tMs / FRAME_MS);
  const start = Math.round(easeInOutCubic(frame / (FRAMES - 1)) * (width - BAND.length + 3)) - 3 + rowOffset(row);
  const style = `${RESET}${accent}`;
  // Columns of a wide character outside the band show as blanks.
  const glyph = (column: number) => BAND[column - start] ?? ' ';
  return overlay(line, width, start, start + BAND.length, (cell, column) => Array.from({length: cell.width}, (_, each) => {
    const char = glyph(column + each);
    return {char, width: 1, style: char === ' ' ? cell.style : style};
  }));
}

/**
 * The file header row with the Rendered button pressed, `tMs` after the
 * press, or null once the press is over. Full motion shows the button in
 * inverse; reduced motion shows one frame of `░` over it in place of the
 * beam. `span` is the button label's columns on the row.
 */
export function pressFrame(line: string, span: {start: number; end: number} | null, tMs: number, motion: Motion, accent: string | null): string | null {
  if (!span || motion === 'off' || tMs < 0 || tMs >= PRESS_MS) return null;
  if (motion === 'reduced') {
    const style = accent === null ? '' : `${RESET}${accent}`;
    return overlay(line, null, span.start, span.end, (cell) => Array.from({length: cell.width}, () => ({char: '░', width: 1, style})));
  }
  return overlay(line, null, span.start, span.end, (cell) => [{...cell, style: `${cell.style}${INVERSE}`}]);
}
