import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {FileStatus} from '../src/git.js';
import {HEAD_SCRIPT, PAGE_SCRIPT} from '../src/rendered/assets.generated.js';
import type {FragmentRequest, FragmentResult, PageResult} from '../src/rendered/backend.js';
import {describeImage, imageFacts, type ImageBody} from '../src/rendered/image.js';
import {assembleFilePage, type PageInput} from '../src/rendered/page.js';
import {createRenderedHandler} from '../src/rendered/worker/handler.js';
import {cleanupTempDirs, commitAll, git, initRepo} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';

// An image or SVG file's page: its sides inlined under the asset rule,
// compared side by side, by flipping, or as a difference, with their sizes
// and where the review's markdown shows the file.

afterEach(cleanupTempDirs);

const RED = pngFixture(3, 2, [200, 40, 40, 255]);
const BLUE = pngFixture(4, 5, [40, 40, 200, 255]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><script>alert(1)</script><rect width="20" height="10"/></svg>';
const TITLE: PageInput['title'] = {repo: 'project', base: 'main', branch: 'feature', worktree: false, renderedAt: 0};

const shown = (bytes: Buffer | string, mime: string, width: number, height: number) => ({kind: 'shown' as const, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, mime, bytes: Buffer.byteLength(bytes), width, height});

function imagePage(status: FileStatus, image: ImageBody, extra: Partial<PageInput> = {}) {
  return assembleFilePage({title: TITLE, file: {path: 'docs/hero.png', status, body: {kind: 'image', image}}, rail: [], ...extra});
}

const withoutScripts = (html: string) => html.replace(`<script>${HEAD_SCRIPT}</script>`, '').replace(`<script>${PAGE_SCRIPT}</script>`, '');
// The page's markup: its body, less its script.
const markup = (html: string) => withoutScripts(html.slice(html.indexOf('<body>')));

function writeBytes(repo: string, file: string, bytes: Buffer | string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), {recursive: true});
  fs.writeFileSync(path.join(repo, file), bytes);
}

