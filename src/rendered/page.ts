import {createHash} from 'node:crypto';
import path from 'node:path';
import type {FileStatus} from '../git.js';
import {HEAD_SCRIPT, HEAD_SCRIPT_HASH, PAGE_CSS, PAGE_CSS_HASH, PAGE_SCRIPT, PAGE_SCRIPT_HASH} from './assets.generated.js';
import {describeImage, imageFacts, type ImageBody, type ImageFacts, type ImageSide} from './image.js';
import {refusedCard, type DifferenceKind, type RenderedFragment} from './markdown.js';
import type {RawSource} from './raw.js';
import type {Finding} from './report.js';

// Whole HTML documents around rendered fragments. A page is one
// self-contained file: its only style is the inlined stylesheet and its
// only scripts our own two, each allowed by its hash: a tiny one in <head>
// that paints the trip's first frame (client/head.ts), and the page script
// (client/main.ts). The script plays the arrival and adds the page's keys; the page
// reads as its finished self with scripting off, and the controls that
// need the script stay hidden. Every repo-supplied string printed here is
// escaped, and the fragment itself is already sanitized.

/** One entry in the page's rail of rendered files. */
export type RailEntry = {
  path: string;
  status: FileStatus;
  /** That file's page, relative to this one. */
  href: string;
  /** The short count at the right: changed blocks, `+` for a new file, `−` for a deleted one, `img` for a changed image. */
  label: string;
  current: boolean;
  /** A page the review doesn't list, which also looks different. */
  also?: true;
};

/** The rail's count for a file not rendered yet: blank, never a count it might not have. */
export const RAIL_PENDING = '';

/**
 * A rail entry's count: `+` for a new file, `−` for a deleted one, else its
 * changed and removed blocks, `·` for none. `pending` is a file whose
 * render hasn't answered yet, which has no count to show.
 */
export function railLabel(status: FileStatus, changes: RenderedFragment['changes'] | null | 'pending') {
  if (status === 'added' || status === 'untracked') return '+';
  if (status === 'deleted') return '−';
  if (changes === 'pending') return RAIL_PENDING;
  const total = changes ? changes.changed + changes.removed : 0;
  return total > 0 ? String(total) : '·';
}

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

export type PageInput = {
  title: {repo: string; base: string; branch: string; worktree: boolean; renderedAt: number};
  file: PageFile;
  rail: RailEntry[];
  /** The page's links to a heading another page doesn't have, by their `ref` index (linkReport). */
  brokenRefs?: readonly number[];
  /** On an image's page: where the review's markdown shows it, each with its page, or null for none. */
  appears?: ReadonlyArray<{path: string; line: number; href: string | null}>;
  /**
   * The link and anchor report as this page shows it: its own findings, in
   * the strip, and the review's in a few words, in the rail.
   */
  report?: {own: readonly Finding[]; notes: readonly string[]};
};

/** The page's whole policy: nothing loads, and only our own style and script apply. */
export function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    'img-src data:',
    `style-src '${PAGE_CSS_HASH}'`,
    `script-src '${HEAD_SCRIPT_HASH}' '${PAGE_SCRIPT_HASH}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
  ].join('; ');
}

// The same escapes rehype-stringify writes, so our text and the fragment's
// read alike.
function escapeHtml(text: string) {
  return text.replace(/&/g, '&#x26;').replace(/</g, '&#x3C;').replace(/"/g, '&#x22;');
}

const STATUS_LETTERS: Record<FileStatus, string> = {modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U'};

function statusLetter(status: FileStatus) {
  return `<span class="br-status br-status-${status}">${STATUS_LETTERS[status]}</span>`;
}

// The document up to <body>: the policy first, then the schemes the page
// supports and the script that paints a trip's first frame, both read
// before anything paints, then our one stylesheet.
function documentHead(title: string) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">`,
    '<meta charset="utf-8">',
    '<meta name="color-scheme" content="dark light">',
    `<script>${HEAD_SCRIPT}</script>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)} · branch-review</title>`,
    `<style>${PAGE_CSS}</style>`,
    '</head>',
  ];
}

