import {describe, expect, it} from 'vitest';
import {
  buildDiffSections,
  flattenSectionLines,
  formatMetrics,
  getSectionForLine,
  getSectionIndexForLine,
} from '../src/sections.js';

describe('section helpers', () => {
  it('maps scroll offsets back to the file section in view', () => {
    const sections = buildDiffSections([
      {
        path: 'a.ts',
        metrics: {path: 'a.ts', additions: 3, deletions: 1, changedLines: 4},
        diff: 'line-a1\nline-a2',
      },
      {
        path: 'b.ts',
        metrics: {path: 'b.ts', additions: 2, deletions: 2, changedLines: 4},
        diff: 'line-b1\nline-b2\nline-b3',
      },
    ]);

    expect(getSectionIndexForLine(sections, 0)).toBe(0);
    expect(getSectionForLine(sections, sections[0].endLineExclusive)?.path).toBe('b.ts');
    expect(flattenSectionLines(sections).length).toBe(sections[1].endLineExclusive);
  });

  it('formats important metrics for header display', () => {
    expect(formatMetrics({additions: 5, deletions: 2, changedLines: 7})).toContain('7 changed');
  });
});
