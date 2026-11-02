import path from 'node:path';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, {defaultSchema} from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import GithubSlugger from 'github-slugger';
import {nameToEmoji} from 'gemoji';
import {parse as parseYaml} from 'yaml';
import {normalizeIdentifier} from 'micromark-util-normalize-identifier';
import type {Element, ElementContent, Parents, Root, RootContent} from 'hast';
import type {Nodes as MdastNodes, Root as MdastRoot, Yaml} from 'mdast';
import type {FileStatus} from '../git.js';
import {remarkAlerts, type AlertType} from './alerts.js';
import {createBlockIds, privateAttribute} from './blockIds.js';
import {baseText, markBlocks, type ChangeGroup, type MarkableBlock} from './changes.js';
import {readPageHash} from './hash.js';
import {anchorTarget, LINK_TEXT, linkReason, pageTop, REFUSED_TEXT, refusedCard, withPrefix} from './words.js';

export {anchorTarget, imageFinding, LINK_TEXT, linkReason, refusedCard} from './words.js';
import {octicon, type OcticonName} from './octicons.js';
import {rawSource, type RawSource} from './raw.js';

// The offline renderer: markdown in, the HTML GitHub would show for it out,
// with change marks. Repo text is untrusted all the way through. Raw HTML
// passes rehype-sanitize with GitHub's schema model; everything we add after
// that (anchors, alert icons, highlighting, embedded images, change marks) is
// built from our own nodes and never from repo markup.

/** How one image path resolved. The lookup owns every file and git read. */
export type AssetAnswer =
  // `untracked`: a file the review shows that isn't part of a push yet.
  | {kind: 'embed'; mime: string; dataUrl: string; oid: string; width?: number; height?: number; untracked?: true}
  | {kind: 'refused'; reason: RefusedReason; hint?: string}
  // The lookup doesn't read local images, so the page says so in place.
  | {kind: 'skipped'};

export type RefusedReason =
  | 'remote' | 'untracked' | 'ignored' | 'caseMismatch' | 'missing' | 'symlink' | 'outside' | 'lfs' | 'submodule' | 'notImage'
  // Not a finding about GitHub: the page has no room left, or the bytes
  // couldn't be read as the review named them (`hint` says why).
  | 'tooLarge' | 'pageLimit' | 'unreadable';

/** The most image bytes one page inlines; images past it show a card. */
export const PAGE_INLINE_LIMIT = 32 * 1024 * 1024;

/**
 * How one relative link resolved: to another rendered page, to a file git
 * holds that the review didn't render (`outside`), or to nothing GitHub
 * would find: no such file, a file git doesn't track or ignores, a name
 * whose capitals differ from the file's, or a heading that isn't there.
 * `unchecked`: no answer came in time, so the page claims nothing of it.
 */
export type LinkAnswer =
  | {kind: 'inReview'; href: string}
  | {kind: 'outside'}
  | {kind: 'unchecked'}
  | {kind: 'missing'}
  | {kind: 'badAnchor'}
  | {kind: 'untracked'}
  | {kind: 'ignored'}
  | {kind: 'caseMismatch'; hint: string};

/** What a link on the page came to: `ok`, or how it resolved when it opens no page. */
export type LinkStatus = 'ok' | Exclude<LinkAnswer['kind'], 'inReview'>;

/**
 * One link on the page, as written, with its line. A link to a heading on
 * another rendered page names it in `ref`, which the page checks once that
 * page's anchors are known: `index` names the link in the page's HTML.
 */
export type PageLink = {href: string; status: LinkStatus; line: number; hint?: string; ref?: {path: string; anchor: string; index: number}};

/** One repo image the page's own text shows, as written, and how it resolved. */
export type PageImageUse = {path: string; url: string; line: number; status: 'embed' | 'skipped' | RefusedReason; hint?: string};

export type RenderInput = {
  /** The file's repo-relative POSIX path; relative links resolve from its folder. */
  path: string;
  /**
   * Where the file was on the base side, when the review moved it. Images
   * the base side shows resolve from its folder, as they did there; links
   * open the review's pages, so they always resolve from `path`.
   */
  basePath?: string;
  /** How the review sees the file; the first frame of a new or deleted one is all one tint. */
  status?: FileStatus;
  /**
   * The text is the same on both sides, as in a file the review doesn't
   * list that shows an image the branch changed: its blocks are marked by
   * the images they show alone.
   */
  textUnchanged?: true;
  source: string;
  groups: ChangeGroup[];
  asset: (repoPath: string) => Promise<AssetAnswer>;
  // Images in the base side's text, which `before` views and removed
  // markers show. Without it they resolve as the page's own images do.
  baseAsset?: (repoPath: string) => Promise<AssetAnswer>;
  // Whether an image shows other content than it did on the base side,
  // where the base side's text finds it at `basePath`. A block that shows
  // one is marked even when its text didn't change.
  assetChanged?: (repoPath: string, basePath: string) => Promise<boolean>;
  link: (repoPath: string, hash?: string) => LinkAnswer | Promise<LinkAnswer>;
};

export type RenderedBlock = {
  id: string;
  /** The tag the block renders as: `p`, `h2`, `li`, `tr`, ... */
  kind: string;
  lines: readonly [number, number];
  group?: string;
  mark?: 'added' | 'modified';
};

export type DifferenceKind = 'mermaid' | 'math' | 'diagram' | 'remoteImage' | 'outsideLink' | 'localImage';

export type RenderedFragment = {
  html: string;
  blocks: RenderedBlock[];
  headings: Array<{id: string; depth: number; text: string}>;
  links: PageLink[];
  /** Every id a link can point at on the page: its headings' and its HTML's, `user-content-` first. */
  anchors: string[];
  /** The repo images the page's own text shows. */
  images: PageImageUse[];
  /**
   * Where in `html` each link with a `ref` starts its attributes, right
   * after `<a`, by the ref's index: the page, once it knows the other
   * pages' anchors, draws the ones that point nowhere broken there.
   */
  refOffsets?: number[];
  assetOids: string[];
  /** Where the page is known to differ from github.com, counted. */
  differences: Array<{kind: DifferenceKind; count: number}>;
  /** Blocks marked changed, and removed-content markers placed. */
  changes: {changed: number; removed: number};
  /** The source as the diff showed it, for the page's first frame. */
  raw?: RawSource;
};

type Lookups = Pick<RenderInput, 'asset' | 'baseAsset' | 'assetChanged' | 'link'>;

type TreeOptions = Lookups & {
  path: string;
  status?: FileStatus;
  textUnchanged?: true;
  basePath?: string;
  // Where this text's images resolve from, when not `path`: the base
  // side's text of a file the review moved.
  imagesFrom?: string;
  // Change runs to mark; null renders without marks (removed and base text).
  groups: ChangeGroup[] | null;
  // Heading anchors carry ids, so only the page's own text gets them.
  anchors: boolean;
};

type Tally = {
  differences: Map<DifferenceKind, number>;
  assetOids: Set<string>;
  // Image bytes inlined so far, before views and removed markers included:
  // the whole page shares one budget.
  inlined: {bytes: number};
};

type RenderedTree = {
  tree: Root;
  blocks: RenderedBlock[];
  headings: RenderedFragment['headings'];
  links: RenderedFragment['links'];
  anchors: string[];
  images: PageImageUse[];
  refAttribute?: string;
  changes: RenderedFragment['changes'];
};

