import {describe, expect, it} from 'vitest';
import {MISSING_CLIPBOARD_MESSAGE} from '../src/clipboard/write.js';
import {executeCopyCommand} from '../src/commands/execute.js';
import {copyCommands, getCopyCommand, type CommandContext} from '../src/commands/registry.js';
import type {ReviewFile, ReviewBlock, ReviewModel} from '../src/review/model.js';

const block: ReviewBlock = {
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
  blocks: [block],
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
    const context: CommandContext = {
      model,
      activeFile: file,
      focusedBlock: block,
      readFileContent: () => 'export const value = 2;\n',
      resolveAbsolutePath: () => '/repo/src/example.ts',
    };

    expect(copyCommands.map((command) => command.id)).toEqual([
      'copy.filePrompt',
      'copy.fileContents',
      'copy.blockPrompt',
      'copy.path',
      'copy.absolutePath',
      'copy.pathLine',
      'copy.allPaths',
      'copy.blockCode',
      'copy.blockDiff',
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

    const blockDiffCommand = getCopyCommand('copy.blockDiff');
    expect(blockDiffCommand?.shortcuts).toEqual(['y h']);
    expect(blockDiffCommand?.buildPayload(context)?.text).toBe(block.rawDiff);

    expect(getCopyCommand('copy.fileContents')?.buildPayload(context)).toEqual({
      text: 'export const value = 2;\n',
      toast: 'Copied file',
      hint: 'src/example.ts',
    });
    expect(getCopyCommand('copy.absolutePath')?.buildPayload(context)).toEqual({
      text: '/repo/src/example.ts',
      toast: 'Copied absolute path',
      hint: 'src/example.ts',
    });
    expect(getCopyCommand('copy.fileDiff')?.buildPayload(context)?.text).toBe(file.rawDiff);
    expect(getCopyCommand('copy.filePrompt')?.buildPayload(context)?.text).toContain('```diff');
    expect(getCopyCommand('copy.blockCode')?.buildPayload(context)?.text).toBe('new');
    expect(getCopyCommand('copy.blockPrompt')?.buildPayload(context)?.text).toContain('Lines: 10-10');
  });

  it('documents payload contracts for every copy action', () => {
    const context: CommandContext = {
      model,
      activeFile: file,
      focusedBlock: block,
      readFileContent: () => 'export const value = 2;\n',
      resolveAbsolutePath: () => '/repo/src/example.ts',
    };

    expect(getCopyCommand('copy.path')?.buildPayload(context)?.text).toBe('src/example.ts');
    expect(getCopyCommand('copy.absolutePath')?.buildPayload(context)?.text).toBe('/repo/src/example.ts');
    expect(getCopyCommand('copy.pathLine')?.buildPayload(context)?.text).toBe('src/example.ts:10');
    expect(getCopyCommand('copy.allPaths')?.buildPayload(context)?.text).toBe('src/example.ts');
    expect(getCopyCommand('copy.blockCode')?.buildPayload(context)?.text).toBe('new');
    expect(getCopyCommand('copy.blockDiff')?.buildPayload(context)?.text).toBe(block.rawDiff);
    expect(getCopyCommand('copy.fileDiff')?.buildPayload(context)?.text).toBe(file.rawDiff);
    expect(getCopyCommand('copy.fileContents')?.buildPayload(context)?.text).toBe('export const value = 2;\n');
    expect(getCopyCommand('copy.filePrompt')?.buildPayload(context)?.text).toMatchInlineSnapshot(`
      "File: src/example.ts

      \`\`\`diff
      diff --git a/src/example.ts b/src/example.ts
      @@ -9 +10 @@
      -old
      +new
      \`\`\`"
    `);
    expect(getCopyCommand('copy.blockPrompt')?.buildPayload(context)?.text).toMatchInlineSnapshot(`
      "File: src/example.ts
      Lines: 10-10

      \`\`\`diff
      @@ -9 +10 @@
      -old
      +new
      \`\`\`"
    `);
    expect(getCopyCommand('copy.branchPrompt')?.buildPayload(context)?.text).toMatchInlineSnapshot(`
      "# Branch review · development...HEAD + worktree
      1 files · +1 -1

      ## src/example.ts

      \`\`\`diff
      diff --git a/src/example.ts b/src/example.ts
      @@ -9 +10 @@
      -old
      +new
      \`\`\`"
    `);
  });

  it('executes copy commands through an injectable clipboard writer', async () => {
    const writes: string[] = [];
    const context: CommandContext = {model, activeFile: file, focusedBlock: block};

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

  it('copies full file contents separately from file diffs', async () => {
    const writes: string[] = [];
    const context: CommandContext = {
      model,
      activeFile: file,
      focusedBlock: block,
      readFileContent: () => 'export const value = 2;\n',
      resolveAbsolutePath: () => '/repo/src/example.ts',
    };

    await expect(executeCopyCommand('copy.fileContents', context, {
      write: async (text) => {
        writes.push(text);
        return {
          ok: true,
          command: {command: '/usr/bin/pbcopy', args: [], displayName: 'pbcopy'},
        };
      },
    })).resolves.toMatchObject({
      ok: true,
      commandId: 'copy.fileContents',
      toast: 'Copied file',
      hint: 'src/example.ts',
    });

    expect(writes).toEqual(['export const value = 2;\n']);
    expect(writes[0]).not.toBe(file.rawDiff);
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

  it('shows why file contents could not be read', async () => {
    const writes: string[] = [];
    const result = await executeCopyCommand('copy.fileContents', {
      model,
      activeFile: file,
      readFileContent: () => {
        throw new Error('src/example.ts is not a regular file');
      },
    }, {
      write: (text) => {
        writes.push(text);
        return {ok: true, command: {command: 'fake', args: [], displayName: 'fake'}};
      },
    });

    expect(result).toEqual({
      ok: false,
      commandId: 'copy.fileContents',
      toast: 'Copy action unavailable.',
      hint: 'src/example.ts is not a regular file',
      reason: 'disabled',
    });
    expect(writes).toEqual([]);
  });
});

describe('block copies on two files that show the same path', () => {
  // A name that failed to decode is shown by an escaped stand-in; a real file
  // can be named like it. The undecodable one is listed first here.
  const undecodable: ReviewFile = {
    ...file,
    blocks: [{...block, id: 'u', rawDiff: '@@ -9 +10 @@\n-old\n+latin', addedCode: 'latin'}],
    pathError: 'file name is not UTF-8',
    rawDiffError: 'file name is not UTF-8',
  };
  const real: ReviewFile = {...file, blocks: [{...block, id: 'r'}]};
  const twoFiles: ReviewModel = {...model, files: [undecodable, real]};
  const blockCopies = ['copy.blockCode', 'copy.blockDiff', 'copy.blockPrompt'];

  function recorder() {
    const writes: string[] = [];
    return {writes, write: async (text: string) => {
      writes.push(text);
      return {ok: true as const, command: {command: 'pbcopy', args: [], displayName: 'pbcopy'}};
    }};
  }

  it('checks the file passed with the block, not the first file with its path', async () => {
    const writer = recorder();
    const context: CommandContext = {model: twoFiles, activeFile: real, focusedBlock: real.blocks[0], focusedBlockFile: real};
    for (const id of blockCopies) {
      expect(await executeCopyCommand(id, context, writer), id).toMatchObject({ok: true});
    }
    expect(writer.writes[0]).toBe('new');
    expect(writer.writes).toHaveLength(3);
  });

  it('fails every block copy on the undecodable file with its reason, with or without a block', async () => {
    const writer = recorder();
    const contexts: CommandContext[] = [
      {model: twoFiles, activeFile: undecodable, focusedBlock: undecodable.blocks[0], focusedBlockFile: undecodable},
      {model: twoFiles, activeFile: {...undecodable, blocks: []}, focusedBlockFile: {...undecodable, blocks: []}},
    ];
    for (const context of contexts) {
      for (const id of blockCopies) {
        expect(await executeCopyCommand(id, context, writer), id)
          .toMatchObject({ok: false, hint: 'file name is not UTF-8', reason: 'disabled'});
      }
    }
    expect(writer.writes).toEqual([]);
  });

  it('keeps block copies disabled, with no reason, on a valid file that shows no block', async () => {
    const empty: ReviewFile = {...file, blocks: []};
    for (const id of blockCopies) {
      expect(await executeCopyCommand(id, {model, activeFile: empty, focusedBlockFile: empty}), id).toEqual({
        ok: false,
        commandId: id,
        toast: 'Copy action unavailable.',
        reason: 'disabled',
      });
    }
  });
});
