import {describe, expect, it} from 'vitest';
import {drawHunk, parseHunks, type CardDiff} from '../src/rendered/review/diff.js';
import {EXPAND_STEP, expandGap, gapsOf, tableHtml, tableRows} from '../src/rendered/review/table.js';
import {diffFile} from './rendered-helpers.js';

// The diff table both sides draw: the page as it arrives (unified), and the
// page script for split and for each click that reveals context. Gaps
// between hunks are read from the hunk numbers, and filled from the
// reviewed side's lines the page carries.

const lines = (count: number, edit: (index: number) => string | null = () => null) => Array.from({length: count}, (_, index) => edit(index) ?? `line ${index + 1}`);
const BEFORE = `${lines(40).join('\n')}\n`;
const AFTER = `${lines(40, (index) => (index === 9 ? 'line 10, edited' : index === 29 ? 'line 30, edited' : null)).join('\n')}\n`;

function card(withContext = true): CardDiff {
  const hunks = parseHunks(diffFile(BEFORE, AFTER, 'a.txt').blocks).map((hunk) => drawHunk(hunk));
  const after = AFTER.split('\n').slice(0, -1);
  return {hunks, context: withContext ? after : null, total: after.length};
}

describe('gapsOf', () => {
  it('finds the unchanged lines before, between and after the hunks, with the old side offset', () => {
    expect(gapsOf(card())).toEqual([
      {from: 1, to: 6, delta: 0, trailing: false},
      {from: 14, to: 26, delta: 0, trailing: false},
      {from: 34, to: 40, delta: 0, trailing: true},
    ]);
  });

  it('offsets the old side by what the hunks above added', () => {
    const grown = `${lines(20, (index) => (index === 2 ? 'line 3\nnew line' : null)).join('\n')}\n`;
    const hunks = parseHunks(diffFile(`${lines(20).join('\n')}\n`, grown, 'a.txt').blocks).map((hunk) => drawHunk(hunk));
    const gaps = gapsOf({hunks, context: grown.split('\n').slice(0, -1), total: 21});
    expect(gaps.at(-1)).toEqual({from: 8, to: 21, delta: -1, trailing: true});
  });

  it('has no trailing gap when the reviewed side has no known length', () => {
    const {hunks} = card();
    expect(gapsOf({hunks, context: null}).at(-1)!.trailing).toBe(false);
  });
});

describe('tableRows', () => {
  it('draws a header for each hunk, recounted from the rows under it, with git\'s context', () => {
    const rows = tableRows(card(), [0, 0, 0]);
    const headers = rows.filter((row) => row.kind === 'hunk');
    expect(headers.map((row) => row.kind === 'hunk' && row.text)).toEqual(['@@ -7,7 +7,7 @@ line 6', '@@ -27,7 +27,7 @@ line 26', '']);
    expect(headers.map((row) => row.kind === 'hunk' && row.dir)).toEqual(['up', 'up', 'down']);
  });

  it('reveals context five lines at a time next to the hunk, then the rest of a short gap at once', () => {
    const diff = card();
    let shown = [0, 0, 0];
    shown = expandGap(diff, shown, 1);
    expect(shown).toEqual([0, EXPAND_STEP, 0]);
    let rows = tableRows(diff, shown);
    // The header over the opened lines counts them in, on both sides, from where they start.
    expect(rows.find((row) => row.kind === 'hunk' && row.gap === 1)).toMatchObject({text: '@@ -22,12 +22,12 @@ line 26'});
    const revealed = rows.filter((row) => row.kind === 'line' && row.revealed).map((row) => row.kind === 'line' && row.line.n);
    expect(revealed).toEqual([22, 23, 24, 25, 26]);
    // Eight left: five, then the last three in one click, which drops the header.
    shown = expandGap(diff, shown, 1);
    expect(shown[1]).toBe(10);
    rows = tableRows(diff, shown);
    expect(rows.find((row) => row.kind === 'hunk' && row.gap === 1)).toMatchObject({dir: 'unfold', remaining: 3});
    shown = expandGap(diff, shown, 1);
    expect(shown[1]).toBe(13);
    expect(tableRows(diff, shown).some((row) => row.kind === 'hunk' && row.gap === 1)).toBe(false);
    // The trailing gap opens downward from the last hunk.
    rows = tableRows(diff, expandGap(diff, shown, 2));
    expect(rows.filter((row) => row.kind === 'line').at(-1)).toMatchObject({line: {o: 38, n: 38, h: 'line 38'}});
  });

  it('keeps a gap closed when the page carries no context, and says to open the file when the page budget ran out', () => {
    const {hunks, total} = card();
    expect(tableRows({hunks, context: null}, [0, 0, 0]).filter((row) => row.kind === 'hunk').map((row) => row.kind === 'hunk' && row.dir)).toEqual([null, null]);
    const budget = tableRows({hunks, context: null, contextNote: 'budget', total}, [0, 0, 0]);
    expect(budget.filter((row) => row.kind === 'hunk').map((row) => row.kind === 'hunk' && row.disabled)).toEqual([true, true, true]);
    expect(expandGap({hunks, context: null, contextNote: 'budget', total}, [0, 0, 0], 1)).toEqual([0, 0, 0]);
  });
});

describe('tableHtml', () => {
  it('draws unified rows with both numbers and the marker, and escapes nothing twice', () => {
    const html = tableHtml(card(), [0, 0, 0], 'unified');
    expect(html).toContain('<table class="diff uni">');
    expect(html).toContain('<tr class="del"><td class="ln" data-n="10"></td><td class="ln" data-n=""></td><td class="cd"><span class="mk">-</span>line 10</td></tr>');
    expect(html).toContain('<tr class="add"><td class="ln" data-n=""></td><td class="ln" data-n="10"></td><td class="cd"><span class="mk">+</span>line 10<span class="x">, edited</span></td></tr>');
    expect(html).toContain('aria-label="Show 5 more lines above"');
  });

  it('pairs removed and added lines side by side in split, with an empty cell where a side has none', () => {
    const hunks = parseHunks(diffFile('a\nbat\nc\n', 'a\nbot\nnew\nc\n', 'a.txt').blocks).map((hunk) => drawHunk(hunk));
    const html = tableHtml({hunks, context: ['a', 'bot', 'new', 'c'], total: 4}, [0, 0], 'split');
    expect(html).toContain('<table class="diff split">');
    expect(html).toContain('<tr><td class="ln del" data-n="2"></td><td class="cd del"><span class="mk">-</span><span class="x">bat</span></td><td class="ln add" data-n="2"></td><td class="cd add"><span class="mk">+</span><span class="x">bot</span></td></tr>');
    expect(html).toContain('<tr><td class="ln emp"></td><td class="cd emp"></td><td class="ln add" data-n="3"></td><td class="cd add"><span class="mk">+</span>new</td></tr>');
  });

  it('draws a disabled control that says to open the file', () => {
    const {hunks, total} = card();
    const html = tableHtml({hunks, context: null, contextNote: 'budget', total}, [0, 0, 0], 'unified');
    expect(html).toContain('disabled aria-label="Open the file to see more" title="Open the file to see more"');
  });
});
