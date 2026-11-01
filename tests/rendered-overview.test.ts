import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {HEAD_SCRIPT, HEAD_SCRIPT_HASH, PAGE_CSS_HASH, PAGE_SCRIPT, PAGE_SCRIPT_HASH} from '../src/rendered/assets.generated.js';
import {assembleOverview, contentSecurityPolicy, type OverviewInput} from '../src/rendered/page.js';

// The overview `R` opens: every rendered file of the review with its
// status and what changed, deleted files on their own, each row opening its
// page. Like a file page, it is one self-contained file that runs nothing.

const TITLE = {repo: 'branch-review-cli', base: 'main', branch: 'feature/rich-view', worktree: false, renderedAt: Date.UTC(2026, 9, 31, 12, 4)};

const CSS = fs.readFileSync(new URL('../src/rendered/assets/page.css', import.meta.url), 'utf8');

// The first rule page.css opens with exactly `selector`, as written there.
function rule(selector: string) {
  const at = CSS.indexOf(`\n${selector} {`);
  return at < 0 ? '' : CSS.slice(at, CSS.indexOf('}', at) + 1);
}

function overview(overrides: Partial<OverviewInput> = {}) {
  return assembleOverview({
    title: TITLE,
    entries: [
      {path: 'docs/rendered-view.md', status: 'modified', href: 'f-aaaaaaaaaaaaaaaaaaaa.html', state: 'rendered', changes: {changed: 3, removed: 1}},
      {path: 'docs/flow.md', status: 'added', href: 'f-bbbbbbbbbbbbbbbbbbbb.html', state: 'rendered', changes: {changed: 0, removed: 0}},
      {path: 'README.md', status: 'modified', href: 'f-cccccccccccccccccccc.html', state: 'rendered', changes: {changed: 1, removed: 0}},
      {path: 'docs/old-trip.md', status: 'deleted', href: 'f-dddddddddddddddddddd.html', state: 'rendered', changes: {changed: 0, removed: 0}},
    ],
    differences: [{kind: 'mermaid', count: 1}],
    ...overrides,
  });
}

