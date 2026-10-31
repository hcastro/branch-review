import fs from 'node:fs';
import path from 'node:path';
import {escapeHiddenCharacters, escapeHiddenCharactersInJson} from '../controlChars.js';
import type {DiffRange, FileStatus} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import type {ReviewModel} from '../review/model.js';
import {reviewAssetSides} from './assets.js';
import {changeGroups} from './changes.js';
import {failedMarkdownPage, renderableKind} from './classify.js';
import {pageKey, railSignature} from './keys.js';
import type {DifferenceKind, LinkAnswer, RenderedFragment} from './markdown.js';
import {assembleFilePage, railLabel, type PageBody, type RailEntry} from './page.js';
import {createRenderThread} from './renderThread.js';
import {writeErrorReason} from './site.js';
import {createSourceReader, oneLine, pageBody, sourceSpec} from './source.js';

// `--render-out <dir>`: the review's markdown pages written to a directory,
// in this process, with no UI and no browser. The same renderer and page
// shell as the TUI's pages; this module owns only reading each file's text,
// naming the pages and writing them.

// The renderer's deadline per file, as for a fragment in the UI. A file past
// it shows its raw text under a one-line reason.
const RENDER_DEADLINE_MS = 5000;

export type RenderOutPage = {
  path: string;
  status: FileStatus;
  /** The page's file name inside the out dir. */
  file: string;
  state: PageBody['kind'];
  changes: RenderedFragment['changes'];
  differences: Array<{kind: DifferenceKind; count: number}>;
  reason?: string;
};

export type RenderOutReport = {
  version: 1;
  base: string;
  branch: string;
  /** The out dir, absolute. */
  dir: string;
  pages: RenderOutPage[];
};

