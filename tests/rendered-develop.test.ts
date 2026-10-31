import {describe, expect, it} from 'vitest';
import {DEVELOP, flipFrom, planDevelop, type DevelopUnit, type Rect} from '../src/rendered/develop.js';

// The page's develop as a schedule, before any browser runs it: which block
// moves when, for how long, and what each motion setting leaves of it.

const VIEW = {height: 800};

function unit(index: number, overrides: Partial<DevelopUnit> = {}): DevelopUnit {
  const y = 60 + index * 48;
  return {
    id: `b-0000000${index % 10}-${index}`,
    rich: {x: 340, y, w: 890, h: 40},
    raw: {x: 300, y: y - 10, w: 600, h: 20},
    mark: null,
    kind: 'text',
    ...overrides,
  };
}

const lastEnd = (steps: ReturnType<typeof planDevelop>['steps'], skip: string[] = ['glow']) => Math.max(0, ...steps.filter((step) => !skip.includes(step.effect)).map((step) => step.start + step.duration));

describe('planDevelop, the full develop', () => {
  const units = Array.from({length: 40}, (_, index) => unit(index, {mark: index % 5 === 0 ? 'added' : index % 7 === 0 ? 'modified' : null}));
  const plan = planDevelop({units, viewport: VIEW, mode: 'full'});

  it('reaches the final layout by 760 ms, and finishes its glow by 1.5 s', () => {
    expect(lastEnd(plan.steps)).toBeLessThanOrEqual(760);
    expect(plan.settled).toBe(lastEnd(plan.steps));
    expect(lastEnd(plan.steps, [])).toBeLessThanOrEqual(1500);
    expect(plan.done).toBe(lastEnd(plan.steps, []));
  });

  it('holds the raw frame 120 ms, fades the markup marks first, then its text, then its color', () => {
    expect(plan.veil).toEqual({hold: 120, markers: {start: 120, duration: 100}, text: {start: 120, duration: 200}, fade: {start: 120, duration: 400}});
  });

  it('staggers blocks 16 ms apart in reading order, and never more than 200 ms in all', () => {
    const flips = plan.steps.filter((step) => step.effect === 'flip');
    const starts = flips.map((step) => step.start);
    expect(starts.slice(0, 4)).toEqual([120, 136, 152, 168]);
    expect(Math.max(...starts)).toBe(120 + 200);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (const step of flips) {
      expect(step.duration).toBe(440);
      expect(step.easing).toBe('cubic-bezier(.16,1,.3,1)');
    }
  });

  it('moves only the blocks in view', () => {
    const inView = units.filter((each) => each.rich.y < VIEW.height && each.rich.y + each.rich.h > 0).map((each) => each.id);
    const moved = new Set(plan.steps.map((step) => step.id));
    expect([...moved].sort()).toEqual([...inView].sort());
    expect(inView.length).toBeLessThan(units.length);
    // A block above the view, scrolled past, doesn't move either.
    const above = planDevelop({units: [unit(0, {rich: {x: 0, y: -200, w: 10, h: 100}})], viewport: VIEW, mode: 'full'});
    expect(above.steps).toEqual([]);
  });

  it('shrinks each changed block\'s tint into its bar, and glows it once', () => {
    const marked = units.filter((each) => each.mark && each.rich.y < VIEW.height).map((each) => each.id);
    const tints = plan.steps.filter((step) => step.effect === 'tint');
    expect(tints.map((step) => step.id)).toEqual(marked);
    for (const step of tints) expect([step.start, step.duration]).toEqual([220, 400]);
    const glows = plan.steps.filter((step) => step.effect === 'glow');
    expect(glows.map((step) => step.id)).toEqual(marked);
    for (const step of glows) expect([step.start, step.duration]).toEqual([700, 800]);
  });

  it('develops images, table rules and code colors on their own beats', () => {
    const special = planDevelop({
      units: [unit(0, {kind: 'image'}), unit(1, {kind: 'table'}), unit(2, {kind: 'code'})],
      viewport: VIEW,
      mode: 'full',
    });
    const beat = (effect: string) => special.steps.filter((step) => step.effect === effect).map((step) => [step.start, step.duration]);
    expect(beat('image')).toEqual([[360, 400]]);
    // The picture's box shows from 240 ms and gives way as the picture sharpens.
    expect(beat('frame')).toEqual([[240, 520]]);
    expect(beat('rules')).toEqual([[300, 220]]);
    expect(beat('code')).toEqual([[480, 120]]);
    expect(lastEnd(special.steps)).toBeLessThanOrEqual(760);
  });

  it('fades in a block it has no raw lines for, without moving it', () => {
    const lone = planDevelop({units: [unit(0, {raw: null})], viewport: VIEW, mode: 'full'});
    expect(lone.steps.map((step) => step.effect)).toEqual(['fade']);
    expect(lone.steps[0]).toMatchObject({start: 120, duration: 440});
  });
});

