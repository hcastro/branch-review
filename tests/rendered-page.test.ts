import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {PAGE_CSS} from '../src/rendered/assets.generated.js';
import {articleHtml, type PageFile} from '../src/rendered/page.js';
import {renderMarkdown} from '../src/rendered/markdown.js';

// A rendered markdown file's article, as a card's rich view on the Review
// in browser page and the in-pane view's tile draw it, and the stylesheet
// that draws its change marks around GitHub's own.

const VENDORED_CSS = new URL('../src/rendered/assets/github-markdown.css', import.meta.url);
const CHROME_CSS = fs.readFileSync(new URL('../src/rendered/assets/page.css', import.meta.url), 'utf8');
// The Review in browser page's own sheet, where its rich views' article rules live.
const REVIEW_CSS = fs.readFileSync(new URL('../src/rendered/assets/review.css', import.meta.url), 'utf8');

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

// The rule a selector opens in page.css, or another sheet, as written there.
function rule(selector: string, css = CHROME_CSS) {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1);
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

describe('articleHtml', () => {
  it('wraps a rendered file in markdown-body, dimmed for a deleted file, and escapes nothing twice', async () => {
    const fragment = await rendered('Text & <b>more</b>.\n');
    const html = articleHtml({path: 'docs/page.md', status: 'modified', body: {kind: 'rendered', fragment}});
    expect(html).toBe(`<article class="markdown-body">\n${fragment.html}\n</article>`);
    expect(articleHtml({path: 'docs/page.md', status: 'deleted', body: {kind: 'rendered', fragment}})).toContain('<article class="markdown-body br-dimmed">');
  });

  it('shows a card for an empty, oversized, non-UTF-8 or failed file, with the raw text where there is some', () => {
    const page = (body: PageFile['body']) => articleHtml({path: 'a.md', status: 'modified', body});
    expect(page({kind: 'empty'})).toContain('<p class="br-state">this file is empty</p>');
    const large = page({kind: 'tooLarge', bytes: 2.4 * 1024 * 1024, head: '# Head <b>raw</b>'});
    expect(large).toContain('<p class="br-state">too large to show (2.4 MB)</p>');
    expect(large).toContain('<pre class="br-raw"># Head &#x3C;b>raw&#x3C;/b></pre>');
    expect(page({kind: 'notUtf8'})).toContain('<p class="br-state">not UTF-8 text</p>');
    const failed = page({kind: 'failed', reason: 'parser gave up', source: 'raw <script>'});
    expect(failed).toContain("<p class=\"br-state br-state-error\">couldn't show this file · parser gave up</p>");
    expect(failed).toContain('<pre class="br-raw">raw &#x3C;script></pre>');
    // In the article's box, the card and raw text setting no width of their own.
    expect(failed).toMatch(/^<div class="br-body">\n<p class="br-state br-state-error">/);
    expect(rule('.br-state')).not.toContain('max-width');
    expect(rule('.br-raw')).not.toContain('max-width');
  });

  it('says a file the background render hasn\'t reached is not ready yet, and how to see it', () => {
    expect(articleHtml({path: 'a.md', status: 'modified', body: {kind: 'pending'}})).toContain('<p class="br-state">not ready yet · press r in branch-review again in a moment</p>');
  });

  it('never prints a home path or a stack trace', async () => {
    const html = articleHtml({path: 'docs/page.md', status: 'modified', body: {kind: 'rendered', fragment: await rendered()}});
    expect(html).not.toMatch(/\/Users\/|\/home\/|\n {4}at /);
  });

  it('inlines the vendored GitHub stylesheet unchanged, pinned by its hash', () => {
    const vendored = fs.readFileSync(VENDORED_CSS, 'utf8');
    expect(createHash('sha256').update(vendored).digest('hex')).toBe(VENDORED_CSS_SHA256);
    expect(PAGE_CSS).toContain(vendored);
    expect(PAGE_CSS).toContain('github-markdown-css 5.9.0');
    // The one url() is GitHub's inline data: mask for the link icon.
    expect(PAGE_CSS).not.toMatch(/url\((?!"data:)|@import|@font-face/);
  });

});

describe('page.css', () => {
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
    // The opened chip uses the text shades, not the bar shades.
    expect(CHROME_CSS).toMatch(/details\.br-before\[open\] > summary \{ border-color: var\(--br-modified\); color: var\(--br-modified-text\); \}/);
    // Old text is tinted, never faded below what can be read.
    for (const selector of ['.markdown-body .br-removed-body { border-left', '.markdown-body .br-before-body { border-left']) {
      expect(CHROME_CSS).toContain(selector);
    }
    expect(CHROME_CSS).not.toMatch(/br-(removed|before)-body[^{]*\{[^}]*opacity/);
    // A deleted file's rich view dims its pictures and cards, and its text
    // keeps full contrast.
    expect(rule('.rv-rich .markdown-body.br-dimmed :is(img, picture, video, .br-card)', REVIEW_CSS)).toContain('opacity: 0.75;');
    expect(rule('.rv-rich .markdown-body.br-dimmed', REVIEW_CSS)).toBe('');
    for (const css of [CHROME_CSS, REVIEW_CSS]) expect(css).not.toMatch(/\.br-dimmed[^{,]*\{[^}]*opacity/);
    // No rule is left for the file pages' main column, which no page has now.
    expect(CHROME_CSS).not.toContain('.br-main');
  });

  it('takes the closed before chip out of the flow, so it adds no space under its block', () => {
    expect(rule('.markdown-body details.br-before:not([open])')).toMatch(/position: absolute;[\s\S]*right: var\(--br-article-pad\);[\s\S]*transform: translateY\(calc\(-100% - 16px\)\);/);
    expect(rule('.markdown-body details.br-before')).toContain('margin: 0;');
    expect(rule('.rv-rich .markdown-body', REVIEW_CSS)).toContain('position: relative;');
  });

  it('hides the footnotes label from sight, as GitHub does', () => {
    expect(rule('.markdown-body .sr-only')).toMatch(/position: absolute;[\s\S]*clip: rect\(0, 0, 0, 0\);/);
  });

  it('keeps a removed list item out of its ordered list\'s numbering', () => {
    expect(rule('.markdown-body li.br-removed-item')).toMatch(/display: block;/);
  });

  it('keeps a closed before chip in a table cell at the foot of the cell, out of the cells\' flow', () => {
    // As specific as the closed chip's own rule, and after it, so it wins.
    const cell = '.markdown-body :is(td, th) > details.br-before:not([open])';
    expect(rule(cell)).toMatch(/right: 13px;[\s\S]*transform: none;/);
    expect(rule('.markdown-body :is(td, th) > details.br-before')).toMatch(/position: absolute;[\s\S]*right: 13px;[\s\S]*bottom: 6px;/);
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

  it('keeps an embedded image\'s height in proportion to its width', () => {
    expect(rule('.markdown-body img[data-br-size]')).toBe('.markdown-body img[data-br-size] { height: auto; }');
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

});
