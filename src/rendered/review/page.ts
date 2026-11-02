import path from 'node:path';
import {COMMIT_LIST_LIMIT, type FileStatus} from '../../git.js';
import type {Finding} from '../report.js';
import {REVIEW_CSS, REVIEW_CSS_HASH, REVIEW_HEAD_SCRIPT, REVIEW_HEAD_SCRIPT_HASH, REVIEW_SCRIPT, REVIEW_SCRIPT_HASH} from '../assets.generated.js';
import {sizeText, type ImageBody, type ImageSide} from '../image.js';
import {articleHtml, differenceNotes, findingsLabel, type PageBody} from '../page.js';
import {PAGE_INLINE_LIMIT} from '../markdown.js';
import {refusedCard} from '../words.js';
import {escapeHiddenCharacters, escapeHiddenCharactersInJson, HIDDEN_CHARACTERS, visibleMarker} from '../../controlChars.js';
import {markHidden, packDiff, type CardDiff} from './diff.js';
import {icon, type IconName} from './icons.js';
import {countsText, specialParts, type CardSpecial, type SpecialPart} from './special.js';
import {tableHtml} from './table.js';
import {dayName, relativeTime} from './time.js';

// The Review in browser page: the whole branch as a code review in one
// self-contained document, laid out like GitHub's pull request page. An
// app bar, a note, the title with the branch's state, the Files changed
// and Commits tabs, a sticky toolbar, the file tree and one card per
// changed file in the review's order. The page arrives drawn, unified
// diffs included, and reads with scripting off; the page script (client/
// review.ts) adds everything a reader does on it, from the hunks and
// context it carries as inert JSON. Its only style and scripts are ours,
// each allowed by its hash. Every repo string is escaped here; a rich
// markdown view is the renderer's fragment, sanitized already.

/** A side of the branch against its upstream, as the title's state says it. `unknown`: git didn't say in time. */
export type BranchState = {kind: 'unpushed'} | {kind: 'ahead'; remote: string; count: number} | {kind: 'behind'; remote: string; count: number}
  | {kind: 'diverged'; remote: string; ahead: number; behind: number} | {kind: 'even'; remote: string} | {kind: 'unknown'};

/** One commit on the branch that the base doesn't have. `time`: its commit time, in seconds. Never an author. */
export type ReviewCommit = {hash: string; subject: string; time: number; files: number};

/** One changed file's card. */
export type ReviewPageCard = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** What the card can show besides its source diff: a markdown file's rich view, an image's sides. */
  kind: 'text' | 'markdown' | 'raster' | 'svg';
  /** Names the file in the browser's viewed marks, with no repo text: a hash of its path. */
  viewKey: string;
  /** Changes with the file's diff, so a mark made before a change clears. */
  signature: string;
  /** The stable page name other files' rich views link to it by. */
  alias?: string;
  /** Its source diff, or null when it has none to show. */
  diff: CardDiff | null;
  /** In place of the diff, what the file is, in GitHub's one line: a binary file, a submodule, a rename with no changes. */
  special?: CardSpecial;
  /** A mode change that came with changes to the text, named in the header. */
  mode?: {from: string; to: string};
  /** In place of the diff, one line saying why there is none, for a card with no special kind (an image that failed). */
  notice?: string;
  /** A markdown file's rich view: the page body its render made, with the links it draws broken. */
  rich?: {body: PageBody; brokenRefs?: readonly number[]};
  /** An image's or SVG's two sides. */
  image?: ImageBody;
  /** An image or SVG whose sides the page couldn't show: why. */
  imageFailure?: string;
  /** An image or SVG not rendered yet: its card says it is on its way. */
  pending?: true;
  /** A file the review doesn't list, whose text is the same, which shows these changed images. */
  also?: readonly string[];
};

export type ReviewPageInput = {
  title: {repo: string; base: string; branch: string; worktree: boolean};
  /** Names this review's viewed marks in the browser, with no repo text. */
  reviewId: string;
  /** When the page was made, ms: the relative times it says start there. */
  builtAt: number;
  state: BranchState | null;
  /** The branch's newest commits, newest first, at most COMMIT_LIST_LIMIT, or null when they couldn't be read. */
  commits: ReviewCommit[] | null;
  /** How many commits the branch has in all, when git said. */
  commitTotal?: number;
  cards: ReviewPageCard[];
  /** What won't render on GitHub: the link and asset report, by file and line. */
  findings?: readonly Finding[];
};

/** Names the page as ours, early in its <head>: `--export-html` replaces only a page that carries it. */
export const GENERATOR = '<meta name="generator" content="branch-review">';

