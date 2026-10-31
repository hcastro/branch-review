import path from 'node:path';
import type {FileStatus} from '../git.js';
import {PAGE_CSS, PAGE_CSS_HASH} from './assets.generated.js';
import type {DifferenceKind, RenderedFragment} from './markdown.js';

// Whole HTML documents around rendered fragments. A page is one
// self-contained file: its only style is the inlined stylesheet, allowed by
// hash, and it has no script, so it reads the same with scripting off. Every
// repo-supplied string printed here is escaped, and the fragment itself is
// already sanitized.

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

/** A rail entry's count: `+` for a new file, `−` for a deleted one, else its changed and removed blocks, `·` for none. */
export function railLabel(status: FileStatus, changes: RenderedFragment['changes'] | null) {
  if (status === 'added' || status === 'untracked') return '+';
  if (status === 'deleted') return '−';
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

/** The page's whole policy: nothing loads, nothing runs, only our style applies. */
export function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    'img-src data:',
    `style-src '${PAGE_CSS_HASH}'`,
    "script-src 'none'",
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

export function assembleFilePage(input: PageInput): string {
  const {title, file, rail} = input;
  const name = path.posix.basename(file.path);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(name)} · branch-review</title>`,
    `<style>${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    strip(title, file.body.kind === 'rendered' ? file.body.fragment.differences : []),
    '<div class="br-layout">',
    railNav(rail, title),
    '<main class="br-main">',
    switcher(rail, file),
    fileHead(file),
    banners(file, title),
    body(file),
    '</main>',
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function strip(title: PageInput['title'], differences: RenderedFragment['differences']) {
  return [
    '<header class="br-strip">',
    '<span class="br-brand"><span class="br-brand-mark" aria-hidden="true">▍</span><span class="br-brand-word">branch-review</span></span>',
    `<span class="br-refs" title="${escapeHtml(title.repo)}"><span class="br-base">${escapeHtml(title.base)}</span><span class="br-arrow">←</span><span class="br-branch">${escapeHtml(title.branch)}</span></span>`,
    '<div class="br-strip-end">',
    fidelity(differences),
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
        `<span class="br-rail-count">${escapeHtml(entry.label)}</span>`,
        '</a></li>',
      ].join('');
    }),
    '</ul>',
  ].join('\n'));
}

function railNav(rail: RailEntry[], title: PageInput['title']) {
  const renderedAt = new Date(title.renderedAt);
  return [
    '<nav class="br-rail" aria-label="Rendered files">',
    `<p class="br-rail-title">CHANGED · ${rail.length} rendered</p>`,
    ...railLists(rail),
    `<p class="br-rail-foot">Rendered offline <time datetime="${renderedAt.toISOString()}">${renderedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</time>. Nothing left this machine.</p>`,
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
  if (file.body.kind === 'rendered') {
    const {changed, removed} = file.body.fragment.changes;
    if (changed > 0) parts.push(`${changed} changed`);
    if (removed > 0) parts.push(`${removed} removed`);
  } else {
    parts.push(BODY_STATE[file.body.kind]);
  }
  return [
    '<div class="br-filehead">',
    `<h1 class="br-path">${crumbs}</h1>`,
    `<p class="br-summary">${parts.join(' · ')}</p>`,
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
  return file.body.kind === 'rendered'
    ? `<article class="markdown-body${file.status === 'deleted' ? ' br-dimmed' : ''}">\n${file.body.fragment.html}\n</article>`
    : `<div class="br-body">\n${cardBody(file.body)}\n</div>`;
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
