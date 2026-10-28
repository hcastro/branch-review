import {describe, expect, it} from 'vitest';
import {
  applyScrollDelta,
  findFocusedBlockLineIndex,
  getTreeRowHitFromPanel,
  getTreeCopySlotWidth,
  getTreeIndicatorWidth,
  shouldShowTreeCopy,
} from '../src/ui/App.js';

describe('wheel helpers', () => {
  it('applies direct deltas at single-line precision', () => {
    expect(applyScrollDelta(10, 40, 3)).toBe(13);
    expect(applyScrollDelta(10, 40, -2)).toBe(8);
  });

  it('clamps at the viewport bounds', () => {
    expect(applyScrollDelta(0, 40, -3)).toBe(0);
    expect(applyScrollDelta(39, 40, 3)).toBe(40);
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
    const rows = lines.map((line) => ({kind: line.includes('•') ? 'header' as const : 'body' as const}));
    const section = {startLine: 3, endLineExclusive: 9};

    expect(findFocusedBlockLineIndex(rows, section, 3)).toBe(5);
    expect(findFocusedBlockLineIndex(rows, section, 6)).toBe(5);
    expect(findFocusedBlockLineIndex(rows, section, 8)).toBe(7);
    expect(findFocusedBlockLineIndex(rows, {startLine: 0, endLineExclusive: 3}, 8)).toBe(1);
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
    expect(shouldShowTreeCopy('file', false, false, true)).toBe(true);
    expect(shouldShowTreeCopy('dir', true, false)).toBe(false);
  });

  it('keeps the hidden tree copy slot the same width as the visible copy label', () => {
    expect(getTreeCopySlotWidth(false)).toBe(' Copy'.length);
    expect(getTreeIndicatorWidth(false)).toBe(1 + ' Copy'.length);
    expect(getTreeIndicatorWidth(false)).toBeLessThan(getTreeIndicatorWidth(true));
  });
});
