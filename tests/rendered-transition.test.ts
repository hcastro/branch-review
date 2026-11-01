import stripAnsi from 'strip-ansi';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {crossingLine, crossingPlays, glowTone, scanRow, type ArrivingRow, type CrossingStyle} from '../src/rendered/transition.js';
import {createPaneClock} from '../src/ui/paneCrossing.js';
import {decodePlaceholders} from './media-helpers.js';
import {placeholderRun} from '../src/media/kitty.js';

// The in-pane crossing, frame by frame: the diff's text dissolves in its own
// colors, the page's silhouette arrives as a mosaic of its own colors, an
// accent scanline sweeps down with the page's placeholder cells above it,
// and the gutter's bars glow and settle. Pure row looks at the storyboard's
// times, for a local terminal and a slow link (SSH or tmux), and the clock
// that holds the mosaic until the tiles on screen are in the terminal.

const WIDTH = 24;
const ROWS = 10;
const GREEN = '\u001B[32m';
const RESET = '\u001B[0m';
const DEPARTING = `${GREEN}+Press r to go${RESET}`;
const BG: [number, number, number] = [16, 20, 24];
// A tile row: its placeholder cells as drawn, and its cells' mean colors,
// the page background on the left half and text gray on the right.
const ARRIVING: ArrivingRow = {
  drawn: placeholderRun(9, 0, 0, WIDTH),
  mosaic: Array.from({length: WIDTH}, (_, col) => (col < WIDTH / 2 ? BG : [180, 180, 180] as [number, number, number])),
};
const TEXT_ROW: ArrivingRow = {drawn: 'docs/page.md', mosaic: null};

const style = (link: CrossingStyle['link'] = 'local'): CrossingStyle => ({width: WIDTH, rows: ROWS, link, accent: '\u001B[36m', bg: BG, depth: 3});
const plain = (line: string) => stripAnsi(line);

