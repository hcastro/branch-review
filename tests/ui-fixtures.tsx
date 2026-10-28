import React from 'react';
import {EventEmitter} from 'node:events';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {render as inkRender} from 'ink';
import {expect} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildDiffSections, type DiffSection} from '../src/sections.js';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import type {ClipboardWriter} from '../src/commands/execute.js';
import type {ReviewFile, ReviewModel} from '../src/review/model.js';

// Shared fixtures for the ui-* test files: a review model built from raw
// unified diffs plus delta-shaped rendered lines, and SGR mouse input.

export async function flush(times = 1) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function emitMouseMoveAt(column: number, row: number) {
  process.stdin.emit('data', `\u001B[<35;${column + 1};${row + 1}M`);
  await flush();
}

export async function emitMousePressAt(column: number, row: number) {
  process.stdin.emit('data', `\u001B[<0;${column + 1};${row + 1}M`);
  await flush();
}

export async function emitMouseDragAt(column: number, row: number, release = false) {
  process.stdin.emit('data', `\u001B[<32;${column + 1};${row + 1}${release ? 'm' : 'M'}`);
  await flush();
}

export async function emitWheelDownAt(column: number, row: number) {
  process.stdin.emit('data', `\u001B[<65;${column + 1};${row + 1}M`);
  await flush();
}

export function frameLines(frame: string | undefined) {
  return stripAnsi(frame ?? '').split('\n');
}

