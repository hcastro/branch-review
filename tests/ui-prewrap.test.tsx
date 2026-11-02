import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import stripAnsi from 'strip-ansi';
import {render} from 'ink-testing-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {DiffRange} from '../src/git.js';
import type {ReviewFile, ReviewModel} from '../src/review/model.js';
import {buildReviewSections} from '../src/review/build.js';
import type {CreateRepoWatcherOptions} from '../src/watch/repoWatcher.js';
import {plainDiffMode} from '../src/ui/palette.js';
import {PREWRAP_MIN_LINES, ReviewController} from '../src/ui/ReviewController.js';

// Records the sections each render-time wrap is given, by their line count,
// the width of every wrap, and when the latest wrap ahead (in slices) ended.
// `beforeSliced`, when set, runs once before the next wrap ahead starts.
const wraps = vi.hoisted(() => ({
  lineCounts: [] as number[],
  widths: [] as number[],
  sliced: [] as Array<{lineCount: number; width: number}>,
  prewrapDoneAt: 0,
  beforeSliced: null as null | (() => Promise<void>),
}));
vi.mock('../src/sections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sections.js')>();
  return {
    ...actual,
    wrapSections: (...args: Parameters<typeof actual.wrapSections>) => {
      wraps.lineCounts.push(...args[0].map((section) => section.lines.length));
      wraps.widths.push(args[1]);
      return actual.wrapSections(...args);
    },
    wrapSectionsInSlices: async (...args: Parameters<typeof actual.wrapSectionsInSlices>) => {
      wraps.sliced.push({lineCount: args[0].reduce((sum, section) => sum + section.lines.length, 0), width: args[1]});
      const before = wraps.beforeSliced;
      wraps.beforeSliced = null;
      if (before) await before();
      try {
        return await actual.wrapSectionsInSlices(...args);
      } finally {
        wraps.prewrapDoneAt = performance.now();
      }
    },
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  wraps.beforeSliced = null;
});

function createRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-prewrap-'));
  tempDirs.push(cwd);
  execFileSync('git', ['init', '-q', '-b', 'development'], {cwd, stdio: 'ignore'});
  return cwd;
}

// A delta row as delta draws it: line numbers, the gutter and 24-bit color
// around each token. The `+` after the gutter is the marker a plain diff
// row carries, so a wrap with the wrong marker option hangs its continuation
// rows at another column.
function deltaRow(index: number) {
  return `\x1B[34m\x1B[38;5;88m      \x1B[34m⋮\x1B[38;5;28m ${String(index + 1).padStart(6)}  \x1B[34m│+\x1B[48;2;0;56;0;38;2;249;38;114mexport\x1B[38;2;248;248;242m \x1B[38;2;102;217;239mconst\x1B[38;2;248;248;242m \x1B[38;2;255;255;255mvalue${index}\x1B[38;2;248;248;242m = { id: \x1B[38;2;190;132;255m${index}\x1B[38;2;248;248;242m, name: \x1B[38;2;230;219;116m"item ${index}"\x1B[38;2;248;248;242m };\x1B[0m\x1B[48;2;0;56;0m\x1B[0K\x1B[0m`;
}

// A file of `rows` delta rows starting at row `first`. The signature names
// the content, as the review builder's does.
function fileOf(filePath: string, rows: number, first = 0): ReviewFile {
  return {
    path: filePath,
    status: 'added',
    signature: `${filePath}:${first}:${rows}`,
    metrics: {path: filePath, additions: rows, deletions: 0, changedLines: rows},
    rawDiff: '',
    renderedLines: Array.from({length: rows}, (_, index) => deltaRow(first + index)),
    blocks: [],
  };
}

function reviewOfFiles(files: ReviewFile[]): ReviewModel {
  const changedLines = files.reduce((sum, file) => sum + file.metrics.changedLines, 0);
  return {
    base: 'development',
    branch: 'HEAD + worktree',
    label: 'development...HEAD + worktree',
    metrics: {filesChanged: files.length, additions: changedLines, deletions: 0, changedLines},
    files,
  };
}

function reviewOf(filePath: string, rows: number): ReviewModel {
  return reviewOfFiles([fileOf(filePath, rows)]);
}

