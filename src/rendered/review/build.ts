import {createHash} from 'node:crypto';
import {isUtf8} from 'node:buffer';
import {branchCommitCountOperation, branchCommitsOperation, COMMIT_LIST_LIMIT, runOperationAsync, upstreamStateOperation} from '../../git.js';
import {createLru} from '../../media/lru.js';
import type {FragmentRequest, ReviewCardRequest, ReviewRequest} from '../backend.js';
import type {PageBody} from '../page.js';
import {oneLine, type SourceReader, type SourceSpec} from '../source.js';
import {drawHunk, escapeText, markHidden, parseHunks, type CardDiff, type Hunk} from './diff.js';
import {colorable, COLOR_MS_PER_UNIT, coloringCost, highlightLines} from './highlight.js';
import {assembleReviewPage, CONTEXT_FILE_LIMIT, diffFolds, textBudget, type BranchState, type ReviewCommit, type ReviewPageCard} from './page.js';
import {lfsPointerSize, type CardSpecial} from './special.js';

// The worker's half of the Review in browser page: each card's diff read
// from its hunks, colored by the grammar for its file across each whole
// side, with the reviewed side's lines for the context the page carries;
// each markdown file's rich view and each image's sides from the renderer's
// fragments; the commits and the branch's state from git; then the page.
// A card's diff is kept by everything it is drawn from, so a page written
// again after one file changed colors only that file again. A page that
// had to leave something out to arrive in time (the commits, a card's
// colors, a rich view) says it is partial, and the UI writes it again.

const CARD_CACHE_BYTES = 48 * 1024 * 1024;
// Files read and colored at once.
const CONCURRENCY = 4;
/**
 * How long the cards may spend reading, coloring and rendering. A card
 * started past it draws its hunks' own lines, uncolored, and a rich view
 * not rendered yet says it is on its way, so the page arrives well inside
 * the time `r` waits for it, worker start and grammar load included.
 */
export const BUILD_BUDGET_MS = 4_000;
// How long the commits and the branch's state may take: a cold git on a
// loaded machine takes seconds. They start first, beside the cards.
export const GIT_BUDGET_MS = 6_000;
/**
 * How long before the end of BUILD_BUDGET_MS every coloring should be done
 * by: the page is assembled and sent after it.
 */
export const COLOR_MARGIN_MS = 500;
/**
 * How a build keeps its coloring to its time. A coloring started can't be
 * stopped, and the grammars run on the worker's one thread, so the cards
 * take turns: one card's sides color at a time, and each turn starts only
 * when the time really left, less COLOR_MARGIN_MS, still holds what that
 * card would take at the worst rate measured (review/highlight.ts). Each
 * card is judged by the clock when its turn comes, so ordinary code, which
 * colors faster than that rate, leaves the next card more time, and only
 * the last card's worst case is held back. A card past it is drawn
 * escaped, the page says it is partial, and the next build, which finds
 * the colored cards kept, colors more. `buildColorCost` caps the units one
 * build may color besides; none by default.
 */

type Read = {text: string; bytes: number} | {tooLarge: true} | null;
// Waits for the build's coloring turn for `texts`, and says whether the
// build may color them: null when not, else what to call once they are
// colored, which hands the turn on.
type Charge = (texts: readonly string[]) => Promise<(() => void) | null>;
// What the page budget needs of a side, kept by the side's blob id, which
// fixes its text: its size in UTF-8 bytes and its lines, or that it is too
// large to read.
type Size = {bytes: number; lines: number} | 'tooLarge';

/**
 * What git says of the branch: its newest commits, how many it has in all
 * (`total`), and where it stands against its upstream (null: no local
 * branch). Undefined for what couldn't be read.
 */
export type BranchReading = {commits?: ReviewCommit[]; total?: number; upstream?: {remote: string; ahead: number; behind?: number} | {remote: null} | null};

