import {describe, expect, it} from 'vitest';
import type {ReviewCardRequest, ReviewRequest} from '../src/rendered/backend.js';
import {patchObjectIds} from '../src/media/classify.js';
import type {PageBody} from '../src/rendered/page.js';
import {BUILD_BUDGET_MS, createReviewBuilder, type ReadBranch} from '../src/rendered/review/build.js';
import {highlightLines} from '../src/rendered/review/highlight.js';
import {reviewCardRequest} from '../src/rendered/review/request.js';
import {OPEN_DEADLINE_MS} from '../src/rendered/service.js';
import type {SourceReader} from '../src/rendered/source.js';
import type {ReviewFile} from '../src/review/model.js';
import {diffFile} from './rendered-helpers.js';

// The worker's half of the Review in browser page on its own, over sides
// held in memory: what each card's signature names, the context budget
// counted in the text's bytes, what a build past its time budget leaves
// out and says is partial, and the branch facts git answers or doesn't.

const RANGE = {branch: 'feature', includeWorktree: false};
const REFS = {base: 'main', branch: 'feature'};

type Data = {cards: Array<{diff: {context: string[] | null; contextNote?: string; total?: number} | null}>};
const dataOf = (html: string) => JSON.parse(/<script type="application\/json" id="rv-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as Data;
const sigs = (html: string) => [...html.matchAll(/data-sig="([^"]+)"/g)].map((match) => match[1]);

// Texts by blob id, as the review's patches name them.
function memorySides(files: Array<{file: ReviewFile; before: string | null; after: string | null}>): SourceReader {
  const blobs = new Map<string, string>();
  for (const {file, before, after} of files) {
    const ids = patchObjectIds(file.rawDiff) ?? {};
    if (ids.before && before !== null) blobs.set(ids.before, before);
    if (ids.after && after !== null) blobs.set(ids.after, after);
  }
  return {
    read: async (_cwd: string, spec: {kind: string; id?: string}) => {
      const text = spec.id ? blobs.get(spec.id) : undefined;
      return text === undefined ? {kind: 'unavailable', reason: 'no such blob'} : {kind: 'text', bytes: Buffer.from(text)};
    },
  } as unknown as SourceReader;
}

const noFragment = async (): Promise<{body: PageBody}> => ({body: {kind: 'pending'}});
const knownBranch: ReadBranch = async () => ({commits: [], upstream: {remote: null}});

function request(cards: ReviewCardRequest[]): ReviewRequest {
  return {key: 'k', cwd: '/repo', refs: REFS, title: {repo: 'repo', base: 'main', branch: 'feature', worktree: false}, reviewId: 'r', cards, links: {}, assets: null, findings: []};
}

// A TypeScript file of about `bytes` bytes, every line a string the grammar colors.
function tsText(bytes: number, edit = '') {
  const line = 'export const value = "some text the grammar colors" + 42;\n';
  return `${edit}${line.repeat(Math.ceil(bytes / line.length))}${edit}`;
}

function tsCard(name: string, bytes: number) {
  const before = tsText(bytes);
  const after = tsText(bytes, 'export const first = 1;\n');
  const file = diffFile(before, after, name);
  return {file, before, after, card: reviewCardRequest(file, RANGE, null)};
}

describe('the review builder', () => {
  it('changes an image\'s signature with its blob, though it has no hunks, and a mode change\'s with its mode', async () => {
    const builder = createReviewBuilder({sources: memorySides([]), fragment: noFragment, branch: knownBranch});
    const image = (after: string): ReviewFile => ({
      path: 'img/hero.png', status: 'modified', metrics: {path: 'img/hero.png', additions: 0, deletions: 0, changedLines: 0}, renderedLines: [], blocks: [],
      rawDiff: `diff --git a/img/hero.png b/img/hero.png\nindex 1111111..${after} 100644\nBinary files a/img/hero.png and b/img/hero.png differ\n`,
    });
    const mode = (to: string): ReviewFile => ({
      path: 'bin/tool', status: 'modified', metrics: {path: 'bin/tool', additions: 0, deletions: 0, changedLines: 0}, renderedLines: [], blocks: [],
      rawDiff: `diff --git a/bin/tool b/bin/tool\nold mode 100644\nnew mode ${to}\n`,
    });
    const first = await builder.page(request([reviewCardRequest(image('2222222'), RANGE, null), reviewCardRequest(mode('100755'), RANGE, null)]));
    const redrawn = await builder.page(request([reviewCardRequest(image('3333333'), RANGE, null), reviewCardRequest(mode('100700'), RANGE, null)]));
    const again = await builder.page(request([reviewCardRequest(image('2222222'), RANGE, null), reviewCardRequest(mode('100755'), RANGE, null)]));
    expect(sigs(first.html)[0]).not.toBe(sigs(redrawn.html)[0]);
    expect(sigs(first.html)[1]).not.toBe(sigs(redrawn.html)[1]);
    expect(sigs(again.html)).toEqual(sigs(first.html));
  });

  it('counts a file\'s context in its text\'s bytes, not the colored HTML the page carries it as', async () => {
    // 150 KB of text colors into far more than 400 KB of HTML.
    const big = tsCard('src/big.ts', 150 * 1024);
    const colored = await highlightLines(big.after, 'src/big.ts');
    expect(colored!.reduce((sum, line) => sum + line.length + 1, 0)).toBeGreaterThan(400 * 1024);
    const builder = createReviewBuilder({sources: memorySides([big]), fragment: noFragment, branch: knownBranch});
    const {html} = await builder.page(request([big.card]));
    const [card] = dataOf(html).cards;
    expect(card!.diff!.context).toHaveLength(big.after.split('\n').length - 1);
    expect(card!.diff!.context![1]).toContain('<span class="pl-s">');
  }, 60_000);

  it('carries a file\'s context up to 400 KB of text and the page\'s up to 2 MiB, in the review\'s order, coloring only what it carries', async () => {
    const files = [tsCard('a.ts', 300 * 1024), tsCard('b.ts', 401 * 1024), ...Array.from({length: 7}, (_, index) => tsCard(`c${index}.ts`, 300 * 1024))];
    const colored: string[] = [];
    // Plain lines, so the test measures the budget and not the grammar.
    const highlight = async (text: string, path: string) => {
      if (text.length > 1000) colored.push(path);
      return null;
    };
    const builder = createReviewBuilder({sources: memorySides(files), fragment: noFragment, highlight, branch: knownBranch});
    const {html} = await builder.page(request(files.map((each) => each.card)));
    expect(dataOf(html).cards.map((card) => (card.diff!.context === null ? card.diff!.contextNote : 'carried'))).toEqual(['carried', 'budget', 'carried', 'carried', 'carried', 'carried', 'carried', 'budget', 'budget']);
    // A whole side is colored only for a file whose context the page carries.
    expect(new Set(colored)).toEqual(new Set(['a.ts', 'c0.ts', 'c1.ts', 'c2.ts', 'c3.ts', 'c4.ts']));
    // A file past the budget still knows how long it is, for the control that says to open it.
    expect(dataOf(html).cards[1]!.diff!.total).toBe(files[1]!.after.split('\n').length - 1);
  });

  it('draws the cards past its time budget plain, with the control that says to open the file, and says the page is partial', async () => {
    const files = Array.from({length: 12}, (_, index) => tsCard(`src/f${index}.ts`, 2 * 1024));
    let clock = 0;
    // A highlighter that takes a second of the build's clock for each side.
    const highlight = async (text: string) => {
      clock += 1_000;
      return text.split('\n').slice(0, -1);
    };
    const builder = createReviewBuilder({sources: memorySides(files), fragment: noFragment, highlight, now: () => clock, branch: knownBranch});
    const {html, partial} = await builder.page(request(files.map((each) => each.card)));
    const cards = dataOf(html).cards;
    expect(partial).toBe(true);
    const plain = cards.filter((card) => card.diff!.context === null);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.length).toBeLessThan(cards.length);
    for (const card of plain) expect(card.diff!.contextNote).toBe('budget');
    expect(html).toContain('aria-label="Open the file to see more"');
    // Well inside what `r` waits for, which also covers the worker's start.
    expect(BUILD_BUDGET_MS * 2).toBeLessThanOrEqual(OPEN_DEADLINE_MS);
  });

  it('renders no rich view past its time budget, drawing it as on its way, and says the page is partial', async () => {
    let clock = 0;
    const fragment = async (): Promise<{body: PageBody}> => {
      clock += 3_000;
      return {body: {kind: 'empty'}};
    };
    const builder = createReviewBuilder({sources: memorySides([]), fragment, now: () => clock, branch: knownBranch});
    const markdown = (name: string): ReviewCardRequest => ({path: name, status: 'modified', additions: 0, deletions: 0, kind: 'markdown', identity: name, blocks: [], sides: {}, fragment: {cwd: '/repo', key: name, path: name, status: 'modified', source: {kind: 'none', reason: 'test'}, groups: []}});
    const unsent: ReviewCardRequest = {path: 'img/new.png', status: 'added', additions: 0, deletions: 0, kind: 'raster', identity: 'img', blocks: [], sides: {}};
    const {html, partial} = await builder.page({...request(Array.from({length: 8}, (_, index) => markdown(`doc-${index}.md`)).concat(unsent)), assets: {} as never});
    expect(partial).toBe(true);
    expect(html.match(/Still being prepared/g)!.length).toBeGreaterThan(1);
    // An image the review hasn't rendered yet says so, never "binary file not shown".
    const image = html.slice(html.indexOf('aria-label="img/new.png"'));
    expect(image).toContain('Still being prepared');
  });

  it('says when git couldn\'t say where the branch stands in time, and that the page is partial', async () => {
    const builder = createReviewBuilder({sources: memorySides([]), fragment: noFragment, branch: () => new Promise(() => undefined), gitBudgetMs: 50});
    const {html, partial} = await builder.page(request([]));
    expect(partial).toBe(true);
    expect(html).toMatch(/<span class="rv-state rv-state-unknown"[^>]*>.*Branch state unavailable<\/span>/);
    expect(html).toContain("Couldn't read the commits on this branch.");
  });

  it('lets the event loop run between the sides it colors, so a job beside it is heard while it builds', async () => {
    const files = [tsCard('src/a.ts', 2 * 1024), tsCard('src/b.ts', 2 * 1024)];
    // Each side holds the loop for 100 ms, four sides in all.
    const highlight = async (text: string) => {
      const until = Date.now() + 100;
      while (Date.now() < until) {
        // Coloring.
      }
      return text.split('\n').slice(0, -1);
    };
    const builder = createReviewBuilder({sources: memorySides(files), fragment: noFragment, highlight, branch: knownBranch});
    const started = Date.now();
    let heard = Infinity;
    setTimeout(() => {
      heard = Date.now() - started;
    }, 10);
    await builder.page(request(files.map((each) => each.card)));
    const finished = Date.now() - started;
    expect(finished).toBeGreaterThanOrEqual(400);
    // Heard after a side or two, long before the last one ended.
    expect(heard).toBeLessThan(finished - 150);
  });

  it('comes back inside its time budget with GitHub\'s grammars on a one-line JSON of 200 KB, drawing it escaped', async () => {
    const row = (value: number) => `{"id":${value},"name":"x${value}","tags":["a","b"],"ok":true},`;
    const json = (seed: number) => {
      let text = '[';
      for (let value = 0; text.length < 200 * 1024; value += 1) text += row(value * seed);
      return `${text}{}]\n`;
    };
    const before = json(1);
    const after = json(3);
    const file = diffFile(before, after, 'data.json');
    const builder = createReviewBuilder({sources: memorySides([{file, before, after}]), fragment: noFragment, branch: knownBranch});
    const started = Date.now();
    const {html} = await builder.page(request([reviewCardRequest(file, RANGE, null)]));
    expect(Date.now() - started).toBeLessThan(BUILD_BUDGET_MS + 1_000);
    const [card] = dataOf(html).cards;
    expect(card!.diff!.context![0]).not.toContain('<span class="pl-');
    expect(card!.diff!.context![0]).toContain('{&quot;id&quot;:0');
  }, 120_000);
});

