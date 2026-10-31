// The develop on a rendered page, as a schedule. The page opens as the raw
// text the reader just saw in the terminal, then each block in view grows
// from its raw lines' box into its rendered self, the diff's line tints
// shrink into the margin bars, and changed blocks glow once. Pure and
// DOM-free: the page script measures the boxes, asks for a plan, and plays
// it with the Web Animations API, and tests check the plan itself.

export type Rect = {x: number; y: number; w: number; h: number};

/** One block the develop can move: its rendered box, and the box its raw lines take, if they show. */
export type DevelopUnit = {
  id: string;
  rich: Rect;
  raw: Rect | null;
  mark: 'added' | 'modified' | null;
  kind: 'text' | 'image' | 'table' | 'code';
};

export type DevelopEffect = 'flip' | 'fade' | 'tint' | 'frame' | 'image' | 'rules' | 'code' | 'glow' | 'scroll';

export type DevelopStep = {id: string; effect: DevelopEffect; start: number; duration: number; easing: string};

export type VeilPlan = {
  /** How long the raw frame holds before anything moves. */
  hold: number;
  /** The fade of the markup marks (`#`, `|`, fences, `**`, `- `), or null when they go with the rest. */
  markers: {start: number; duration: number} | null;
  /** The raw text fading as the blocks take its place, or null when it goes with the frame. */
  text: {start: number; duration: number} | null;
  /** The raw frame's background fading to the page's. */
  fade: {start: number; duration: number};
};

export type DevelopPlan = {
  veil: VeilPlan | null;
  steps: DevelopStep[];
  /**
   * The fade-in of the before chips and removed markers in view, or null.
   * They sit where the blocks land, so they wait for the blocks to get there.
   */
  chips: {start: number; duration: number} | null;
  /** When the layout is final. */
  settled: number;
  /** When the last glow ends. */
  done: number;
};

/** The develop's timings, in ms. */
export const DEVELOP = {
  holdMs: 120,
  markersMs: 100,
  rawTextMs: 200,
  veilFadeMs: 400,
  flipMs: 440,
  staggerMs: 16,
  staggerCapMs: 200,
  tintStartMs: 220,
  tintMs: 400,
  // A picture's box shows first, in its final shape, and gives way as the
  // picture comes in.
  frameStartMs: 240,
  imageStartMs: 360,
  imageMs: 400,
  rulesStartMs: 300,
  rulesMs: 220,
  codeStartMs: 480,
  codeMs: 120,
  chipsStartMs: 480,
  chipsMs: 120,
  glowStartMs: 700,
  glowMs: 800,
  revisitScrollMs: 220,
  revisitGlowMs: 600,
  livePulseMs: 600,
  reducedFadeMs: 160,
} as const;

/** Grows out fast and settles slowly, so text is readable early. */
export const DEVELOP_EASING = 'cubic-bezier(.16,1,.3,1)';
const SETTLE_EASING = 'ease-out';
// A block's raw box can be far smaller or larger than its rendered one,
// such as a fence around one line or a table drawn as long rows; a scale
// past these reads as a flash, not a move.
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

export type DevelopMode = 'full' | 'short' | 'none';

/**
 * The transform that puts a block's rendered box over its raw box, scaled
 * from the top-left corner: the develop's first frame, which it then
 * animates to none. One scale, from the heights: a heading's raw line is
 * short and its rendered box spans the page, and scaling the two axes
 * apart would squash its letters.
 */
export function flipFrom(raw: Rect, rich: Rect) {
  const s = rich.h > 0 ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw.h / rich.h)) : 1;
  return {dx: raw.x - rich.x, dy: raw.y - rich.y, s};
}

const EMPTY: DevelopPlan = {veil: null, steps: [], chips: null, settled: 0, done: 0};

function finish(veil: VeilPlan | null, steps: DevelopStep[], chips: DevelopPlan['chips'] = null): DevelopPlan {
  const ends = (all: DevelopStep[]) => Math.max(0, ...all.map((step) => step.start + step.duration));
  const veilEnd = Math.max(veil ? veil.fade.start + veil.fade.duration : 0, chips ? chips.start + chips.duration : 0);
  return {veil, steps, chips, settled: Math.max(veilEnd, ends(steps.filter((step) => step.effect !== 'glow'))), done: Math.max(veilEnd, ends(steps))};
}

