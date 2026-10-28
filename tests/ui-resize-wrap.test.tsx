import {afterEach, describe, expect, it, vi} from 'vitest';
import {buildDiffSections} from '../src/sections.js';
import {frameLines, renderOnTerminal} from './ui-fixtures.js';

// Counts the widths the review is wrapped at: wrapping a large review takes
// seconds, so a burst of resizes must wrap it once.
const wraps = vi.hoisted(() => ({widths: [] as number[]}));
vi.mock('../src/sections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sections.js')>();
  return {
    ...actual,
    wrapSections: (...args: Parameters<typeof actual.wrapSections>) => {
      wraps.widths.push(args[1]);
      return actual.wrapSections(...args);
    },
  };
});

// React runs effects from setImmediate, which stays real; only timeouts are
// faked, so the settle delay is under the test's control.
async function settleEffects() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const longLine = `${'word '.repeat(40)}END`;

function fixture() {
  return {
    sections: buildDiffSections([{
      path: 'src/long.ts',
      metrics: {path: 'src/long.ts', additions: 1, deletions: 0, changedLines: 1},
      diff: longLine,
    }]),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resizing the terminal', () => {
  it('wraps the review once after a burst of resize events', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    wraps.widths = [];
    const instance = renderOnTerminal(fixture(), 120, 30);
    await settleEffects();
    expect(wraps.widths).toHaveLength(1);

    for (const columns of [118, 116, 114, 112, 110, 108]) {
      instance.resize(columns, 30);
      await settleEffects();
      vi.advanceTimersByTime(20);
      await settleEffects();
    }
    // Still the first wrap while the width keeps changing.
    expect(wraps.widths).toHaveLength(1);

    vi.advanceTimersByTime(500);
    await settleEffects();
    expect(wraps.widths).toHaveLength(2);
    expect(wraps.widths[1]).toBe(wraps.widths[0]! - 12);

    instance.unmount();
  });

  it('shows the review wrapped for the new width once the resize settles', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const instance = renderOnTerminal(fixture(), 160, 30);
    await settleEffects();
    const wideRows = frameLines(instance.lastFrame()).filter((line) => line.includes('word')).length;

    instance.resize(90, 30);
    await settleEffects();
    vi.advanceTimersByTime(500);
    await settleEffects();

    const lines = frameLines(instance.lastFrame());
    expect(lines.filter((line) => line.includes('word')).length).toBeGreaterThan(wideRows);
    expect(lines.join('\n')).toContain('END');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(90);

    instance.unmount();
  });
});
