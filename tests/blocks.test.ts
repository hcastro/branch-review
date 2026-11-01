import {describe, expect, it} from 'vitest';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import {buildBlockDiffPayload, buildBlockPromptPayload, buildCodePayload} from '../src/clipboard/payloads.js';

describe('parseUnifiedDiffBlocks', () => {
  it('keeps added lines that start with ++ in the block code', () => {
    const rawDiff = [
      'diff --git a/loop.c b/loop.c',
      '--- a/loop.c',
      '+++ b/loop.c',
      '@@ -1 +1,3 @@',
      ' int i = 0;',
      '+++i;',
      '+++ not a header',
      '',
    ].join('\n');

    const [block] = parseUnifiedDiffBlocks(rawDiff, 'loop.c');
    expect(block?.addedCode).toBe('++i;\n++ not a header');
  });

  it('slices each block exactly, keeping line terminators', () => {
    const rawDiff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n \n@@ -9 +9 @@\n-c\n+d\n';
    const blocks = parseUnifiedDiffBlocks(rawDiff, 'x');

    expect(blocks.map((block) => block.rawDiff)).toEqual(['@@ -1,2 +1,2 @@\n-a\n+b\n \n', '@@ -9 +9 @@\n-c\n+d\n']);
  });

  it('keeps a hunk whose function context holds a lone carriage return, and its copy payloads', () => {
    // git ends a line only at `\n`, so a `\r` inside a line can land in the
    // function context it prints after a hunk's `@@`.
    const hunk = '@@ -1,3 +1,3 @@ Title\rstill the title\n Title\rstill the title\n-old line\n+new line\n context\n';
    const rawDiff = `diff --git a/notes.md b/notes.md\nindex 1111111..2222222 100644\n--- a/notes.md\n+++ b/notes.md\n${hunk}`;

    const blocks = parseUnifiedDiffBlocks(rawDiff, 'notes.md');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, functionHeader: 'Title\rstill the title', addedCode: 'new line'});
    expect(buildBlockDiffPayload(blocks[0]!)).toBe(hunk);
    expect(buildCodePayload(blocks[0]!)).toBe('new line');
    expect(buildBlockPromptPayload({path: 'notes.md'}, blocks[0]!)).toBe(buildBlockPromptPayload({path: 'notes.md'}, {...blocks[0]!, functionHeader: 'Title\rstill the title'}));
  });

  it('extracts block ranges, function headers, raw diff, and added code', () => {
    const rawDiff = [
      'diff --git a/src/example.ts b/src/example.ts',
      'index 1111111..2222222 100644',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1,2 +1,3 @@ function example()',
      ' const before = true;',
      '-const value = 1;',
      '+const value = 2;',
      '+const next = 3;',
      '@@ -10 +11,0 @@ function remove()',
      '-const removed = true;',
    ].join('\n');

    const blocks = parseUnifiedDiffBlocks(rawDiff, 'src/example.ts');

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      id: 'src/example.ts:1:0',
      filePath: 'src/example.ts',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      lineStart: 1,
      lineEnd: 3,
      functionHeader: 'function example()',
      addedCode: 'const value = 2;\nconst next = 3;',
    });
    expect(blocks[0]?.rawDiff).toMatchInlineSnapshot(`
      "@@ -1,2 +1,3 @@ function example()
       const before = true;
      -const value = 1;
      +const value = 2;
      +const next = 3;
      "
    `);
    expect(blocks[1]).toMatchObject({
      id: 'src/example.ts:11:1',
      oldStart: 10,
      oldLines: 1,
      newStart: 11,
      newLines: 0,
      lineStart: 11,
      lineEnd: 11,
      functionHeader: 'function remove()',
      addedCode: '',
    });
  });
});
