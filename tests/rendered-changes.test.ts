import {afterEach, describe, expect, it} from 'vitest';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown, type RenderInput} from '../src/rendered/markdown.js';
import {cleanupTempDirs} from './core-helpers.js';
import {diffFile} from './rendered-helpers.js';

afterEach(cleanupTempDirs);

const lookups: Pick<RenderInput, 'asset' | 'link'> = {
  asset: async () => ({kind: 'skipped'}),
  link: () => ({kind: 'outside'}),
};

// What the page marks for `before` -> `after`: each marked block as its tag,
// mark and text, and each removed marker as its label.
async function marksFor(before: string, after: string) {
  const file = diffFile(before, after);
  const fragment = await renderMarkdown({path: 'doc.md', source: after, groups: changeGroups(file), ...lookups});
  const doc = new DOMParserLite(fragment.html);
  return {
    marked: doc.marked(),
    removed: doc.removed(),
    blocks: fragment.blocks,
    html: fragment.html,
    fragment,
  };
}

// The text inside each `before` view, in page order, tags stripped.
function beforeViews(html: string) {
  return [...html.matchAll(/<details class="br-before"><summary>before<\/summary><div class="br-before-body">([\s\S]*?)<\/div><\/details>/g)]
    .map((match) => stripTags(match[1]!).trim());
}

// Just enough HTML reading for these assertions, with no DOM dependency: the
// fragment is our own serializer's output, so attributes are always quoted.
class DOMParserLite {
  constructor(private readonly html: string) {}

  marked() {
    const found: Array<{tag: string; mark: string; text: string}> = [];
    const pattern = /<(\w+)([^>]*?) data-mark="(added|modified)"[^>]*>/g;
    for (const match of this.html.matchAll(pattern)) {
      const rest = this.html.slice(match.index! + match[0].length);
      // The block's first run of text: up to the end of its first cell,
      // paragraph or item, or the start of a nested list or chip.
      const first = rest.split(/<\/(?:p|td|th|li|h[1-6])>|<(?:ul|ol|details)\b/)[0]!;
      found.push({tag: match[1]!, mark: match[3]!, text: stripTags(first).trim().split('\n')[0]!.slice(0, 40)});
    }
    return found;
  }

  removed() {
    return [...this.html.matchAll(/<summary[^>]*>([^<]*removed[^<]*)<\/summary>/g)].map((match) => match[1]!.trim());
  }
}

function stripTags(html: string) {
  return html.replace(/<[^>]+>/g, '');
}

// The HTML inside each `before` view and each removed marker, in page order.
function beforeBodies(html: string) {
  return [...html.matchAll(/<div class="br-before-body">([\s\S]*?)<\/div><\/details>/g)].map((match) => match[1]!);
}

function removedBodies(html: string) {
  return [...html.matchAll(/<div class="br-removed-body">([\s\S]*?)<\/div><\/details>/g)].map((match) => match[1]!);
}

describe('changeGroups', () => {
  it('reads an added run, a modified run and a removed run from the hunks', () => {
    const file = diffFile('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n', 'one\nTWO\nthree\nfour\nfive\nsix\nseven\nextra\neight\nnine\n');
    expect(changeGroups(file)).toEqual([
      {id: 'g0', kind: 'modified', after: [2, 2], base: [2, 2], anchorLine: 2, removedLines: ['two']},
      {id: 'g1', kind: 'added', after: [8, 8], base: null, anchorLine: 8, removedLines: []},
      {id: 'g2', kind: 'removed', after: null, base: [10, 10], anchorLine: 11, removedLines: ['ten']},
    ]);
  });

  it('anchors a pure deletion at the start to line 1', () => {
    const file = diffFile('gone\n\nkept\n', 'kept\n');
    expect(changeGroups(file)).toEqual([
      {id: 'g0', kind: 'removed', after: null, base: [1, 2], anchorLine: 1, removedLines: ['gone', '']},
    ]);
  });

  it('returns no groups for new and deleted files, which get a banner instead of bars', () => {
    expect(changeGroups(diffFile(null, '# New\n'))).toEqual([]);
    expect(changeGroups(diffFile('# Old\n', null))).toEqual([]);
    expect(changeGroups({...diffFile(null, '# New\n'), status: 'untracked'})).toEqual([]);
  });
});