// The HTML of the page's tree, and where each link a ref names starts its
// attributes. The refs ride on an attribute made fresh for this render,
// which no repo text holds, and come out here.
function stringifyWithRefs(tree: Root, attribute: string | undefined): {html: string; refOffsets?: number[]} {
  const marked = unified().use(rehypeStringify).stringify(tree);
  if (!attribute) return {html: marked};
  const refOffsets: number[] = [];
  let removed = 0;
  const html = marked.replace(new RegExp(` ${attribute}="(\\d+)"`, 'g'), (found: string, index: string, at: number) => {
    refOffsets[Number(index)] = at - removed;
    removed += found.length;
    return '';
  });
  return refOffsets.length > 0 ? {html, refOffsets} : {html};
}

export async function renderMarkdown(input: RenderInput): Promise<RenderedFragment> {
  const tally: Tally = {differences: new Map(), assetOids: new Set(), inlined: {bytes: 0}};
  const rendered = await renderTree(input.source, {...input, groups: input.groups, anchors: true}, tally);
  return {
    ...stringifyWithRefs(rendered.tree, rendered.refAttribute),
    blocks: rendered.blocks,
    headings: rendered.headings,
    links: rendered.links,
    anchors: rendered.anchors,
    images: rendered.images,
    assetOids: [...tally.assetOids],
    differences: [...tally.differences].map(([kind, count]) => ({kind, count})),
    changes: rendered.changes,
    raw: rawSource(input.source, input.groups, input.status),
  };
}

async function renderTree(source: string, options: TreeOptions, tally: Tally): Promise<RenderedTree> {
  const stamp = privateAttribute();
  const processor = parser(stamp.property);
  const {mdast, hast: raw} = await parseOnGitLines(processor, source);
  const sourceLines = source.split('\n');
  const candidates = options.groups ? collectBlocks(raw, sourceLines, stamp.property) : [];

  // The sanitizer makes a new tree: `raw` stays as parsed, for the side's
  // context below.
  const tree = unified().use(rehypeSanitize, sanitizeSchema(stamp.property)).runSync(raw) as Root;

  const headings = options.anchors ? addHeadingAnchors(tree, stamp.property) : [];
  const blockNodes = readStamps(tree, stamp.property);
  replaceEmoji(tree);
  finishGithubMarkup(tree, tally);
  await highlightCode(tree, tally);
  // Only the page's own text says where links point and what they can
  // point at; nested renders are views of it.
  const refs = options.anchors ? privateAttribute() : null;
  // Links and images are looked up side by side, so a slow link check
  // never spends the time the page's images have. The images' differences
  // count after the links', as if looked up second, so the chip's list
  // keeps one order.
  const imageTally: Tally = {...tally, differences: new Map()};
  const [{links, anchors}, {looked, uses}] = await Promise.all([resolveLinks(tree, options, tally, refs?.property ?? null), resolveImages(tree, options, imageTally)]);
  for (const [kind, n] of imageTally.differences) tally.differences.set(kind, (tally.differences.get(kind) ?? 0) + n);

  const blocks: RenderedBlock[] = [];
  const changes = {changed: 0, removed: 0};
  if (options.groups) {
    const groups = options.groups;
    // A changed image marks its block even where the text is the same, as
    // in a file the branch didn't touch at all.
    const imageLines = groups.length > 0 || options.textUnchanged ? await changedImageLines(looked, options) : new Set<number>();
    const compare = groups.length > 0 || imageLines.size > 0;
    // The base side is parsed only for its blocks' positions. Nothing of it
    // shows except through the nested renders below, which sanitize.
    const base = compare ? await baseSide(processor, source, groups) : emptySide();
    const page: Side = {blocks: candidates, lines: sourceLines, ...(compare ? sideContext(mdast, raw, source) : emptySide())};
    const {marks, removals} = compare
      ? markBlocks({blocks: candidates, lines: sourceLines}, {blocks: base.blocks, lines: base.lines}, groups, imageLines)
      : {marks: [], removals: []};
    // Nested renders count their own differences: the page's chip counts
    // only what the page itself shows. Images in what reaches the page share
    // its budget; renders made only to compare get budgets of their own, so
    // both sides of a comparison inline the same images.
    const nested: TreeOptions = {...options, groups: null, anchors: false};
    const nestedBase: TreeOptions = {...nested, asset: options.baseAsset ?? options.asset, imagesFrom: options.basePath ?? options.path};
    const nestedTally = (): Tally => ({differences: new Map(), assetOids: tally.assetOids, inlined: tally.inlined});
    const trialTally = (): Tally => ({differences: new Map(), assetOids: new Set(), inlined: {bytes: 0}});

    for (const [index, candidate] of candidates.entries()) {
      let mark = marks[index] ?? null;
      let before: BaseRender | null = null;
      if (mark?.kind === 'modified' && mark.was.length > 0) {
        const trial = trialTally();
        before = await renderBase(base, mark.was, nestedBase, trial);
        // Text that changed without changing what the page shows, such as a
        // renumbered list item or a trailing space, is no change to mark.
        if (before && sameRendering(before, await renderBase(page, [index], nested, trialTally()))) mark = null;
        // The view the page keeps, within what the page has left.
        else if (before && trial.inlined.bytes > 0) before = await renderBase(base, mark.was, nestedBase, nestedTally());
      }
      const placed = blockNodes.get(index);
      const group = mark?.groups[0];
      blocks.push({id: candidate.id, kind: candidate.tag, lines: candidate.lines, ...(mark ? {...(group ? {group} : {}), mark: mark.kind} : {})});
      if (!placed) continue;
      // Every block carries its id and source lines, so the page can find
      // the block a diff line belongs to.
      placed.node.properties.dataBlock = candidate.id;
      placed.node.properties.dataLines = `${candidate.lines[0]}-${candidate.lines[1]}`;
      if (!mark) continue;
      const marked = INLINE_TAGS.has(placed.node.tagName) ? markBox(placed) : placed;
      // A removed marker placed before this block goes before its box.
      blockNodes.set(index, marked);
      marked.node.properties.dataMark = mark.kind;
      changes.changed += 1;
      if (before) placeChip(marked, candidate.tag, details('br-before', 'before', 'br-before-body', before.nodes));
    }

    for (const removal of removals) {
      const removed = await renderBase(base, removal.blocks, nestedBase, nestedTally());
      // Text that renders as nothing, such as a link definition or an HTML
      // comment, left nothing on the page to mark.
      if (!removed) continue;
      const next = removal.before === null ? undefined : candidates[removal.before];
      const marker = removedMarker(removed, next, sourceLines);
      const target = removal.before === null ? undefined : blockNodes.get(removal.before);
      if (target) insertBefore(target, marker);
      else insertAtBodyEnd(tree, marker);
      changes.removed += 1;
    }
  }

  return {tree, blocks, headings, links, anchors, images: uses, ...(refs ? {refAttribute: refs.attribute} : {}), changes};
}

function parser(stampProperty: string) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkAlerts, {stamp: stampProperty})
    // An empty prefix here: the sanitizer adds `user-content-` to every id,
    // so footnote ids get it once, as on GitHub.
    .use(remarkRehype, {allowDangerousHtml: true, clobberPrefix: '', handlers: {yaml: frontmatterTable as never}})
    .use(rehypeRaw);
}

/**
 * One side of the diff, for rendering its blocks on their own: the blocks,
 * the source lines, and what a block needs from the rest of its file. That
 * is each link definition, a label for each footnote so a reference to it
 * renders as one, and the number each footnote reference shows on the
 * whole page, by its target.
 */
type Side = {blocks: Candidate[]; lines: string[]; definitions: Map<string, string[]>; footnoteLabels: Map<string, string>; footnoteNumbers: Map<string, string>};

function emptySide(): Side {
  return {blocks: [], lines: [], definitions: new Map(), footnoteLabels: new Map(), footnoteNumbers: new Map()};
}

// A label as CommonMark matches it: case folded, runs of white space as one.
const labelKey = (label: string) => normalizeIdentifier(label).toLowerCase().toUpperCase();