const emptyReview: ReviewModel = reviewOfFiles([]);

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resetRecords() {
  wraps.lineCounts = [];
  wraps.widths = [];
  wraps.sliced = [];
  wraps.prewrapDoneAt = 0;
}

// Each test's timeout, and how long all the waits after its mount may take
// together before they give up and let the test's own assertions fail. The
// budget ends well before the timeout, so a stuck wait fails on an assertion
// and the test's `finally` still unmounts the controller. Both are wide, so a
// slow runner only makes a test slower.
type WaitTiming = {timeoutMs: number; waitBudgetMs: number};
const QUICK_TEST: WaitTiming = {timeoutMs: 60_000, waitBudgetMs: 45_000};
const WIDTH_TEST: WaitTiming = {timeoutMs: 180_000, waitBudgetMs: 120_000};

/**
 * Mounts the controller in watch mode. `land` answers the next refresh with
 * `review` under `fingerprint`, starts it, and waits until `landed` holds for
 * the frame. `until` waits for any condition. Every wait stops when the
 * test's wait budget, counted from the mount, runs out. A 1 ms ticker records
 * when the event loop turns.
 */
async function mountController(timing: WaitTiming) {
  if (timing.waitBudgetMs > timing.timeoutMs - 5_000) {
    throw new Error(`wait budget ${timing.waitBudgetMs} ms must end at least 5 s before the ${timing.timeoutMs} ms timeout`);
  }
  const budgetEndsAt = Date.now() + timing.waitBudgetMs;
  const cwd = createRepo();
  const range: DiffRange = {base: 'development', branch: 'HEAD', diffArg: 'development', includeWorktree: true};
  let watcher: CreateRepoWatcherOptions | null = null;
  let answer = {fingerprint: 'before', review: emptyReview};
  let answeredAt = 0;
  const instance = render(
    <ReviewController
      cwd={cwd}
      range={range}
      initialReview={emptyReview}
      initialFingerprint="before"
      watch
      requestedBranch="HEAD"
      requestedBase="development"
      refreshInWorker={async () => {
        answeredAt = performance.now();
        return {range, fingerprint: answer.fingerprint, branchName: 'feature/prewrap', review: answer.review};
      }}
      createWatcher={(options) => {
        watcher = options;
        return {close: async () => undefined};
      }}
    />,
  );
  const ticks: number[] = [];
  const ticker = setInterval(() => ticks.push(performance.now()), 1);
  const frame = () => stripAnsi(instance.lastFrame() ?? '');
  // Let the pane's wrap width settle before a refresh lands.
  await flush(300);
  resetRecords();

  const until = async (done: (frame: string) => boolean) => {
    while (!done(frame()) && Date.now() < budgetEndsAt) await flush(5);
    return frame();
  };

  return {
    frame,
    ticks,
    get answeredAt() {
      return answeredAt;
    },
    until,
    async land(review: ReviewModel, fingerprint: string, landed: (frame: string) => boolean) {
      answer = {fingerprint, review};
      watcher!.onChange();
      return until(landed);
    },
    resize(columns: number) {
      Object.defineProperty(instance.stdout, 'columns', {value: columns, configurable: true});
      instance.stdout.emit('resize');
    },
    unmount() {
      clearInterval(ticker);
      instance.unmount();
    },
  };
}

// The unrecorded wrap, for the rows a test expects to see.
const {wrapSections} = await vi.importActual<typeof import('../src/sections.js')>('../src/sections.js');
const expectedRows = new Map<string, string[]>();

// Each line wraps on its own, so the first rows of a section come from its
// first lines alone.
const PREFIX_LINES = 10;

// The rows the diff pane shows at `width` for the first PREFIX_LINES lines of
// `section`, as text.
function rowsAt(section: ReturnType<typeof buildReviewSections>[number], width: number) {
  const key = `${section.path}\0${width}`;
  let rows = expectedRows.get(key);
  if (!rows) {
    const prefix = {...section, lines: section.lines.slice(0, PREFIX_LINES)};
    rows = wrapSections([prefix], width, {plusMinusMarkers: plainDiffMode})[0]!.lines.map((row) => stripAnsi(row).trimEnd());
    expectedRows.set(key, rows);
  }
  return rows;
}

// Just over the limit: the width tests need a review that is wrapped ahead,
// and wrap it several times, so a bigger one only makes them slower.
const WIDTH_TEST_ROWS = PREWRAP_MIN_LINES + 2_000;

