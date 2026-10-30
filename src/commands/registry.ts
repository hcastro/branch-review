import {
  buildAbsolutePathPayload,
  buildCodePayload,
  buildFileContentsPayload,
  buildFileDiffPayload,
  buildBlockDiffPayload,
  buildBlockPromptPayload,
  buildPathPayload,
} from '../clipboard/payloads.js';
import type {ReviewFile, ReviewBlock, ReviewModel} from '../review/model.js';

export type CommandGroup = 'Copy for agent' | 'Copy paths' | 'Copy content' | 'Export';

export type CommandContext = {
  model: ReviewModel;
  activeFile?: ReviewFile;
  focusedBlock?: ReviewBlock;
  // The file `focusedBlock` belongs to, or the file a block copy acts on when
  // no block is focused. Two files can show the same path text, so a block's
  // path alone can name the wrong one.
  focusedBlockFile?: ReviewFile;
  readFileContent?: (file: ReviewFile) => string | null;
  resolveAbsolutePath?: (file: ReviewFile) => string | null;
};

export type CommandPayload = {
  text: string;
  toast: string;
  hint?: string;
};

export type CommandDefinition = {
  id: string;
  group: CommandGroup;
  title: string;
  isEnabled: (context: CommandContext) => boolean;
  buildPayload: (context: CommandContext) => CommandPayload | null;
};

function activeFile(context: CommandContext) {
  return context.activeFile ?? null;
}

function focusedBlock(context: CommandContext) {
  return context.focusedBlock ?? null;
}

function fileAndBlock(context: CommandContext) {
  const file = activeFile(context);
  const block = focusedBlock(context);
  return file && block ? {file, block} : null;
}

// A copy of a file's diff text fails, with the reason as the message, when
// that text failed to load or is not valid UTF-8. A thrown error becomes a
// failed copy that names the reason.
function assertDiffCopyable(file: Pick<ReviewFile, 'rawDiffError'> | undefined) {
  if (file?.rawDiffError !== undefined) throw new Error(file.rawDiffError);
}

// A file whose name is not valid UTF-8 is shown under an escaped name that
// names no real file, so no copy may hand that name (or anything read
// through it) on as if it were the file's.
function assertPathCopyable(file: Pick<ReviewFile, 'pathError'> | undefined) {
  if (file?.pathError !== undefined) throw new Error(file.pathError);
}

// The file a block copy acts on: the one passed with the block; without it,
// the file with the block's path, else the active file.
function blockFile(context: CommandContext, block: ReviewBlock | null) {
  return context.focusedBlockFile
    ?? (block ? context.model.files.find((file) => file.path === block.filePath) : undefined)
    ?? context.activeFile;
}

// A block copy on a file whose name is not UTF-8 fails with that reason, as
// its file copies do, even when the file shows no block to focus.
function blockCopyRefused(context: CommandContext) {
  return blockFile(context, focusedBlock(context))?.pathError !== undefined;
}

export const copyCommands: CommandDefinition[] = [
  {
    id: 'copy.fileContents',
    group: 'Copy content',
    title: 'Copy active file contents',
    isEnabled: (context) => {
      const file = activeFile(context);
      return Boolean(file && file.status !== 'deleted');
    },
    buildPayload: (context) => {
      const file = activeFile(context);
      if (!file || file.status === 'deleted') return null;
      assertPathCopyable(file);
      const contents = context.readFileContent?.(file);
      if (typeof contents !== 'string') return null;
      return {
        text: buildFileContentsPayload(contents),
        toast: 'Copied file',
        hint: file.path,
      };
    },
  },
  {
    id: 'copy.blockPrompt',
    group: 'Copy for agent',
    title: 'Copy focused block',
    isEnabled: (context) => Boolean(fileAndBlock(context)) || blockCopyRefused(context),
    buildPayload: (context) => {
      assertPathCopyable(blockFile(context, focusedBlock(context)));
      const target = fileAndBlock(context);
      if (!target) return null;
      assertPathCopyable(target.file);
      assertDiffCopyable(blockFile(context, target.block));
      return {
        text: buildBlockPromptPayload(target.file, target.block),
        toast: 'Copied block',
        hint: `${target.file.path}:${target.block.lineStart}`,
      };
    },
  },
  {
    id: 'copy.path',
    group: 'Copy paths',
    title: 'Copy active file path',
    isEnabled: (context) => Boolean(activeFile(context)),
    buildPayload: (context) => {
      const file = activeFile(context);
      if (!file) return null;
      assertPathCopyable(file);
      return {
        text: buildPathPayload(file),
        toast: 'Copied path',
        hint: file.path,
      };
    },
  },
  {
    id: 'copy.absolutePath',
    group: 'Copy paths',
    title: 'Copy active file absolute path',
    isEnabled: (context) => Boolean(activeFile(context)),
    buildPayload: (context) => {
      const file = activeFile(context);
      if (!file) return null;
      assertPathCopyable(file);
      const absolutePath = context.resolveAbsolutePath?.(file);
      if (typeof absolutePath !== 'string') return null;
      return {
        text: buildAbsolutePathPayload(absolutePath),
        toast: 'Copied absolute path',
        hint: file.path,
      };
    },
  },
  {
    id: 'copy.blockCode',
    group: 'Copy content',
    title: 'Copy focused block code',
    isEnabled: (context) => Boolean(focusedBlock(context)) || blockCopyRefused(context),
    buildPayload: (context) => {
      const block = focusedBlock(context);
      assertPathCopyable(blockFile(context, block));
      if (!block) return null;
      assertDiffCopyable(blockFile(context, block));
      return {
        text: buildCodePayload(block),
        toast: 'Copied block code',
        hint: `${block.filePath}:${block.lineStart}`,
      };
    },
  },
  {
    id: 'copy.blockDiff',
    group: 'Copy content',
    title: 'Copy focused block diff',
    isEnabled: (context) => Boolean(focusedBlock(context)) || blockCopyRefused(context),
    buildPayload: (context) => {
      const block = focusedBlock(context);
      assertPathCopyable(blockFile(context, block));
      if (!block) return null;
      assertDiffCopyable(blockFile(context, block));
      return {
        text: buildBlockDiffPayload(block),
        toast: 'Copied block diff',
        hint: `${block.filePath}:${block.lineStart}`,
      };
    },
  },
  {
    id: 'copy.fileDiff',
    group: 'Copy content',
    title: 'Copy active file diff',
    isEnabled: (context) => Boolean(activeFile(context)),
    buildPayload: (context) => {
      const file = activeFile(context);
      if (!file) return null;
      assertDiffCopyable(file);
      return {
        text: buildFileDiffPayload(file),
        toast: 'Copied file diff',
        hint: file.path,
      };
    },
  },
];

export function getCopyCommand(id: string) {
  return copyCommands.find((command) => command.id === id) ?? null;
}
