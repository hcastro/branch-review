import {describe, expect, it} from 'vitest';
import {copyCommands, getCopyCommand, type CommandContext} from '../src/commands/registry.js';
import type {ReviewFile, ReviewHunk, ReviewModel} from '../src/review/model.js';

const hunk: ReviewHunk = {
  id: 'src/example.ts:10:0',
  filePath: 'src/example.ts',
  oldStart: 9,
  oldLines: 1,
  newStart: 10,
  newLines: 1,
  lineStart: 10,
  lineEnd: 10,
  rawDiff: '@@ -9 +10 @@\n-old\n+new',
  addedCode: 'new',
};

const file: ReviewFile = {
  path: 'src/example.ts',
  status: 'modified',
  metrics: {path: 'src/example.ts', additions: 1, deletions: 1, changedLines: 2},
  rawDiff: 'diff --git a/src/example.ts b/src/example.ts\n@@ -9 +10 @@\n-old\n+new',
  renderedLines: [],
  hunks: [hunk],
};

const model: ReviewModel = {
  base: 'development',
  branch: 'HEAD + worktree',
  label: 'development...HEAD + worktree',
  metrics: {filesChanged: 1, additions: 1, deletions: 1, changedLines: 2},
  files: [file],
};

describe('copy command registry', () => {
  it('uses one registry for palette, yank, and button payloads', () => {
    const context: CommandContext = {model, activeFile: file, focusedHunk: hunk};

    expect(copyCommands.map((command) => command.id)).toEqual([
      'copy.filePrompt',
      'copy.hunkPrompt',
      'copy.path',
      'copy.pathLine',
      'copy.allPaths',
      'copy.hunkCode',
      'copy.hunkDiff',
      'copy.fileDiff',
      'copy.branchPrompt',
    ]);
    expect(copyCommands.some((command) => command.id.toLowerCase().includes('github'))).toBe(false);

    const pathCommand = getCopyCommand('copy.path');
    expect(pathCommand?.shortcuts).toEqual(['y p', 'y P']);
    expect(pathCommand?.buildPayload(context)).toEqual({
      text: 'src/example.ts',
      toast: 'Copied path',
      hint: 'src/example.ts',
    });

    const hunkDiffCommand = getCopyCommand('copy.hunkDiff');
    expect(hunkDiffCommand?.shortcuts).toEqual(['y h']);
    expect(hunkDiffCommand?.buildPayload(context)?.text).toBe(hunk.rawDiff);
  });
});
