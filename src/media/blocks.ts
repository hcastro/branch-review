// The block preview: a picture as colored half blocks, for terminals that
// cannot draw images. Each cell is `▀` with the top pixel as its foreground
// and the bottom pixel as its background, so one cell shows two pixels
// stacked. U+2580 is one cell wide everywhere and one slot in Ink's grid, so
// these rows survive anything drawn over or beside them.

// A pixel outside the picture (the padding of a box shared with a larger
// side): the terminal's own background shows there. Above any 24-bit color.
export const CLEAR_PIXEL = 0x1000000;

const UPPER = '▀';
const LOWER = '▄';
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const channels = (rgb: number) => [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff] as const;

function nearestLevel(value: number) {
  let best = 0;
  for (let index = 1; index < CUBE_LEVELS.length; index += 1) {
    if (Math.abs(CUBE_LEVELS[index]! - value) < Math.abs(CUBE_LEVELS[best]! - value)) best = index;
  }
  return best;
}

function distance(left: readonly number[], right: readonly number[]) {
  return left.reduce((sum, value, index) => sum + (value - right[index]!) ** 2, 0);
}

/** The nearest xterm 256-color index: the 6 × 6 × 6 cube or the 24 grays. */
export function xterm256(rgb: number): number {
  const color = channels(rgb);
  const [r, g, b] = color.map(nearestLevel) as [number, number, number];
  const cube = 16 + 36 * r + 6 * g + b;
  const cubeDistance = distance(color, [CUBE_LEVELS[r]!, CUBE_LEVELS[g]!, CUBE_LEVELS[b]!]);
  const average = (color[0] + color[1] + color[2]) / 3;
  const gray = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const level = 8 + 10 * gray;
  return distance(color, [level, level, level]) < cubeDistance ? 232 + gray : cube;
}

// One color's SGR parameters, foreground (38) or background (48); the
// default color when the pixel is clear.
function colorCode(base: 38 | 48, rgb: number, depth: 2 | 3) {
  if (rgb === CLEAR_PIXEL) return base === 38 ? '39' : '49';
  if (depth === 2) return `${base};5;${xterm256(rgb)}`;
  const [r, g, b] = channels(rgb);
  return `${base};2;${r};${g};${b}`;
}

/**
 * One ANSI string per cell row from the worker's cells (for each cell its
 * top pixel then its bottom pixel, `0xRRGGBB` or CLEAR_PIXEL), each exactly
 * `cols` cells wide. Colors that stay the same from one cell to the next
 * are not repeated, and a row that set any color ends with the defaults.
 */
export function blockRows(cells: Uint32Array, cols: number, rows: number, depth: 2 | 3): string[] {
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    let line = '';
    // The SGR parameters in effect; '39'/'49' are the terminal's defaults.
    let fg = '39';
    let bg = '49';
    for (let col = 0; col < cols; col += 1) {
      const at = (row * cols + col) * 2;
      const top = cells[at] ?? CLEAR_PIXEL;
      const bottom = cells[at + 1] ?? CLEAR_PIXEL;
      let char = UPPER;
      let nextFg = fg;
      let nextBg: string;
      if (top === CLEAR_PIXEL && bottom === CLEAR_PIXEL) {
        // A space shows only the background, so the foreground can stay.
        char = ' ';
        nextBg = '49';
      } else if (top === CLEAR_PIXEL) {
        char = LOWER;
        nextFg = colorCode(38, bottom, depth);
        nextBg = '49';
      } else {
        nextFg = colorCode(38, top, depth);
        nextBg = colorCode(48, bottom, depth);
      }
      const changes = [nextFg !== fg ? nextFg : '', nextBg !== bg ? nextBg : ''].filter(Boolean);
      if (changes.length > 0) line += `\u001B[${changes.join(';')}m`;
      fg = nextFg;
      bg = nextBg;
      line += char;
    }
    if (fg !== '39' || bg !== '49') line += '\u001B[39;49m';
    lines.push(line);
  }
  return lines;
}
