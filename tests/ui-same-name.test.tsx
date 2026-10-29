import path from 'node:path';
import {execFileSync} from 'node:child_process';
import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildReviewModel, buildReviewSections} from '../src/review/build.js';
import {NAME_NOT_UTF8, getReviewFileContents, resolveRefs} from '../src/git.js';
import {cleanupTempDirs, git, initRepo} from './core-helpers.js';
import {
  buildFixture,
  cellPosition,
  emitMousePressAt,
  flush,
  frameLines,
  gutter,
  recordingWriter,
  renderFixture,
  renderSized,
} from './ui-fixtures.js';

// A file whose name is not UTF-8 is shown by an escaped stand-in. A second,
// real file can have that stand-in as its name. The two must stay two rows,
// each opening and copying as its own file. Built from a real repo with real
// git and delta.

vi.setConfig({testTimeout: 120_000});
afterEach(cleanupTempDirs);

function gitWithInput(cwd: string, args: string[], input: Buffer | string) {
  return execFileSync('git', args, {cwd, input, encoding: 'utf8'}).trim();
}

// Commits files whose names are raw bytes on top of HEAD as branch `name`,
// with plumbing, so it works on filesystems that reject such names.
function commitRawNames(cwd: string, name: string, files: Array<{name: Buffer; contents: string}>) {
  const tree = execFileSync('git', ['ls-tree', '-z', 'HEAD'], {cwd});
  const entries = files.map(({name: fileName, contents}) => {
    const blob = gitWithInput(cwd, ['hash-object', '-w', '--stdin'], contents);
    return Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), fileName, Buffer.from([0])]);
  });
  const newTree = gitWithInput(cwd, ['mktree', '-z'], Buffer.concat([tree, ...entries]));
  const commit = gitWithInput(cwd, ['commit-tree', newTree, '-p', 'HEAD', '-m', 'raw names'], '');
  git(cwd, 'update-ref', `refs/heads/${name}`, commit);
}

// `caf` + byte 0xE9 + `.txt`: Latin-1 for café, shown as `caf\351.txt`.
const latin1Cafe = Buffer.from([...Buffer.from('caf'), 0xE9, ...Buffer.from('.txt')]);
// A real UTF-8 name holding a backslash and the digits 351.
const literalCafe = 'caf\\351.txt';

const TREE_SPLIT = '││';
const treePart = (line: string) => line.split(TREE_SPLIT)[0] ?? '';
const diffPart = (line: string) => line.split(TREE_SPLIT).slice(1).join(TREE_SPLIT);
const footer = (frame: string | undefined) => frameLines(frame).at(-2) ?? '';

type Rendered = ReturnType<typeof renderSized>;

async function press(instance: Rendered, input: string) {
  instance.stdin.write(input);
  await flush(5);
}

// The screen cell of every tree row that shows `literalCafe`.
function cafeRows(instance: Rendered) {
  return frameLines(instance.lastFrame()).flatMap((line, row) => (
    treePart(line).includes(`• ${literalCafe}`) ? [{row, column: treePart(line).indexOf(literalCafe)}] : []
  ));
}

const BLOCK_BUTTONS = ['Copy code', 'Copy diff', 'Copy block'];

// Each block copy, by key and then by the focused header's buttons, run on
// the file at the top of the pane. Returns, per copy, what it wrote and the
// footer it left.
async function runBlockCopies(instance: Rendered, writes: string[], {buttons}: {buttons: boolean}) {
  // Button cells are read once: a copied button changes its label.
  const frame = instance.lastFrame();
  const cells = buttons ? BLOCK_BUTTONS.map((label) => cellPosition(frame, BLOCK_BUTTONS, label)) : [];
  const results: Array<{copy: string; wrote: string[]; footer: string}> = [];
  const record = async (copy: string, act: () => Promise<void>) => {
    const before = writes.length;
    await act();
    results.push({copy, wrote: writes.slice(before), footer: footer(instance.lastFrame())});
  };
  for (const key of ['c', 'p', 'b']) await record(key, () => press(instance, key));
  for (const [index, cell] of cells.entries()) {
    await record(BLOCK_BUTTONS[index]!, async () => {
      await emitMousePressAt(cell.column, cell.row);
      await flush(5);
    });
  }
  return results;
}

// The valid file's block copies each copy that file's own block: its code,
// its diff, and its agent prompt.
function expectOwnBlock(results: Awaited<ReturnType<typeof runBlockCopies>>) {
  for (const {copy, wrote, footer: shown} of results) {
    expect(wrote, copy).toHaveLength(1);
    expect(shown, copy).toContain('✓ Copied');
    const kind = copy === 'c' || copy === 'Copy code' ? 'code' : copy === 'p' || copy === 'Copy diff' ? 'diff' : 'prompt';
    if (kind === 'code') expect(wrote[0], copy).toBe('one\ntwo\nthree');
    if (kind === 'diff') expect(wrote[0], copy).toContain('+one\n+two\n+three');
    if (kind === 'prompt') {
      expect(wrote[0], copy).toContain(`File: ${literalCafe}`);
      expect(wrote[0], copy).toContain('+three');
    }
  }
}

