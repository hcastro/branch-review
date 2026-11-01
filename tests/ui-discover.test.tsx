import React from 'react';
import stripAnsi from 'strip-ansi';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {App} from '../src/ui/App.js';
import {fileKey} from '../src/git.js';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import type {LayoutResult, RenderedBackend} from '../src/rendered/backend.js';
import {createRenderedPane} from '../src/rendered/pane.js';
import type {PageLayout} from '../src/rendered/plan.js';
import type {OpenOutcome, RenderedPages} from '../src/rendered/service.js';
import {cleanupTempDirs} from './core-helpers.js';
import {decodePlaceholders, KITTY_CAPS, pngHeaderOnly} from './media-helpers.js';
import {
  binaryMediaFile,
  buildFixture,
  cellPosition,
  emitMouseMoveAt,
  emitMousePressAt,
  flush,
  frameLines,
  markdownFile,
  recordingWriter,
  renderSized,
  type FixtureFile,
} from './ui-fixtures.js';

// What a reader new to branch-review sees of Preview (`v`) and Review in
// browser (`r`, `R`): the header buttons in words with their hover tips,
// the footer hints, a one-time tip the first time a file can use either,
// and the `?` overlay listing every key. The pane draws pages from a fake
// browser; the pages that `r` opens come from a fake service.

afterEach(cleanupTempDirs);

const SIZE = {columns: 140, rows: 32};
const CAPS = {...KITTY_CAPS, cellPx: {w: 10, h: 20}, bg: '#101418', scheme: 'dark' as const};
const ROW = 20 / 1.25;
const LAYOUT: PageLayout = {heightCss: 40 * ROW, blocks: [{id: 'b-title', top: 0, bottom: 2 * ROW, lines: [1, 1]}], removed: [], links: [], anchors: []};

const PAGE = markdownFile('docs/page.md', ['# Title', '', 'A new paragraph.']);
const OTHER = markdownFile('docs/other.md', ['# Other', '', 'Text.']);
const CODE: FixtureFile = {path: 'src/app.ts', rawDiff: '@@ -0,0 +1,2 @@\n+one\n+two', rendered: ['• src/app.ts:1: ', ' 1 ⋮ 1 │one', ' 2 ⋮ 2 │two']};
const HERO = binaryMediaFile('docs/hero.png');

const TIP_BOTH = 'Tip: press v to preview this file as GitHub shows it, or r to open its changes in the browser';
const TIP_BROWSER = "Tip: press r to open this file's changes in the browser";

function setup({files = [PAGE, CODE, OTHER], preview = true, tips = true, animations = false, size = SIZE}: {files?: FixtureFile[]; preview?: boolean; tips?: boolean; animations?: boolean; size?: {columns: number; rows: number}} = {}) {
  const fixture = buildFixture(files);
  const registry = createImageRegistry({write: () => undefined, random: () => 0});
  const backend: Pick<RenderedBackend, 'layout' | 'tile' | 'disabledReason'> = {
    layout: async (request): Promise<LayoutResult> => ({ok: true, layout: LAYOUT, document: `doc-${request.source.fragment.key}`}),
    tile: async (request) => {
      const {geometry} = request.source;
      return {ok: true, png: pngHeaderOnly(geometry.sheetCols * geometry.cellPx.w, Math.min(geometry.tileRows, request.rows - request.index * geometry.tileRows) * geometry.cellPx.h)};
    },
    disabledReason: () => null,
  };
  const markdown = new Set(files.filter((file) => file.path.endsWith('.md')).map((file) => fileKey({path: file.path})));
  const pageable = new Set(files.filter((file) => /\.(md|png|svg)$/.test(file.path)).map((file) => fileKey({path: file.path})));
  const pane = createRenderedPane({
    backend,
    registry,
    caps: CAPS,
    env: preview ? {} : {BRANCH_REVIEW_PREVIEW: 'off'},
    chrome: () => ({path: '/fake/chrome-headless-shell', headless: '--headless'}),
    source: (key) => (markdown.has(key) ? {fragment: {cwd: '/repo', key: `frag-${key.replace(/\W/g, '')}`, path: key, status: 'modified', source: {kind: 'blob', id: 'abcdef1'}, groups: [], links: {}, assets: {base: null, after: {tree: 'HEAD'}, epoch: 0}}, base: 'development'} : null),
    fileForAlias: () => null,
  });
  // The footer's notices from the service, which a test can send.
  const notices: string[] = [];
  const listeners = new Set<() => void>();
  let version = 0;
  const opened: string[] = [];
  const pages: RenderedPages = {
    renderable: (key) => pageable.has(key),
    open: async ({fileKey: key}): Promise<OpenOutcome> => {
      opened.push(key);
      return {kind: 'info', message: `⇗ ${key} opened in the browser split`};
    },
    openOverview: async () => ({kind: 'info', message: '⇗ all files opened in the browser split'}),
    openHint: () => "Open this file's changes in a browser split, as GitHub shows them",
    opens: () => true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    takeNotices: () => notices.splice(0),
    pane,
  };
  const say = (notice: string) => {
    notices.push(notice);
    version += 1;
    for (const listener of listeners) listener();
  };
  const instance = renderSized(
    <App
      base="development"
      branch="HEAD"
      sections={fixture.sections}
      branchMetrics={fixture.review.metrics}
      review={fixture.review}
      copyWriter={recordingWriter([])}
      readFileContent={() => '# Title\n\nA new paragraph.\n'}
      dimensions={size}
      graphics={CAPS}
      tips={tips}
      animations={animations}
      rendered={{focus: (key) => pane.focus(key), ...pages}}
    />,
    size,
  );
  return {instance, say, opened};
}

