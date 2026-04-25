import {describe, expect, it} from 'vitest';
import {MISSING_CLIPBOARD_MESSAGE} from '../src/clipboard/write.js';
import {executeCopyCommand} from '../src/commands/execute.js';
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

  it('executes copy commands through an injectable clipboard writer', async () => {
    const writes: string[] = [];
    const context: CommandContext = {model, activeFile: file, focusedHunk: hunk};

    await expect(executeCopyCommand('copy.path', context, {
      write: async (text) => {
        writes.push(text);
        return {
          ok: true,
          command: {command: '/usr/bin/pbcopy', args: [], displayName: 'pbcopy'},
        };
      },
    })).resolves.toEqual({
      ok: true,
      commandId: 'copy.path',
      toast: 'Copied path',
      hint: 'src/example.ts',
      bytes: Buffer.byteLength('src/example.ts', 'utf8'),
    });
    expect(writes).toEqual(['src/example.ts']);
  });

  it('returns friendly command execution failures', async () => {
    const context: CommandContext = {model};

    await expect(executeCopyCommand('copy.path', context, {
      write: async () => {
        throw new Error('should not write when disabled');
      },
    })).resolves.toEqual({
      ok: false,
      commandId: 'copy.path',
      toast: 'Copy action unavailable.',
      reason: 'disabled',
    });

    await expect(executeCopyCommand('copy.path', {...context, activeFile: file}, {
      write: async () => ({
        ok: false,
        message: MISSING_CLIPBOARD_MESSAGE,
      }),
    })).resolves.toEqual({
      ok: false,
      commandId: 'copy.path',
      toast: MISSING_CLIPBOARD_MESSAGE,
      reason: 'clipboard',
    });

    await expect(executeCopyCommand('copy.missing', context)).resolves.toEqual({
      ok: false,
      commandId: 'copy.missing',
      toast: 'Copy action not found.',
      reason: 'not-found',
    });
  });
});
