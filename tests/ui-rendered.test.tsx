import fs from 'node:fs';
import stripAnsi from 'strip-ansi';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  binaryMediaFile,
  buildFixture,
  cellPosition,
  emitMouseMoveAt,
  emitMousePressAt,
  fakeMediaService,
  fakeRenderedService,
  flush,
  frameLines,
  gutter,
  markdownFile,
  renderFixture,
  sideInfo,
} from './ui-fixtures.js';
import {cleanupTempDirs} from './core-helpers.js';

// The trip from the TUI to a rendered page: the Rendered button and its
// hint, `r` and `R`, the footer's hints and toasts, and the beam the TUI
// plays on the way. The surface is real, with cmux, the browser opener and
// tool lookup recorded, so these tests see the exact commands a press
// sends, and nothing real ever runs.

afterEach(cleanupTempDirs);

const SIZE = {columns: 120, rows: 30};
const BAND = /[░▒▓]{3,}/;
const SPLIT_ARGS = (url: string) => ['--json', 'browser', 'open-split', url, '--workspace', 'workspace:1', '--focus', 'false'];

function docs() {
  return buildFixture([
    markdownFile('docs/guide.md', ['# Guide', '', 'Press r to see this page.', 'It opens in a split.']),
    {path: 'src/app.ts', rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: ['• src/app.ts:1: ', `${gutter(1)}b`]},
    markdownFile('README.md', ['# Readme', '', 'Hello.']),
  ]);
}

function diffRows(frame: string | undefined) {
  return frameLines(frame).slice(6, SIZE.rows - 4);
}

async function waitForFrame(instance: {lastFrame: () => string | undefined}, needle: string) {
  await vi.waitFor(() => expect(stripAnsi(instance.lastFrame() ?? '')).toContain(needle), {timeout: 4_000, interval: 20});
}

describe('the Rendered button', () => {
  it('leads a markdown file\'s header actions, and stays off every other file', async () => {
    const fixture = docs();
    const {service} = fakeRenderedService({review: fixture.review});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    const header = frameLines(instance.lastFrame())[4]!;
    expect(header).toMatch(/docs\/guide\.md\s+╭─Rendered ⇗─╮ ╭─Copy path─╮ ╭─Copy diff─╮ ╭─Copy file─╮/);

    instance.stdin.write('\u001B[B');
    await flush(2);
    const other = frameLines(instance.lastFrame())[4]!;
    expect(other).toContain('src/app.ts');
    expect(other).not.toContain('Rendered');
    instance.unmount();
  });

  it('is the last header action to drop when the pane narrows', async () => {
    const fixture = docs();
    const {service} = fakeRenderedService({review: fixture.review});
    for (const [columns, shown] of [[96, ['Rendered ⇗', 'Copy path', 'Copy diff']], [74, ['Rendered ⇗']]] as const) {
      const instance = renderFixture({...fixture, rendered: service}, {columns, rows: 30});
      await flush();
      const header = frameLines(instance.lastFrame())[4]!;
      const actions = [...header.matchAll(/╭─([^─]+)─╮/g)].map((match) => match[1]);
      expect(actions, `${columns} columns`).toEqual(shown);
      instance.unmount();
    }
  });

  it('says where the page opens while the pointer is over it', async () => {
    const fixture = docs();
    const {service} = fakeRenderedService({review: fixture.review});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    const at = cellPosition(instance.lastFrame(), ['Rendered ⇗'], 'Rendered');
    await emitMouseMoveAt(at.column + 2, at.row);
    await flush(2);
    expect(frameLines(instance.lastFrame())[1]).toContain('r · opens the rendered page in a split to the right');
    instance.unmount();
  });

  it('opens the page when clicked, like r', async () => {
    const fixture = docs();
    const {service, calls} = fakeRenderedService({review: fixture.review, motion: 'off'});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    const at = cellPosition(instance.lastFrame(), ['Rendered ⇗'], 'Rendered');
    await emitMousePressAt(at.column + 1, at.row);
    await waitForFrame(instance, '⇗ guide.md · in the split →');
    expect(calls).toHaveLength(1);
    instance.unmount();
  });
});

