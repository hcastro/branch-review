import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {describe, expect, it} from 'vitest';
import {
  BRAND_A,
  BRAND_B,
  chip,
  chipLaunchLook,
  CHIP_HOVER,
  CHIP_REST,
  color,
  LAUNCH_LANDS_MS,
  LAUNCH_MS,
  launchScanRow,
  launchScreen,
  placeAt,
  PRESS_MS,
  pressFrame,
  shimmerAt,
  SHIMMER_MS,
  type LaunchRow,
  type LaunchStyle,
} from '../src/rendered/launch.js';
import {toStyledCells} from '../src/ui/text.js';

// "Send to browser": the diff's code dissolves, a scanline lifts the rows
// from the bottom up, specks fly from them into the Review in browser chip,
// and the code draws back in. Pure frames of the visible rows on a fake
// clock, the chip's looks, and the press for a terminal without color.

const CYAN = '\u001B[36m';
const WIDTH = 60;
const GUTTER = '  12 ⋮  12 │';
const FROM = stringWidth(GUTTER);
const CODE = `\u001B[48;2;0;56;0m\u001B[38;2;248;248;242mA charge that fails for a temporary reason is tried again.\u001B[0m`;
const ROW: LaunchRow = {line: `${GUTTER}${CODE}`, from: FROM};
const SPECK = /[⣿⠿⠶⠖⠒⠂]/;
const INVERSE = '\u001B[7m';
// The style each cell is drawn with, by its text, as a terminal reads the
// line from its start.
const stylesOf = (frame: string) => toStyledCells(frame).map((cell) => ({char: cell.char, style: cell.style}));
const SHADE = /[░▒▓]/;
const style = (_rows: number): LaunchStyle => ({width: WIDTH, depth: 3, target: {row: -2, col: 50}});
const screen = (rows: number, t: number, lines?: Array<LaunchRow | null>) => launchScreen(t, lines ?? Array.from({length: rows}, () => ROW), style(rows));
const plain = (row: string | null) => (row === null ? null : stripAnsi(row));

