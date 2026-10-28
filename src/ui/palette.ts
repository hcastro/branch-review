import chalk from 'chalk';
import {isColorDisabled} from '../git.js';

// Every colour the app adds goes through this palette, both the raw SGR codes
// drawn into the diff pane and the colour props handed to Ink, so NO_COLOR
// turns them all off in one place.

export type ColorDepth = 0 | 1 | 2 | 3;
export type ArrivalKind = 'new' | 'changed';

type Env = Record<string, string | undefined>;

// git.ts runs delta in plain mode, +/- markers kept, under this same rule, so
// the diff parser and the chrome agree on when colour is off.
export function isPlainDiffMode(env: Env = process.env) {
  return isColorDisabled(env);
}

// `terminalLevel` is chalk's level, which Ink colours with. A level of 0 with
// no explicit request means stdout is not a terminal (a test or a pipe); the
// pane then keeps full colour, as it did before this palette existed.
export function resolveColorDepth(env: Env = process.env, terminalLevel: number = chalk.level): ColorDepth {
  if (isPlainDiffMode(env) || env.FORCE_COLOR === 'false') return 0;
  if (terminalLevel >= 3) return 3;
  if (terminalLevel === 2) return 2;
  if (terminalLevel === 1) return 1;
  return 3;
}

const RESET = '\u001B[0m';
const BOLD = '\u001B[1m';
const INVERSE = '\u001B[7m';

// Truecolor washes, strongest first. Each ends while still clearly coloured,
// so a fading wash never leaves a near-black band on a light theme.
const ARRIVAL_RAMPS: Record<ArrivalKind, string[]> = {
  new: ['18;72;38', '17;68;37', '15;60;34', '13;52;31', '11;44;28'].map((rgb) => `\u001B[48;2;${rgb}m`),
  changed: ['17;64;72', '16;60;69', '14;54;63', '12;47;57', '10;39;49'].map((rgb) => `\u001B[48;2;${rgb}m`),
};
const ARRIVAL_STEPS = [0.08, 0.18, 0.31, 0.46, 0.62];
// Bright-black background: visible on dark and light 16-colour themes.
const ARRIVAL_ANSI16 = '\u001B[100m';

export type Palette = {
  enabled: boolean;
  depth: ColorDepth;
  sgr: {
    reset: string;
    bold: string;
    cyan: string;
    cyanBright: string;
    cyanBrightBold: string;
    gray: string;
    green: string;
    greenBold: string;
    red: string;
    yellow: string;
    magenta: string;
    magentaBright: string;
    selection: string;
  };
  // An Ink colour prop, or undefined (the terminal's default) without colour.
  ink: <T extends string>(color: T) => T | undefined;
  arrivalBackground: (kind: ArrivalKind, progress: number) => string | null;
};

export function createPalette(depth: ColorDepth): Palette {
  const enabled = depth > 0;
  const code = (sgr: string) => (enabled ? sgr : '');

  return {
    enabled,
    depth,
    sgr: {
      reset: RESET,
      bold: BOLD,
      cyan: code('\u001B[36m'),
      cyanBright: code('\u001B[96m'),
      cyanBrightBold: enabled ? '\u001B[96;1m' : BOLD,
      gray: code('\u001B[90m'),
      green: code('\u001B[32m'),
      greenBold: enabled ? '\u001B[32;1m' : BOLD,
      red: code('\u001B[31m'),
      yellow: code('\u001B[33m'),
      magenta: code('\u001B[35m'),
      magentaBright: code('\u001B[95m'),
      // Inverse video needs no colour and reads on any theme.
      selection: depth === 3 ? '\u001B[48;2;28;68;76m\u001B[97;1m' : INVERSE,
    },
    ink: (color) => (enabled ? color : undefined),
    arrivalBackground: (kind, progress) => {
      if (!enabled) return null;
      const step = ARRIVAL_STEPS.findIndex((limit) => progress < limit);
      if (step < 0) return null;
      if (depth < 3) return step < 4 ? ARRIVAL_ANSI16 : null;
      return ARRIVAL_RAMPS[kind][step]!;
    },
  };
}

export const palette = createPalette(resolveColorDepth());
// Read once, like the palette, so every wrap agrees with how delta was run.
export const plainDiffMode = isPlainDiffMode();
