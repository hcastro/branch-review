import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {renderMarkdown, repoPathFor, type AssetAnswer, type LinkAnswer} from '../src/rendered/markdown.js';

// Each fixture renders with no change marks, and its HTML is kept next to it
// as a snapshot, so a dependency bump that moves the output shows up as a
// diff to read, never as a silent drift from GitHub.

const FIXTURES = new URL('./fixtures/rendered/', import.meta.url);
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function readFixture(name: string) {
  return fs.readFileSync(new URL(`${name}.md`, FIXTURES), 'utf8');
}

async function render(name: string, {
  embed = new Set<string>(),
  inReview = new Map<string, string>(),
}: {embed?: Set<string>; inReview?: Map<string, string>} = {}) {
  const asked: string[] = [];
  const fragment = await renderMarkdown({
    path: `docs/${name}.md`,
    source: readFixture(name),
    groups: [],
    asset: async (repoPath): Promise<AssetAnswer> => {
      asked.push(repoPath);
      return embed.has(repoPath) ? {kind: 'embed', mime: 'image/png', dataUrl: PNG, oid: `oid-${repoPath}`} : {kind: 'skipped'};
    },
    link: (repoPath): LinkAnswer => (inReview.has(repoPath) ? {kind: 'inReview', href: inReview.get(repoPath)!} : {kind: 'outside'}),
  });
  // Our block ids and source lines ride on every block; GitHub's markup is
  // what the fixtures compare, so they come off here.
  return {fragment, html: fragment.html.replace(/ data-(?:block|lines)="[^"]*"/g, ''), asked};
}

async function snapshot(name: string, html: string) {
  await expect(html).toMatchFileSnapshot(`./fixtures/rendered/${name}.html`);
}

describe('renderMarkdown fixtures', () => {
  it('renders the five alerts as GitHub does, and leaves empty, inline and nested markers as quotes', async () => {
    const {html} = await render('alerts');
    for (const type of ['note', 'tip', 'important', 'warning', 'caution']) {
      expect(html).toContain(`<div class="markdown-alert markdown-alert-${type}">`);
    }
    expect(html).toContain('<p class="markdown-alert-title"><svg class="octicon octicon-info mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true">');
    expect(html).toContain('<svg class="octicon octicon-light-bulb mr-2"');
    expect(html).toContain('Important</p>');
    expect(html).toContain('<p>The second one.</p>');
    expect(html.match(/markdown-alert-title/g)).toHaveLength(5);
    expect(html).toContain('<blockquote>\n<p>[!NOTE]</p>\n</blockquote>');
    expect(html).toContain('[!NOTE] in the middle.');
    expect(html).toContain('Nested in a list, so a plain quote.');
    await snapshot('alerts', html);
  });

  it('renders task lists with disabled checkboxes', async () => {
    const {html} = await render('tasks');
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain('<li class="task-list-item"><input type="checkbox" checked disabled class="task-list-item-checkbox"> Render offline</li>');
    expect(html).toContain('<input type="checkbox" disabled class="task-list-item-checkbox"> Nested task');
    await snapshot('tasks', html);
  });

  it('prefixes footnote ids with user-content- once, and points the links at them', async () => {
    const {html, fragment} = await render('footnotes');
    expect(html).not.toContain('user-content-user-content');
    expect(html).toContain('href="#user-content-fn-parity" id="user-content-fnref-parity"');
    expect(html).toContain('<li id="user-content-fn-parity">');
    expect(html).toContain('href="#user-content-fnref-parity"');
    expect(fragment.links.every((link) => link.status === 'ok')).toBe(true);
    await snapshot('footnotes', html);
  });

  it('renders tables with their column alignment and escaped pipes', async () => {
    const {html} = await render('tables');
    expect(html).toContain('<th align="left">Surface</th>');
    expect(html).toContain('<th align="center">Opens</th>');
    expect(html).toContain('<td align="right">3</td>');
    expect(html).toContain('a new tab | always');
    await snapshot('tables', html);
  });

  it('gives duplicate headings GitHub slugs, with anchors, and resolves in-page links to them', async () => {
    const {html, fragment} = await render('headings');
    expect(fragment.headings.map((heading) => heading.id)).toEqual(['setup', 'setup-1', 'setup-2', 'code-and-emphasis-in-a-heading-rocket', 'ünïcödé--symbols']);
    expect(html).toContain('<div class="markdown-heading"><h1 tabindex="-1" class="heading-element">Setup</h1><a id="user-content-setup" class="anchor" aria-label="Permalink: Setup" href="#user-content-setup"><svg class="octicon octicon-link"');
    expect(html).toContain('id="user-content-setup-1"');
    expect(html).toContain('<a href="#user-content-setup-1">the second setup</a>');
    expect(html).toContain('<a href="#user-content-setup">the top</a>');
    // An anchor with no heading stays as written and is reported.
    expect(html).toContain('<a href="#nowhere">nowhere</a>');
    expect(fragment.links).toContainEqual({href: '#nowhere', status: 'badAnchor', line: 9});
    // Emoji shortcodes become the character, outside code only.
    expect(html).toContain('heading 🚀</h2>');
    await snapshot('headings', html);
  });

  it('renders YAML frontmatter as a table, nested values as nested tables', async () => {
    const {html} = await render('frontmatter');
    expect(html).toMatch(/^<table><thead><tr><th>title<\/th><th>tags<\/th><th>owner<\/th><\/tr><\/thead><tbody><tr><td><div>Rendered view<\/div><\/td><td><table><tbody><tr><td><div>docs<\/div><\/td><td><div>review<\/div><\/td><\/tr><\/tbody><\/table><\/td><td><table><thead><tr><th>name<\/th><th>team<\/th><\/tr><\/thead>/);
    expect(html).toContain('Body after frontmatter</h1>');
    await snapshot('frontmatter', html);
  });

  it('keeps the raw HTML GitHub allows: alignment, details, kbd, sub, sup and named anchors', async () => {
    const {html} = await render('raw-html');
    expect(html).toContain('<div align="center">');
    expect(html).toContain('<details>\n<summary>More</summary>');
    expect(html).toContain('<p>Hidden <strong>markdown</strong> inside.</p>');
    expect(html).toContain('<kbd>Ctrl</kbd>+<kbd>C</kbd>');
    expect(html).toContain('H<sub>2</sub>O and x<sup>2</sup>');
    expect(html).toContain('<a name="user-content-custom-anchor"></a>');
    expect(html).toContain('<a href="#user-content-custom-anchor">the custom anchor</a>');
    await snapshot('raw-html', html);
  });

  it('inlines a picture\'s local sources, drops remote ones, and keeps the theme-only image markers', async () => {
    const embed = new Set(['docs/logo-dark.png', 'docs/logo-light.png', 'docs/diagram-dark.png', 'docs/diagram-light.png']);
    const {html, fragment, asked} = await render('picture', {embed});
    expect(asked.sort()).toEqual([...embed].sort());
    expect(html).toContain(`<source media="(prefers-color-scheme: dark)" srcset="${PNG}">`);
    expect(html).not.toContain('example.com');
    expect(html).toContain(`<img alt="Logo" src="${PNG}" width="120">`);
    expect(html).toContain(`<img src="${PNG}" alt="Dark only" data-gh-theme="dark">`);
    expect(html).toContain(`<img src="${PNG}" alt="Light only" data-gh-theme="light">`);
    expect(fragment.assetOids.sort()).toEqual([...embed].map((repoPath) => `oid-${repoPath}`).sort());
    await snapshot('picture', html);
  });

  it('keeps soft breaks soft in hard-wrapped prose, and hard breaks hard', async () => {
    const {html} = await render('prose');
    expect(html).toContain('<p>Most docs in a repo wrap at eighty columns, so a paragraph\nspans several lines in the file. GitHub keeps those soft\nbreaks soft: the paragraph reflows, with no line breaks.</p>');
    expect(html.match(/<br>/g)).toHaveLength(2);
    await snapshot('prose', html);
  });

  it('highlights with GitHub\'s grammars and tags what GitHub draws as a picture', async () => {
    const {html, fragment} = await render('code');
    expect(html).toContain('<div class="highlight highlight-source-js"><pre><span class="pl-k">const</span> <span class="pl-c1">answer</span> <span class="pl-k">=</span> <span class="pl-c1">42</span>;\n</pre></div>');
    expect(html).toContain('<div class="br-drawn"><span class="br-tag">diagram · GitHub draws this</span><pre><code>graph LR');
    expect(html).toContain('<span class="br-tag">math · GitHub typesets this</span>');
    expect(html).toContain('<pre><code class="language-made-up-language">plain text, no colors\n</code></pre>');
    expect(html).toContain('<pre><code>indented code\n</code></pre>');
    expect(fragment.differences).toEqual(expect.arrayContaining([{kind: 'mermaid', count: 1}, {kind: 'math', count: 2}]));
    await snapshot('code', html);
  });

  it('never points the page at a remote image, and puts a card where an image can\'t be inlined', async () => {
    const {html, fragment, asked} = await render('images');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('<span class="br-card br-remote" role="img" aria-label="build passing · img.shields.io · not loaded (offline)">build passing · img.shields.io · not loaded (offline)</span>');
    expect(html).toContain('The trip · docs/flow.svg · not embedded');
    expect(html).toContain("won't render on GitHub: outside the repo · ../../outside.png");
    // The outside path is refused before any lookup.
    expect(asked).toEqual(['docs/flow.svg']);
    expect(fragment.differences).toEqual(expect.arrayContaining([{kind: 'remoteImage', count: 2}, {kind: 'localImage', count: 1}]));
    await snapshot('images', html);
  });
});

describe('lookups by name', () => {
  async function renderSource(source: string) {
    return renderMarkdown({path: 'README.md', source, groups: [], asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
  }

  it('treats a fence language or emoji shortcode named after an object key as plain text', async () => {
    const fragment = await renderSource('```constructor\nx\n```\n\n```__proto__\ny\n```\n\nkeep :constructor: and :toString: and :\\_\\_proto\\_\\_: but :tada:\n');
    expect(fragment.html).toMatch(/<pre [^>]*><code class="language-constructor">x\n<\/code><\/pre>/);
    expect(fragment.html).toMatch(/<pre [^>]*><code class="language-__proto__">y\n<\/code><\/pre>/);
    expect(fragment.html).toMatch(/<p [^>]*>keep :constructor: and :toString: and :__proto__: but 🎉<\/p>/);
    expect(fragment.differences).toEqual([]);
  });

  it('shows one card per theme for a light and dark image pair, and counts the pair once', async () => {
    const fragment = await renderSource([
      '![Logo](https://example.com/dark.png#gh-dark-mode-only)![Logo](https://example.com/light.png#gh-light-mode-only)',
      '',
      '![Chart](./chart-dark.png#gh-dark-mode-only)![Chart](./chart-light.png#gh-light-mode-only)',
      '',
      '![Badge](https://img.shields.io/x.svg)',
      '',
    ].join('\n'));
    expect(fragment.html).toMatch(/<span class="br-card br-remote" [^>]*data-gh-theme="dark">Logo · example\.com/);
    expect(fragment.html).toMatch(/<span class="br-card br-remote" [^>]*data-gh-theme="light">Logo · example\.com/);
    expect(fragment.html).toMatch(/<span class="br-card br-skipped" [^>]*data-gh-theme="dark">Chart · chart-dark\.png/);
    expect(fragment.html).toMatch(/<span class="br-card br-remote" role="img" aria-label="[^"]*">Badge/);
    expect(fragment.differences).toEqual([{kind: 'remoteImage', count: 2}, {kind: 'localImage', count: 1}]);
  });
});

describe('block ids', () => {
  it('puts a stable id and the source lines on every top-level block, list item and table row', async () => {
    const source = '# Title\n\nSame text.\n\n- item\n\n| a |\n| - |\n| 1 |\n\nSame text.\n';
    const first = await renderMarkdown({path: 'a.md', source, groups: [], asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    expect(first.blocks.map((block) => [block.kind, block.lines])).toEqual([
      ['h1', [1, 1]], ['p', [3, 3]], ['ul', [5, 5]], ['li', [5, 5]], ['table', [7, 9]], ['tr', [7, 7]], ['tr', [9, 9]], ['p', [11, 11]],
    ]);
    const ids = first.blocks.map((block) => block.id);
    expect(ids.every((id) => /^b-[0-9a-f]{8}-\d+$/.test(id))).toBe(true);
    // The same text twice gets the same hash and the next occurrence.
    expect(ids[1]!.replace(/-0$/, '')).toBe(ids[7]!.replace(/-1$/, ''));
    expect(first.html).toContain(`<p data-block="${ids[1]}" data-lines="3-3">Same text.</p>`);

    // An edit above leaves the ids of unchanged blocks as they were.
    const edited = await renderMarkdown({path: 'a.md', source: `Intro.\n\n${source}`, groups: [], asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    expect(edited.blocks.slice(1).map((block) => block.id)).toEqual(ids);
  });
});

describe('links', () => {
  it('points a link to another rendered file at its page, keeping the heading anchor', async () => {
    const fragment = await renderMarkdown({
      path: 'docs/guide.md',
      source: 'See [setup](./setup.md#tokens), [the code](../src/index.ts) and [the site](https://example.com).\n',
      groups: [],
      asset: async () => ({kind: 'skipped'}),
      link: (repoPath, hash) => (repoPath === 'docs/setup.md' ? {kind: 'inReview', href: 'abc123.html'} : {kind: 'outside'}),
    });
    expect(fragment.html).toContain('<a href="abc123.html#user-content-tokens">setup</a>');
    expect(fragment.html).toContain('<a class="br-inert" title="not part of this review">the code</a>');
    expect(fragment.html).toContain('<a href="https://example.com" rel="nofollow noopener noreferrer">the site</a>');
    expect(fragment.differences).toContainEqual({kind: 'outsideLink', count: 1});
  });

  it('resolves repo paths from the file\'s folder, and refuses paths that climb out of the repo', () => {
    expect(repoPathFor('docs/guide.md', './img/a.png')).toBe('docs/img/a.png');
    expect(repoPathFor('docs/guide.md', '../README.md#top')).toBe('README.md');
    expect(repoPathFor('docs/guide.md', '/assets/logo%20big.png?raw=true')).toBe('assets/logo big.png');
    expect(repoPathFor('README.md', '../outside.md')).toBeNull();
    expect(repoPathFor('docs/guide.md', '../')).toBeNull();
  });
});
