import {afterEach, describe, expect, it} from 'vitest';
import {anchorLine, blockForSourceLine, sourceLineAt} from '../src/rendered/anchor.js';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown} from '../src/rendered/markdown.js';
import {cleanupTempDirs} from './core-helpers.js';
import {diffFile} from './rendered-helpers.js';

// Place-keeping: the line the diff shows at the top of the pane, found in
// the source, then the rendered block that holds it, so the page opens on
// the text that was under the reader's eyes.

afterEach(cleanupTempDirs);

const BEFORE = ['# Title', '', 'First paragraph.', '', 'Old second paragraph.', '', '- one', '- two', '', 'Tail.', ''].join('\n');
const AFTER = ['# Title', '', 'First paragraph.', '', 'New second paragraph,', 'over two lines.', '', '- one', '- two', '- three', '', 'Tail.', ''].join('\n');

describe('sourceLineAt', () => {
  it('names the after-side line of each body line of a hunk, and of a removed one the line that follows it', () => {
    const rawDiff = ['@@ -3,4 +3,5 @@', ' First paragraph.', ' ', '-Old second paragraph.', '+New second paragraph,', '+over two lines.', ' ', ' - one'].join('\n');
    const lines = [0, 1, 2, 3, 4, 5, 6].map((ordinal) => sourceLineAt(rawDiff, ordinal, 'after'));
    // The removed line sits where the text that replaced it starts.
    expect(lines).toEqual([3, 4, 5, 5, 6, 7, 8]);
    expect(sourceLineAt(rawDiff, 7, 'after')).toBeNull();
    expect(sourceLineAt(rawDiff, -1, 'after')).toBeNull();
    expect(sourceLineAt('not a hunk', 0, 'after')).toBeNull();
  });

  it('skips git\'s no-newline note, which is no line of the file', () => {
    const rawDiff = ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n');
    // delta draws no row for the note, so the ordinals count only real lines.
    expect(sourceLineAt(rawDiff, 0, 'after')).toBe(1);
    expect(sourceLineAt(rawDiff, 1, 'after')).toBe(1);
    expect(sourceLineAt(rawDiff, 2, 'after')).toBeNull();
  });

  it('counts a deleted file on its base side, which is what its page shows', () => {
    const file = diffFile('# Gone\n\nText.\n', null);
    const block = file.blocks[0]!;
    expect([0, 1, 2].map((ordinal) => sourceLineAt(block.rawDiff, ordinal, 'base'))).toEqual([1, 2, 3]);
    // On the after side a deleted file has no lines at all; each removal sits at line 1.
    expect(sourceLineAt(block.rawDiff, 2, 'after')).toBe(1);
  });

  it('names a removal at the end of a file by the line after the last one', () => {
    const file = diffFile('a\n\nb\n\nc\n', 'a\n\nb\n');
    const block = file.blocks[0]!;
    const ordinals = block.rawDiff.split('\n').slice(1).filter((line) => /^[ +-]/.test(line)).length;
    expect(sourceLineAt(block.rawDiff, ordinals - 1, 'after')).toBe(4);
  });
});

describe('anchorLine', () => {
  it('uses the base side for a deleted file and the after side for every other', () => {
    const deleted = diffFile('one\ntwo\n', null);
    expect(anchorLine(deleted, deleted.blocks[0]!, 1)).toBe(2);
    const modified = diffFile(BEFORE, AFTER);
    const block = modified.blocks[0]!;
    expect(anchorLine(modified, block, 0)).toBe(sourceLineAt(block.rawDiff, 0, 'after'));
  });
});

describe('blockForSourceLine', () => {
  const blocks = [{lines: [1, 1]}, {lines: [3, 3]}, {lines: [5, 6]}, {lines: [8, 8]}, {lines: [9, 9]}, {lines: [12, 12]}] as const;

  it('finds the block that holds the line', () => {
    expect(blockForSourceLine(blocks, 1)).toBe(0);
    expect(blockForSourceLine(blocks, 6)).toBe(2);
    expect(blockForSourceLine(blocks, 9)).toBe(4);
  });

  it('takes the next block for a line between blocks, and the last one past them all', () => {
    expect(blockForSourceLine(blocks, 2)).toBe(1);
    expect(blockForSourceLine(blocks, 7)).toBe(3);
    expect(blockForSourceLine(blocks, 40)).toBe(5);
    expect(blockForSourceLine([], 3)).toBe(-1);
  });

  it('prefers the innermost block when they nest, such as an item in a quote', () => {
    expect(blockForSourceLine([{lines: [1, 6]}, {lines: [2, 3]}, {lines: [4, 6]}], 5)).toBe(2);
  });

  it('goes round trip from every line of a diff to the rendered block that shows it', async () => {
    const file = diffFile(BEFORE, AFTER);
    const fragment = await renderMarkdown({path: 'doc.md', source: AFTER, groups: changeGroups(file), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const block = file.blocks[0]!;
    const body = block.rawDiff.split('\n').slice(1).filter((line) => /^[ +-]/.test(line));
    const afterLines = AFTER.split('\n');
    for (const [ordinal, line] of body.entries()) {
      const at = sourceLineAt(block.rawDiff, ordinal, 'after')!;
      const found = fragment.blocks[blockForSourceLine(fragment.blocks, at)]!;
      if (line.startsWith('-')) continue;
      // The text the diff printed is the source line the anchor names.
      expect(afterLines[at - 1]).toBe(line.slice(1));
      if (line.slice(1).trim() === '') continue;
      // And the block found holds that line.
      expect(found.lines[0] <= at && at <= found.lines[1], `${line} at ${at}`).toBe(true);
    }
    // The changed paragraph's lines land on its one block, which is marked.
    const paragraph = fragment.blocks[blockForSourceLine(fragment.blocks, 6)]!;
    expect(paragraph).toMatchObject({kind: 'p', lines: [5, 6], mark: 'modified'});
  });
});