/** The page's whole policy: nothing loads, and only our own style and scripts apply. */
export function reviewPolicy() {
  return [
    "default-src 'none'",
    'img-src data:',
    `style-src '${REVIEW_CSS_HASH}'`,
    `script-src '${REVIEW_HEAD_SCRIPT_HASH}' '${REVIEW_SCRIPT_HASH}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
  ].join('; ');
}

// The page's budgets for what it carries: the file text beyond the tables
// it draws, which is each folded diff's lines and the reviewed side's text
// that expanding context reveals, for the whole page and for one file's
// context, counted in the text's own UTF-8 bytes (the colored HTML the
// page carries it as runs about four times that), and the images it
// inlines, counted in data URL characters as the renderer counts a
// markdown page's.
export const CONTEXT_FILE_LIMIT = 400 * 1024;
export const TEXT_PAGE_LIMIT = 2 * 1024 * 1024;
export const IMAGE_PAGE_LIMIT = PAGE_INLINE_LIMIT;

/**
 * The page's text budget. Each call says whether `bytes` more fit what the
 * page has left, and counts them when they do: `diff` for a folded diff's
 * lines, `context` for a reviewed side, which must also fit its file's
 * limit. A file whose context it refuses keeps its diff, and its controls
 * say to open the file.
 */
export function textBudget() {
  let used = 0;
  const take = (bytes: number) => {
    if (used + bytes > TEXT_PAGE_LIMIT) return false;
    used += bytes;
    return true;
  };
  return {
    diff: take,
    context: (bytes: number) => bytes <= CONTEXT_FILE_LIMIT && take(bytes),
  };
}

export type TextBudget = ReturnType<typeof textBudget>;

// A diff this long arrives folded, with Load diff, as GitHub folds one:
// most readers skip a generated file or a lockfile, and a page that draws
// every line of one is slow to open. A deleted file's diff arrives folded
// too, as on GitHub. A folded diff's lines ride in the page's data, so
// loading it is instant and needs nothing from the network.
export const FOLD_LINES = 3_000;
export const FOLD_BYTES = 1024 * 1024;

/** The bytes of a diff's hunks, headers included. */
export function diffBytes(blocks: ReadonlyArray<{rawDiff: string}>) {
  return blocks.reduce((sum, block) => sum + Buffer.byteLength(block.rawDiff), 0);
}

function folds(card: {status: FileStatus; blocks: ReadonlyArray<{rawDiff: string}>}) {
  if (card.status === 'deleted') return true;
  let lines = 0;
  for (const block of card.blocks) {
    // Each line of the hunk, not its header.
    for (let at = block.rawDiff.indexOf('\n'); at >= 0 && at < block.rawDiff.length - 1; at = block.rawDiff.indexOf('\n', at + 1)) lines += 1;
  }
  return lines > FOLD_LINES || diffBytes(card.blocks) > FOLD_BYTES;
}

/**
 * How each card draws its diff, in the review's order: open, folded behind
 * Load diff, or, for a folded diff the page can't carry, the one line that
 * says why. Every folded diff takes its bytes from the page's text budget
 * before any context does, since a diff matters more than the lines around
 * it. A diff past the whole budget on its own is too large; one that would
 * fit but for the diffs before it says the page has no room left, so a
 * small file is never called too large. A deleted file's says only that it
 * was deleted: the branch has no file to open. A card with a special kind
 * draws no diff.
 */
export function diffFolds(cards: ReadonlyArray<{status: FileStatus; blocks: ReadonlyArray<{rawDiff: string}>; special?: CardSpecial}>, budget: TextBudget): Array<'open' | 'fold' | CardSpecial> {
  return cards.map((card): 'open' | 'fold' | CardSpecial => {
    if (card.special || card.blocks.length === 0 || !folds(card)) return 'open';
    const bytes = diffBytes(card.blocks);
    if (budget.diff(bytes)) return 'fold';
    if (card.status === 'deleted') return {kind: 'deleted'};
    return bytes > TEXT_PAGE_LIMIT ? {kind: 'tooLarge', bytes} : {kind: 'noRoom', bytes};
  });
}

/** A card as the page carries it: a rich view's article drawn, its images within the page's budget. */
type CarriedCard = ReviewPageCard & {article?: string};

/**
 * The cards as the page carries them, with one image budget for the whole
 * page, taken in the review's order by every picture it inlines: an image
 * card's sides and the images in each rich view, whose renders each kept
 * to the limit on their own. A side past it is a card, and so is an image
 * in a rich view, as the renderer draws one past its own page's limit. The
 * context budget is the builder's, which colors only what the page carries.
 */
export function applyBudgets(cards: readonly ReviewPageCard[]): CarriedCard[] {
  const places = new Map(cards.flatMap((each, index): Array<[string, number]> => (each.alias ? [[each.alias, index]] : [])));
  let images = 0;
  const take = (dataUrl: string) => {
    if (images + dataUrl.length > IMAGE_PAGE_LIMIT) return false;
    images += dataUrl.length;
    return true;
  };
  return cards.map((card): CarriedCard => {
    if (card.image) {
      const fit = (side: ImageSide | null): ImageSide | null => (side?.kind !== 'shown' || take(side.dataUrl) ? side : {kind: 'card', reason: 'pageLimit'});
      return {...card, image: {...card.image, before: fit(card.image.before), after: fit(card.image.after)}};
    }
    const body = card.rich?.body;
    if (card.kind !== 'markdown' || body?.kind !== 'rendered') return card;
    const article = articleHtml({path: card.path, status: card.status, ...(card.oldPath ? {oldPath: card.oldPath} : {}), body}, card.rich?.brokenRefs ?? []);
    return {...card, article: inlineWithin(linkCards(article, places), take)};
  });
}

const PAGE_HREF = / href="(f-[0-9a-f]{20})\.html(?:#([^"]*))?"/;

/**
 * `html` with each opening tag named in `names` replaced by what `rewrite`
 * makes of it, in one pass. Outside a tag it jumps to the next `<`; at one
 * it reads a tag name, then attributes as rehype-stringify writes them (a
 * name, and a value in double quotes, read to the next `"`, since a value
 * holds none unescaped, though it may hold a `<` or `>`), up to `>` or
 * `/>`. A well-formed tag is copied or rewritten whole, so no tag is ever
 * looked for inside a value; anything else is copied from its `<`, and the
 * scan goes on right after that `<`. Linear in the length of `html`, where
 * a global regex over it would start a match at each `<` inside a long
 * value and scan to its end.
 */
export function rewriteTags(html: string, names: ReadonlySet<string>, rewrite: (name: string, tag: string, attributes: string) => string): string {
  const parts: string[] = [];
  let at = 0;
  for (let open = html.indexOf('<'); open >= 0; open = html.indexOf('<', at)) {
    parts.push(html.slice(at, open));
    const tag = readTag(html, open);
    if (!tag) {
      parts.push('<');
      at = open + 1;
      continue;
    }
    const whole = html.slice(open, tag.end);
    parts.push(names.has(tag.name) ? rewrite(tag.name, whole, tag.attributes) : whole);
    at = tag.end;
  }
  parts.push(html.slice(at));
  return parts.join('');
}

const isSpace = (char: string | undefined) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
const isNameStart = (char: string | undefined) => char !== undefined && /[A-Za-z]/.test(char);
const isNameChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9-]/.test(char);
// An attribute name: anything but space, a quote, `<`, `>`, `/` or `=`.
const isAttributeChar = (char: string | undefined) => char !== undefined && !isSpace(char) && !'"\'<>/='.includes(char);

// The opening tag at `open`: its name, its attributes as written (each
// with the space before it), and where it ends; null for one that isn't
// well formed.
function readTag(html: string, open: number): {name: string; attributes: string; end: number} | null {
  let at = open + 1;
  if (!isNameStart(html[at])) return null;
  while (isNameChar(html[at])) at += 1;
  const name = html.slice(open + 1, at);
  const attributesFrom = at;
  let attributesTo = at;
  for (;;) {
    const spaced = isSpace(html[at]);
    while (isSpace(html[at])) at += 1;
    if (html[at] === '>') return {name, attributes: html.slice(attributesFrom, attributesTo), end: at + 1};
    if (html[at] === '/' && html[at + 1] === '>') return {name, attributes: html.slice(attributesFrom, attributesTo), end: at + 2};
    if (!spaced || !isAttributeChar(html[at])) return null;
    while (isAttributeChar(html[at])) at += 1;
    if (html[at] === '=') {
      if (html[at + 1] !== '"') return null;
      const close = html.indexOf('"', at + 2);
      if (close < 0) return null;
      at = close + 1;
    }
    attributesTo = at;
  }
}