const settle = (times = 8) => flush(times);
const text = (frame: string | undefined) => frameLines(frame).map((line) => stripAnsi(line)).join('\n');
const footer = (frame: string | undefined) => stripAnsi(frameLines(frame).at(-2) ?? '');
const header = (frame: string | undefined) => stripAnsi(frameLines(frame)[4] ?? '');
async function press(instance: ReturnType<typeof setup>['instance'], key: string) {
  instance.stdin.write(key);
  await settle();
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the header buttons, in words', () => {
  it('shows Preview and Review in browser on a markdown file, and Diff in place of Preview while the Preview shows', async () => {
    const {instance} = setup({tips: false});
    await settle();
    expect(header(instance.lastFrame())).toMatch(/docs\/page\.md +╭─Preview─╮ ╭─Review in browser ⇗─╮ ╭─Copy path─╮ ╭─Copy diff─╮ ╭─Copy file─╮/);
    await press(instance, 'v');
    expect(header(instance.lastFrame())).toMatch(/docs\/page\.md +╭─Diff─╮ ╭─Review in browser ⇗─╮ ╭─Copy path─╮/);
    await press(instance, 'v');
    expect(header(instance.lastFrame())).toMatch(/╭─Preview─╮ ╭─Review in browser ⇗─╮/);
    instance.unmount();
  });

  it('shows the Preview when Preview is clicked, and the diff again when Diff is', async () => {
    const {instance} = setup({tips: false});
    await settle();
    const click = async (label: string) => {
      const at = cellPosition(instance.lastFrame(), ['docs/page.md', label], label);
      await emitMousePressAt(at.column + 2, at.row);
      await settle();
    };
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    await click('Preview');
    expect(header(instance.lastFrame())).toContain('╭─Diff─╮');
    expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
    await click('Diff');
    expect(header(instance.lastFrame())).toContain('╭─Preview─╮');
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    instance.unmount();
  });

  it('shows Review in browser beside an image\'s own buttons, and no Preview', async () => {
    const {instance} = setup({files: [HERO, PAGE], tips: false});
    await settle();
    const row = header(instance.lastFrame());
    expect(row).toMatch(/docs\/hero\.png +╭─Review in browser ⇗─╮ ╭─Copy path─╮/);
    expect(row).not.toContain('Preview');
    instance.unmount();
  });

  it('shows no Preview button where Preview is turned off, and keeps Review in browser', async () => {
    const {instance} = setup({preview: false, tips: false});
    await settle();
    expect(header(instance.lastFrame())).toMatch(/docs\/page\.md +╭─Review in browser ⇗─╮ ╭─Copy path─╮/);
    expect(header(instance.lastFrame())).not.toContain('Preview');
    instance.unmount();
  });

  it('keeps Preview and Review in browser the last buttons to drop when the header narrows', async () => {
    for (const [columns, shown] of [[110, ['Preview', 'Review in browser ⇗', 'Copy path']], [84, ['Preview', 'Review in browser ⇗']], [70, ['Preview', 'Review in browser ⇗']]] as const) {
      const {instance} = setup({tips: false, size: {columns, rows: 32}});
      await settle();
      const actions = [...header(instance.lastFrame()).matchAll(/╭─([^─]+)─╮/g)].map((match) => match[1]);
      expect(actions, `${columns} columns`).toEqual(shown);
      instance.unmount();
    }
  });

  it('says in plain words what each button does while the pointer is over it', async () => {
    const {instance} = setup({tips: false});
    await settle();
    const tipFor = async (label: string) => {
      const at = cellPosition(instance.lastFrame(), [label], label.split(' ')[0]!);
      await emitMouseMoveAt(at.column + 2, at.row);
      await settle();
      return stripAnsi(frameLines(instance.lastFrame())[1] ?? '');
    };
    expect(await tipFor('Preview')).toContain('Show this file the way GitHub draws it, right here');
    expect(await tipFor('Review in browser ⇗')).toContain("Open this file's changes in a browser split, as GitHub shows them");
    await press(instance, 'v');
    expect(await tipFor('Diff')).toContain("Go back to this file's diff");
    instance.unmount();
  });
});

