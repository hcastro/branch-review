import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {afterAll, describe, expect, it} from 'vitest';
import type {FragmentRequest, LayoutResult, TileResult, TileSource} from '../src/rendered/backend.js';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown} from '../src/rendered/markdown.js';
import {assembleTileDocument} from '../src/rendered/page.js';
import {rowAt, rowMarks} from '../src/rendered/plan.js';
import {pageRows, tileGeometry} from '../src/rendered/tileGeometry.js';
import {createBrowser, type TileDocument} from '../src/rendered/worker/browser.js';
import {createRenderedHandler} from '../src/rendered/worker/handler.js';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';
import {diffFile} from './rendered-helpers.js';

// The in-pane view's jobs in a real headless Chromium: a page laid out and
// one tile cut exactly as many pixels as its cells hold at the owner's
// cell size, and the browser's own network log naming no host at all, even
// for a document that asks for one. Then several documents in one browser,
// each in its own colors, a short page as tall as its text, and a removed
// paragraph's marker the gutter can mark.
// Opt-in: BRANCH_REVIEW_TEST_CHROME names a chrome-headless-shell or
// Chromium binary, run headless with no network.

const CHROME = process.env.BRANCH_REVIEW_TEST_CHROME;

afterAll(() => cleanupTempDirs());

describe.skipIf(!CHROME)('tiles in a real Chromium', () => {
  it('cuts a tile of 1703 by 1160 pixels for 131 by 40 cells of 13 by 29, and reaches no host', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const netLog = path.join(dir, 'net-log.json');
    const source = [
      '# The page in the pane', '',
      'A paragraph with [a link](https://example.com/docs) and an image that is not loaded:', '',
      '![badge](https://img.shields.io/badge/build-passing-green)', '',
      ...Array.from({length: 60}, (_, index) => `Paragraph ${index + 1}, long enough to wrap once it is laid out at the sheet's width in the pane.\n`),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'page.md'), source);
    const fragment: FragmentRequest = {cwd: dir, key: 'live-1', path: 'page.md', status: 'added', source: {kind: 'worktree', path: 'page.md'}, groups: [], links: {}, assets: {base: null, after: {tree: 'HEAD'}, epoch: 0}};
    const geometry = tileGeometry(220, {w: 13, h: 29})!;
    const tileSource: TileSource = {fragment, scheme: 'dark', bg: '#101418', base: 'main', geometry, chrome: {path: CHROME!, headless: '--headless'}};
    const handler = createRenderedHandler({
      browser: (binary) => createBrowser({binary, userDataDir: path.join(dir, 'chrome'), extraArgs: [`--log-net-log=${netLog}`, '--net-log-capture-mode=Everything']}),
    });
    const laid = await handler.handle({type: 'layout', source: tileSource}) as LayoutResult;
    expect(laid.ok).toBe(true);
    const layout = (laid as Extract<LayoutResult, {ok: true}>).layout;
    expect(layout.heightCss).toBeGreaterThan(1000);
    expect(layout.links.some((link) => link.href === 'https://example.com/docs')).toBe(true);
    const rows = pageRows(geometry, layout.heightCss);
    const tile = await handler.handle({type: 'tile', source: tileSource, document: (laid as Extract<LayoutResult, {ok: true}>).document, index: 0, rows, mosaic: true}) as TileResult;
    expect(tile.ok).toBe(true);
    const {png, mosaic} = tile as Extract<TileResult, {ok: true}>;
    const meta = await sharp(Buffer.from(png)).metadata();
    expect([meta.width, meta.height]).toEqual([1703, 1160]);
    expect(mosaic).toHaveLength(131 * 40 * 3);
    handler.dispose();
    // The log is written out as the browser exits.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(fs.existsSync(netLog) && fs.readFileSync(netLog, 'utf8').trimEnd().endsWith('}'))) await new Promise((resolve) => setTimeout(resolve, 100));
    const log = fs.readFileSync(netLog, 'utf8');
    const hosts = [...new Set([...log.matchAll(/"host":"([^"]+)"/g)].map((match) => match[1]))];
    const urls = [...new Set([...log.matchAll(/"url":"(https?:[^"]*)"/g)].map((match) => match[1]))];
    // The log is whole and saw the page's work, so an empty list means none.
    expect(log).toContain('"events"');
    expect(log.length).toBeGreaterThan(1000);
    expect(hosts).toEqual([]);
    expect(urls).toEqual([]);
  }, 60_000);

  it('fails a request a document makes before it leaves, so the network log names no host', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const netLog = path.join(dir, 'net-log.json');
    const blocked: string[] = [];
    const browser = createBrowser({
      binary: {path: CHROME!, headless: '--headless'},
      userDataDir: path.join(dir, 'chrome'),
      extraArgs: [`--log-net-log=${netLog}`, '--net-log-capture-mode=Everything'],
      onBlocked: (url) => blocked.push(url),
    });
    // Not one of ours: no policy, and an image and a stylesheet on a host.
    const document: TileDocument = {
      key: 'raw-1',
      html: '<!doctype html><html><head><link rel="stylesheet" href="https://example.com/x.css"></head><body><p>remote</p><img src="https://example.com/x.png"></body></html>',
      cssWidth: 600,
      dpr: 1,
      scheme: 'dark',
    };
    await browser.layout(document);
    browser.close();
    const log = await finishedLog(netLog);
    expect(blocked.sort()).toEqual(['https://example.com/x.css', 'https://example.com/x.png']);
    expect(log).toContain('"events"');
    expect(hostsIn(log)).toEqual([]);
  }, 60_000);
});

describe.skipIf(!CHROME)('several tile documents in a real Chromium', () => {
  const geometry = tileGeometry(220, {w: 13, h: 29})!;
  const narrow = tileGeometry(120, {w: 13, h: 29})!;

  function sourceOf(dir: string, name: string, text: string, extra: Partial<FragmentRequest> = {}): TileSource {
    fs.writeFileSync(path.join(dir, name), text);
    const fragment: FragmentRequest = {cwd: dir, key: `live-${name}`, path: name, status: 'added', source: {kind: 'worktree', path: name}, groups: [], links: {}, assets: {base: null, after: {tree: 'HEAD'}, epoch: 0}, ...extra};
    return {fragment, scheme: 'dark', bg: '#101418', base: 'main', geometry, chrome: {path: CHROME!, headless: '--headless'}};
  }

  const handlerIn = (dir: string, profile: string) => createRenderedHandler({browser: (binary) => createBrowser({binary, userDataDir: path.join(dir, profile)})});

  // The color of pixel (x, y) of a tile PNG.
  async function pixel(png: Uint8Array, x: number, y: number) {
    const {data, info} = await sharp(Buffer.from(png)).raw().toBuffer({resolveWithObject: true});
    const at = (y * info.width + x) * info.channels;
    return `#${[...data.subarray(at, at + 3)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }

  it('draws each document in its own colors and padding, however many came before it in the browser', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const text = '# Title\n\nA paragraph long enough to wrap at the narrow sheet, so its height depends on the width it is laid out at.\n';
    const first = sourceOf(dir, 'page.md', text);
    // The same page, then a light one at another width, then the first again.
    const documents: TileSource[] = [first, {...first, scheme: 'light', bg: '#fafafa', geometry: narrow}, {...first, bg: '#000000'}];
    const shared = handlerIn(dir, 'chrome-shared');
    const seen: Array<{height: number; corner: string}> = [];
    for (const source of documents) {
      const laid = await shared.handle({type: 'layout', source}) as Extract<LayoutResult, {ok: true}>;
      const tile = await shared.handle({type: 'tile', source, document: laid.document, index: 0, rows: pageRows(source.geometry, laid.layout.heightCss), mosaic: false}) as Extract<TileResult, {ok: true}>;
      expect(tile.ok).toBe(true);
      seen.push({height: laid.layout.heightCss, corner: await pixel(tile.png, 2, 2)});
    }
    shared.dispose();
    expect(seen.map((each) => each.corner)).toEqual(['#101418', '#fafafa', '#000000']);
    // Each document laid out alone, in a browser of its own, is as tall.
    for (const [index, source] of documents.entries()) {
      const alone = handlerIn(dir, `chrome-alone-${index}`);
      const laid = await alone.handle({type: 'layout', source}) as Extract<LayoutResult, {ok: true}>;
      alone.dispose();
      expect(seen[index]!.height, `document ${index}`).toBe(laid.layout.heightCss);
    }
  }, 120_000);

  it('gives a link that wraps one box per line, so a click beside it on either line finds the right link or none', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const sheet = tileGeometry(51, {w: 10, h: 20}, 1)!;
    expect(sheet.cssWidth).toBe(480);
    const text = 'Some plain words come first, then [a long link whose text runs on past the end of the first line](https://one.example/a) and [second](https://two.example/b) after it.\n';
    const handler = handlerIn(dir, 'chrome');
    const laid = await handler.handle({type: 'layout', source: {...sourceOf(dir, 'links.md', text), geometry: sheet}}) as Extract<LayoutResult, {ok: true}>;
    handler.dispose();
    const [wrapping, second] = laid.layout.links;
    expect(wrapping!.href).toBe('https://one.example/a');
    expect(second!.href).toBe('https://two.example/b');
    expect(wrapping!.rects.length).toBeGreaterThanOrEqual(2);
    const inside = (rects: ReadonlyArray<{left: number; right: number; top: number; bottom: number}>, x: number, y: number) => rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    // The second link's middle is in no box of the wrapped one.
    const target = second!.rects[0]!;
    expect(inside(wrapping!.rects, (target.left + target.right) / 2, (target.top + target.bottom) / 2)).toBe(false);
    // Nor is the plain text before the wrapped link on its first line.
    const first = wrapping!.rects[0]!;
    expect(first.left).toBeGreaterThan(40);
    expect(inside(wrapping!.rects, first.left / 2, (first.top + first.bottom) / 2)).toBe(false);
  }, 60_000);

  it('makes a short page as tall as its text, not the browser\'s window', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const handler = handlerIn(dir, 'chrome');
    const laid = await handler.handle({type: 'layout', source: sourceOf(dir, 'short.md', '# Short\n\nOne paragraph.\n')}) as Extract<LayoutResult, {ok: true}>;
    handler.dispose();
    expect(laid.ok).toBe(true);
    // The title, a paragraph and the tile padding: well under the 800 px window.
    expect(laid.layout.heightCss).toBeGreaterThan(80);
    expect(laid.layout.heightCss).toBeLessThan(250);
  }, 60_000);

  it('keeps a removed paragraph\'s marker on the page, folded, so the gutter marks its row', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const before = '# Guide\n\nKept paragraph.\n\nA paragraph the branch removes.\n\n## Next\n\nMore text.\n';
    const after = '# Guide\n\nKept paragraph.\n\n## Next\n\nMore text.\n';
    const groups = changeGroups(diffFile(before, after, 'guide.md'));
    const handler = handlerIn(dir, 'chrome');
    const laid = await handler.handle({type: 'layout', source: sourceOf(dir, 'guide.md', after, {status: 'modified', groups})}) as Extract<LayoutResult, {ok: true}>;
    handler.dispose();
    expect(laid.layout.removed).toHaveLength(1);
    const [marker] = laid.layout.removed;
    // One folded line, between the kept paragraph and the next heading.
    expect(marker!.bottom - marker!.top).toBeGreaterThan(10);
    expect(marker!.bottom - marker!.top).toBeLessThan(60);
    expect(rowMarks(laid.layout, geometry, pageRows(geometry, laid.layout.heightCss))).toContain('removed');
  }, 60_000);

  it('marks a changed list item\'s own rows, and the items nested in it by their own marks', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const before = '# Roadmap\n\n- [ ] Tables\n  - [ ] Alignment\n  - [ ] Wide tables\n- [ ] Other\n\nEnd.\n';
    const after = '# Roadmap\n\n- [x] Tables\n  - [x] Alignment\n  - [ ] Wide tables\n    - [ ] Horizontal scroll\n- [ ] Other\n\nEnd.\n';
    const groups = changeGroups(diffFile(before, after, 'roadmap.md'));
    const handler = handlerIn(dir, 'chrome');
    const laid = await handler.handle({type: 'layout', source: sourceOf(dir, 'roadmap.md', after, {status: 'modified', groups})}) as Extract<LayoutResult, {ok: true}>;
    handler.dispose();
    const block = (first: number, last: number) => laid.layout.blocks.find((each) => each.lines?.[0] === first && each.lines?.[1] === last)!;
    const [tables, alignment, wide, scroll] = [block(3, 6), block(4, 4), block(5, 6), block(6, 6)];
    expect([tables.mark, alignment.mark, wide.mark, scroll.mark]).toEqual(['modified', 'modified', undefined, 'added']);
    expect(tables.bottom).toBeLessThanOrEqual(alignment.top);
    const marks = rowMarks(laid.layout, geometry, pageRows(geometry, laid.layout.heightCss));
    const middle = (box: {top: number; bottom: number}) => rowAt(geometry, (box.top + box.bottom) / 2);
    expect(marks[middle(tables)]).toBe('modified');
    expect(marks[middle({top: wide.top, bottom: scroll.top})]).toBeNull();
    expect(marks[middle(scroll)]).toBe('added');
  }, 60_000);

  it('draws nothing for a changed item over a nested list: the same pixels with its mark taken out', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const before = '# Roadmap\n\n- [ ] Tables\n  - [ ] Alignment\n  - [ ] Wide tables\n- [ ] Other\n';
    const after = '# Roadmap\n\n- [x] Tables\n  - [ ] Alignment\n  - [ ] Wide tables\n- [ ] Other\n';
    const fragment = await renderMarkdown({path: 'roadmap.md', status: 'modified', source: after, groups: changeGroups(diffFile(before, after, 'roadmap.md')), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    // A terminal background unlike the page's own, so a cover in the page's color would show.
    const html = assembleTileDocument({file: {path: 'roadmap.md', status: 'modified', body: {kind: 'rendered', fragment}}, scheme: 'dark', bg: '#203040', cssWidth: 640})
      .replace(/<details class="br-before">[\s\S]*?<\/details>/g, '');
    expect(html.match(/<li [^>]*data-mark="modified"/g)).toHaveLength(1);
    const unmarked = html.replace(/ data-mark="modified"/g, '');
    const browser = createBrowser({binary: {path: CHROME!, headless: '--headless'}, userDataDir: path.join(dir, 'chrome')});
    try {
      const drawn: Buffer[] = [];
      for (const [key, text] of [['marked', html], ['unmarked', unmarked]] as const) {
        const document: TileDocument = {key, html: text, cssWidth: 640, dpr: 1, scheme: 'dark'};
        const layout = await browser.layout(document);
        drawn.push(await sharp(Buffer.from(await browser.capture(document, {cssY: 0, cssHeight: layout.heightCss}))).raw().toBuffer());
      }
      expect(drawn[0]!.equals(drawn[1]!)).toBe(true);
    } finally {
      browser.close();
    }
  }, 60_000);

  it('draws no before chip on a changed list item or table header cell', async () => {
    const dir = makeTempDir('branch-review-tiles-chrome-');
    const before = '# Roadmap\n\nIntro.\n\n- [ ] Tables\n- [ ] Alignment\n  - [ ] Nested\n\n| Key | Meaning |\n| --- | --- |\n| a | first |\n\nEnd.\n';
    const after = '# Roadmap\n\nIntro.\n\n- [x] Tables\n- [ ] Alignment\n  - [x] Nested\n\n| Key | What it means |\n| --- | --- |\n| a | first |\n\nEnd.\n';
    const fragment = await renderMarkdown({path: 'roadmap.md', status: 'modified', source: after, groups: changeGroups(diffFile(before, after, 'roadmap.md')), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const html = assembleTileDocument({file: {path: 'roadmap.md', status: 'modified', body: {kind: 'rendered', fragment}}, scheme: 'dark', bg: '#101418', cssWidth: 640});
    const chips = html.match(/<details class="br-before">[\s\S]*?<\/details>/g) ?? [];
    expect(chips).toHaveLength(3);
    // The same document with every chip taken out must draw the same pixels.
    let without = html;
    for (const chip of chips) without = without.replace(chip, '');
    const browser = createBrowser({binary: {path: CHROME!, headless: '--headless'}, userDataDir: path.join(dir, 'chrome')});
    try {
      const drawn: Buffer[] = [];
      for (const [key, text] of [['with-chips', html], ['without-chips', without]] as const) {
        const document: TileDocument = {key, html: text, cssWidth: 640, dpr: 1, scheme: 'dark'};
        const layout = await browser.layout(document);
        drawn.push(await sharp(Buffer.from(await browser.capture(document, {cssY: 0, cssHeight: layout.heightCss}))).raw().toBuffer());
      }
      expect(drawn[0]!.length).toBe(drawn[1]!.length);
      expect(drawn[0]!.equals(drawn[1]!)).toBe(true);
    } finally {
      browser.close();
    }
  }, 60_000);
});

// The browser writes its network log out as it exits.
async function finishedLog(file: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(fs.existsSync(file) && fs.readFileSync(file, 'utf8').trimEnd().endsWith('}'))) await new Promise((resolve) => setTimeout(resolve, 100));
  return fs.readFileSync(file, 'utf8');
}

function hostsIn(log: string) {
  return [...new Set([...log.matchAll(/"host":"([^"]+)"/g)].map((match) => match[1]))];
}
