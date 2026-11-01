import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import stripAnsi from 'strip-ansi';
import {render} from 'ink-testing-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {DiffRange} from '../src/git.js';
import type {ReviewModel} from '../src/review/model.js';
import type {CreateRepoWatcherOptions} from '../src/watch/repoWatcher.js';
import {PREWRAP_MIN_LINES, ReviewController} from '../src/ui/ReviewController.js';

// Records the sections each render-time wrap is given, by their line count.
const wraps = vi.hoisted(() => ({lineCounts: [] as number[]}));
vi.mock('../src/sections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sections.js')>();
  return {
    ...actual,
    wrapSections: (...args: Parameters<typeof actual.wrapSections>) => {
      wraps.lineCounts.push(...args[0].map((section) => section.lines.length));
      return actual.wrapSections(...args);
    },
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

function createRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-prewrap-'));
  tempDirs.push(cwd);
  execFileSync('git', ['init', '-q', '-b', 'development'], {cwd, stdio: 'ignore'});
  return cwd;
}

// A delta row as delta draws it: line numbers, the gutter and 24-bit color
// around each token.
function deltaRow(index: number) {
  return `\x1B[34m\x1B[38;5;88m      \x1B[34m⋮\x1B[38;5;28m ${String(index + 1).padStart(6)}  \x1B[34m│\x1B[48;2;0;56;0;38;2;249;38;114mexport\x1B[38;2;248;248;242m \x1B[38;2;102;217;239mconst\x1B[38;2;248;248;242m \x1B[38;2;255;255;255mvalue${index}\x1B[38;2;248;248;242m = { id: \x1B[38;2;190;132;255m${index}\x1B[38;2;248;248;242m, name: \x1B[38;2;230;219;116m"item ${index}"\x1B[38;2;248;248;242m };\x1B[0m\x1B[48;2;0;56;0m\x1B[0K\x1B[0m`;
}

function reviewOf(filePath: string, rows: number): ReviewModel {
  return {
    base: 'development',
    branch: 'HEAD + worktree',
    label: 'development...HEAD + worktree',
    metrics: {filesChanged: 1, additions: rows, deletions: 0, changedLines: rows},
    files: [{
      path: filePath,
      status: 'added',
      metrics: {path: filePath, additions: rows, deletions: 0, changedLines: rows},
      rawDiff: '',
      renderedLines: Array.from({length: rows}, (_, index) => deltaRow(index)),
      blocks: [],
    }],
  };
}

const emptyReview: ReviewModel = {
  base: 'development',
  branch: 'HEAD + worktree',
  label: 'development...HEAD + worktree',
  metrics: {filesChanged: 0, additions: 0, deletions: 0, changedLines: 0},
  files: [],
};

async function flush(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mounts the controller with a refresh that answers `review`, lands it, and
 * reports the longest the event loop went without turning from the moment the
 * refresh answered until the review is on screen.
 */
async function landRefresh(review: ReviewModel, firstRow: string) {
  const cwd = createRepo();
  const range: DiffRange = {base: 'development', branch: 'HEAD', diffArg: 'development', includeWorktree: true};
  let watcher: CreateRepoWatcherOptions | null = null;
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
        return {range, fingerprint: 'after', branchName: 'feature/prewrap', review};
      }}
      createWatcher={(options) => {
        watcher = options;
        return {close: async () => undefined};
      }}
    />,
  );
  // Let the pane's wrap width settle before the refresh lands.
  await flush(300);
  wraps.lineCounts = [];

  let last = performance.now();
  let longestStall = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    if (answeredAt) longestStall = Math.max(longestStall, now - Math.max(last, answeredAt));
    last = now;
  }, 1);
  let frame = '';
  try {
    watcher!.onChange();
    const deadline = Date.now() + 20_000;
    while (!frame.includes(firstRow) && Date.now() < deadline) {
      await flush(5);
      frame = stripAnsi(instance.lastFrame() ?? '');
    }
  } finally {
    clearInterval(ticker);
    instance.unmount();
  }

  return {frame, longestStall};
}

describe('a refresh that lands a large review', () => {
  it('wraps it ahead in slices, so its render does not wrap it and the event loop keeps turning', async () => {
    const rows = 120_000;
    expect(rows).toBeGreaterThan(PREWRAP_MIN_LINES);
    const {frame, longestStall} = await landRefresh(reviewOf('src/big.ts', rows), 'value0 = { id: 0');

    expect(frame).toContain('big.ts');
    expect(frame).toContain('value0 = { id: 0');
    // The render took the rows wrapped ahead instead of wrapping them itself.
    expect(wraps.lineCounts.filter((count) => count > rows)).toEqual([]);
    // Wrapped in the render, these rows held the loop for over a second.
    expect(longestStall).toBeLessThan(500);
  }, 60_000);

  it('wraps a review under the limit in its render, as before', async () => {
    const rows = 50;
    const {frame} = await landRefresh(reviewOf('src/small.ts', rows), 'value0 = { id: 0');

    expect(frame).toContain('value0 = { id: 0');
    expect(wraps.lineCounts).toContain(rows + 1);
  }, 60_000);
});
