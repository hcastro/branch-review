import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import React from 'react';
import {render} from 'ink-testing-library';
import {afterEach, describe, expect, it} from 'vitest';
import {resolveRefs} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import type {RenderedService} from '../src/rendered/service.js';
import {runCli} from '../src/startup.js';
import {ReviewController} from '../src/ui/ReviewController.js';
import {cleanupTempDirs, initRepo, makeTempDir, writeExecutable, writeFiles} from './core-helpers.js';

// The rendered view starts with the UI whatever the terminal can draw: it
// needs no graphics, only the session dir, and the exit hooks take its
// worker and its pages away with the rest of the session.

afterEach(cleanupTempDirs);

class FakeProcess extends EventEmitter {
  exitCode: number | undefined;
  exits: number[] = [];
  exit = (code?: number) => {
    this.exits.push(code ?? 0);
    this.emit('exit', code ?? 0);
  };
}

type Element = React.ReactElement<Record<string, unknown>>;
function findProps(tree: unknown, type: unknown): Record<string, unknown> | null {
  if (!tree || typeof tree !== 'object') return null;
  const element = tree as Element;
  if (element.type === type) return element.props;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findProps(child, type);
    if (found) return found;
  }
  return null;
}

describe('the rendered view at startup', () => {
  it('starts without graphics, writes pages in the session dir, and leaves nothing behind at exit', async () => {
    const cwd = initRepo({'README.md': '# Readme\n\nOne.\n'});
    writeFiles(cwd, {'README.md': '# Readme\n\nOne, edited.\n'});
    const parent = makeTempDir('branch-review-session-parent-');
    const proc = new FakeProcess();
    let tree: unknown;
    let markRendered!: () => void;
    const mounted = new Promise<void>((resolve) => {
      markRendered = resolve;
    });

    void runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: {...process.env, BRANCH_REVIEW_TMPDIR: parent},
      stdout: {isTTY: true, columns: 120, write: () => true},
      stderr: {write: () => true},
      render: (element) => {
        tree = element;
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => undefined};
      },
    });
    await mounted;

    // No stdin: no graphics, so no media service, and still a rendered one.
    const props = findProps(tree, ReviewController)!;
    expect(props.media).toBeUndefined();
    const rendered = props.rendered as RenderedService;
    rendered.setReview(props.initialReview as Parameters<RenderedService['setReview']>[0], {cwd, range: props.range as Parameters<RenderedService['setReview']>[1]['range']});
    const outcome = await rendered.page('README.md');
    expect(outcome).toMatchObject({ok: true});
    const file = new URL((outcome as {url: string}).url).pathname;
    expect(file.startsWith(fs.realpathSync(parent))).toBe(true);
    const html = fs.readFileSync(file, 'utf8');
    expect(html).toContain('One, edited.');
    // The repo shows by its folder's name only, and no stack trace or absolute path reaches a page.
    expect(html).not.toContain(cwd);
    expect(html).not.toContain('    at ');
    expect(fs.readdirSync(parent).filter((name) => name.startsWith('branch-review-media-'))).toHaveLength(1);

    // The exit hook ends the rendered worker, which the page above started.
    const dispose = rendered.dispose;
    let disposed = 0;
    rendered.dispose = () => {
      disposed += 1;
      dispose();
    };
    proc.emit('exit', 0);
    expect(disposed).toBe(1);
    expect(fs.readdirSync(parent)).toEqual([]);
  }, 60_000);
});

