import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {App} from '../src/ui/App.js';
import {buildReviewModel, buildReviewSections} from '../src/review/build.js';
import {getReviewFileContents, resolveRefs} from '../src/git.js';
import {cleanupTempDirs, initRepo} from './core-helpers.js';
import {cellPosition, emitMouseDragAt, emitMousePressAt, flush, frameLines, recordingWriter, renderSized} from './ui-fixtures.js';

// A drag-selection over a file whose text is not its bytes copies nothing and
// says why, the way the keyboard copies of that file do. Built from a real
// repo with real git and delta, so the rows are the ones a user would see.

vi.setConfig({testTimeout: 120_000});
afterEach(cleanupTempDirs);

async function renderRepo(cwd: string, writes: string[]) {
  const range = resolveRefs(cwd, 'HEAD', 'main');
  const review = await buildReviewModel({cwd, range, width: 100});
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
  return {instance, review};
}

async function dragOver(frame: string | undefined, line: string) {
  const from = cellPosition(frame, [line], line);
  const to = cellPosition(frame, [line], line, line.length - 1);
  await emitMousePressAt(from.column, from.row);
  await emitMouseDragAt(to.column, to.row);
  await emitMouseDragAt(to.column, to.row, true);
  await flush(5);
}

const footer = (frame: string | undefined) => frameLines(frame).at(-2) ?? '';

describe('drag-select over a file that is not UTF-8', () => {
  it('copies nothing and shows the reason, like the keyboard copies', async () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    fs.writeFileSync(path.join(cwd, 'a.txt'), Buffer.from('one\ncaf\xe9 latin1\n', 'latin1'));
    const writes: string[] = [];
    const {instance, review} = await renderRepo(cwd, writes);
    expect(review.files[0]!.rawDiffError).toBe('not UTF-8 text');

    instance.stdin.write('d');
    await flush(5);
    expect(footer(instance.lastFrame())).toContain('✗ Copy action unavailable. · not UTF-8 text');

    await dragOver(instance.lastFrame(), 'latin1');
    expect(footer(instance.lastFrame())).toContain('✗ Copy action unavailable. · not UTF-8 text');
    expect(footer(instance.lastFrame())).not.toContain('Copied selection');
    expect(writes).toEqual([]);

    instance.unmount();
  });

  it('copies nothing from a drag that starts in a UTF-8 file and ends in one that is not', async () => {
    const cwd = initRepo({'a.txt': 'one\n', 'b.txt': 'two\n'});
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\nplain utf8 line\n');
    fs.writeFileSync(path.join(cwd, 'b.txt'), Buffer.from('two\ncaf\xe9 latin1\n', 'latin1'));
    const writes: string[] = [];
    const {instance, review} = await renderRepo(cwd, writes);
    expect(review.files.map((file) => file.rawDiffError)).toEqual([undefined, 'not UTF-8 text']);

    const frame = instance.lastFrame();
    const from = cellPosition(frame, ['plain utf8 line'], 'plain utf8 line');
    const to = cellPosition(frame, ['latin1'], 'latin1', 'latin1'.length - 1);
    expect(to.row).toBeGreaterThan(from.row);
    await emitMousePressAt(from.column, from.row);
    await emitMouseDragAt(to.column, to.row);
    await emitMouseDragAt(to.column, to.row, true);
    await flush(5);

    expect(footer(instance.lastFrame())).toContain('✗ Copy action unavailable. · not UTF-8 text');
    expect(footer(instance.lastFrame())).not.toContain('Copied selection');
    expect(writes).toEqual([]);

    instance.unmount();
  });

  it('still copies a selection inside a UTF-8 file of the same review', async () => {
    const cwd = initRepo({'a.txt': 'one\n', 'b.txt': 'two\n'});
    fs.writeFileSync(path.join(cwd, 'a.txt'), Buffer.from('one\ncaf\xe9 latin1\n', 'latin1'));
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'two\nplain utf8 line\n');
    const writes: string[] = [];
    const {instance} = await renderRepo(cwd, writes);

    await dragOver(instance.lastFrame(), 'plain utf8 line');
    expect(writes).toEqual(['plain utf8 line']);
    expect(footer(instance.lastFrame())).toContain('✓ Copied selection');

    instance.unmount();
  });
});
