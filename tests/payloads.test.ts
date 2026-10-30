import {describe, expect, it} from 'vitest';
import {
  buildAbsolutePathPayload,
  buildCodePayload,
  buildFileContentsPayload,
  buildFileDiffPayload,
  buildBlockDiffPayload,
  buildBlockPromptPayload,
  buildPathPayload,
} from '../src/clipboard/payloads.js';
import type {ReviewFile, ReviewBlock} from '../src/review/model.js';

const rawBlock = [
  '@@ -1,2 +1,3 @@ function example()',
  ' const before = true;',
  '-const value = 1;',
  '+const value = 2;',
  '+const next = 3;',
].join('\n');

const block: ReviewBlock = {
  id: 'src/example.ts:1:0',
  filePath: 'src/example.ts',
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 3,
  lineStart: 1,
  lineEnd: 3,
  functionHeader: 'function example()',
  rawDiff: rawBlock,
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
    rawBlock,
  ].join('\n'),
  renderedLines: [],
  blocks: [block],
};

describe('copy payload builders', () => {
  it('builds path and content payloads', () => {
    expect(buildPathPayload(file)).toBe('src/example.ts');
    expect(buildAbsolutePathPayload('/repo/src/example.ts')).toBe('/repo/src/example.ts');
    expect(buildCodePayload(block)).toMatchInlineSnapshot(`
      "const value = 2;
      const next = 3;"
    `);
    expect(buildBlockDiffPayload(block)).toBe(rawBlock);
    expect(buildFileDiffPayload(file)).toBe(file.rawDiff);
    expect(buildFileContentsPayload('export const value = 2;\n')).toBe('export const value = 2;\n');
  });

  it('builds agent prompt payloads', () => {
    expect(buildBlockPromptPayload(file, block)).toMatchInlineSnapshot(`
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
  });
});
