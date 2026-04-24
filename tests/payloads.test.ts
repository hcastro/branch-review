import {describe, expect, it} from 'vitest';
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
} from '../src/clipboard/payloads.js';
import type {ReviewFile, ReviewHunk, ReviewModel} from '../src/review/model.js';

const rawHunk = [
  '@@ -1,2 +1,3 @@ function example()',
  ' const before = true;',
  '-const value = 1;',
  '+const value = 2;',
  '+const next = 3;',
].join('\n');

const hunk: ReviewHunk = {
  id: 'src/example.ts:1:0',
  filePath: 'src/example.ts',
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 3,
  lineStart: 1,
  lineEnd: 3,
  functionHeader: 'function example()',
  rawDiff: rawHunk,
  addedCode: 'const value = 2;\nconst next = 3;',
};

const file: ReviewFile = {
  path: 'src/example.ts',
  status: 'modified',
  metrics: {path: 'src/example.ts', additions: 2, deletions: 1, changedLines: 3},
  rawDiff: [
    'diff --git a/src/example.ts b/src/example.ts',
    '--- a/src/example.ts',
    '+++ b/src/example.ts',
    rawHunk,
  ].join('\n'),
  renderedLines: [],
  hunks: [hunk],
};

const model: ReviewModel = {
  base: 'development',
  branch: 'HEAD + worktree',
  label: 'development...HEAD + worktree',
  metrics: {filesChanged: 1, additions: 2, deletions: 1, changedLines: 3},
  files: [file],
};

describe('copy payload builders', () => {
  it('builds path and content payloads', () => {
    expect(buildPathPayload(file)).toBe('src/example.ts');
    expect(buildPathLinePayload(file, hunk)).toBe('src/example.ts:1');
    expect(buildAllChangedPathsPayload(model)).toBe('src/example.ts');
    expect(buildCodePayload(hunk)).toMatchInlineSnapshot(`
      "const value = 2;
      const next = 3;"
    `);
    expect(buildHunkDiffPayload(hunk)).toBe(rawHunk);
    expect(buildFileDiffPayload(file)).toBe(file.rawDiff);
  });

  it('builds agent prompt payloads', () => {
    expect(buildHunkPromptPayload(file, hunk)).toMatchInlineSnapshot(`
      "File: src/example.ts
      Lines: 1-3
      Function: function example()

      \`\`\`diff
      @@ -1,2 +1,3 @@ function example()
       const before = true;
      -const value = 1;
      +const value = 2;
      +const next = 3;
      \`\`\`"
    `);

    expect(buildFilePromptPayload(file)).toMatchInlineSnapshot(`
      "File: src/example.ts

      \`\`\`diff
      diff --git a/src/example.ts b/src/example.ts
      --- a/src/example.ts
      +++ b/src/example.ts
      @@ -1,2 +1,3 @@ function example()
       const before = true;
      -const value = 1;
      +const value = 2;
      +const next = 3;
      \`\`\`"
    `);

    expect(buildBranchPromptPayload(model)).toMatchInlineSnapshot(`
      "# Branch review · development...HEAD + worktree
      1 files · +2 -1

      ## src/example.ts

      \`\`\`diff
      diff --git a/src/example.ts b/src/example.ts
      --- a/src/example.ts
      +++ b/src/example.ts
      @@ -1,2 +1,3 @@ function example()
       const before = true;
      -const value = 1;
      +const value = 2;
      +const next = 3;
      \`\`\`"
    `);
  });
});
