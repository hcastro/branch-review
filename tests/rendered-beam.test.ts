import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {describe, expect, it} from 'vitest';
import {BEAM_MS, beamFrame, PRESS_MS, pressFrame} from '../src/rendered/beam.js';
import {toStyledCells} from '../src/ui/text.js';

// The shade band that sweeps the diff toward the split, and the press on the
// Rendered button, as pure frames of one row at a time on a fake clock.

const CYAN = '\u001B[36m';
const WIDTH = 60;
const LINE = '  12      │\u001B[32m+Press `r`. The diff you were reading becomes the page,\u001B[0m';
const BAND = /[░▒▓]+/;
const INVERSE = '\u001B[7m';

// The style each cell is drawn with, by its text, as a terminal reads the
// line from its start.
function stylesOf(frame: string) {
  return toStyledCells(frame).map((cell) => ({char: cell.char, style: cell.style}));
}

function band(frame: string | null) {
  const text = stripAnsi(frame ?? '');
  const match = BAND.exec(text);
  return match ? {start: stringWidth(text.slice(0, match.index)), text: match[0]} : null;
}

describe('beamFrame', () => {
  it('sweeps a six-cell band left to right over 320 ms in eight 40 ms frames', () => {
    const starts = [0, 40, 80, 120, 160, 200, 240, 280].map((t) => band(beamFrame(LINE, 0, t, WIDTH, CYAN))?.start ?? -1);
    // Each frame stands further right than the last.
    for (let index = 1; index < starts.length; index += 1) expect(starts[index]!).toBeGreaterThanOrEqual(starts[index - 1]!);
    expect(starts.at(-1)!).toBeGreaterThan(WIDTH / 2);
    // Within one 40 ms frame, nothing moves.
    expect(beamFrame(LINE, 0, 121, WIDTH, CYAN)).toBe(beamFrame(LINE, 0, 159, WIDTH, CYAN));
    expect(band(beamFrame(LINE, 0, 120, WIDTH, CYAN))!.text).toBe('░▒▓▓▒░');
    expect(BEAM_MS).toBe(320);
  });

  it('eases in and out on x: slow off the left edge, fast across the middle, slow into the right', () => {
    // Row 0 of a 60-column pane, whose wave offset is 2.
    const at = (t: number) => band(beamFrame(LINE, 0, t, WIDTH, CYAN))!;
    expect([40, 120, 200, 280].map((t) => at(t).start)).toEqual([0, 17, 51, 56]);
    expect(at(40).text).toBe('░▒▓▓▒░');
    const step = (from: number) => at(from + 40).start - at(from).start;
    expect(step(40)).toBeLessThan(step(120));
    expect(step(240)).toBeLessThan(step(120));
  });

  it('draws the band in the accent over the text, and the text it passed is back', () => {
    const at120 = beamFrame(LINE, 0, 120, WIDTH, CYAN)!;
    expect(at120).toContain(`${CYAN}░▒▓▓▒░`);
    expect(stringWidth(stripAnsi(at120))).toBe(WIDTH);
    // Every cell outside the band is the line's own.
    const plain = stripAnsi(LINE).padEnd(WIDTH, ' ').slice(0, WIDTH);
    const shown = stripAnsi(at120);
    const {start} = band(at120)!;
    expect(shown.slice(0, start)).toBe(plain.slice(0, start));
    expect(shown.slice(start + 6)).toBe(plain.slice(start + 6));
    // The line's own color comes back after the band.
    expect(at120.slice(at120.indexOf('░▒▓▓▒░') + 6)).toMatch(/^(\u001B\[32m|\u001B\[0m)/);
  });

  it('keeps its accent off the cells after the band, on a line that sets only attributes or a background', () => {
    for (const line of ['\u001B[1mabcdefghijklmnopqrstuvwxyz0123456789\u001B[0m', '\u001B[48;5;22mabcdefghijklmnopqrstuvwxyz0123456789\u001B[0m']) {
      const frame = beamFrame(line, 0, 120, WIDTH, CYAN)!;
      const cells = stylesOf(frame);
      const end = stripAnsi(frame).indexOf('░▒▓▓▒░') + 6;
      const after = cells.slice(end).filter((cell) => cell.char !== ' ');
      expect(after.length).toBeGreaterThan(0);
      for (const cell of after) {
        expect(cell.style).not.toContain(CYAN);
        expect(cell.style).toBe(line.slice(0, line.indexOf('m') + 1));
      }
    }
  });

  it('staggers rows by up to three columns so the edge reads as a wave', () => {
    const starts = Array.from({length: 12}, (_, row) => band(beamFrame(LINE, row, 120, WIDTH, CYAN))!.start);
    const base = Math.min(...starts);
    expect(new Set(starts.map((start) => start - base)).size).toBeGreaterThan(1);
    expect(Math.max(...starts) - base).toBeLessThanOrEqual(3);
    // The same row always gets the same offset.
    expect(beamFrame(LINE, 5, 120, WIDTH, CYAN)).toBe(beamFrame(LINE, 5, 120, WIDTH, CYAN));
  });

  it('is done at 320 ms, and draws nothing before the press or without color', () => {
    expect(beamFrame(LINE, 0, 320, WIDTH, CYAN)).toBeNull();
    expect(beamFrame(LINE, 0, 1000, WIDTH, CYAN)).toBeNull();
    expect(beamFrame(LINE, 0, -1, WIDTH, CYAN)).toBeNull();
    // NO_COLOR: the palette has no accent, so there is no beam.
    expect(beamFrame(LINE, 0, 120, WIDTH, null)).toBeNull();
  });

  it('keeps a wide character whole: the band covers it or leaves it', () => {
    const wide = '界'.repeat(30);
    for (let t = 0; t < BEAM_MS; t += 40) {
      const frame = beamFrame(wide, 1, t, WIDTH, CYAN);
      if (frame === null) continue;
      expect(stringWidth(stripAnsi(frame))).toBe(WIDTH);
      expect(stripAnsi(frame)).not.toContain('�');
    }
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

  it('gives reduced motion one 120 ms frame of ░ on the button in place of the beam', () => {
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
