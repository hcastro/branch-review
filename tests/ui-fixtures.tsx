import React from 'react';
import {EventEmitter} from 'node:events';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {render as inkRender} from 'ink';
import {expect} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildDiffSections, type DiffSection} from '../src/sections.js';
import type {GraphicsCaps} from '../src/media/types.js';
import type {MediaRowsHook} from '../src/ui/App.js';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import type {ClipboardWriter} from '../src/commands/execute.js';
import type {ReviewFile, ReviewModel} from '../src/review/model.js';
import type {FileStatus} from '../src/git.js';
import {createMediaService, type MediaService} from '../src/media/service.js';
import type {ExportRequest, ExportResult, InspectRequest, InspectResult, MediaBackend, RenderRequest, RenderResult} from '../src/media/backend.js';
import type {SideInfo} from '../src/media/types.js';
import {KITTY_CAPS, pngFixture} from './media-helpers.js';

export {BLOCKS_CAPS, decodePlaceholders, KITTY_CAPS, parseApc, pngFixture, sgrCodeNames, sideInfo} from './media-helpers.js';

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

export type FixtureFile = {path: string; rawDiff: string; rendered: string[]; error?: string; status?: FileStatus};

export function buildFixture(files: FixtureFile[]): {sections: DiffSection[]; review: ReviewModel} {
  const reviewFiles = files.map((file): ReviewFile & {error?: string} => {
    const additions = file.rawDiff.split('\n').filter((line) => line.startsWith('+')).length;
    const deletions = file.rawDiff.split('\n').filter((line) => line.startsWith('-')).length;
    const metrics = {path: file.path, additions, deletions, changedLines: additions + deletions};
    return {
      path: file.path,
      status: file.status ?? 'modified',
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
  graphics?: GraphicsCaps;
  addMediaRows?: MediaRowsHook;
  media?: MediaService;
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
      {...(fixture.graphics ? {graphics: fixture.graphics} : {})}
      {...(fixture.addMediaRows ? {addMediaRows: fixture.addMediaRows} : {})}
      {...(fixture.media ? {media: fixture.media} : {})}
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

// Media files the way git and the build print them: a binary patch with an
// `index` line, drawn as today's one placeholder line.
export function binaryMediaFile(path: string, status: FileStatus = 'modified', ids = ['029ace0', '97fa3ee']): FixtureFile {
  const [before, after] = status === 'added' || status === 'untracked' ? ['0000000', ids[1]!] : status === 'deleted' ? [ids[0]!, '0000000'] : ids;
  const header = status === 'added' || status === 'untracked' ? ['new file mode 100644'] : status === 'deleted' ? ['deleted file mode 100644'] : [];
  return {
    path,
    status,
    rawDiff: [`diff --git a/${path} b/${path}`, ...header, `index ${before}..${after}${header.length ? '' : ' 100644'}`, `Binary files a/${path} and b/${path} differ`, ''].join('\n'),
    rendered: ['binary file changed'],
  };
}

export function svgSourceFile(path: string): FixtureFile {
  return {
    path,
    rawDiff: [`diff --git a/${path} b/${path}`, 'index b284849..35ecfd6 100644', `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1,2 @@', '-<svg/>', '+<svg>', '+</svg>', ''].join('\n'),
    rendered: [`• ${path}:1: `, `   1 ⋮     │<svg/>`, `${gutter(1)}<svg>`, `${gutter(2)}</svg>`],
  };
}

// An SVG the way git and delta print it: an `index` line and text hunks,
// one per entry of `hunks` (its new start line), each adding `size` lines
// named by hunk ordinal and `tag`, so a new tag is new content. With
// `binary`, the `*.svg binary` attribute case: a binary patch and no hunks.
export function svgMediaFile(path: string, {status = 'added', ids = ['0000000', '35ecfd6'], hunks = [1], size = 6, tag = '', binary = false}: {
  status?: FileStatus;
  ids?: [string, string] | string[];
  hunks?: number[];
  size?: number;
  tag?: string;
  binary?: boolean;
} = {}): FixtureFile {
  const added = status === 'added' || status === 'untracked';
  const raw = [`diff --git a/${path} b/${path}`, ...(added ? ['new file mode 100644'] : []), `index ${ids[0]}..${ids[1]}${added ? '' : ' 100644'}`];
  if (binary) {
    raw.push(`Binary files ${added ? '/dev/null' : `a/${path}`} and b/${path} differ`, '');
    return {path, status, rawDiff: raw.join('\n'), rendered: ['binary file changed']};
  }
  raw.push(`--- ${added ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`);
  const rendered: string[] = [];
  for (const [ordinal, start] of hunks.entries()) {
    raw.push(`@@ -${added ? '0,0' : `${start},0`} +${start},${size} @@`);
    rendered.push(`• ${path}:${start}: `);
    for (let index = 0; index < size; index += 1) {
      const line = `<g id="${tag}h${ordinal}-${index}"/>`;
      raw.push(`+${line}`);
      rendered.push(`${gutter(start + index)}${line}`);
    }
  }
  raw.push('');
  return {path, status, rawDiff: raw.join('\n'), rendered};
}

export type FakeBackendCall =
  | {type: 'inspect'; request: InspectRequest}
  | {type: 'render'; request: RenderRequest}
  | {type: 'exportCopy'; request: ExportRequest};

type FakeSide = SideInfo | {error: string; state?: 'stale' | 'error'};

/**
 * An in-process media backend: canned side facts by object id, and a PNG of
 * the box's canvas size for every render. Every call is recorded. `exportCopy`
 * answers the export job instead of the canned path (the worker's own job, say).
 */
export function fakeMediaBackend({sides = {}, render, exportDir, exportCopy}: {
  sides?: Record<string, FakeSide>;
  render?: (request: RenderRequest) => RenderResult | Promise<RenderResult>;
  exportDir?: string;
  exportCopy?: (request: ExportRequest) => Promise<ExportResult>;
} = {}) {
  const calls: FakeBackendCall[] = [];
  let disposed = 0;
  const backend: MediaBackend = {
    async inspect(request) {
      calls.push({type: 'inspect', request});
      const side = sides[request.side.abbrevId];
      if (!side) return {ok: false, state: 'error', reason: `no fake side ${request.side.abbrevId}`};
      if ('error' in side) return {ok: false, state: side.state ?? 'error', reason: side.error} as InspectResult;
      return {ok: true, info: side};
    },
    async render(request) {
      calls.push({type: 'render', request});
      if (render) return render(request);
      const {cols, rows, cellPx} = request.target;
      if (request.op === 'blocks' || request.op === 'blocksDifference') {
        // Every cell blue over red: the top pixel then the bottom one.
        const cells = new Uint32Array(cols * rows * 2);
        for (let at = 0; at < cells.length; at += 2) cells.set([0x1e78c8, 0xc82828], at);
        return {ok: true, cells, cols, rows};
      }
      return {ok: true, png: pngFixture(cols * cellPx.w, rows * cellPx.h, [30, 120, 200, 255])};
    },
    async exportCopy(request) {
      calls.push({type: 'exportCopy', request});
      if (exportCopy) return exportCopy(request);
      return {ok: true, path: `${exportDir ?? request.dir}/open-1/${request.side.side}.png`};
    },
    dispose() {
      disposed += 1;
    },
  };
  return {backend, calls, disposedCount: () => disposed};
}

/**
 * A real media service over the fake backend, with a recording graphics sink
 * (kept apart from the frames, so a frame is never an escape) and a
 * recording opener.
 */
export function fakeMediaService({caps = KITTY_CAPS, sides, render, exportCopy, tempDir = '/tmp/branch-review-media-test', env = {}, review, includeWorktree = false, watching, registry}: {
  caps?: GraphicsCaps;
  sides?: Record<string, FakeSide>;
  render?: (request: RenderRequest) => RenderResult | Promise<RenderResult>;
  exportCopy?: (request: ExportRequest) => Promise<ExportResult>;
  tempDir?: string;
  env?: NodeJS.ProcessEnv;
  review?: ReviewModel;
  includeWorktree?: boolean;
  watching?: boolean;
  registry?: Parameters<typeof createMediaService>[0]['registry'];
} = {}) {
  const fake = fakeMediaBackend({sides, render, ...(exportCopy ? {exportCopy} : {})});
  const graphicsWrites: string[] = [];
  const opened: Array<{command: string; args: string[]}> = [];
  const service = createMediaService({
    caps,
    backend: fake.backend,
    sink: {write: (sequence) => graphicsWrites.push(sequence)},
    tempDir: () => tempDir,
    opener: (command, args) => opened.push({command, args}),
    env,
    platform: 'darwin',
    ...(watching === undefined ? {} : {watching}),
    ...(registry ? {registry} : {}),
  });
  if (review) service.setReview(review, {cwd: '/repo', range: {includeWorktree}});
  return {service, graphicsWrites, opened, calls: fake.calls, disposedCount: fake.disposedCount};
}