const NARROW_COLUMNS = 60;

// Short budgets for the tests of the wait helper itself.
const STUCK_WAIT: WaitTiming = {timeoutMs: 10_000, waitBudgetMs: 1_000};
const SLOW_WAIT: WaitTiming = {timeoutMs: 10_000, waitBudgetMs: 4_000};

describe('the wait helper', () => {
  it('gives up a wait that never holds before the test times out, so the test unmounts the controller', async () => {
    const startedAt = Date.now();
    const controller = await mountController(STUCK_WAIT);
    try {
      await controller.until(() => false);
      expect(Date.now() - startedAt).toBeLessThan(STUCK_WAIT.timeoutMs - 5_000);
    } finally {
      controller.unmount();
    }
    // The ticker stopped: the controller was unmounted.
    const ticks = controller.ticks.length;
    await flush(50);
    expect(controller.ticks.length).toBe(ticks);
  }, STUCK_WAIT.timeoutMs);

  it('still waits out a condition that holds inside the budget', async () => {
    const controller = await mountController(SLOW_WAIT);
    try {
      const readyAt = Date.now() + 1_500;
      await controller.until(() => Date.now() >= readyAt);
      expect(Date.now()).toBeGreaterThanOrEqual(readyAt);
    } finally {
      controller.unmount();
    }
  }, SLOW_WAIT.timeoutMs);

  it('refuses a wait budget that does not end well before the timeout', async () => {
    await expect(mountController({timeoutMs: 60_000, waitBudgetMs: 120_000})).rejects.toThrow('must end at least 5 s before');
    await expect(mountController({timeoutMs: 60_000, waitBudgetMs: 56_000})).rejects.toThrow('must end at least 5 s before');
    for (const timing of [QUICK_TEST, WIDTH_TEST]) expect(timing.waitBudgetMs).toBeLessThanOrEqual(timing.timeoutMs - 5_000);
  });
});