type Options = {
  cwd: string;
  range: DiffRange;
  review: ReviewModel;
  /** Absolute. */
  outDir: string;
  /** The out dir as the user typed it, for messages. */
  outLabel: string;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function renderToDirectory({cwd, range, review, outDir, outLabel, now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}: Options): Promise<RenderOutReport> {
  // A markdown file whose review entry failed is listed too, as a page or a
  // card, so no failure goes missing from the run.
  const files = review.files.flatMap((file) => {
    if (renderableKind(file, range) === 'markdown') return [{file}];
    const failed = failedMarkdownPage(file, range);
    return failed === null ? [] : [{file, ...('reason' in failed ? {failure: failed.reason} : {})}];
  });
  const rail = railSignature(files.map(({file}) => file));
  const planned = files.map(({file, failure}) => {
    const ids = patchObjectIds(file.rawDiff) ?? {};
    const groups = changeGroups(file);
    return {file, failure, ids, groups, key: pageKey({path: file.path, ...(file.oldPath ? {oldPath: file.oldPath} : {}), status: file.status, ...ids, groups, rail})};
  });

  // A link to another rendered file opens its page. A deleted file's page
  // exists, but the link is broken on GitHub, so it reads as missing. Any
  // other path is outside the review.
  const links: Record<string, LinkAnswer> = Object.fromEntries(planned.map(({file, key}): [string, LinkAnswer] => [
    file.path,
    file.status === 'deleted' ? {kind: 'missing'} : {kind: 'inReview', href: `${key}.html`},
  ]));

  const bodies: PageBody[] = [];
  const thread = createRenderThread({deadlineMs: RENDER_DEADLINE_MS});
  const reader = createSourceReader({sleep});
  // The images on every page, under the same rule as the TUI's pages.
  const assets = reviewAssetSides(review, range, 0);
  try {
    for (const {file, failure, ids, groups} of planned) {
      if (failure !== undefined) {
        bodies.push({kind: 'failed', reason: oneLine(failure), source: ''});
        continue;
      }
      const render = (source: string) => thread.render({cwd, path: file.path, ...(file.oldPath ? {oldPath: file.oldPath} : {}), status: file.status, source, groups, links, assets});
      bodies.push(await pageBody(() => reader.read(cwd, sourceSpec(file, range, ids)), render));
    }
  } finally {
    await thread.close();
  }

  const railEntries = planned.map(({file, key}, index): Omit<RailEntry, 'current'> => ({
    path: file.path,
    status: file.status,
    href: `${key}.html`,
    label: railLabel(file.status, changesOf(bodies[index]!)),
  }));

  prepareDir(outDir, outLabel);
  const renderedAt = now();
  const title = {repo: path.basename(cwd), base: review.base, branch: review.branch, worktree: range.includeWorktree, renderedAt};
  const report: RenderOutPage[] = [];
  for (const [index, {file, key}] of planned.entries()) {
    const body = bodies[index]!;
    const html = assembleFilePage({
      title,
      file: {path: file.path, status: file.status, ...(file.oldPath ? {oldPath: file.oldPath} : {}), body},
      rail: railEntries.map((entry) => ({...entry, current: entry.path === file.path})),
    });
    writePage(outDir, outLabel, `${key}.html`, html);
    report.push({
      path: file.path,
      status: file.status,
      file: `${key}.html`,
      state: body.kind,
      changes: body.kind === 'rendered' ? body.fragment.changes : {changed: 0, removed: 0},
      differences: body.kind === 'rendered' ? body.fragment.differences : [],
      ...(body.kind === 'failed' ? {reason: body.reason} : {}),
    });
  }

  return {version: 1, base: review.base, branch: review.branch, dir: outDir, pages: report};
}

function writeFailure(outLabel: string, error: unknown) {
  return new Error(`can't write the pages to ${outLabel}: ${writeErrorReason(error)}`);
}

function prepareDir(outDir: string, outLabel: string) {
  try {
    fs.mkdirSync(outDir, {recursive: true});
    if (!fs.statSync(outDir).isDirectory()) throw Object.assign(new Error('not a directory'), {code: 'ENOTDIR'});
  } catch (error) {
    throw writeFailure(outLabel, error);
  }
}

// Temp name then rename, so a reader never sees half a page, and a rerun
// replaces its own pages in place. Nothing else in the dir is touched.
function writePage(outDir: string, outLabel: string, name: string, html: string) {
  const temp = path.join(outDir, `.${name}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, html, {flag: 'wx', mode: 0o644});
    fs.renameSync(temp, path.join(outDir, name));
  } catch (error) {
    fs.rmSync(temp, {force: true});
    throw writeFailure(outLabel, error);
  }
}

function changesOf(body: PageBody) {
  return body.kind === 'rendered' ? body.fragment.changes : null;
}

const STATUS_LETTERS: Record<FileStatus, string> = {modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U'};
const STATUS_NOTES: Partial<Record<FileStatus, string>> = {added: 'new file', untracked: 'untracked', deleted: 'deleted', renamed: 'renamed'};
const STATE_NOTES: Partial<Record<PageBody['kind'], string>> = {empty: 'empty', tooLarge: 'too large to render', notUtf8: 'not UTF-8 text', failed: "couldn't render"};

/**
 * The plain-text report: one line per page with its status, its file in
 * the out dir and what changed. Repo paths pass through
 * escapeHiddenCharacters, as everywhere the tool prints them.
 */
export function formatRenderOutSummary(report: RenderOutReport, outLabel: string) {
  if (report.pages.length === 0) return 'nothing to render · no markdown files on this branch\n';
  const dir = outLabel.endsWith('/') ? outLabel : `${outLabel}/`;
  const paths = report.pages.map((page) => escapeHiddenCharacters(page.path));
  const width = Math.max(...paths.map((shown) => shown.length)) + 3;
  const lines = report.pages.map((page, index) => {
    const notes = [STATUS_NOTES[page.status], STATE_NOTES[page.state]].filter((note): note is string => Boolean(note));
    if (page.changes.changed > 0) notes.push(`${page.changes.changed} changed`);
    if (page.changes.removed > 0) notes.push(`${page.changes.removed} removed`);
    const differences = page.differences.reduce((sum, difference) => sum + difference.count, 0);
    if (differences > 0) notes.push(`${differences} difference${differences === 1 ? '' : 's'}`);
    // Some changes leave nothing to mark, such as a new link definition.
    const note = notes.length > 0 ? notes.join(' · ') : 'no blocks marked';
    return `  ${STATUS_LETTERS[page.status]} ${paths[index]!.padEnd(width)}${dir}${page.file}  ${note}`;
  });
  const count = report.pages.length;
  return [`Rendered ${count} page${count === 1 ? '' : 's'} to ${dir} · nothing left this machine`, ...lines, ''].join('\n');
}

/**
 * The JSON report. Repo paths and refs can hold characters JSON.stringify
 * leaves as they are, such as C1 and bidi controls, so those are escaped
 * too: the JSON decodes to the same values and prints as plain text.
 */
export function formatRenderOutJson(report: RenderOutReport) {
  return `${escapeHiddenCharactersInJson(JSON.stringify(report, null, 2))}\n`;
}