// A rich view's link to another file in the review names that file's
// stable page name, `f-….html`, which the Preview's pages go by and this
// page has no file for. Here it names the file's card on this page, its
// rich view and any heading in it, so a new tab, a copied link and the
// status bar all lead to this page. Its `=` is one no repo link can carry
// (the renderer makes such a link inert), so the page script follows only
// links this page drew.
function linkCards(article: string, places: ReadonlyMap<string, number>) {
  return rewriteTags(article, LINKS, (_name, tag) => tag.replace(PAGE_HREF, (href, alias: string, anchor: string | undefined) => {
    const index = places.get(alias);
    return index === undefined ? href : ` href="#file-${index}&amp;v=rich${anchor ? `&amp;h=${anchor}` : ''}"`;
  }));
}

const LINKS: ReadonlySet<string> = new Set(['a']);
const PICTURES: ReadonlySet<string> = new Set(['img', 'source']);

// The rich view with each picture the page has no room for left out: an
// image becomes the renderer's own card for one past the page's limit, and
// a `<source>` goes, leaving its `<img>` to stand for the picture.
function inlineWithin(article: string, take: (dataUrl: string) => boolean) {
  return rewriteTags(article, PICTURES, (name, tag, attributes) => {
    // A value as the renderer wrote it, its `&` and `"` escaped already; a
    // `<` or `>` in it is escaped here for the text.
    const attribute = (key: string) => new RegExp(` ${key}="([^"]*)"`).exec(attributes)?.[1]?.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const dataUrl = attribute(name === 'img' ? 'src' : 'srcset');
    if (!dataUrl?.startsWith('data:') || take(dataUrl)) return tag;
    if (name === 'source') return '';
    const alt = attribute('alt');
    const theme = attribute('data-gh-theme');
    const text = [refusedCard('pageLimit').text, ...(alt ? [alt] : [])].join(' · ');
    return `<span class="br-card br-soft" role="img" aria-label="${text}"${theme ? ` data-gh-theme="${theme}"` : ''}>${text}</span>`;
  });
}