describe('an image page', () => {
  it('shows a modified image side by side, with each side\'s size, the three compare modes and where it appears', () => {
    const image: ImageBody = {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: shown(BLUE, 'image/png', 4, 5)};
    const html = imagePage('modified', image, {appears: [{path: 'README.md', line: 18, href: 'f-readme.html'}, {path: 'docs/notes.md', line: 4, href: null}]});
    expect(html).toContain(`<p class="br-summary"><span class="br-status br-status-modified">M</span> · 3×2 · ${RED.length} B → 4×5 · ${BLUE.length} B</p>`);
    expect(html).toContain('<section class="br-image-page" data-mode="side">');
    expect(html).toMatch(/<figure class="br-figure br-before"><figcaption>before · <span class="br-ref">main<\/span><\/figcaption><div class="br-frame"><img alt="before: hero.png" src="data:image\/png;base64,[^"]+" width="3" height="2"><\/div>/);
    expect(html).toMatch(/<figure class="br-figure br-after"><figcaption>after · <span class="br-ref">feature<\/span><\/figcaption><div class="br-frame"><img alt="after: hero.png" src="data:image\/png;base64,[^"]+" width="4" height="5"><\/div>/);
    // The compare keys match the TUI's digits, and need the page script.
    expect(html).toMatch(/<div class="br-modes br-js" role="toolbar" aria-label="Compare" hidden>.*<kbd>1<\/kbd> side by side.*<kbd>2<\/kbd> flip.*<kbd>3<\/kbd> difference/s);
    expect(html).toContain('checkerboard');
    expect(html).toContain('<p class="br-appears">appears in <a href="f-readme.html#at=L18&#x26;d=short">README.md:18</a> · <span>docs/notes.md:4</span></p>');
    expect(markup(html)).not.toContain('class="markdown-body');
    expect(withoutScripts(html)).not.toMatch(/<script|\sstyle=|\son[a-z]+=/i);
  });

  it('puts an added image alone on a checkerboard, and a deleted one dimmed under its banner, with no compare modes', () => {
    const added = imagePage('added', {format: 'raster', before: null, after: shown(RED, 'image/png', 3, 2)});
    expect(added).toContain('<p class="br-banner br-banner-added">new file</p>');
    expect(added).toContain('<section class="br-image-page br-single" data-mode="side">');
    expect(added).toMatch(/<figure class="br-figure br-after"><figcaption>added · <span class="br-ref">feature<\/span><\/figcaption><div class="br-frame">/);
    expect(markup(added)).not.toContain('br-modes');
    expect(markup(added)).not.toContain('br-before');

    const deleted = imagePage('deleted', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: null});
    expect(deleted).toContain('deleted on this branch · shown from main');
    expect(deleted).toContain('<section class="br-image-page br-single br-deleted" data-mode="side">');
    expect(deleted).toMatch(/<figure class="br-figure br-before"><figcaption>deleted · <span class="br-ref">main<\/span><\/figcaption>/);
    expect(markup(deleted)).not.toContain('br-modes');
  });

  it('draws an SVG as an image from a data URI, never as markup of its own', () => {
    const html = imagePage('added', {format: 'svg', before: null, after: shown(SVG, 'image/svg+xml', 20, 10)});
    expect(html).toContain(`src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}"`);
    expect(markup(html)).not.toMatch(/<svg[\s>]|<script|alert\(1\)/);
  });

  it('shows a card in place of a side the page can\'t inline, saying why', () => {
    const html = imagePage('modified', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: {kind: 'card', reason: 'tooLarge'}});
    expect(html).toContain('<div class="br-frame br-frame-card"><span class="br-card br-soft">image not inlined · page limit · o opens it in branch-review</span></div>');
    // Nothing to compare against: the modes are off.
    expect(markup(html)).not.toContain('br-modes');
    const lfs = imagePage('modified', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: {kind: 'card', reason: 'lfs'}});
    expect(lfs).toContain('<span class="br-card br-refused">won\'t render on GitHub: LFS object · not fetched</span>');
  });

  it('says each side\'s dimensions and size, or the one side a new or deleted file has', () => {
    expect(describeImage(imageFacts({format: 'raster', before: shown(Buffer.alloc(86_016), 'image/png', 1200, 480), after: shown(Buffer.alloc(93_184), 'image/png', 1200, 520)}))).toBe('1200×480 · 84 KB → 1200×520 · 91 KB');
    expect(describeImage(imageFacts({format: 'svg', before: null, after: shown(Buffer.alloc(22_528), 'image/svg+xml', 1200, 480)}))).toBe('1200×480 · 22 KB');
    expect(describeImage(imageFacts({format: 'raster', before: shown(Buffer.alloc(2_500_000), 'image/png', 10, 10), after: {kind: 'card', reason: 'tooLarge'}}))).toBe('10×10 · 2.4 MB → not shown');
  });
});

