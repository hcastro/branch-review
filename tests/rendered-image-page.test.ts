import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {FileStatus} from '../src/git.js';
import type {FragmentRequest, FragmentResult, ReviewResult} from '../src/rendered/backend.js';
import {describeImage, imageFacts, type ImageBody} from '../src/rendered/image.js';
import {assembleReviewPage} from '../src/rendered/review/page.js';
import {REFUSED_TEXT} from '../src/rendered/words.js';
import {createRenderedHandler} from '../src/rendered/worker/handler.js';
import {cleanupTempDirs, commitAll, git, initRepo} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';

// An image's or an SVG's card on the Review in browser page: its sides
// inlined under the asset rule, compared in 2-up, swipe and onion skin,
// with their sizes, and read by the worker at the review's refs.

afterEach(cleanupTempDirs);

const RED = pngFixture(3, 2, [200, 40, 40, 255]);
const BLUE = pngFixture(4, 5, [40, 40, 200, 255]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><script>alert(1)</script><rect width="20" height="10"/></svg>';

const shown = (bytes: Buffer | string, mime: string, width: number, height: number) => ({kind: 'shown' as const, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, mime, bytes: Buffer.byteLength(bytes), width, height});

function imagePage(status: FileStatus, image: ImageBody) {
  return assembleReviewPage({
    title: {repo: 'project', base: 'main', branch: 'feature', worktree: false},
    reviewId: 'r',
    builtAt: 0,
    state: null,
    commits: [],
    cards: [{path: image.format === 'svg' ? 'docs/flow.svg' : 'docs/hero.png', status, additions: 0, deletions: 0, kind: image.format, viewKey: 'v', signature: 's', diff: null, image}],
  });
}

// The card as the page draws it, without the page's data and its script.
const card = (html: string) => html.slice(html.indexOf('<section class="rv-card'), html.indexOf('</section>', html.indexOf('<section class="rv-card')));

function writeBytes(repo: string, file: string, bytes: Buffer | string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), {recursive: true});
  fs.writeFileSync(path.join(repo, file), bytes);
}

describe('an image card', () => {
  it('compares a modified image in 2-up, swipe and onion skin, with each side\'s size and dimensions', () => {
    const html = card(imagePage('modified', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: shown(BLUE, 'image/png', 4, 5)}));
    expect(html).toContain(`<span class="rv-fh-size">${RED.length} B → ${BLUE.length} B</span>`);
    expect(html).toMatch(/<figure class="rv-before"><div class="rv-frame"><img alt="Before" src="data:image\/png;base64,[^"]+" width="3" height="2"><\/div><figcaption><b>Before<\/b><span>3 × 2 · \d+ B<\/span><\/figcaption><\/figure>/);
    expect(html).toMatch(/<figure class="rv-after"><div class="rv-frame"><img alt="After" src="data:image\/png;base64,[^"]+" width="4" height="5"><\/div>/);
    for (const mode of ['2-up', 'Swipe', 'Onion skin']) expect(html).toContain(`>${mode}</button>`);
    expect(html).not.toMatch(/<script|\sstyle=|\son[a-z]+=/i);
  });

  it('puts an added image alone, and a deleted one dimmed, with no compare modes', () => {
    const added = card(imagePage('added', {format: 'raster', before: null, after: shown(RED, 'image/png', 3, 2)}));
    expect(added).toMatch(/<figure class="rv-single"><div class="rv-frame"><img alt="After"[^>]*><\/div><figcaption><b>Added<\/b>/);
    expect(added).not.toContain('>Swipe</button>');

    const deleted = card(imagePage('deleted', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: null}));
    expect(deleted).toMatch(/<figure class="rv-single rv-deleted"><div class="rv-frame"><img alt="Before"[^>]*><\/div><figcaption><b>Deleted<\/b>/);
    expect(deleted).not.toContain('>Swipe</button>');
  });

  it('draws an SVG as an image from a data URI, never as markup of its own', () => {
    const html = card(imagePage('added', {format: 'svg', before: null, after: shown(SVG, 'image/svg+xml', 20, 10)}));
    expect(html).toContain(`src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}"`);
    expect(html).not.toMatch(/<svg xmlns|<script|alert\(1\)/);
  });

  it('shows a card in place of a side the page can\'t inline, saying why, with nothing to compare', () => {
    const html = card(imagePage('modified', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: {kind: 'card', reason: 'tooLarge'}}));
    expect(html).toContain(`<div class="rv-img-card">${REFUSED_TEXT.tooLarge}</div>`);
    expect(html).not.toContain('>Swipe</button>');
    const lfs = card(imagePage('modified', {format: 'raster', before: shown(RED, 'image/png', 3, 2), after: {kind: 'card', reason: 'lfs'}}));
    expect(lfs).toContain('<div class="rv-img-card">won\'t render on GitHub: LFS object · not fetched</div>');
  });

  it('says each side\'s dimensions and size, or the one side a new or deleted file has', () => {
    expect(describeImage(imageFacts({format: 'raster', before: shown(Buffer.alloc(86_016), 'image/png', 1200, 480), after: shown(Buffer.alloc(93_184), 'image/png', 1200, 520)}))).toBe('1200×480 · 84 KB → 1200×520 · 91 KB');
    expect(describeImage(imageFacts({format: 'svg', before: null, after: shown(Buffer.alloc(22_528), 'image/svg+xml', 1200, 480)}))).toBe('1200×480 · 22 KB');
    expect(describeImage(imageFacts({format: 'raster', before: shown(Buffer.alloc(2_500_000), 'image/png', 10, 10), after: {kind: 'card', reason: 'tooLarge'}}))).toBe('10×10 · 2.4 MB → not shown');
  });
});