describe('the crossing frames', () => {
  it('plays only with full motion and color', () => {
    expect(crossingPlays('full', true)).toBe(true);
    expect(crossingPlays('reduced', true)).toBe(false);
    expect(crossingPlays('off', true)).toBe(false);
    expect(crossingPlays('full', false)).toBe(false);
  });

  it('at 0 ms starts the dissolve at the top: the first row steps to ▓ in its own color, the last is still text', () => {
    const top = crossingLine(0, 0, DEPARTING, ARRIVING, style());
    expect(plain(top)).toBe('▓▓▓▓▓▓ ▓ ▓▓ ▓▓');
    expect(top).toContain(GREEN);
    expect(plain(crossingLine(0, ROWS - 1, DEPARTING, ARRIVING, style()))).toBe('+Press r to go');
  });

  it('at 80 ms the wave reaches the bottom and the top is ░', () => {
    expect(plain(crossingLine(80, 0, DEPARTING, ARRIVING, style()))).toBe('░░░░░░ ░ ░░ ░░');
    expect(plain(crossingLine(80, ROWS - 1, DEPARTING, ARRIVING, style()))).toBe('▒▒▒▒▒▒ ▒ ▒▒ ▒▒');
  });

  it('at 120 ms paints a tile row in the page\'s own colors, leaving its background blank', () => {
    const line = crossingLine(120, 3, DEPARTING, ARRIVING, style());
    expect(plain(line)).toBe(`${' '.repeat(WIDTH / 2)}${'░'.repeat(WIDTH / 2)}`);
    expect(line).toContain('\u001B[38;2;180;180;180m');
    // Density rises as the mosaic holds.
    expect(plain(crossingLine(240, 3, DEPARTING, ARRIVING, style())).trim()).toBe('▓'.repeat(WIDTH / 2));
    // A row with no tile keeps the dissolved text.
    expect(plain(crossingLine(160, 3, DEPARTING, TEXT_ROW, style()))).toBe('░░░░░░ ░ ░░ ░░');
  });

  it('without 24-bit color, paints the mosaic from the 256-color cube, red, green and blue in their places', () => {
    // A row of pure red, then pure blue, then a blue-green, on the page background.
    const row: ArrivingRow = {
      drawn: placeholderRun(9, 0, 0, WIDTH),
      mosaic: Array.from({length: WIDTH}, (_, col) => (col < 8 ? [255, 0, 0] : col < 16 ? [0, 0, 255] : [0, 102, 153]) as [number, number, number]),
    };
    const line = crossingLine(120, 3, DEPARTING, row, {...style(), depth: 2});
    // 16 + 36 r + 6 g + b on a 0 to 5 scale.
    const codes = [...line.matchAll(/\u001B\[38;5;(\d+)m/g)].map((match) => Number(match[1]));
    expect(codes).toEqual([16 + 36 * 5, 16 + 5, 16 + 6 * 2 + 3]);
    expect(line).not.toContain('38;2;');
    expect(plain(line)).toBe('░'.repeat(WIDTH));
  });

  it('over a slow link has no mosaic: the dissolved text holds in neutral ░', () => {
    expect(plain(crossingLine(120, 3, DEPARTING, ARRIVING, style('slow')))).toBe('░░░░░░ ░ ░░ ░░');
    expect(plain(crossingLine(240, 3, DEPARTING, ARRIVING, style('slow')))).toBe('░░░░░░ ░ ░░ ░░');
  });

  it('at 280 ms the accent scanline starts at the top, with the mosaic under it', () => {
    expect(scanRow(280, ROWS)).toBe(0);
    const scan = crossingLine(280, 0, DEPARTING, ARRIVING, style());
    expect(plain(scan)).toBe('▀'.repeat(WIDTH));
    expect(scan).toContain('\u001B[36m');
    expect(plain(crossingLine(280, 4, DEPARTING, ARRIVING, style())).trim()).toBe('▓'.repeat(WIDTH / 2));
    expect(decodePlaceholders(scan)).toEqual([]);
  });

  it('at 400 ms rows above the scanline are the page\'s placeholder cells, eased out', () => {
    const at = scanRow(400, ROWS);
    // Half the time, seven eighths of the way: ease-out cubic.
    expect(at).toBe(Math.round(0.875 * ROWS));
    const above = crossingLine(400, at - 1, DEPARTING, ARRIVING, style());
    expect(above).toBe(ARRIVING.drawn);
    expect(decodePlaceholders(above)).toHaveLength(WIDTH);
    expect(plain(crossingLine(400, at, DEPARTING, ARRIVING, style()))).toBe('▀'.repeat(WIDTH));
  });

  it('at 520 ms the page is in place and the bars glow in the accent, then settle by 760 ms', () => {
    for (let row = 0; row < ROWS; row += 1) expect(crossingLine(520, row, DEPARTING, ARRIVING, style())).toBe(ARRIVING.drawn);
    expect(glowTone(520)).toBe('accent');
    expect(glowTone(680)).toBe('bright');
    expect(glowTone(760)).toBeNull();
    expect(glowTone(100)).toBeNull();
    expect(crossingLine(760, 0, DEPARTING, ARRIVING, style())).toBe(ARRIVING.drawn);
  });

  it('keeps every row the pane width, cutting nothing wide in half', () => {
    const wide = `${GREEN}表示する${RESET}`;
    expect(plain(crossingLine(80, 0, wide, ARRIVING, style()))).toBe('░░░░░░░░');
    expect(plain(crossingLine(280, 0, wide, ARRIVING, style()))).toHaveLength(WIDTH);
  });
});

describe('the pane crossing clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs 760 ms in 40 ms ticks when the tiles are in, then stops', async () => {
    const clock = createPaneClock();
    let done = false;
    void clock.start({link: 'local', departing: ['a'], ready: () => true}).then(() => {
      done = true;
    });
    expect(clock.snapshot()).toMatchObject({t: 0, developing: false});
    await vi.advanceTimersByTimeAsync(400);
    expect(clock.snapshot()!.t).toBe(400);
    await vi.advanceTimersByTimeAsync(400);
    expect(done).toBe(true);
    expect(clock.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the mosaic at 280 ms until the tiles on screen are in, says developing after 600 ms, then develops', async () => {
    const clock = createPaneClock();
    let ready = false;
    void clock.start({link: 'local', departing: [], ready: () => ready});
    await vi.advanceTimersByTimeAsync(600);
    expect(clock.snapshot()!.t).toBeLessThan(280);
    expect(clock.snapshot()!.t).toBeGreaterThanOrEqual(240);
    expect(clock.snapshot()!.developing).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(clock.snapshot()!.developing).toBe(true);
    ready = true;
    await vi.advanceTimersByTimeAsync(40);
    expect(clock.snapshot()!.t).toBeGreaterThanOrEqual(280);
    await vi.advanceTimersByTimeAsync(120);
    expect(clock.snapshot()!.t).toBeGreaterThanOrEqual(400);
    expect(clock.snapshot()!.developing).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(clock.snapshot()).toBeNull();
  });

  it('ticks at 12 frames a second over a slow link', async () => {
    const clock = createPaneClock();
    let emits = 0;
    clock.subscribe(() => {
      emits += 1;
    });
    void clock.start({link: 'slow', departing: [], ready: () => true});
    await vi.advanceTimersByTimeAsync(830);
    // The first frame, about nine ticks of 83 ms, and the end.
    expect(emits).toBeLessThanOrEqual(12);
    expect(clock.snapshot()).toBeNull();
  });

  it('stops at once when the pane leaves, settling the crossing', async () => {
    const clock = createPaneClock();
    let done = false;
    void clock.start({link: 'local', departing: [], ready: () => false}).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(80);
    clock.stop();
    await Promise.resolve();
    expect(done).toBe(true);
    expect(clock.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
