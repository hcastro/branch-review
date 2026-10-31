import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import React from 'react';
import {render} from 'ink-testing-library';
import {afterEach, describe, expect, it} from 'vitest';
import {resolveRefs} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import type {RenderedService} from '../src/rendered/service.js';
import {runCli} from '../src/startup.js';
import {ReviewController} from '../src/ui/ReviewController.js';
import {cleanupTempDirs, initRepo, makeTempDir, writeFiles} from './core-helpers.js';

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
