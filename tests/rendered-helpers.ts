import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import type {FileStatus} from '../src/git.js';
import type {ReviewFile} from '../src/review/model.js';
import {makeTempDir} from './core-helpers.js';

/**
 * A review file for `before` -> `after` with the hunks real git prints, so
 * change groups are read from the same patch shapes the review sees. null on
 * one side is a new or a deleted file.
 */
export function diffFile(before: string | null, after: string | null, filePath = 'doc.md'): ReviewFile {
  const dir = makeTempDir('branch-review-rendered-diff-');
  const left = path.join(dir, 'before.md');
  const right = path.join(dir, 'after.md');
  if (before !== null) fs.writeFileSync(left, before);
  if (after !== null) fs.writeFileSync(right, after);
  const result = spawnSync('git', [
    'diff', '--no-index', '--no-color', '--no-ext-diff',
    before === null ? '/dev/null' : left,
    after === null ? '/dev/null' : right,
  ], {encoding: 'utf8'});
  const rawDiff = result.stdout;
  const status: FileStatus = before === null ? 'added' : after === null ? 'deleted' : 'modified';
  return {
    path: filePath,
    status,
    metrics: {path: filePath, additions: 0, deletions: 0, changedLines: 0},
    rawDiff,
    renderedLines: [],
    blocks: parseUnifiedDiffBlocks(rawDiff, filePath),
  };
}