describe('the footer hints, in words', () => {
  it('names v, r and R in words on a markdown file, v back to diff in the Preview, and ? keys last, with no bare ⇗', async () => {
    const {instance} = setup({tips: false});
    await settle();
    expect(footer(instance.lastFrame())).toContain('q quit • ↑/↓ jump file • v preview • r review in browser • R all files in browser • j/k scroll • [/] block • t tree • ? keys');
    await press(instance, 'v');
    expect(footer(instance.lastFrame())).toContain('q quit • v back to diff • [/] change • j/k scroll • c copy block • r review in browser • t tree • ? keys');
    expect(footer(instance.lastFrame())).not.toMatch(/• [^•]*⇗/);
    // A code file in the same review keeps its hints, and the keys at the end.
    await press(instance, 'v');
    await press(instance, '\u001B[B');
    expect(footer(instance.lastFrame())).toContain('q quit • ↑/↓ jump file • j/k scroll • [/] block • ⏎ fold • y d f c p b copy • t tree • ? keys');
    instance.unmount();
  });

  it('keeps ? keys at the end when the footer is too short for every hint', async () => {
    const {instance} = setup({tips: false, size: {columns: 80, rows: 32}});
    await settle();
    // The footer inside its border, without the range label at its right end.
    const hints = footer(instance.lastFrame()).replace(/^│ /, '').replace(/ *│$/, '').replace(/ +…?[^ ]*\.\.\.HEAD$/, '').trimEnd();
    expect(hints.startsWith('q quit • '), hints).toBe(true);
    expect(hints.endsWith(' • ? keys'), hints).toBe(true);
    instance.unmount();
  });
});

