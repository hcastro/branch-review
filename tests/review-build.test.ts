import {describe, expect, it} from 'vitest';
import type {ReviewCardRequest, ReviewRequest} from '../src/rendered/backend.js';
import {patchObjectIds} from '../src/media/classify.js';
import type {PageBody} from '../src/rendered/page.js';
import {BUILD_BUDGET_MS, createReviewBuilder, type ReadBranch} from '../src/rendered/review/build.js';
import {parseHunks, unpackHtml} from '../src/rendered/review/diff.js';
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
// The page's data, its lines' HTML unpacked.
const dataOf = (html: string) => {
  const data = JSON.parse(/<script type="application\/json" id="rv-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as Data;
  for (const card of data.cards) if (card.diff?.context) card.diff.context = card.diff.context.map(unpackHtml);
  return data;
};
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
    // A line between the hunks: the ones a hunk shows ride with it.
    expect(card!.diff!.context![100]).toContain('<span class="pl-s">');
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

  it('carries in its context only the lines no hunk shows, so a new file carries none of its text twice', async () => {
    const modified = tsCard('src/a.ts', 4 * 1024);
    const added = (() => {
      const after = tsText(2 * 1024);
      const file = diffFile(null, after, 'src/new.ts');
      return {file, before: null, after, card: reviewCardRequest(file, RANGE, null)};
    })();
    const builder = createReviewBuilder({sources: memorySides([modified, added]), fragment: noFragment, highlight: async () => null, branch: knownBranch});
    const [first, second] = dataOf((await builder.page(request([modified.card, added.card]))).html).cards;
    const shown = new Set(parseHunks(modified.card.blocks).flatMap((hunk) => hunk.lines.flatMap((line) => (line.n === undefined ? [] : [line.n]))));
    expect(first!.diff!.context!.every((line, index) => (shown.has(index + 1) ? line === '' : line !== ''))).toBe(true);
    expect(second!.diff!.context!.every((line) => line === '')).toBe(true);
  });

  it('folds a diff past 3,000 lines or 1 MiB, and reads nothing of one past 4 MiB, whose card says it is too large', async () => {
    // A new file's patch, written here: git's output through a test pipe stops at 1 MiB.
    const added = (path: string, count: number, text: string): ReviewFile => {
      const hunk = `@@ -0,0 +1,${count} @@\n${Array.from({length: count}, (_, index) => `+${text} ${index}\n`).join('')}`;
      const rawDiff = `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${String(count).padStart(7, '0')}\n--- /dev/null\n+++ b/${path}\n${hunk}`;
      return {path, status: 'added', metrics: {path, additions: count, deletions: 0, changedLines: count}, rawDiff, renderedLines: [], blocks: [{rawDiff: hunk}]} as unknown as ReviewFile;
    };
    const long = added('data/long.csv', 3_001, 'row');
    const wide = added('data/wide.csv', 900, 'x'.repeat(1_200));
    const huge = added('data/huge.csv', 4_000, 'y'.repeat(1_100));
    const short = added('data/short.csv', 2_999, 'row');
    const read: string[] = [];
    const sources = {read: async (_cwd: string, spec: {path?: string; id?: string}) => {
      read.push(String(spec.id));
      return {kind: 'unavailable', reason: 'not here'};
    }} as unknown as SourceReader;
    const builder = createReviewBuilder({sources, fragment: noFragment, highlight: async () => null, branch: knownBranch});
    const cards = [long, wide, huge, short].map((file) => reviewCardRequest(file, RANGE, null));
    const {html} = await builder.page(request(cards));
    const data = dataOf(html).cards as Array<{diff: {fold?: true} | null}>;
    expect(data.map((card) => (card.diff === null ? 'none' : card.diff.fold ? 'fold' : 'open'))).toEqual(['fold', 'fold', 'none', 'open']);
    expect(html).toMatch(/<div class="rv-special rv-special-tooLarge">.*<span>This diff is too large to show here\. Open the file to see it\.<\/span>/);
    expect(read).not.toContain(patchObjectIds(huge.rawDiff)!.after);
  });

  it('carries folded diffs within the page\'s 2 MiB of file text, ahead of context, and says the page has no room left for a diff past it', async () => {
    // Three new files of about 800 KB each, each folded for its 3,001 lines.
    const added = (path: string): ReviewFile => {
      const hunk = `@@ -0,0 +1,3001 @@\n${Array.from({length: 3_001}, (_, index) => `+${'z'.repeat(310)} ${index}\n`).join('')}`;
      const rawDiff = `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n${hunk}`;
      return {path, status: 'added', metrics: {path, additions: 3_001, deletions: 0, changedLines: 3_001}, rawDiff, renderedLines: [], blocks: [{rawDiff: hunk}]} as unknown as ReviewFile;
    };
    const small = tsCard('src/small.ts', 300 * 1024);
    const builder = createReviewBuilder({sources: memorySides([small]), fragment: noFragment, highlight: async () => null, branch: knownBranch});
    const cards = [small.card, ...['a.csv', 'b.csv', 'c.csv'].map((name) => reviewCardRequest(added(`data/${name}`), RANGE, null))];
    const {html, specials} = await builder.page(request(cards));
    const data = dataOf(html).cards as Array<{diff: {fold?: true; context: unknown} | null}>;
    expect(data.map((card) => (card.diff === null ? 'none' : card.diff.fold ? 'fold' : 'open'))).toEqual(['open', 'fold', 'fold', 'none']);
    // The third would fit in 2 MiB on its own: it is no diff too large to show.
    expect(specials.map((special) => special?.kind)).toEqual([undefined, undefined, undefined, 'noRoom']);
    // The two folded diffs leave less than the first file's context.
    expect(data[0]!.diff!.context).toBeNull();
    expect(html).not.toContain('class="rv-special rv-special-tooLarge"');
    expect(html).toMatch(/<div class="rv-special rv-special-noRoom">.*<span>This page has no room left for this diff\. Open the file to see it\.<\/span>/);
  });

  it('says a small deleted file the page has no room for was deleted, never that its diff is too large, and keeps its counts', async () => {
    // Forty deleted files of 600 lines, about 60 KB each: more than 2 MiB in all.
    const deleted = (path: string): ReviewFile => {
      const hunk = `@@ -1,600 +0,0 @@\n${Array.from({length: 600}, (_, index) => `-${'v'.repeat(95)} ${String(index).padStart(3, '0')}\n`).join('')}`;
      const rawDiff = `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/${path}\n+++ /dev/null\n${hunk}`;
      return {path, status: 'deleted', metrics: {path, additions: 0, deletions: 600, changedLines: 600}, rawDiff, renderedLines: [], blocks: [{rawDiff: hunk}]} as unknown as ReviewFile;
    };
    const files = Array.from({length: 40}, (_, index) => deleted(`vendor/lib/file-${String(index).padStart(2, '0')}.js`));
    const builder = createReviewBuilder({sources: memorySides([]), fragment: noFragment, highlight: async () => null, branch: knownBranch});
    const {html, specials} = await builder.page(request(files.map((file) => reviewCardRequest(file, RANGE, null))));
    const kinds = specials.map((special) => special?.kind ?? 'fold');
    // The first ones fold behind Load diff; the rest, once the page is full, say the file was deleted.
    expect(kinds.indexOf('deleted')).toBeGreaterThan(20);
    expect(kinds.slice(kinds.indexOf('deleted')).every((kind) => kind === 'deleted')).toBe(true);
    const cards = html.split('<section class="rv-card"').slice(1);
    expect(cards.join('')).not.toContain('too large');
    expect(cards.join('')).not.toContain('no room');
    for (const [index, card] of cards.entries()) {
      expect(card, String(index)).toContain('<span class="rv-d">−600</span>');
      expect(card).toContain(kinds[index] === 'deleted' ? '<span>This file was deleted.</span>' : 'data-act="load">Load diff</button><span>This file was deleted.</span>');
      if (kinds[index] === 'deleted') expect(card).not.toContain('Load diff');
    }
  });

  it('checks Git LFS pointers a few at a time within its time budget, and draws the diff of one it had no time to check', async () => {
    const pointer = (index: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${index.toString(16).padStart(64, '0')}\nsize ${1_000 + index}\n`;
    const files = Array.from({length: 60}, (_, index) => ({file: diffFile(null, pointer(index), `assets/blob-${index}.bin`), before: null, after: pointer(index)}));
    const cards = files.map(({file}) => reviewCardRequest(file, RANGE, null));
    expect(cards.every((card) => card.special?.kind === 'lfs')).toBe(true);
    const inner = memorySides(files);
    let clock = 0;
    let reads = 0;
    let open = 0;
    let most = 0;
    // A loaded machine: each read takes 100 ms of the build's clock.
    const sources = {read: async (cwd: string, spec: never) => {
      reads += 1;
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setImmediate(resolve));
      clock += 100;
      open -= 1;
      return inner.read(cwd, spec);
    }} as unknown as SourceReader;
    const builder = createReviewBuilder({sources, fragment: noFragment, highlight: async () => null, now: () => clock, branch: knownBranch, buildBudgetMs: 1_000});
    const {html, partial, specials} = await builder.page(request(cards));
    // A few readers at once, as the cards have, and none past the budget.
    expect(most).toBeLessThanOrEqual(4);
    expect(reads).toBeLessThanOrEqual(1_000 / 100 + 4);
    expect(partial).toBe(true);
    const checked = specials.filter((special) => special?.kind === 'lfs').length;
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(reads);
    // A pointer left unchecked draws its diff, the safe answer.
    const drawn = html.split('<section class="rv-card"').slice(1).filter((card) => card.includes('<table class="diff uni">'));
    expect(drawn).toHaveLength(60 - checked);
  });

  it('folds a short deleted file behind Load diff over GitHub\'s words, and keeps a deleted markdown file\'s rich view', async () => {
    const gone = diffFile(`${Array.from({length: 20}, (_, line) => `line ${line}`).join('\n')}\n`, null, 'gone.txt');
    const doc = diffFile('# Old\n\nA page.\n', null, 'docs/old.md');
    const markdown: ReviewCardRequest = {...reviewCardRequest(doc, RANGE, null), kind: 'markdown', fragment: {cwd: '/repo', key: 'old', path: 'docs/old.md', status: 'deleted', source: {kind: 'none', reason: 'test'}, groups: []}};
    const builder = createReviewBuilder({sources: memorySides([]), fragment: async () => ({body: {kind: 'empty'}}), highlight: async () => null, branch: knownBranch});
    const {html} = await builder.page(request([reviewCardRequest(gone, RANGE, null), markdown]));
    const data = dataOf(html).cards as Array<{diff: {fold?: true; hunks: unknown[]} | null}>;
    expect(data.map((card) => card.diff?.fold)).toEqual([true, true]);
    const [first, second] = html.split('<section class="rv-card"').slice(1);
    expect(first).toContain('data-act="load">Load diff</button><span>This file was deleted.</span>');
    expect(first).not.toContain('<table');
    expect(second).toContain('<div class="rv-v-rich" hidden>');
    expect(second).toContain('This file was deleted.');
  });

  it('draws the diff of a file that opens like a Git LFS pointer and goes on past its hunk, and one line for a whole pointer', async () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\next-0-tool sha256:${'c'.repeat(64)}\noid sha256:${'a'.repeat(64)}\nsize 2500000\n`;
    const code = Array.from({length: 50}, (_, line) => `echo HIDDEN_PAYLOAD_LINE ${line}`).join('\n');
    // Only the first line changes, so the hunk's reviewed side is the pointer alone.
    const forged = {before: `#!/bin/sh\n${pointer.slice(pointer.indexOf('\n') + 1)}${code}\n`, after: `${pointer}${code}\n`};
    const forgedFile = diffFile(forged.before, forged.after, 'run.sh');
    const real = {before: pointer.replace('2500000', '1200000').replace(/a{64}/, 'b'.repeat(64)), after: pointer};
    const realFile = diffFile(real.before, real.after, 'img/big.psd');
    const files = [{file: forgedFile, ...forged}, {file: realFile, ...real}];
    const cards = files.map(({file}) => reviewCardRequest(file, RANGE, null));
    // The patch alone reads as a pointer: only the side says otherwise.
    expect(cards.map((card) => card.special?.kind)).toEqual(['lfs', 'lfs']);
    const builder = createReviewBuilder({sources: memorySides(files), fragment: noFragment, highlight: async () => null, branch: knownBranch});
    const {html, specials} = await builder.page(request(cards));
    expect(specials.map((special) => special?.kind)).toEqual([undefined, 'lfs']);
    const [run, psd] = html.split('<section class="rv-card"').slice(1);
    expect(run).toContain('<table class="diff uni">');
    expect(run).not.toContain('rv-special-lfs');
    // Its context carries the lines past the hunk, for the arrows to reveal.
    expect(dataOf(html).cards[0]!.diff!.context!.join('\n')).toContain('HIDDEN_PAYLOAD_LINE 49');
    expect(psd).toContain('<span>Git LFS file not shown.</span>');
  });

  it('reads no side of a file whose card is one line, and draws no hunk of a submodule\'s commits', async () => {
    const file = {...diffFile('a\n', 'b\n', 'lib'), rawDiff: 'diff --git a/lib b/lib\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 160000\n--- a/lib\n+++ b/lib\n@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222\n'};
    const builder = createReviewBuilder({sources: memorySides([]), fragment: noFragment, branch: knownBranch});
    const {html} = await builder.page(request([reviewCardRequest({...file, blocks: [{...file.blocks[0]!, rawDiff: file.rawDiff.slice(file.rawDiff.indexOf('@@'))}]}, RANGE, null)]));
    expect(dataOf(html).cards[0]!.diff).toBeNull();
    expect(html).toContain('<span>Submodule updated from <code>1111111</code> to <code>2222222</code>.</span>');
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

  it('says a branch with commits its upstream has and it lacks is behind, never up to date, and both counts once they diverged', async () => {
    const pill = async (upstream: {remote: string; ahead: number; behind?: number}) => {
      const builder = createReviewBuilder({sources: memorySides([]), fragment: noFragment, branch: async () => ({commits: [], upstream})});
      const {html} = await builder.page(request([]));
      return /<span class="rv-state ([^"]*)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/span>/.exec(html)?.slice(1);
    };
    expect(await pill({remote: 'origin', ahead: 0, behind: 3})).toEqual(['rv-state-behind', 'Behind origin by 3']);
    expect(await pill({remote: 'origin', ahead: 2, behind: 1})).toEqual(['rv-state-diverged', 'Ahead 2, behind 1']);
    expect(await pill({remote: 'origin', ahead: 2})).toEqual(['rv-state-ahead', 'Ahead of origin by 2']);
    expect(await pill({remote: 'origin', ahead: 0})).toEqual(['rv-state-even', 'Up to date with origin']);
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
    // The one line rides with its hunk, which the table draws.
    const added = /<tr class="add">.*?<td class="cd">(.*?)<\/td><\/tr>/.exec(html)![1]!;
    expect(added).not.toContain('<span class="pl-');
    expect(added).toContain('{&quot;id&quot;:0');
  }, 120_000);
});