describe('launchScreen', () => {
  it('runs 840 ms and lands at 640, and draws nothing before the press or after it', () => {
    expect([LAUNCH_MS, LAUNCH_LANDS_MS, PRESS_MS]).toEqual([840, 640, 120]);
    for (const t of [-1, LAUNCH_MS, 5_000]) expect(screen(6, t)).toEqual(Array(6).fill(null));
    expect(launchScreen(100, [], style(0))).toEqual([]);
  });

  it('dissolves the code top to bottom in its own colors, and keeps the gutter as it was', () => {
    const at0 = screen(6, 0).map(plain);
    // The top row shades on the press; the bottom row a frame later.
    expect(at0[0]!.slice(FROM)).toMatch(/^▓+/);
    expect(at0[5]).toBeNull();
    const at120 = screen(6, 120);
    for (const row of at120) {
      expect(plain(row)!.slice(0, FROM)).toBe(GUTTER);
      expect(plain(row)!.slice(FROM).trim()).toMatch(/^[░ ]+$/);
      expect(stringWidth(plain(row)!)).toBe(WIDTH);
      // The added row's background stays under the shade.
      expect(row).toContain('48;2;0;56;0m');
    }
  });

  it('sweeps a gradient scanline up from the bottom from 160 to 480 ms, easing in and out', () => {
    const rows = 20;
    const scans = [160, 200, 240, 280, 320, 360, 400, 440, 480].map((t) => launchScanRow(t, rows));
    expect(scans[0]).toBe(rows);
    expect(scans.at(-1)).toBe(-1);
    for (let index = 1; index < scans.length; index += 1) expect(scans[index]!).toBeLessThanOrEqual(scans[index - 1]!);
    const step = (index: number) => scans[index - 1]! - scans[index]!;
    expect(step(1)).toBeLessThan(step(4));
    expect(step(8)).toBeLessThan(step(4));
    const frame = screen(rows, 320);
    const scan = launchScanRow(320, rows);
    expect(plain(frame[scan])).toBe(`${GUTTER}${'▄'.repeat(WIDTH - FROM)}`);
    // Teal at its left end, violet at its right.
    expect(frame[scan]).toContain(color(BRAND_A, 3));
    expect(frame[scan]).toContain(color(BRAND_B, 3));
    // Above it the rows hold in shade; below it the code has gone.
    expect(plain(frame[scan - 1])!.slice(FROM)).toMatch(SHADE);
    expect(plain(frame[scan + 1])!.slice(FROM)).not.toMatch(SHADE);
  });

  it('lifts specks off each row it passes, which fly up toward the chip and are gone by the time the code draws back', () => {
    const rows = 12;
    const lifted = (t: number) => screen(rows, t).map((row) => plain(row)?.slice(FROM) ?? '');
    const specks = (t: number) => lifted(t).reduce((sum, row) => sum + [...row].filter((char) => SPECK.test(char)).length, 0);
    expect(specks(120)).toBe(0);
    expect(specks(360)).toBeGreaterThan(5);
    // Specks rise: the lowest row with one climbs as the flight goes on.
    const lowest = (t: number) => lifted(t).reduce((last, row, index) => (SPECK.test(row) ? index : last), -1);
    expect(lowest(560)).toBeLessThan(lowest(360));
    expect(specks(760)).toBe(0);
    // The same moment always draws the same specks.
    expect(screen(rows, 400)).toEqual(screen(rows, 400));
    expect(screen(rows, 401)).toEqual(screen(rows, 439));
  });

  it('draws the code back in from the top after the specks land, and is the diff again at the end', () => {
    const rows = 8;
    const at640 = screen(rows, 640).map(plain);
    expect(at640[0]!.slice(FROM)).toMatch(SHADE);
    expect(at640.at(-1)!.slice(FROM).trim()).toBe('');
    // In the last frame the top rows are themselves again and the bottom one is nearly there.
    const last = screen(rows, LAUNCH_MS - 1);
    expect(last[0]).toBeNull();
    expect(plain(last.at(-1)!)!.slice(FROM)).toMatch(/▓/);
  });

  it('keeps still a row the caller holds back, and lands no speck on it', () => {
    const rows = 10;
    const lines = Array.from({length: rows}, (_, index) => (index % 3 === 0 ? null : ROW));
    for (let t = 0; t < LAUNCH_MS; t += 40) {
      const frame = launchScreen(t, lines, style(rows));
      for (const [index, line] of lines.entries()) if (line === null) expect(frame[index], `${t} ms row ${index}`).toBeNull();
    }
  });

  it('keeps every frame as wide as the pane, wide characters included', () => {
    const wide: LaunchRow = {line: `${GUTTER}${'界'.repeat(30)}`, from: FROM};
    for (let t = 0; t < LAUNCH_MS; t += 40) {
      for (const row of launchScreen(t, Array(6).fill(wide), style(6))) {
        if (row === null) continue;
        expect(stringWidth(stripAnsi(row))).toBe(WIDTH);
        expect(stripAnsi(row)).not.toContain('�');
      }
    }
  });

  it('draws in 256 and 16 colors too', () => {
    const at = (depth: 1 | 2) => launchScreen(320, Array(10).fill(ROW), {...style(10), depth}).join('');
    expect(at(2)).toMatch(/\u001B\[38;5;\d+m▄/);
    expect(at(1)).toMatch(/\u001B\[3[56]m▄/);
  });
});

describe('the Review in browser chip', () => {
  const LABEL = 'Review in browser ⇗';

  it('is as wide as the tab it replaces, with its ⇗ first, on the brand gradient', () => {
    for (const depth of [1, 2, 3] as const) {
      const drawn = chip(LABEL, depth);
      expect(stripAnsi(drawn)).toBe('▐ ⇗ Review in browser ▌');
      expect(stringWidth(stripAnsi(drawn))).toBe(stringWidth(LABEL) + 4);
    }
    const truecolor = chip(LABEL, 3);
    expect(truecolor).toContain(color(BRAND_A, 3, 48));
    expect(truecolor).toContain(color(BRAND_B, 3, 48));
    // Dark bold text.
    expect(truecolor).toContain('\u001B[38;2;13;17;23m\u001B[1m');
  });

  it('lights up on hover, presses in on the press, flares as the specks land, and settles', () => {
    const fills = (look = CHIP_REST) => [...chip(LABEL, 3, look).matchAll(/48;2;(\d+);(\d+);(\d+)m/g)].map((match) => Number(match[1]) + Number(match[2]) + Number(match[3]));
    const sum = (look = CHIP_REST) => fills(look).reduce((total, value) => total + value, 0);
    expect(sum(CHIP_HOVER)).toBeGreaterThan(sum(CHIP_REST));
    expect(sum(chipLaunchLook(0, false))).toBeLessThan(sum(CHIP_REST));
    expect(chipLaunchLook(PRESS_MS - 1, false).press).toBe(1);
    expect(chipLaunchLook(PRESS_MS, false)).toEqual(CHIP_REST);
    expect(chipLaunchLook(600, false).glow).toBe(1);
    expect(chipLaunchLook(720, false).glow).toBeGreaterThan(0);
    expect(chipLaunchLook(LAUNCH_MS, true)).toEqual(CHIP_HOVER);
  });

  it('sends one stripe across on hover, left to right, in 400 ms', () => {
    expect(SHIMMER_MS).toBe(400);
    const places = [0, 100, 200, 300, 399].map((t) => shimmerAt(t)!);
    for (let index = 1; index < places.length; index += 1) expect(places[index]!).toBeGreaterThan(places[index - 1]!);
    expect(places[0]).toBeLessThan(0);
    expect(places.at(-1)).toBeGreaterThan(1);
    expect(shimmerAt(SHIMMER_MS)).toBeNull();
    expect(shimmerAt(-1)).toBeNull();
    // The stripe brightens the cells it is over.
    const lit = chip(LABEL, 3, {...CHIP_REST, shimmer: 0.5});
    expect(lit).not.toBe(chip(LABEL, 3));
  });

  it('goes in place of the tab on a header row, leaving the rest of the row as it was', () => {
    const tab = `╭─${LABEL}─╮`;
    const row = `docs/guide.md   \u001B[90m${tab}\u001B[0m \u001B[90m╭─Copy path─╮\u001B[0m`;
    const start = stringWidth('docs/guide.md   ');
    const placed = placeAt(row, start, start + stringWidth(tab), chip(LABEL, 3));
    expect(stripAnsi(placed)).toBe(`docs/guide.md   ▐ ⇗ Review in browser ▌ ╭─Copy path─╮`);
    expect(placed.slice(placed.lastIndexOf('▌'))).toContain('\u001B[90m╭─Copy path─╮');
  });
});

describe('pressFrame', () => {
  const ROW = 'docs/rendered-view.md   ╭─Rendered ⇗─╮╭─Copy path─╮';
  const span = {start: ROW.indexOf('Rendered'), end: ROW.indexOf('Rendered') + 'Rendered ⇗'.length};

  it('shows the button inverse for 120 ms on a full crossing', () => {
    expect(PRESS_MS).toBe(120);
    const frame = pressFrame(ROW, span, 0, 'full', CYAN)!;
    expect(frame).toContain('\u001B[7mRendered ⇗');
    expect(stripAnsi(frame)).toBe(ROW);
    expect(pressFrame(ROW, span, PRESS_MS - 1, 'full', CYAN)).toBe(frame);
    expect(pressFrame(ROW, span, PRESS_MS, 'full', CYAN)).toBeNull();
  });

  it('ends the inverse with the label, so the frame after it keeps its own color', () => {
    const GRAY = '\u001B[90m';
    const row = `docs/guide.md   ${GRAY}╭─Rendered ⇗─╮\u001B[39m`;
    const start = stripAnsi(row).indexOf('Rendered');
    const frame = pressFrame(row, {start, end: start + 'Rendered ⇗'.length}, 0, 'full', CYAN)!;
    const cells = stylesOf(frame);
    const label = cells.slice(start, start + 'Rendered ⇗'.length);
    expect(label.every((cell) => cell.style.includes(INVERSE))).toBe(true);
    const corner = cells.slice(start + 'Rendered ⇗'.length);
    expect(corner.map((cell) => cell.char).join('')).toBe('─╮');
    for (const cell of corner) expect(cell.style).toBe(GRAY);
    // The frame before the label never was inverse.
    expect(cells.slice(start - 2, start).every((cell) => cell.style === GRAY)).toBe(true);
  });

  it('gives reduced motion one 120 ms frame of ░ on the button in place of the launch', () => {
    const frame = pressFrame(ROW, span, 40, 'reduced', CYAN)!;
    expect(stripAnsi(frame)).toBe(ROW.replace('Rendered ⇗', '░'.repeat(10)));
    expect(frame).toContain(`${CYAN}░░░░░░░░░░`);
    expect(pressFrame(ROW, span, PRESS_MS, 'reduced', CYAN)).toBeNull();
  });

  it('holds both press frames for exactly 120 ms', () => {
    for (const motion of ['full', 'reduced'] as const) {
      expect(pressFrame(ROW, span, 119, motion, CYAN), motion).not.toBeNull();
      expect(pressFrame(ROW, span, 120, motion, CYAN), motion).toBeNull();
    }
  });

  it('draws nothing with motion off or no button on the row', () => {
    expect(pressFrame(ROW, span, 0, 'off', CYAN)).toBeNull();
    expect(pressFrame(ROW, null, 0, 'full', CYAN)).toBeNull();
  });
});