describe('a refresh that lands a large review', () => {
  it('wraps it ahead in slices, so its render does not wrap it and the event loop keeps turning', async () => {
    const rows = 120_000;
    expect(rows).toBeGreaterThan(PREWRAP_MIN_LINES);
    const controller = await mountController(QUICK_TEST);
    try {
      const frame = await controller.land(reviewOf('src/big.ts', rows), 'after', (text) => text.includes('value0 = { id: 0'));

      expect(frame).toContain('big.ts');
      expect(frame).toContain('value0 = { id: 0');
      // The render took the rows wrapped ahead instead of wrapping them itself.
      expect(wraps.lineCounts.filter((count) => count > rows)).toEqual([]);
      // The event loop turned while the rows were wrapped ahead. Wrapped in
      // one go, it would not turn at all in this window, on any machine.
      expect(wraps.prewrapDoneAt).toBeGreaterThan(0);
      const answeredAt = controller.answeredAt;
      expect(controller.ticks.filter((at) => at > answeredAt && at < wraps.prewrapDoneAt).length).toBeGreaterThanOrEqual(10);
    } finally {
      controller.unmount();
    }
  }, QUICK_TEST.timeoutMs);

  it('wraps a review under the limit in its render, as before', async () => {
    const rows = 50;
    const controller = await mountController(QUICK_TEST);
    try {
      const frame = await controller.land(reviewOf('src/small.ts', rows), 'after', (text) => text.includes('value0 = { id: 0'));

      expect(frame).toContain('value0 = { id: 0');
      expect(wraps.lineCounts).toContain(rows + 1);
    } finally {
      controller.unmount();
    }
  }, QUICK_TEST.timeoutMs);

  it('wraps ahead only the files the render has not wrapped yet', async () => {
    const files = Array.from({length: 400}, (_, index) => fileOf(`src/f${String(index).padStart(3, '0')}.ts`, 300, index * 300));
    const controller = await mountController(QUICK_TEST);
    try {
      await controller.land(reviewOfFiles(files), 'first', (text) => text.includes('value0 = { id: 0'));
      expect(wraps.sliced.length).toBeGreaterThan(0);

      // One file changes; the other 399 keep their content and signatures.
      resetRecords();
      const changed = fileOf('src/f000.ts', 300, 500_000);
      const next = reviewOfFiles([changed, ...files.slice(1)]);
      const frame = await controller.land(next, 'second', (text) => text.includes('value500000 = { id: 500000'));

      expect(frame).toContain('value500000 = { id: 500000');
      expect(wraps.sliced).toEqual([]);
      expect(wraps.lineCounts).toEqual([buildReviewSections(reviewOfFiles([changed]))[0]!.lines.length]);
    } finally {
      controller.unmount();
    }
  }, QUICK_TEST.timeoutMs);

  it('still wraps ahead a changed file that is large by itself', async () => {
    const files = Array.from({length: 400}, (_, index) => fileOf(`src/f${String(index).padStart(3, '0')}.ts`, 300, index * 300));
    const controller = await mountController(QUICK_TEST);
    try {
      await controller.land(reviewOfFiles(files), 'first', (text) => text.includes('value0 = { id: 0'));

      resetRecords();
      const changed = fileOf('src/f000.ts', 12_000, 500_000);
      const [changedSection] = buildReviewSections(reviewOfFiles([changed]));
      expect(changedSection!.lines.length).toBeGreaterThan(PREWRAP_MIN_LINES);
      const frame = await controller.land(reviewOfFiles([changed, ...files.slice(1)]), 'second', (text) => text.includes('value500000 = { id: 500000'));

      expect(frame).toContain('value500000 = { id: 500000');
      // Only the changed file was wrapped ahead, and the render wrapped nothing.
      expect(wraps.sliced).toEqual([{lineCount: changedSection!.lines.length, width: expect.any(Number)}]);
      expect(wraps.lineCounts).toEqual([]);
    } finally {
      controller.unmount();
    }
  }, QUICK_TEST.timeoutMs);

  it('wraps it again at a new width after it lands', async () => {
    const review = reviewOf('src/big.ts', WIDTH_TEST_ROWS);
    const [big] = buildReviewSections(review);
    expect(big!.lines.length).toBeGreaterThan(PREWRAP_MIN_LINES);
    const controller = await mountController(WIDTH_TEST);
    try {
      await controller.land(review, 'after', (text) => text.includes('value0 = { id: 0'));
      expect(wraps.sliced.length).toBeGreaterThan(0);
      resetRecords();
      controller.resize(NARROW_COLUMNS);
      // Past WRAP_SETTLE_MS. The settle timer is set before this one ends, and
      // the render it starts wraps synchronously inside it, so this does not
      // depend on how fast the machine wraps.
      await flush(300);

      // The render wrapped the big file itself, at the new width: the rows
      // wrapped ahead were for the old one.
      expect(wraps.lineCounts).toContain(big!.lines.length);
      const finalWidth = wraps.widths.at(-1)!;
      const expected = rowsAt(big!, finalWidth);
      expect(expected.length).toBeGreaterThan(PREFIX_LINES);
      const frame = controller.frame();
      for (const row of expected.slice(0, 5)) expect(frame).toContain(row);
    } finally {
      controller.unmount();
    }
  }, WIDTH_TEST.timeoutMs);

  it('wraps it again ahead when the width settles on a new value during the wrap', async () => {
    const rows = WIDTH_TEST_ROWS;
    const review = reviewOf('src/big.ts', rows);
    const [big] = buildReviewSections(review);
    expect(big!.lines.length).toBeGreaterThan(PREWRAP_MIN_LINES);
    const controller = await mountController(WIDTH_TEST);
    try {
      wraps.beforeSliced = async () => {
        controller.resize(NARROW_COLUMNS);
        await flush(300);
      };
      await controller.land(review, 'after', () => wraps.sliced.length >= 2);
      const widths = new Set(wraps.sliced.map((wrap) => wrap.width));
      expect(widths.size).toBe(2);
      const expected = rowsAt(big!, wraps.sliced.at(-1)!.width);
      await controller.until((text) => expected.slice(0, 5).every((row) => text.includes(row)));

      // The render never wrapped the big file: it found it wrapped ahead at
      // the width it settled on.
      expect(wraps.lineCounts.filter((count) => count > rows)).toEqual([]);
      const frame = controller.frame();
      expect(expected.length).toBeGreaterThan(PREFIX_LINES);
      for (const row of expected.slice(0, 5)) expect(frame).toContain(row);
    } finally {
      controller.unmount();
    }
  }, WIDTH_TEST.timeoutMs);
});