// The same escapes the diff model writes.
function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A repo string as the page draws it: escaped, each hidden character a
// marker, as the TUI shows it (a bidi control or a zero-width space in a
// path or a subject would otherwise read as something it isn't).
const shown = (text: string) => markHidden(escapeHtml(text));
// For an attribute people read (aria-label, title), which holds no markup:
// the marker as text.
const spoken = (text: string) => escapeHtml(escapeHiddenCharacters(text));
// For an attribute a test or a selector finds a card or a tree row by:
// each hidden character as a character reference, which the browser reads
// back as itself, so no raw one is in the file. The browser reads NUL and
// the C1 controls back as other characters (U+0085 as U+2026), so those
// are their markers. Copy path and the tree's filter read the exact path
// from the page's data, never from here.
const exact = (text: string) => escapeHtml(text).replace(HIDDEN_CHARACTERS, (char) => {
  const code = char.codePointAt(0)!;
  return code === 0 || (code >= 0x80 && code <= 0x9F) ? escapeHtml(visibleMarker(char)) : `&#x${code.toString(16).toUpperCase()};`;
});

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function assembleReviewPage(input: ReviewPageInput): string {
  const cards = applyBudgets(input.cards);
  // The files the branch changed, apart from the ones that only look different.
  const changed = cards.filter((each) => !each.also);
  const {title} = input;
  return [
    '<!doctype html>',
    '<html lang="en" class="rv">',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${reviewPolicy()}">`,
    '<meta charset="utf-8">',
    GENERATOR,
    '<meta name="color-scheme" content="light dark">',
    `<script>${REVIEW_HEAD_SCRIPT}</script>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${spoken(`${title.branch} into ${title.base}`)} · branch-review</title>`,
    `<style>${REVIEW_CSS}</style>`,
    '</head>',
    '<body>',
    appBar(title.repo),
    '<main class="rv-gut">',
    '<div class="rv-wrap">',
    note(),
    heading(input),
    tabs(changed, input.commits, commitCount(input)),
    '</div>',
    '</main>',
    toolbar(changed.length, input.commits, commitCount(input), title.worktree),
    '<div class="rv-gut">',
    '<div class="rv-wrap">',
    '<div class="rv-layout" id="panel-files" role="tabpanel" aria-labelledby="tab-files">',
    sidebar(cards),
    `<div class="rv-files" id="files">\n${[report(input.findings ?? [], cards), ...cards.map((each, index) => (each.also && !cards[index - 1]?.also ? `<h2 class="rv-also-h">Also looks different</h2>\n${card(each, index)}` : card(each, index)))].join('\n')}\n</div>`,
    '</div>',
    commitList(input.commits, commitCount(input), input.builtAt),
    '</div>',
    '</div>',
    '<div class="rv-drawer-back" id="drawer-back" data-act="drawer-close"></div>',
    MENU,
    KEYS,
    '<div class="rv-toast" id="toast" role="status" hidden></div>',
    `<script type="application/json" id="rv-data">${pageData(input.reviewId, cards)}</script>`,
    `<script>${REVIEW_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function appBar(repo: string) {
  return [
    '<header class="rv-appbar rv-gut">',
    '<div class="rv-wrap rv-appbar-in">',
    `<span class="rv-wordmark"><span class="rv-glyph">${icon('branch')}</span>branch-review</span>`,
    '<span class="rv-crumb-sep" aria-hidden="true">/</span>',
    `<span class="rv-repo">${icon('repo')}<span>${shown(repo)}</span></span>`,
    '<span class="rv-spacer"></span>',
    '<span class="rv-local" title="Built from your diff on this machine. Nothing on this page was sent anywhere."><i></i>On this machine</span>',
    '<div class="rv-seg rv-icons rv-theme rv-js" role="group" aria-label="Theme">',
    `<button type="button" data-theme-set="auto" aria-pressed="true" title="Match the system" aria-label="Match the system theme">${icon('monitor')}</button>`,
    `<button type="button" data-theme-set="light" aria-pressed="false" title="Light" aria-label="Light theme">${icon('sun')}</button>`,
    `<button type="button" data-theme-set="dark" aria-pressed="false" title="Dark" aria-label="Dark theme">${icon('moon')}</button>`,
    '</div>',
    `<button type="button" class="rv-icon-btn rv-keys-btn rv-js" data-act="keys" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${icon('keyboard')}</button>`,
    '</div>',
    '</header>',
  ].join('\n');
}

function note() {
  return [
    '<div class="rv-note" id="note" role="note">',
    icon('shield'),
    "<p>Your branch's changes, built here on your machine. Nothing leaves this machine.</p>",
    `<button type="button" class="rv-icon-btn rv-sm rv-js" data-act="dismiss" aria-label="Dismiss this note">${icon('x')}</button>`,
    '</div>',
  ].join('\n');
}

const STATE_WORDS = {
  unknown: () => 'Branch state unavailable',
  unpushed: () => 'Not pushed',
  ahead: (state: Extract<BranchState, {kind: 'ahead'}>) => `Ahead of ${state.remote} by ${state.count}`,
  behind: (state: Extract<BranchState, {kind: 'behind'}>) => `Behind ${state.remote} by ${state.count}`,
  diverged: (state: Extract<BranchState, {kind: 'diverged'}>) => `Ahead ${state.ahead}, behind ${state.behind}`,
  even: (state: Extract<BranchState, {kind: 'even'}>) => `Up to date with ${state.remote}`,
};

// A pill whose words leave something out says it in its hover tip.
const STATE_TIPS: Partial<Record<BranchState['kind'], (state: BranchState) => string>> = {
  unknown: () => "git didn't say in time where this branch stands against its upstream",
  diverged: (state) => {
    const {remote, ahead, behind} = state as Extract<BranchState, {kind: 'diverged'}>;
    return spoken(`${plural(ahead, 'commit')} here that ${remote} doesn't have, and ${behind} there that this branch doesn't`);
  },
};

// How many commits the branch has: git's count, or the list's length when
// the list isn't full, else unknown (null), which the page says as `250+`.
function commitCount({commits, commitTotal}: ReviewPageInput): number | null {
  if (commitTotal !== undefined) return commitTotal;
  return commits && commits.length < COMMIT_LIST_LIMIT ? commits.length : null;
}

const countWords = (count: number | null) => (count === null ? `${COMMIT_LIST_LIMIT}+ commits` : plural(count, 'commit'));

function heading(input: ReviewPageInput) {
  const {title, state, commits, builtAt} = input;
  const count = commitCount(input);
  const words = state ? (STATE_WORDS[state.kind] as (state: BranchState) => string)(state) : null;
  const meta = [
    ...(state ? [`<span class="rv-state rv-state-${state.kind}"${STATE_TIPS[state.kind] ? ` title="${STATE_TIPS[state.kind]!(state)}"` : ''}>${icon('branch')}${shown(words!)}</span>`] : []),
    ...(commits && commits.length > 0 ? [`<span>${countWords(count)} on <span class="rv-ref">${shown(title.branch)}</span> that ${count === 1 ? 'is' : 'are'} not on <span class="rv-ref">${shown(title.base)}</span></span>`] : []),
    ...(commits && commits.length > 0 ? [`<span class="rv-nowrap"><span aria-hidden="true">· </span>last commit ${timeTag(commits[0]!.time, builtAt)}</span>`] : []),
    ...(title.worktree ? ['<span class="rv-nowrap"><span aria-hidden="true">· </span>with uncommitted changes</span>'] : []),
  ];
  return [
    '<div class="rv-head">',
    `<h1><span>${shown(title.branch)}</span><span class="rv-into">into ${shown(title.base)}</span></h1>`,
    `<div class="rv-meta">${meta.join('')}</div>`,
    '</div>',
  ].join('\n');
}

// A time the page script keeps current as the tab ages.
function timeTag(seconds: number, builtAt: number) {
  return `<time data-t="${Math.round(seconds)}" datetime="${new Date(seconds * 1000).toISOString()}">${relativeTime(seconds, builtAt / 1000)}</time>`;
}

/** Five blocks of the file's added and removed share, as GitHub draws them. */
export function diffstatBlocks(additions: number, deletions: number) {
  const total = additions + deletions;
  let green: number;
  let red: number;
  if (total <= 5) {
    green = additions;
    red = deletions;
  } else {
    green = Math.round((additions / total) * 5);
    red = 5 - green;
    if (deletions > 0 && red === 0) [green, red] = [4, 1];
    if (additions > 0 && green === 0) [green, red] = [1, 4];
  }
  const blocks = Array.from({length: 5}, (_, index) => `<i${index < green ? ' class="g"' : index < green + red ? ' class="r"' : ''}></i>`).join('');
  return `<span class="rv-blocks" aria-hidden="true">${blocks}</span>`;
}

const stat = (additions: number, deletions: number) => `<span class="rv-a">+${additions}</span><span class="rv-d">−${deletions}</span>${diffstatBlocks(additions, deletions)}`;

// The line counts a card's header shows, or null for a card that shows
// none: an image with no text diff, which has no lines, and a one-line
// card whose lines aren't the file's text, as on GitHub (a submodule's or
// a pointer's lines are git's). The Files changed total adds these alone.
function shownCounts(each: ReviewPageCard) {
  if ((each.kind === 'raster' || each.kind === 'svg') && each.diff === null) return null;
  if (each.special && !(countsText(each.special) && each.additions + each.deletions > 0)) return null;
  return {additions: each.additions, deletions: each.deletions};
}

function tabs(cards: readonly ReviewPageCard[], commits: ReviewCommit[] | null, count: number | null) {
  const counts = cards.map(shownCounts);
  const additions = counts.reduce((sum, each) => sum + (each?.additions ?? 0), 0);
  const deletions = counts.reduce((sum, each) => sum + (each?.deletions ?? 0), 0);
  return [
    '<nav class="rv-tabs" role="tablist" aria-label="Review sections">',
    `<button type="button" class="rv-tab" role="tab" id="tab-files" aria-selected="true" aria-controls="panel-files" data-tab="files">${icon('fileDiff')}Files changed<span class="rv-count">${cards.length}</span></button>`,
    `<button type="button" class="rv-tab rv-js" role="tab" id="tab-commits" aria-selected="false" aria-controls="panel-commits" data-tab="commits">${icon('commit')}Commits<span class="rv-count">${commits ? count ?? `${COMMIT_LIST_LIMIT}+` : '?'}</span></button>`,
    `<span class="rv-total">${stat(additions, deletions)}</span>`,
    '</nav>',
  ].join('\n');
}

function toolbar(files: number, commits: ReviewCommit[] | null, total: number | null, worktree: boolean) {
  const from = commits && commits.length > 0 ? `changes from <b>all ${countWords(total)}</b>` : '';
  const shown = worktree ? (from ? `${from} and <b>uncommitted changes</b>` : '<b>uncommitted changes</b>') : from || 'the changes on this branch';
  const ring = 2 * Math.PI * 8;
  return [
    '<div class="rv-toolbar rv-gut" id="toolbar">',
    '<div class="rv-wrap rv-toolbar-in">',
    `<button type="button" class="rv-icon-btn rv-tree-btn rv-js" data-act="tree" aria-label="Hide file tree" title="Hide file tree" aria-expanded="true">${icon('sidebar')}<span class="rv-lbl">Files</span></button>`,
    `<span class="rv-tb-note">Showing ${shown}</span>`,
    '<span class="rv-spacer"></span>',
    '<span class="rv-progress rv-js" id="progress" aria-live="polite">',
    `<svg viewBox="0 0 20 20" aria-hidden="true"><circle class="rv-trk" cx="10" cy="10" r="8" fill="none" stroke-width="2.5"></circle><circle class="rv-val" id="ring" cx="10" cy="10" r="8" fill="none" stroke-width="2.5" stroke-dasharray="${ring.toFixed(2)}" stroke-dashoffset="${ring.toFixed(2)}" stroke-linecap="round"></circle></svg>`,
    `<span><b id="viewed-n">0</b> / <span id="viewed-of">${files}</span> files viewed</span>`,
    '</span>',
    '<div class="rv-seg rv-mode rv-js" role="group" aria-label="Diff layout">',
    '<button type="button" data-act="mode" data-m="unified" aria-pressed="true">Unified</button>',
    '<button type="button" data-act="mode" data-m="split" aria-pressed="false">Split</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('\n');
}

const STATUS_ICON: Record<FileStatus, Parameters<typeof icon>[0]> = {added: 'plusSq', untracked: 'plusSq', modified: 'dotSq', deleted: 'minusSq', renamed: 'arrowSq'};
const STATUS_WORD: Record<FileStatus, string> = {added: 'Added', untracked: 'Untracked', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed'};

// A folder of the tree: its folders by name, and what it lists in order.
type TreeNode = {dirs: Map<string, TreeNode>; entries: Array<{dir: string} | {file: number}>};

// The changed files as a tree, in the order their cards come, so the tree,
// the cards and `j` and `k` agree: each folder where its first file falls,
// a run of folders that hold only one folder each folded into one row.
function sidebar(cards: readonly ReviewPageCard[]) {
  const root: TreeNode = {dirs: new Map(), entries: []};
  for (const [index, each] of cards.entries()) {
    if (each.also) continue;
    let node = root;
    for (const part of each.path.split('/').slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = {dirs: new Map(), entries: []};
        node.dirs.set(part, next);
        node.entries.push({dir: part});
      }
      node = next;
    }
    node.entries.push({file: index});
  }
  const fileRow = (index: number) => {
    const each = cards[index]!;
    return [
      `<li role="treeitem" data-path="${exact(each.path)}">`,
      `<a class="rv-row rv-file" href="#file-${index}" data-act="goto" data-i="${index}">${icon('file')}<span class="rv-nm">${shown(path.posix.basename(each.path))}</span>`,
      `<span class="rv-vchk" title="Viewed">${icon('check')}</span>`,
      each.also ? `<span class="rv-st rv-st-also" title="Looks different">${icon('dotSq')}</span>` : `<span class="rv-st rv-st-${each.status}" title="${STATUS_WORD[each.status]}">${icon(STATUS_ICON[each.status])}</span>`,
      '</a></li>',
    ].join('');
  };
  const also = [...cards.keys()].filter((index) => cards[index]!.also);
  const walk = (node: TreeNode): string => node.entries.map((entry) => {
    if ('file' in entry) return fileRow(entry.file);
    let label = entry.dir;
    let inner = node.dirs.get(entry.dir)!;
    while (inner.entries.length === 1 && 'dir' in inner.entries[0]!) {
      const next = inner.entries[0].dir;
      label = `${label}/${next}`;
      inner = inner.dirs.get(next)!;
    }
    return `<li class="rv-dir" role="treeitem" aria-expanded="true"><button type="button" class="rv-row" data-act="dir">${icon('chevD', 'rv-chev')}${icon('folder')}<span class="rv-nm">${shown(label)}</span></button><ul role="group">${walk(inner)}</ul></li>`;
  }).join('');
  return [
    '<aside class="rv-sidebar" id="sidebar" aria-label="Changed files">',
    `<div class="rv-side-head"><h2>Changed files</h2><button type="button" class="rv-icon-btn" data-act="drawer-close" aria-label="Close file list">${icon('x')}</button></div>`,
    `<div class="rv-filter rv-js">${icon('search')}<input id="file-filter" type="search" placeholder="Filter changed files" aria-label="Filter changed files" autocomplete="off"></div>`,
    `<ul class="rv-tree" id="tree" role="tree">${walk(root)}</ul>`,
    ...(also.length > 0 ? [`<p class="rv-tree-title">Also looks different</p><ul class="rv-tree rv-tree-also" role="tree">${also.map(fileRow).join('')}</ul>`] : []),
    '<p class="rv-tree-empty" id="tree-empty" hidden>No changed files match.</p>',
    '</aside>',
  ].join('\n');
}

// What won't resolve once the branch is on GitHub, above the files: each
// row names the file and line and jumps to the file's card. Dismissing it
// hides it while the page is open.
function report(findings: readonly Finding[], cards: readonly ReviewPageCard[]) {
  if (findings.length === 0) return '';
  const rows = findings.map((finding) => {
    const index = cards.findIndex((each) => each.path === finding.path);
    const text = `<code>${shown(`${finding.path}:${finding.line}`)}</code><span>${shown(`${finding.target} · ${finding.reason}`)}</span>`;
    return index < 0 ? `<li><span class="rv-row">${text}</span></li>` : `<li><a class="rv-row" href="#file-${index}" data-act="goto" data-i="${index}">${text}</a></li>`;
  });
  return [
    '<section class="rv-report" id="report" aria-labelledby="report-h">',
    `<div class="rv-report-h">${icon('info')}<h2 id="report-h">Won't render on GitHub · ${shown(findingsLabel(findings)!)}</h2><button type="button" class="rv-icon-btn rv-sm rv-js" data-act="report-close" aria-label="Dismiss this list">${icon('x')}</button></div>`,
    `<ul>${rows.join('')}</ul>`,
    '</section>',
  ].join('\n');
}

