import {describe, expect, it} from 'vitest';
import {
  getActionFromRenderedLine,
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

  it('detects action labels from the rendered row text', () => {
    const actions = [
      {id: 'copy.code', label: 'Copy code'},
      {id: 'copy.diff', label: 'Copy diff'},
      {id: 'copy.prompt', label: 'Copy prompt'},
    ] as const;
    const line = '\u001B[36m• src/example.ts:1:\u001B[0m          \u001B[90mCopy code\u001B[0m  \u001B[90mCopy diff\u001B[0m  \u001B[90mCopy prompt\u001B[0m';

    expect(getActionFromRenderedLine(35, line, actions)).toBe('copy.code');
    expect(getActionFromRenderedLine(46, line, actions)).toBe('copy.diff');
    expect(getActionFromRenderedLine(53, line, actions)).toBe('copy.prompt');
    expect(getActionFromRenderedLine(5, line, actions)).toBeNull();
  });
});
