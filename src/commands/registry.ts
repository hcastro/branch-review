import {
  buildAbsolutePathPayload,
  buildAllChangedPathsPayload,
  buildBranchPromptPayload,
  buildCodePayload,
  buildFileContentsPayload,
  buildFileDiffPayload,
  buildFilePromptPayload,
  buildBlockDiffPayload,
  buildBlockPromptPayload,
  buildPathLinePayload,
  buildPathPayload,
} from '../clipboard/payloads.js';
import type {ReviewFile, ReviewBlock, ReviewModel} from '../review/model.js';

export type CommandGroup = 'Copy for agent' | 'Copy paths' | 'Copy content' | 'Export';

export type CommandContext = {
  model: ReviewModel;
  activeFile?: ReviewFile;
  focusedBlock?: ReviewBlock;
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
  shortcuts: string[];
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

function blockFile(context: CommandContext, block: ReviewBlock) {
  return context.model.files.find((file) => file.path === block.filePath) ?? context.activeFile;
}

export const copyCommands: CommandDefinition[] = [
  {
    id: 'copy.filePrompt',
    group: 'Copy for agent',
    title: 'Copy active file context',
    shortcuts: [],
    isEnabled: (context) => Boolean(activeFile(context)),
    buildPayload: (context) => {
      const file = activeFile(context);
      if (!file) return null;
      assertPathCopyable(file);
      assertDiffCopyable(file);
      return {
        text: buildFilePromptPayload(file),
        toast: 'Copied file context',
        hint: file.path,
      };
    },
  },
  {
    id: 'copy.fileContents',
    group: 'Copy content',
    title: 'Copy active file contents',
    shortcuts: [],
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
    shortcuts: [],
    isEnabled: (context) => Boolean(fileAndBlock(context)),
    buildPayload: (context) => {
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
    shortcuts: ['y p', 'y P'],
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
    shortcuts: [],
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
    id: 'copy.pathLine',
    group: 'Copy paths',
    title: 'Copy focused block path:line',
    shortcuts: ['y l'],
    isEnabled: (context) => Boolean(fileAndBlock(context)),
    buildPayload: (context) => {
      const target = fileAndBlock(context);
      if (!target) return null;
      assertPathCopyable(target.file);
      return {
        text: buildPathLinePayload(target.file, target.block),
        toast: 'Copied path:line',
        hint: `${target.file.path}:${target.block.lineStart}`,
      };
    },
  },
  {
    id: 'copy.allPaths',
    group: 'Copy paths',
    title: 'Copy all changed paths',
    shortcuts: ['y A'],
    isEnabled: (context) => context.model.files.length > 0,
    buildPayload: (context) => {
      const unnamed = context.model.files.find((file) => file.pathError !== undefined);
      if (unnamed) throw new Error(`${unnamed.pathError}: ${unnamed.path}`);
      return {
        text: buildAllChangedPathsPayload(context.model),
        toast: 'Copied all changed paths',
        hint: `${context.model.files.length} files`,
      };
    },
  },
  {
    id: 'copy.blockCode',
    group: 'Copy content',
    title: 'Copy focused block code',
    shortcuts: ['y c'],
    isEnabled: (context) => Boolean(focusedBlock(context)),
    buildPayload: (context) => {
      const block = focusedBlock(context);
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
    shortcuts: ['y h'],
    isEnabled: (context) => Boolean(focusedBlock(context)),
    buildPayload: (context) => {
      const block = focusedBlock(context);
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
    shortcuts: ['y f'],
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
  {
    id: 'copy.branchPrompt',
    group: 'Export',
    title: 'Copy branch review',
    shortcuts: ['y a'],
    isEnabled: (context) => context.model.files.length > 0,
    buildPayload: (context) => ({
      text: buildBranchPromptPayload(context.model),
      toast: 'Copied branch review',
      hint: `${context.model.files.length} files`,
    }),
  },
];

export function getCopyCommand(id: string) {
  return copyCommands.find((command) => command.id === id) ?? null;
}