describe('the footer', () => {
  it('names r and R on a markdown file, and keeps its usual hints elsewhere', async () => {
    const fixture = docs();
    const {service} = fakeRenderedService({review: fixture.review});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    expect(frameLines(instance.lastFrame()).find((line) => line.includes('q quit'))).toContain('q quit • ↑/↓ jump file • r rendered ⇗ • R all • j/k scroll • [/] block • t tree');
    instance.stdin.write('\u001B[B');
    await flush(2);
    expect(frameLines(instance.lastFrame()).find((line) => line.includes('q quit'))).toContain('q quit • ↑/↓ jump file • j/k scroll • [/] block • ⏎ fold');
    instance.unmount();
  });

  it('draws a review with nothing to render byte for byte as before', async () => {
    const fixture = buildFixture([{path: 'src/app.ts', rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: ['• src/app.ts:1: ', `${gutter(1)}b`]}]);
    const without = renderFixture(fixture, SIZE);
    await flush();
    const {service} = fakeRenderedService({review: fixture.review});
    const withView = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    expect(withView.lastFrame()).toBe(without.lastFrame());
    without.unmount();
    withView.unmount();
  });
});

describe('r and R', () => {
  it('opens the active file in a cmux split, then sends that split to the next page', async () => {
    const fixture = docs();
    const {service, calls, opened} = fakeRenderedService({review: fixture.review, motion: 'off'});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ guide.md · in the split → · nothing left this machine');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/fake/bin/cmux');
    const url = calls[0]!.args[3]!;
    expect(calls[0]!.args).toEqual(SPLIT_ARGS(url));
    // The page, with the trip's hash: the line on top of the pane, a first visit.
    expect(url).toMatch(/^file:\/\/.+\/rendered\/[0-9a-f]{20}\.html#at=L1&f=0\.\d+&d=full&m=1&n=1$/);
    expect(fs.existsSync(new URL(url).pathname)).toBe(true);

    // The next file, and r again: the same split goes there.
    instance.stdin.write('\u001B[B');
    await flush(2);
    instance.stdin.write('\u001B[B');
    await flush(2);
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ README.md · in the split →');
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain('nothing left this machine');
    expect(calls[1]!.args.slice(0, 4)).toEqual(['browser', '--surface', 'surface:7', 'goto']);
    expect(calls[1]!.args[4]).not.toBe(url);
    expect(opened).toEqual([]);
    instance.unmount();
  });

  it('opens the page at the line on top of the pane, as far down the page as it is down the pane', async () => {
    const lines = Array.from({length: 60}, (_, index) => `Line ${index + 1} of a long page.`);
    const fixture = buildFixture([markdownFile('docs/long.md', lines)]);
    const {service, calls} = fakeRenderedService({review: fixture.review, motion: 'off'});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    const rows = diffRows(instance.lastFrame());
    // At the top the block's framed header comes first: line 1 is a few rows down.
    const first = rows.findIndex((row) => row.includes('Line 1 of'));
    expect(first).toBeGreaterThan(0);
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ long.md · in the split →');
    // The pane's view: its rows under the file head, down to its bottom border.
    const pane = frameLines(instance.lastFrame()).findIndex((line, index) => index > 6 && line.startsWith('╰')) - 6;
    expect(new URL(calls[0]!.args[3]!).hash).toBe(`#at=L1&f=${Math.round((first / pane) * 100) / 100}&d=full&m=1&n=1`);

    // Scrolled down, the top row is a later line, right at the top.
    for (let press = 0; press < 12; press += 1) instance.stdin.write('j');
    await flush(3);
    const top = /\s(\d+) │Line/.exec(diffRows(instance.lastFrame())[0]!)?.[1];
    expect(top).toBeDefined();
    instance.stdin.write('r');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(new URL(calls[1]!.args[4]!).hash).toBe(`#at=L${top}&f=0&d=short&m=1&n=2`);
    instance.unmount();
  });

  it('opens the first rendered file when the active file has no page', async () => {
    const fixture = docs();
    const {service} = fakeRenderedService({review: fixture.review, motion: 'off'});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    instance.stdin.write('\u001B[B');
    await flush(2);
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ docs/guide.md · first rendered file · in the split →');
    instance.unmount();
  });

  it('opens the overview on R', async () => {
    const fixture = docs();
    const {service, calls} = fakeRenderedService({review: fixture.review, motion: 'off'});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    instance.stdin.write('R');
    await waitForFrame(instance, '⇗ overview · in the split →');
    const html = fs.readFileSync(new URL(calls[0]!.args[3]!).pathname, 'utf8');
    expect(html).toContain('<title>Overview · branch-review</title>');
    expect(html).toContain('docs/guide.md');
    expect(html).toContain('README.md');
    instance.unmount();
  });

  it('opens the default browser by absolute path when cmux does not answer in time', async () => {
    const fixture = docs();
    const {service, opened} = fakeRenderedService({review: fixture.review, motion: 'off', cmux: [{ok: false, timedOut: true, reason: 'timed out'}]});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    instance.stdin.write('r');
    await waitForFrame(instance, "⇗ guide.md · cmux didn't answer · opened in your browser");
    expect(opened).toHaveLength(1);
    expect(opened[0]![0]).toBe('/usr/bin/open');
    expect(opened[0]![1]).toEqual([expect.stringMatching(/^file:\/\/.+\.html#at=L1&f=0\.\d+&d=full&m=1&n=1$/)]);
    instance.unmount();
  });

  it('opens a new browser tab per press outside cmux', async () => {
    const fixture = docs();
    const {service, calls, opened} = fakeRenderedService({review: fixture.review, motion: 'off', env: {}});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ guide.md · opened in your browser');
    instance.stdin.write('r');
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(calls).toEqual([]);
    instance.unmount();
  });

  it('refuses over SSH with the headless option, and plays nothing', async () => {
    const fixture = docs();
    const {service, calls, opened} = fakeRenderedService({review: fixture.review, env: {CMUX_WORKSPACE_ID: 'workspace:1', SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    const framesBefore = instance.frames.length;
    instance.stdin.write('r');
    await waitForFrame(instance, "✗ open isn't available over SSH · branch-review --render-out <dir> writes the pages");
    for (const frame of instance.frames.slice(framesBefore)) expect(stripAnsi(frame)).not.toMatch(BAND);
    expect(calls).toEqual([]);
    expect(opened).toEqual([]);
    instance.unmount();
  });

  it('works with image previews off', async () => {
    const fixture = docs();
    const {service, calls} = fakeRenderedService({review: fixture.review, motion: 'off'});
    const instance = renderFixture({...fixture, rendered: service, graphics: {protocol: 'none', detectionTimedOut: false} as never}, SIZE);
    await flush();
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ guide.md · in the split →');
    expect(calls).toHaveLength(1);
    instance.unmount();
  });

  it('says when nothing on the branch renders', async () => {
    const fixture = buildFixture([{path: 'src/app.ts', rawDiff: '@@ -1 +1 @@\n-a\n+b', rendered: ['• src/app.ts:1: ', `${gutter(1)}b`]}]);
    const {service, calls} = fakeRenderedService({review: fixture.review});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    instance.stdin.write('r');
    await waitForFrame(instance, 'nothing to render · no markdown files on this branch');
    instance.stdin.write('R');
    await flush(2);
    expect(calls).toEqual([]);
    instance.unmount();
  });

  it('says once, in the footer, that the rendered view turned off', async () => {
    const fixture = docs();
    const {service} = fakeRenderedService({review: fixture.review, motion: 'off', offAfterFirst: 'rendered view turned off: the worker kept crashing'});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    instance.stdin.write('R');
    await waitForFrame(instance, '✗ rendered view turned off: the worker kept crashing');
    instance.unmount();
  });

  it('says in the footer, with no key pressed, that the worker gave up during the background render', async () => {
    const fixture = docs();
    const {service} = fakeRenderedService({review: fixture.review, offAfterFirst: 'rendered view turned off: the worker kept crashing'});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    expect(stripAnsi(instance.lastFrame() ?? '')).not.toContain('turned off');
    // The background pass starts 2 s after the review, and its second fragment turns the view off.
    await vi.waitFor(() => expect(stripAnsi(instance.lastFrame() ?? '')).toContain('✗ rendered view turned off: the worker kept crashing'), {timeout: 6_000, interval: 20});
    instance.unmount();
  });
});

describe('the beam', () => {
  // A markdown file over a picture: the beam sweeps the text rows and
  // leaves the picture's placeholder rows as they are.
  function withPicture() {
    const fixture = buildFixture([
      markdownFile('docs/guide.md', ['# Guide', '', 'Press r to see this page.']),
      binaryMediaFile('docs/hero.png', 'added', ['0000000', '97fa3ee']),
    ]);
    const media = fakeMediaService({review: fixture.review, sides: {'97fa3ee': sideInfo({width: 200, height: 100, bytes: 232_000})}});
    return {fixture, media};
  }

  it('sweeps the diff text rows after the press, and never redraws a picture row', async () => {
    const {fixture, media} = withPicture();
    const {service} = fakeRenderedService({review: fixture.review});
    const instance = renderFixture({...fixture, media: media.service, rendered: service}, SIZE);
    await vi.waitFor(() => expect(instance.lastFrame()).toMatch(/\u001B\[38;5;\d+m\u{10EEEE}/u), {timeout: 4_000});
    const pictureRows = (frame: string) => frame.split('\n').filter((line) => line.includes('\u{10EEEE}'));
    const resting = pictureRows(instance.lastFrame()!);
    expect(resting.length).toBeGreaterThan(0);

    const from = instance.frames.length;
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ guide.md · in the split →');
    const during = instance.frames.slice(from);
    const swept = during.filter((frame) => diffRows(frame).some((row) => BAND.test(row)));
    expect(swept.length).toBeGreaterThanOrEqual(2);
    // The press shows on the button first, in inverse.
    expect(during.some((frame) => frame.includes('\u001B[7mRendered ⇗'))).toBe(true);
    for (const frame of during) expect(pictureRows(frame)).toEqual(resting);
    // The band never lands on the header rows, and is gone once the toast shows.
    for (const frame of during) expect(frameLines(frame).slice(0, 6).join('\n')).not.toMatch(BAND);
    expect(diffRows(instance.lastFrame()).some((row) => BAND.test(row))).toBe(false);
    instance.unmount();
  });

  it('sweeps only the rows that hold diff text, never a block\'s framed header nor the blank rows under the last line', async () => {
    const fixture = buildFixture([markdownFile('docs/guide.md', ['# Guide', '', 'Press r to see this page.', 'It opens in a split.'])]);
    const {service} = fakeRenderedService({review: fixture.review});
    const instance = renderFixture({...fixture, rendered: service}, SIZE);
    await flush();
    const resting = diffRows(instance.lastFrame());
    // A code row carries delta's gutter; the framed header and the padding don't.
    const code = resting.map((row) => row.includes('⋮'));
    expect(code.filter(Boolean)).toHaveLength(4);
    expect(resting.some((row) => row.includes('docs/guide.md:1:'))).toBe(true);
    expect(code.lastIndexOf(true)).toBeLessThan(resting.length - 3);

    const from = instance.frames.length;
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ guide.md · in the split →');
    const during = instance.frames.slice(from).map((frame) => diffRows(frame));
    expect(during.filter((rows) => rows.some((row) => BAND.test(stripAnsi(row)))).length).toBeGreaterThanOrEqual(2);
    for (const rows of during) {
      for (const [index, row] of rows.entries()) {
        if (!code[index]) expect(row, `row ${index}`).toBe(resting[index]);
      }
    }
    instance.unmount();
  });

  it('plays nothing with motion off, and one frame of ░ on the button with reduced motion', async () => {
    const fixture = docs();
    for (const motion of ['off', 'reduced'] as const) {
      const {service} = fakeRenderedService({review: fixture.review, motion});
      const instance = renderFixture({...fixture, rendered: service}, SIZE);
      await flush();
      const from = instance.frames.length;
      instance.stdin.write('r');
      await waitForFrame(instance, '⇗ guide.md · in the split →');
      const during = instance.frames.slice(from).map((frame) => stripAnsi(frame));
      for (const frame of during) expect(diffRows(frame).join('\n')).not.toMatch(BAND);
      expect(during.some((frame) => frameLines(frame)[4]!.includes('╭─░░░░░░░░░░─╮')), motion).toBe(motion === 'reduced');
      instance.unmount();
    }
  });

  it('keeps each beam frame within budget at 226×67', async () => {
    const lines = Array.from({length: 80}, (_, index) => `Line ${index} of a long document, wrapped at a readable width for the pane.`);
    const fixture = buildFixture([markdownFile('docs/long.md', lines)]);
    const {service} = fakeRenderedService({review: fixture.review});
    const size = {columns: 226, rows: 67};
    const instance = renderFixture({...fixture, rendered: service}, size);
    await flush();
    const from = instance.frames.length;
    const started = performance.now();
    instance.stdin.write('r');
    await waitForFrame(instance, '⇗ long.md · in the split →');
    const elapsed = performance.now() - started;
    const frames = instance.frames.slice(from);
    const swept = frames.filter((frame) => BAND.test(stripAnsi(frame)));
    expect(swept.length).toBeGreaterThanOrEqual(2);
    const largest = Math.max(...frames.map((frame) => Buffer.byteLength(frame)));
    expect(largest).toBeLessThanOrEqual(80 * 1024);
    // Printed for the report: the sweep's frames and what each cost.
    console.log(`beam at 226x67: ${swept.length} swept frames, largest ${largest} bytes, ${Math.round(elapsed)} ms from press to toast`);
    instance.unmount();
  });
});
