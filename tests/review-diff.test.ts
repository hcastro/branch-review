import {describe, expect, it} from 'vitest';
import {drawHunk, escapeText, markRange, pairedRanges, parseHunks, wordRange} from '../src/rendered/review/diff.js';
import {diffFile} from './rendered-helpers.js';

// The Review in browser page's diff model: hunks read from the review's
// blocks with their numbers on both sides, the word highlight GitHub draws
// on a changed line, and that highlight laid over syntax-colored HTML.

const BEFORE = ['import a from "a";', 'const version = "0.4.2";', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'export default a;', ''].join('\n');
const AFTER = BEFORE.replace('"0.4.2"', '"0.5.0"').replace('export default a;', 'export default a;\nexport const b = 1;');

describe('parseHunks', () => {
  it('numbers each line on the side it is on, from the hunk headers git printed', () => {
    const hunks = parseHunks(diffFile(BEFORE, AFTER, 'src/a.ts').blocks);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({oldStart: 1, newStart: 1});
    expect(hunks[0]!.lines.slice(0, 3)).toEqual([
      {t: ' ', o: 1, n: 1, text: 'import a from "a";'},
      {t: '-', o: 2, text: 'const version = "0.4.2";'},
      {t: '+', n: 2, text: 'const version = "0.5.0";'},
    ]);
    const second = hunks[1]!;
    expect(second.lines.at(-1)).toEqual({t: '+', n: 13, text: 'export const b = 1;'});
  });

  it('keeps the function context, drops the no-newline note, reads a bare empty line as context and a CRLF end as no text', () => {
    const raw = '@@ -3,3 +3,3 @@ function run() {\n context\r\n-old\n+new\n\\ No newline at end of file\n\n';
    const [hunk] = parseHunks([{rawDiff: raw}]);
    expect(hunk!.context).toBe('function run() {');
    expect(hunk!.lines).toEqual([
      {t: ' ', o: 3, n: 3, text: 'context'},
      {t: '-', o: 4, text: 'old'},
      {t: '+', n: 4, text: 'new'},
      {t: ' ', o: 5, n: 5, text: ''},
    ]);
  });

  it('starts a side with no lines in the hunk after the line its header names', () => {
    const [hunk] = parseHunks([{rawDiff: '@@ -4,0 +5,2 @@\n+one\n+two\n'}]);
    expect(hunk!.lines.map((line) => line.n)).toEqual([5, 6]);
    const [removal] = parseHunks([{rawDiff: '@@ -7,2 +6,0 @@\n-one\n-two\n'}]);
    expect(removal!.lines.map((line) => line.o)).toEqual([7, 8]);
  });

  it('skips a block whose header is not a hunk header', () => {
    expect(parseHunks([{rawDiff: 'Binary files a and b differ\n'}])).toEqual([]);
  });
});

describe('word highlights', () => {
  it('marks where a changed line differs, widened to whole words', () => {
    expect(wordRange('.version("0.4.2");', '.version("0.5.0");')).toEqual([[12, 15], [12, 15]]);
    expect(wordRange('A queue.', 'A queue, with a preview.')).toEqual([[7, 7], [7, 23]]);
    // Too little in common to be the same line edited.
    expect(wordRange('alpha', 'omega')).toBeNull();
    expect(wordRange('same', 'same')).toBeNull();
  });

  it('marks nothing on a line paired with a blank one, whose real counterpart is elsewhere', () => {
    expect(wordRange('  const width = options.width ?? 640;', '')).toBeNull();
    expect(wordRange('', 'const width = options.width ?? 800;')).toBeNull();
    expect(wordRange('  return width;', '   ')).toBeNull();
    const lines = parseHunks([{rawDiff: '@@ -1,2 +1,4 @@\n x\n-  const width = options.width ?? 640;\n+\n+// The default.\n+const width = options.width ?? 800;\n'}])[0]!.lines;
    expect(pairedRanges(lines).size).toBe(0);
  });

  it('pairs each run of removed lines with the added run right after it, in order', () => {
    const lines = parseHunks([{rawDiff: '@@ -1,3 +1,3 @@\n-let a = 1;\n-let b = 2;\n+let a = 10;\n+let b = 20;\n same\n'}])[0]!.lines;
    expect([...pairedRanges(lines).keys()]).toEqual([0, 2, 1, 3]);
  });

  it('wraps the range in the word mark, closing it around each syntax span it crosses', () => {
    const html = '<span class="pl-k">const</span> v = <span class="pl-s">&quot;0.5&quot;</span>;';
    expect(markRange(html, 10, 15)).toBe('<span class="pl-k">const</span> v = <span class="pl-s"><span class="x">&quot;0.5&quot;</span></span>;');
    expect(markRange(escapeText('a < b'), 2, 3)).toBe('a <span class="x">&lt;</span> b');
    expect(markRange('abc', 1, 1)).toBe('abc');
  });

  it('draws a hunk from highlighted sides by line number, and escapes a line it has no HTML for', () => {
    const [hunk] = parseHunks([{rawDiff: '@@ -1,2 +1,2 @@\n <b>\n-x = 1\n+x = 2\n'}]);
    const drawn = drawHunk(hunk!, {new: (line) => (line === 2 ? '<span class="pl-v">x</span> = 2' : undefined)});
    expect(drawn.lines).toEqual([
      {t: ' ', o: 1, n: 1, h: '&lt;b&gt;'},
      {t: '-', o: 2, h: 'x = <span class="x">1</span>'},
      {t: '+', n: 2, h: '<span class="pl-v">x</span> = <span class="x">2</span>'},
    ]);
  });
});
