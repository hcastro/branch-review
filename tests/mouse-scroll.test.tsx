import {describe, expect, it} from 'vitest';
import {
  applyMouseScroll,
  applyScrollDelta,
} from '../src/ui/App.js';

describe('wheel helpers', () => {
  it('applies direct deltas at single-line precision', () => {
    expect(applyScrollDelta(10, 40, 3)).toBe(13);
    expect(applyScrollDelta(10, 40, -2)).toBe(8);
    expect(applyMouseScroll(10, 40, 'scrolldown')).toBe(13);
    expect(applyMouseScroll(10, 40, 'scrollup')).toBe(7);
    expect(applyMouseScroll(10, 40, undefined)).toBe(10);
  });

  it('clamps at the viewport bounds', () => {
    expect(applyMouseScroll(0, 40, 'scrollup')).toBe(0);
    expect(applyScrollDelta(39, 40, 3)).toBe(40);
  });
});