describe('planDevelop, other trips', () => {
  const units = [unit(0), unit(1, {mark: 'modified'}), unit(2, {mark: 'added'}), unit(3)];

  it('on a revisit, scrolls 220 ms to the anchor and glows that block alone for 600 ms', () => {
    const plan = planDevelop({units, viewport: VIEW, mode: 'short', anchor: units[1]!.id});
    expect(plan.veil).toBeNull();
    expect(plan.steps).toEqual([
      {id: units[1]!.id, effect: 'scroll', start: 0, duration: 220, easing: 'ease-out'},
      {id: units[1]!.id, effect: 'glow', start: 220, duration: 600, easing: 'ease-out'},
    ]);
  });

  it('on a live refresh, pulses only the new blocks, with no develop', () => {
    const plan = planDevelop({units, viewport: VIEW, mode: 'none', pulse: [units[2]!.id, 'b-ffffffff-0']});
    expect(plan.veil).toBeNull();
    expect(plan.steps).toEqual([{id: units[2]!.id, effect: 'glow', start: 0, duration: 600, easing: 'ease-out'}]);
  });

  it('with reduced motion, is one 160 ms fade from the raw frame, static bars and no glow', () => {
    for (const mode of ['full', 'short', 'none'] as const) {
      const plan = planDevelop({units, viewport: VIEW, mode, reduced: true, anchor: units[1]!.id, pulse: [units[2]!.id]});
      expect(plan.steps, mode).toEqual([]);
      expect(plan.veil, mode).toEqual(mode === 'full' ? {hold: 0, markers: null, text: null, fade: {start: 0, duration: 160}} : null);
    }
  });

  it('with motion off (m=0), paints the final page at once', () => {
    const plan = planDevelop({units, viewport: VIEW, mode: 'full', still: true});
    expect(plan).toEqual({veil: null, steps: [], chips: null, settled: 0, done: 0});
  });

  it('fades the before chips and removed markers in with the code colors on a first visit only', () => {
    expect(planDevelop({units, viewport: VIEW, mode: 'full'}).chips).toEqual({start: 480, duration: 120});
    for (const mode of ['short', 'none'] as const) expect(planDevelop({units, viewport: VIEW, mode, anchor: units[1]!.id, pulse: [units[2]!.id]}).chips, mode).toBeNull();
    expect(planDevelop({units, viewport: VIEW, mode: 'full', reduced: true}).chips).toBeNull();
  });

  it('keeps its timings as named constants the page script and this test share', () => {
    expect(DEVELOP).toMatchObject({holdMs: 120, flipMs: 440, staggerMs: 16, staggerCapMs: 200, glowMs: 800, revisitScrollMs: 220, revisitGlowMs: 600, reducedFadeMs: 160});
  });
});

describe('flipFrom', () => {
  it('starts a block at its raw lines\' box, scaled from its top-left corner by their height, so its type grows evenly', () => {
    const raw: Rect = {x: 100, y: 50, w: 300, h: 40};
    const rich: Rect = {x: 140, y: 70, w: 900, h: 80};
    // Text keeps its shape: one scale from the heights, whatever the widths.
    expect(flipFrom(raw, rich)).toEqual({dx: -40, dy: -20, s: 0.5});
  });

  it('never scales to nothing or by more than four times', () => {
    expect(flipFrom({x: 0, y: 0, w: 0, h: 0}, {x: 0, y: 0, w: 100, h: 100})).toEqual({dx: 0, dy: 0, s: 0.25});
    expect(flipFrom({x: 0, y: 0, w: 10, h: 1000}, {x: 0, y: 0, w: 10, h: 10})).toEqual({dx: 0, dy: 0, s: 4});
    expect(flipFrom({x: 5, y: 0, w: 10, h: 10}, {x: 0, y: 0, w: 10, h: 0})).toEqual({dx: 5, dy: 0, s: 1});
  });
});