function card(each: CarriedCard, index: number) {
  const name = path.posix.basename(each.path);
  const dir = each.path.slice(0, each.path.length - name.length);
  const moved = each.oldPath ? `<span class="rv-from">${shown(each.oldPath)} → </span>` : '';
  const label = spoken(each.path);
  const image = each.image ? imageSizes(each.image) : null;
  // An image with no text diff is counted by its sizes, and has none to
  // say while its sides aren't in.
  const counts = shownCounts(each);
  const statHtml = each.also ? '<span class="rv-fh-size">text unchanged</span>'
    : image && each.diff === null ? `<span class="rv-fh-size">${image}</span>`
      : counts ? `<span class="rv-fh-stat">${stat(counts.additions, counts.deletions)}</span>` : '';
  // A file that only looks different has nothing but its rich view.
  const views = !each.also && (each.kind === 'markdown' || (each.kind === 'svg' && each.diff !== null));
  // An SVG opens on its pictures, when the page has them to show.
  const startsRich = each.kind === 'svg' && each.image !== undefined;
  const viewSwitch = views ? [
    `<div class="rv-seg rv-sm rv-js" role="group" aria-label="View for ${label}">`,
    `<button type="button" data-act="view" data-v="source" aria-pressed="${!startsRich}" title="Source diff">${icon('code')}<span>Source</span></button>`,
    `<button type="button" data-act="view" data-v="rich" aria-pressed="${startsRich}" title="Rich diff">${icon('eye')}<span>Rich</span></button>`,
    '</div>',
  ].join('') : '';
  const source = each.diff ? sourceDiff(each.diff, each.status) : each.special ? specialLine(each.special, each) : `<p class="rv-notice">${shown(each.notice ?? 'No changes to show.')}</p>`;
  const rich = each.kind === 'markdown' ? richView(each) : each.image ? imageView(each.image, each.status) : imageNote(each);
  // A card with both views switches between them; an image with no text
  // diff is its pictures alone.
  const bodyHtml = views
    ? `<div class="rv-v-src"${startsRich ? ' hidden' : ''}>${source}</div><div class="rv-v-rich"${startsRich ? '' : ' hidden'}>${rich}</div>`
    : rich || source;
  // Code that may read differently than it runs says so above both views.
  const bidi = each.diff && (each.kind === 'text' || each.kind === 'markdown') && each.diff.hunks.some((hunk) => hunk.lines.some((line) => BIDI_MARKER.test(line.h)))
    ? `<p class="rv-bidi" role="note">${icon('alert')}<span>${BIDI_WARNING}</span></p>` : '';
  return [
    `<section class="rv-card${each.also ? ' rv-also' : ''}" id="file-${index}" data-i="${index}" data-vk="${escapeHtml(each.viewKey)}" data-sig="${escapeHtml(each.signature)}"${each.alias ? ` data-alias="${escapeHtml(each.alias)}"` : ''} data-path="${exact(each.path)}" aria-label="${label}">`,
    '<div class="rv-fh">',
    `<button type="button" class="rv-icon-btn rv-sm rv-chevron rv-js" data-act="collapse" aria-expanded="true" aria-label="Collapse ${label}">${icon('chevD')}</button>`,
    `<div class="rv-fh-path"><span class="rv-path">${moved}${shown(dir)}<b>${shown(name)}</b></span><button type="button" class="rv-icon-btn rv-sm rv-js" data-act="copy" aria-label="Copy file path" title="Copy file path">${icon('copy')}</button></div>`,
    statHtml,
    each.mode ? `<span class="rv-fh-mode" title="File mode changed">${escapeHtml(`${each.mode.from} → ${each.mode.to}`)}</span>` : '',
    `<div class="rv-fh-act">${viewSwitch}${each.also ? '' : '<label class="rv-viewed-btn rv-js"><input type="checkbox" data-act="viewed"><span>Viewed</span></label>'}<button type="button" class="rv-icon-btn rv-js" data-act="menu" aria-label="More options for ${label}" aria-haspopup="menu" aria-expanded="false">${icon('kebab')}</button></div>`,
    '</div>',
    `<div class="rv-fb">${bidi}${bodyHtml}</div>`,
    '</section>',
  ].join('\n');
}

