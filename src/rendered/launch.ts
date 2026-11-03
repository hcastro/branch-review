import {renderStyledCells, toStyledCells, type StyledCell} from '../ui/text.js';
import {LEAVES_PANE} from './marks.js';
import type {Motion} from './motion.js';

// The TUI half of the trip to a rendered page, "send to browser": the
// diff's code dissolves in its own colors (0 to 160 ms), a teal to violet
// scanline sweeps up from the bottom (160 to 480 ms), and each row it
// passes lifts off as specks that fly up into the Review in browser
// button. They land at 640 ms, when a split opens and the button flares,
// and the code draws back in from the top (640 to 840 ms). The gutter's
// line numbers stay put throughout. Pure frames of the visible rows from
// the time since the press, 40 ms a frame: text cells only, so it runs in
// any terminal with color and never touches a picture's placeholder rows.
// A row the caller passes as null keeps still, and so does a frame's null
// row.

/** The whole trip, from the press to the diff drawn back. */
export const LAUNCH_MS = 840;
/** When the specks reach the button: a split opens with the page here. */
export const LAUNCH_LANDS_MS = 640;
/** How long the button shows it was pressed. */
export const PRESS_MS = 120;
/** The stripe that crosses the button once when the pointer comes onto it. */
export const SHIMMER_MS = 400;

const FRAME_MS = 40;
const DISSOLVE_END_MS = 160;
const SCAN_END_MS = 480;
const REPRINT_MS = 640;
const FLARE_FROM_MS = 600;
const FLARE_MS = 240;
const SHADES = ['▓', '▒', '░'];
const SCANLINE = '▄';
// A speck shrinks as it nears the button.
const SPECKS = ['⣿', '⠿', '⠶', '⠖', '⠒'];
const TRAIL = '⠂';

const RESET = '\u001B[0m';
const BOLD = '\u001B[1m';
const FAINT = '\u001B[2m';
const INVERSE = '\u001B[7m';

export type Rgb = readonly [number, number, number];
/** 1: 16 colors, 2: 256, 3: 24-bit. */
export type LaunchDepth = 1 | 2 | 3;

// branch-review's colors on a dark terminal: the banner's dark gradient.
export const BRAND_A: Rgb = [92, 209, 222];
export const BRAND_B: Rgb = [204, 170, 253];
const INK: Rgb = [13, 17, 23];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const u = Math.max(0, Math.min(1, amount));
  return [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * u)) as unknown as Rgb;
}

