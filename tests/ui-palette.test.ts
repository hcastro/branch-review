import {describe, expect, it, vi} from 'vitest';
import {createPalette, isPlainDiffMode, resolveColorDepth} from '../src/ui/palette.js';
import {isColorDisabled} from '../src/git.js';

// The palette takes on/off from git.ts's colour-off rule, the one delta runs
// under. The rule is stubbed with the agreed definition (NO_COLOR non-empty,
// FORCE_COLOR 0 or false, TERM=dumb), and single tests swap it out to prove
// the palette adds no rule of its own.
const colourRule = vi.hoisted(() => ({
  agreed: (env: Record<string, string | undefined>) => Boolean(env.NO_COLOR)
    || env.FORCE_COLOR === '0'
    || env.FORCE_COLOR === 'false'
    || env.TERM === 'dumb',
}));
vi.mock('../src/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git.js')>()),
  isColorDisabled: vi.fn((env: Record<string, string | undefined>) => colourRule.agreed(env)),
}));

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

  it('turns colour off for TERM=dumb', () => {
    expect(resolveColorDepth({TERM: 'dumb'}, 3)).toBe(0);
    expect(resolveColorDepth({TERM: 'xterm-256color'}, 3)).toBe(3);
  });

  it('is off exactly when the shared colour-off rule says so, for every input', () => {
    const inputs = [
      {}, {NO_COLOR: '1'}, {NO_COLOR: ''}, {FORCE_COLOR: '0'}, {FORCE_COLOR: 'false'}, {FORCE_COLOR: '1'},
      {FORCE_COLOR: 'true'}, {FORCE_COLOR: ''}, {TERM: 'dumb'}, {TERM: 'xterm'}, {NO_COLOR: '1', FORCE_COLOR: '3'},
    ];
    for (const env of inputs) {
      expect(resolveColorDepth(env, 3) === 0, JSON.stringify(env)).toBe(isColorDisabled(env));
      expect(isPlainDiffMode(env), JSON.stringify(env)).toBe(isColorDisabled(env));
    }
  });

  it('adds no colour-off rule of its own', () => {
    const rule = vi.mocked(isColorDisabled);
    try {
      // Whatever the environment says, the shared rule decides.
      rule.mockImplementation(() => false);
      for (const env of [{FORCE_COLOR: 'false'}, {TERM: 'dumb'}, {NO_COLOR: '1'}, {FORCE_COLOR: '0'}]) {
        expect(resolveColorDepth(env, 2), JSON.stringify(env)).toBe(2);
      }
      rule.mockImplementation(() => true);
      expect(resolveColorDepth({FORCE_COLOR: '3'}, 3)).toBe(0);
    } finally {
      rule.mockImplementation((env = {}) => colourRule.agreed(env));
    }
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

  it('draws chrome text in plain cyan, never bright cyan, so it reads on light themes', () => {
    for (const depth of [1, 2, 3] as const) {
      const palette = createPalette(depth);
      expect(palette.sgr.cyanBold).toBe('\u001B[36;1m');
      expect(Object.values(palette.sgr).filter((code) => /\[(?:[\d;]*;)?96[;m]/.test(code))).toEqual([]);
    }
    expect(createPalette(0).sgr.cyanBold).toBe('\u001B[1m');
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
