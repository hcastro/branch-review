import os from 'node:os';
import {describe, expect, it} from 'vitest';
import {REVIEW_CSS_HASH, REVIEW_HEAD_SCRIPT_HASH, REVIEW_SCRIPT, REVIEW_SCRIPT_HASH} from '../src/rendered/assets.generated.js';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown} from '../src/rendered/markdown.js';
import {drawHunk, escapeText, parseHunks, unpackHtml} from '../src/rendered/review/diff.js';
import {icon} from '../src/rendered/review/icons.js';
import {applyBudgets, assembleReviewPage, reviewPolicy, type ReviewPageCard, type ReviewPageInput} from '../src/rendered/review/page.js';
import {diffFile} from './rendered-helpers.js';

// The Review in browser page as the worker writes it: one self-contained
// document for the whole branch, its policy pinned to our own style and
// scripts, every repo string escaped, one card per changed file in the
// review's order, and what the page script reads carried as inert data.

const PNG = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;

function textCard(path: string, before: string | null, after: string | null, overrides: Partial<ReviewPageCard> = {}): ReviewPageCard {
  const file = diffFile(before, after, path);
  const lines = after?.split('\n') ?? [];
  if (lines.at(-1) === '') lines.pop();
  return {
    path,
    status: file.status,
    additions: 1,
    deletions: 1,
    kind: 'text',
    viewKey: `vk-${path.length}`,
    signature: `sig-${path.length}`,
    diff: {hunks: parseHunks(file.blocks).map((hunk) => drawHunk(hunk)), context: after === null ? null : lines.map(escapeText), total: lines.length},
    ...overrides,
  };
}

async function input(cards: ReviewPageCard[], overrides: Partial<ReviewPageInput> = {}): Promise<ReviewPageInput> {
  return {
    title: {repo: 'widget', base: 'main', branch: 'feature/docs-refresh', worktree: false},
    reviewId: 'r-0123456789abcdef',
    builtAt: Date.UTC(2026, 10, 1, 12),
    state: {kind: 'unpushed'},
    commits: [
      {hash: '7be04d8', subject: 'feat(cli): add a preview command', time: Date.UTC(2026, 10, 1, 11) / 1000, files: 4},
      {hash: 'a3f9c21', subject: 'docs: refresh the README', time: Date.UTC(2026, 10, 1, 11, 48) / 1000, files: 2},
    ],
    cards,
    ...overrides,
  };
}

const head = (html: string) => html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
// The page as drawn, without its data block and its script.
const drawn = (html: string) => html.slice(html.indexOf('<body>'), html.indexOf('<script type="application/json"'));