async function baseSide(processor: ReturnType<typeof parser>, source: string, groups: ChangeGroup[]): Promise<Side> {
  const text = baseText(source, groups);
  const lines = text.split('\n');
  const {mdast, hast: root} = await parseOnGitLines(processor, text);
  return {blocks: collectBlocks(root, lines, null), lines, ...sideContext(mdast, root, text)};
}

/**
 * Both trees of `text`, their positions counted on git's lines. git ends a
 * line only at a newline, and every line number a diff gives is git's; the
 * parser also ends one at a lone carriage return. In a file with one, each
 * position is read again from its offset, which both counts share.
 */
async function parseOnGitLines(processor: ReturnType<typeof parser>, text: string) {
  const mdast = processor.parse(text);
  const recount = /\r(?!\n)/.test(text);
  if (recount) countGitLines(mdast, text);
  const hast = await processor.run(mdast) as Root;
  // Raw HTML is parsed again on the way, with the parser's count.
  if (recount) countGitLines(hast, text);
  return {mdast, hast};
}

type Positioned = {position?: {start: {line: number; column: number; offset?: number}; end: {line: number; column: number; offset?: number}}; children?: Positioned[]};

function countGitLines(tree: Positioned, text: string) {
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  const recount = (point: {line: number; column: number; offset?: number}) => {
    if (point.offset === undefined) return;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= point.offset) low = middle;
      else high = middle - 1;
    }
    point.line = low + 1;
    point.column = point.offset - starts[low]! + 1;
  };
  const visit = (node: Positioned) => {
    if (node.position) {
      recount(node.position.start);
      recount(node.position.end);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

// Each link definition by its label, every one in file order (the first
// wins, as on the page), and each footnote's label by its normalized form.
function sideContext(mdast: MdastRoot, hast: Root, source: string): Pick<Side, 'definitions' | 'footnoteLabels' | 'footnoteNumbers'> {
  const definitions = new Map<string, string[]>();
  const footnoteLabels = new Map<string, string>();
  const visit = (node: MdastNodes, nested: boolean) => {
    if (node.type === 'definition' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      const text = source.slice(node.position.start.offset, node.position.end.offset);
      // A definition inside a quote or a list item keeps that container's
      // marks on its later lines; at the top of a file it needs none. Keyed
      // by the label as written, as a reference names it (`identifier`):
      // `label` is decoded, so `R&amp;D` there is `R&D`.
      const key = labelKey(node.identifier);
      definitions.set(key, [...(definitions.get(key) ?? []), nested ? text.split('\n').map((line, index) => (index === 0 ? line : line.replace(/^[ \t>]*/, ''))).join('\n') : text]);
    } else if (node.type === 'footnoteDefinition') {
      // The label as written, which a view's context defines it by again.
      const label = writtenFootnoteLabel(node, source) ?? node.label ?? node.identifier;
      if (!footnoteLabels.has(labelKey(node.identifier))) footnoteLabels.set(labelKey(node.identifier), label);
    }
    if ('children' in node) for (const child of node.children) visit(child, node.type !== 'root');
  };
  visit(mdast, false);

  const footnoteNumbers = new Map<string, string>();
  walk(hast, (node) => {
    if (node.tagName === 'a' && node.properties.dataFootnoteRef !== undefined && typeof node.properties.href === 'string') {
      footnoteNumbers.set(footnoteTarget(node.properties.href), textOf(node));
    }
  });
  return {definitions, footnoteLabels, footnoteNumbers};
}

// A footnote definition's label as the source writes it, between its `[^`
// and the first `]`, or null when its position isn't known.
function writtenFootnoteLabel(node: {position?: {start: {offset?: number}}}, source: string): string | null {
  const start = node.position?.start.offset;
  if (start === undefined || !source.startsWith('[^', start)) return null;
  const close = source.indexOf(']', start + 2);
  return close < 0 ? null : source.slice(start + 2, close);
}

// A footnote reference's target, the same before and after the sanitizer
// and the link pass prefix it.
function footnoteTarget(href: string) {
  return href.replace(/^#(?:user-content-)?/, '');
}

// The page's body ends before the footnotes, which GitHub always shows last.
function insertAtBodyEnd(tree: Root, node: Element) {
  const footnotes = tree.children.findIndex((child) => child.type === 'element' && child.tagName === 'section' && child.properties.dataFootnotes !== undefined);
  if (footnotes < 0) tree.children.push(node);
  else tree.children.splice(footnotes, 0, node);
}

const STRIPPED = ['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'textarea', 'select', 'title', 'svg', 'math', 'xmp', 'noembed', 'noframes'];

// GitHub's schema model, as rehype-sanitize ships it, with three changes:
// elements whose text is code or styling go entirely rather than leaving
// their text behind, links are only http(s), mailto, relative or `#`, and
// this render's private attribute may pass.
function sanitizeSchema(stampProperty: string) {
  return {
    ...defaultSchema,
    strip: [...(defaultSchema.strip ?? []), ...STRIPPED],
    protocols: {...defaultSchema.protocols, href: ['http', 'https', 'mailto']},
    attributes: {...defaultSchema.attributes, '*': [...(defaultSchema.attributes?.['*'] ?? []), stampProperty]},
  };
}

/**
 * `column` is where the block starts on its first line. A table row also
 * names its table's first line and column, which a table nested in a list
 * item needs to render on its own.
 */
type Candidate = MarkableBlock & {id: string; column: number; table?: {line: number; column: number}};

// Top-level blocks, list items and table rows, in document order, each with
// its source lines and a stable id. With a stamp, each one gets `b:<index>`
// in the private attribute so it can be found again after the sanitizer
// rebuilt the tree.
function collectBlocks(root: Root, sourceLines: string[], stampProperty: string | null): Candidate[] {
  const candidates: Candidate[] = [];
  const nextId = createBlockIds();
  const visit = (node: Parents, parent: number | null, topLevel: boolean, footnote: boolean, table: Candidate['table']) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      const start = child.position?.start;
      const end = child.position?.end.line;
      const inFootnotes = footnote || (child.tagName === 'section' && child.properties.dataFootnotes !== undefined);
      const inTable = child.tagName === 'table' && start ? {line: start.line, column: start.column} : table;
      let enclosing = parent;
      if ((topLevel || child.tagName === 'li' || child.tagName === 'tr') && start && end) {
        const text = sourceLines.slice(start.line - 1, end).join('\n');
        candidates.push({
          id: nextId(text), tag: child.tagName, lines: [start.line, end], parent, text, footnote: inFootnotes, column: start.column,
          ...(child.tagName === 'tr' && inTable ? {table: inTable} : {}),
        });
        enclosing = candidates.length - 1;
        if (stampProperty) addToken(child, stampProperty, `b:${enclosing}`);
      }
      visit(child, enclosing, false, inFootnotes, inTable);
    }
  };
  visit(root, null, true, false, undefined);
  return candidates;
}

function addToken(node: Element, property: string, token: string) {
  const existing = node.properties[property];
  node.properties[property] = typeof existing === 'string' && existing ? `${existing} ${token}` : token;
}

type Placed = {node: Element; parent: Parents};

const ALERT_ICONS: Record<AlertType, OcticonName> = {note: 'info', tip: 'light-bulb', important: 'report', warning: 'alert', caution: 'stop'};

// Turns each private token into what it stands for, then removes the
// attribute: alert classes and title icons, and the block ids and source
// lines on every candidate. Returns where each candidate ended up.
function readStamps(tree: Root, stampProperty: string): Map<number, Placed> {
  const placed = new Map<number, Placed>();
  walk(tree, (node, parent) => {
    const value = node.properties[stampProperty];
    if (typeof value !== 'string') return;
    delete node.properties[stampProperty];
    for (const token of value.split(' ')) {
      const [kind, arg = ''] = token.split(':');
      if (kind === 'b') placed.set(Number(arg), {node, parent});
      else if (kind === 'alert') node.properties.className = ['markdown-alert', `markdown-alert-${arg}`];
      else if (kind === 'alert-title') {
        node.properties.className = ['markdown-alert-title'];
        node.children.unshift(octicon(ALERT_ICONS[arg as AlertType], 'mr-2'));
      }
    }
  });
  return placed;
}

function walk(node: Parents, visit: (node: Element, parent: Parents) => void | 'skip') {
  for (const child of [...node.children]) {
    if (child.type !== 'element') continue;
    if (visit(child, node) === 'skip') continue;
    walk(child, visit);
  }
}

function textOf(node: Parents | ElementContent | RootContent): string {
  if (node.type === 'text') return node.value;
  if ('children' in node) return node.children.map((child) => textOf(child)).join('');
  return '';
}

const HEADING = /^h[1-6]$/;

// GitHub's heading markup: `div.markdown-heading > h2.heading-element` with a
// sibling `a.anchor` that carries the `user-content-` id. The heading node is
// rewritten in place into the wrapper, so anything holding it (the block map)
// holds the wrapper, and the wrapper keeps the private attribute.
function addHeadingAnchors(tree: Root, stampProperty: string): RenderedFragment['headings'] {
  const slugger = new GithubSlugger();
  const headings: RenderedFragment['headings'] = [];
  walk(tree, (node) => {
    // The footnotes section's label is for screen readers only, with no
    // anchor on GitHub.
    if (node.tagName === 'section' && node.properties.dataFootnotes !== undefined) return 'skip';
    if (!HEADING.test(node.tagName)) return;
    const text = textOf(node);
    const slug = slugger.slug(text);
    headings.push({id: slug, depth: Number(node.tagName[1]), text});
    const {[stampProperty]: stamp, ...rest} = node.properties;
    const heading: Element = {
      type: 'element',
      tagName: node.tagName,
      properties: {...rest, tabIndex: -1, className: ['heading-element']},
      children: node.children,
      position: node.position,
    };
    const anchor: Element = {
      type: 'element',
      tagName: 'a',
      properties: {id: `user-content-${slug}`, className: ['anchor'], ariaLabel: `Permalink: ${text}`, href: `#user-content-${slug}`},
      children: [octicon('link')],
    };
    node.tagName = 'div';
    node.properties = {className: ['markdown-heading'], ...(stamp === undefined ? {} : {[stampProperty]: stamp})};
    node.children = [heading, anchor];
    return 'skip';
  });
  return headings;
}

const SHORTCODE = /:([a-z0-9_+-]+):/g;
const NO_EMOJI = new Set(['code', 'pre', 'kbd', 'samp']);

function replaceEmoji(tree: Root) {
  const visit = (node: Parents) => {
    for (const child of node.children) {
      if (child.type === 'text') {
        // Own keys only: `:constructor:` names no emoji.
        child.value = child.value.replace(SHORTCODE, (match, name: string) => (Object.hasOwn(nameToEmoji, name) ? nameToEmoji[name]! : match));
      } else if (child.type === 'element' && !NO_EMOJI.has(child.tagName)) {
        visit(child);
      }
    }
  };
  visit(tree);
}

// Inline `$x$` and display `$$` math, which GitHub typesets. Prices such as
// `$5 and $10` don't match: the closing `$` must follow a non-space.
const INLINE_MATH = /(?<![\w$])\$(?=\S)[^$\n]*?\S\$(?![\w$])|\$\$/g;

// Small touches GitHub makes to markup the sanitizer leaves bare: the class
// its stylesheet gives task checkboxes, and a count of the math it would
// typeset, which here stays as text.
function finishGithubMarkup(tree: Root, tally: Tally) {
  const visit = (node: Parents) => {
    for (const child of node.children) {
      if (child.type === 'text') {
        for (const _ of child.value.matchAll(INLINE_MATH)) count(tally, 'math');
      } else if (child.type === 'element' && !NO_EMOJI.has(child.tagName)) {
        if (child.tagName === 'input' && child.properties.type === 'checkbox') child.properties.className = ['task-list-item-checkbox'];
        visit(child);
      }
    }
  };
  visit(tree);
}

// Fenced code GitHub draws as a picture rather than as code.
const DRAWN: Record<string, {kind: DifferenceKind; tag: string}> = {
  mermaid: {kind: 'mermaid', tag: 'diagram · GitHub draws this'},
  geojson: {kind: 'diagram', tag: 'map · GitHub draws this'},
  topojson: {kind: 'diagram', tag: 'map · GitHub draws this'},
  stl: {kind: 'diagram', tag: '3D model · GitHub draws this'},
  math: {kind: 'math', tag: 'math · GitHub typesets this'},
};

type StarryNight = Awaited<ReturnType<typeof import('@wooorm/starry-night')['createStarryNight']>>;
let starryNight: Promise<StarryNight> | undefined;

// Loaded on the first page that has a fenced language, or the first diff
// the Review in browser page colors: the grammars are most of the
// renderer's start-up cost.
export function loadStarryNight() {
  starryNight ??= import('@wooorm/starry-night').then(({common, createStarryNight}) => createStarryNight(common));
  return starryNight;
}

function codeLanguage(pre: Element) {
  const code = pre.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
  const className = code?.properties.className;
  const languageClass = Array.isArray(className) ? className.find((name) => String(name).startsWith('language-')) : undefined;
  return code ? {code, language: languageClass ? String(languageClass).slice('language-'.length).toLowerCase() : null} : null;
}

// Highlighting with GitHub's own grammars, as `pl-*` classes the vendored
// stylesheet colors. A diagram or math block stays as its source with a tag
// that says GitHub draws it, and counts as a difference.
async function highlightCode(tree: Root, tally: Tally) {
  const blocks: Array<{pre: Element; code: Element; language: string | null}> = [];
  walk(tree, (node) => {
    if (node.tagName !== 'pre') return;
    const found = codeLanguage(node);
    if (found) blocks.push({pre: node, ...found});
    return 'skip';
  });

  // Own keys only: a fence named `constructor` is code like any other.
  const drawnFor = (language: string | null) => (language !== null && Object.hasOwn(DRAWN, language) ? DRAWN[language] : undefined);
  const tagged = blocks.filter((block) => drawnFor(block.language));
  for (const {pre, code, language} of tagged) {
    const drawn = drawnFor(language)!;
    count(tally, drawn.kind);
    code.properties = {};
    const inner: Element = {type: 'element', tagName: 'pre', properties: {}, children: pre.children};
    pre.tagName = 'div';
    pre.properties = {className: ['br-drawn']};
    pre.children = [{type: 'element', tagName: 'span', properties: {className: ['br-tag']}, children: [{type: 'text', value: drawn.tag}]}, inner];
  }

  const highlight = blocks.filter((block) => block.language && !drawnFor(block.language));
  if (highlight.length === 0) return;
  const starry = await loadStarryNight();
  for (const {pre, code, language} of highlight) {
    const scope = starry.flagToScope(language!);
    if (!scope) continue;
    const highlighted = starry.highlight(textOf(code), scope);
    const inner: Element = {type: 'element', tagName: 'pre', properties: {}, children: highlighted.children as ElementContent[]};
    pre.tagName = 'div';
    pre.properties = {className: ['highlight', `highlight-${scope.replace(/\./g, '-')}`]};
    pre.children = [inner];
  }
}

function count(tally: Tally, kind: DifferenceKind) {
  tally.differences.set(kind, (tally.differences.get(kind) ?? 0) + 1);
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isRemote(url: string) {
  return url.startsWith('//') || /^https?:/i.test(url);
}

/**
 * The repo path a relative URL in `fromFile` names, POSIX-normalized, or null
 * when it climbs out of the repo or names its root. A leading `/` is the repo
 * root, as on GitHub. A URL that decodes to an absolute path (`/%2F/etc`) or
 * to a control character such as NUL names no file in the repo either, so
 * no lookup ever hands one to git.
 */
export function repoPathFor(fromFile: string, url: string): string | null {
  let target = url.split('#')[0]!.split('?')[0]!;
  try {
    target = decodeURIComponent(target);
  } catch {
    // A stray `%` stays as written.
  }
  const joined = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(fromFile), target);
  const normal = path.posix.normalize(joined).replace(/\/+$/, '');
  if (normal === '' || normal === '.' || normal === '..' || normal.startsWith('../') || normal.startsWith('/')) return null;
  if (/[\u0000-\u001f\u007f]/.test(normal)) return null;
  return normal;
}

function decodeHash(hash: string) {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

// Links resolve here, without a script on the page: `#slug` points at the
// `user-content-` id GitHub's own script would scroll to, a link to another
// rendered file points at its page, and a link to anything else in the repo
// is inert, since there is no page to open: dotted when GitHub would find
// the file, drawn broken when it wouldn't. External links open with no
// referrer and no opener. A link to a heading on another rendered page
// carries `refProperty` until the page is assembled, which then knows that
// page's anchors. Every path is asked at once; the answers apply in page
// order.
async function resolveLinks(tree: Root, options: TreeOptions, tally: Tally, refProperty: string | null): Promise<{links: PageLink[]; anchors: string[]}> {
  const anchors = pageAnchors(tree);
  const ids = new Set(anchors);
  // Only the text the report checks draws a link broken: the page's own,
  // on a page that stays on GitHub and that the review changed. `before`
  // views and removed markers are old text, a deleted file's page is gone,
  // and a page whose text is unchanged isn't the review's; their links stay
  // inert and dotted.
  const drawn = options.anchors && !options.textUnchanged && options.status !== 'deleted';

  type Pending = {node: Element; link: PageLink; repoPath: string | null; hash: string | undefined; answer: Promise<LinkAnswer>};
  const links: PageLink[] = [];
  const pending: Pending[] = [];
  walk(tree, (node) => {
    if (node.tagName !== 'a' || typeof node.properties.href !== 'string') return;
    const href = node.properties.href;
    const line = node.position?.start.line ?? 0;
    const className = node.properties.className;
    if (Array.isArray(className) && className.includes('anchor')) return;

    if (href.startsWith('#')) {
      const target = decodeHash(href.slice(1));
      if (tripHashLike(href.slice(1)) || tripHashLike(target)) {
        makeInert(node, {kind: 'badAnchor'}, drawn);
        links.push({href, status: 'badAnchor', line});
        return;
      }
      const found = anchorTarget(ids, target);
      if (found !== null && found !== 'top') node.properties.href = `#${found}`;
      // As on GitHub, a link to a heading that isn't there stays a link.
      else if (found === null && drawn) Object.assign(node.properties, {className: ['br-broken'], title: LINK_TEXT.badAnchor});
      links.push({href, status: found !== null ? 'ok' : 'badAnchor', line});
      return;
    }

    if (SCHEME.test(href) || href.startsWith('//')) {
      node.properties.rel = ['nofollow', 'noopener', 'noreferrer'];
      links.push({href, status: 'ok', line});
      return;
    }

    const repoPath = repoPathFor(options.path, href);
    const hash = href.includes('#') ? decodeHash(href.slice(href.indexOf('#') + 1)) : undefined;
    const answer = repoPath === null ? {kind: 'outside' as const} : hash !== undefined && tripHashLike(hash) ? {kind: 'badAnchor' as const} : options.link(repoPath, hash);
    // A lookup that fails is no finding: a wrong mark is worse than a missing one.
    const settled = Promise.resolve(answer).catch((): LinkAnswer => ({kind: 'outside'}));
    const link: PageLink = {href, status: 'ok', line};
    links.push(link);
    pending.push({node, link, repoPath, hash, answer: settled});
  });

  const answers = await Promise.all(pending.map((each) => each.answer));
  let refs = 0;
  for (const [index, {node, link, repoPath, hash}] of pending.entries()) {
    const answer = answers[index]!;
    if (answer.kind === 'inReview') {
      const anchor = hash ? withPrefix(hash) : '';
      node.properties.href = `${answer.href}${anchor ? `#${anchor}` : ''}`;
      // The top of a page is always there, so only a heading needs checking.
      if (anchor && !pageTop(hash!) && refProperty && repoPath !== null) {
        // First of the link's attributes, so the page knows where they
        // start when it draws the link broken (finishRefs).
        node.properties = {[refProperty]: String(refs), ...node.properties};
        link.ref = {path: repoPath, anchor, index: refs};
        refs += 1;
      }
      continue;
    }
    makeInert(node, answer, drawn);
    if (answer.kind === 'outside') count(tally, 'outsideLink');
    link.status = answer.kind;
    if (answer.kind === 'caseMismatch') link.hint = answer.hint;
  }
  return {links, anchors};
}



// Every id on the page a link can point at: those its headings, footnotes
// and HTML carry once the sanitizer gave them their prefix, by `id` or by
// `name`, sorted.
function pageAnchors(tree: Root): string[] {
  const ids = new Set<string>();
  walk(tree, (node) => {
    for (const key of ['id', 'name']) {
      const value = node.properties[key];
      if (typeof value === 'string' && value.startsWith('user-content-')) ids.add(value);
    }
  });
  return [...ids].sort();
}

/**
 * The ids a link can point at on the page `source` renders to, as that
 * page's own render lists them in `anchors`, for a markdown file the
 * review doesn't render: a link into it can still be checked.
 */
export async function markdownAnchors(source: string): Promise<string[]> {
  const stamp = privateAttribute();
  const processor = parser(stamp.property);
  const hast = await processor.run(processor.parse(source)) as Root;
  const tree = unified().use(rehypeSanitize, sanitizeSchema(stamp.property)).runSync(hast) as Root;
  addHeadingAnchors(tree, stamp.property);
  return pageAnchors(tree);
}

// No page to open for it: the link stays readable, inert, and says why. One
// GitHub wouldn't resolve either is drawn broken, where `drawn`. One with
// no answer is plain text: neither the dotted underline of a file outside
// the review nor a broken one would be true of it.
function makeInert(node: Element, answer: Exclude<LinkAnswer, {kind: 'inReview'}>, drawn: boolean) {
  delete node.properties.href;
  if (answer.kind === 'unchecked') {
    Object.assign(node.properties, {className: ['br-unchecked'], title: LINK_TEXT.unchecked});
    return;
  }
  node.properties.className = answer.kind === 'outside' || !drawn ? ['br-inert'] : ['br-inert', 'br-broken'];
  node.properties.title = answer.kind === 'outside' ? LINK_TEXT.outside : linkReason(answer.kind, 'hint' in answer ? answer.hint : undefined);
}

// A fragment the page script would read as a trip's hash (`d=full`,
// `g=<ids>`, colors), which no GitHub heading slug can be: a repo link
// carrying one could make the page play a develop or a pulse the diff
// never asked for.
function tripHashLike(fragment: string) {
  return Object.keys(readPageHash(fragment)).length > 0;
}

// The first URL of a `srcset`, which is all a markdown `<picture>` uses.
function srcsetUrl(srcset: unknown) {
  const value = Array.isArray(srcset) ? srcset.join(',') : typeof srcset === 'string' ? srcset : '';
  return value.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
}

/** A repo image the page shows, as written, and the source line it sits on. */
type PageImage = {repoPath: string; url: string; line: number};

// Every image becomes bytes inside the page or a card in its place, so the
// page never asks for anything: a remote image is a dashed pill, never a
// request, and a `<source>` that can't be inlined is dropped so the
// `<img>` fallback shows. Returns the repo images it looked up, and how
// each `<img>` among them resolved.
async function resolveImages(tree: Root, options: TreeOptions, tally: Tally): Promise<{looked: PageImage[]; uses: PageImageUse[]}> {
  const images: Array<{node: Element; parent: Parents; url: string}> = [];
  walk(tree, (node, parent) => {
    if (node.tagName === 'img' && typeof node.properties.src === 'string') images.push({node, parent, url: node.properties.src});
    else if (node.tagName === 'source') images.push({node, parent, url: srcsetUrl(node.properties.srcSet)});
  });

  // Every distinct image is asked for at once, so a page's lookups take the
  // time of the slowest rather than of all of them in turn. They are used
  // in page order, which is the order the page budget counts them in.
  const answers = new Map<string, Promise<AssetAnswer>>();
  const looked: PageImage[] = [];
  const uses: PageImageUse[] = [];
  const repoPathOf = (url: string) => (url === '' || isRemote(url) ? null : repoPathFor(options.imagesFrom ?? options.path, url));
  for (const {node, url} of images) {
    const repoPath = repoPathOf(url);
    if (repoPath === null) continue;
    looked.push({repoPath, url, line: node.position?.start.line ?? 0});
    if (answers.has(repoPath)) continue;
    const answer = options.asset(repoPath);
    // Awaited in turn below; a failure is seen there, not before.
    answer.catch(() => undefined);
    answers.set(repoPath, answer);
  }

  // GitHub shows one image of a `#gh-dark-mode-only` and
  // `#gh-light-mode-only` pair per theme, so a pair of cards is one
  // difference: the plain cards, plus the larger of the two themes' counts.
  const cards = new Map<DifferenceKind, {plain: number; dark: number; light: number}>();
  const countCard = (kind: DifferenceKind, theme: 'dark' | 'light' | undefined) => {
    const counts = cards.get(kind) ?? {plain: 0, dark: 0, light: 0};
    counts[theme ?? 'plain'] += 1;
    cards.set(kind, counts);
  };

  for (const {node, parent, url} of images) {
    const isSource = node.tagName === 'source';
    const theme = /#gh-(dark|light)-mode-only$/.exec(url)?.[1] as 'dark' | 'light' | undefined;
    const alt = typeof node.properties.alt === 'string' ? node.properties.alt : '';
    const remote = url === '' || isRemote(url);
    const repoPath = remote ? null : repoPathOf(url);
    let answer: AssetAnswer = remote
      ? {kind: 'refused', reason: 'remote'}
      : repoPath === null ? {kind: 'refused', reason: 'outside'} : await answers.get(repoPath)!;
    if (answer.kind === 'embed') {
      if (tally.inlined.bytes + answer.dataUrl.length > PAGE_INLINE_LIMIT) answer = {kind: 'refused', reason: 'pageLimit'};
      else tally.inlined.bytes += answer.dataUrl.length;
    }
    if (!remote && !isSource && url !== '') {
      const status = answer.kind === 'refused' ? answer.reason : answer.kind;
      const hint = answer.kind === 'refused' && answer.reason === 'caseMismatch' ? answer.hint : undefined;
      uses.push({path: repoPath ?? url, url, line: node.position?.start.line ?? 0, status, ...(hint ? {hint} : {})});
    }

    if (answer.kind === 'embed') {
      tally.assetOids.add(answer.oid);
      if (isSource) node.properties.srcSet = answer.dataUrl;
      else node.properties.src = answer.dataUrl;
      // The picture's own size, so the page has its final layout before
      // the image decodes: WebKit decodes a data: image after the page
      // script has placed the reader's block. Only where the author set no
      // size and no <source> may swap in another picture; page.css keeps
      // the height in proportion when the width shrinks to fit.
      if (!isSource && answer.width && answer.height && node.properties.width === undefined && node.properties.height === undefined && !(parent.type === 'element' && parent.tagName === 'picture')) {
        node.properties.width = answer.width;
        node.properties.height = answer.height;
        node.properties.dataBrSize = '';
      }
      if (theme && !isSource) node.properties.dataGhTheme = theme;
      // Shown, as the work tree has it, with the same word the page's own
      // banner gives an untracked file.
      if (answer.untracked && !isSource) insertAfter({node, parent}, imageNote('untracked · not part of a push yet', theme));
      continue;
    }
    if (isSource) {
      parent.children.splice(parent.children.indexOf(node), 1);
      continue;
    }
    if (url === '' && !node.properties.src) continue;

    let next: Element;
    if (answer.kind === 'refused' && answer.reason === 'remote') {
      countCard('remoteImage', theme);
      next = card(['br-card', 'br-remote'], [alt, hostOf(url), REFUSED_TEXT.remote]);
    } else if (answer.kind === 'skipped') {
      countCard('localImage', theme);
      next = card(['br-card', 'br-skipped'], [alt, repoPath ?? url, 'not embedded']);
    } else {
      const said = refusedCard(answer.reason, answer.hint);
      next = card(['br-card', said.soft ? 'br-soft' : 'br-refused'], [said.text, repoPath ?? url]);
    }
    // The card shows in the theme the image would, as the image does.
    if (theme) next.properties.dataGhTheme = theme;
    replaceWith(node, next);
  }
  for (const [kind, {plain, dark, light}] of cards) {
    tally.differences.set(kind, (tally.differences.get(kind) ?? 0) + plain + Math.max(dark, light));
  }
  return {looked, uses};
}

// The source lines that show an image whose content changed on the branch.
// The base side's text of a moved file found the image from its old folder;
// one it found outside the repo there is no change to mark.
async function changedImageLines(images: PageImage[], options: TreeOptions) {
  const {assetChanged} = options;
  const lines = new Set<number>();
  if (!assetChanged) return lines;
  const changed = new Map<string, Promise<boolean>>();
  const keyOf = ({repoPath, url}: PageImage) => {
    const basePath = repoPathFor(options.basePath ?? options.path, url);
    return basePath === null ? null : {key: `${repoPath}\0${basePath}`, repoPath, basePath};
  };
  for (const image of images) {
    const found = keyOf(image);
    if (!found || changed.has(found.key)) continue;
    const answer = assetChanged(found.repoPath, found.basePath);
    answer.catch(() => undefined);
    changed.set(found.key, answer);
  }
  for (const image of images) {
    const found = keyOf(image);
    if (found && await changed.get(found.key)!) lines.add(image.line);
  }
  return lines;
}

function imageNote(text: string, theme: 'dark' | 'light' | undefined): Element {
  return {type: 'element', tagName: 'span', properties: {className: ['br-image-note'], ...(theme ? {dataGhTheme: theme} : {})}, children: [{type: 'text', value: text}]};
}

function hostOf(url: string) {
  try {
    return new URL(url, 'https://invalid.example').host;
  } catch {
    return 'remote';
  }
}

function card(className: string[], parts: string[]): Element {
  const text = parts.filter(Boolean).join(' · ');
  return {type: 'element', tagName: 'span', properties: {className, role: 'img', ariaLabel: text}, children: [{type: 'text', value: text}]};
}

// In place, so anything that holds the node (the block map) holds the card.
function replaceWith(node: Element, next: Element) {
  node.tagName = next.tagName;
  node.properties = next.properties;
  node.children = next.children;
}

function details(className: string, summary: string, bodyClass: string, body: Array<ElementContent | RootContent>): Element {
  return {
    type: 'element',
    tagName: 'details',
    properties: {className: [className]},
    children: [
      {type: 'element', tagName: 'summary', properties: {}, children: [{type: 'text', value: summary}]},
      {type: 'element', tagName: 'div', properties: {className: [bodyClass]}, children: body.filter((child) => child.type !== 'doctype') as ElementContent[]},
    ],
  };
}

// Raw HTML a block can be that sits in the line rather than making a box
// of its own, such as a lone `<img>` or `<picture>`. A change bar is the
// marked element's ::before, which an image never draws and an inline
// element draws only a line high.
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'del', 'dfn', 'em', 'i', 'img', 'ins', 'kbd', 'mark', 'picture',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var',
]);

// Wraps such a block in a box of ours that keeps its place in the line and
// carries its id, source lines and mark, so the bar spans the whole block.
function markBox(placed: Placed): Placed {
  const {node, parent} = placed;
  const {dataBlock, dataLines, ...rest} = node.properties;
  node.properties = rest;
  const box: Element = {type: 'element', tagName: 'span', properties: {className: ['br-marked'], dataBlock, dataLines}, children: [node]};
  parent.children.splice(parent.children.indexOf(node), 1, box);
  return {node: box, parent};
}

function insertBefore(target: Placed, node: Element) {
  target.parent.children.splice(target.parent.children.indexOf(target.node), 0, node);
}

function insertAfter(target: Placed, node: Element) {
  target.parent.children.splice(target.parent.children.indexOf(target.node) + 1, 0, node);
}

// A modified block's `before` chip goes at the end of the block's own
// content: inside a list item ahead of any nested list, inside a table row's
// last cell, and right after any other block, so the markup stays valid.
function placeChip(placed: Placed, tag: string, chip: Element) {
  const {node} = placed;
  if (tag === 'li') {
    const nested = node.children.findIndex((child) => child.type === 'element' && (child.tagName === 'ul' || child.tagName === 'ol'));
    node.children.splice(nested < 0 ? node.children.length : nested, 0, chip);
  } else if (tag === 'tr') {
    const cells = node.children.filter((child): child is Element => child.type === 'element');
    cells.at(-1)?.children.push(chip);
  } else {
    insertAfter(placed, chip);
  }
}

/**
 * `own` is what belongs to the chosen blocks themselves, for telling whether
 * a block renders as it did: a row's view carries its table's header for
 * context, which isn't the row's.
 */
type BaseRender = {nodes: ElementContent[]; label: string; own: ElementContent[]};

const FOOTNOTE_LABEL = /^\s*\[\^([^\]]+)\]:/;

