import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {runOperationAsync, untrackedStateOperation} from '../src/git.js';
import {createAssetResolver, LATE_IDENTITY, pageLookups, type AssetResolver, type AssetSides, type AssetUse} from '../src/rendered/assets.js';
import type {FragmentResult} from '../src/rendered/backend.js';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown, type LinkAnswer, type RenderedFragment} from '../src/rendered/markdown.js';
import {assembleFilePage, type PageInput} from '../src/rendered/page.js';
import {appearances, findingNotes, linkReport, type ReportSource} from '../src/rendered/report.js';
import type {RunOperation} from '../src/rendered/tree.js';
import {createRenderedHandler} from '../src/rendered/worker/handler.js';
import {cleanupTempDirs, commitAll, git, initRepo} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';
import {diffFile} from './rendered-helpers.js';

// The link and anchor report: every link and image on the review's pages
// that won't resolve on GitHub, found against the other pages' anchors and
// against what git holds, with the line it sits on.

afterEach(cleanupTempDirs);

const TITLE: PageInput['title'] = {repo: 'project', base: 'main', branch: 'feature', worktree: false, renderedAt: 0};
const outside = (): LinkAnswer => ({kind: 'outside'});
const skipped = async () => ({kind: 'skipped'} as const);

const source = (fragment: RenderedFragment, page: string, status: ReportSource['status'] = 'modified'): ReportSource => ({path: page, status, ...fragment});

function writeBytes(repo: string, file: string, bytes: Buffer | string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), {recursive: true});
  fs.writeFileSync(path.join(repo, file), bytes);
}

