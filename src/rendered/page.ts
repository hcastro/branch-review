import {createHash} from 'node:crypto';
import path from 'node:path';
import type {FileStatus} from '../git.js';
import {PAGE_CSS, PAGE_CSS_HASH} from './assets.generated.js';
import type {ImageBody} from './image.js';
import type {DifferenceKind, RenderedFragment} from './markdown.js';
import type {Finding} from './report.js';

// A rendered markdown file as the pages draw it: its article, with the
// change marks, the links its render couldn't yet know were broken drawn
// broken, and the card for a file that has no article to show. The Review
// in browser page (review/page.ts) holds it in a card's rich view; the
// in-pane view's tile document, below, is the article alone. Every
// repo-supplied string printed here is escaped, and the fragment itself is
// already sanitized.

export type PageBody =
  | {kind: 'rendered'; fragment: RenderedFragment}
  // An image or SVG file's own page.
  | {kind: 'image'; image: ImageBody}
  | {kind: 'empty'}
  | {kind: 'tooLarge'; bytes: number; head: string}
  | {kind: 'notUtf8'}
  | {kind: 'failed'; reason: string; source: string}
  // A file the background render hasn't reached: opening it renders it.
  | {kind: 'pending'};

export type PageFile = {
  path: string;
  status: FileStatus;
  oldPath?: string;
  /** A page the review doesn't list, whose text is unchanged: the changed images it shows. */
  also?: {embeds: string[]};
  body: PageBody;
};