/**
 * Blocks of one side rendered on their own, without marks, for a `before`
 * view, a removed marker, or telling whether a block renders as it did, or
 * null when they render as nothing visible. Each renders from its whole
 * source on that side, found by the side's own positions, so the view is the
 * block as it was. A list item renders as the item's content, a table row
 * under its table's header, and a footnote with a reference to it, since a
 * definition alone renders nothing.
 */
async function renderBase(side: Side, indexes: number[], options: TreeOptions, tally: Tally): Promise<BaseRender | null> {
  const chosen = indexes.map((index) => side.blocks[index]!);
  const {lines} = side;
  const slice = (block: Candidate) => lines.slice(block.lines[0] - 1, block.lines[1]);
  const render = (source: string[], first: number, except?: Set<string>) => renderAlone(side, source.join('\n'), first, options, tally, except);
  const table = chosen[0]!.table;
  let nodes: ElementContent[];
  let own: ElementContent[] | undefined;
  let label: string;

  if (chosen.every((block) => block.footnote && block.tag === 'li')) {
    const labels = chosen.map((block) => FOOTNOTE_LABEL.exec(lines[block.lines[0] - 1] ?? '')?.[1] ?? '');
    const rendered = await render([labels.map((name) => `[^${name}]`).join(' '), '', ...chosen.flatMap(slice)], 0, new Set(labels));
    const items: Element[] = [];
    walk(rendered, (node) => {
      if (node.tagName !== 'li') return;
      items.push(node);
      return 'skip';
    });
    // The chosen footnotes come first, in the order the line above cites
    // them; any after them are footnotes their own text cites.
    nodes = items.slice(0, chosen.length).flatMap((item) => withoutBackrefs(item.children));
    label = plural(chosen.length, 'footnote');
  } else if (table && chosen.every((block) => block.tag === 'tr' && block.table?.line === table.line)) {
    // A table nested in a list item is indented by the item; each line comes
    // out by the table's own column, so the rows render as a table.
    const rows = chosen.filter((block) => block.lines[0] !== table.line);
    const source = [...lines.slice(table.line - 1, table.line + 1), ...rows.flatMap(slice)].map((line) => dedent(line, table.column - 1));
    const tree = await render(source, table.line);
    nodes = bodyElements(tree);
    const trs: Element[] = [];
    walk(tree, (child) => {
      if (child.tagName === 'tr') trs.push(child);
    });
    // The header row is there for context, unless it was chosen too.
    const withHeader = rows.length < chosen.length;
    own = withHeader ? trs : trs.slice(1);
    const wholeTable = withHeader && chosen.length === side.blocks.filter((block) => block.table?.line === table.line).length;
    label = wholeTable ? plural(1, 'table') : plural(rows.length || 1, 'table row');
  } else if (chosen.every((block) => block.tag === 'li')) {
    // Each item dedented by its own column, so a nested item renders as an
    // item rather than as code.
    const source = chosen.flatMap((block) => slice(block).map((line) => dedent(line, block.column - 1)));
    const lists = bodyElements(await render(source, chosen[0]!.lines[0]));
    const items = lists.flatMap((list) => list.children.filter((child): child is Element => child.type === 'element' && child.tagName === 'li'));
    nodes = items.length === 1 ? items[0]!.children : lists;
    label = plural(items.length, 'list item');
  } else {
    const first = Math.min(...chosen.map((block) => block.lines[0]));
    // A header row's source ends with the delimiter row under it.
    const last = Math.max(...chosen.map((block) => (block.table?.line === block.lines[0] ? block.lines[1] + 1 : block.lines[1])));
    nodes = bodyElements(await render(lines.slice(first - 1, last), first));
    label = describeBlocks(nodes as Element[]);
  }
  return visible(nodes) ? {nodes, label, own: own ?? nodes} : null;
}