describe('an image card in the worker', () => {
  // The file's fragment, then its card on the page the review job writes.
  async function pageFor(repo: string, request: Omit<FragmentRequest, 'cwd' | 'key' | 'source' | 'groups' | 'links'>) {
    const handler = createRenderedHandler();
    const fragment: FragmentRequest = {cwd: repo, key: `key-${request.path}`, source: {kind: 'none', reason: 'an image'}, groups: [], links: {}, ...request};
    const summary = await handler.handle({type: 'fragment', ...fragment}) as FragmentResult;
    const {links: _links, assets, ...own} = fragment;
    const page = await handler.handle({
      type: 'review', key: 'k', cwd: repo, refs: {base: 'main', branch: 'feature'}, title: {repo: 'project', base: 'main', branch: 'feature', worktree: false}, reviewId: 'r', links: {}, assets, findings: [],
      cards: [{path: request.path, ...(request.oldPath ? {oldPath: request.oldPath} : {}), status: request.status, additions: 0, deletions: 0, kind: request.kind!, identity: '', blocks: [], sides: {}, fragment: own}],
    }) as ReviewResult;
    return {summary, html: page.ok ? card(page.html) : ''};
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
    expect(hero.html).toContain(`src="data:image/png;base64,${RED.toString('base64')}"`);
    expect(hero.html).toContain(`src="data:image/png;base64,${BLUE.toString('base64')}"`);

    const flow = await pageFor(repo, {path: 'docs/flow.svg', status: 'added', kind: 'svg', assets});
    expect(flow.summary).toMatchObject({ok: true, summary: {kind: 'image', image: {after: {width: 20, height: 10}}}});
    expect(flow.summary.ok && flow.summary.summary.image?.before).toBeUndefined();
    expect(flow.html).toContain(`src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}"`);
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
    expect(gone.html).toContain(`src="data:image/png;base64,${RED.toString('base64')}"`);
    expect(gone.html).not.toContain('class="rv-after"');
    expect(gone.html).not.toContain('rv-img-card');

    const moved = await pageFor(repo, {path: 'docs/new.png', oldPath: 'docs/old.png', status: 'renamed', kind: 'raster', assets});
    expect(moved.summary).toMatchObject({ok: true, summary: {kind: 'image', image: {before: {width: 4, height: 5}, after: {width: 4, height: 5}}}});
    // Each side's data once, in 2-up; swipe and onion skin take it from there.
    expect(moved.html.split(`src="data:image/png;base64,${BLUE.toString('base64')}"`)).toHaveLength(3);
    expect(moved.html.match(/<img alt="(?:Before|After)" data-from="(?:before|after)"/g)).toHaveLength(4);
    expect(moved.html).not.toContain('rv-img-card');
  });
});