describe('the link and anchor report', () => {
  it('checks an anchor against the slugs of the page it names, and marks a broken one on the page', async () => {
    const guide = await renderMarkdown({path: 'docs/guide.md', source: '# Guide\n\n## Install it\n\n<a name="old-name"></a>Text.\n', groups: [], asset: skipped, link: outside});
    const links = (repoPath: string): LinkAnswer => (repoPath === 'docs/guide.md' ? {kind: 'inReview', href: 'f-guide.html'} : outside());
    const readme = await renderMarkdown({
      path: 'README.md',
      source: [
        'See [install](docs/guide.md#install-it), [the old name](docs/guide.md#old-name)',
        'and [tokens](docs/guide.md#tokenz).',
        '',
        '## Here',
        '',
        'Up to [here](#here), down to [nowhere](#nowhere), and [the guide](docs/guide.md).',
        '',
      ].join('\n'),
      groups: [],
      asset: skipped,
      link: links,
    });
    expect(guide.anchors).toEqual(expect.arrayContaining(['user-content-guide', 'user-content-install-it', 'user-content-old-name']));

    const {findings, broken} = linkReport([source(readme, 'README.md'), source(guide, 'docs/guide.md')]);
    expect(findings).toEqual([
      {path: 'README.md', line: 2, target: 'docs/guide.md#tokenz', what: 'link', kind: 'badAnchor', reason: 'anchor not found'},
      {path: 'README.md', line: 6, target: '#nowhere', what: 'link', kind: 'badAnchor', reason: 'anchor not found'},
    ]);

    // On the page, the link to the missing anchor is drawn broken and still
    // opens the page; the others are plain links.
    const html = assembleFilePage({title: TITLE, file: {path: 'README.md', status: 'modified', body: {kind: 'rendered', fragment: readme}}, rail: [], brokenRefs: broken.get('README.md') ?? []});
    expect(html).toContain('<a href="f-guide.html#user-content-tokenz" class="br-broken" title="anchor not found">tokens</a>');
    expect(html).toContain('<a href="f-guide.html#user-content-install-it">install</a>');
    expect(html).toContain('<a href="f-guide.html#user-content-old-name">the old name</a>');
    expect(html).toContain('<a href="#nowhere" class="br-broken" title="anchor not found">nowhere</a>');
    expect(html).not.toMatch(/data-br[a-z]{16}/);
  });

  it('finds a link to a missing, untracked or ignored file and one whose case differs, and passes a folder or a tracked file', async () => {
    const repo = initRepo({'.gitignore': 'secret/\n', 'LICENSE': 'MIT\n', 'docs/setup.md': '# Setup\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'README.md', 'changed\n');
    commitAll(repo, 'feature');
    writeBytes(repo, 'notes/draft.md', 'draft\n');
    writeBytes(repo, 'secret/keys.md', 'keys\n');
    const sides: AssetSides = {base: 'main...feature', after: {tree: 'feature'}, epoch: 0};
    const lookups = pageLookups(createAssetResolver({cwd: repo}), sides, false);
    const readme = await renderMarkdown({
      path: 'README.md',
      source: [
        '- [license](LICENSE)',
        '- [docs](docs/) and [docs again](./docs)',
        '- [setup](docs/setup.md#setup)',
        '- [gone](docs/gone.md)',
        '- [draft](notes/draft.md)',
        '- [keys](secret/keys.md)',
        '- [Setup](Docs/Setup.md)',
        '- [site](https://example.com/x.md)',
        '',
      ].join('\n'),
      groups: [],
      ...lookups,
      link: lookups.linkTarget,
    });

    const {findings} = linkReport([source(readme, 'README.md')]);
    expect(findings).toEqual([
      {path: 'README.md', line: 4, target: 'docs/gone.md', what: 'link', kind: 'missing', reason: 'file not found'},
      {path: 'README.md', line: 5, target: 'notes/draft.md', what: 'link', kind: 'untracked', reason: 'file is untracked'},
      {path: 'README.md', line: 6, target: 'secret/keys.md', what: 'link', kind: 'ignored', reason: 'ignored by git'},
      {path: 'README.md', line: 7, target: 'Docs/Setup.md', what: 'link', kind: 'caseMismatch', reason: 'case mismatch: Docs/Setup.md vs docs/setup.md'},
    ]);
    // A file git tracks outside the review is a link that works on GitHub,
    // inert here; one that won't resolve is drawn broken.
    expect(readme.html).toContain('<a class="br-inert" title="not part of this review">license</a>');
    expect(readme.html).toContain('<a class="br-inert br-broken" title="file is untracked">draft</a>');
    expect(readme.html).toContain('<a class="br-inert br-broken" title="case mismatch: Docs/Setup.md vs docs/setup.md">Setup</a>');
  });

  it('claims nothing of a link whose check runs past the budget, and has the page asked for again', async () => {
    const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    const slow = {
      linkTarget: () => ({known: later(600, {kind: 'missing'} as const), checked: later(600, {kind: 'missing'} as const)}),
    } as unknown as AssetResolver;
    const uses: AssetUse[] = [];
    const lookups = pageLookups(slow, {base: 'main', after: {tree: 'feature'}, epoch: 0}, false, uses, {budgetMs: 50});
    const page = await renderMarkdown({path: 'README.md', source: 'See [gone](docs/gone.md).\n', groups: [], asset: skipped, link: lookups.linkTarget});
    expect(page.links.map((link) => link.status)).toEqual(['unchecked']);
    // Neither a file outside the review nor a broken link: plain text.
    expect(page.html).toContain('<a class="br-unchecked" title="not checked in time">gone</a>');
    expect(page.html).not.toContain('br-inert');
    expect(page.differences).toEqual([]);
    expect(linkReport([source(page, 'README.md')]).findings).toEqual([]);
    expect(uses).toEqual([{side: 'after', path: 'docs/gone.md', identity: LATE_IDENTITY}]);
  }, 10_000);

  it('finds every missing file a link-heavy page names, from the trees alone when git is slow to say more', async () => {
    const repo = initRepo({'README.md': '# Project\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'CHANGES.md', 'changed\n');
    commitAll(repo, 'feature');
    // Every question about the work tree takes 400 ms, and the most at once is recorded.
    let running = 0;
    let most = 0;
    const slowWorkTree: RunOperation = async (operation, scope) => {
      if (Object.getPrototypeOf(operation) !== untrackedStateOperation.prototype) return runOperationAsync(operation, scope);
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 400));
      running -= 1;
      return runOperationAsync(operation, scope);
    };
    const sides: AssetSides = {base: 'main...feature', after: {tree: 'feature'}, epoch: 0};
    const resolver = createAssetResolver({cwd: repo, run: slowWorkTree});
    // The tree is read before the page's budget starts.
    await resolver.linkTarget(sides, 'README.md').checked;
    const uses: AssetUse[] = [];
    const lookups = pageLookups(resolver, sides, false, uses, {budgetMs: 300});
    const text = Array.from({length: 40}, (_, index) => `- [${index}](docs/missing-${index}.md)`).join('\n');
    const page = await renderMarkdown({path: 'CHANGES.md', source: `${text}\n`, groups: [], asset: skipped, link: lookups.linkTarget});
    expect(page.links.map((link) => link.status)).toEqual(Array.from({length: 40}, () => 'missing'));
    expect(linkReport([source(page, 'CHANGES.md')]).findings).toHaveLength(40);
    expect(page.html).not.toContain('not part of this review');
    // git's word is still owed, so the page renders again for it.
    expect(uses.some((use) => use.identity === LATE_IDENTITY)).toBe(true);
    expect(most).toBeLessThanOrEqual(6);
  }, 20_000);

  it('makes a fragment whose link check ran out of time late, and the next ask claims what the trees say', async () => {
    const repo = initRepo({'README.md': '# Project\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'CHANGES.md', 'See [gone](docs/gone.md).\n');
    commitAll(repo, 'feature');
    const handler = createRenderedHandler({lookupBudgetMs: 0});
    const ask = async () => await handler.handle({
      type: 'fragment',
      cwd: repo,
      key: 'changes-key',
      path: 'CHANGES.md',
      status: 'added',
      source: {kind: 'blob', id: git(repo, 'rev-parse', 'feature:CHANGES.md').trim()},
      groups: [],
      links: {},
      assets: {base: 'main...feature', after: {tree: 'feature'}, epoch: 0},
    }) as FragmentResult & {ok: true};
    // Before git read the tree, nothing is known of the link.
    const first = await ask();
    expect(first.summary.links.map((link) => link.status)).toEqual(['unchecked']);
    expect(first.summary.late).toBe(true);
    // Asked again, as the service asks a late page again: once git has read
    // the tree, the link is missing, and no answer before then claims more.
    const statuses: string[] = [];
    for (let tries = 0; tries < 100 && statuses.at(-1) !== 'missing'; tries += 1) {
      statuses.push(...(await ask()).summary.links.map((link) => link.status));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(statuses.at(-1)).toBe('missing');
    expect(statuses.every((status) => status === 'unchecked' || status === 'missing')).toBe(true);
  }, 20_000);

  it('lists a page\'s findings by line, images and links together', () => {
    const page: ReportSource = {
      path: 'README.md',
      status: 'modified',
      links: [{href: 'gone.md', status: 'missing', line: 5}],
      images: [{path: 'logo.png', url: 'logo.png', line: 2, status: 'missing'}],
      anchors: [],
    };
    expect(linkReport([page]).findings.map((finding) => [finding.line, finding.what])).toEqual([[2, 'image'], [5, 'link']]);
  });

  it('lists an image GitHub won\'t show, by the path as written, and leaves offline cards and a deleted page out', async () => {
    const repo = initRepo({'docs/flow.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'docs/hero.png', pngFixture(2, 2));
    commitAll(repo, 'hero');
    writeBytes(repo, 'notes/draft.png', pngFixture(2, 2));
    const sides: AssetSides = {base: 'main...feature', after: {tree: 'feature'}, epoch: 0};
    const lookups = pageLookups(createAssetResolver({cwd: repo}), sides, false);
    const text = '![flow](./Flow.svg)\n\n![hero](hero.png)\n\n![draft](../notes/draft.png)\n\n![badge](https://img.shields.io/x.svg)\n';
    const page = await renderMarkdown({path: 'docs/page.md', source: text, groups: [], ...lookups, link: lookups.linkTarget});
    expect(page.images).toEqual([
      {path: 'docs/Flow.svg', url: './Flow.svg', line: 1, status: 'caseMismatch', hint: 'Flow.svg vs flow.svg'},
      {path: 'docs/hero.png', url: 'hero.png', line: 3, status: 'embed'},
      {path: 'notes/draft.png', url: '../notes/draft.png', line: 5, status: 'untracked'},
    ]);
    const gone = await renderMarkdown({path: 'old.md', source: '[x](nowhere.md)\n', groups: [], ...lookups, link: lookups.linkTarget});

    const {findings} = linkReport([source(page, 'docs/page.md'), source(gone, 'old.md', 'deleted')]);
    expect(findings).toEqual([
      {path: 'docs/page.md', line: 1, target: './Flow.svg', what: 'image', kind: 'caseMismatch', reason: 'case mismatch: Flow.svg vs flow.svg'},
      {path: 'docs/page.md', line: 5, target: '../notes/draft.png', what: 'image', kind: 'untracked', reason: 'file is untracked'},
    ]);
  });

  it('checks a link into a markdown file outside the review against the headings git holds for it', async () => {
    const repo = initRepo({'docs/guide.md': '# Guide\n\n## Install\n\n<a name="Old-Name"></a>Text.\n', 'LICENSE': 'MIT\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'CHANGES.md', 'changed\n');
    commitAll(repo, 'feature');
    const text = [
      '- [install](docs/guide.md#instal)',
      '- [install](docs/guide.md#install) and [its capitals](docs/guide.md#Install)',
      '- [the old name](docs/guide.md#Old-Name) and [its top](docs/guide.md#TOP)',
      '- [the license](LICENSE#nowhere) and [the guide](docs/guide.md)',
      '',
    ].join('\n');
    // At a ref, and in a work tree review, where the guide is on disk as the base holds it.
    const sides: AssetSides[] = [{base: 'main...feature', after: {tree: 'feature'}, epoch: 0}, {base: 'main', after: {worktree: [{path: 'CHANGES.md', id: null, mode: 'regular'}]}, epoch: 0}];
    for (const each of sides) {
      const lookups = pageLookups(createAssetResolver({cwd: repo}), each, false);
      const changes = await renderMarkdown({path: 'CHANGES.md', source: text, groups: [], ...lookups, link: lookups.linkTarget});
      const {findings} = linkReport([source(changes, 'CHANGES.md')]);
      expect(findings, JSON.stringify(each.after)).toEqual([
        {path: 'CHANGES.md', line: 1, target: 'docs/guide.md#instal', what: 'link', kind: 'badAnchor', reason: 'anchor not found'},
      ]);
      expect(changes.links.map((link) => link.status)).toEqual(['badAnchor', 'outside', 'outside', 'outside', 'outside', 'outside', 'outside']);
      expect(changes.html).toContain('<a class="br-inert br-broken" title="anchor not found">install</a>');
    }
  });

  it('takes #top in any case for the top of the page, and a heading in other capitals as GitHub does', async () => {
    const guide = await renderMarkdown({path: 'docs/guide.md', source: '# Guide\n\n## Install it\n', groups: [], asset: skipped, link: outside});
    const links = (repoPath: string): LinkAnswer => (repoPath === 'docs/guide.md' ? {kind: 'inReview', href: 'f-guide.html'} : outside());
    const readme = await renderMarkdown({
      path: 'README.md',
      source: '## Here\n\n[back to top](#top), [Top again](#TOP), [here](#Here), [its top](docs/guide.md#top) and [install](docs/guide.md#Install-It).\n',
      groups: [],
      asset: skipped,
      link: links,
    });
    const {findings, broken} = linkReport([source(readme, 'README.md'), source(guide, 'docs/guide.md')]);
    expect(findings).toEqual([]);
    expect(readme.links.map((link) => link.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const html = assembleFilePage({title: TITLE, file: {path: 'README.md', status: 'modified', body: {kind: 'rendered', fragment: readme}}, rail: [], brokenRefs: broken.get('README.md') ?? []});
    expect(html.slice(html.indexOf('<article'), html.indexOf('</article>'))).not.toContain('br-broken');
    expect(html).toContain('<a href="#top">back to top</a>');
    expect(html).toContain('<a href="#user-content-here">here</a>');
  });

  it('draws a link to a missing heading broken over the class and title the repo gave it', async () => {
    const guide = await renderMarkdown({path: 'docs/guide.md', source: '# Guide\n', groups: [], asset: skipped, link: outside});
    const links = (repoPath: string): LinkAnswer => (repoPath === 'docs/guide.md' ? {kind: 'inReview', href: 'f-guide.html'} : outside());
    const readme = await renderMarkdown({
      path: 'README.md',
      source: '[read](docs/guide.md#nope "Readme") and <a class="data-footnote-backref" href="docs/guide.md#gone">back</a> and [plain](docs/guide.md#none).\n',
      groups: [],
      asset: skipped,
      link: links,
    });
    const {broken} = linkReport([source(readme, 'README.md'), source(guide, 'docs/guide.md')]);
    const html = assembleFilePage({title: TITLE, file: {path: 'README.md', status: 'modified', body: {kind: 'rendered', fragment: readme}}, rail: [], brokenRefs: broken.get('README.md') ?? []});
    const tags = [...html.matchAll(/<a [^>]*href="f-guide\.html[^>]*>/g)].map((match) => match[0]);
    expect(tags).toEqual([
      '<a href="f-guide.html#user-content-nope" title="anchor not found" class="br-broken">',
      '<a class="data-footnote-backref br-broken" href="f-guide.html#user-content-gone" title="anchor not found">',
      '<a href="f-guide.html#user-content-none" class="br-broken" title="anchor not found">',
    ]);
  });

  it('draws no link broken where the report finds nothing: old text, a deleted page, a page that also looks different', async () => {
    const before = 'See the [old notes](gone.md) and [up](#nowhere), in full.\n\nKeep.\n\nDrop [this](#nowhere) and [that](gone.md).\n';
    const after = 'See the old notes and up, in full.\n\nKeep.\n';
    const missing = (): LinkAnswer => ({kind: 'missing'});
    const changed = await renderMarkdown({path: 'doc.md', source: after, groups: changeGroups(diffFile(before, after)), asset: skipped, link: missing});
    expect(changed.html).toContain('class="br-before"');
    expect(changed.html).toContain('class="br-removed"');
    expect(linkReport([source(changed, 'doc.md')]).findings).toEqual([]);
    expect(changed.html).not.toContain('br-broken');
    expect(changed.html).toContain('<a class="br-inert" title="file not found">old notes</a>');

    const deleted = await renderMarkdown({path: 'doc.md', status: 'deleted', source: before, groups: [], asset: skipped, link: missing});
    const also = await renderMarkdown({path: 'doc.md', textUnchanged: true, source: before, groups: [], asset: skipped, link: missing});
    expect(linkReport([source(deleted, 'doc.md', 'deleted')]).findings).toEqual([]);
    for (const fragment of [deleted, also]) expect(fragment.html).not.toContain('br-broken');
  });

  it('says the findings in a few words, links first, images by their reason', () => {
    const finding = (what: 'link' | 'image', kind: 'missing' | 'caseMismatch' | 'untracked') => ({path: 'a.md', line: 1, target: 'x', what, kind, reason: ''});
    expect(findingNotes([])).toEqual([]);
    expect(findingNotes([finding('link', 'missing')])).toEqual(['1 link won\'t resolve']);
    expect(findingNotes([finding('link', 'missing'), finding('link', 'untracked'), finding('image', 'caseMismatch')])).toEqual(['2 links won\'t resolve', '1 image: case mismatch']);
    expect(findingNotes([finding('image', 'caseMismatch'), finding('image', 'untracked'), finding('image', 'untracked')])).toEqual(['2 images: file is untracked', '1 image: case mismatch']);
  });

  it('says where the pages show an image, once a line, leaving out a deleted page', () => {
    const use = (imagePath: string, line: number) => ({path: imagePath, url: imagePath, line, status: 'embed' as const});
    expect(appearances([
      {path: 'README.md', status: 'modified', images: [use('docs/hero.png', 18), use('docs/hero.png', 18), use('docs/flow.svg', 20)]},
      {path: 'docs/old.md', status: 'deleted', images: [use('docs/hero.png', 3)]},
      {path: 'CONTRIBUTING.md', images: [use('docs/hero.png', 5)]},
    ], 'docs/hero.png')).toEqual([{path: 'README.md', line: 18}, {path: 'CONTRIBUTING.md', line: 5}]);
  });
});