// A card's source diff: its table, drawn unified, or for a long diff the
// line that loads it, the table drawn in place from the page's data.
function sourceDiff(diff: CardDiff, status: FileStatus) {
  if (!diff.fold) return `<div class="rv-tbl">${tableHtml(diff, [], 'unified')}</div>`;
  const why = status === 'deleted' ? 'This file was deleted.' : 'Large diffs are not rendered by default.';
  return [
    '<div class="rv-tbl" hidden></div>',
    `<div class="rv-special rv-load"><button type="button" class="rv-load-btn rv-js" data-act="load">Load diff</button><span>${why}</span></div>`,
  ].join('');
}

const SPECIAL_ICONS: Record<CardSpecial['kind'], IconName> = {binary: 'binary', empty: 'file', renamed: 'arrowSq', mode: 'mode', submodule: 'submodule', lfs: 'lfs', tooLarge: 'alert', noRoom: 'alert', deleted: 'minusSq', unreadable: 'alert', none: 'file'};

const partHtml = (part: SpecialPart) => (typeof part === 'string' ? shown(part) : `<code>${shown(part.code)}</code>`);

// GitHub's one line in place of a diff, with what follows it after a dot.
function specialLine(special: CardSpecial, file: {status: FileStatus; oldPath?: string}) {
  const {words, note} = specialParts(special, file);
  const noteHtml = note ? `<span class="rv-sp-note"><span aria-hidden="true">· </span>${note.map(partHtml).join('')}</span>` : '';
  return `<div class="rv-special rv-special-${special.kind}">${icon(SPECIAL_ICONS[special.kind])}<span>${words.map(partHtml).join('')}</span>${noteHtml}</div>`;
}

const BANNERS: Partial<Record<FileStatus, (oldPath?: string) => [string, Parameters<typeof icon>[0], string]>> = {
  added: () => ['added', 'plusSq', '<b>New file.</b> Everything below is added in this branch.'],
  untracked: () => ['added', 'plusSq', '<b>Untracked file.</b> Everything below is new, and not part of a push yet.'],
  deleted: () => ['deleted', 'minusSq', '<b>Deleted file.</b> Shown as it was on the base branch.'],
  renamed: (oldPath) => ['renamed', 'arrowSq', `<b>Renamed</b> from ${shown(oldPath ?? '')}.`],
};

