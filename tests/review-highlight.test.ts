import {describe, expect, it} from 'vitest';
import type {Root} from 'hast';
import {colorable, COLORED_LINE_LIMIT, COLORED_SIDE_COST, COLORED_TEXT_LIMIT, coloringCost, highlightLines, scopeFor, splitLines} from '../src/rendered/review/highlight.js';

// Syntax colors for the Review in browser page's diffs: GitHub's grammars
// through starry-night, the whole side at once so a token that spans lines
// is colored on each of them, cut into one balanced piece of HTML a line.

const balanced = (html: string) => (html.match(/<span/g) ?? []).length === (html.match(/<\/span>/g) ?? []).length;

describe('highlightLines', () => {
  it('colors each line with GitHub\'s classes and closes every span on the line it opened', async () => {
    const lines = await highlightLines('const a = "x";\n/* one\n   two */\nlet b = 1;\n', 'src/a.ts');
    expect(lines).toHaveLength(4);
    expect(lines![0]).toContain('<span class="pl-k">const</span>');
    expect(lines![0]).toContain('<span class="pl-s">');
    // The comment spans two lines: each gets its own comment span.
    expect(lines![1]).toMatch(/^<span class="pl-c">\/\* one<\/span>$/);
    expect(lines![2]).toMatch(/^<span class="pl-c">   two \*\/<\/span>$/);
    for (const line of lines!) expect(balanced(line)).toBe(true);
  });

  it('escapes the text it colors', async () => {
    const lines = await highlightLines('if (a < b && c > "<script>") {}\n', 'x.js');
    expect(lines![0]).not.toContain('<script>');
    expect(lines![0]).toContain('&lt;script&gt;');
    expect(lines![0]).toContain('&amp;&amp;');
  });

  it('keeps an empty last line only when the text has one past its final newline', async () => {
    expect(await highlightLines('a\nb', 'x.js')).toHaveLength(2);
    expect(await highlightLines('a\nb\n', 'x.js')).toHaveLength(2);
    expect(await highlightLines('a\nb\n\n', 'x.js')).toHaveLength(3);
  });

  it('reads a grammar from the extension or a well-known name, and none for an unknown file', async () => {
    expect(await scopeFor('README.md')).toBe('text.md');
    expect(await scopeFor('docs/guide.markdown')).toBe('text.md');
    expect(await scopeFor('package.json')).toBe('source.json');
    expect(await scopeFor('Makefile')).toBe('source.makefile');
    // TSX reads as TypeScript, the nearest grammar GitHub's common set has.
    expect(await scopeFor('src/App.tsx')).toBe('source.ts');
    expect(await highlightLines('whatever\n', 'notes.unknownext')).toBeNull();
  });

  it('gives the grammar no line past 4 KB and no text past 400 KB, whose coloring would hold the worker for seconds', async () => {
    const row = '{"id":1,"name":"x","tags":["a","b"],"ok":true},';
    const line = (length: number) => `[${row.repeat(Math.ceil(length / row.length)).slice(0, length - 2)}]`;
    expect(await highlightLines(`${line(COLORED_LINE_LIMIT)}\n`, 'data.json')).toHaveLength(1);
    const started = Date.now();
    expect(await highlightLines(`{}\n${line(200 * 1024)}\n`, 'data.json')).toBeNull();
    expect(await highlightLines(`${line(COLORED_LINE_LIMIT + 1)}\n`, 'data.json')).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    const many = `${'export const value = "some text the grammar colors" + 42;\n'.repeat(Math.ceil(COLORED_TEXT_LIMIT / 58) + 1)}`;
    expect(many.length).toBeGreaterThan(COLORED_TEXT_LIMIT);
    expect(await highlightLines(many, 'src/a.ts')).toBeNull();
  });

  it('colors ordinary code up to near 400 KB a side, and still refuses a side whose cost would hold the worker past a second', async () => {
    const ts = (bytes: number, width: number) => {
      let line = 'export const v = "';
      while (line.length < width - 2) line += 'word ';
      line = `${line.slice(0, width - 2)}";\n`;
      return line.repeat(Math.floor(bytes / line.length));
    };
    // GitHub colors these, and the grammars took a third of a second on each.
    for (const text of [ts(350 * 1024, 110), ts(390 * 1024, 95), ts(398 * 1024, 118)]) {
      expect(text.length).toBeLessThanOrEqual(COLORED_TEXT_LIMIT);
      expect(colorable(text)).toBe(true);
    }
    expect(colorable(ts(400 * 1024, 125))).toBe(false);
    // Three 4,000-char comment lines: about 1.3 s at the worst rate measured.
    const comments = `const a = 1; // ${'x'.repeat(4000)}\n`.repeat(3);
    expect(coloringCost(comments)).toBeGreaterThan(COLORED_SIDE_COST);
    expect(colorable(comments)).toBe(false);
    expect(await highlightLines(comments, 'src/long.ts')).toBeNull();
  });

  it('closes a span whose own text runs over a newline at the end of its line, and opens it again on the next', () => {
    const span = (name: string, children: Root['children']) => ({type: 'element' as const, tagName: 'span', properties: {className: [name]}, children}) as Root['children'][number];
    const root: Root = {type: 'root', children: [span('pl-c', [{type: 'text', value: '/* one\n'}, span('pl-k', [{type: 'text', value: 'two\nthree'}]), {type: 'text', value: ' */'}])]};
    const lines = splitLines(root);
    expect(lines).toEqual([
      '<span class="pl-c">/* one</span>',
      '<span class="pl-c"><span class="pl-k">two</span></span>',
      '<span class="pl-c"><span class="pl-k">three</span> */</span>',
    ]);
    for (const line of lines) expect(balanced(line)).toBe(true);
  });
});