/**
 * The plan for one arrival. `full` is a file's first visit: the raw hold,
 * then every block in view develops. `short` is a revisit: a quick scroll
 * to the anchor block and a glow on it. `none` is a live refresh: a pulse
 * on the blocks in `pulse` (the ones new since the last page). `reduced`
 * (the page's prefers-reduced-motion) leaves one 160 ms fade of the raw
 * frame on a first visit and nothing else; `still` (`--no-animations`)
 * leaves nothing.
 */
export function planDevelop({units, viewport, mode, anchor, pulse = [], reduced = false, still = false}: {
  units: readonly DevelopUnit[];
  viewport: {height: number};
  mode: DevelopMode;
  anchor?: string;
  pulse?: readonly string[];
  reduced?: boolean;
  still?: boolean;
}): DevelopPlan {
  if (still) return EMPTY;
  if (reduced) return mode === 'full' ? finish({hold: 0, markers: null, text: null, fade: {start: 0, duration: DEVELOP.reducedFadeMs}}, []) : EMPTY;

  if (mode === 'short') {
    const target = units.find((each) => each.id === anchor);
    if (!target) return EMPTY;
    return finish(null, [
      {id: target.id, effect: 'scroll', start: 0, duration: DEVELOP.revisitScrollMs, easing: SETTLE_EASING},
      {id: target.id, effect: 'glow', start: DEVELOP.revisitScrollMs, duration: DEVELOP.revisitGlowMs, easing: SETTLE_EASING},
    ]);
  }

  if (mode === 'none') {
    const fresh = new Set(pulse);
    return finish(null, units.filter((each) => fresh.has(each.id)).map((each) => ({id: each.id, effect: 'glow', start: 0, duration: DEVELOP.livePulseMs, easing: SETTLE_EASING})));
  }

  const inView = units
    .filter((each) => each.rich.y < viewport.height && each.rich.y + each.rich.h > 0)
    .sort((left, right) => left.rich.y - right.rich.y || left.rich.x - right.rich.x);
  const steps: DevelopStep[] = [];
  for (const [index, each] of inView.entries()) {
    const start = DEVELOP.holdMs + Math.min(index * DEVELOP.staggerMs, DEVELOP.staggerCapMs);
    steps.push({id: each.id, effect: each.raw ? 'flip' : 'fade', start, duration: DEVELOP.flipMs, easing: DEVELOP_EASING});
    if (each.mark) steps.push({id: each.id, effect: 'tint', start: DEVELOP.tintStartMs, duration: DEVELOP.tintMs, easing: DEVELOP_EASING});
    if (each.kind === 'image') {
      steps.push({id: each.id, effect: 'frame', start: DEVELOP.frameStartMs, duration: DEVELOP.imageStartMs + DEVELOP.imageMs - DEVELOP.frameStartMs, easing: 'linear'});
      steps.push({id: each.id, effect: 'image', start: DEVELOP.imageStartMs, duration: DEVELOP.imageMs, easing: SETTLE_EASING});
    }
    if (each.kind === 'table') steps.push({id: each.id, effect: 'rules', start: DEVELOP.rulesStartMs, duration: DEVELOP.rulesMs, easing: SETTLE_EASING});
    if (each.kind === 'code') steps.push({id: each.id, effect: 'code', start: DEVELOP.codeStartMs, duration: DEVELOP.codeMs, easing: SETTLE_EASING});
  }
  for (const each of inView) {
    if (each.mark) steps.push({id: each.id, effect: 'glow', start: DEVELOP.glowStartMs, duration: DEVELOP.glowMs, easing: SETTLE_EASING});
  }
  return finish({
    hold: DEVELOP.holdMs,
    markers: {start: DEVELOP.holdMs, duration: DEVELOP.markersMs},
    // The raw text gives way faster than the frame's color, so the two
    // texts cross only briefly.
    text: {start: DEVELOP.holdMs, duration: DEVELOP.rawTextMs},
    fade: {start: DEVELOP.holdMs, duration: DEVELOP.veilFadeMs},
  }, steps, {start: DEVELOP.chipsStartMs, duration: DEVELOP.chipsMs});
}