describe('the first-time tip', () => {
  it('shows once, on the first file Preview or Review in browser can show, until a key is pressed', async () => {
    const {instance} = setup();
    await settle();
    expect(footer(instance.lastFrame())).toContain(TIP_BOTH);
    await press(instance, 'j');
    expect(footer(instance.lastFrame())).not.toContain('Tip:');
    expect(footer(instance.lastFrame())).toContain('v preview');
    // Never again this session: not on another markdown file, nor back on this one.
    await press(instance, '\u001B[B');
    await press(instance, '\u001B[B');
    expect(header(instance.lastFrame())).toContain('docs/other.md');
    expect(footer(instance.lastFrame())).toContain('v preview');
    await press(instance, '\u001B[A');
    await press(instance, '\u001B[A');
    expect(text(instance.lastFrame())).not.toContain('Tip:');
    instance.unmount();
  });

  it('waits for the first file it applies to, and ends by itself after about 6 s', async () => {
    const {instance} = setup({files: [CODE, PAGE]});
    await settle();
    expect(footer(instance.lastFrame())).not.toContain('Tip:');
    await press(instance, '\u001B[B');
    expect(footer(instance.lastFrame())).toContain(TIP_BOTH);
    await sleep(5_000);
    expect(footer(instance.lastFrame())).toContain(TIP_BOTH);
    await vi.waitFor(() => expect(footer(instance.lastFrame())).not.toContain('Tip:'), {timeout: 2_500, interval: 50});
    expect(footer(instance.lastFrame())).toContain('v preview');
    instance.unmount();
  }, 20_000);

  it('names only r on an image, and on markdown where Preview is off', async () => {
    const image = setup({files: [HERO, PAGE]});
    await settle();
    expect(footer(image.instance.lastFrame())).toContain(TIP_BROWSER);
    image.instance.unmount();
    const off = setup({preview: false});
    await settle();
    expect(footer(off.instance.lastFrame())).toContain(TIP_BROWSER);
    off.instance.unmount();
  });

  it('never covers a toast: a toast that comes during the tip waits for it, and the tip waits for a toast on screen', async () => {
    const during = setup();
    await settle();
    during.say('✗ Preview and Review in browser turned off: the worker kept crashing');
    await settle();
    expect(footer(during.instance.lastFrame())).toContain(TIP_BOTH);
    await press(during.instance, 'z');
    expect(footer(during.instance.lastFrame())).toContain('✗ Preview and Review in browser turned off: the worker kept crashing');
    during.instance.unmount();

    const after = setup({files: [CODE, PAGE]});
    await settle();
    // A toast, then the move to the first file the tip is for.
    await press(after.instance, 'y');
    expect(footer(after.instance.lastFrame())).toMatch(/Copied|copied/);
    await press(after.instance, '\u001B[B');
    expect(footer(after.instance.lastFrame())).not.toContain('Tip:');
    await vi.waitFor(() => expect(footer(after.instance.lastFrame())).toContain(TIP_BOTH), {timeout: 4_000, interval: 50});
    // Its 6 s start when it shows, not while it waited under the toast.
    await sleep(5_000);
    expect(footer(after.instance.lastFrame())).toContain(TIP_BOTH);
    after.instance.unmount();
  }, 20_000);

  it('stays while the pointer moves over the terminal, which sends the app a mouse report and not a key', async () => {
    const {instance} = setup();
    await settle();
    expect(footer(instance.lastFrame())).toContain(TIP_BOTH);
    // The terminal reports a move to both readers of stdin: the mouse
    // tracking and the keys.
    await emitMouseMoveAt(60, 15);
    instance.stdin.write('\u001B[<35;60;15M');
    await settle();
    expect(footer(instance.lastFrame())).toContain(TIP_BOTH);
    await press(instance, 'j');
    expect(footer(instance.lastFrame())).not.toContain('Tip:');
    instance.unmount();
  });

  it('never shows in a Preview, where it would hide the Preview\'s hints and hold back the toast of a failure', async () => {
    const {instance} = setup({files: [CODE, PAGE]});
    await settle();
    // A toast, so the tip waits, then into a Preview before the toast ends.
    await press(instance, 'y');
    await press(instance, '\u001B[B');
    await press(instance, 'v');
    expect(header(instance.lastFrame())).toContain('╭─Diff─╮');
    await vi.waitFor(() => expect(footer(instance.lastFrame())).not.toMatch(/Copied|copied/), {timeout: 4_000, interval: 50});
    await sleep(500);
    expect(footer(instance.lastFrame())).not.toContain('Tip:');
    expect(footer(instance.lastFrame())).toContain('v back to diff');
    // A reader who opened a Preview has found v, so the tip is spent.
    await press(instance, 'v');
    await sleep(500);
    expect(footer(instance.lastFrame())).not.toContain('Tip:');
    expect(footer(instance.lastFrame())).toContain('v preview');
    instance.unmount();
  }, 15_000);

  it('ends at a click like at a key, and the toast the click brings shows at once', async () => {
    const {instance} = setup();
    await settle();
    expect(footer(instance.lastFrame())).toContain(TIP_BOTH);
    const at = cellPosition(instance.lastFrame(), ['docs/page.md', 'Copy path'], 'Copy path');
    await emitMousePressAt(at.column + 2, at.row);
    await settle();
    expect(footer(instance.lastFrame())).not.toContain('Tip:');
    expect(footer(instance.lastFrame())).toMatch(/Copied|copied/);
    instance.unmount();
  });

  it('is plain text, the same with or without animations', async () => {
    const footerLine = async (animations: boolean) => {
      const {instance} = setup({animations});
      await settle();
      const line = (instance.lastFrame() ?? '').split('\n').at(-2) ?? '';
      instance.unmount();
      return line;
    };
    const still = await footerLine(false);
    expect(stripAnsi(still)).toContain(TIP_BOTH);
    expect(await footerLine(true)).toBe(still);
  });
});