// A markdown file as GitHub draws it, with the rich view's change marks
// (page.css): bars, before chips and removed markers.
function richView(each: CarriedCard) {
  const body = each.rich?.body ?? {kind: 'pending'};
  const differences = body.kind === 'rendered' ? body.fragment.differences : [];
  const notes = differenceNotes(differences);
  const banner = each.also ? alsoBanner(each.also) : BANNERS[each.status]?.(each.oldPath);
  // A new file is added from top to bottom: one bar along it, as GitHub's
  // rich diff draws it, in place of a mark on every block.
  const allAdded = body.kind === 'rendered' && (each.status === 'added' || each.status === 'untracked');
  const marks = body.kind === 'rendered' && each.status !== 'added' && each.status !== 'untracked' && each.status !== 'deleted';
  return [
    '<div class="rv-rich-bar">',
    ...(marks ? ['<span class="rv-legend"><i class="rv-l-add"></i>Added</span><span class="rv-legend"><i class="rv-l-mod"></i>Modified</span><span class="rv-legend"><i class="rv-l-del"></i>Removed</span>'] : []),
    ...(allAdded ? ['<span class="rv-legend"><i class="rv-l-add"></i>Added</span>'] : []),
    '<details class="rv-fid">',
    `<summary title="Drawn on this machine with GitHub's rules, so small differences are possible">${icon('info')}≈ GitHub rendering${notes.length > 0 ? ` · ${plural(notes.length, 'difference')}` : ''}</summary>`,
    `<div class="rv-pop"><p>Drawn on this machine with GitHub's parser rules, sanitizer and stylesheet.</p>${notes.length > 0 ? `<ul>${notes.map((line) => `<li>${shown(line)}</li>`).join('')}</ul>` : '<p>No known differences in this file.</p>'}</div>`,
    '</details>',
    '</div>',
    ...(banner && (each.status !== 'renamed' || each.oldPath) ? [`<div class="rv-banner rv-banner-${banner[0]}">${icon(banner[1])}<span>${banner[2]}</span></div>`] : []),
    body.kind === 'pending' ? `<p class="rv-notice">${ON_ITS_WAY}</p>`
      : `<div class="rv-rich${allAdded ? ' rv-all-add' : ''}">${each.article ?? articleHtml({path: each.path, status: each.status, ...(each.oldPath ? {oldPath: each.oldPath} : {}), body}, each.rich?.brokenRefs ?? [])}</div>`,
  ].join('');
}

// A bidi control among a card's diff lines, as the lines draw it.
const BIDI_MARKER = /<span class="rv-hc" title="U\+(?:202[A-E]|206[6-9])">/;
const BIDI_WARNING = 'This file contains bidirectional Unicode text that may read differently than it appears. Source shows each one as a marker.';

// A card whose render isn't back yet: the page is written again once it is.
const ON_ITS_WAY = 'Still being prepared. Press r in branch-review again in a moment to see it.';

function alsoBanner(images: readonly string[]): [string, Parameters<typeof icon>[0], string] {
  return ['renamed', 'dotSq', `<b>Not changed on this branch.</b> It shows ${images.map((image) => `<code>${shown(image)}</code>`).join(', ')}, which this branch changed.`];
}

// An image or SVG card with no pictures to show: why, in one line.
function imageNote(each: ReviewPageCard) {
  if (each.imageFailure !== undefined) return `<p class="rv-notice">${shown(each.imageFailure)}</p>`;
  if (each.pending) return `<p class="rv-notice">${ON_ITS_WAY}</p>`;
  return '';
}

function sideFacts(side: ImageSide) {
  if (side.kind !== 'shown') return 'not shown';
  return side.width && side.height ? `${side.width} × ${side.height} · ${sizeText(side.bytes)}` : sizeText(side.bytes);
}

// The header's sizes: `16 KB → 15 KB`, or one side's alone.
function imageSizes(image: ImageBody) {
  const size = (side: ImageSide | null) => (side?.kind === 'shown' ? sizeText(side.bytes) : null);
  const before = size(image.before);
  const after = size(image.after);
  return before && after ? `${before} → ${after}` : before ?? after ?? '';
}

function picture(side: ImageSide, which: 'before' | 'after') {
  if (side.kind !== 'shown') {
    const {text} = refusedCard(side.reason, side.hint);
    return `<div class="rv-img-card">${shown(text)}</div>`;
  }
  return `<img alt="${which === 'before' ? 'Before' : 'After'}" src="${side.dataUrl}"${pictureSize(side)}>`;
}

const pictureSize = (side: Extract<ImageSide, {kind: 'shown'}>) => (side.width && side.height ? ` width="${side.width}" height="${side.height}"` : '');

// A side in the swipe or onion stage: the same picture as the 2-up one,
// with no data of its own, which the page script gives it from the 2-up
// one the first time the reader picks the mode, so the page carries each
// side's data once, as its budget counts it.
const stagePicture = (side: Extract<ImageSide, {kind: 'shown'}>, which: 'before' | 'after') => `<img alt="${which === 'before' ? 'Before' : 'After'}" data-from="${which}"${pictureSize(side)}>`;

