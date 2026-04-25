import {describe, expect, it} from 'vitest';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';

describe('parseUnifiedDiffBlocks', () => {
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
      +const next = 3;"
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
