import {describe, expect, it} from 'vitest';
import {
  DECODE_DELAY_MS,
  DECODE_GLYPHS,
  DECODE_LINE_MS,
  DECODE_MS,
  DECODE_SWEEP_MS,
  easeInOut,
  lineProgress,
  scanlineY,
  scrambled,
} from '../src/rendered/client/decode.js';

// The browser half of the trip: the timing the canvas draws from. The
// canvas itself is checked in a real Chromium in review-page-chrome.test.ts.

describe('the decode arrival', () => {
  it('waits 80 ms, sweeps for 620, and gives the last line 200 to decode: 900 ms in all', () => {
    expect([DECODE_DELAY_MS, DECODE_SWEEP_MS, DECODE_LINE_MS, DECODE_MS]).toEqual([80, 620, 200, 900]);
  });

  it('eases the scanline in and out from the top of the window to the bottom', () => {
    expect(scanlineY(0, 800)).toBe(0);
    expect(scanlineY(DECODE_DELAY_MS, 800)).toBe(0);
    expect(scanlineY(DECODE_DELAY_MS + DECODE_SWEEP_MS / 2, 800)).toBeCloseTo(400);
    expect(scanlineY(DECODE_DELAY_MS + DECODE_SWEEP_MS, 800)).toBe(800);
    expect(scanlineY(DECODE_MS, 800)).toBe(800);
    // Slow at the ends, fast in the middle.
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
    const ys = Array.from({length: 40}, (_, step) => scanlineY((step * DECODE_MS) / 39, 800));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it('decodes a line once the scanline reaches its top, over 200 ms', () => {
    const top = 400;
    const reached = Array.from({length: 1000}, (_, t) => t).find((t) => scanlineY(t, 800) >= top)!;
    expect(lineProgress(reached - 1, top, 800)).toBe(0);
    expect(lineProgress(reached + DECODE_LINE_MS / 2, top, 800)).toBeCloseTo(0.5, 1);
    expect(lineProgress(reached + DECODE_LINE_MS + 1, top, 800)).toBe(1);
  });

  it('starts the top line first and has every line in the window decoded by the end', () => {
    expect(lineProgress(DECODE_DELAY_MS + 100, 0, 800)).toBeGreaterThan(0);
    expect(lineProgress(DECODE_DELAY_MS + 100, 600, 800)).toBe(0);
    for (const top of [-20, 0, 300, 799, 800]) expect(lineProgress(DECODE_MS, top, 800), String(top)).toBe(1);
  });

  it('scrambles a line from letters, code and the TUI\'s specks, the same for the same seed', () => {
    const glyphs = scrambled(60, 42);
    expect([...glyphs]).toHaveLength(60);
    for (const glyph of glyphs) expect(DECODE_GLYPHS).toContain(glyph);
    expect(scrambled(60, 42)).toBe(glyphs);
    expect(scrambled(60, 43)).not.toBe(glyphs);
    expect(DECODE_GLYPHS).toContain('⣿');
  });
});