// YAML frontmatter counts only at the very top of a file.
const FRONTMATTER_FENCE = /^---\s*$/;

/**
 * Source from one side rendered alone, with that side's link definitions
 * and footnote labels ahead of it, so its references render as they do on
 * the side's page and show the same footnote numbers. The footnotes section
 * those labels add is for the page, not the view. `first` is the side line
 * the source starts at: frontmatter there must stay first, and holds no
 * references. `except` names footnotes the source defines itself.
 */
async function renderAlone(side: Side, source: string, first: number, options: TreeOptions, tally: Tally, except = new Set<string>()): Promise<Root> {
  // Only what the source can refer to: every bracketed run in it, read as
  // a label, so the context grows with the block, never with the file.
  const named = bracketedLabels(source);
  const exceptKeys = new Set([...except].map(labelKey));
  const labels = [...named].flatMap((key) => {
    const label = key.startsWith('^') ? side.footnoteLabels.get(key.slice(1)) : undefined;
    return label !== undefined && !exceptKeys.has(key.slice(1)) ? [`[^${label}]: .`] : [];
  });
  const definitions = [...named].flatMap((key) => side.definitions.get(key) ?? []);
  // A footnote definition takes the indented lines after it, as a list item
  // does, so a comment, which renders as nothing, closes the labels.
  const context = [...labels, ...(labels.length > 0 ? ['<!-- -->'] : []), ...definitions];
  const frontmatter = first === 1 && FRONTMATTER_FENCE.test(side.lines[0] ?? '');
  const tree = (await renderTree(context.length > 0 && !frontmatter ? `${context.join('\n\n')}\n\n${source}` : source, options, tally)).tree;
  walk(tree, (node) => {
    // The page owns every id and name: a view of a block that has one would
    // repeat it, and a link to it could land in the view. Links keep their
    // targets.
    delete node.properties.id;
    delete node.properties.name;
    if (node.tagName !== 'a' || node.properties.dataFootnoteRef === undefined || typeof node.properties.href !== 'string') return;
    const number = side.footnoteNumbers.get(footnoteTarget(node.properties.href));
    if (number !== undefined) node.children = [{type: 'text', value: number}];
  });
  return tree;
}