// The end of the document: the help the `?` key opens, then the script,
// once everything it reads is parsed.
function documentFoot(keys: ReadonlyArray<readonly [string, string]>) {
  return [
    '<div class="br-help" id="br-help" role="dialog" aria-label="Keys" hidden>',
    '<h2>Keys</h2>',
    '<dl>',
    ...keys.map(([key, what]) => `<div><dt>${key}</dt><dd>${what}</dd></div>`),
    '</dl>',
    '</div>',
    `<script>${PAGE_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ];
}

const FILE_KEYS = [
  ['<kbd>[</kbd> <kbd>]</kbd>', 'previous or next change'],
  ['<kbd>{</kbd> <kbd>}</kbd>', 'previous or next file'],
  ['<kbd>t</kbd>', 'theme: system, light, dark'],
  ['<kbd>m</kbd>', 'show or hide the change marks'],
  ['<kbd>?</kbd>', 'these keys'],
] as const;

const IMAGE_KEYS = [
  ['<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>', 'side by side, flip, difference'],
  ['<kbd>f</kbd>', 'flip to the other side'],
  ['<kbd>{</kbd> <kbd>}</kbd>', 'previous or next file'],
  ['<kbd>t</kbd>', 'theme: system, light, dark'],
  ['<kbd>?</kbd>', 'these keys'],
] as const;

// An image with one side, or a side that is a card, has nothing to compare.
const SINGLE_IMAGE_KEYS = IMAGE_KEYS.slice(2);

const OVERVIEW_KEYS = [
  ['<kbd>{</kbd> <kbd>}</kbd>', 'previous or next page'],
  ['<kbd>⏎</kbd>', 'open it'],
  ['<kbd>t</kbd>', 'theme: system, light, dark'],
  ['<kbd>?</kbd>', 'these keys'],
] as const;

export function assembleFilePage(input: PageInput): string {
  const {title, file, rail} = input;
  const image = file.body.kind === 'image';
  const compares = file.body.kind === 'image' && comparable(file.body.image);
  return [
    ...documentHead(path.posix.basename(file.path)),
    '<body>',
    strip(title, file.body.kind === 'rendered' ? file.body.fragment.differences : [], !image, ownFindings(input.report?.own ?? [])),
    '<div class="br-layout">',
    railNav(rail, title, input.report?.notes ?? [], !image ? FILE_RAIL_KEYS : compares ? IMAGE_RAIL_KEYS : SINGLE_IMAGE_RAIL_KEYS),
    '<main class="br-main">',
    switcher(rail, file, input.report?.notes ?? []),
    fileHead(file),
    banners(file, title),
    file.body.kind === 'image' ? imageSection(file.body.image, file, title, input.appears ?? []) : body(file, input.brokenRefs ?? []),
    '</main>',
    '</div>',
    ...documentFoot(!image ? FILE_KEYS : compares ? IMAGE_KEYS : SINGLE_IMAGE_KEYS),
  ].join('\n');
}

// The in-pane view's tile document: the article alone, laid out at the
// sheet's width in the terminal's own background, so a tile's letterbox and
// the pane around it are one surface. The pane draws the change marks as
// gutter text and has no pointer on the page, so the page draws no bars, nor
// the cover a nested list puts over its item's bar, and leaves out the before
// chip, and the room the chip keeps; a removed block's
// marker stays, folded, and names where to open it, so the gutter has a row
// to mark. The chip hides with an important rule because the page places it
// in list items and table cells with rules more specific than the tile's.
// Chromium loads it with scripts off, and it has none.
const TILE_CSS = [
  'html, body { min-height: 0; height: auto; background: var(--br-tile-bg); }',
  'html { width: var(--br-tile-width); scroll-padding-top: 0; }',
  ':root { --br-chip-room: 0px; --br-row-chip-room: 0px; }',
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

/** `brokenRefs`: as on the file's page, the links drawn broken. */
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
    banners(file, {repo: '', base, branch: '', worktree: false, renderedAt: 0}),
    // The raw source rides only in a file page, for its first frame.
    content.replace(/<template class="br-raw-source">[\s\S]*?<\/template>/, ''),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// The strip's controls are buttons for the page script's keys, hidden
// until it runs. `marks`: the page has change marks to show or hide.
function strip(title: PageInput['title'], differences: RenderedFragment['differences'], marks: boolean, findings: string | null = null) {
  return [
    '<header class="br-strip">',
    '<span class="br-brand"><span class="br-brand-mark" aria-hidden="true">▍</span><span class="br-brand-word">branch-review</span></span>',
    `<span class="br-refs" title="${escapeHtml(title.repo)}"><span class="br-base">${escapeHtml(title.base)}</span><span class="br-arrow">←</span><span class="br-branch">${escapeHtml(title.branch)}</span></span>`,
    '<div class="br-strip-end">',
    fidelity(differences),
    ...(findings ? [findings] : []),
    '<button type="button" class="br-control br-theme br-js" title="Theme (t)" hidden><span class="br-theme-mark" aria-hidden="true">◐</span><span class="br-control-word br-theme-name">Auto</span></button>',
    ...(marks ? ['<button type="button" class="br-control br-marks br-js" title="Change marks (m)" aria-pressed="true" hidden><span class="br-marks-bar" aria-hidden="true">▍</span><span class="br-control-word">Changes</span></button>'] : []),
    '<button type="button" class="br-control br-help-button br-js" title="Keys (?)" aria-label="Keys" aria-controls="br-help" aria-expanded="false" hidden>?</button>',
    '</div>',
    '</header>',
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

// `≈ GitHub`, or `≈ GitHub · 2 differences`, opening a list of where this
// page differs from github.com. The last note holds for every page.
function fidelity(differences: RenderedFragment['differences']) {
  const total = differences.reduce((sum, difference) => sum + difference.count, 0);
  const label = total === 0 ? '≈ GitHub' : `≈ GitHub · ${total} difference${total === 1 ? '' : 's'}`;
  const items = differences.map((difference) => `<li>${DIFFERENCE_TEXT[difference.kind](difference.count)}</li>`);
  return [
    '<details class="br-fidelity">',
    `<summary>${label}</summary>`,
    '<div class="br-popover">',
    '<h2>Rendered here, offline</h2>',
    '<p>With GitHub\'s parser rules, sanitizer and stylesheet. Nothing on this page left this machine.</p>',
    items.length > 0 ? `<ul>\n${items.join('\n')}\n</ul>` : '<p>No known differences on this page.</p>',
    '<p class="br-always">Code colors come from GitHub\'s grammars and can drift between versions.</p>',
    '</div>',
    '</details>',
  ].join('\n');
}

// The rendered files grouped by folder, the current one marked.
function railLists(rail: RailEntry[]) {
  const groups = new Map<string, RailEntry[]>();
  for (const entry of rail) {
    const dir = path.posix.dirname(entry.path);
    const key = dir === '.' ? '(root)' : `${dir}/`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups].map(([dir, entries]) => [
    `<span class="br-rail-dir">${escapeHtml(dir)}</span>`,
    '<ul>',
    ...entries.map((entry) => {
      const current = entry.current ? ' br-current' : '';
      const ariaCurrent = entry.current ? ' aria-current="page"' : '';
      return [
        `<li><a class="br-rail-file${current}" href="${escapeHtml(entry.href)}"${ariaCurrent}>`,
        entry.also ? '<span class="br-status br-status-also">·</span>' : statusLetter(entry.status),
        `<span class="br-rail-name">${escapeHtml(path.posix.basename(entry.path))}</span>`,
        entry.label === RAIL_PENDING ? '<span class="br-rail-count" title="not rendered yet"></span>' : `<span class="br-rail-count">${escapeHtml(entry.label)}</span>`,
        '</a></li>',
      ].join('');
    }),
    '</ul>',
  ].join('\n'));
}

function railFoot(title: PageInput['title']) {
  const renderedAt = new Date(title.renderedAt);
  return `<p class="br-rail-foot">Rendered offline <time datetime="${renderedAt.toISOString()}">${renderedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</time>. Nothing left this machine.</p>`;
}

// The page's keys, as the rail's foot names them once the script runs.
function railKeys(keys: ReadonlyArray<readonly [string, string]>) {
  return `<dl class="br-rail-keys br-js" hidden>${keys.map(([key, what]) => `<div><dt>${key}</dt><dd>${what}</dd></div>`).join('')}</dl>`;
}

// What this page has that won't resolve on GitHub, in the strip. The page
// script makes it step from one to the next.
function ownFindings(own: readonly Finding[]) {
  const label = findingsLabel(own);
  return label ? `<span class="br-findings" title="Won't resolve on GitHub" ${findingsShort(own)}>${label}</span>` : null;
}

// The findings chip's short form, which a narrow screen shows in place of
// its words: a sign and the count, never half a word.
function findingsShort(findings: readonly unknown[]) {
  return `data-short="✗ ${findings.length}"`;
}

const FILE_RAIL_KEYS = [['<kbd>[</kbd> <kbd>]</kbd>', 'change'], ['<kbd>{</kbd> <kbd>}</kbd>', 'file'], ['<kbd>t</kbd>', 'theme'], ['<kbd>m</kbd>', 'marks']] as const;
const IMAGE_RAIL_KEYS = [['<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>', 'compare'], ['<kbd>{</kbd> <kbd>}</kbd>', 'file'], ['<kbd>t</kbd>', 'theme'], ['<kbd>f</kbd>', 'flip']] as const;
const SINGLE_IMAGE_RAIL_KEYS = [['<kbd>{</kbd> <kbd>}</kbd>', 'file'], ['<kbd>t</kbd>', 'theme']] as const;

// What the rail lists, in the side rail and the narrow screen's switcher
// alike: the review's files, those that also look different under a title
// of their own, and what won't render on GitHub across the review, in a
// few words.
function railSections(rail: RailEntry[], notes: readonly string[]) {
  const also = rail.filter((entry) => entry.also);
  return [
    ...railLists(rail.filter((entry) => !entry.also)),
    ...(also.length > 0 ? ['<p class="br-rail-title">ALSO LOOKS DIFFERENT</p>', ...railLists(also)] : []),
    ...(notes.length > 0 ? [`<ul class="br-rail-findings">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`] : []),
  ];
}

function railNav(rail: RailEntry[], title: PageInput['title'], notes: readonly string[], keys: ReadonlyArray<readonly [string, string]>) {
  return [
    '<nav class="br-rail" aria-label="Rendered files">',
    '<div class="br-rail-panel">',
    `<p class="br-rail-title">CHANGED · ${rail.filter((entry) => !entry.also).length} rendered</p>`,
    ...railSections(rail, notes),
    railKeys(keys),
    railFoot(title),
    '</div>',
    '</nav>',
  ].join('\n');
}

// The rail folded into one line over the head, which the stylesheet shows
// in its place on a narrow screen. The position counts the review's files,
// as the rail's title does; a page outside the review says so instead.
function switcher(rail: RailEntry[], file: PageFile, notes: readonly string[]) {
  const review = rail.filter((entry) => !entry.also);
  const index = review.findIndex((entry) => entry.current);
  const position = rail.some((entry) => entry.current && entry.also) ? 'also looks different' : index < 0 ? `${review.length} rendered` : `${index + 1} of ${review.length}`;
  return [
    '<details class="br-switcher">',
    `<summary><span class="br-switcher-name">${escapeHtml(path.posix.basename(file.path))}</span><span class="br-switcher-count">${position}</span></summary>`,
    '<nav class="br-switcher-list" aria-label="Rendered files">',
    ...railSections(rail, notes),
    '</nav>',
    '</details>',
  ].join('\n');
}

function fileHead(file: PageFile) {
  const dir = path.posix.dirname(file.path);
  const name = path.posix.basename(file.path);
  const crumbs = dir === '.'
    ? escapeHtml(name)
    : `<span class="br-dir">${escapeHtml(dir.split('/').join(' / '))}</span><span class="br-sep"> / </span>${escapeHtml(name)}`;
  // A page outside the review has no status of its own: its dot leads the note.
  const parts = file.also ? ['<span class="br-status br-status-also">·</span> text unchanged', escapeHtml(`embeds ${file.also.embeds.join(', ')}`)] : [statusLetter(file.status)];
  let total = 0;
  if (file.body.kind === 'rendered') {
    const {changed, removed} = file.body.fragment.changes;
    // On a page whose text is unchanged, the marks are the images it shows,
    // which the note names already.
    if (changed > 0 && !file.also) parts.push(`${changed} changed`);
    if (removed > 0 && !file.also) parts.push(`${removed} removed`);
    total = changed + removed;
  } else if (file.body.kind === 'image') {
    const facts = describeImage(imageFacts(file.body.image));
    if (facts) parts.push(escapeHtml(facts));
  } else {
    parts.push(BODY_STATE[file.body.kind]);
  }
  return [
    '<div class="br-filehead">',
    `<h1 class="br-path">${crumbs}</h1>`,
    `<p class="br-summary">${parts.join(' · ')}</p>`,
    // Where the reader is among the changes, and a step to either side.
    ...(total > 0 ? [[
      '<nav class="br-changes br-js" aria-label="Changes" hidden>',
      `<span class="br-changes-at" aria-live="polite">change 1 of ${total}</span>`,
      '<button type="button" class="br-step" data-step="-1" title="Previous change ([)" aria-label="Previous change">↑</button>',
      '<button type="button" class="br-step" data-step="1" title="Next change (])" aria-label="Next change">↓</button>',
      '</nav>',
    ].join('')] : []),
    '</div>',
  ].join('\n');
}

function banners(file: PageFile, title: PageInput['title']) {
  const banner = (kind: string, text: string) => `<p class="br-banner br-banner-${kind}">${escapeHtml(text)}</p>`;
  const shown: string[] = [];
  if (file.status === 'added') shown.push(banner('added', 'new file'));
  if (file.status === 'untracked') shown.push(banner('untracked', 'untracked · not part of a push yet'));
  if (file.status === 'deleted') shown.push(banner('deleted', `deleted on this branch · shown from ${title.base}`));
  if (file.status === 'renamed' && file.oldPath) shown.push(banner('renamed', `renamed from ${file.oldPath}`));
  return shown.length > 0 ? `<div class="br-banners">${shown.join('')}</div>` : '';
}

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// What the head says of a file with no rendered page.
const BODY_STATE: Record<Exclude<PageBody['kind'], 'rendered' | 'image'>, string> = {
  empty: 'empty',
  tooLarge: 'too large to render',
  notUtf8: 'not UTF-8 text',
  failed: "couldn't render",
  pending: 'not rendered yet',
};

function body(file: PageFile, brokenRefs: readonly number[]) {
  if (file.body.kind === 'image') return '';
  if (file.body.kind !== 'rendered') return `<div class="br-body">\n${cardBody(file.body)}\n</div>`;
  const {fragment} = file.body;
  return [
    `<article class="markdown-body${file.status === 'deleted' ? ' br-dimmed' : ''}">\n${finishRefs(fragment, brokenRefs)}\n</article>`,
    ...(fragment.raw ? [rawTemplate(fragment.raw)] : []),
  ].join('\n');
}

// The attributes of an opening tag as rehype-stringify writes them: each
// value in double quotes, which a value never holds unescaped.
const TAG_ATTRIBUTES = /^(?: [^\s"'>/=]+(?:="[^"]*")?)*/;
const ATTRIBUTE = / ([^\s"'>/=]+)(?:="([^"]*)")?/g;

// A link to another page's heading is known to point nowhere only now,
// once that page's anchors are: it is drawn broken where its render said
// its attributes start, from the last one back so each place still holds.
// Its class gains ours and its title says why, in place, so a class or
// title the repo gave the link never wins over them.
function finishRefs(fragment: RenderedFragment, brokenRefs: readonly number[]) {
  const offsets = fragment.refOffsets;
  if (!offsets || brokenRefs.length === 0) return fragment.html;
  let html = fragment.html;
  const places = [...new Set(brokenRefs)].flatMap((index) => (offsets[index] === undefined ? [] : [offsets[index]!])).sort((left, right) => right - left);
  for (const at of places) {
    const written = TAG_ATTRIBUTES.exec(html.slice(at))![0];
    const attributes = new Map([...written.matchAll(ATTRIBUTE)].map((match) => [match[1]!, match[2]] as const));
    attributes.set('class', [attributes.get('class'), 'br-broken'].filter(Boolean).join(' '));
    attributes.set('title', 'anchor not found');
    const rewritten = [...attributes].map(([name, value]) => (value === undefined ? ` ${name}` : ` ${name}="${value}"`)).join('');
    html = `${html.slice(0, at)}${rewritten}${html.slice(at + written.length)}`;
  }
  return html;
}

// The source as the diff showed it, for the page script's first frame:
// inert in a template, never laid out, read as text. The parser drops a
// newline right after <pre>, so one goes there to keep a blank first line.
function rawTemplate(raw: RawSource) {
  return `<template class="br-raw-source"><pre data-tints="${raw.tints}">\n${escapeHtml(raw.text)}</pre></template>`;
}

// One side of an image, as a figure: the picture in its frame, or the card
// in its place. `caption` names the side.
function figure(side: ImageSide, which: 'before' | 'after', caption: string, ref: string, name: string) {
  const frame = side.kind === 'shown'
    ? `<div class="br-frame"><img alt="${which}: ${escapeHtml(name)}" src="${side.dataUrl}"${side.width && side.height ? ` width="${side.width}" height="${side.height}"` : ''}></div>`
    : `<div class="br-frame br-frame-card">${imageCard(side)}</div>`;
  return `<figure class="br-figure br-${which}"><figcaption>${caption} · <span class="br-ref">${escapeHtml(ref)}</span></figcaption>${frame}</figure>`;
}

// The card for a side the page leaves out. One too large to inline can
// still be opened from the review.
function imageCard(side: Extract<ImageSide, {kind: 'card'}>) {
  const {text, soft} = refusedCard(side.reason, side.hint);
  const more = side.reason === 'tooLarge' || side.reason === 'pageLimit' ? ' · o opens it in branch-review' : '';
  return `<span class="br-card ${soft ? 'br-soft' : 'br-refused'}">${escapeHtml(text + more)}</span>`;
}

// The compare modes, as the TUI keys them, and the frame's two switches.
// Only with a picture on each side, and only once the page script runs.
const MODES = [
  '<div class="br-modes br-js" role="toolbar" aria-label="Compare" hidden>',
  '<button type="button" class="br-mode" data-mode="side" aria-pressed="true"><kbd>1</kbd> side by side</button>',
  '<button type="button" class="br-mode" data-mode="flip" aria-pressed="false"><kbd>2</kbd> flip</button>',
  '<button type="button" class="br-mode" data-mode="difference" aria-pressed="false"><kbd>3</kbd> difference</button>',
  '<span class="br-modes-end">',
  '<button type="button" class="br-switch br-board" aria-pressed="true" title="A checkerboard under the picture, where it is transparent"><span aria-hidden="true">◐</span> checkerboard</button>',
  '<button type="button" class="br-switch br-fit" aria-pressed="true" title="Fit the picture to the page, or show it at its own size">fit</button>',
  '</span>',
  '</div>',
].join('');

// Whether the page can compare the two sides: a picture on each.
const comparable = (image: ImageBody) => image.before?.kind === 'shown' && image.after?.kind === 'shown';

/**
 * An image's page body. A modified image shows both sides; flip and
 * difference stack them, which the page script switches to. A new image
 * shows its new side and a deleted one its base side, dimmed. Below, where
 * the review's markdown shows it, each line opening its page there.
 */
function imageSection(image: ImageBody, file: PageFile, title: PageInput['title'], appears: NonNullable<PageInput['appears']>) {
  const name = path.posix.basename(file.path);
  const both = image.before !== null && image.after !== null;
  const figures = [
    ...(image.before ? [figure(image.before, 'before', image.after ? 'before' : 'deleted', title.base, name)] : []),
    ...(image.after ? [figure(image.after, 'after', image.before ? 'after' : file.status === 'untracked' ? 'untracked' : 'added', title.branch, name)] : []),
  ];
  const compare = comparable(image);
  const kinds = ['br-image-page', ...(both ? [] : ['br-single']), ...(file.status === 'deleted' ? ['br-deleted'] : [])];
  const places = appears.map((place) => {
    const label = escapeHtml(`${place.path}:${place.line}`);
    return place.href ? `<a href="${escapeHtml(place.href)}#at=L${place.line}&#x26;d=short">${label}</a>` : `<span>${label}</span>`;
  });
  return [
    `<section class="${kinds.join(' ')}" data-mode="side">`,
    ...(compare ? [MODES] : []),
    `<div class="br-compare">\n${figures.join('\n')}\n</div>`,
    ...(compare ? [`<p class="br-difference-note">difference · <span class="br-ref">${escapeHtml(title.base)}</span> against <span class="br-ref">${escapeHtml(title.branch)}</span> · light where they differ</p>`] : []),
    ...(places.length > 0 ? [`<p class="br-appears">appears in ${places.join(' · ')}</p>`] : []),
    '</section>',
  ].join('\n');
}

function cardBody(fileBody: Exclude<PageBody, {kind: 'rendered' | 'image'}>) {
  const state = (text: string, error = false) => `<p class="br-state${error ? ' br-state-error' : ''}">${escapeHtml(text)}</p>`;
  const raw = (text: string) => `<pre class="br-raw">${escapeHtml(text)}</pre>`;
  switch (fileBody.kind) {
    case 'empty':
      return state('this file is empty');
    case 'tooLarge':
      return `${state(`too large to render (${megabytes(fileBody.bytes)})`)}\n${raw(fileBody.head)}`;
    case 'notUtf8':
      return state('not UTF-8 text');
    case 'failed':
      return `${state(`couldn't render this file · ${fileBody.reason}`, true)}\n${raw(fileBody.source)}`;
    case 'pending':
      return state('not rendered yet · opening this file in branch-review renders it');
  }
}

/** One file on the overview. `href` is its page, or null while it has none. */
export type OverviewEntry = {
  path: string;
  status: FileStatus;
  oldPath?: string;
  href: string | null;
  state: PageBody['kind'];
  /** What its page marks, once it is rendered. */
  changes: RenderedFragment['changes'] | null;
  /** Why it failed to render, when it did. */
  reason?: string;
  /** An image's sides, once its page is read. */
  image?: ImageFacts;
  /** For a page whose text didn't change: the changed images it shows. */
  embeds?: readonly string[];
};

export type OverviewInput = {
  title: PageInput['title'];
  /** In the review's order. */
  entries: OverviewEntry[];
  /** What the pages do differently from github.com, summed. */
  differences: RenderedFragment['differences'];
  /** Pages the review doesn't list whose text is the same but which show an image it changed. */
  also?: OverviewEntry[];
  /** What won't render on GitHub, each with the page it is on, or null. */
  findings?: ReadonlyArray<Finding & {href: string | null}>;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What an overview row says of its file: how it got there, then what its
// page shows. A deleted file's page is its base side, so that is all its
// row says, unless the page is a card.
function overviewNote(entry: OverviewEntry, base: string) {
  if (entry.status === 'deleted' && (entry.state === 'rendered' || entry.state === 'image')) return `shown dimmed from ${base}`;
  if (entry.embeds) return ['text unchanged', `embeds ${entry.embeds.join(', ')}`].join(' · ');
  const notes: string[] = [];
  if (entry.status === 'added') notes.push('new file');
  if (entry.status === 'renamed' && entry.oldPath) notes.push(`renamed from ${entry.oldPath}`);
  if (entry.status === 'untracked') notes.push(entry.state === 'rendered' ? 'untracked · not part of a push yet' : 'untracked');
  if (entry.state === 'image') {
    // A new image is `added`, with its one side.
    if (entry.status === 'added') notes.splice(notes.indexOf('new file'), 1, 'added');
    const facts = entry.image ? describeImage(entry.image) : '';
    if (facts) notes.push(facts);
  } else if (entry.state !== 'rendered') {
    // A failed render, or a page that couldn't be written, says why.
    const why = (entry.state === 'failed' || entry.state === 'pending') && entry.reason ? ` · ${entry.reason}` : '';
    notes.push(`${BODY_STATE[entry.state]}${why}`);
  } else {
    const {changed, removed} = entry.changes ?? {changed: 0, removed: 0};
    if (changed > 0) notes.push(`${changed} changed`);
    if (removed > 0) notes.push(`${removed} removed`);
    if (notes.length === 0) notes.push('no blocks marked');
  }
  return notes.join(' · ');
}

function overviewRow(entry: OverviewEntry, base: string) {
  const parts = [
    '<span class="br-row-bar" aria-hidden="true"></span>',
    entry.embeds ? '<span class="br-status br-status-also">·</span>' : statusLetter(entry.status),
    `<span class="br-row-path">${escapeHtml(entry.path)}</span>`,
    `<span class="br-row-note">${escapeHtml(overviewNote(entry, base))}</span>`,
  ].join('');
  const kind = `br-row br-row-${entry.embeds ? 'also' : entry.status}`;
  return entry.href === null
    ? `<li><div class="${kind} br-row-none">${parts}</div></li>`
    : `<li><a class="${kind}" href="${escapeHtml(entry.href)}">${parts}<span class="br-row-open">open ›</span></a></li>`;
}

function overviewGroup(heading: string, entries: OverviewEntry[], base: string) {
  return group(heading, entries.map((entry) => overviewRow(entry, base)));
}

function group(heading: string, rows: string[], id?: string) {
  if (rows.length === 0) return '';
  return [
    `<section class="br-group"${id ? ` id="${id}"` : ''}>`,
    `<h2 class="br-group-title">${heading}</h2>`,
    '<ul class="br-rows">',
    ...rows,
    '</ul>',
    '</section>',
  ].join('\n');
}

// A finding's row: where it is, what the page wrote, and why GitHub won't
// resolve it, opening its page at that line.
function findingRow(finding: Finding & {href: string | null}) {
  const parts = [
    '<span class="br-row-bar" aria-hidden="true"></span>',
    '<span class="br-status br-status-finding">✗</span>',
    `<span class="br-row-path">${escapeHtml(`${finding.path}:${finding.line}`)}</span>`,
    `<span class="br-row-note">${escapeHtml(`${finding.target} · ${finding.reason}`)}</span>`,
  ].join('');
  return finding.href === null
    ? `<li><div class="br-row br-row-finding br-row-none">${parts}</div></li>`
    : `<li><a class="br-row br-row-finding" href="${escapeHtml(finding.href)}#at=L${finding.line}&#x26;d=short">${parts}</a></li>`;
}

/** `1 broken link · 2 images won't render`, or null with nothing to say. */
export function findingsLabel(findings: ReadonlyArray<Pick<Finding, 'what'>>) {
  const links = findings.filter((finding) => finding.what === 'link').length;
  const images = findings.length - links;
  const parts = [...(links > 0 ? [plural(links, 'broken link')] : []), ...(images > 0 ? [`${plural(images, 'image')} won't render`] : [])];
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The overview: every rendered file of the review, deleted ones apart, each
 * row opening its page, and what the pages do differently from github.com.
 */
export function assembleOverview({title, entries, differences, also = [], findings = []}: OverviewInput): string {
  const pages = entries.filter((entry) => entry.status !== 'deleted');
  const deleted = entries.filter((entry) => entry.status === 'deleted');
  // Each count matches its group's rows.
  const counts = [
    plural(pages.length, 'page'),
    ...(also.length > 0 ? [`${also.length} also looks different`] : []),
    ...(deleted.length > 0 ? [`${deleted.length} deleted`] : []),
    ...(findings.length > 0 ? [plural(findings.length, 'finding')] : []),
  ];
  const chip = findingsLabel(findings);
  const total = differences.reduce((sum, difference) => sum + difference.count, 0);
  const foot = total === 0 ? '' : ` · ${plural(total, 'difference')}: ${differences.map((difference) => DIFFERENCE_TEXT[difference.kind](difference.count)).join(', ')}`;
  return [
    ...documentHead('Overview'),
    '<body>',
    strip(title, differences, false, chip ? `<a class="br-findings" href="#br-findings" ${findingsShort(findings)}>${chip}</a>` : null),
    '<div class="br-layout">',
    '<nav class="br-rail" aria-label="Overview">',
    '<div class="br-rail-panel">',
    '<p class="br-rail-title">OVERVIEW</p>',
    '<ul class="br-rail-stats">',
    ...counts.map((count) => `<li>${count}</li>`),
    '</ul>',
    railKeys([['<kbd>{</kbd> <kbd>}</kbd>', 'page'], ['<kbd>⏎</kbd>', 'open'], ['<kbd>t</kbd>', 'theme']]),
    railFoot(title),
    '</div>',
    '</nav>',
    '<main class="br-main br-overview">',
    '<div class="br-filehead">',
    `<h1 class="br-path">Rendered view of <span class="br-branch">${escapeHtml(title.branch)}</span></h1>`,
    `<p class="br-summary">${counts.join(' · ')}</p>`,
    '</div>',
    '<div class="br-groups">',
    overviewGroup('Pages', pages, title.base),
    overviewGroup('Also looks different', also, title.base),
    overviewGroup('Deleted', deleted, title.base),
    group("Won't render on GitHub", findings.map(findingRow), 'br-findings'),
    `<p class="br-overview-foot">≈ GitHub · rendered offline with GitHub's stylesheet${escapeHtml(foot)}</p>`,
    '</div>',
    '</main>',
    '</div>',
    ...documentFoot(OVERVIEW_KEYS),
  ].filter((line) => line !== '').join('\n');
}