function expectRefused(results: Awaited<ReturnType<typeof runBlockCopies>>) {
  for (const {copy, wrote, footer: shown} of results) {
    expect(wrote, copy).toEqual([]);
    expect(shown, copy).toContain(`✗ Copy action unavailable. · ${NAME_NOT_UTF8}`);
  }
}

describe('a name that is not UTF-8 next to a real file shown with the same text', () => {
  it('keeps two tree rows, each showing its own diff and copying as its own file', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    commitRawNames(cwd, 'feat', [
      {name: latin1Cafe, contents: 'one\n'},
      {name: Buffer.from(literalCafe), contents: 'one\ntwo\nthree\n'},
    ]);
    const range = resolveRefs(cwd, 'feat', 'main');
    const review = await buildReviewModel({cwd, range, width: 100});
    expect(review.files.map((file) => [file.path, file.pathError])).toEqual(expect.arrayContaining([
      [literalCafe, NAME_NOT_UTF8],
      [literalCafe, undefined],
    ]));

    const writes: string[] = [];
    const dimensions = {columns: 140, rows: 30};
    const instance = renderSized(
      <App
        base={range.base}
        branch={review.branch}
        sections={buildReviewSections(review)}
        branchMetrics={review.metrics}
        review={review}
        copyWriter={recordingWriter(writes)}
        readFileContent={(file) => getReviewFileContents(cwd, range, file)}
        resolveAbsolutePath={(file) => path.resolve(cwd, file.path)}
        repoRoot={cwd}
        dimensions={dimensions}
      />,
      dimensions,
    );
    await flush(5);

    const rowsOnScreen = cafeRows(instance);
    expect(rowsOnScreen).toHaveLength(2);

    const seen: string[] = [];
    for (const {row, column} of rowsOnScreen) {
      await emitMousePressAt(column, row);
      await flush(5);
      // A click puts the file's diff at the top of the pane; the other
      // file's diff may still show below it.
      const diff = frameLines(instance.lastFrame()).map(diffPart);
      const errorAt = diff.findIndex((line) => line.includes(NAME_NOT_UTF8));
      const realAt = diff.findIndex((line) => line.includes('three'));
      const before = writes.length;

      if (realAt >= 0 && (errorAt < 0 || realAt < errorAt)) {
        seen.push('real');
        instance.stdin.write('y');
        await flush(5);
        expect(writes.slice(before)).toEqual([literalCafe]);
        instance.stdin.write('d');
        await flush(5);
        expect(writes).toHaveLength(before + 2);
        expect(writes.at(-1)).toContain('+three');
        expect(footer(instance.lastFrame())).toContain('✓ Copied');
        expectOwnBlock(await runBlockCopies(instance, writes, {buttons: true}));
      } else {
        seen.push('undecodable');
        expect(errorAt).toBeGreaterThanOrEqual(0);
        for (const key of ['y', 'd', 'f']) {
          instance.stdin.write(key);
          await flush(5);
          expect(footer(instance.lastFrame()), key).toContain(NAME_NOT_UTF8);
          expect(footer(instance.lastFrame()), key).not.toContain('✓');
        }
        // The file shows no block, so it has no header buttons; its block
        // keys still fail with the file's reason.
        expectRefused(await runBlockCopies(instance, writes, {buttons: false}));
        expect(writes).toHaveLength(before);
      }
    }
    expect(seen.sort()).toEqual(['real', 'undecodable']);

    instance.unmount();
  });

  it('runs a block copy on the focused block\'s own file when the other file comes first', async () => {
    // Git lists the real file first, and the undecodable one shows no block.
    // This review puts the undecodable file first, with a block of its own,
    // so a block copy that found its file by path would check the wrong one.
    const built = buildFixture([
      {path: literalCafe, rawDiff: '@@ -0,0 +1 @@\n+latin', rendered: [`• ${literalCafe}:1: `, `${gutter(1)}latin`]},
      {
        path: literalCafe,
        rawDiff: '@@ -0,0 +1,3 @@\n+one\n+two\n+three',
        rendered: [`• ${literalCafe}:1: `, `${gutter(1)}one`, `${gutter(2)}two`, `${gutter(3)}three`],
      },
    ]);
    Object.assign(built.review.files[0]!, {pathError: NAME_NOT_UTF8, rawDiffError: NAME_NOT_UTF8});

    const writes: string[] = [];
    const instance = renderFixture(built, {columns: 140, rows: 30}, writes);
    await flush(5);
    const rowsOnScreen = cafeRows(instance);
    expect(rowsOnScreen).toHaveLength(2);

    const seen: string[] = [];
    for (const {row, column} of rowsOnScreen) {
      await emitMousePressAt(column, row);
      await flush(5);
      const diff = frameLines(instance.lastFrame()).map(diffPart);
      const latinAt = diff.findIndex((line) => line.includes('latin'));
      const realAt = diff.findIndex((line) => line.includes('three'));
      const results = await runBlockCopies(instance, writes, {buttons: true});

      if (realAt >= 0 && (latinAt < 0 || realAt < latinAt)) {
        seen.push('real');
        expectOwnBlock(results);
      } else {
        seen.push('undecodable');
        expectRefused(results);
      }
    }
    expect(seen.sort()).toEqual(['real', 'undecodable']);

    instance.unmount();
  });
});