// An image's sides: 2-up, swipe and onion skin for a picture on each, as
// GitHub compares them; a lone side, or a side the page left out, alone.
function imageView(image: ImageBody, status: FileStatus) {
  const {before, after} = image;
  const both = before?.kind === 'shown' && after?.kind === 'shown';
  if (!both) {
    const figures = [
      ...(before ? [`<figure class="rv-single${status === 'deleted' ? ' rv-deleted' : ''}"><div class="rv-frame">${picture(before, 'before')}</div><figcaption><b>${after ? 'Before' : 'Deleted'}</b><span>${sideFacts(before)}</span></figcaption></figure>`] : []),
      ...(after ? [`<figure class="rv-single"><div class="rv-frame">${picture(after, 'after')}</div><figcaption><b>${before ? 'After' : 'Added'}</b><span>${sideFacts(after)}</span></figcaption></figure>`] : []),
    ];
    return `<div class="rv-img">${figures.join('')}</div>`;
  }
  const delta = after.bytes - before.bytes;
  const kb = Math.round(Math.abs(delta) / 1024);
  const deltaHtml = kb === 0 ? '' : `<span class="rv-delta ${delta < 0 ? 'rv-smaller' : 'rv-larger'}">${delta < 0 ? '−' : '+'}${kb} KB</span>`;
  return [
    '<div class="rv-img">',
    '<div class="rv-seg rv-js" role="group" aria-label="Image compare mode">',
    '<button type="button" data-act="imode" data-im="2up" aria-pressed="true">2-up</button>',
    '<button type="button" data-act="imode" data-im="swipe" aria-pressed="false">Swipe</button>',
    '<button type="button" data-act="imode" data-im="onion" aria-pressed="false">Onion skin</button>',
    '</div>',
    '<div class="rv-im" data-im-panel="2up">',
    '<div class="rv-two-up">',
    `<figure class="rv-before"><div class="rv-frame">${picture(before, 'before')}</div><figcaption><b>Before</b><span>${sideFacts(before)}</span></figcaption></figure>`,
    `<figure class="rv-after"><div class="rv-frame">${picture(after, 'after')}</div><figcaption><b>After</b><span>${sideFacts(after)}</span></figcaption></figure>`,
    '</div>',
    '</div>',
    '<div class="rv-im" data-im-panel="swipe" hidden>',
    '<div class="rv-stage rv-swipe rv-frame">',
    `<div class="rv-layer">${stagePicture(before, 'before')}</div>`,
    `<div class="rv-layer rv-after">${stagePicture(after, 'after')}</div>`,
    '<div class="rv-stage-tags"><span class="rv-tag rv-tag-b">Before</span><span class="rv-tag rv-tag-a">After</span></div>',
    `<div class="rv-handle" role="slider" tabindex="0" aria-label="Swipe position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span class="rv-grip">${icon('grip')}</span></div>`,
    '</div>',
    '</div>',
    '<div class="rv-im" data-im-panel="onion" hidden>',
    '<div class="rv-stage rv-onion rv-frame">',
    `<div class="rv-layer">${stagePicture(before, 'before')}</div>`,
    `<div class="rv-layer rv-after">${stagePicture(after, 'after')}</div>`,
    '</div>',
    '<label class="rv-onion-ctl"><span>Before</span><input type="range" min="0" max="100" value="50" aria-label="Opacity of the after image"><span>After</span></label>',
    '</div>',
    `<p class="rv-img-meta">${sideFacts(before)} → ${sideFacts(after)}${deltaHtml}</p>`,
    '</div>',
  ].join('');
}

// The Commits tab: the branch's newest commits by day, newest first, each
// with its subject, how long ago and how many files, and its short hash.
function commitList(commits: ReviewCommit[] | null, count: number | null, builtAt: number) {
  const parts = ['<div class="rv-commits" id="panel-commits" role="tabpanel" aria-labelledby="tab-commits" hidden>'];
  if (commits === null) {
    parts.push("<p class=\"rv-none\">Couldn't read the commits on this branch.</p>");
  } else if (commits.length === 0) {
    parts.push('<p class="rv-none">No commits yet: every change here is uncommitted.</p>');
  } else {
    const days = new Map<string, ReviewCommit[]>();
    for (const commit of commits) {
      const day = dayName(commit.time);
      days.set(day, [...(days.get(day) ?? []), commit]);
    }
    for (const [day, list] of days) {
      parts.push(`<h3>${icon('commit')}Commits on ${shown(day)}</h3>`, '<ol>');
      for (const commit of list) {
        parts.push(`<li><div><p class="rv-msg">${shown(commit.subject)}</p><p class="rv-cmeta">Committed ${timeTag(commit.time, builtAt)} · ${plural(commit.files, 'file')}</p></div><code class="rv-sha">${shown(commit.hash)}</code></li>`);
      }
      parts.push('</ol>');
    }
    // A list cut at its limit says so, with the full count when git gave it.
    if (count === null ? commits.length >= COMMIT_LIST_LIMIT : commits.length < count) {
      parts.push(`<p class="rv-none rv-more-commits">${count === null ? `Showing the newest ${commits.length} commits.` : `Showing the newest ${commits.length} of ${count} commits.`}</p>`);
    }
  }
  parts.push('</div>');
  return parts.join('\n');
}

const MENU = [
  '<div class="rv-menu" id="menu" role="menu" hidden>',
  `<button type="button" role="menuitem" data-menu="copy">${icon('copy')}Copy file path</button>`,
  `<button type="button" role="menuitem" data-menu="tree">${icon('sidebar')}Show in file tree</button>`,
  `<button type="button" role="menuitem" data-menu="viewed">${icon('check')}<span class="rv-mv">Mark as viewed</span></button>`,
  '<hr>',
  `<button type="button" role="menuitem" data-menu="collapse-all">${icon('fold')}Collapse all files</button>`,
  `<button type="button" role="menuitem" data-menu="expand-all">${icon('unfold')}Expand all files</button>`,
  '</div>',
].join('\n');

const KEYS = [
  '<div class="rv-modal-back" id="keys" hidden>',
  '<div class="rv-modal" role="dialog" aria-modal="true" aria-labelledby="keys-h">',
  `<div class="rv-modal-h"><h2 id="keys-h">Keyboard shortcuts</h2><button type="button" class="rv-icon-btn" data-act="keys-close" aria-label="Close">${icon('x')}</button></div>`,
  '<dl>',
  '<dt><kbd>j</kbd></dt><dd>Next file</dd>',
  '<dt><kbd>k</kbd></dt><dd>Previous file</dd>',
  '<dt><kbd>v</kbd></dt><dd>Mark the current file as viewed, or unmark it</dd>',
  '<dt><kbd>?</kbd></dt><dd>Show these shortcuts</dd>',
  '<dt><kbd>Esc</kbd></dt><dd>Close this list, a menu or the file list</dd>',
  '</dl>',
  '</div>',
  '</div>',
].join('\n');

/**
 * What the page script reads: the review's name for its viewed marks, and
 * each card's exact path, which Copy path and the tree's filter read, and
 * its hunks and context, packed (review/diff.ts). JSON in a data block
 * runs nothing, with every `<` escaped no text in it can end the block,
 * and each hidden character is a `\uXXXX` escape, read back as itself.
 */
function pageData(reviewId: string, cards: readonly ReviewPageCard[]) {
  // A drawn table's lines ride in the table alone; the rest of the HTML in
  // its short form, which the script unpacks.
  const data = {id: reviewId, cards: cards.map((each) => ({path: each.path, diff: each.diff && packDiff(each.diff, !each.diff.fold)}))};
  return escapeHiddenCharactersInJson(JSON.stringify(data)).replace(/</g, '\\u003c');
}