describe('change marks on the page', () => {
  it('counts lines as git does when a lone carriage return sits in the file', async () => {
    // The parser would end a line at the carriage return; git ends one only
    // at a newline, and the marks follow git's numbering.
    const before = 'Intro\rsecond half.\n\nA one.\n\nB two.\n\nC three.\n\nD four.\n\nE five.\n\nF six.\n';
    const {marked, blocks, fragment} = await marksFor(before, before.replace('E five.', 'E five changed.'));
    expect(marked).toEqual([{tag: 'p', mark: 'modified', text: 'E five changed.'}]);
    expect(fragment.changes).toEqual({changed: 1, removed: 0});
    expect(blocks.map((block) => block.lines)).toEqual([[1, 1], [3, 3], [5, 5], [7, 7], [9, 9], [11, 11], [13, 13]]);
    // Each block's id comes from its own text, not from an empty slice.
    expect(new Set(blocks.map((block) => block.id.split('-')[1])).size).toBe(7);
  });

  it('marks an added paragraph as added and leaves its neighbors unmarked', async () => {
    const {marked, removed} = await marksFor('# Title\n\nFirst.\n\nLast.\n', '# Title\n\nFirst.\n\nAdded here.\n\nLast.\n');
    expect(marked).toEqual([{tag: 'p', mark: 'added', text: 'Added here.'}]);
    expect(removed).toEqual([]);
  });

  it('marks a changed paragraph as modified, with a before chip', async () => {
    const before = '# Title\n\nPress `o` to open the page.\n\nTail.\n';
    const after = '# Title\n\nPress `r` to open the page.\n\nTail.\n';
    const file = diffFile(before, after);
    const fragment = await renderMarkdown({path: 'doc.md', source: after, groups: changeGroups(file), ...lookups});
    const {marked} = await marksFor(before, after);
    expect(marked).toEqual([{tag: 'p', mark: 'modified', text: 'Press r to open the page.'}]);
    expect(fragment.html).toMatch(/<details class="br-before"><summary>before<\/summary><div class="br-before-body"><p>Press <code>o<\/code> to open the page.<\/p><\/div><\/details>/);
  });

  it('marks a rewrapped paragraph as one modified block, never as added', async () => {
    const before = 'Intro.\n\nThe quick brown fox jumps over\nthe lazy dog and keeps running.\n\nOutro.\n';
    const after = 'Intro.\n\nThe quick brown fox\njumps over the lazy dog and\nkeeps running.\n\nOutro.\n';
    const {marked} = await marksFor(before, after);
    expect(marked).toEqual([{tag: 'p', mark: 'modified', text: 'The quick brown fox'}]);
  });

  it('places a removed paragraph marker at the start, in the middle and at the end', async () => {
    expect((await marksFor('Gone first.\n\nKept.\n\nAlso kept.\n', 'Kept.\n\nAlso kept.\n')).removed).toEqual(['− 1 paragraph removed · show']);
    const middle = await marksFor('A.\n\nGone.\n\nB.\n', 'A.\n\nB.\n');
    expect(middle.marked).toEqual([]);
    expect(middle.removed).toEqual(['− 1 paragraph removed · show']);
    const end = await marksFor('A.\n\nB.\n\nGone last.\n', 'A.\n\nB.\n');
    expect(end.removed).toEqual(['− 1 paragraph removed · show']);
  });

  it('puts the removed marker where the content was, in document order', async () => {
    const file = diffFile('A.\n\nGone.\n\nB.\n', 'A.\n\nB.\n');
    const fragment = await renderMarkdown({path: 'doc.md', source: 'A.\n\nB.\n', groups: changeGroups(file), ...lookups});
    const a = fragment.html.indexOf('>A.</p>');
    const marker = fragment.html.indexOf('br-removed');
    const b = fragment.html.indexOf('>B.</p>');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a < marker && marker < b).toBe(true);
    // The removed text is there, dimmed, behind the summary.
    expect(fragment.html).toMatch(/<details class="br-removed">.*<p>Gone\.<\/p>/s);
  });

  it('marks the table row that changed, and an added row as added', async () => {
    const before = '| Surface | Opens |\n| --- | --- |\n| cmux | a browser split |\n| browser | a new tab |\n';
    const after = '| Surface | Opens |\n| --- | --- |\n| cmux | a browser split, reused |\n| browser | a new tab |\n| SSH | a toast |\n';
    const {marked} = await marksFor(before, after);
    expect(marked).toEqual([
      {tag: 'tr', mark: 'modified', text: 'cmux'},
      {tag: 'tr', mark: 'added', text: 'SSH'},
    ]);
  });

  it('marks a removed table row inside the table', async () => {
    const {removed, marked} = await marksFor('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n', '| a | b |\n| - | - |\n| 1 | 2 |\n| 5 | 6 |\n');
    expect(marked).toEqual([]);
    expect(removed).toEqual(['− 1 table row removed · show']);
  });

  it('marks list items, not the whole list, and the nested item that changed', async () => {
    const before = '- one\n- two\n  - nested\n- three\n';
    const after = '- one\n- two\n  - nested, edited\n- three\n- four\n';
    const {marked} = await marksFor(before, after);
    expect(marked).toEqual([
      {tag: 'li', mark: 'modified', text: 'nested, edited'},
      {tag: 'li', mark: 'added', text: 'four'},
    ]);
  });

  it('marks a removed list item between its neighbors', async () => {
    const {removed, marked} = await marksFor('- one\n- two\n- three\n', '- one\n- three\n');
    expect(marked).toEqual([]);
    expect(removed).toEqual(['− 1 list item removed · show']);
  });

  it('marks a block that lost a line in its middle as modified, with no separate marker', async () => {
    const {removed, marked} = await marksFor('Line one\nline two\nline three\n', 'Line one\nline three\n');
    expect(marked).toEqual([{tag: 'p', mark: 'modified', text: 'Line one'}]);
    expect(removed).toEqual([]);
  });

  it('shows no marker when only blank lines were removed', async () => {
    const {removed, marked} = await marksFor('A.\n\n\n\nB.\n', 'A.\n\nB.\n');
    expect(removed).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('never marks a block the diff did not touch', async () => {
    const before = '# One\n\nPara a.\n\n## Two\n\nPara b.\n\n```js\nconst x = 1;\n```\n\n## Three\n\nPara c.\n';
    const after = before.replace('Para b.', 'Para b, edited.');
    const {marked, blocks} = await marksFor(before, after);
    expect(marked).toEqual([{tag: 'p', mark: 'modified', text: 'Para b, edited.'}]);
    expect(blocks.filter((block) => block.mark).map((block) => block.lines)).toEqual([[7, 7]]);
  });

  it('marks no block when a tight list only turned loose', async () => {
    const {marked, removed} = await marksFor('# T\n\n- a\n- b\n- c\n', '# T\n\n- a\n\n- b\n- c\n');
    expect(marked).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('marks a list item that gained a paragraph as modified, not the list as added', async () => {
    const {marked, html} = await marksFor('- one\n\n- two\n', '- one\n\n  more\n\n- two\n');
    expect(marked).toEqual([{tag: 'li', mark: 'modified', text: 'one'}]);
    expect(html).not.toMatch(/<ul[^>]*data-mark/);
    expect(beforeViews(html)).toEqual(['one']);
  });

  it('marks a paragraph that gained a line as modified, with the whole old paragraph as its before view', async () => {
    const {marked, html} = await marksFor('Line one\nline two\n', 'Line one\nline two\nline three\n');
    expect(marked).toEqual([{tag: 'p', mark: 'modified', text: 'Line one'}]);
    expect(beforeViews(html)).toEqual(['Line one\nline two']);
  });

  it('marks a list item that gained a line as modified', async () => {
    const {marked, html} = await marksFor('- one\n- two\n', '- one\n  continued\n- two\n');
    expect(marked).toEqual([{tag: 'li', mark: 'modified', text: 'one'}]);
    expect(beforeViews(html)).toEqual(['one']);
  });

  it('marks a code block that gained a line as modified, with the old code as its before view', async () => {
    const {marked, html} = await marksFor('Intro.\n\n```\na\nb\n```\n', 'Intro.\n\n```\na\nb\nc\n```\n');
    expect(marked).toEqual([{tag: 'pre', mark: 'modified', text: 'a'}]);
    expect(beforeViews(html)).toEqual(['a\nb']);
  });

  it('shows the whole old block in the before view when one line of it changed', async () => {
    const before = '# T\n\nFirst line of it,\nsecond line of it,\nthird line of it.\n\n```ts\nimport {a} from "a";\nconst x = a();\nexport {x};\n```\n';
    const after = '# T\n\nFirst line of it,\nsecond line, edited,\nthird line of it.\n\n```ts\nimport {a} from "a";\nconst x = a(1);\nexport {x};\n```\n';
    const {marked, html} = await marksFor(before, after);
    expect(marked.map((block) => [block.tag, block.mark])).toEqual([['p', 'modified'], ['div', 'modified']]);
    expect(beforeViews(html)).toEqual([
      'First line of it,\nsecond line of it,\nthird line of it.',
      'import {a} from "a";\nconst x = a();\nexport {x};',
    ]);
  });

  it('shows a replaced code block as code in the before view, not as prose', async () => {
    const before = 'Run it:\n\n```ts\nconst widget = createWidget();\n```\n';
    const after = 'Run it:\n\n```python\nwidget = create_widget()\n```\n';
    const {marked, html} = await marksFor(before, after);
    expect(marked).toEqual([{tag: 'div', mark: 'modified', text: 'widget = create_widget()'}]);
    expect(html).toMatch(/<div class="br-before-body"><div class="highlight highlight-source-ts"><pre>/);
    expect(beforeViews(html)).toEqual(['const widget = createWidget();']);
  });

  it('leaves a heading and paragraph that stayed unmarked when git lines them up against a removed section', async () => {
    const before = '# Assets\n\nIntro.\n\n![Hero](docs/img/hero.png)\n\n## Retired\n\n![Old diagram](docs/img/old.png)\n\nThe old diagram above is removed on the branch.\n\n## Kept\n\nPlain paragraph that stays.\n';
    const after = '# Assets\n\nIntro.\n\n![Hero](docs/img/hero.png)\n\n## Kept\n\nPlain paragraph that stays.\n\n## New assets\n\n![Flow SVG](docs/img/flow.svg)\n\n![LFS pointer](docs/img/big-lfs.png)\n';
    // Git pairs each old line with a new one around the blank lines.
    expect(diffFile(before, after).rawDiff).toContain('-## Retired\n+## Kept\n');
    const {marked, removed, html} = await marksFor(before, after);
    expect(marked).toEqual([
      {tag: 'div', mark: 'added', text: 'New assets'},
      {tag: 'p', mark: 'added', text: 'Flow SVG · docs/img/flow.svg · not embed'},
      {tag: 'p', mark: 'added', text: 'LFS pointer · docs/img/big-lfs.png · not'},
    ]);
    expect(removed).toEqual(['− 3 blocks removed · show']);
    const removedText = stripTags(/<div class="br-removed-body">([\s\S]*?)<\/div><\/details>/.exec(html)![1]!);
    expect(removedText).toContain('The old diagram above is removed on the branch.');
    expect(removedText).not.toContain('Kept');
    expect(beforeViews(html)).toEqual([]);
  });

  it('never shows a new image-only paragraph as an edit of removed text', async () => {
    const before = '# Widgets\n\n## Old section\n\nThis section is going away on the branch.\n\n## License\n\nMIT.\n';
    const after = '# Widgets\n\n![Flow](docs/img/flow.png)\n\nImages that won\'t render on GitHub:\n\n![Logo](docs/img/logo.png)\n![Draft](docs/img/draft.png)\n\n## License\n\nMIT.\n';
    const {marked, removed, html} = await marksFor(before, after);
    expect(marked.map((block) => block.mark)).toEqual(['added', 'added', 'added']);
    expect(removed).toEqual(['− 2 blocks removed · show']);
    expect(beforeViews(html)).toEqual([]);
  });

  it('marks a block added in the same hunk as an edit as added, with no before chip', async () => {
    const {marked, html} = await marksFor('Alpha.\n', 'Alpha edited.\n\nBrand new para.\n');
    expect(marked).toEqual([
      {tag: 'p', mark: 'modified', text: 'Alpha edited.'},
      {tag: 'p', mark: 'added', text: 'Brand new para.'},
    ]);
    expect(beforeViews(html)).toEqual(['Alpha.']);
  });

  it('marks new alerts after an edited paragraph as added, never with an empty before view', async () => {
    const before = '# Widget\n\nA small toolkit.\n\n## Install\n';
    const after = '# Widget\n\nA small toolkit that needs no account.\n\n> [!TIP]\n> Start here.\n\n> [!WARNING]\n> Careful.\n\n```mermaid\ngraph TD\n```\n\n## Install\n';
    const {marked, html} = await marksFor(before, after);
    expect(marked.map((block) => [block.tag, block.mark])).toEqual([['p', 'modified'], ['div', 'added'], ['div', 'added'], ['div', 'added']]);
    expect(beforeViews(html)).toEqual(['A small toolkit.']);
    expect(html).not.toContain('<div class="br-before-body"></div>');
  });

  it('pairs a rewritten run block by block, and shows what has no counterpart as removed', async () => {
    const before = 'Intro.\n\nOld first point.\n\nA paragraph about the cache.\n\nOld closing line.\n\nEnd.\n';
    const after = 'Intro.\n\n## A new heading\n\nA paragraph about the cache, edited.\n\nEnd.\n';
    const {marked, removed, html} = await marksFor(before, after);
    expect(marked).toEqual([
      {tag: 'div', mark: 'added', text: 'A new heading'},
      {tag: 'p', mark: 'modified', text: 'A paragraph about the cache, edited.'},
    ]);
    expect(beforeViews(html)).toEqual(['A paragraph about the cache.']);
    expect(removed).toEqual(['− 1 paragraph removed · show', '− 1 paragraph removed · show']);
    expect(html.indexOf('Old first point.')).toBeLessThan(html.indexOf('A new heading'));
    expect(html.indexOf('Old closing line.')).toBeGreaterThan(html.indexOf('cache, edited.'));
  });

  it('puts the before chip of a list item inside the item', async () => {
    const {marked, html} = await marksFor('- Theme\n- Two\n', '- Theming\n- Two\n');
    expect(marked).toEqual([{tag: 'li', mark: 'modified', text: 'Theming'}]);
    expect(html).toMatch(/<li data-block="[^"]+" data-lines="1-1" data-mark="modified">Theming<details class="br-before"><summary>before<\/summary><div class="br-before-body">Theme<\/div><\/details><\/li>/);
  });

  it('puts the before chip of a table row inside its last cell, with the old row under the header', async () => {
    const {html} = await marksFor('| a | b |\n| - | - |\n| 1 | 2 |\n', '| a | b |\n| - | - |\n| 1 | 3 |\n');
    expect(html).toMatch(/<td>3<details class="br-before"><summary>before<\/summary><div class="br-before-body"><table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>[\s\S]*<\/table><\/div><\/details><\/td>/);
  });

  it('shows a modified footnote\'s old text inside its item, never as a bare child of the list', async () => {
    const {marked, html} = await marksFor('Text[^1].\n\n[^1]: old note\n', 'Text[^1].\n\n[^1]: new note\n');
    expect(marked).toEqual([{tag: 'li', mark: 'modified', text: 'new note ↩'}]);
    expect(html).not.toMatch(/<\/li>\s*<details/);
    expect(html).toMatch(/<li id="user-content-fn-1"[^>]*data-mark="modified">[\s\S]*<details class="br-before">[\s\S]*<\/details>\s*<\/li>/);
    expect(beforeViews(html)).toEqual(['old note']);
  });

  it('draws a paragraph removed before a footnote definition between the paragraphs, not among the footnotes', async () => {
    const {removed, html} = await marksFor('A[^1].\n\nB removed para.\n\n[^1]: note\n', 'A[^1].\n\n[^1]: note\n');
    expect(removed).toEqual(['− 1 paragraph removed · show']);
    const marker = html.indexOf('class="br-removed"');
    expect(marker).toBeGreaterThan(html.indexOf('A<sup>'));
    expect(marker).toBeLessThan(html.indexOf('<section data-footnotes'));
    expect(html).not.toContain('br-removed-item');
  });

  it('shows no removed marker for text that rendered as nothing', async () => {
    const definition = await marksFor('See [x].\n\n[x]: https://a.example\n\nEnd.\n', 'See [x].\n\nEnd.\n');
    expect(definition.removed).toEqual([]);
    expect(definition.fragment.changes.removed).toBe(0);
    const comment = await marksFor('A.\n\n<!-- note -->\n\nB.\n', 'A.\n\nB.\n');
    expect(comment.removed).toEqual([]);
    const marker = await marksFor('A.\n\n[//]: # (comment)\n\nB.\n', 'A.\n\nB.\n');
    expect(marker.removed).toEqual([]);
    const empty = await marksFor('A.\n\n<div align="center"></div>\n\nB.\n', 'A.\n\nB.\n');
    expect(empty.removed).toEqual([]);
    // An HTML block that showed nothing before has no before view either.
    const filled = await marksFor('A.\n\n<div align="center"></div>\n\nB.\n', 'A.\n\n<div align="center">Now text</div>\n\nB.\n');
    expect(filled.marked).toEqual([{tag: 'div', mark: 'modified', text: 'Now text'}]);
    expect(filled.html).not.toContain('br-before');
  });

  it('puts a paragraph removed right before a list or a table before it, outside it', async () => {
    const list = await marksFor('Intro.\n\nGone.\n\n- a\n- b\n', 'Intro.\n\n- a\n- b\n');
    expect(list.removed).toEqual(['− 1 paragraph removed · show']);
    expect(list.html).toMatch(/<details class="br-removed">[\s\S]*<\/details>\n?<ul/);
    expect(list.html).not.toContain('br-removed-item');
    const table = await marksFor('Intro.\n\nGone.\n\n| a |\n| - |\n| 1 |\n', 'Intro.\n\n| a |\n| - |\n| 1 |\n');
    expect(table.removed).toEqual(['− 1 paragraph removed · show']);
    expect(table.html).toMatch(/<details class="br-removed">[\s\S]*<\/details>\n?<table/);
    expect(table.html).not.toContain('br-removed-row');
  });

  it('places a removal that lands on a blank line before the next block', async () => {
    const {removed, html} = await marksFor('A.\n\nGone.\n\nB.\n', 'A.\n\n\nB.\n');
    expect(removed).toEqual(['− 1 paragraph removed · show']);
    const marker = html.indexOf('class="br-removed"');
    expect(marker).toBeGreaterThan(html.indexOf('>A.</p>'));
    expect(marker).toBeLessThan(html.indexOf('>B.</p>'));
  });

  it('draws a removed list item as an item of its list', async () => {
    const {html} = await marksFor('- one\n- two\n- three\n', '- one\n- three\n');
    expect(html).toMatch(/<li class="br-removed-item"><details class="br-removed"><summary>− 1 list item removed · show<\/summary>/);
  });

  it('counts the page\'s own differences once, not again inside before and removed views', async () => {
    const {fragment} = await marksFor('Build ![ci](https://img.shields.io/x.svg) old.\n\nGone ![b](https://img.shields.io/y.svg).\n\nEnd.\n', 'Build ![ci](https://img.shields.io/x.svg) new.\n\nEnd.\n');
    expect(fragment.differences).toEqual([{kind: 'remoteImage', count: 1}]);
  });

  it('reads a paragraph edited under a new badge line as the whole old paragraph, and the badge as added', async () => {
    const before = '# Widget\n\nA small toolkit. It needs no account.\nThis paragraph is hard-wrapped\nacross lines.\n\n## Install\n';
    const after = '# Widget\n\n[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example.com)\n\nA small toolkit. It needs no account,\nand ships a theme engine.\nThis paragraph is hard-wrapped\nacross lines.\n\n## Install\n';
    const {marked, html} = await marksFor(before, after);
    expect(marked).toEqual([
      {tag: 'p', mark: 'added', text: 'build · img.shields.io · not loaded (off'},
      {tag: 'p', mark: 'modified', text: 'A small toolkit. It needs no account,'},
    ]);
    expect(beforeViews(html)).toEqual(['A small toolkit. It needs no account.\nThis paragraph is hard-wrapped\nacross lines.']);
  });

  it('marks a new code block that took over the old one\'s closing fence as added', async () => {
    const before = '## Usage\n\n```ts\nimport {createWidget} from \'widget-toolkit\';\n\nconst widget = createWidget({name: \'clock\', size: 3});\nwidget.render(document.body);\n```\n\n## Options\n';
    const after = '## Usage\n\n```ts\nimport {createWidget, type WidgetOptions} from \'widget-toolkit\';\n\nconst options: WidgetOptions = {name: \'clock\', size: 3};\nconst widget = createWidget(options);\nwidget.render(document.body); // draws once\n```\n\n```python\nfrom widget_toolkit import create_widget\n\ndef main() -> None:\n    widget = create_widget(name="clock", size=3)\n```\n\n## Options\n';
    const {marked, html} = await marksFor(before, after);
    expect(marked.map((block) => [block.mark, block.text.slice(0, 20)])).toEqual([['modified', 'import {createWidget'], ['added', 'from widget_toolkit ']]);
    expect(beforeViews(html)).toHaveLength(1);
    expect(beforeViews(html)[0]).toContain("createWidget({name: 'clock', size: 3});");
  });

  it('leaves a block unmarked when its source changed but its rendering did not', async () => {
    const steps = ['Install the tool.', 'Run the review.', 'Read the page.', 'Fix what it shows.', 'Push the branch.'];
    const numbered = (items: string[]) => `${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n`;
    const renumbered = await marksFor(numbered(steps), numbered(['A new first step.', ...steps]));
    expect(renumbered.marked).toEqual([{tag: 'li', mark: 'added', text: 'A new first step.'}]);
    expect(renumbered.fragment.changes).toEqual({changed: 1, removed: 0});
    expect(renumbered.blocks.filter((block) => block.mark).map((block) => block.lines)).toEqual([[1, 1]]);
    expect(renumbered.html).not.toContain('br-before');

    const newline = await marksFor('A.\n\nLast', 'A.\n\nLast\n');
    expect(newline.marked).toEqual([]);
    expect(newline.fragment.changes).toEqual({changed: 0, removed: 0});
    expect(newline.html).not.toContain('br-before');

    const spaces = await marksFor('A.  \n\nB. \n', 'A.\n\nB.\n');
    expect(spaces.marked).toEqual([]);
    expect(spaces.html).not.toContain('br-before');

    // A change the page shows still marks the block.
    const edited = await marksFor(numbered(steps), numbered(['Install the tool.', 'Run the review twice.', ...steps.slice(2)]));
    expect(edited.marked).toEqual([{tag: 'li', mark: 'modified', text: 'Run the review twice.'}]);
  });

  it('resolves reference links and footnote references in before views and removed markers', async () => {
    const link = await marksFor('See the [docs][d] for more.\n\n[d]: https://example.com/docs\n', 'See the [docs][d] for more detail.\n\n[d]: https://example.com/docs\n');
    expect(beforeBodies(link.html)).toEqual(['<p>See the <a href="https://example.com/docs" rel="nofollow noopener noreferrer">docs</a> for more.</p>']);

    const notes = '\n\n[^a]: First.\n[^b]: Second.\n';
    const note = await marksFor(`Intro[^a].\n\nA claim[^b] here.${notes}`, `Intro[^a].\n\nA claim[^b] right here.${notes}`);
    const [before] = beforeBodies(note.html);
    // The reference keeps the number the base page gave it, and the view
    // carries no footnotes of its own.
    expect(before).toMatch(/^<p>A claim<sup><a [^>]*data-footnote-ref[^>]*>2<\/a><\/sup> here\.<\/p>$/);

    const gone = await marksFor(`Intro[^a].\n\nGone, see [docs][d] and[^b].\n\nEnd.\n\n[d]: https://example.com/docs${notes}`, `Intro[^a].\n\nEnd.\n\n[d]: https://example.com/docs${notes}`);
    expect(gone.removed).toEqual(['− 1 paragraph removed · show']);
    const [removed] = removedBodies(gone.html);
    expect(removed).toContain('<a href="https://example.com/docs" rel="nofollow noopener noreferrer">docs</a>');
    expect(removed).toMatch(/and<sup><a [^>]*>2<\/a><\/sup>\.<\/p>$/);
    expect(removed).not.toContain('[^b]');
    expect(removed).not.toContain('data-footnotes');
  });

  it('marks a new table by its rows, never the table around them', async () => {
    const added = await marksFor('Intro.\n\nOld end.\n', 'Intro.\n\nNew end.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(added.marked).toEqual([
      {tag: 'p', mark: 'modified', text: 'New end.'},
      {tag: 'tr', mark: 'added', text: 'a'},
      {tag: 'tr', mark: 'added', text: '1'},
    ]);
    expect(added.fragment.changes).toEqual({changed: 3, removed: 0});
    expect(added.html).not.toMatch(/<table[^>]*data-mark/);
  });

  it('marks the header row when only a column\'s alignment changed', async () => {
    const {marked, html, fragment} = await marksFor('| a | b |\n| - | - |\n| 1 | 2 |\n', '| a | b |\n| :- | - |\n| 1 | 2 |\n');
    expect(marked).toEqual([{tag: 'tr', mark: 'modified', text: 'a'}]);
    expect(fragment.changes).toEqual({changed: 1, removed: 0});
    expect(html).not.toMatch(/<table[^>]*data-mark/);
    // The old header alone, under no copy of itself.
    expect(beforeBodies(html)).toEqual(['<table><thead><tr><th>a</th><th>b</th></tr></thead></table>']);
  });

  it('shows a removed table as one table, and two removed tables as two', async () => {
    const one = await marksFor('A.\n\n| a |\n| - |\n| 1 |\n| 2 |\n\nB.\n', 'A.\n\nB.\n');
    expect(one.removed).toEqual(['− 1 table removed · show']);
    expect(removedBodies(one.html)[0]!.match(/<tr>/g)).toHaveLength(3);
    const two = await marksFor('A.\n\n| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |\n\nB.\n', 'A.\n\nB.\n');
    expect(two.removed).toEqual(['− 2 tables removed · show']);
  });

  it('puts a paragraph removed after a table after the table, never inside it', async () => {
    const before = '| Command | Does |\n| - | - |\n| widget list | Lists widgets |\n\nOld paragraph about widgets.\n\nEnd.\n';
    const after = '| Command | Does |\n| - | - |\n| widget list | Lists widgets |\n| widget theme | Sets the theme |\n\nEnd.\n';
    const {marked, removed, html} = await marksFor(before, after);
    expect(marked).toEqual([{tag: 'tr', mark: 'added', text: 'widget theme'}]);
    expect(removed).toEqual(['− 1 paragraph removed · show']);
    expect(html).not.toContain('br-removed-row');
    const marker = html.indexOf('class="br-removed"');
    expect(marker).toBeGreaterThan(html.indexOf('</table>'));
    expect(marker).toBeLessThan(html.indexOf('>End.</p>'));
  });

  it('shows a table row from a table nested in a list as a row under its header, not as code', async () => {
    const table = (rows: string[]) => `- outer\n    - inner\n\n        | a | b |\n        | - | - |\n${rows.map((row) => `        ${row}`).join('\n')}\n`;
    const gone = await marksFor(table(['| 1 | 2 |', '| 3 | 4 |']), table(['| 1 | 2 |']));
    expect(gone.removed).toEqual(['− 1 table row removed · show']);
    const [removed] = removedBodies(gone.html);
    expect(removed).toMatch(/^<table>[\s\S]*<th>a<\/th>[\s\S]*<td>3<\/td>[\s\S]*<\/table>$/);
    expect(removed).not.toContain('<pre>');

    const edited = await marksFor(table(['| 1 | 2 |', '| 3 | 4 |']), table(['| 1 | 2 |', '| 3 | 5 |']));
    const [before] = beforeBodies(edited.html);
    expect(before).toMatch(/^<table>[\s\S]*<th>a<\/th>[\s\S]*<td>4<\/td>[\s\S]*<\/table>$/);
    expect(before).not.toContain('<pre>');
  });

  it('gives an embedded image its own size, so its box holds before it decodes, unless the author sized it or a picture may swap it', async () => {
    const source = '![Hero](hero.png)\n\n<img src="hero.png" width="90">\n\n<picture>\n<source srcset="hero.png">\n<img src="hero.png">\n</picture>\n';
    const embed = {kind: 'embed', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==', oid: 'abc', width: 640, height: 260} as const;
    const fragment = await renderMarkdown({path: 'doc.md', source, groups: [], asset: async () => embed, link: () => ({kind: 'outside'})});
    expect(fragment.html).toContain('<img src="data:image/png;base64,AA==" alt="Hero" width="640" height="260" data-br-size="">');
    expect(fragment.html).toMatch(/<img src="data:image\/png;base64,AA==" width="90" data-block=/);
    expect(fragment.html).toMatch(/<picture[^>]*>\s*<source srcset="data:image\/png;base64,AA==">\s*<img src="data:image\/png;base64,AA==">\s*<\/picture>/);
  });

  it('marks an added rule, a lone image and a picture on a box that can draw their bars', async () => {
    const before = '# Doc\n\nIntro.\n';
    const after = '# Doc\n\nIntro.\n\n---\n\n<img src="d.png" width="90">\n\n<picture>\n<source srcset="d.png">\n<img src="d.png">\n</picture>\n';
    const embed = {kind: 'embed', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==', oid: 'abc'} as const;
    const fragment = await renderMarkdown({path: 'doc.md', source: after, groups: changeGroups(diffFile(before, after)), asset: async () => embed, link: () => ({kind: 'outside'})});
    expect(fragment.changes).toEqual({changed: 3, removed: 0});
    // A rule draws its own bar; an image draws none, and a picture sits in the line.
    expect(fragment.html).toMatch(/<hr data-block="[^"]+" data-lines="5-5" data-mark="added">/);
    expect(fragment.html).toMatch(/<span class="br-marked" data-block="[^"]+" data-lines="7-7" data-mark="added"><img src="data:image\/png;base64,AA==" width="90"><\/span>/);
    expect(fragment.html).toMatch(/<span class="br-marked" data-block="[^"]+" data-lines="9-12" data-mark="added"><picture>/);
    expect(fragment.html).not.toMatch(/<(img|picture)[^>]*data-mark/);
  });
});