// The rows of one section, as text with tags dropped and spaces folded.
function section(html: string, heading: string) {
  const at = html.indexOf(`<h2 class="br-group-title">${heading}</h2>`);
  if (at < 0) return [];
  const end = html.indexOf('</section>', at);
  return [...html.slice(at, end).matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

describe('assembleOverview', () => {
  it('puts the same CSP first in <head>, and has no script but our own and no style attribute', () => {
    const html = overview();
    const head = html.slice(html.indexOf('<head>') + '<head>'.length).trimStart();
    expect(head.startsWith(`<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">`)).toBe(true);
    expect(contentSecurityPolicy()).toContain(`style-src '${PAGE_CSS_HASH}'`);
    expect(contentSecurityPolicy()).toContain(`script-src '${HEAD_SCRIPT_HASH}' '${PAGE_SCRIPT_HASH}'`);
    expect(html.split(`<script>${PAGE_SCRIPT}</script>`)).toHaveLength(2);
    expect(html.split(`<script>${HEAD_SCRIPT}</script>`)).toHaveLength(2);
    expect(html.replace(`<script>${HEAD_SCRIPT}</script>`, '').replace(`<script>${PAGE_SCRIPT}</script>`, '')).not.toMatch(/<script|\sstyle=|\son[a-z]+=/i);
    expect(html).toContain('<title>All files · branch-review</title>');
  });

  it('lists the pages in review order with status, what changed and a link, and deleted files apart', () => {
    const html = overview();
    expect(section(html, 'Pages')).toEqual([
      'M docs/rendered-view.md 3 changed · 1 removed open ›',
      'A docs/flow.md new file open ›',
      'M README.md 1 changed open ›',
    ]);
    expect(section(html, 'Deleted')).toEqual(['D docs/old-trip.md shown dimmed from main open ›']);
    expect(html).toContain('<a class="br-row br-row-modified" href="f-aaaaaaaaaaaaaaaaaaaa.html">');
    expect(html).toContain('<a class="br-row br-row-deleted" href="f-dddddddddddddddddddd.html">');
  });

  it('counts the pages in the rail and the head, and names the branch', () => {
    const html = overview();
    expect(html).toContain('<p class="br-rail-title">ALL FILES</p>');
    // Each count matches its group: three rows under Pages, one under Deleted.
    expect(html).toMatch(/<ul class="br-rail-stats">\s*<li>3 pages<\/li>\s*<li>1 deleted<\/li>\s*<\/ul>/);
    expect(html).toContain('<h1 class="br-path">All files in <span class="br-branch">feature/rich-view</span></h1>');
    expect(html).toContain('<p class="br-summary">3 pages · 1 deleted</p>');
    expect(section(html, 'Pages')).toHaveLength(3);
    expect(section(html, 'Deleted')).toHaveLength(1);
    expect(overview({entries: [{path: 'a.md', status: 'modified', href: 'f-aaaaaaaaaaaaaaaaaaaa.html', state: 'rendered', changes: {changed: 1, removed: 0}}]}))
      .toContain('<p class="br-summary">1 page</p>');
  });

  it('says what each state is, and gives a file with no page yet no link', () => {
    const html = overview({entries: [
      {path: 'a.md', status: 'modified', href: 'f-aaaaaaaaaaaaaaaaaaaa.html', state: 'rendered', changes: {changed: 0, removed: 0}},
      {path: 'b.md', status: 'modified', href: 'f-bbbbbbbbbbbbbbbbbbbb.html', state: 'failed', changes: null, reason: 'took too long to prepare'},
      {path: 'c.md', status: 'renamed', oldPath: 'old/c.md', href: 'f-cccccccccccccccccccc.html', state: 'rendered', changes: {changed: 2, removed: 0}},
      {path: 'd.md', status: 'untracked', href: 'f-dddddddddddddddddddd.html', state: 'empty', changes: null},
      {path: 'e.md', status: 'modified', href: null, state: 'pending', changes: null},
    ]});
    expect(section(html, 'Pages')).toEqual([
      'M a.md no blocks marked open ›',
      "M b.md couldn't show · took too long to prepare open ›",
      'R c.md renamed from old/c.md · 2 changed open ›',
      'U d.md untracked · empty open ›',
      'M e.md not ready yet',
    ]);
    expect(html).toContain('<div class="br-row br-row-modified br-row-none">');
  });

  it('says when a deleted file\'s page is a card, or has no page yet, and why', () => {
    const html = overview({entries: [
      {path: 'a.md', status: 'modified', href: 'f-aaaaaaaaaaaaaaaaaaaa.html', state: 'rendered', changes: {changed: 1, removed: 0}},
      {path: 'old/b.md', status: 'deleted', href: 'f-bbbbbbbbbbbbbbbbbbbb.html', state: 'failed', changes: null, reason: 'parser gave up'},
      {path: 'old/c.md', status: 'deleted', href: null, state: 'pending', changes: null},
      {path: 'old/d.md', status: 'deleted', href: 'f-dddddddddddddddddddd.html', state: 'rendered', changes: null},
    ]});
    expect(section(html, 'Deleted')).toEqual([
      "D old/b.md couldn't show · parser gave up open ›",
      'D old/c.md not ready yet',
      'D old/d.md shown dimmed from main open ›',
    ]);
  });

  it('says why a file has no page when its page couldn\'t be written', () => {
    const html = overview({entries: [{path: 'a.md', status: 'modified', href: null, state: 'pending', changes: null, reason: 'disk full'}]});
    expect(section(html, 'Pages')).toEqual(['M a.md not ready yet · disk full']);
  });

  it('lines every row\'s note up in one column across the groups', () => {
    // One grid on the groups; each level down to the row takes its columns.
    expect(rule('.br-groups')).toMatch(/display: grid;[\s\S]*grid-template-columns: 34px minmax\(0, max-content\) minmax\(0, 1fr\) auto;/);
    expect(rule('.br-group, .br-rows, .br-rows > li')).toMatch(/grid-template-columns: subgrid;[\s\S]*grid-column: 1 \/ -1;/);
    expect(rule('.br-row')).toMatch(/grid-template-columns: subgrid;\s*grid-column: 1 \/ -1;/);
    expect(rule('.br-group-title, .br-overview-foot')).toContain('grid-column: 1 / -1;');
    // The groups and the foot are the grid's own items.
    expect(overview()).toMatch(/<div class="br-groups">\n<section class="br-group">[\s\S]*<\/section>\n<p class="br-overview-foot">/);
  });

  it('escapes every repo string it prints', () => {
    const html = overview({
      title: {...TITLE, branch: 'x"><script>alert(1)</script>', base: '<b>main</b>'},
      entries: [{path: 'docs/<img src=x onerror=alert(1)>.md', status: 'deleted', href: 'f-aaaaaaaaaaaaaaaaaaaa.html', state: 'rendered', changes: null}],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>main</b>');
    expect(html).toContain('docs/&#x3C;img src=x onerror=alert(1)>.md');
  });

  it('sums what the pages do differently from github.com, in the strip and the foot', () => {
    const html = overview({differences: [{kind: 'mermaid', count: 1}, {kind: 'remoteImage', count: 2}]});
    expect(html).toContain('<summary>≈ GitHub · 3 differences</summary>');
    expect(html).toContain('<p class="br-overview-foot">≈ GitHub · drawn on this machine with GitHub\'s stylesheet · 3 differences: 1 Mermaid diagram shown as code, 2 remote images not loaded: the page works offline</p>');
    expect(overview({differences: []})).toContain('<p class="br-overview-foot">≈ GitHub · drawn on this machine with GitHub\'s stylesheet</p>');
  });

  // The whole branch: an image and an SVG among the pages, a page whose text
  // didn't change but shows a changed image, a deleted page, and what won't
  // render on GitHub.
  function wholeBranch() {
    const shown = (width: number, height: number, bytes: number) => ({width, height, bytes});
    return overview({
      entries: [
        {path: 'docs/rendered-view.md', status: 'modified', href: 'f-aaaaaaaaaaaaaaaaaaaa.html', state: 'rendered', changes: {changed: 3, removed: 1}},
        {path: 'docs/flow.svg', status: 'added', href: 'f-bbbbbbbbbbbbbbbbbbbb.html', state: 'image', changes: null, image: {after: shown(1200, 480, 22_528)}},
        {path: 'docs/hero.png', status: 'modified', href: 'f-cccccccccccccccccccc.html', state: 'image', changes: null, image: {before: shown(1200, 480, 86_016), after: shown(1200, 520, 93_184)}},
        {path: 'README.md', status: 'modified', href: 'f-dddddddddddddddddddd.html', state: 'rendered', changes: {changed: 1, removed: 0}},
        {path: 'docs/old-trip.md', status: 'deleted', href: 'f-eeeeeeeeeeeeeeeeeeee.html', state: 'rendered', changes: {changed: 0, removed: 0}},
      ],
      also: [{path: 'CONTRIBUTING.md', status: 'modified', href: 'f-ffffffffffffffffffff.html', state: 'rendered', changes: {changed: 1, removed: 0}, embeds: ['docs/hero.png']}],
      findings: [
        {path: 'README.md', line: 41, target: 'setup.md#tokenz', what: 'link', kind: 'badAnchor', reason: 'anchor not found', href: 'f-dddddddddddddddddddd.html'},
        {path: 'docs/rendered-view.md', line: 18, target: './Flow.svg', what: 'image', kind: 'caseMismatch', reason: 'case mismatch: Flow.svg vs flow.svg', href: 'f-aaaaaaaaaaaaaaaaaaaa.html'},
        {path: 'README.md', line: 7, target: './notes/draft.png', what: 'image', kind: 'untracked', reason: 'file is untracked', href: 'f-dddddddddddddddddddd.html'},
      ],
    });
  }

  it('reads the whole branch: images with their sizes, what also looks different, the deleted, and what won\'t render on GitHub', () => {
    const html = wholeBranch();
    expect(section(html, 'Pages')).toEqual([
      'M docs/rendered-view.md 3 changed · 1 removed open ›',
      'A docs/flow.svg added · 1200×480 · 22 KB open ›',
      'M docs/hero.png 1200×480 · 84 KB → 1200×520 · 91 KB open ›',
      'M README.md 1 changed open ›',
    ]);
    expect(section(html, 'Also looks different')).toEqual(['· CONTRIBUTING.md text unchanged · embeds docs/hero.png open ›']);
    expect(section(html, 'Deleted')).toEqual(['D docs/old-trip.md shown dimmed from main open ›']);
    expect(section(html, "Won't render on GitHub")).toEqual([
      '✗ README.md:41 setup.md#tokenz · anchor not found',
      '✗ docs/rendered-view.md:18 ./Flow.svg · case mismatch: Flow.svg vs flow.svg',
      '✗ README.md:7 ./notes/draft.png · file is untracked',
    ]);
    // Each finding opens its page at its line.
    expect(html).toContain('<a class="br-row br-row-finding" href="f-dddddddddddddddddddd.html#at=L41&#x26;d=short">');
    expect(html).toMatch(/<ul class="br-rail-stats">\s*<li>4 pages<\/li>\s*<li>1 also looks different<\/li>\s*<li>1 deleted<\/li>\s*<li>3 findings<\/li>\s*<\/ul>/);
    expect(html).toContain('<p class="br-summary">4 pages · 1 also looks different · 1 deleted · 3 findings</p>');
    // The strip says how many links won't resolve, and goes to the list.
    expect(html).toContain('<a class="br-findings" href="#br-findings" data-short="✗ 3">1 broken link · 2 images won\'t render</a>');
  });

  it('matches its snapshot for the whole branch', async () => {
    // The body, less the page script: the stylesheet and the script have
    // tests of their own.
    const html = wholeBranch();
    const body = html.slice(html.indexOf('<body>'), html.indexOf(`<script>${PAGE_SCRIPT}</script>`));
    await expect(body).toMatchFileSnapshot('./fixtures/rendered/overview.html');
  });
});

