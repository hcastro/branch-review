import stripAnsi from 'strip-ansi';
import {afterEach, describe, expect, it, vi} from 'vitest';

// The palette reads the environment when first imported, so NO_COLOR is
// set before any import of the app, as in ui-no-color.test.tsx.
const previousEnv = vi.hoisted(() => {
  const previous = {NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR};
  process.env.NO_COLOR = '1';
  process.env.FORCE_COLOR = '3';
  return previous;
});

const {buildFixture, fakeRenderedService, flush, frameLines, markdownFile, renderFixture} = await import('./ui-fixtures.js');
const {cleanupTempDirs} = await import('./core-helpers.js');

for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(cleanupTempDirs);

// SGR parameters that only set attributes, never a color.
const ATTRIBUTE_ONLY = new Set(['', '0', '1', '2', '7', '22', '27']);

describe('the beam with NO_COLOR', () => {
  it('is skipped, the page still opens, and no frame carries a color', async () => {
    const fixture = buildFixture([markdownFile('docs/guide.md', ['# Guide', '', 'Press r.'])]);
    const {service, calls} = fakeRenderedService({review: fixture.review});
    const instance = renderFixture({...fixture, rendered: service}, {columns: 120, rows: 30});
    await flush();
    const from = instance.frames.length;
    // On a loaded runner the app can start listening for keys after its
    // first frame, and the test's stdin drops a key sent before that, so r
    // is sent again while the page hasn't been asked for. One call is still
    // asserted below.
    for (let attempt = 0; attempt < 10 && calls.length === 0; attempt += 1) {
      instance.stdin.write('r');
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), {timeout: 1_000, interval: 20}).catch(() => undefined);
    }
    // The wait is long for a loaded CI runner: this test is about color, not speed.
    await vi.waitFor(() => expect(stripAnsi(instance.lastFrame() ?? '')).toContain('⇗ guide.md opened in the browser split'), {timeout: 15_000});
    expect(calls).toHaveLength(1);
    for (const frame of instance.frames.slice(from)) {
      expect(frameLines(frame).slice(6).join('\n')).not.toMatch(/[░▒▓]{3,}/);
      const colors = [...frame.matchAll(/\u001B\[([0-9;:]*)m/g)].map((match) => match[1]!).filter((params) => params.split(/[;:]/).some((param) => !ATTRIBUTE_ONLY.has(param)));
      expect(colors).toEqual([]);
    }
    instance.unmount();
  });
});