export function cellPosition(frame: string | undefined, needles: string[], text: string, offset = 0) {
  const lines = frameLines(frame);
  const row = lines.findIndex((line) => needles.every((needle) => line.includes(needle)));
  expect(row, `row containing ${JSON.stringify(needles)}`).toBeGreaterThanOrEqual(0);
  const index = lines[row]!.indexOf(text);
  expect(index, `text ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
  return {row, column: stringWidth(lines[row]!.slice(0, index)) + offset};
}

export function recordingWriter(writes: string[]): ClipboardWriter {
  return async (text) => {
    writes.push(text);
    return {ok: true, command: {command: '/usr/bin/pbcopy', args: [], displayName: 'pbcopy'}};
  };
}

export type FixtureFile = {path: string; rawDiff: string; rendered: string[]; error?: string};

export function buildFixture(files: FixtureFile[]): {sections: DiffSection[]; review: ReviewModel} {
  const reviewFiles = files.map((file): ReviewFile & {error?: string} => {
    const additions = file.rawDiff.split('\n').filter((line) => line.startsWith('+')).length;
    const deletions = file.rawDiff.split('\n').filter((line) => line.startsWith('-')).length;
    const metrics = {path: file.path, additions, deletions, changedLines: additions + deletions};
    return {
      path: file.path,
      status: 'modified' as const,
      metrics,
      rawDiff: file.rawDiff,
      renderedLines: file.rendered,
      blocks: parseUnifiedDiffBlocks(file.rawDiff, file.path),
      ...(file.error === undefined ? {} : {error: file.error}),
    };
  });
  const metrics = {
    filesChanged: reviewFiles.length,
    additions: reviewFiles.reduce((sum, file) => sum + file.metrics.additions, 0),
    deletions: reviewFiles.reduce((sum, file) => sum + file.metrics.deletions, 0),
    changedLines: reviewFiles.reduce((sum, file) => sum + file.metrics.changedLines, 0),
  };

  return {
    sections: buildDiffSections(reviewFiles.map((file) => ({
      path: file.path,
      metrics: file.metrics,
      diff: file.renderedLines.join('\n'),
    }))),
    review: {base: 'development', branch: 'HEAD', label: 'development...HEAD', metrics, files: reviewFiles},
  };
}

export type AppFixtureProps = {
  sections: DiffSection[];
  review?: ReviewModel;
  watchStatus?: string;
  readFileContent?: (file: ReviewFile) => string | null;
  resolveAbsolutePath?: (file: ReviewFile) => string | null;
};

export function appElement(
  fixture: AppFixtureProps,
  dimensions: {columns: number; rows: number} | undefined,
  copyWriter: ClipboardWriter,
) {
  return (
    <App
      base="development"
      branch="HEAD"
      sections={fixture.sections}
      branchMetrics={fixture.review?.metrics ?? {filesChanged: fixture.sections.length, additions: 0, deletions: 0, changedLines: 0}}
      review={fixture.review}
      copyWriter={copyWriter}
      readFileContent={fixture.readFileContent}
      resolveAbsolutePath={fixture.resolveAbsolutePath}
      watchStatus={fixture.watchStatus}
      dimensions={dimensions}
    />
  );
}

// Renders with `dimensions` on a fake terminal of the same size. Ink sizes its
// root to stdout's columns, so a stdout narrower or wider than `dimensions`
// would lay out a frame no real terminal shows.
export function renderFixture(
  fixture: AppFixtureProps,
  dimensions: {columns: number; rows: number},
  writes: string[] = [],
  copyWriter: ClipboardWriter = recordingWriter(writes),
) {
  return renderSized(appElement(fixture, dimensions, copyWriter), dimensions);
}

class FrameStream extends EventEmitter {
  frames: string[] = [];
  constructor(public columns: number, public rows: number) {
    super();
  }

  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };

  lastFrame = () => this.frames.at(-1);
}

// ink-testing-library's stdin: keys reach Ink through read() after a
// 'readable' event, and listeners on 'data' see them too.
class KeyStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };

  read = () => {
    const {data} = this;
    this.data = null;
    return data;
  };

  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

// ink-testing-library's render, with stdout sized to `size` (by default the
// element's `dimensions` prop) instead of its fixed 100 columns. Every render
// writes the whole frame (debug mode).
export function renderSized(
  tree: React.ReactElement<{dimensions?: {columns: number; rows: number}}>,
  size = tree.props.dimensions ?? {columns: 100, rows: 40},
) {
  const stdout = new FrameStream(size.columns, size.rows);
  const stderr = new FrameStream(size.columns, size.rows);
  const stdin = new KeyStdin();
  const instance = inkRender(tree, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: stdout as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stderr: stderr as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdin: stdin as any,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    rerender: instance.rerender,
    unmount: instance.unmount,
    cleanup: instance.cleanup,
    waitUntilExit: instance.waitUntilExit,
    stdout,
    stderr,
    stdin,
    frames: stdout.frames,
    lastFrame: stdout.lastFrame,
  };
}

export function gutter(line: number) {
  const label = String(line).padStart(3);
  return ` ${label} ⋮ ${label} │`;
}

// A file with one hunk per entry of `hunks` (its new start line), each adding
// `size` lines, and delta-shaped rendered lines for it. Added lines are named
// by hunk ordinal, so moving a hunk's start leaves its content unchanged.
export function multiBlockFile(path: string, hunks: number[], size: number, prefix = path): FixtureFile {
  const raw: string[] = [];
  const rendered: string[] = [];
  for (const [ordinal, start] of hunks.entries()) {
    raw.push(`@@ -${start},0 +${start},${size} @@`);
    rendered.push(`• ${path}:${start}: `);
    for (let index = 0; index < size; index += 1) {
      raw.push(`+${prefix}-h${ordinal}-${index}`);
      rendered.push(`${gutter(start + index)}${prefix}-h${ordinal}-${index}`);
    }
  }

  return {path, rawDiff: raw.join('\n'), rendered};
}

type FakeTerminal = {
  stdout: EventEmitter & {columns: number; rows: number; isTTY: boolean; write: (chunk: string) => boolean};
  lastFrame: () => string;
  writes: string[];
};

function fakeStdout(columns: number, rows: number): FakeTerminal {
  const chunks: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: true,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  });

  // Ink also writes bare escape sequences (cursor, mouse modes); the frame is
  // the last write with visible text.
  const lastFrame = () => [...chunks].reverse().find((chunk) => stripAnsi(chunk).trim() !== '') ?? '';
  return {stdout, lastFrame, writes: chunks};
}

// A readable stdin: Ink reads keys with read() after a 'readable' event, the
// way it reads a real terminal.
function fakeStdin() {
  let pending: string | null = null;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => undefined,
    setEncoding: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    read: () => {
      const chunk = pending;
      pending = null;
      return chunk;
    },
    write: (data: string) => {
      pending = data;
      stdin.emit('readable');
    },
  });
  return stdin;
}

// Renders on a fake terminal whose size the App reads from stdout itself, the
// way it runs in a real terminal, so size changes arrive as 'resize' events.
export function renderOnTerminal(fixture: AppFixtureProps, columns: number, rows: number, writes: string[] = []) {
  const terminal = fakeStdout(columns, rows);
  const stdin = fakeStdin();
  const instance = inkRender(appElement(fixture, undefined, recordingWriter(writes)), {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: terminal.stdout as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdin: stdin as any,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    ...instance,
    stdout: terminal.stdout,
    stdin,
    lastFrame: terminal.lastFrame,
    resize(nextColumns: number, nextRows: number) {
      terminal.stdout.columns = nextColumns;
      terminal.stdout.rows = nextRows;
      terminal.stdout.emit('resize');
    },
  };
}

// The frame as the terminal shows it: rows past the screen height scroll the
// top rows away, and a frame as tall as the screen makes Ink clear it first.
export function frameFits(frame: string, columns: number, rows: number) {
  const lines = frameLines(frame);
  return {
    height: lines.length,
    maxWidth: Math.max(...lines.map((line) => stringWidth(line))),
    fits: lines.length <= rows - 1 && lines.every((line) => stringWidth(line) <= columns),
  };
}