export type ReadBranch = (cwd: string, refs: ReviewRequest['refs'], signal: AbortSignal) => Promise<BranchReading>;

const readBranch: ReadBranch = async (cwd, refs, signal) => {
  const [commits, total, upstream] = await Promise.all([
    runOperationAsync(branchCommitsOperation(cwd, refs.base, refs.branch), {signal}).catch(() => undefined),
    runOperationAsync(branchCommitCountOperation(cwd, refs.base, refs.branch), {signal}).catch(() => undefined),
    runOperationAsync(upstreamStateOperation(cwd, refs.branch), {signal}).catch(() => undefined),
  ]);
  return {...(commits ? {commits} : {}), ...(total !== undefined ? {total} : {}), ...(upstream !== undefined ? {upstream} : {})};
};

// The reviewed side's lines with those a hunk shows left blank: the page
// carries each line once, and a gap reveals only lines no hunk shows. A
// new file's context is then all blank, and costs the page almost nothing.
function gapsOnly(lines: readonly string[], hunks: readonly Hunk[]) {
  const gaps = [...lines];
  for (const hunk of hunks) for (const line of hunk.lines) if (line.n !== undefined) gaps[line.n - 1] = '';
  return gaps;
}

// Lets the event loop run, so a job beside this one, and the git this job
// waits on, are heard between two sides.
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

// A branch with an upstream, by the commits each side has that the other
// doesn't: one with commits to fetch is never up to date.
function stateAgainst({remote, ahead, behind = 0}: {remote: string; ahead: number; behind?: number}): BranchState {
  if (ahead > 0 && behind > 0) return {kind: 'diverged', remote, ahead, behind};
  if (ahead > 0) return {kind: 'ahead', remote, count: ahead};
  if (behind > 0) return {kind: 'behind', remote, count: behind};
  return {kind: 'even', remote};
}