describe('an image page in the worker', () => {
  async function pageFor(repo: string, request: Omit<FragmentRequest, 'cwd' | 'key' | 'source' | 'groups' | 'links'>) {
    const handler = createRenderedHandler();
    const fragment: FragmentRequest = {cwd: repo, key: `key-${request.path}`, source: {kind: 'none', reason: 'an image'}, groups: [], links: {}, ...request};
    const summary = await handler.handle({type: 'fragment', ...fragment}) as FragmentResult;
    const page = await handler.handle({type: 'page', key: 'k', title: TITLE, file: {path: request.path, status: request.status}, rail: [], content: {fragment}}) as PageResult;
    return {summary, page};
  }

  it('reads both sides of a modified PNG at their refs, and only the new side of an added SVG', async () => {
    const repo = initRepo();
    writeBytes(repo, 'docs/hero.png', RED);
    commitAll(repo, 'red');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'docs/hero.png', BLUE);
    writeBytes(repo, 'docs/flow.svg', SVG);
    commitAll(repo, 'blue');
    const assets = {base: 'main...feature', after: {tree: 'feature'}, epoch: 0};

    const hero = await pageFor(repo, {path: 'docs/hero.png', status: 'modified', kind: 'raster', assets});
    expect(hero.summary).toMatchObject({ok: true, summary: {kind: 'image', image: {before: {width: 3, height: 2, bytes: RED.length}, after: {width: 4, height: 5, bytes: BLUE.length}}}});
    expect(hero.page.ok && hero.page.html).toContain(`src="data:image/png;base64,${RED.toString('base64')}"`);
    expect(hero.page.ok && hero.page.html).toContain(`src="data:image/png;base64,${BLUE.toString('base64')}"`);

    const flow = await pageFor(repo, {path: 'docs/flow.svg', status: 'added', kind: 'svg', assets});
    expect(flow.summary).toMatchObject({ok: true, summary: {kind: 'image', image: {after: {width: 20, height: 10}}}});
    expect(flow.summary.ok && flow.summary.summary.image?.before).toBeUndefined();
    expect(flow.page.ok && flow.page.html).toContain(`src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}"`);
  });

  it('reads only the base side of a deleted PNG, and a moved one\'s base side where it was', async () => {
    const repo = initRepo();
    writeBytes(repo, 'docs/gone.png', RED);
    writeBytes(repo, 'docs/old.png', BLUE);
    commitAll(repo, 'images');
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'rm', '-q', 'docs/gone.png');
    git(repo, 'mv', 'docs/old.png', 'docs/new.png');
    commitAll(repo, 'delete and move');
    const assets = {base: 'main...feature', after: {tree: 'feature'}, epoch: 0};

    const gone = await pageFor(repo, {path: 'docs/gone.png', status: 'deleted', kind: 'raster', assets});
    expect(gone.summary).toMatchObject({ok: true, summary: {kind: 'image', image: {before: {width: 3, height: 2, bytes: RED.length}}}});
    expect(gone.summary.ok && gone.summary.summary.image?.after).toBeUndefined();
    const deleted = gone.page.ok ? markup(gone.page.html) : '';
    expect(deleted).toContain(`src="data:image/png;base64,${RED.toString('base64')}"`);
    expect(deleted).not.toContain('br-figure br-after');
    expect(deleted).not.toContain('br-card');

    const moved = await pageFor(repo, {path: 'docs/new.png', oldPath: 'docs/old.png', status: 'renamed', kind: 'raster', assets});
    expect(moved.summary).toMatchObject({ok: true, summary: {kind: 'image', image: {before: {width: 4, height: 5}, after: {width: 4, height: 5}}}});
    const both = moved.page.ok ? markup(moved.page.html) : '';
    expect(both.split(`src="data:image/png;base64,${BLUE.toString('base64')}"`)).toHaveLength(3);
    expect(both).not.toContain('br-card');
  });
});

describe('the keys an image page offers', () => {
  const railKeys = (html: string) => [...html.matchAll(/<dl class="br-rail-keys br-js" hidden>(.*?)<\/dl>/g)].map((match) => [...match[1]!.matchAll(/<dd>([^<]*)<\/dd>/g)].map((each) => each[1]));
  const helpKeys = (html: string) => [...html.slice(html.indexOf('<div class="br-help"')).matchAll(/<dd>([^<]*)<\/dd>/g)].map((each) => each[1]);

  it('names the compare keys only when there are two pictures to compare', () => {
    const both = imagePage('modified', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: shown(BLUE, 'image/png', 4, 5)});
    expect(railKeys(both)).toEqual([['compare', 'file', 'theme', 'flip']]);
    expect(helpKeys(both)).toEqual(['side by side, flip, difference', 'flip to the other side', 'previous or next file', 'theme: system, light, dark', 'these keys']);

    const single = [
      imagePage('added', {format: 'raster', before: null, after: shown(RED, 'image/png', 3, 2)}),
      imagePage('deleted', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: null}),
      imagePage('modified', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: {kind: 'card', reason: 'tooLarge'}}),
    ];
    for (const html of single) {
      expect(railKeys(html)).toEqual([['file', 'theme']]);
      expect(helpKeys(html)).toEqual(['previous or next file', 'theme: system, light, dark', 'these keys']);
    }
  });
});