// The labels a source may refer to: the text of each bracketed run, as in
// `[label]`, `[text][label]` and `[label][]`, normalized; a footnote's
// `[^label]` as `^` and its normalized label. A run that names no
// definition costs nothing. Runs are read without nesting, as labels are.
function bracketedLabels(source: string): Set<string> {
  const keys = new Set<string>();
  for (let open = source.indexOf('['); open >= 0; open = source.indexOf('[', open + 1)) {
    const close = source.indexOf(']', open + 1);
    if (close < 0) break;
    const inner = source.slice(open + 1, close);
    // A label holds no unescaped bracket and at most 999 characters.
    if (inner.includes('[') || inner.length > 999 || inner.trim() === '') continue;
    keys.add(inner.startsWith('^') ? `^${labelKey(inner.slice(1))}` : labelKey(inner));
  }
  return keys;
}

// Whether two renders show the same thing.
function sameRendering(left: BaseRender, right: BaseRender | null) {
  const html = (nodes: ElementContent[]) => unified().use(rehypeStringify).stringify({type: 'root', children: nodes});
  return right !== null && html(left.own) === html(right.own);
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// The top-level elements of a nested render, without the footnotes section.
function bodyElements(tree: Root): Element[] {
  return tree.children.filter((child): child is Element => child.type === 'element' && !(child.tagName === 'section' && child.properties.dataFootnotes !== undefined));
}

function dedent(line: string, columns: number) {
  const leading = /^ */.exec(line)![0].length;
  return line.slice(Math.min(leading, columns));
}

// A footnote's back link points at a reference this view doesn't have.
function withoutBackrefs(nodes: ElementContent[]): ElementContent[] {
  return nodes.flatMap((node): ElementContent[] => {
    if (node.type !== 'element') return [node];
    if (node.tagName === 'a' && node.properties.dataFootnoteBackref !== undefined) return [];
    return [{...node, children: withoutBackrefs(node.children)}];
  });
}

// Text, or an element that shows something without text, such as an image.
function visible(nodes: Array<ElementContent | RootContent>): boolean {
  return nodes.some((node) => {
    if (node.type === 'text') return node.value.trim() !== '';
    if (node.type !== 'element') return false;
    return ['img', 'hr', 'input'].includes(node.tagName) || visible(node.children);
  });
}

// The marker for content removed between blocks: a closed `<details>` with
// the removed blocks rendered inside. Inside a list it's an item and inside
// a table a full-width row, so the markup stays valid where it lands.
function removedMarker(removed: BaseRender, next: Candidate | undefined, afterLines: string[]): Element {
  const marker = details('br-removed', `− ${removed.label} removed · show`, 'br-removed-body', removed.nodes);
  if (next?.tag === 'li') return {type: 'element', tagName: 'li', properties: {className: ['br-removed-item']}, children: [marker]};
  if (next?.tag === 'tr') {
    const columns = Math.max(1, (afterLines[next.lines[0] - 1] ?? '').split('|').length - 2);
    return {type: 'element', tagName: 'tr', properties: {className: ['br-removed-row']}, children: [
      {type: 'element', tagName: 'td', properties: {colSpan: columns}, children: [marker]},
    ]};
  }
  return marker;
}

const KIND_NAMES: Array<[RegExp, string]> = [
  [/^p$/, 'paragraph'],
  [/^h[1-6]$/, 'heading'],
  [/^(pre|div\.highlight|div\.br-drawn)$/, 'code block'],
  [/^table$/, 'table'],
  [/^(blockquote|div\.markdown-alert)$/, 'quote'],
  [/^hr$/, 'rule'],
];

// What a run of removed blocks was, by the tags they render as.
function describeBlocks(top: Element[]) {
  if (top.length > 0 && top.every((node) => node.tagName === 'ul' || node.tagName === 'ol')) {
    return plural(top.reduce((sum, list) => sum + list.children.filter((child) => child.type === 'element').length, 0), 'list item');
  }
  const names = top.map((node) => {
    const className = node.properties.className;
    const key = Array.isArray(className) && className.length > 0 ? `${node.tagName}.${className[0]}` : node.tagName;
    return KIND_NAMES.find(([pattern]) => pattern.test(key))?.[1] ?? 'block';
  });
  const first = names[0] ?? 'block';
  return plural(Math.max(1, names.length), names.every((name) => name === first) ? first : 'block');
}

// YAML frontmatter as GitHub shows it: a table with the keys as headers and
// one row of values, nested tables for nested values. Built as hast with
// text nodes, so it passes the sanitizer like everything else.
function frontmatterTable(state: {patch(from: Yaml, to: Element): void}, node: Yaml): Element {
  let value: unknown;
  try {
    value = parseYaml(node.value);
  } catch {
    value = undefined;
  }
  // A value that refers to itself, or nests past what a page can show,
  // shows as its source, as a value that doesn't parse does.
  const table = value === undefined ? null : valueTable(value, new WeakSet(), 0);
  const result = table ?? element('pre', [element('code', [{type: 'text', value: node.value}])]);
  state.patch(node, result);
  return result;
}

function element(tagName: string, children: ElementContent[], properties: Element['properties'] = {}): Element {
  return {type: 'element', tagName, properties, children};
}

// Frontmatter tables nest at most this deep.
const MAX_FRONTMATTER_DEPTH = 32;

// The table for a value, or null for one that contains itself (`path`
// holds the objects above it) or nests past MAX_FRONTMATTER_DEPTH.
function valueTable(value: unknown, path: WeakSet<object>, depth: number): Element | null {
  if (depth >= MAX_FRONTMATTER_DEPTH) return null;
  const cells = (items: readonly unknown[]) => {
    const out: Element[] = [];
    for (const item of items) {
      const inner = cell(item, path, depth + 1);
      if (!inner) return null;
      out.push(element('td', [inner]));
    }
    return out;
  };
  if (value && typeof value === 'object') {
    if (path.has(value)) return null;
    path.add(value);
    try {
      if (Array.isArray(value)) {
        const row = cells(value);
        return row && element('table', [element('tbody', [element('tr', row)])]);
      }
      const entries = Object.entries(value as Record<string, unknown>);
      const row = cells(entries.map(([, item]) => item));
      return row && element('table', [
        element('thead', [element('tr', entries.map(([key]) => element('th', [{type: 'text', value: key}])))]),
        element('tbody', [element('tr', row)]),
      ]);
    } finally {
      path.delete(value);
    }
  }
  const row = cells([value]);
  return row && element('table', [element('tbody', [element('tr', row)])]);
}

function cell(value: unknown, path: WeakSet<object>, depth: number): Element | null {
  if (value && typeof value === 'object') return valueTable(value, path, depth);
  return element('div', [{type: 'text', value: value === null || value === undefined ? '' : String(value)}]);
}