export function createReviewBuilder({sources, fragment, now = Date.now, highlight = highlightLines, colorCost, branch = readBranch, gitBudgetMs = GIT_BUDGET_MS, buildBudgetMs = BUILD_BUDGET_MS, buildColorCost = Infinity}: {
  sources: SourceReader;
  // The renderer's fragment for a request, held by the handler.
  fragment: (request: FragmentRequest) => Promise<{body: PageBody}>;
  now?: () => number;
  highlight?: (text: string, path: string) => Promise<string[] | null>;
  // What coloring a text costs: the grammars' cost, or nothing for a
  // highlighter given in their place, unless it says.
  colorCost?: (text: string) => number;
  branch?: ReadBranch;
  gitBudgetMs?: number;
  // `--export-html`, which nobody waits on, gives the cards all the time they take.
  buildBudgetMs?: number;
  // The most cost units one build colors, past its time: none by default.
  buildColorCost?: number;
}) {
  const costOf = colorCost ?? (highlight === highlightLines ? coloringCost : () => 0);
  const diffs = createLru<CardDiff>(CARD_CACHE_BYTES, (diff) => JSON.stringify(diff).length * 2);
  const sizes = createLru<Size>(1024 * 1024, () => 64);
  // Whether a side is a whole Git LFS pointer, by the same key as its size.
  const pointers = createLru<boolean>(1024 * 1024, () => 64);

  const read = async (cwd: string, spec: SourceSpec | undefined): Promise<Read> => {
    if (!spec) return null;
    try {
      const side = await sources.read(cwd, spec);
      if (side.kind === 'tooLarge') return {tooLarge: true};
      // A work tree file that no longer reads as its diff: no line of it
      // could be trusted to sit where the hunks say.
      if (side.kind !== 'text' || !isUtf8(side.bytes)) return null;
      return {text: side.bytes.toString('utf8'), bytes: side.bytes.length};
    } catch {
      return null;
    }
  };

  // A side's size is fixed by its blob id: a side named by none (an
  // untracked file) is read each time.
  const sizeKey = (cwd: string, spec: SourceSpec | undefined) => (spec && 'id' in spec && spec.id ? JSON.stringify([cwd, spec]) : null);
  const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

  // A side's lines as HTML: colored when its grammar is known and the
  // build paid for it, escaped when not. `cut`: the build had no room left
  // for it, which a later build may have. An empty side has no lines.
  // `lineEnds`: a whole side as read, whose `\r` before a `\n` (or at its
  // end) is the line's end, not its text, as parseHunks reads a hunk's
  // lines: no line of a CRLF file draws a marker for it. A lone `\r` inside
  // a line is its text. The hunks' own lines arrive without them.
  const drawSide = async (text: string, path: string, paid: boolean, lineEnds = true) => {
    if (text === '') return {lines: [], cut: false};
    await breathe();
    const own = lineEnds ? text.replace(/\r(?=\n|$)/g, '') : text;
    const lines = own.split('\n');
    if (own.endsWith('\n')) lines.pop();
    if (!paid) return {lines: lines.map(escapeText), cut: true};
    return {lines: (await highlight(own, path).catch(() => null)) ?? lines.map(escapeText), cut: false};
  };

  // One side of the hunks' own lines, colored together, for a side the
  // page doesn't color whole: by line number.
  const hunkSide = async (hunks: readonly Hunk[], side: 'o' | 'n', path: string, charge: Charge) => {
    const lines = hunks.flatMap((hunk) => hunk.lines.filter((line) => line[side] !== undefined));
    const text = lines.map((line) => line.text).join('\n');
    const paid = await charge([text]);
    try {
      const drawn = await drawSide(text, path, paid !== null, false);
      return {html: new Map(lines.map((line, index) => [line[side]!, drawn.lines[index] ?? escapeText(line.text)])), cut: drawn.cut};
    } finally {
      paid?.();
    }
  };

  /**
   * A card's diff. `colors`: whether the build's budget has room to read
   * and color it; past it, the hunks' own lines, plain, with the context
   * controls saying to open the file. `carry` asks the page's budget, in
   * the review's order, for the reviewed side's bytes, and says whether
   * the page carries them: only a side the page carries is colored whole,
   * with its base side, and the others color their hunks' lines alone.
   */
  async function cardDiff(cwd: string, card: ReviewCardRequest, colors: boolean, carry: (bytes: number | null) => Promise<boolean>, charge: Charge): Promise<{diff: CardDiff | null; plain: boolean}> {
    const hunks = parseHunks(card.blocks);
    if (hunks.length === 0 || !colors) {
      await carry(null);
      return hunks.length === 0 ? {diff: null, plain: false} : {diff: {hunks: hunks.map((hunk) => drawHunk(hunk)), context: null, contextNote: 'budget'}, plain: true};
    }
    const afterKey = sizeKey(cwd, card.sides.after);
    let after: Read | undefined;
    let size = afterKey ? sizes.get(afterKey) : undefined;
    if (size === undefined) {
      after = await read(cwd, card.sides.after);
      if (after) size = 'tooLarge' in after ? 'tooLarge' : {bytes: after.bytes, lines: lineCount(after.text)};
      if (afterKey && size) sizes.set(afterKey, size);
    }
    const carried = await carry(size && size !== 'tooLarge' ? size.bytes : null);
    const key = createHash('sha256').update(JSON.stringify([cwd, card.path, card.status, card.sides, card.blocks.map((block) => block.rawDiff), carried])).digest('hex');
    const known = diffs.get(key);
    if (known) return {diff: known, plain: false};
    if (carried && after === undefined) after = await read(cwd, card.sides.after);
    const newText = carried && after && 'text' in after ? after.text : null;
    const before = newText === null ? null : await read(cwd, card.sides.before);
    const oldText = before && 'text' in before && before.bytes <= CONTEXT_FILE_LIMIT ? before.text : null;
    // Whether the build left a side escaped for want of time.
    let cut = false;
    // Both whole sides in one turn, so a card is colored whole or not at
    // all, and the next build has one card less to color.
    const paid = await charge([oldText, newText].flatMap((text) => (text === null ? [] : [text])));
    const whole = async (text: string | null, path: string) => {
      if (text === null) return null;
      const drawn = await drawSide(text, path, paid !== null);
      cut ||= drawn.cut;
      return drawn.lines;
    };
    const ownLines = async (side: 'o' | 'n', path: string) => {
      const drawn = await hunkSide(hunks, side, path, charge);
      cut ||= drawn.cut;
      return drawn.html;
    };
    let oldLines: string[] | null;
    let newLines: string[] | null;
    try {
      oldLines = await whole(oldText, card.oldPath ?? card.path);
      newLines = await whole(newText, card.path);
    } finally {
      paid?.();
    }
    // A side shorter than its hunks say isn't the text they were read from.
    const reach = (side: 'o' | 'n') => Math.max(0, ...hunks.flatMap((hunk) => hunk.lines.map((line) => line[side] ?? 0)));
    if (oldLines && oldLines.length < reach('o')) oldLines = null;
    if (newLines && newLines.length < reach('n')) newLines = null;
    const oldHtml = oldLines ?? await ownLines('o', card.oldPath ?? card.path);
    const newHtml = newLines ?? await ownLines('n', card.path);
    const lookup = (html: string[] | Map<number, string>) => (line: number) => (Array.isArray(html) ? html[line - 1] : html.get(line));
    // A side the page leaves out, though it has one, is the reader's to open.
    const leftOut = newLines === null && size !== undefined;
    const total = size && size !== 'tooLarge' ? size.lines : undefined;
    const diff: CardDiff = {
      hunks: hunks.map((hunk) => drawHunk(hunk, {old: lookup(oldHtml), new: lookup(newHtml)})),
      // The hunks' lines get their markers as they are drawn; the context's here.
      context: newLines && gapsOnly(newLines, hunks).map(markHidden),
      ...(leftOut ? {contextNote: 'budget' as const} : {}),
      ...(total !== undefined ? {total} : {}),
    };
    // A diff drawn in part escaped isn't kept: the next build colors it.
    if (cut) return {diff, plain: true};
    diffs.set(key, diff);
    return {diff, plain: false};
  }

  // The commits and the branch's state, or null for what git didn't answer
  // in time: the page says so, and is partial.
  async function branchFacts(request: ReviewRequest): Promise<{state: BranchState | null; commits: ReviewCommit[] | null; commitTotal?: number; complete: boolean}> {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A git that answered while the loop was busy coloring is heard first:
    // the give-up waits one more turn for its output.
    const late = new Promise<BranchReading>((resolve) => {
      timer = setTimeout(() => setImmediate(() => resolve({})), gitBudgetMs);
      timer.unref?.();
    });
    const reading = await Promise.race([branch(request.cwd, request.refs, stop.signal).catch((): BranchReading => ({})), late]);
    clearTimeout(timer);
    stop.abort();
    const {upstream} = reading;
    const state: BranchState | null = upstream === undefined ? {kind: 'unknown'} : upstream === null ? null : upstream.remote === null ? {kind: 'unpushed'} : stateAgainst(upstream);
    const {commits, total} = reading;
    // A full list whose count didn't come back can't say how many there are.
    const counted = commits === undefined || total !== undefined || commits.length < COMMIT_LIST_LIMIT;
    return {state, commits: commits ?? null, ...(total !== undefined ? {commitTotal: total} : {}), complete: upstream !== undefined && commits !== undefined && counted};
  }

  // A Git LFS pointer's card is one line only when its whole side reads as
  // the pointer its hunk shows: a file that opens like one and goes on past
  // the hunk draws its diff. So does one whose side can't be read. The
  // answer is kept by the side's blob id, so a page written again reads
  // only what changed.
  async function wholePointer(cwd: string, card: ReviewCardRequest): Promise<CardSpecial | undefined> {
    const spec = card.status === 'deleted' ? card.sides.before : card.sides.after;
    const key = sizeKey(cwd, spec);
    let whole = key ? pointers.get(key) : undefined;
    if (whole === undefined) {
      const side = await read(cwd, spec);
      const text = side && 'text' in side && side.text.endsWith('\n') ? side.text.slice(0, -1) : null;
      whole = text !== null && lfsPointerSize(text.split('\n')) !== undefined;
      if (key) pointers.set(key, whole);
    }
    return whole ? card.special : undefined;
  }

  /**
   * Each card's special kind, with every Git LFS candidate checked against
   * its side by a few readers at once, as the cards are, while the build's
   * budget lasts. A candidate left unchecked draws its diff, the safe
   * answer, and the page says it is partial.
   */
  async function checkPointers(request: ReviewRequest, inBudget: () => boolean): Promise<{specials: Array<CardSpecial | undefined>; unchecked: boolean}> {
    const specials: Array<CardSpecial | undefined> = request.cards.map((card) => (card.special?.kind === 'lfs' ? undefined : card.special));
    const candidates = [...request.cards.keys()].filter((index) => request.cards[index]!.special?.kind === 'lfs');
    let unchecked = false;
    let next = 0;
    const reader = async () => {
      while (next < candidates.length) {
        const index = candidates[next]!;
        next += 1;
        if (!inBudget()) {
          unchecked = true;
          continue;
        }
        specials[index] = await wholePointer(request.cwd, request.cards[index]!);
      }
    };
    await Promise.all(Array.from({length: CONCURRENCY}, reader));
    return {specials, unchecked};
  }

  const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

  return {
    /** The page, and each card's one line in place of a diff, for a report to say what the page shows. */
    async page(request: ReviewRequest): Promise<{html: string; partial: boolean; specials: Array<CardSpecial | undefined>}> {
      const startedAt = now();
      const inBudget = () => now() - startedAt < buildBudgetMs;
      // The coloring turn, taken by one card at a time, all its sides or
      // none. A side the grammars refuse anyway costs nothing: no later
      // build could color it either. A turn whose coloring, at the worst
      // rate, would end past the build's time less its margin, by the clock
      // as the turn starts, is refused.
      let colorLeft = buildColorCost;
      let colorTurn = Promise.resolve();
      const charge: Charge = async (texts) => {
        // A card with no whole side to color waits for no turn.
        if (texts.length === 0) return () => undefined;
        const before = colorTurn;
        let handOn!: () => void;
        colorTurn = new Promise((resolve) => {
          handOn = resolve;
        });
        await before;
        const cost = texts.reduce((sum, text) => sum + (colorable(text) ? costOf(text) : 0), 0);
        if (cost > colorLeft || now() - startedAt + cost * COLOR_MS_PER_UNIT > buildBudgetMs - COLOR_MARGIN_MS) {
          handOn();
          return null;
        }
        colorLeft -= cost;
        return handOn;
      };
      const facts = branchFacts(request);
      const budget = textBudget();
      // The fold decisions need each card's final kind, so the pointers are
      // checked first.
      const {specials, unchecked} = await checkPointers(request, inBudget);
      const folds = diffFolds(request.cards.map((card, index) => ({status: card.status, blocks: card.blocks, special: specials[index]})), budget);
      const cards: ReviewPageCard[] = new Array(request.cards.length);
      let partial = unchecked;
      // Each card asks the page's budget once its predecessor has, so the
      // first files in the review's order carry their context, as on a
      // page read top down.
      let turn = Promise.resolve();
      let next = 0;
      const renderedOf = (card: ReviewCardRequest): Promise<PageBody | null> => {
        if (card.renderFailure !== undefined) return Promise.resolve({kind: 'failed', reason: card.renderFailure, source: ''});
        // A file the review hasn't rendered yet, or one the budget has no
        // room left for, is on its way. One the review left past its
        // prerender limit isn't a reason to write the page again: a press
        // renders it.
        if (!card.fragment || !inBudget()) {
          if (card.kind === 'text') return Promise.resolve(null);
          if (card.fragment || !card.deferred) partial = true;
          return Promise.resolve({kind: 'pending'});
        }
        const whole: FragmentRequest = {...card.fragment, links: request.links, assets: request.assets!};
        return fragment(whole).then(({body}) => body, (error: unknown): PageBody => ({kind: 'failed', reason: oneLine(error), source: ''}));
      };
      const work = async () => {
        while (next < request.cards.length) {
          const index = next;
          next += 1;
          const card = request.cards[index]!;
          const before = turn;
          let release!: () => void;
          turn = new Promise((resolve) => {
            release = resolve;
          });
          const carry = async (bytes: number | null) => {
            await before;
            const carried = bytes !== null && budget.context(bytes);
            release();
            return carried;
          };
          // A diff the page has no room to carry isn't read: its card says
          // so in one line, as a binary file's or a submodule's does.
          const fold = folds[index]!;
          const special: CardSpecial | undefined = specials[index] ?? (typeof fold === 'object' ? fold : undefined);
          let drawn: Awaited<ReturnType<typeof cardDiff>>;
          let rendered: PageBody | null;
          try {
            [drawn, rendered] = await Promise.all([special ? carry(null).then(() => ({diff: null, plain: false})) : cardDiff(request.cwd, card, inBudget(), carry, charge), renderedOf(card)]);
          } finally {
            void before.then(release);
          }
          if (drawn.plain) partial = true;
          // A long diff arrives folded, its lines in the page's data.
          const diff = drawn.diff && fold === 'fold' ? {...drawn.diff, fold: true as const} : drawn.diff;
          // An image whose sides couldn't be read says why in place of them.
          const imageFailed = card.kind !== 'text' && card.kind !== 'markdown' && rendered?.kind === 'failed' ? `Couldn't show this image: ${rendered.reason}` : undefined;
          cards[index] = {
            path: card.path,
            ...(card.alias ? {alias: card.alias} : {}),
            ...(card.oldPath ? {oldPath: card.oldPath} : {}),
            status: card.status,
            additions: card.additions,
            deletions: card.deletions,
            kind: card.kind,
            viewKey: shortHash(`path\0${card.path}`),
            // Both sides' blobs, the mode and the old path as well as the
            // hunks: an image or a mode change has no hunks to differ by.
            signature: shortHash(JSON.stringify([card.identity, card.blocks.map((block) => block.rawDiff)])),
            diff,
            ...(card.also ? {also: card.also} : {}),
            ...(imageFailed !== undefined ? {imageFailure: imageFailed} : {}),
            ...(imageFailed !== undefined && diff === null ? {notice: imageFailed} : special && diff === null ? {special} : {}),
            ...(card.mode ? {mode: card.mode} : {}),
            ...(rendered?.kind === 'pending' && card.kind !== 'markdown' ? {pending: true} : {}),
            ...(rendered && rendered.kind === 'image' ? {image: rendered.image} : {}),
            ...(rendered && card.kind === 'markdown' ? {rich: {body: rendered, ...(card.brokenRefs ? {brokenRefs: card.brokenRefs} : {})}} : {}),
          };
        }
      };
      await Promise.all(Array.from({length: CONCURRENCY}, work));
      const {state, commits, commitTotal, complete} = await facts;
      const html = assembleReviewPage({title: request.title, reviewId: request.reviewId, builtAt: now(), state, commits, ...(commitTotal !== undefined ? {commitTotal} : {}), cards, findings: request.findings});
      return {html, partial: partial || !complete, specials: cards.map((each) => each.special)};
    },
  };
}
