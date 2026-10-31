import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {PAGE_CSS, PAGE_CSS_HASH, PAGE_SCRIPT, PAGE_SCRIPT_HASH} from '../src/rendered/assets.generated.js';
import {assembleFilePage, contentSecurityPolicy, railLabel, type PageFile, type PageInput} from '../src/rendered/page.js';
import {renderMarkdown} from '../src/rendered/markdown.js';
import {rawSource} from '../src/rendered/raw.js';
import type {ChangeGroup} from '../src/rendered/changes.js';

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

// The page less its own script, so a check for any other script, or for
// markup a repo string could have opened, reads the rest of the page.
function withoutOurScript(html: string) {
  return html.replace(`<script>${PAGE_SCRIPT}</script>`, '');
}

function sha256Base64(text: string) {
  return createHash('sha256').update(text).digest('base64');
}

describe('assembleFilePage', () => {
  it('puts the CSP first in <head>, with nothing allowed to load, and only our own style and script to run', async () => {
    const html = await page();
    expect(html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)![1];
    expect(csp).toBe(contentSecurityPolicy());
    expect(csp).toBe(`default-src 'none'; img-src data:; style-src '${PAGE_CSS_HASH}'; script-src '${PAGE_SCRIPT_HASH}'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'`);
  });

  it('allows its inline style and its one script by their hashes, and no other script', async () => {
    const html = await page();
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]!);
    expect(styles).toHaveLength(1);
    expect(`sha256-${sha256Base64(styles[0]!)}`).toBe(PAGE_CSS_HASH);
    expect(styles[0]).toBe(PAGE_CSS);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[0]);
    expect(scripts).toEqual([`<script>${PAGE_SCRIPT}</script>`]);
    expect(`sha256-${sha256Base64(PAGE_SCRIPT)}`).toBe(PAGE_SCRIPT_HASH);
    // Last in the body, once everything it reads is parsed.
    expect(html.endsWith(`<script>${PAGE_SCRIPT}</script>\n</body>\n</html>\n`)).toBe(true);
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
    expect(withoutOurScript(html)).not.toMatch(/<script|<img src=x|<b>|<repo>|<1>/);
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
    // A deleted file's page dims its pictures and cards, and its text keeps
    // full contrast.
    expect(rule('.br-main .markdown-body.br-dimmed :is(img, picture, video, .br-card)')).toContain('opacity: 0.75;');
    expect(rule('.br-main .markdown-body.br-dimmed')).toBe('');
    expect(CHROME_CSS).not.toMatch(/\.br-dimmed[^{,]*\{[^}]*opacity/);
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

  it('shows no count in the rail for a file not rendered yet, and says so on hover', async () => {
    expect(railLabel('modified', 'pending')).toBe('');
    expect(railLabel('renamed', 'pending')).toBe('');
    // A new or deleted file's mark needs no render.
    expect(railLabel('added', 'pending')).toBe('+');
    expect(railLabel('deleted', 'pending')).toBe('−');
    expect(railLabel('modified', null)).toBe('·');
    const html = await page({rail: [
      {path: 'docs/page.md', status: 'modified', href: 'aaaa.html', label: '3', current: true},
      {path: 'README.md', status: 'modified', href: 'cccc.html', label: '', current: false},
    ]});
    expect(html).toContain('<span class="br-rail-name">README.md</span><span class="br-rail-count" title="not rendered yet"></span>');
    expect(html).toContain('<span class="br-rail-name">page.md</span><span class="br-rail-count">3</span>');
  });

  it('keeps a heading\'s anchor in the layout on a narrow screen, so a #link still scrolls to it', () => {
    const narrow = CHROME_CSS.slice(CHROME_CSS.indexOf('@media (max-width: 767px)'));
    const block = narrow.slice(0, narrow.indexOf('\n}\n'));
    expect(block).not.toMatch(/\.anchor[^{]*\{[^}]*display: none/);
    expect(block).toMatch(/\.markdown-body \.markdown-heading \.anchor,\n\s*\.markdown-body \.markdown-heading \.octicon-link \{ visibility: hidden; \}/);
  });

  it('draws a table row\'s bar in the margin with the other bars, inside the table\'s own scroller', () => {
    // The table reaches into the margin by the bar's offset and gives it back as padding.
    const table = rule('.markdown-body table:has(tr[data-mark])');
    expect(table).toContain('margin-left: var(--br-bar-x);');
    expect(table).toContain('padding-left: calc(0px - var(--br-bar-x));');
    expect(table).toContain('max-width: calc(100% - var(--br-bar-x));');
    expect(rule('.markdown-body tr[data-mark] > :first-child')).toContain('position: relative;');
    const bar = rule('.markdown-body tr[data-mark] > :first-child::before');
    expect(bar).toMatch(/position: absolute;[\s\S]*left: calc\(var\(--br-bar-x\) - 1px\);[\s\S]*width: 3px;/);
    expect(rule('.markdown-body tr[data-mark="modified"] > :first-child::before')).toContain('background: var(--br-modified);');
    expect(CHROME_CSS).not.toContain('inset 3px 0 0');
  });

  it('runs the rail\'s panel the whole height of the page, with its list sticky in view', async () => {
    // The rail is the grid's first column, stretched to the row, so its
    // background and border reach the end of the longest page.
    const nav = rule('.br-rail');
    expect(nav).toContain('align-self: stretch;');
    expect(nav).toContain('background: var(--br-surface);');
    expect(nav).toContain('border-right: 1px solid var(--br-border);');
    expect(nav).not.toMatch(/\bheight:|position: sticky/);
    // What it lists stays under the strip while the page scrolls.
    const panel = rule('.br-rail-panel');
    expect(panel).toMatch(/position: sticky;[\s\S]*top: 44px;[\s\S]*max-height: calc\(100vh - 44px\);[\s\S]*overflow-y: auto;/);
    const html = await page();
    expect(html).toMatch(/<nav class="br-rail" aria-label="Rendered files">\n<div class="br-rail-panel">\n<p class="br-rail-title">CHANGED · 3 rendered<\/p>[\s\S]*<p class="br-rail-foot">[^\n]*<\/p>\n<\/div>\n<\/nav>/);
  });

  it('starts the file head and banners at the article\'s left edge', () => {
    expect(rule('.br-filehead')).toContain('padding: 22px 45px 0;');
    expect(rule('.br-banners')).toContain('padding: 0 45px;');
    expect(rule('.br-main .markdown-body')).toContain('padding: 32px var(--br-article-pad) 45px;');
    expect(rule('.br-filehead')).not.toContain('border-bottom');
  });
});

describe('the raw first frame', () => {
  const group = (overrides: Partial<ChangeGroup>): ChangeGroup => ({id: 'g0', kind: 'added', after: null, base: null, anchorLine: 1, removedLines: [], ...overrides});

  it('is the source as the diff showed it: added lines tinted, removed ones back in place', () => {
    const source = '# Title\n\nNew line one,\nnew line two.\n\nTail.\n';
    const raw = rawSource(source, [
      group({kind: 'modified', after: [3, 4], base: [3, 3], anchorLine: 3, removedLines: ['Old line.']}),
      group({id: 'g1', kind: 'removed', base: [7, 7], anchorLine: 7, removedLines: ['Gone at the end.']}),
    ]);
    expect(raw.text.split('\n')).toEqual(['# Title', '', 'Old line.', 'New line one,', 'new line two.', '', 'Tail.', 'Gone at the end.']);
    expect(raw.tints).toBe('  -++  -');
  });

  it('tints every line of a new file added and every line of a deleted file removed, still counting them as the page\'s own', async () => {
    const source = '# New\n\nAll of this is new.\n';
    for (const status of ['added', 'untracked'] as const) {
      expect(rawSource(source, [], status)).toEqual({text: '# New\n\nAll of this is new.', tints: '+++'});
    }
    // A deleted file's page is its base text: red, as the diff drew it,
    // and still the page's lines, so `x` and never `-`.
    expect(rawSource(source, [], 'deleted')).toEqual({text: '# New\n\nAll of this is new.', tints: 'xxx'});
    expect(rawSource(source, [], 'modified').tints).toBe('   ');
    const fragment = await renderMarkdown({path: 'a.md', status: 'deleted', source, groups: [], asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    expect(fragment.raw?.tints).toBe('xxx');
  });

  it('has one tint a line, with no line for the final newline and no carriage returns', () => {
    const raw = rawSource('a\r\nb\r\n', []);
    expect(raw).toEqual({text: 'a\nb', tints: '  '});
    expect(rawSource('', [])).toEqual({text: '', tints: ' '});
  });

  it('rides in the page as escaped text in an inert template, its first blank line kept', async () => {
    const source = '\n<script>alert(1)</script> & "quotes"\n';
    const fragment = await renderMarkdown({path: 'a.md', source, groups: [], asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const html = assembleFilePage(input({path: 'a.md', status: 'modified', body: {kind: 'rendered', fragment}}));
    expect(html).toContain('<template class="br-raw-source"><pre data-tints="  ">\n\n&#x3C;script>alert(1)&#x3C;/script> &#x26; &#x22;quotes&#x22;</pre></template>');
    // After the article, outside it.
    expect(html.indexOf('<template class="br-raw-source">')).toBeGreaterThan(html.indexOf('</article>'));
    // A card has no raw frame.
    expect(withoutOurScript(assembleFilePage(input({path: 'a.md', status: 'modified', body: {kind: 'empty'}})))).not.toContain('br-raw-source');
  });
});

describe('the page\'s keys and controls', () => {
  it('puts the theme, marks and keys buttons in the strip, hidden until the script runs', async () => {
    const html = await page();
    const end = html.slice(html.indexOf('<div class="br-strip-end">'), html.indexOf('</header>'));
    expect(end.indexOf('br-fidelity')).toBeLessThan(end.indexOf('br-theme'));
    expect(end).toMatch(/<button type="button" class="br-control br-theme br-js" title="Theme \(t\)" hidden>.*◐.*<span class="br-control-word br-theme-name">Auto<\/span><\/button>/);
    expect(end).toMatch(/<button type="button" class="br-control br-marks br-js" title="Change marks \(m\)" aria-pressed="true" hidden><span class="br-marks-bar" aria-hidden="true">▍<\/span><span class="br-control-word">Changes<\/span><\/button>/);
    expect(end).toMatch(/<button type="button" class="br-control br-help-button br-js"[^>]*aria-controls="br-help"[^>]*hidden>\?<\/button>/);
    // Hidden means hidden, whatever display a control's own rule gives it.
    expect(CHROME_CSS).toContain('.br-js[hidden] { display: none !important; }');
  });

  it('keeps the strip readable on a narrow screen: a few letters of the base, and a bar on the marks button', () => {
    const narrow = CHROME_CSS.slice(CHROME_CSS.indexOf('@media (max-width: 767px)'));
    expect(narrow).toMatch(/^@media \(max-width: 767px\) \{[^@]*\.br-control-word \{ display: none; \}[^@]*\.br-refs \.br-base \{ min-width: 4ch; \}/);
    expect(rule('.br-marks[aria-pressed="true"] .br-marks-bar')).toContain('color: var(--br-modified);');
    expect(rule('.br-marks-bar')).toContain('color: var(--br-faint);');
  });

  it('leaves the narrow screen\'s layout to its own rule when a theme is forced', () => {
    // A forced theme's block outranks `:root` in the narrow media query, so
    // it may carry colors only, never a length the narrow screen changes.
    const narrow = CHROME_CSS.slice(CHROME_CSS.indexOf('@media (max-width: 767px)'));
    const layout = [...narrow.match(/:root \{([^}]*)\}/)![1]!.matchAll(/(--br-[\w-]+):/g)].map((match) => match[1]!);
    expect(layout).toEqual(['--br-bar-x', '--br-article-pad']);
    for (const forced of PAGE_CSS.matchAll(/:root\[data-theme="(?:light|dark)"\] \{([^}]*)\}/g)) {
      for (const name of layout) expect(forced[1]).not.toContain(name);
    }
  });

  it('keeps an embedded image\'s height in proportion to its width', () => {
    expect(rule('.markdown-body img[data-br-size]')).toBe('.markdown-body img[data-br-size] { height: auto; }');
  });

  it('names the keys in the rail and in the help, which opens closed', async () => {
    const html = await page();
    expect(html).toMatch(/<dl class="br-rail-keys br-js" hidden><div><dt><kbd>\[<\/kbd> <kbd>\]<\/kbd><\/dt><dd>change<\/dd><\/div><div><dt><kbd>\{<\/kbd> <kbd>\}<\/kbd><\/dt><dd>file<\/dd><\/div><div><dt><kbd>t<\/kbd><\/dt><dd>theme<\/dd><\/div><div><dt><kbd>m<\/kbd><\/dt><dd>marks<\/dd><\/div><\/dl>/);
    expect(html).toContain('<div class="br-help" id="br-help" role="dialog" aria-label="Keys" hidden>');
    for (const what of ['previous or next change', 'previous or next file', 'theme: system, light, dark', 'show or hide the change marks', 'these keys']) expect(html).toContain(`<dd>${what}</dd>`);
  });

  it('says where the reader is among the changes, in the file head, only when there are some', async () => {
    const fragment = {...await rendered(), changes: {changed: 3, removed: 1}};
    const html = assembleFilePage(input({path: 'docs/page.md', status: 'modified', body: {kind: 'rendered', fragment}}));
    expect(html).toContain('<nav class="br-changes br-js" aria-label="Changes" hidden><span class="br-changes-at" aria-live="polite">change 1 of 4</span><button type="button" class="br-step" data-step="-1" title="Previous change ([)" aria-label="Previous change">↑</button><button type="button" class="br-step" data-step="1" title="Next change (])" aria-label="Next change">↓</button></nav>');
    expect(await page()).not.toContain('<nav class="br-changes');
  });

  it('forces either theme over the system\'s, both palettes derived from the ones they force', () => {
    const vendored = fs.readFileSync(VENDORED_CSS, 'utf8');
    const block = (css: string, opening: string) => css.slice(css.indexOf(opening) + opening.length, css.indexOf('}', css.indexOf(opening))).trim();
    expect(PAGE_CSS).toContain(`:root[data-theme="dark"] .markdown-body {\n  ${block(vendored, '@media (prefers-color-scheme: dark) {\n  .markdown-body, [data-theme="dark"] {')}\n}`);
    expect(PAGE_CSS).toContain(`:root[data-theme="light"] .markdown-body {\n  ${block(vendored, '@media (prefers-color-scheme: light) {\n  .markdown-body, [data-theme="light"] {')}\n}`);
    expect(PAGE_CSS).toContain(`:root[data-theme="dark"] {\n  color-scheme: dark;\n  ${block(CHROME_CSS, '@media (prefers-color-scheme: dark) {\n  :root {')}\n}`);
    expect(PAGE_CSS).toContain(`:root[data-theme="light"] {\n  ${block(CHROME_CSS, ':root {').replace('color-scheme: light dark;', 'color-scheme: light;')}\n}`);
    // Theme-only images follow the switch too.
    expect(CHROME_CSS).toMatch(/:root\[data-theme="dark"\] \.markdown-body :is\(img, \.br-card, \.br-image-note\)\[data-gh-theme="light"\],\n:root\[data-theme="light"\] \.markdown-body :is\(img, \.br-card, \.br-image-note\)\[data-gh-theme="dark"\] \{ display: none; \}/);
  });

  it('hides every mark with m, and the room the before chips keep', () => {
    expect(CHROME_CSS).toContain(':root.br-marks-off { --br-chip-room: 0px; }');
    expect(CHROME_CSS).toMatch(/\.br-marks-off \.markdown-body \[data-mark\]::before,\n\.br-marks-off \.markdown-body tr\[data-mark\] > :first-child::before \{ content: none; \}/);
    expect(CHROME_CSS).toContain('.br-marks-off .markdown-body :is(details.br-removed, details.br-before, li.br-removed-item, tr.br-removed-row) { display: none; }');
  });

  it('keeps the develop\'s tints behind the text and gone at rest, its glow at 14% of the accent', () => {
    const tint = rule('.markdown-body .br-tint');
    expect(tint).toMatch(/position: absolute;[\s\S]*left: var\(--br-bar-x\);[\s\S]*z-index: -1;[\s\S]*transform: scaleX\(0\);[\s\S]*transform-origin: 0 50%;/);
    expect(rule('.markdown-body [data-mark]')).toContain('position: relative;');
    expect(CHROME_CSS).toContain('.markdown-body [data-mark] { isolation: isolate; }');
    for (const scheme of ['light', 'dark'] as const) {
      const block = [...CHROME_CSS.matchAll(/:root \{([^}]*)\}/g)].map((match) => match[1]!)[scheme === 'light' ? 0 : 1]!;
      const accent = /--br-accent: (#[0-9a-f]{6});/.exec(block)![1];
      expect(block).toContain(`--br-glow: ${accent}24;`);
    }
    expect(rule('.br-veil')).toMatch(/position: fixed;[\s\S]*background: var\(--br-veil-bg\);[\s\S]*color: var\(--br-veil-fg\);[\s\S]*pointer-events: none;/);
  });

  it('gives the overview the theme and keys buttons but no marks to hide', async () => {
    const {assembleOverview} = await import('../src/rendered/page.js');
    const html = assembleOverview({title: input({path: 'a.md', status: 'modified', body: {kind: 'empty'}}).title, entries: [], differences: []});
    expect(html).toContain('class="br-control br-theme br-js"');
    expect(html).toContain('class="br-control br-help-button br-js"');
    expect(html).not.toContain('class="br-control br-marks');
    expect(html).toContain('<dd>previous or next page</dd>');
    expect(html).toContain('<div><dt><kbd>⏎</kbd></dt><dd>open</dd></div>');
  });
});

