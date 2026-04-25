import {
  buildAllChangedPathsPayload,
  buildBranchPromptPayload,
  buildCodePayload,
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

export const copyCommands: CommandDefinition[] = [
  {
    id: 'copy.filePrompt',
    group: 'Copy for agent',
    title: 'Copy active file',
    shortcuts: [],
    isEnabled: (context) => Boolean(activeFile(context)),
    buildPayload: (context) => {
      const file = activeFile(context);
      if (!file) return null;
      return {
        text: buildFilePromptPayload(file),
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
      return {
        text: buildPathPayload(file),
        toast: 'Copied path',
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
    buildPayload: (context) => ({
      text: buildAllChangedPathsPayload(context.model),
      toast: 'Copied all changed paths',
      hint: `${context.model.files.length} files`,
    }),
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