describe('assembleReviewPage', () => {
  it('opens with a policy that allows only our stylesheet and our two scripts, and loads nothing', async () => {
    const html = assembleReviewPage(await input([textCard('src/a.ts', 'a\n', 'b\n')]));
    expect(head(html)).toMatch(/^<head>\n<meta http-equiv="Content-Security-Policy" content="[^"]+">/);
    expect(reviewPolicy()).toBe(`default-src 'none'; img-src data:; style-src '${REVIEW_CSS_HASH}'; script-src '${REVIEW_HEAD_SCRIPT_HASH}' '${REVIEW_SCRIPT_HASH}'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'`);
    expect(html).toContain(`<script>${REVIEW_SCRIPT}</script>`);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    // One executable script in the body: ours. The data block is inert JSON.
    expect([...html.matchAll(/<script(?: [^>]*)?>/g)].map((match) => match[0])).toEqual(['<script>', '<script type="application/json" id="rv-data">', '<script>']);
  });

  it('draws the app bar, the note, the title with its state, the tabs and the toolbar in words', async () => {
    const html = assembleReviewPage(await input([textCard('src/a.ts', 'a\n', 'b\n'), textCard('README.md', 'x\n', 'y\n')]));
    expect(html).toContain('<span class="rv-wordmark">');
    expect(html).toContain('<span>widget</span>');
    expect(html).toContain('On this machine');
    expect(html).toContain("Your branch's changes, built here on your machine. Nothing leaves this machine.");
    expect(html).toContain('<h1><span>feature/docs-refresh</span><span class="rv-into">into main</span></h1>');
    expect(html).toMatch(/<span class="rv-state rv-state-unpushed">.*Not pushed<\/span>/);
    expect(html).toContain('2 commits on <span class="rv-ref">feature/docs-refresh</span> that are not on <span class="rv-ref">main</span>');
    expect(html).toMatch(/Files changed<span class="rv-count">2<\/span>/);
    expect(html).toMatch(/Commits<span class="rv-count">2<\/span>/);
    expect(html).toContain('Showing changes from <b>all 2 commits</b>');
    expect(html).toContain('files viewed');
    expect(html).toContain('>Unified</button>');
    expect(html).toContain('>Split</button>');
    expect(html).toContain('placeholder="Filter changed files"');
  });

  it('names the state of the branch against its upstream', async () => {
    const pill = async (state: ReviewPageInput['state']) => /<span class="rv-state[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/span>/.exec(assembleReviewPage(await input([], {state})))?.[1] ?? null;
    expect(await pill({kind: 'unpushed'})).toBe('Not pushed');
    expect(await pill({kind: 'ahead', remote: 'origin', count: 3})).toBe('Ahead of origin by 3');
    expect(await pill({kind: 'even', remote: 'upstream'})).toBe('Up to date with upstream');
    expect(await pill({kind: 'behind', remote: 'origin', count: 2})).toBe('Behind origin by 2');
    expect(await pill({kind: 'diverged', remote: 'origin', ahead: 1, behind: 4})).toBe('Ahead 1, behind 4');
    // git didn't say in time: a quiet pill in the same place, never a gap.
    expect(await pill({kind: 'unknown'})).toBe('Branch state unavailable');
    expect(await pill(null)).toBeNull();
  });

  it('lists the commits by day with subjects, short hashes and relative times, and never a name or an email', async () => {
    const html = assembleReviewPage(await input([]));
    const commits = html.slice(html.indexOf('id="panel-commits"'), html.indexOf('id="menu"'));
    expect(commits).toContain('Commits on Nov 1, 2026');
    expect(commits).toContain('<p class="rv-msg">feat(cli): add a preview command</p>');
    expect(commits).toContain('<code class="rv-sha">7be04d8</code>');
    expect(commits).toMatch(/Committed <time data-t="\d+" datetime="[^"]+">1 hour ago<\/time> · 4 files/);
    expect(commits).toMatch(/Committed <time data-t="\d+" datetime="[^"]+">12 minutes ago<\/time> · 2 files/);
    expect(commits).not.toMatch(/@|You committed/);
  });

  it('says so when the commits could not be read, and counts uncommitted work in the toolbar', async () => {
    const html = assembleReviewPage(await input([], {commits: null, title: {repo: 'widget', base: 'main', branch: 'feature', worktree: true}}));
    expect(html).toContain("Couldn't read the commits on this branch.");
    expect(html).toContain('Showing <b>uncommitted changes</b>');
    const both = assembleReviewPage(await input([], {title: {repo: 'widget', base: 'main', branch: 'feature', worktree: true}}));
    expect(both).toContain('Showing changes from <b>all 2 commits</b> and <b>uncommitted changes</b>');
  });

  it('draws one card per file in the review\'s order, each with its anchor, path, counts, Viewed and its menu', async () => {
    const cards = [textCard('src/z.ts', 'a\n', 'b\n'), textCard('docs/a.ts', 'a\n', 'b\n', {additions: 12, deletions: 3})];
    const html = assembleReviewPage(await input(cards));
    const ids = [...html.matchAll(/<section class="rv-card[^"]*" id="(file-\d+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(['file-0', 'file-1']);
    expect(html.indexOf('src/<b>z.ts</b>')).toBeLessThan(html.indexOf('docs/<b>a.ts</b>'));
    expect(html).toContain('<span class="rv-a">+12</span><span class="rv-d">−3</span>');
    expect(html).toContain('<span class="rv-blocks" aria-hidden="true"><i class="g"></i><i class="g"></i><i class="g"></i><i class="g"></i><i class="r"></i></span>');
    expect(html).toContain('<span>Viewed</span>');
    expect(html).toContain('aria-label="More options for docs/a.ts"');
    expect(html).toContain('data-vk="vk-9" data-sig="sig-9"');
    // The tree links each file to its card, so it works with no script at all.
    expect(html).toContain('href="#file-1"');
  });

  it('draws the unified diff as the page arrives, and carries the hunks and context for the script as data with no tag in it', async () => {
    const html = assembleReviewPage(await input([textCard('src/a.ts', 'one\n</script><b>\n', 'one\n</script><i>\n')]));
    expect(html).toContain('<table class="diff uni">');
    expect(html).toContain('&lt;/script&gt;&lt;<span class="x">i</span>&gt;');
    const data = /<script type="application\/json" id="rv-data">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(data).not.toContain('<');
    const parsed = JSON.parse(data) as {id: string; cards: Array<{diff: {hunks: unknown[]; context: string[]}}>};
    expect(parsed.id).toBe('r-0123456789abcdef');
    expect(parsed.cards[0]!.diff.hunks).toHaveLength(1);
    expect(parsed.cards[0]!.diff.context[1]).toBe('&lt;/script&gt;&lt;i&gt;');
  });

  it('escapes every repo string: paths, refs, the repo name, subjects and the function context', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const card = textCard(`docs/${evil}.ts`, 'a\n', 'b\n');
    const html = assembleReviewPage(await input([card], {
      title: {repo: evil, base: `${evil}base`, branch: `${evil}branch`, worktree: false},
      commits: [{hash: 'abc1234', subject: evil, time: 1, files: 1}],
    }));
    expect(html).not.toContain(evil);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('gives a markdown file a Source and a Rich view: the rich one is the rendered fragment with its marks and the fidelity note', async () => {
    const before = '# Widget\n\nA queue.\n';
    const after = '# Widget\n\nA queue, with a preview.\n\nNew paragraph.\n';
    const file = diffFile(before, after, 'README.md');
    const fragment = await renderMarkdown({path: 'README.md', source: after, groups: changeGroups(file), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const card = textCard('README.md', before, after, {kind: 'markdown', rich: {body: {kind: 'rendered', fragment}}});
    const html = assembleReviewPage(await input([card]));
    expect(html).toContain('data-act="view" data-v="source" aria-pressed="true"');
    expect(html).toContain('data-act="view" data-v="rich" aria-pressed="false"');
    const rich = html.slice(html.indexOf('<div class="rv-v-rich"'));
    expect(rich.startsWith('<div class="rv-v-rich" hidden>')).toBe(true);
    expect(rich).toContain('<article class="markdown-body">');
    expect(rich).toContain('data-mark="modified"');
    expect(rich).toContain('≈ GitHub rendering');
    expect(rich).not.toContain('br-raw-source');
  });

  it('says a new markdown file is all new in its rich view, with the Added legend and one bar along it', async () => {
    const after = '# Guide\n\nHello.\n';
    const fragment = await renderMarkdown({path: 'docs/guide.md', status: 'added', source: after, groups: changeGroups(diffFile(null, after, 'docs/guide.md')), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const html = assembleReviewPage(await input([textCard('docs/guide.md', null, after, {kind: 'markdown', rich: {body: {kind: 'rendered', fragment}}})]));
    expect(html).toContain('<b>New file.</b> Everything below is added in this branch.');
    const rich = html.slice(html.indexOf('<div class="rv-v-rich"'));
    expect(rich).toContain('<span class="rv-legend"><i class="rv-l-add"></i>Added</span><details');
    expect(rich).not.toContain('rv-l-mod');
    expect(rich).toContain('<div class="rv-rich rv-all-add"><article class="markdown-body">');
  });

  it('opens an SVG whose pictures failed on its source diff, its rich view saying why', async () => {
    const card = textCard('img/logo.svg', '<svg/>\n', '<svg></svg>\n', {kind: 'svg', imageFailure: "Couldn't show this image: timed out"});
    const html = assembleReviewPage(await input([card]));
    const body = html.slice(html.indexOf('<div class="rv-fb">'), html.indexOf('</section>'));
    expect(body).toContain('<div class="rv-v-src"><div class="rv-tbl">');
    expect(body).toContain('<div class="rv-v-rich" hidden><p class="rv-notice">Couldn&#39;t show this image: timed out</p></div>'.replace('&#39;', "'"));
    expect(html).toContain('data-v="source" aria-pressed="true"');
  });

  it('says an image or a rich view the review hasn\'t rendered yet is on its way', async () => {
    const image: ReviewPageCard = {path: 'img/new.png', status: 'added', additions: 0, deletions: 0, kind: 'raster', viewKey: 'v', signature: 's', diff: null, notice: 'Binary file not shown.', pending: true};
    const doc = textCard('docs/a.md', 'a\n', 'b\n', {kind: 'markdown', rich: {body: {kind: 'pending'}}});
    const html = assembleReviewPage(await input([image, doc]));
    const imageCard = html.slice(html.indexOf('aria-label="img/new.png"'), html.indexOf('aria-label="docs/a.md"'));
    expect(imageCard).toContain('Still being prepared. Press r in branch-review again in a moment to see it.');
    expect(imageCard).not.toContain('Binary file not shown.');
    expect(html.slice(html.indexOf('aria-label="docs/a.md"'))).toContain('<p class="rv-notice">Still being prepared.');
  });

  it('says nothing of lines in the header of an image whose sides aren\'t in yet', async () => {
    const image: ReviewPageCard = {path: 'img/logo.png', status: 'modified', additions: 0, deletions: 0, kind: 'raster', viewKey: 'v', signature: 's', diff: null, notice: 'Binary file not shown.', pending: true};
    const html = assembleReviewPage(await input([image, textCard('src/a.ts', 'a\n', 'b\n')]));
    const header = html.slice(html.indexOf('aria-label="img/logo.png"'), html.indexOf('<div class="rv-fb">'));
    expect(header).not.toContain('rv-fh-stat');
    expect(header).not.toContain('rv-blocks');
    expect(header).not.toContain('+0');
    // A text file keeps its counts.
    expect(html.slice(html.indexOf('aria-label="src/a.ts"'))).toContain('<span class="rv-fh-stat">');
  });

  it('folds a run of folders that each hold one folder into one row of the tree', async () => {
    const html = assembleReviewPage(await input([textCard('src/a/b/c.ts', 'a\n', 'b\n'), textCard('src/a/b/d.ts', 'a\n', 'b\n'), textCard('README.md', 'a\n', 'b\n')]));
    const tree = html.slice(html.indexOf('<ul class="rv-tree" id="tree"'), html.indexOf('</aside>'));
    expect([...tree.matchAll(/<span class="rv-nm">([^<]+)<\/span><\/button>/g)].map((match) => match[1])).toEqual(['src/a/b']);
    expect([...tree.matchAll(/data-path="([^"]+)"/g)].map((match) => match[1])).toEqual(['src/a/b/c.ts', 'src/a/b/d.ts', 'README.md']);
  });

  it('gives markdown that only looks different a card of its own after the changed files, with its rich view and no Viewed box', async () => {
    const source = '# Contributing\n\n![logo](img/logo.png)\n';
    const fragment = await renderMarkdown({path: 'CONTRIBUTING.md', source, groups: [], asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const also: ReviewPageCard = {path: 'CONTRIBUTING.md', status: 'modified', additions: 0, deletions: 0, kind: 'markdown', viewKey: 'v', signature: 's', diff: null, also: ['img/logo.png'], rich: {body: {kind: 'rendered', fragment}}};
    const html = assembleReviewPage(await input([textCard('src/a.ts', 'a\n', 'b\n'), also]));
    expect(html).toMatch(/Files changed<span class="rv-count">1<\/span>/);
    expect(html).toContain('<span id="viewed-of">1</span>');
    const card = html.slice(html.indexOf('<h2 class="rv-also-h">Also looks different</h2>'));
    expect(card).toContain('<section class="rv-card rv-also" id="file-1"');
    expect(card).toContain('<b>Not changed on this branch.</b> It shows <code>img/logo.png</code>, which this branch changed.');
    expect(card.slice(0, card.indexOf('</section>'))).not.toContain('data-act="viewed"');
    expect(html).toContain('<p class="rv-tree-title">Also looks different</p>');
  });

  it('lists what won\'t render on GitHub above the files, each row jumping to its file\'s card', async () => {
    const findings = [
      {path: 'README.md', line: 2, target: 'gone.md', what: 'link' as const, kind: 'missing' as const, reason: 'no such file'},
      {path: 'README.md', line: 6, target: 'Logo.png', what: 'image' as const, kind: 'caseMismatch' as const, reason: 'case mismatch: Logo.png vs logo.png'},
    ];
    const html = assembleReviewPage(await input([textCard('src/a.ts', 'a\n', 'b\n'), textCard('README.md', 'a\n', 'b\n')], {findings}));
    const report = html.slice(html.indexOf('<section class="rv-report"'), html.indexOf('</section>', html.indexOf('<section class="rv-report"')));
    expect(report).toContain("<h2 id=\"report-h\">Won't render on GitHub · 1 broken link · 1 image won't render</h2>");
    expect(report).toContain('<a class="rv-row" href="#file-1" data-act="goto" data-i="1"><code>README.md:2</code><span>gone.md · no such file</span></a>');
    expect(report).toContain('data-act="report-close"');
    expect(html.indexOf('<section class="rv-report"')).toBeLessThan(html.indexOf('id="file-0"'));
    expect(assembleReviewPage(await input([textCard('src/a.ts', 'a\n', 'b\n')]))).not.toContain('<section class="rv-report"');
  });

  it('compares a changed image in 2-up, swipe and onion skin, with each side\'s size', async () => {
    const card: ReviewPageCard = {
      path: 'img/hero.png', status: 'modified', additions: 0, deletions: 0, kind: 'raster', viewKey: 'v', signature: 's', diff: null,
      image: {format: 'raster', before: {kind: 'shown', dataUrl: PNG, mime: 'image/png', bytes: 16_384, width: 600, height: 240}, after: {kind: 'shown', dataUrl: PNG, mime: 'image/png', bytes: 15_360, width: 600, height: 240}},
    };
    const html = assembleReviewPage(await input([card]));
    for (const mode of ['2-up', 'Swipe', 'Onion skin']) expect(html).toContain(`>${mode}</button>`);
    expect(html).toContain('<span class="rv-fh-size">16 KB → 15 KB</span>');
    expect(html).toContain('600 × 240 · 16 KB → 600 × 240 · 15 KB<span class="rv-delta rv-smaller">−1 KB</span>');
    expect(html).toContain(`src="${PNG}"`);
    expect(html).toContain('role="slider"');
    // An image with no text diff is its pictures alone, shown, never behind a view switch.
    const cardHtml = html.slice(html.indexOf('<section class="rv-card"'), html.indexOf('</section>'));
    expect(cardHtml).not.toMatch(/rv-v-(src|rich)/);
  });

  it('shows a new image on its own, and a side the page leaves out as a card that says why', async () => {
    const card: ReviewPageCard = {path: 'img/new.png', status: 'added', additions: 0, deletions: 0, kind: 'raster', viewKey: 'v', signature: 's', diff: null, image: {format: 'raster', before: null, after: {kind: 'card', reason: 'pageLimit'}}};
    const html = assembleReviewPage(await input([card]));
    expect(html).not.toContain('>Swipe</button>');
    expect(html).toContain('class="rv-img-card"');
  });

  it('draws a one-line card for a file with no diff to show', async () => {
    const html = assembleReviewPage(await input([{path: 'bin/tool', status: 'modified', additions: 0, deletions: 0, kind: 'text', viewKey: 'v', signature: 's', diff: null, notice: 'Binary file not shown.'}]));
    expect(html).toContain('<p class="rv-notice">Binary file not shown.</p>');
  });

  it('draws each file with no diff to show as GitHub\'s one line, with its icon and the words for its kind', async () => {
    const special = (path: string, kind: ReviewPageCard['special'], overrides: Partial<ReviewPageCard> = {}): ReviewPageCard => ({path, status: 'modified', additions: 0, deletions: 0, kind: 'text', viewKey: path, signature: 's', diff: null, special: kind, ...overrides});
    const html = assembleReviewPage(await input([
      special('bin/tool', {kind: 'binary'}),
      special('docs/new.md', {kind: 'renamed'}, {status: 'renamed', oldPath: 'docs/<old>.md'}),
      special('bin/run', {kind: 'mode', from: '100644', to: '100755'}),
      special('empty.txt', {kind: 'empty'}, {status: 'added'}),
      special('gone.txt', {kind: 'empty'}, {status: 'deleted'}),
      special('lib', {kind: 'submodule', before: '1'.repeat(40), after: '2'.repeat(40)}),
      special('img/big.psd', {kind: 'lfs', bytes: 2_500_000}),
      special('data/dump.sql', {kind: 'tooLarge', bytes: 5 * 1024 * 1024}),
    ]));
    const line = (kind: string) => new RegExp(`<div class="rv-special rv-special-${kind}"><svg class="ic"[^>]*>[\\s\\S]*?</svg><span>(.*?)</span>(?:<span class="rv-sp-note"><span aria-hidden="true">· </span>(.*?)</span>)?</div>`).exec(html)?.slice(1).filter(Boolean);
    expect(line('binary')).toEqual(['Binary file not shown.']);
    expect(line('renamed')).toEqual(['File renamed without changes.', 'renamed from <code>docs/&lt;old&gt;.md</code>']);
    expect(line('mode')).toEqual(['File mode changed from 100644 to 100755.']);
    expect(html).toContain('<span>Empty file added.</span>');
    expect(html).toContain('<span>Empty file deleted.</span>');
    expect(line('submodule')).toEqual(['Submodule updated from <code>1111111</code> to <code>2222222</code>.']);
    expect(line('lfs')).toEqual(['Git LFS file not shown.', '2.4 MB']);
    expect(line('tooLarge')).toEqual(['This diff is too large to show here. Open the file to see it.', '5.0 MB']);
    expect(drawn(html)).not.toContain('<table');
    // No line counts for a file with no lines to count.
    expect(drawn(html)).not.toContain('rv-fh-stat');
  });

  it('counts no lines in the header of a submodule or a Git LFS pointer, whose lines are git\'s, and counts a diff too large to show', async () => {
    const special = (path: string, kind: ReviewPageCard['special'], additions: number, deletions: number): ReviewPageCard => ({path, status: 'modified', additions, deletions, kind: 'text', viewKey: path, signature: 's', diff: null, special: kind});
    const html = assembleReviewPage(await input([
      special('lib', {kind: 'submodule', before: '1'.repeat(40), after: '2'.repeat(40)}, 1, 1),
      special('img/big.psd', {kind: 'lfs', bytes: 2_500_000}, 2, 2),
      special('data/dump.sql', {kind: 'tooLarge', bytes: 5 * 1024 * 1024}, 70_000, 3),
    ]));
    const header = (path: string) => new RegExp(`<section class="rv-card" id="file-\\d+"[^>]*aria-label="${path}">\\n<div class="rv-fh">([\\s\\S]*?)\\n<div class="rv-fb">`).exec(html)![1]!;
    expect(header('lib')).not.toContain('rv-fh-stat');
    expect(header('img/big.psd')).not.toContain('rv-fh-stat');
    expect(header('data/dump.sql')).toContain('<span class="rv-a">+70000</span><span class="rv-d">−3</span>');
  });

  it('adds up in the Files changed total only the line counts the cards show', async () => {
    const special = (path: string, kind: ReviewPageCard['special'], additions: number, deletions: number): ReviewPageCard => ({path, status: 'modified', additions, deletions, kind: 'text', viewKey: path, signature: 's', diff: null, special: kind});
    const html = assembleReviewPage(await input([
      textCard('src/a.ts', 'a\n', 'b\n'),
      special('lib', {kind: 'submodule', after: '2'.repeat(40)}, 1, 0),
      special('img/big.psd', {kind: 'lfs', bytes: 2_500_000}, 3, 0),
      special('data/dump.sql', {kind: 'tooLarge', bytes: 5 * 1024 * 1024}, 70_000, 3),
      special('vendor/old.js', {kind: 'deleted'}, 0, 600),
    ]));
    expect(html).toContain('<span class="rv-total"><span class="rv-a">+70001</span><span class="rv-d">−604</span>');
  });

  it('gives each one-line card the icon for its kind', async () => {
    const special = (path: string, kind: NonNullable<ReviewPageCard['special']>, status: ReviewPageCard['status'] = 'modified'): ReviewPageCard => ({path, status, additions: 0, deletions: 0, kind: 'text', viewKey: path, signature: 's', diff: null, special: kind});
    const kinds: Array<[NonNullable<ReviewPageCard['special']>, Parameters<typeof icon>[0]]> = [
      [{kind: 'binary'}, 'binary'],
      [{kind: 'empty'}, 'file'],
      [{kind: 'renamed'}, 'arrowSq'],
      [{kind: 'mode', from: '100644', to: '100755'}, 'mode'],
      [{kind: 'submodule', after: '2'.repeat(40)}, 'submodule'],
      [{kind: 'lfs'}, 'lfs'],
      [{kind: 'tooLarge', bytes: 1}, 'alert'],
      [{kind: 'noRoom', bytes: 1}, 'alert'],
      [{kind: 'deleted'}, 'minusSq'],
      [{kind: 'unreadable', reason: 'boom'}, 'alert'],
      [{kind: 'none'}, 'file'],
    ];
    const html = assembleReviewPage(await input(kinds.map(([kind], index) => special(`f${index}`, kind, kind.kind === 'deleted' ? 'deleted' : 'modified'))));
    for (const [kind, name] of kinds) expect(html, kind.kind).toContain(`<div class="rv-special rv-special-${kind.kind}">${icon(name)}<span>`);
  });

  it('says a folded diff the page has no room for is past its room, and a deleted file\'s that it was deleted, each keeping its counts', async () => {
    const special = (path: string, kind: ReviewPageCard['special'], status: ReviewPageCard['status']): ReviewPageCard => ({path, status, additions: 0, deletions: 600, kind: 'text', viewKey: path, signature: 's', diff: null, special: kind});
    const html = assembleReviewPage(await input([special('data/rows.csv', {kind: 'noRoom', bytes: 800 * 1024}, 'modified'), special('vendor/old.js', {kind: 'deleted'}, 'deleted')]));
    expect(html).toContain('<span>This page has no room left for this diff. Open the file to see it.</span><span class="rv-sp-note"><span aria-hidden="true">· </span>800 KB</span>');
    expect(html).toContain('<span>This file was deleted.</span></div>');
    expect(drawn(html).match(/<span class="rv-d">−600<\/span>/g)).toHaveLength(2);
  });

  it('names a mode change that came with changes to the text in the card\'s header', async () => {
    const html = assembleReviewPage(await input([textCard('bin/run', 'a\n', 'b\n', {mode: {from: '100644', to: '100755'}})]));
    expect(html).toContain('<span class="rv-fh-mode" title="File mode changed">100644 → 100755</span>');
  });

  it('folds a long diff behind Load diff, drawing no table of it, its lines in the page\'s data', async () => {
    const long = textCard('pnpm-lock.yaml', 'a\n', 'b\n');
    const gone = textCard('old/dump.sql', 'a\n', null, {status: 'deleted'});
    const html = assembleReviewPage(await input([{...long, diff: {...long.diff!, fold: true}}, {...gone, diff: {...gone.diff!, fold: true}}]));
    expect(drawn(html)).not.toContain('<table');
    expect(html).toContain('<div class="rv-tbl" hidden></div><div class="rv-special rv-load"><button type="button" class="rv-load-btn rv-js" data-act="load">Load diff</button><span>Large diffs are not rendered by default.</span></div>');
    expect(html).toContain('data-act="load">Load diff</button><span>This file was deleted.</span>');
    const data = JSON.parse(/<script type="application\/json" id="rv-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as {cards: Array<{diff: {fold?: true; hunks: unknown[]}}>};
    expect(data.cards.map((each) => [each.diff.fold, each.diff.hunks.length])).toEqual([[true, 1], [true, 1]]);
  });

  it('carries each line once: a drawn table\'s in the table, a folded diff\'s and the context in their short form in the data', async () => {
    const colored = '<span class="pl-k">const</span> a = <span class="pl-c1">2</span>;';
    const card = (fold: boolean) => {
      const each = textCard('src/a.ts', 'const a = 1;\n', 'const a = 2;\n');
      each.diff!.hunks[0]!.lines[1]!.h = colored;
      each.diff!.context = [colored];
      return {...each, diff: {...each.diff!, ...(fold ? {fold: true as const} : {})}};
    };
    const html = assembleReviewPage(await input([card(false), card(true)]));
    expect(drawn(html)).toContain(`<span class="mk">+</span>${colored}`);
    type Packed = {cards: Array<{diff: {hunks: Array<{lines: number | Array<{h: string}>}>; context: string[]}}>};
    const [table, folded] = (JSON.parse(/<script type="application\/json" id="rv-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as Packed).cards;
    expect(table!.diff.hunks[0]!.lines).toBe(2);
    expect(table!.diff.context[0]).toBe('>k>const>> a = >c1>2>>;');
    const lines = folded!.diff.hunks[0]!.lines as Array<{h: string}>;
    expect(lines[1]!.h).toBe('>k>const>> a = >c1>2>>;');
    expect(unpackHtml(lines[1]!.h)).toBe(colored);
  });

  it('names a moved file by both paths', async () => {
    const html = assembleReviewPage(await input([textCard('docs/new.md', 'a\n', 'b\n', {status: 'renamed', oldPath: 'docs/old.md'})]));
    expect(html).toContain('<span class="rv-from">docs/old.md → </span>docs/<b>new.md</b>');
  });

  it('never prints an absolute home path', async () => {
    const html = assembleReviewPage(await input([textCard('src/a.ts', 'a\n', 'b\n')]));
    expect(html).not.toContain(os.homedir());
  });
});

describe('applyBudgets', () => {
  // The context budget is the builder's, which colors only what the page
  // carries: tests/review-build.test.ts.

  it('inlines images up to 32 MiB a page and turns the rest into cards that say so', () => {
    // Counted in data URL characters, as the renderer counts a markdown page's.
    const side = (bytes: number) => ({kind: 'shown' as const, dataUrl: dataUrlOf(bytes), mime: 'image/png', bytes});
    const image = (path: string, bytes: number): ReviewPageCard => ({path, status: 'modified', additions: 0, deletions: 0, kind: 'raster', viewKey: 'v', signature: 's', diff: null, image: {format: 'raster', before: side(bytes), after: side(bytes)}});
    const cards = applyBudgets([image('a.png', 5 * 1024 * 1024), image('b.png', 5 * 1024 * 1024), image('c.png', 5 * 1024 * 1024)]);
    expect(cards.map((card) => [card.image!.before!.kind, card.image!.after!.kind])).toEqual([['shown', 'shown'], ['shown', 'shown'], ['card', 'card']]);
    expect(cards[2]!.image!.after).toEqual({kind: 'card', reason: 'pageLimit'});
  });

  it('keeps one image budget for the page across rich views and image cards, in the review\'s order', async () => {
    // Each rich view's render keeps to 32 MiB on its own: two images of 10 MiB each.
    const url = dataUrlOf(7.5 * 1024 * 1024);
    expect(url.length).toBeGreaterThan(10 * 1024 * 1024);
    const doc = async (path: string) => {
      const source = `# ${path}\n\n![first](a.png)\n\n![<b>second</b>](b.png)\n`;
      const fragment = await renderMarkdown({path, source, groups: [], asset: async (repoPath) => ({kind: 'embed', mime: 'image/png', dataUrl: url, oid: repoPath}), link: () => ({kind: 'outside'})});
      expect(fragment.html.split(url).length - 1).toBe(2);
      return textCard(path, 'a\n', 'b\n', {kind: 'markdown', rich: {body: {kind: 'rendered', fragment}}});
    };
    const side = {kind: 'shown' as const, dataUrl: dataUrlOf(2 * 1024 * 1024, 'B'), mime: 'image/png', bytes: 2 * 1024 * 1024};
    const hero: ReviewPageCard = {path: 'img/hero.png', status: 'modified', additions: 0, deletions: 0, kind: 'raster', viewKey: 'v', signature: 's', diff: null, image: {format: 'raster', before: side, after: side}};
    const html = assembleReviewPage(await input([await doc('docs/a.md'), await doc('docs/b.md'), hero]));
    // Three of the four fit 32 MiB; the fourth, and the image after it, don't.
    expect(html.split(url).length - 1).toBe(3);
    const second = html.slice(html.indexOf('aria-label="docs/b.md"'), html.indexOf('aria-label="img/hero.png"'));
    expect(second).toContain('<span class="br-card br-soft" role="img" aria-label="image not inlined · page limit · &lt;b&gt;second&lt;/b&gt;">image not inlined · page limit · &lt;b&gt;second&lt;/b&gt;</span>');
    // The alt's markup is text, and no piece of the tag is left behind.
    expect(second).not.toContain('<b>second');
    expect(second).not.toContain('</b>"');
    expect(html.includes(side.dataUrl)).toBe(false);
    expect(html.slice(html.indexOf('aria-label="img/hero.png"'))).toContain('image not inlined · page limit');
    expect(html.length).toBeLessThan(33 * 1024 * 1024);
  });
});

// A data URL as long as the base64 of `bytes` bytes, all one digit.
function dataUrlOf(bytes: number, digit = 'A') {
  return `data:image/png;base64,${digit.repeat(Math.ceil(bytes / 3) * 4)}`;
}
