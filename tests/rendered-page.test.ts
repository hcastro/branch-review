import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {PAGE_CSS, PAGE_CSS_HASH} from '../src/rendered/assets.generated.js';
import {assembleFilePage, contentSecurityPolicy, type PageFile, type PageInput} from '../src/rendered/page.js';
import {renderMarkdown} from '../src/rendered/markdown.js';

const VENDORED_CSS = new URL('../src/rendered/assets/github-markdown.css', import.meta.url);
const CHROME_CSS = fs.readFileSync(new URL('../src/rendered/assets/page.css', import.meta.url), 'utf8');

// The custom properties one `:root` block of page.css sets, light first.
function tokens(scheme: 'light' | 'dark') {
  const blocks = [...CHROME_CSS.matchAll(/:root \{([^}]*)\}/g)].map((match) => match[1]!);
  const block = scheme === 'light' ? blocks[0]! : blocks[1]!;
  return Object.fromEntries([...block.matchAll(/--br-([\w-]+):\s*(#[0-9a-f]{6})\b/g)].map((match) => [match[1]!, match[2]!]));
}

// WCAG 2 contrast ratio of two #rrggbb colors.
function contrast(left: string, right: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

// The rule a selector opens in page.css, as written there.
function rule(selector: string) {
  const at = CHROME_CSS.indexOf(`${selector} {`);
  return at < 0 ? '' : CHROME_CSS.slice(at, CHROME_CSS.indexOf('}', at) + 1);
}
// github-markdown-css 5.9.0's github-markdown.css, byte for byte. A bump
// changes this on purpose, with the fixture snapshots reviewed alongside.
const VENDORED_CSS_SHA256 = '6112686f954db5d3806fb96116d2ab20ad3018469ab1015c587fd8efe7d25cf4';

const FEATURES = [
  '# Title', '', '> [!NOTE]', '> A note.', '', '- [x] done', '', '| a | b |', '| :- | -: |', '| 1 | 2 |', '',
  '```js', 'const a = 1;', '```', '', '![remote](https://example.com/x.png) ![local](./x.png)', '',
  '<div align="center"><img src="x.png" width="20"></div>', '', 'Text[^1].', '', '[^1]: Note.', '',
].join('\n');

async function rendered(source = FEATURES) {
  return renderMarkdown({path: 'docs/page.md', source, groups: [], asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
}

function input(file: PageFile, overrides: Partial<PageInput> = {}): PageInput {
  return {
    title: {repo: 'branch-review-cli', base: 'main', branch: 'feature/rich-view', worktree: false, renderedAt: Date.UTC(2026, 9, 31, 12, 4)},
    file,
    rail: [
      {path: 'docs/page.md', status: 'modified', href: 'aaaa.html', label: '3', current: true},
      {path: 'docs/flow.md', status: 'added', href: 'bbbb.html', label: '+', current: false},
      {path: 'README.md', status: 'modified', href: 'cccc.html', label: '1', current: false},
    ],
    ...overrides,
  };
}

async function page(overrides: Partial<PageInput> = {}) {
  const fragment = await rendered();
  return assembleFilePage(input({path: 'docs/page.md', status: 'modified', body: {kind: 'rendered', fragment}}, overrides));
}

function sha256Base64(text: string) {
  return createHash('sha256').update(text).digest('base64');
}

describe('assembleFilePage', () => {
  it('puts the CSP first in <head>, with nothing allowed to load or run', async () => {
    const html = await page();
    expect(html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)![1];
    expect(csp).toBe(contentSecurityPolicy());
    expect(csp).toBe(`default-src 'none'; img-src data:; style-src '${PAGE_CSS_HASH}'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'`);
  });

  it('allows each inline style by its hash, and has no script', async () => {
    const html = await page();
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]!);
    expect(styles).toHaveLength(1);
    expect(`sha256-${sha256Base64(styles[0]!)}`).toBe(PAGE_CSS_HASH);
    expect(styles[0]).toBe(PAGE_CSS);
    expect(html).not.toMatch(/<script\b/i);
  });

  it('carries no style attribute anywhere, so the CSP never needs unsafe-inline', async () => {
    const html = await page();
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it('inlines the vendored GitHub stylesheet unchanged, pinned by its hash', () => {
    const vendored = fs.readFileSync(VENDORED_CSS, 'utf8');
    expect(createHash('sha256').update(vendored).digest('hex')).toBe(VENDORED_CSS_SHA256);
    expect(PAGE_CSS).toContain(vendored);
    expect(PAGE_CSS).toContain('github-markdown-css 5.9.0');
    // The one url() is GitHub's inline data: mask for the link icon.
    expect(PAGE_CSS).not.toMatch(/url\((?!"data:)|@import|@font-face/);
  });

  it('wraps the article in markdown-body, with the strip, the rail and the file head around it', async () => {
    const html = await page();
    expect(html).toContain('<title>page.md · branch-review</title>');
    expect(html).toContain('<article class="markdown-body">');
    expect(html).toMatch(/<header class="br-strip">.*branch-review.*main.*←.*feature\/rich-view/s);
    expect(html).toContain('<nav class="br-rail" aria-label="Rendered files">');
    expect(html).toContain('CHANGED · 3 rendered');
    expect(html).toContain('<a class="br-rail-file br-current" href="aaaa.html" aria-current="page">');
    expect(html).toContain('<a class="br-rail-file" href="bbbb.html">');
    expect(html).toMatch(/<span class="br-rail-dir">docs\/<\/span>.*<span class="br-rail-dir">\(root\)<\/span>/s);
    expect(html).toMatch(/<h1 class="br-path"><span class="br-dir">docs<\/span><span class="br-sep"> \/ <\/span>page\.md<\/h1>/);
  });

  it('states the fidelity: ≈ GitHub, the counted differences, and what always differs', async () => {
    const html = await page();
    expect(html).toContain('<summary>≈ GitHub · 3 differences</summary>');
    expect(html).toContain('<li>1 remote image not loaded: the page works offline</li>');
    expect(html).toContain('<li>2 local images not embedded</li>');
    expect(html).toContain('Code colors come from GitHub');

    const plain = assembleFilePage(input({path: 'a.md', status: 'modified', body: {kind: 'rendered', fragment: await rendered('Plain text.\n')}}));
    expect(plain).toContain('<summary>≈ GitHub</summary>');
  });

  it('counts what changed in the file head', async () => {
    const fragment = {...await rendered(), changes: {changed: 3, removed: 1}};
    const html = assembleFilePage(input({path: 'docs/page.md', status: 'modified', body: {kind: 'rendered', fragment}}));
    expect(html).toContain('<p class="br-summary"><span class="br-status br-status-modified">M</span> · 3 changed · 1 removed</p>');
  });

  it('shows a banner for a new, untracked, deleted or renamed file', async () => {
    const fragment = await rendered('Text.\n');
    const banner = (file: Partial<PageFile>) => assembleFilePage(input({path: 'a.md', status: 'modified', body: {kind: 'rendered', fragment}, ...file} as PageFile));
    expect(banner({status: 'added'})).toContain('<p class="br-banner br-banner-added">new file</p>');
    expect(banner({status: 'untracked'})).toContain('<p class="br-banner br-banner-untracked">untracked · not part of a push yet</p>');
    expect(banner({status: 'deleted'})).toContain('<p class="br-banner br-banner-deleted">deleted on this branch · shown from main</p>');
    expect(banner({status: 'deleted'})).toContain('<article class="markdown-body br-dimmed">');
    expect(banner({status: 'renamed', oldPath: 'docs/old.md'})).toContain('<p class="br-banner br-banner-renamed">renamed from docs/old.md</p>');
  });

  it('shows a card for an empty, oversized, non-UTF-8 or failed file, with the raw text where there is some', () => {
    const page = (body: PageFile['body']) => assembleFilePage(input({path: 'a.md', status: 'modified', body}));
    expect(page({kind: 'empty'})).toContain('<p class="br-state">this file is empty</p>');
    const large = page({kind: 'tooLarge', bytes: 2.4 * 1024 * 1024, head: '# Head <b>raw</b>'});
    expect(large).toContain('<p class="br-state">too large to render (2.4 MB)</p>');
    expect(large).toContain('<pre class="br-raw"># Head &#x3C;b>raw&#x3C;/b></pre>');
    expect(page({kind: 'notUtf8'})).toContain('<p class="br-state">not UTF-8 text</p>');
    const failed = page({kind: 'failed', reason: 'parser gave up', source: 'raw <script>'});
    expect(failed).toContain("<p class=\"br-state br-state-error\">couldn't render this file · parser gave up</p>");
    expect(failed).toContain('<pre class="br-raw">raw &#x3C;script></pre>');
  });

  it('sets a file with no rendered page in the article\'s box, and says its state in the head', () => {
    const page = (body: PageFile['body']) => assembleFilePage(input({path: 'a.md', status: 'modified', body}));
    const failed = page({kind: 'failed', reason: 'took too long to render', source: '# Raw'});
    expect(failed).toContain('<div class="br-body">\n<p class="br-state br-state-error">couldn\'t render this file · took too long to render</p>\n<pre class="br-raw"># Raw</pre>\n</div>');
    expect(failed).toContain('<p class="br-summary"><span class="br-status br-status-modified">M</span> · couldn\'t render</p>');
    expect(page({kind: 'empty'})).toContain('M</span> · empty</p>');
    expect(page({kind: 'tooLarge', bytes: 3 * 1024 * 1024, head: ''})).toContain('M</span> · too large to render</p>');
    expect(page({kind: 'notUtf8'})).toContain('M</span> · not UTF-8 text</p>');
    // The article's measure and inset, at every width; the card and raw
    // text set no width of their own.
    expect(rule('.br-body')).toBe('.br-body { max-width: 980px; margin: 0 auto; padding: 0 var(--br-article-pad); }');
    expect(rule('.br-state')).not.toContain('max-width');
    expect(rule('.br-raw')).not.toContain('max-width');
  });

  it('keeps a modified block at GitHub\'s measure, with room for its before chip under its last line', () => {
    // Room at the block's foot, never at the end of its lines, so it wraps where GitHub wraps it.
    expect(CHROME_CSS).toMatch(/\.markdown-body \[data-mark="modified"\]:has\(\+ details\.br-before\),\n\.markdown-body li > p:has\(\+ details\.br-before\) \{ padding-block-end: var\(--br-chip-room\); \}/);
    expect(CHROME_CSS).not.toContain('padding-inline-end');
    // As tall as the closed chip: its line, padding and border.
    expect(CHROME_CSS).toContain(':root { --br-chip-room: 26px; }');
    // In a list item the chip follows the item's last word, where it can only move to a line of its own.
    expect(rule('.markdown-body li > details.br-before')).toContain('display: inline-block;');
    expect(rule('.markdown-body li > details.br-before:not([open])')).toMatch(/position: static;[\s\S]*transform: none;/);
  });

  it('draws the bar of an added rule outside its clipped quarter em, and of a lone image on the box around it', () => {
    expect(rule('.markdown-body hr[data-mark]')).toContain('overflow: visible;');
    expect(rule('.markdown-body hr[data-mark]::before')).toMatch(/display: block; top: -6px; bottom: -6px;/);
    expect(rule('.markdown-body .br-marked')).toContain('display: inline-block;');
    // Beside another inline block in its line, its bar sits in the gap before it.
    expect(CHROME_CSS).toMatch(/\.markdown-body > :is\([^)]*\bimg\b[^)]*\bspan\b[^)]*\) \+ \.br-marked::before \{ left: -5px; \}/);
  });

  it('keeps an asset card\'s corners clear of its text when it wraps', () => {
    expect(rule('.markdown-body .br-card')).toContain('border-radius: 8px;');
    expect(rule('.markdown-body .br-card')).not.toContain('999px');
  });

  it('keeps the branch readable in a narrow strip, giving up the base first', async () => {
    const html = await page();
    expect(html).toMatch(/<span class="br-refs" title="[^"]*"><span class="br-base">[^<]*<\/span><span class="br-arrow">←<\/span><span class="br-branch">/);
    expect(rule('.br-refs .br-base')).toContain('flex: 0 1000 auto;');
    expect(CHROME_CSS).toContain('.br-refs .br-branch { flex: 0 1 auto; color: var(--br-fg); }');
    expect(rule('.br-refs .br-base,\n.br-refs .br-branch')).toContain('text-overflow: ellipsis;');
    // Below 480 px the brand keeps its mark; its word is still read aloud.
    expect(html).toContain('<span class="br-brand-word">branch-review</span>');
    expect(CHROME_CSS).toMatch(/@media \(max-width: 479px\) \{\s*\.br-brand-word \{ position: absolute;[^}]*clip: rect\(0, 0, 0, 0\);/);
  });

  it('says a file the background render hasn\'t reached is not rendered yet', () => {
    const html = assembleFilePage(input({path: 'a.md', status: 'modified', body: {kind: 'pending'}}));
    expect(html).toContain('<p class="br-state">not rendered yet · opening this file in branch-review renders it</p>');
    expect(html).toContain('M</span> · not rendered yet</p>');
  });

  it('escapes every repo-supplied string it prints', async () => {
    const fragment = await rendered('Text.\n');
    const html = assembleFilePage(input(
      {path: 'docs/<img src=x onerror=alert(1)>.md', status: 'renamed', oldPath: '"><script>', body: {kind: 'rendered', fragment}},
      {
        title: {repo: '<repo>', base: 'main<script>', branch: '&branch', worktree: true, renderedAt: 0},
        rail: [{path: 'a/<b>.md', status: 'modified', href: 'x.html', label: '<1>', current: false}],
      },
    ));
    expect(html).not.toMatch(/<script|<img src=x|<b>|<repo>|<1>/);
    expect(html).toContain('<span class="br-refs" title="&#x3C;repo>">');
    expect(html).toContain('&#x3C;img src=x onerror=alert(1)>.md');
    expect(html).toContain('&#x26;branch');
  });

  it('never prints a home path or a stack trace', async () => {
    const html = await page();
    expect(html).not.toMatch(/\/Users\/|\/home\/|\n {4}at /);
  });

  it('escapes quotes in attributes, so a repo name or a link can\'t open a new one', async () => {
    const fragment = await rendered('Text.\n');
    const html = assembleFilePage(input(
      {path: 'a.md', status: 'modified', body: {kind: 'rendered', fragment}},
      {
        title: {repo: 'repo" onmouseover="x', base: 'main', branch: 'b', worktree: false, renderedAt: 0},
        rail: [{path: 'a.md', status: 'modified', href: 'x.html" onclick="y', label: '1', current: true}],
      },
    ));
    expect(html).toContain('title="repo&#x22; onmouseover=&#x22;x"');
    expect(html).toContain('href="x.html&#x22; onclick=&#x22;y"');
    expect(html).not.toMatch(/"\s+on[a-z]+=/);
  });

});

describe('page.css', () => {
  it('stops an anchor jump below the sticky strip', () => {
    expect(rule('.br-strip')).toContain('height: 44px;');
    expect(rule('html')).toContain('scroll-padding-top: 52px;');
  });

  it('uses a palette of its own, never GitHub\'s Primer colors, outside the article', () => {
    const primer = ['#f6f8fa', '#d1d9e0', '#1f2328', '#59636e', '#818b98', '#1a7f37', '#cf222e', '#8250df', '#bf8700',
      '#0d1117', '#151b23', '#3d444d', '#f0f6fc', '#9198a1', '#656c76', '#3fb950', '#f85149', '#ab7df8', '#d29922'];
    for (const color of primer) expect(CHROME_CSS.toLowerCase()).not.toContain(color);
  });

  it('keeps chrome text at 4.5:1 and bars at 3:1 on every surface, in both themes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const t = tokens(scheme);
      for (const text of ['fg', 'muted', 'faint', 'added-text', 'modified-text', 'removed', 'renamed']) {
        for (const surface of ['bg', 'surface', 'raised']) expect(contrast(t[text]!, t[surface]!), `${scheme} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const bar of ['added', 'modified', 'removed']) expect(contrast(t[bar]!, t.bg!), `${scheme} ${bar} bar`).toBeGreaterThanOrEqual(3);
    }
    // Status letters and the opened chip use the text shades, not the bar shades.
    expect(rule('.br-status-modified')).toContain('var(--br-modified-text)');
    expect(CHROME_CSS).toMatch(/details\.br-before\[open\] > summary \{ border-color: var\(--br-modified\); color: var\(--br-modified-text\); \}/);
    // Old text is tinted, never faded below what can be read.
    for (const selector of ['.markdown-body .br-removed-body { border-left', '.markdown-body .br-before-body { border-left']) {
      expect(CHROME_CSS).toContain(selector);
    }
    expect(CHROME_CSS).not.toMatch(/br-(removed|before)-body[^{]*\{[^}]*opacity/);
    expect(rule('.br-main .markdown-body.br-dimmed')).toContain('opacity: 0.75;');
  });

  it('takes the closed before chip out of the flow, so it adds no space under its block', () => {
    expect(rule('.markdown-body details.br-before:not([open])')).toMatch(/position: absolute;[\s\S]*right: var\(--br-article-pad\);[\s\S]*transform: translateY\(calc\(-100% - 16px\)\);/);
    expect(rule('.markdown-body details.br-before')).toContain('margin: 0;');
    expect(rule('.br-main .markdown-body')).toContain('position: relative;');
  });

  it('hides the footnotes label from sight, as GitHub does', () => {
    expect(rule('.markdown-body .sr-only')).toMatch(/position: absolute;[\s\S]*clip: rect\(0, 0, 0, 0\);/);
  });

  it('keeps the refs on a narrow screen and folds the rail into a one-line switcher', async () => {
    expect(CHROME_CSS).not.toMatch(/\.br-refs \{ display: none; \}/);
    const narrow = CHROME_CSS.slice(CHROME_CSS.indexOf('@media (max-width: 900px)'));
    expect(narrow).toMatch(/^@media \(max-width: 900px\) \{[^@]*\.br-rail \{ display: none; \}[^@]*\.br-switcher \{ display: block; \}/);
    const html = await page();
    expect(html).toMatch(/<main class="br-main">\n<details class="br-switcher">\n<summary><span class="br-switcher-name">page\.md<\/span><span class="br-switcher-count">1 of 3<\/span><\/summary>\n<nav class="br-switcher-list" aria-label="Rendered files">/);
    expect(html.match(/href="bbbb\.html"/g)).toHaveLength(2);
  });

  it('keeps a removed list item out of its ordered list\'s numbering', () => {
    expect(rule('.markdown-body li.br-removed-item')).toMatch(/display: block;/);
  });

  it('wraps the fidelity popover\'s text inside the popover', () => {
    expect(rule('.br-popover')).toMatch(/white-space: normal;[\s\S]*text-align: left;/);
  });

  it('keeps a closed before chip in a table cell beside the cell\'s text', () => {
    // As specific as the closed chip's own rule, and after it, so it wins.
    const cell = '.markdown-body :is(td, th) > details.br-before:not([open])';
    expect(rule(cell)).toMatch(/position: static;[\s\S]*transform: none;/);
    expect(CHROME_CSS.indexOf(`${cell} {`)).toBeGreaterThan(CHROME_CSS.indexOf('.markdown-body details.br-before:not([open]) {'));
  });

  it('lines the bars of quotes and alerts up with every other bar, past their left border', () => {
    expect(rule('.markdown-body :is(blockquote, .markdown-alert)[data-mark]::before')).toContain('left: calc(var(--br-bar-x) - 0.25em);');
  });

  it('keeps a removed row\'s marker text on one tint, at 4.5:1', () => {
    expect(rule('.markdown-body tr.br-removed-row details.br-removed > summary')).toContain('background: none;');
  });

  it('keeps an old task item\'s checkbox inside its tinted view', () => {
    expect(CHROME_CSS).toMatch(/:is\(\.br-before-body, \.br-removed-body\) > \.task-list-item-checkbox[^{]*\{ margin-left: 0; \}/);
  });

  it('hides the card of a theme-only image in the other theme, as it hides the image', () => {
    expect(CHROME_CSS).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*\.markdown-body :is\(img, \.br-card\)\[data-gh-theme="light"\] \{ display: none; \}/);
    expect(CHROME_CSS).toMatch(/@media \(prefers-color-scheme: light\) \{\s*\.markdown-body :is\(img, \.br-card\)\[data-gh-theme="dark"\] \{ display: none; \}/);
  });

  it('starts the file head and banners at the article\'s left edge', () => {
    expect(rule('.br-filehead')).toContain('padding: 22px 45px 0;');
    expect(rule('.br-banners')).toContain('padding: 0 45px;');
    expect(rule('.br-main .markdown-body')).toContain('padding: 32px var(--br-article-pad) 45px;');
    expect(rule('.br-filehead')).not.toContain('border-bottom');
  });
});

