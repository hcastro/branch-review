import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown} from '../src/rendered/markdown.js';
import {assembleTileDocument, type PageFile} from '../src/rendered/page.js';
import {diffFile} from './rendered-helpers.js';

// The document Chromium cuts the in-pane tiles from: the article alone, no
// rail, no strip, no script, in the terminal's background at the sheet's
// width. The change marks are gutter text in the pane, so the page draws
// none, and the parts that need a click on the page (the before chip, a
// removed block's body) stay out, with the marker naming where to see them.
// The marker itself stays, for the gutter to mark, and a link that won't
// resolve is drawn broken, as on the file page.

const BEFORE = '# Title\n\nKept paragraph.\n\nOld paragraph one.\n\nOld paragraph two.\n\nChanged words here.\n';
const AFTER = '# Title\n\nKept paragraph.\n\nChanged words there.\n\nA new paragraph.\n';

async function page(): Promise<PageFile> {
  const file = diffFile(BEFORE, AFTER, 'docs/page.md');
  const fragment = await renderMarkdown({path: 'docs/page.md', status: 'modified', source: AFTER, groups: changeGroups(file), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
  return {path: 'docs/page.md', status: 'modified', body: {kind: 'rendered', fragment}};
}

const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

describe('the tile document', () => {
  it('runs no script and allows only its own styles, by hash, with the policy first in <head>', async () => {
    const html = assembleTileDocument({file: await page(), scheme: 'dark', bg: '#101418', cssWidth: 973.142857});
    expect(html).not.toMatch(/<script/i);
    const head = html.slice(html.indexOf('<head>') + 6);
    expect(head.trimStart().startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    const policy = /content="([^"]+)"/.exec(head)![1]!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('img-src data:');
    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]!);
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(policy).toContain(hash(style));
    expect(html).not.toMatch(/ style="/);
  });

  it('holds the article alone, at the sheet width, in the terminal background and its scheme', async () => {
    const html = assembleTileDocument({file: await page(), scheme: 'light', bg: '#fafafa', cssWidth: 640});
    const markup = html.slice(html.indexOf('<body>'));
    expect(markup).toContain('class="markdown-body');
    expect(markup).not.toContain('br-rail');
    expect(markup).not.toContain('br-strip');
    expect(html).toMatch(/<html lang="en" data-theme="light" class="br-tile">/);
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain('--br-tile-bg: #fafafa');
    expect(html).toContain('--br-tile-width: 640px');
  });

  it('draws no change marks, leaves the before chip out and names r on a removed marker', async () => {
    const html = assembleTileDocument({file: await page(), scheme: 'dark', bg: '#101418', cssWidth: 640});
    // The blocks keep their ids and marks, which the layout reads for the gutter.
    expect(html).toMatch(/data-mark="modified"/);
    expect(html).toContain('removed · r shows it in the split</summary>');
    expect(html).not.toContain('removed · show</summary>');
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]!).join('\n');
    expect(styles).toMatch(/\.br-tile details\.br-before\s*\{\s*display: none/);
    // The bars are off, and the room the before chip keeps.
    expect(styles).toContain('.br-tile .markdown-body :is([data-mark], details.br-removed)::before, .br-tile .markdown-body tr[data-mark] > :first-child::before { content: none; }');
    expect(styles).toContain(':root { --br-chip-room: 0px; --br-row-chip-room: 0px; }');
  });

  it('hides the before chip with a rule the page\'s chip placement in list items and table cells can\'t outrank', async () => {
    const html = assembleTileDocument({file: await page(), scheme: 'dark', bg: '#101418', cssWidth: 640});
    const [pageCss, tileCss] = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]!);
    // The page shows the chip in an item or a cell with rules more specific
    // than any one the tile could name, so only an important rule wins in
    // every place the chip goes; the page's own rules never use one on it.
    expect(tileCss).toMatch(/\.br-tile details\.br-before\s*\{\s*display: none !important;\s*\}/);
    expect(pageCss).toMatch(/:is\(td, th\) > details\.br-before \{ display: inline-block/);
    expect(pageCss).toMatch(/li > details\.br-before \{ display: inline-block/);
    const chipRules = [...pageCss!.matchAll(/([^{}]*details\.br-before[^{}]*)\{([^}]*)\}/g)];
    expect(chipRules.length).toBeGreaterThan(0);
    for (const [, selector, declarations] of chipRules) expect(declarations, selector).not.toContain('!important');
  });

  it('keeps a removed block\'s marker on the page, where the page\'s marks-off switch would hide it', async () => {
    const html = assembleTileDocument({file: await page(), scheme: 'dark', bg: '#101418', cssWidth: 640});
    // `br-marks-off` is the file page's switch for GitHub's view, which
    // hides removed content outright: the tile must not carry it.
    expect(/<html[^>]*>/.exec(html)![0]).not.toContain('br-marks-off');
    expect(html).toContain('<details class="br-removed"><summary>');
    const tileCss = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]!).at(-1)!;
    expect(tileCss).not.toMatch(/br-removed[^{]*\{[^}]*display: none/);
  });

  it('draws a link to a heading another page doesn\'t have broken, as the file page does', async () => {
    const fragment = await renderMarkdown({path: 'README.md', source: 'See [tokens](docs/guide.md#tokenz) and [usage](docs/guide.md#usage).\n', groups: [], asset: async () => ({kind: 'skipped'}), link: (repoPath) => (repoPath === 'docs/guide.md' ? {kind: 'inReview', href: 'f-guide.html'} : {kind: 'outside'})});
    const file: PageFile = {path: 'README.md', status: 'modified', body: {kind: 'rendered', fragment}};
    const html = assembleTileDocument({file, scheme: 'dark', bg: '#101418', cssWidth: 640, brokenRefs: [0]});
    expect(html).toContain('<a href="f-guide.html#user-content-tokenz" class="br-broken" title="anchor not found">tokens</a>');
    expect(html).toContain('<a href="f-guide.html#user-content-usage">usage</a>');
    expect(assembleTileDocument({file, scheme: 'dark', bg: '#101418', cssWidth: 640})).not.toContain('class="br-broken"');
  });

  it('takes only a hex background, and the dark fallback for anything else', async () => {
    const file = await page();
    expect(assembleTileDocument({file, scheme: 'dark', bg: 'red;}</style><script>', cssWidth: 640})).toContain('--br-tile-bg: #111318');
    expect(assembleTileDocument({file, scheme: 'light', bg: 'nope', cssWidth: 640})).toContain('--br-tile-bg: #ffffff');
  });

  it('shows a page with no rendered body as its card, still with no script', () => {
    const html = assembleTileDocument({file: {path: 'docs/empty.md', status: 'added', body: {kind: 'empty'}}, scheme: 'dark', bg: '#000000', cssWidth: 640});
    expect(html).toContain('this file is empty');
    expect(html).not.toMatch(/<script/i);
  });
});