describe('the rendered view\'s trip at startup', () => {
  it('opens pages in cmux found on PATH, and plays no crossing under --no-animations', async () => {
    const cwd = initRepo({'README.md': '# Readme\n\nOne.\n'});
    writeFiles(cwd, {'README.md': '# Readme\n\nOne, edited.\n'});
    const parent = makeTempDir('branch-review-session-parent-');
    // A fake cmux ahead of anything real on PATH, which logs its arguments
    // and answers the way cmux does when it opens a split.
    const bin = makeTempDir('branch-review-fake-cmux-');
    const log = path.join(bin, 'calls.log');
    writeExecutable(path.join(bin, 'cmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho '{"created_split":true,"surface_ref":"surface:2"}'\n`);
    const proc = new FakeProcess();
    let tree: unknown;
    let markRendered!: () => void;
    const mounted = new Promise<void>((resolve) => {
      markRendered = resolve;
    });
    // Should cmux fail, the browser fallback is recorded, never run.
    const opened: Array<[string, string[]]> = [];

    void runCli({
      argv: ['HEAD', 'main', '--no-watch', '--no-animations'],
      cwd,
      proc,
      env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, CMUX_WORKSPACE_ID: 'workspace:test', SSH_CONNECTION: undefined, BRANCH_REVIEW_MOTION: undefined, BRANCH_REVIEW_TMPDIR: parent},
      opener: (command, args) => opened.push([command, args]),
      stdout: {isTTY: true, columns: 120, write: () => true},
      stderr: {write: () => true},
      render: (element) => {
        tree = element;
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => undefined};
      },
    });
    await mounted;

    const props = findProps(tree, ReviewController)!;
    const rendered = props.rendered as RenderedService;
    rendered.setReview(props.initialReview as Parameters<RenderedService['setReview']>[0], {cwd, range: props.range as Parameters<RenderedService['setReview']>[1]['range']});
    const crossings: string[] = [];
    const outcome = await rendered.open({fileKey: 'README.md'}, {cross: async (motion) => {
      crossings.push(motion);
    }, waiting: () => undefined});
    expect(outcome).toEqual({kind: 'info', message: '⇗ README.md opened in the browser split'});
    expect(crossings).toEqual(['off']);
    const [call] = fs.readFileSync(log, 'utf8').trim().split('\n');
    // With --no-animations the page arrives final: m=0.
    expect(call).toMatch(/^--json browser open-split file:\/\/\S+\/rendered\/[0-9a-f]{20}\.html#d=full&m=0&n=1 --workspace workspace:test --focus false$/);
    expect(call!.startsWith(`--json browser open-split ${new URL(`file://${fs.realpathSync(parent)}`).href}`)).toBe(true);
    expect(opened).toEqual([]);
    proc.emit('exit', 0);
  }, 60_000);

  it('hands the browser fallback to the opener it was given when cmux is too slow', async () => {
    const cwd = initRepo({'README.md': '# Readme\n\nOne.\n'});
    writeFiles(cwd, {'README.md': '# Readme\n\nOne, edited.\n'});
    const parent = makeTempDir('branch-review-session-parent-');
    // A fake cmux that never answers in time, so the surface gives up on it.
    const bin = makeTempDir('branch-review-fake-cmux-');
    writeExecutable(path.join(bin, 'cmux'), '#!/bin/sh\nexec /bin/sleep 5\n');
    const proc = new FakeProcess();
    let tree: unknown;
    let markRendered!: () => void;
    const mounted = new Promise<void>((resolve) => {
      markRendered = resolve;
    });
    const opened: Array<[string, string[]]> = [];

    void runCli({
      argv: ['HEAD', 'main', '--no-watch', '--no-animations'],
      cwd,
      proc,
      env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, CMUX_WORKSPACE_ID: 'workspace:test', SSH_CONNECTION: undefined, BRANCH_REVIEW_MOTION: undefined, BRANCH_REVIEW_TMPDIR: parent},
      opener: (command, args) => opened.push([command, args]),
      stdout: {isTTY: true, columns: 120, write: () => true},
      stderr: {write: () => true},
      render: (element) => {
        tree = element;
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => undefined};
      },
    });
    await mounted;

    const props = findProps(tree, ReviewController)!;
    const rendered = props.rendered as RenderedService;
    rendered.setReview(props.initialReview as Parameters<RenderedService['setReview']>[0], {cwd, range: props.range as Parameters<RenderedService['setReview']>[1]['range']});
    const outcome = await rendered.open({fileKey: 'README.md'}, {cross: async () => undefined, waiting: () => undefined});
    const page = /^file:\/\/\S+\/rendered\/[0-9a-f]{20}\.html#d=full&m=0&n=1$/;
    if (process.platform === 'darwin') {
      expect(outcome).toEqual({kind: 'info', message: "⇗ README.md opened in your browser · cmux didn't answer"});
      expect(opened).toEqual([['/usr/bin/open', [expect.stringMatching(page)]]]);
    } else {
      // Elsewhere the fallback is xdg-open from PATH, when there is one.
      expect(opened.length).toBe(outcome?.message.includes('opened in your browser') ? 1 : 0);
    }
    proc.emit('exit', 0);
  }, 60_000);
});

describe('the review controller', () => {
  it('hands each review to the rendered view', async () => {
    const cwd = initRepo({'README.md': '# Readme\n'});
    writeFiles(cwd, {'README.md': '# Readme, edited\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const review = buildReviewModel({cwd, range, width: 100} as Parameters<typeof buildReviewModel>[0]);
    const calls: Array<{review: unknown; cwd: string; base: string}> = [];
    const rendered = {
      setReview: (next: unknown, ctx: {cwd: string; range: {base: string}}) => calls.push({review: next, cwd: ctx.cwd, base: ctx.range.base}),
      focus: () => undefined,
    } as unknown as RenderedService;
    const instance = render(<ReviewController cwd={cwd} range={range} initialReview={review} watch={false} rendered={rendered} dimensions={{columns: 120, rows: 30}} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([{review, cwd, base: 'main'}]);
    instance.unmount();
  });
});

describe('the terminal\'s colors', () => {
  it('reach the page a trip opens, from the terminal\'s answer at startup', async () => {
    const cwd = initRepo({'README.md': '# Readme\n\nOne.\n'});
    writeFiles(cwd, {'README.md': '# Readme\n\nOne, edited.\n'});
    const parent = makeTempDir('branch-review-session-parent-');
    const proc = new FakeProcess();
    // A terminal that draws no graphics and answers its colors, then DA1.
    const stdin = Object.assign(new EventEmitter(), {isTTY: true, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, unshift: () => undefined});
    const stdout = {isTTY: true, columns: 120, rows: 40, write: (text: string) => {
      if (text.includes('\x1B]11;?')) setImmediate(() => stdin.emit('data', Buffer.from('\x1B]10;rgb:d0d0/d4d4/d8d8\x1B\\\x1B]11;rgb:1e1e/2020/2626\x1B\\\x1B[?62c', 'latin1')));
      return true;
    }};
    let tree: unknown;
    let markRendered!: () => void;
    const mounted = new Promise<void>((resolve) => {
      markRendered = resolve;
    });
    const opened: Array<[string, string[]]> = [];
    void runCli({
      argv: ['HEAD', 'main', '--no-watch'],
      cwd,
      proc,
      env: {
        ...process.env, TERM: 'xterm', TERM_PROGRAM: undefined, COLORTERM: undefined, GHOSTTY_RESOURCES_DIR: undefined, KITTY_WINDOW_ID: undefined,
        NO_COLOR: undefined, FORCE_COLOR: undefined, TMUX: undefined, SSH_CONNECTION: undefined, CMUX_WORKSPACE_ID: undefined,
        BRANCH_REVIEW_IMAGES: undefined, BRANCH_REVIEW_MOTION: 'off', BRANCH_REVIEW_TMPDIR: parent,
      },
      opener: (command, args) => opened.push([command, args]),
      stdin: stdin as never,
      stdout: stdout as never,
      stderr: {write: () => true},
      render: (element) => {
        tree = element;
        markRendered();
        return {waitUntilExit: () => new Promise(() => {}), unmount: () => undefined};
      },
    });
    await mounted;

    const props = findProps(tree, ReviewController)!;
    expect(props.graphics).toMatchObject({protocol: 'none', fg: '#d0d4d8', bg: '#1e2026', scheme: 'dark'});
    const rendered = props.rendered as RenderedService;
    rendered.setReview(props.initialReview as Parameters<RenderedService['setReview']>[0], {cwd, range: props.range as Parameters<RenderedService['setReview']>[1]['range']});
    await rendered.open({fileKey: 'README.md'}, {cross: async () => undefined, waiting: () => undefined});
    if (process.platform === 'darwin') {
      expect(opened).toHaveLength(1);
      expect(new URL(opened[0]![1][0]!).hash).toBe('#d=full&m=1&bg=1e2026&fg=d0d4d8&n=1');
    }
    proc.emit('exit', 0);
  }, 60_000);
});

