import {describe, expect, it} from 'vitest';
import {createPalette, resolveColorDepth} from '../src/ui/palette.js';

describe('colour depth', () => {
  it('turns colour off for NO_COLOR set and non-empty, whatever else is set', () => {
    expect(resolveColorDepth({NO_COLOR: '1'}, 3)).toBe(0);
    expect(resolveColorDepth({NO_COLOR: 'true', FORCE_COLOR: '3'}, 3)).toBe(0);
  });

  it('ignores an empty NO_COLOR', () => {
    expect(resolveColorDepth({NO_COLOR: ''}, 3)).toBe(3);
  });

  it('turns colour off for FORCE_COLOR=0 or false', () => {
    expect(resolveColorDepth({FORCE_COLOR: '0'}, 0)).toBe(0);
    expect(resolveColorDepth({FORCE_COLOR: 'false'}, 0)).toBe(0);
  });

  it('follows the terminal colour level otherwise', () => {
    expect(resolveColorDepth({}, 1)).toBe(1);
    expect(resolveColorDepth({}, 2)).toBe(2);
    expect(resolveColorDepth({}, 3)).toBe(3);
  });

  it('keeps full colour when the level is 0 only because stdout is not a terminal', () => {
    expect(resolveColorDepth({}, 0)).toBe(3);
  });
});

describe('palette', () => {
  it('adds no colour at depth 0 and keeps selection visible with inverse video', () => {
    const palette = createPalette(0);
    expect(palette.enabled).toBe(false);
    expect(Object.values(palette.sgr).filter((code) => /\[(3|4|9|10)\d/.test(code))).toEqual([]);
    expect(palette.sgr.selection).toBe('\u001B[7m');
    expect(palette.ink('cyan')).toBeUndefined();
    expect(palette.arrivalBackground('new', 0)).toBeNull();
  });

  it('uses 16-colour codes without truecolor', () => {
    for (const depth of [1, 2] as const) {
      const palette = createPalette(depth);
      const codes = [palette.sgr.selection, palette.arrivalBackground('new', 0), palette.arrivalBackground('changed', 0)];
      for (const code of codes) {
        expect(code).not.toBeNull();
        expect(code).not.toMatch(/[34]8;[25];/);
      }
      expect(palette.ink('cyan')).toBe('cyan');
    }
  });

  it('uses truecolor washes at depth 3 and ends them before they fade to near-black', () => {
    const palette = createPalette(3);
    expect(palette.arrivalBackground('new', 0)).toMatch(/48;2;/);
    expect(palette.sgr.selection).toContain('48;2;28;68;76');
    for (let progress = 0; progress < 1; progress += 0.01) {
      const code = palette.arrivalBackground('changed', progress);
      if (!code) continue;
      const [, r, g, b] = code.match(/48;2;(\d+);(\d+);(\d+)/)!.map(Number);
      expect(Math.max(r!, g!, b!), `progress ${progress.toFixed(2)}`).toBeGreaterThanOrEqual(40);
    }
    expect(palette.arrivalBackground('new', 0.99)).toBeNull();
  });
});