describe('the ? overlay', () => {
  it('lists every key in plain words, grouped, and Esc closes it without quitting', async () => {
    const {instance} = setup({tips: false});
    await settle();
    await press(instance, '?');
    const shown = text(instance.lastFrame());
    for (const group of ['Move around', 'Copy', 'Preview and browser', 'Images and video']) expect(shown).toContain(group);
    for (const line of ['Previous or next file', "The file's path", 'Preview a markdown file as GitHub shows it', "Review this file's changes in the browser", 'All files in the browser', "In a Preview: copy the change's diff or prompt", 'Side by side, flip, or difference']) expect(shown).toContain(line);
    // Every key that does something, with each of the keys a row's action has.
    expect(shown).toMatch(/Enter Space +Fold or unfold the block/);
    expect(shown).toMatch(/q Esc Ctrl\+C +Quit/);
    expect(shown).toMatch(/p b +In a Preview: copy the change's diff or prompt/);
    expect(shown).toContain('Esc or ? closes');
    expect(shown).not.toContain('docs/page.md  ');
    await press(instance, '\u001B');
    await settle();
    expect(text(instance.lastFrame())).not.toContain('Move around');
    expect(header(instance.lastFrame())).toContain('docs/page.md');
    instance.unmount();
  });

  it('closes on ? again, and keys meant for the diff do nothing while it is open', async () => {
    const {instance, opened} = setup({tips: false});
    await settle();
    const before = header(instance.lastFrame());
    await press(instance, '?');
    await press(instance, 'r');
    await press(instance, '\u001B[B');
    await press(instance, 'v');
    expect(opened).toEqual([]);
    await press(instance, '?');
    expect(text(instance.lastFrame())).not.toContain('Move around');
    expect(header(instance.lastFrame())).toBe(before);
    instance.unmount();
  });

  it('still quits on q while it is open', async () => {
    const {instance} = setup({tips: false});
    await settle();
    let exited = false;
    void instance.waitUntilExit().then(() => {
      exited = true;
    });
    await press(instance, '?');
    expect(exited).toBe(false);
    await press(instance, 'q');
    expect(exited).toBe(true);
    instance.unmount();
  });

  it('scrolls with j and k where the window is too short for every key, and says so in the footer', async () => {
    const {instance} = setup({tips: false, size: {columns: 90, rows: 24}});
    await settle();
    await press(instance, '?');
    expect(footer(instance.lastFrame())).toContain('q quit • Esc or ? close • j/k scroll');
    expect(text(instance.lastFrame())).toContain('Keys · Esc or ? closes');
    for (let step = 0; step < 60; step += 1) instance.stdin.write('j');
    await settle();
    const bottom = text(instance.lastFrame());
    expect(bottom).not.toContain('Keys · Esc or ? closes');
    expect(bottom).toContain('On a video: both frame strips, or one');
    await press(instance, 'k');
    await press(instance, 'k');
    expect(text(instance.lastFrame())).not.toContain('Keys · Esc or ? closes');
    for (let step = 0; step < 60; step += 1) instance.stdin.write('k');
    await settle();
    expect(text(instance.lastFrame())).toContain('Keys · Esc or ? closes');
    instance.unmount();
  });

  it('covers a Preview whole, with no picture cell left under it, and the Preview comes back when it closes', async () => {
    const {instance} = setup({tips: false});
    await settle();
    await press(instance, 'v');
    expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
    await press(instance, '?');
    expect(decodePlaceholders(instance.lastFrame())).toEqual([]);
    expect(text(instance.lastFrame())).toContain('Move around');
    await press(instance, '?');
    expect(decodePlaceholders(instance.lastFrame()).length).toBeGreaterThan(0);
    expect(header(instance.lastFrame())).toContain('╭─Diff─╮');
    instance.unmount();
  });

  it('ends the first-time tip like any other key', async () => {
    const {instance} = setup();
    await settle();
    expect(footer(instance.lastFrame())).toContain(TIP_BOTH);
    await press(instance, '?');
    await press(instance, '?');
    expect(footer(instance.lastFrame())).not.toContain('Tip:');
    instance.unmount();
  });
});