// The 256-color cube's nearest entry.
function cube([r, g, b]: Rgb) {
  const step = (value: number) => Math.round((value / 255) * 5);
  return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

/** The SGR for `rgb` as a foreground (38) or background (48) at `depth`. */
export function color(rgb: Rgb, depth: LaunchDepth, layer: 38 | 48 = 38) {
  if (depth === 3) return `\u001B[${layer};2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (depth === 2) return `\u001B[${layer};5;${cube(rgb)}m`;
  // 16 colors: cyan for the teal half of the gradient, magenta for the violet.
  const violet = rgb[0] > rgb[1];
  return `\u001B[${layer === 38 ? 3 : 4}${violet ? 5 : 6}m`;
}

/** The brand gradient at `u`, 0 teal to 1 violet. */
export function brand(u: number): Rgb {
  return mix(BRAND_A, BRAND_B, u);
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
// painted cell breaks that: the cells after it would keep its color. So a
// cell whose style doesn't extend the one before starts over from a reset.
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

const BLANK: StyledCell = {char: ' ', width: 1, style: ''};

// `row` as exactly `width` one-column cells. The gutter, the cells before
// `from`, stays as it is; from there on, `glyph` draws each cell (null for
// an empty cell), a wide character becomes as many cells as it was wide,
// and a blank keeps its style, so an added row's background stays as the
// diff had it. A wide gutter character cut at `from` turns to blanks.
function cellsOf({line, from}: LaunchRow, width: number, glyph: ((cell: StyledCell) => string) | null): StyledCell[] {
  const out: StyledCell[] = [];
  for (const cell of toStyledCells(line)) {
    if (cell.width === 0) continue;
    if (out.length + cell.width > width) break;
    if (out.length + cell.width <= from) {
      out.push(cell);
      continue;
    }
    const blank = cell.char.trim() === '';
    for (let each = 0; each < cell.width; each += 1) {
      if (out.length < from) out.push({...BLANK, style: cell.style});
      else out.push(glyph === null ? BLANK : {char: blank ? ' ' : glyph(cell), width: 1, style: cell.style});
    }
  }
  while (out.length < width) out.push(BLANK);
  return out;
}

// The row as the caller has it, cell by cell, for a speck to land on.
const asIs = (row: LaunchRow, width: number) => cellsOf(row, width, (cell) => cell.char);

function easeInOutCubic(progress: number) {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

// A fixed hash of two numbers, so the same cell always gets the same speck.
function hash(a: number, b: number) {
  return (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b)) >>> 0;
}

const frameOf = (t: number) => Math.floor(t / FRAME_MS) * FRAME_MS;

/** The row the scanline is on at frame time `t`: `rows` (under the bottom) at 160 ms, up to -1 (past the top) at 480. */
export function launchScanRow(t: number, rows: number) {
  const progress = Math.max(0, Math.min(1, (t - DISSOLVE_END_MS) / (SCAN_END_MS - DISSOLVE_END_MS)));
  return Math.round(rows - easeInOutCubic(progress) * (rows + 1));
}

// The first frame on which the scanline has passed `row`.
function liftedAt(row: number, rows: number) {
  for (let t = DISSOLVE_END_MS; t <= SCAN_END_MS; t += FRAME_MS) if (launchScanRow(t, rows) < row) return t;
  return SCAN_END_MS;
}

/** Where the specks fly: the button's middle on the file header, in the diff rows' columns (the header sits at row -2). */
export type LaunchTarget = {row: number; col: number};

export type LaunchStyle = {width: number; depth: LaunchDepth; target: LaunchTarget};

/** A row that holds diff text: as drawn, and the column its code starts at, after delta's gutter. */
export type LaunchRow = {line: string; from: number};

type Speck = {row: number; col: number; glyph: string; style: string};

// Where every speck is at frame time `t`. Each text row the scanline
// passes gives up to ten, from code cells that held text. A speck speeds
// up along a slight arc toward the button, as if drawn in, and shrinks.
function specksAt(t: number, lines: ReadonlyArray<LaunchRow | null>, {width, depth, target}: LaunchStyle): Speck[] {
  const rows = lines.length;
  const out: Speck[] = [];
  const place = (row0: number, col0: number, age: number, flight: number, bend: number) => {
    const u = (age / flight) ** 2;
    const row = Math.round(row0 + (target.row - row0) * u);
    const col = Math.round(col0 + (target.col - col0) * u + Math.sin(Math.PI * u) * bend);
    return {row, col, u};
  };
  for (const [row0, line] of lines.entries()) {
    if (line === null) continue;
    const born = liftedAt(row0, rows);
    if (t < born) continue;
    const flight = Math.max(220, Math.min(380, 200 + 7 * (row0 - target.row)));
    const age = t - born;
    if (age >= flight + FRAME_MS) continue;
    let taken = 0;
    for (const [col0, cell] of cellsOf(line, width, () => 'x').entries()) {
      if (col0 < line.from || cell.char !== 'x' || taken >= 10) continue;
      const h = hash(row0, col0);
      if (h % 5 !== 0) continue;
      taken += 1;
      const bend = ((h >>> 8) % 5) - 2;
      const tint = brand((col0 - line.from) / Math.max(1, width - line.from - 1));
      if (age < flight) {
        const at = place(row0, col0, age, flight, bend);
        const glyph = SPECKS[Math.min(SPECKS.length - 1, Math.floor(at.u * SPECKS.length))]!;
        out.push({row: at.row, col: at.col, glyph, style: `${BOLD}${color(mix(tint, WHITE, 0.3 * at.u), depth)}`});
      }
      // The cell it left last frame, faint, so it reads as moving.
      if (age >= FRAME_MS) {
        const was = place(row0, col0, Math.min(flight, age - FRAME_MS), flight, bend);
        out.push({row: was.row, col: was.col, glyph: TRAIL, style: `${FAINT}${color(tint, depth)}`});
      }
    }
  }
  return out;
}

/**
 * The visible rows `t` ms after the press: each row as it draws now, or
 * null where it is the row as the caller has it. `lines` are the rows
 * that hold diff text; a null there is a row that keeps still (a header,
 * a picture's placeholder cells), which no speck lands on either.
 */
export function launchScreen(time: number, lines: ReadonlyArray<LaunchRow | null>, style: LaunchStyle): Array<string | null> {
  const rows = lines.length;
  if (time < 0 || time >= LAUNCH_MS || rows === 0) return lines.map(() => null);
  const t = frameOf(time);
  const {width, depth} = style;
  const scan = launchScanRow(t, rows);
  // The scanline moves several rows a frame. It draws on the highest text
  // row it crossed this frame, so it shows even where held rows (headers,
  // pictures) take most of the screen.
  const before = t > DISSOLVE_END_MS ? launchScanRow(t - FRAME_MS, rows) : rows;
  let scanAt = -1;
  for (let row = Math.max(0, scan); row <= Math.min(rows - 1, before); row += 1) {
    if (lines[row] !== null) {
      scanAt = row;
      break;
    }
  }
  const base = lines.map((line, row): StyledCell[] | null => {
    if (line === null) return null;
    if (t < DISSOLVE_END_MS) {
      const offset = rows > 1 ? (row / (rows - 1)) * FRAME_MS : 0;
      const step = Math.max(0, Math.min(3, Math.floor((t - offset) / FRAME_MS) + 1));
      return step === 0 ? null : cellsOf(line, width, () => SHADES[step - 1]!);
    }
    if (t >= REPRINT_MS) {
      const offset = rows > 1 ? (row / (rows - 1)) * 2 * FRAME_MS : 0;
      const k = Math.floor((t - REPRINT_MS - offset) / FRAME_MS);
      if (k < 0) return cellsOf(line, width, null);
      const step = 3 - k;
      return step <= 0 ? null : cellsOf(line, width, () => SHADES[step - 1]!);
    }
    if (row === scanAt) {
      const cells = cellsOf(line, width, null);
      for (let col = line.from; col < width; col += 1) cells[col] = {char: SCANLINE, width: 1, style: `${BOLD}${color(brand((col - line.from) / Math.max(1, width - line.from - 1)), depth)}`};
      return cells;
    }
    if (row > scan) return cellsOf(line, width, null);
    return cellsOf(line, width, () => SHADES[2]!);
  });
  for (const speck of specksAt(t, lines, style)) {
    const under = lines[speck.row];
    if (!under || speck.col < under.from || speck.col >= width) continue;
    base[speck.row] ??= asIs(under, width);
    base[speck.row]![speck.col] = {char: speck.glyph, width: 1, style: speck.style};
  }
  return base.map((cells) => (cells ? `${renderStyledCells(restyle(cells))}${RESET}` : null));
}

/** How the button draws: pressed in (0 to 1), lit (0 to 1), and the shimmer stripe's place across it (0 to 1), or null. */
export type ChipLook = {press: number; glow: number; shimmer: number | null};
export const CHIP_REST: ChipLook = {press: 0, glow: 0, shimmer: null};
export const CHIP_HOVER: ChipLook = {press: 0, glow: 0.18, shimmer: null};

/** The button's look `t` ms into a launch: pressed in for 120 ms, then lit as the specks land. */
export function chipLaunchLook(t: number, hovered: boolean): ChipLook {
  const rest = hovered ? CHIP_HOVER : CHIP_REST;
  if (t < 0 || t >= LAUNCH_MS) return rest;
  if (t < PRESS_MS) return {...rest, press: 1};
  const lit = t >= FLARE_FROM_MS && t < FLARE_FROM_MS + FLARE_MS ? 1 - (t - FLARE_FROM_MS) / FLARE_MS : 0;
  return {...rest, glow: Math.max(rest.glow, lit)};
}

/** The stripe's place across the button `t` ms after the pointer came onto it, or null once it has crossed. */
export function shimmerAt(t: number): number | null {
  if (t < 0 || t >= SHIMMER_MS) return null;
  return -0.25 + easeInOutCubic(t / SHIMMER_MS) * 1.5;
}

/**
 * The Review in browser button as a filled chip, as wide as the tab it
 * replaces (`label` plus four cells): half-block ends, then the label with
 * its `⇗` first, on the brand gradient, in dark bold text.
 */
export function chip(label: string, depth: LaunchDepth, look: ChipLook = CHIP_REST): string {
  const arrow = ` ${LEAVES_PANE}`;
  const words = label.endsWith(arrow) ? `${LEAVES_PANE} ${label.slice(0, -arrow.length)}` : label;
  const text = ` ${words} `;
  if (depth === 1) {
    const bg = look.glow > 0.5 || look.shimmer !== null ? '\u001B[106m' : '\u001B[46m';
    return `\u001B[36m▐${RESET}${bg}\u001B[30m${BOLD}${text}${RESET}\u001B[36m▌${RESET}`;
  }
  const cells = [...text];
  const fill = (index: number): Rgb => {
    const u = cells.length > 1 ? index / (cells.length - 1) : 0;
    let rgb = brand(u);
    rgb = mix(rgb, BLACK, 0.35 * look.press);
    rgb = mix(rgb, WHITE, 0.55 * look.glow);
    if (look.shimmer !== null) {
      const away = Math.abs(u - look.shimmer) * cells.length;
      if (away < 2) rgb = mix(rgb, WHITE, 0.6 * (1 - away / 2));
    }
    return rgb;
  };
  const body = cells.map((char, index) => `${color(fill(index), depth, 48)}${char}`).join('');
  const ink = color(INK, depth);
  return `${color(fill(0), depth)}▐${RESET}${ink}${BOLD}${body}${RESET}${color(fill(cells.length - 1), depth)}▌${RESET}`;
}

/** `line` with the cells in [start, end) replaced by `drawn`, which is exactly that wide. */
export function placeAt(line: string, start: number, end: number, drawn: string): string {
  const fresh = toStyledCells(drawn);
  return overlay(line, null, start, end, (cell, column) => {
    const at: StyledCell[] = [];
    let offset = 0;
    for (const each of fresh) {
      if (offset >= column - start && offset < column - start + cell.width) at.push(each);
      offset += each.width;
    }
    return at;
  });
}

/**
 * The file header row with the button pressed, `tMs` after the press, or
 * null once the press is over, for a terminal without color: the button's
 * label in inverse, or one frame of `░` over it under reduced motion.
 * `span` is the button label's columns on the row.
 */
export function pressFrame(line: string, span: {start: number; end: number} | null, tMs: number, motion: Motion, accent: string | null): string | null {
  if (!span || motion === 'off' || tMs < 0 || tMs >= PRESS_MS) return null;
  if (motion === 'reduced') {
    const style = accent === null ? '' : `${RESET}${accent}`;
    return overlay(line, null, span.start, span.end, (cell) => Array.from({length: cell.width}, () => ({char: '░', width: 1, style})));
  }
  return overlay(line, null, span.start, span.end, (cell) => [{...cell, style: `${cell.style}${INVERSE}`}]);
}
