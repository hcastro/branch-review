import path from 'node:path';
import type {FileStatus} from '../git.js';
import {PAGE_CSS, PAGE_CSS_HASH, PAGE_SCRIPT, PAGE_SCRIPT_HASH} from './assets.generated.js';
import type {DifferenceKind, RenderedFragment} from './markdown.js';
import type {RawSource} from './raw.js';

// Whole HTML documents around rendered fragments. A page is one
// self-contained file: its only style is the inlined stylesheet and its
// only script the inlined page script (client/main.ts), each allowed by its
// hash. The script plays the arrival and adds the page's keys; the page
// reads as its finished self with scripting off, and the controls that
// need the script stay hidden. Every repo-supplied string printed here is
// escaped, and the fragment itself is already sanitized.

/** One entry in the page's rail of rendered files. */
export type RailEntry = {
  path: string;
  status: FileStatus;
  /** That file's page, relative to this one. */
  href: string;
  /** The short count at the right: changed blocks, `+` for a new file, `−` for a deleted one. */
  label: string;
  current: boolean;
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
  | {kind: 'empty'}
  | {kind: 'tooLarge'; bytes: number; head: string}
  | {kind: 'notUtf8'}
  | {kind: 'failed'; reason: string; source: string}
  // A file the background render hasn't reached: opening it renders it.
  | {kind: 'pending'};

export type PageFile = {path: string; status: FileStatus; oldPath?: string; body: PageBody};

export type PageInput = {
  title: {repo: string; base: string; branch: string; worktree: boolean; renderedAt: number};
  file: PageFile;
  rail: RailEntry[];
};

/** The page's whole policy: nothing loads, and only our own style and script apply. */
export function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    'img-src data:',
    `style-src '${PAGE_CSS_HASH}'`,
    `script-src '${PAGE_SCRIPT_HASH}'`,
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

// The document up to <body>: the policy first, then our one stylesheet.
function documentHead(title: string) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">`,
    '<meta charset="utf-8">',
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

const OVERVIEW_KEYS = [
  ['<kbd>{</kbd> <kbd>}</kbd>', 'previous or next page'],
  ['<kbd>⏎</kbd>', 'open it'],
  ['<kbd>t</kbd>', 'theme: system, light, dark'],
  ['<kbd>?</kbd>', 'these keys'],
] as const;

export function assembleFilePage(input: PageInput): string {
  const {title, file, rail} = input;
  return [
    ...documentHead(path.posix.basename(file.path)),
    '<body>',
    strip(title, file.body.kind === 'rendered' ? file.body.fragment.differences : [], true),
    '<div class="br-layout">',
    railNav(rail, title),
    '<main class="br-main">',
    switcher(rail, file),
    fileHead(file),
    banners(file, title),
    body(file),
    '</main>',
    '</div>',
    ...documentFoot(FILE_KEYS),
  ].join('\n');
}

// The strip's controls are buttons for the page script's keys, hidden
// until it runs. `marks`: the page has change marks to show or hide.
function strip(title: PageInput['title'], differences: RenderedFragment['differences'], marks: boolean) {
  return [
    '<header class="br-strip">',
    '<span class="br-brand"><span class="br-brand-mark" aria-hidden="true">▍</span><span class="br-brand-word">branch-review</span></span>',
    `<span class="br-refs" title="${escapeHtml(title.repo)}"><span class="br-base">${escapeHtml(title.base)}</span><span class="br-arrow">←</span><span class="br-branch">${escapeHtml(title.branch)}</span></span>`,
    '<div class="br-strip-end">',
    fidelity(differences),
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
        statusLetter(entry.status),
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

function railNav(rail: RailEntry[], title: PageInput['title']) {
  return [
    '<nav class="br-rail" aria-label="Rendered files">',
    '<div class="br-rail-panel">',
    `<p class="br-rail-title">CHANGED · ${rail.length} rendered</p>`,
    ...railLists(rail),
    railKeys([['<kbd>[</kbd> <kbd>]</kbd>', 'change'], ['<kbd>{</kbd> <kbd>}</kbd>', 'file'], ['<kbd>t</kbd>', 'theme'], ['<kbd>m</kbd>', 'marks']]),
    railFoot(title),
    '</div>',
    '</nav>',
  ].join('\n');
}

// The rail folded into one line over the head, which the stylesheet shows
// in its place on a narrow screen.
function switcher(rail: RailEntry[], file: PageFile) {
  const index = rail.findIndex((entry) => entry.current);
  const position = index < 0 ? `${rail.length} rendered` : `${index + 1} of ${rail.length}`;
  return [
    '<details class="br-switcher">',
    `<summary><span class="br-switcher-name">${escapeHtml(path.posix.basename(file.path))}</span><span class="br-switcher-count">${position}</span></summary>`,
    '<nav class="br-switcher-list" aria-label="Rendered files">',
    ...railLists(rail),
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
  const parts = [statusLetter(file.status)];
  let total = 0;
  if (file.body.kind === 'rendered') {
    const {changed, removed} = file.body.fragment.changes;
    if (changed > 0) parts.push(`${changed} changed`);
    if (removed > 0) parts.push(`${removed} removed`);
    total = changed + removed;
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
const BODY_STATE: Record<Exclude<PageBody['kind'], 'rendered'>, string> = {
  empty: 'empty',
  tooLarge: 'too large to render',
  notUtf8: 'not UTF-8 text',
  failed: "couldn't render",
  pending: 'not rendered yet',
};

function body(file: PageFile) {
  if (file.body.kind !== 'rendered') return `<div class="br-body">\n${cardBody(file.body)}\n</div>`;
  const {fragment} = file.body;
  return [
    `<article class="markdown-body${file.status === 'deleted' ? ' br-dimmed' : ''}">\n${fragment.html}\n</article>`,
    ...(fragment.raw ? [rawTemplate(fragment.raw)] : []),
  ].join('\n');
}

// The source as the diff showed it, for the page script's first frame:
// inert in a template, never laid out, read as text. The parser drops a
// newline right after <pre>, so one goes there to keep a blank first line.
function rawTemplate(raw: RawSource) {
  return `<template class="br-raw-source"><pre data-tints="${raw.tints}">\n${escapeHtml(raw.text)}</pre></template>`;
}

function cardBody(fileBody: Exclude<PageBody, {kind: 'rendered'}>) {
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
};

export type OverviewInput = {
  title: PageInput['title'];
  /** In the review's order. */
  entries: OverviewEntry[];
  /** What the pages do differently from github.com, summed. */
  differences: RenderedFragment['differences'];
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What an overview row says of its file: how it got there, then what its
// page shows. A deleted file's page is its base side, so that is all its
// row says, unless the page is a card.
function overviewNote(entry: OverviewEntry, base: string) {
  if (entry.status === 'deleted' && entry.state === 'rendered') return `shown dimmed from ${base}`;
  const notes: string[] = [];
  if (entry.status === 'added') notes.push('new file');
  if (entry.status === 'renamed' && entry.oldPath) notes.push(`renamed from ${entry.oldPath}`);
  if (entry.status === 'untracked') notes.push(entry.state === 'rendered' ? 'untracked · not part of a push yet' : 'untracked');
  if (entry.state !== 'rendered') {
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
    statusLetter(entry.status),
    `<span class="br-row-path">${escapeHtml(entry.path)}</span>`,
    `<span class="br-row-note">${escapeHtml(overviewNote(entry, base))}</span>`,
  ].join('');
  const kind = `br-row br-row-${entry.status}`;
  return entry.href === null
    ? `<li><div class="${kind} br-row-none">${parts}</div></li>`
    : `<li><a class="${kind}" href="${escapeHtml(entry.href)}">${parts}<span class="br-row-open">open ›</span></a></li>`;
}

function overviewGroup(heading: string, entries: OverviewEntry[], base: string) {
  if (entries.length === 0) return '';
  return [
    '<section class="br-group">',
    `<h2 class="br-group-title">${heading}</h2>`,
    '<ul class="br-rows">',
    ...entries.map((entry) => overviewRow(entry, base)),
    '</ul>',
    '</section>',
  ].join('\n');
}

/**
 * The overview: every rendered file of the review, deleted ones apart, each
 * row opening its page, and what the pages do differently from github.com.
 */
export function assembleOverview({title, entries, differences}: OverviewInput): string {
  const pages = entries.filter((entry) => entry.status !== 'deleted');
  const deleted = entries.filter((entry) => entry.status === 'deleted');
  // Each count matches its group's rows.
  const counts = [plural(pages.length, 'page'), ...(deleted.length > 0 ? [`${deleted.length} deleted`] : [])];
  const total = differences.reduce((sum, difference) => sum + difference.count, 0);
  const foot = total === 0 ? '' : ` · ${plural(total, 'difference')}: ${differences.map((difference) => DIFFERENCE_TEXT[difference.kind](difference.count)).join(', ')}`;
  return [
    ...documentHead('Overview'),
    '<body>',
    strip(title, differences, false),
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
    overviewGroup('Deleted', deleted, title.base),
    `<p class="br-overview-foot">≈ GitHub · rendered offline with GitHub's stylesheet${escapeHtml(foot)}</p>`,
    '</div>',
    '</main>',
    '</div>',
    ...documentFoot(OVERVIEW_KEYS),
  ].join('\n');
}