// The same escapes rehype-stringify writes, so our text and the fragment's
// read alike.
function escapeHtml(text: string) {
  return text.replace(/&/g, '&#x26;').replace(/</g, '&#x3C;').replace(/"/g, '&#x22;');
}

// The in-pane view's tile document: the article alone, laid out at the
// sheet's width in the terminal's own background, so a tile's letterbox and
// the pane around it are one surface. The pane draws the change marks as
// gutter text and has no pointer on the page, so the page draws no bars, nor
// the cover a nested list puts over its item's bar, and leaves out the before
// chip, and the room and cell width the chip keeps; a removed block's
// marker stays, folded, and names where to open it, so the gutter has a row
// to mark. The chip hides with an important rule because the page places it
// in list items and table cells with rules more specific than the tile's.
// Chromium loads it with scripts off, and it has none.
const TILE_CSS = [
  'html, body { min-height: 0; height: auto; background: var(--br-tile-bg); }',
  'html { width: var(--br-tile-width); scroll-padding-top: 0; }',
  ':root { --br-chip-room: 0px; --br-row-chip-room: 0px; }',
  ':root { --br-row-chip-cell: 0px; }',
  '.br-tile .markdown-body { max-width: none; margin: 0; padding: 16px 16px 24px; background: transparent; }',
  '.br-tile .markdown-body :is([data-mark], details.br-removed)::before, .br-tile .markdown-body tr[data-mark] > :first-child::before { content: none; }',
  '.br-tile details.br-before { display: none !important; }',
  '.br-tile .markdown-body li[data-mark] > :is(ul, ol)::before { content: none; }',
  '.br-tile details.br-removed > summary { list-style: none; cursor: default; }',
  '.br-tile .br-banners, .br-tile .br-body { padding: 16px 16px 0; }',
].join('\n');
const TILE_FALLBACK_BG = {dark: '#111318', light: '#ffffff'} as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const REMOVED_SUMMARY = /(<details class="br-removed"><summary>[^<]*) · show<\/summary>/g;

const cspHash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/** `brokenRefs`: as in the file's rich view, the links drawn broken. */
export type TileDocumentInput = {file: PageFile; scheme: 'dark' | 'light'; bg: string; cssWidth: number; base?: string; brokenRefs?: readonly number[]};

export function assembleTileDocument({file, scheme, bg, cssWidth, base = 'the base branch', brokenRefs = []}: TileDocumentInput): string {
  const background = HEX_COLOR.test(bg) ? bg.toLowerCase() : TILE_FALLBACK_BG[scheme];
  const tile = `:root { --br-tile-bg: ${background}; --br-tile-width: ${Number.isFinite(cssWidth) ? cssWidth : 980}px; }\n${TILE_CSS}`;
  const policy = [
    "default-src 'none'",
    'img-src data:',
    `style-src '${PAGE_CSS_HASH}' ${cspHash(tile)}`,
    "script-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
  ].join('; ');
  const content = file.body.kind === 'image' ? '' : body(file, brokenRefs).replace(REMOVED_SUMMARY, '$1 · r shows it in the split</summary>');
  return [
    '<!doctype html>',
    `<html lang="en" data-theme="${scheme}" class="br-tile">`,
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta charset="utf-8">',
    `<meta name="color-scheme" content="${scheme}">`,
    `<title>${escapeHtml(path.posix.basename(file.path))}</title>`,
    `<style>${PAGE_CSS}</style>`,
    `<style>${tile}</style>`,
    '</head>',
    '<body>',
    banners(file, base),
    content,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const DIFFERENCE_TEXT: Record<DifferenceKind, (count: number) => string> = {
  mermaid: (n) => `${n} Mermaid diagram${n === 1 ? '' : 's'} shown as code`,
  math: (n) => `${n} math expression${n === 1 ? '' : 's'} shown as source`,
  diagram: (n) => `${n} map or 3D model${n === 1 ? '' : 's'} shown as code`,
  remoteImage: (n) => `${n} remote image${n === 1 ? '' : 's'} not loaded: the page works offline`,
  outsideLink: (n) => `${n} link${n === 1 ? '' : 's'} to files outside this review, inert`,
  localImage: (n) => `${n} local image${n === 1 ? '' : 's'} not embedded`,
};

// The tile's lines above the article: what the file's status means.
function banners(file: PageFile, base: string) {
  const banner = (kind: string, text: string) => `<p class="br-banner br-banner-${kind}">${escapeHtml(text)}</p>`;
  const shown: string[] = [];
  if (file.status === 'added') shown.push(banner('added', 'new file'));
  if (file.status === 'untracked') shown.push(banner('untracked', 'untracked · not part of a push yet'));
  if (file.status === 'deleted') shown.push(banner('deleted', `deleted on this branch · shown from ${base}`));
  if (file.status === 'renamed' && file.oldPath) shown.push(banner('renamed', `renamed from ${file.oldPath}`));
  return shown.length > 0 ? `<div class="br-banners">${shown.join('')}</div>` : '';
}

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file's article, or the card for a file with none: the Review in browser page's rich view. */
export function articleHtml(file: PageFile, brokenRefs: readonly number[] = []) {
  return body(file, brokenRefs);
}

/** Where a page differs from github.com, a line for each kind. */
export function differenceNotes(differences: RenderedFragment['differences']) {
  return differences.map((difference) => DIFFERENCE_TEXT[difference.kind](difference.count));
}

function body(file: PageFile, brokenRefs: readonly number[]) {
  if (file.body.kind === 'image') return '';
  if (file.body.kind !== 'rendered') return `<div class="br-body">\n${cardBody(file.body)}\n</div>`;
  const {fragment} = file.body;
  return `<article class="markdown-body${file.status === 'deleted' ? ' br-dimmed' : ''}">\n${finishRefs(fragment, brokenRefs)}\n</article>`;
}

// The attributes of an opening tag as rehype-stringify writes them: each
// value in double quotes, which a value never holds unescaped.
const TAG_ATTRIBUTES = /(?: [^\s"'>/=]+(?:="[^"]*")?)*/y;
const ATTRIBUTE = / ([^\s"'>/=]+)(?:="([^"]*)")?/g;

// A link to another page's heading is known to point nowhere only now,
// once that page's anchors are: it is drawn broken where its render said
// its attributes start, from the last one back so each place still holds.
// Its class gains ours and its title says why, in place, so a class or
// title the repo gave the link never wins over them.
function finishRefs(fragment: RenderedFragment, brokenRefs: readonly number[]) {
  const offsets = fragment.refOffsets;
  if (!offsets || brokenRefs.length === 0) return fragment.html;
  const html = fragment.html;
  const places = [...new Set(brokenRefs)].flatMap((index) => (offsets[index] === undefined ? [] : [offsets[index]!])).sort((left, right) => left - right);
  // One pass forward: the text between places as it is, each place's
  // attributes written again, joined once.
  const parts: string[] = [];
  let from = 0;
  for (const at of places) {
    TAG_ATTRIBUTES.lastIndex = at;
    const written = TAG_ATTRIBUTES.exec(html)![0];
    const attributes = new Map([...written.matchAll(ATTRIBUTE)].map((match) => [match[1]!, match[2]] as const));
    attributes.set('class', [attributes.get('class'), 'br-broken'].filter(Boolean).join(' '));
    attributes.set('title', 'anchor not found');
    parts.push(html.slice(from, at), [...attributes].map(([name, value]) => (value === undefined ? ` ${name}` : ` ${name}="${value}"`)).join(''));
    from = at + written.length;
  }
  parts.push(html.slice(from));
  return parts.join('');
}

function cardBody(fileBody: Exclude<PageBody, {kind: 'rendered' | 'image'}>) {
  const state = (text: string, error = false) => `<p class="br-state${error ? ' br-state-error' : ''}">${escapeHtml(text)}</p>`;
  const raw = (text: string) => `<pre class="br-raw">${escapeHtml(text)}</pre>`;
  switch (fileBody.kind) {
    case 'empty':
      return state('this file is empty');
    case 'tooLarge':
      return `${state(`too large to show (${megabytes(fileBody.bytes)})`)}\n${raw(fileBody.head)}`;
    case 'notUtf8':
      return state('not UTF-8 text');
    case 'failed':
      return `${state(`couldn't show this file · ${fileBody.reason}`, true)}\n${raw(fileBody.source)}`;
    case 'pending':
      return state('not ready yet · press r in branch-review again in a moment');
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** `1 broken link · 2 images won't render`, or null with nothing to say. */
export function findingsLabel(findings: ReadonlyArray<Pick<Finding, 'what'>>) {
  const links = findings.filter((finding) => finding.what === 'link').length;
  const images = findings.length - links;
  const parts = [...(links > 0 ? [plural(links, 'broken link')] : []), ...(images > 0 ? [`${plural(images, 'image')} won't render`] : [])];
  return parts.length > 0 ? parts.join(' · ') : null;
}
