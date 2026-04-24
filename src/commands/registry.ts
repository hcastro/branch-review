import {
  buildAllChangedPathsPayload,
  buildBranchPromptPayload,
  buildCodePayload,
  buildFileDiffPayload,
  buildFilePromptPayload,
  buildHunkDiffPayload,
  buildHunkPromptPayload,
  buildPathLinePayload,
  buildPathPayload,
} from '../clipboard/payloads.js';
import type {ReviewFile, ReviewHunk, ReviewModel} from '../review/model.js';

export type CommandGroup = 'Copy for agent' | 'Copy paths' | 'Copy content' | 'Export';

export type CommandContext = {
  model: ReviewModel;
  activeFile?: ReviewFile;
  focusedHunk?: ReviewHunk;
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

function focusedHunk(context: CommandContext) {
  return context.focusedHunk ?? null;
}

function fileAndHunk(context: CommandContext) {
  const file = activeFile(context);
  const hunk = focusedHunk(context);
  return file && hunk ? {file, hunk} : null;
}

export const copyCommands: CommandDefinition[] = [
  {
    id: 'copy.filePrompt',
    group: 'Copy for agent',
    title: 'Copy active file as prompt',
    shortcuts: [],
    isEnabled: (context) => Boolean(activeFile(context)),
    buildPayload: (context) => {
      const file = activeFile(context);
      if (!file) return null;
      return {
        text: buildFilePromptPayload(file),
        toast: 'Copied file prompt',
        hint: file.path,
      };
    },
  },
  {
    id: 'copy.hunkPrompt',
    group: 'Copy for agent',
    title: 'Copy focused hunk as prompt',
    shortcuts: [],
    isEnabled: (context) => Boolean(fileAndHunk(context)),
    buildPayload: (context) => {
      const target = fileAndHunk(context);
      if (!target) return null;
      return {
        text: buildHunkPromptPayload(target.file, target.hunk),
        toast: 'Copied hunk prompt',
        hint: `${target.file.path}:${target.hunk.lineStart}`,
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
    title: 'Copy focused hunk path:line',
    shortcuts: ['y l'],
    isEnabled: (context) => Boolean(fileAndHunk(context)),
    buildPayload: (context) => {
      const target = fileAndHunk(context);
      if (!target) return null;
      return {
        text: buildPathLinePayload(target.file, target.hunk),
        toast: 'Copied path:line',
        hint: `${target.file.path}:${target.hunk.lineStart}`,
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
    id: 'copy.hunkCode',
    group: 'Copy content',
    title: 'Copy focused hunk code',
    shortcuts: ['y c'],
    isEnabled: (context) => Boolean(focusedHunk(context)),
    buildPayload: (context) => {
      const hunk = focusedHunk(context);
      if (!hunk) return null;
      return {
        text: buildCodePayload(hunk),
        toast: 'Copied hunk code',
        hint: `${hunk.filePath}:${hunk.lineStart}`,
      };
    },
  },
  {
    id: 'copy.hunkDiff',
    group: 'Copy content',
    title: 'Copy focused hunk diff',
    shortcuts: ['y h'],
    isEnabled: (context) => Boolean(focusedHunk(context)),
    buildPayload: (context) => {
      const hunk = focusedHunk(context);
      if (!hunk) return null;
      return {
        text: buildHunkDiffPayload(hunk),
        toast: 'Copied hunk diff',
        hint: `${hunk.filePath}:${hunk.lineStart}`,
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
    title: 'Copy branch review as prompt',
    shortcuts: ['y a'],
    isEnabled: (context) => context.model.files.length > 0,
    buildPayload: (context) => ({
      text: buildBranchPromptPayload(context.model),
      toast: 'Copied branch prompt',
      hint: `${context.model.files.length} files`,
    }),
  },
];

export function getCopyCommand(id: string) {
  return copyCommands.find((command) => command.id === id) ?? null;
}
