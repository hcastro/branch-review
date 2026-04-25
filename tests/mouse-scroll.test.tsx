import {describe, expect, it} from 'vitest';
import {
  getActionFromRenderedLine,
  applyMouseScroll,
  applyScrollDelta,
  findFocusedBlockLineIndex,
  getTreeRowHitFromPanel,
  shouldShowTreeCopy,
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
      {id: 'copy.prompt', label: 'Copy block'},
    ] as const;
    const line = '\u001B[36m• src/example.ts:1:\u001B[0m          \u001B[90mCopy code\u001B[0m  \u001B[90mCopy diff\u001B[0m  \u001B[90mCopy block\u001B[0m';

    expect(getActionFromRenderedLine(35, line, actions)).toBe('copy.code');
    expect(getActionFromRenderedLine(46, line, actions)).toBe('copy.diff');
    expect(getActionFromRenderedLine(53, line, actions)).toBe('copy.prompt');
    expect(getActionFromRenderedLine(5, line, actions)).toBeNull();
  });

  it('finds the focused block from scroll position within a file section', () => {
    const lines = [
      'file one',
      '│ • src/one.ts:1:                                      │',
      'code',
      'file two',
      'intro',
      '│ • src/two.ts:10:                                     │',
      'code',
      '│ • src/two.ts:20:                                     │',
      'code',
    ];
    const section = {startLine: 3, endLineExclusive: 9};

    expect(findFocusedBlockLineIndex(lines, section, 3)).toBe(5);
    expect(findFocusedBlockLineIndex(lines, section, 6)).toBe(5);
    expect(findFocusedBlockLineIndex(lines, section, 8)).toBe(7);
    expect(findFocusedBlockLineIndex(lines, {startLine: 0, endLineExclusive: 3}, 8)).toBe(1);
  });

  it('maps tree clicks from panel coordinates without row refs', () => {
    const panel = {left: 4, top: 3, width: 34, height: 12};
    const options = {
      treeOffset: 10,
      visibleTreeRows: 6,
      rowsLength: 30,
      contentWidth: 30,
    };

    expect(getTreeRowHitFromPanel(panel, 7, 5, options)).toMatchObject({
      rowIndex: 10,
      relativeX: 1,
    });
    expect(getTreeRowHitFromPanel(panel, 20, 8, options)).toMatchObject({
      rowIndex: 13,
      relativeX: 14,
    });
    expect(getTreeRowHitFromPanel(panel, 7, 4, options)).toBeNull();
    expect(getTreeRowHitFromPanel(panel, 40, 5, options)).toBeNull();
  });

  it('shows tree copy text only while hovering a file row', () => {
    expect(shouldShowTreeCopy('file', true, false)).toBe(true);
    expect(shouldShowTreeCopy('file', false, true)).toBe(false);
    expect(shouldShowTreeCopy('dir', true, false)).toBe(false);
  });
});
