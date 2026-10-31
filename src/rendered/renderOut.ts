import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isUtf8} from 'node:buffer';
import {escapeHiddenCharacters, escapeHiddenCharactersInJson} from '../controlChars.js';
import {
  blobFactsOperation,
  catFileBlobOperation,
  gitBlobId,
  objectAtRefOperation,
  objectFormatOperation,
  openWorktreeFile,
  readBlobHead,
  runOperation,
  type DiffRange,
  type FileStatus,
  type ObjectFormat,
} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import type {ReviewFile, ReviewModel} from '../review/model.js';
import {changeGroups} from './changes.js';
import {failedMarkdownPage, renderableKind} from './classify.js';
import {pageKey, railSignature} from './keys.js';
import type {DifferenceKind, LinkAnswer, RenderedFragment} from './markdown.js';
import {assembleFilePage, type PageBody, type RailEntry} from './page.js';
import {createRenderThread} from './renderThread.js';

// `--render-out <dir>`: the review's markdown pages written to a directory,
// in this process, with no UI and no browser. The same renderer and page
// shell as the TUI's pages; this module owns only reading each file's text,
// naming the pages and writing them.

// Larger files show a card and their first bytes instead of a page, and no
// more than that is read.
const RENDER_LIMIT = 2 * 1024 * 1024;
const RAW_HEAD_BYTES = 64 * 1024;
// The renderer's deadline per file, as for a fragment in the UI. A file past
// it shows its raw text under a one-line reason.
const RENDER_DEADLINE_MS = 5000;
// After a work tree file reads as other text than its diff, how long to wait
// before reading it again, as the media reader does, to let a write finish.
const REREAD_DELAY_MS = 500;

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
    return {file, failure, ids, groups, key: pageKey({path: file.path, status: file.status, ...ids, groups, rail})};
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
  let format: ObjectFormat | undefined;
  const reader: SourceReader = {
    format: () => (format ??= runOperation(objectFormatOperation(cwd))),
    sleep,
  };
  try {
    for (const {file, failure, ids, groups} of planned) {
      if (failure !== undefined) {
        bodies.push({kind: 'failed', reason: oneLine(failure), source: ''});
        continue;
      }
      bodies.push(await pageBody(() => readSource(cwd, range, file, ids, reader), (source) => thread.render({path: file.path, source, groups, links})));
    }
  } finally {
    await thread.close();
  }

  const railEntries = planned.map(({file, key}, index): Omit<RailEntry, 'current'> => ({
    path: file.path,
    status: file.status,
    href: `${key}.html`,
    label: railLabel(file.status, bodies[index]!),
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

async function pageBody(read: () => Promise<SourceRead>, render: (source: string) => Promise<RenderedFragment>): Promise<PageBody> {
  let text: SourceRead;
  try {
    text = await read();
  } catch (error) {
    return {kind: 'failed', reason: oneLine(error), source: ''};
  }
  if (text.kind === 'tooLarge') return {kind: 'tooLarge', bytes: text.bytes, head: text.head.toString('utf8')};
  if (text.kind === 'mismatch') return {kind: 'failed', reason: text.reason, source: isUtf8(text.bytes) ? text.bytes.toString('utf8') : ''};
  const {bytes} = text;
  if (bytes.length === 0) return {kind: 'empty'};
  if (!isUtf8(bytes)) return {kind: 'notUtf8'};

  const source = bytes.toString('utf8');
  try {
    return {kind: 'rendered', fragment: await render(source)};
  } catch (error) {
    // One file that won't render is a card on its page, not a failed run.
    return {kind: 'failed', reason: oneLine(error), source};
  }
}

// A file's text, or for a file over the render limit its size and first
// bytes, read without the rest. A work tree file whose text isn't the text
// its diff was read from is `mismatch`, with what it holds now.
type SourceRead =
  | {kind: 'text'; bytes: Buffer}
  | {kind: 'tooLarge'; bytes: number; head: Buffer}
  | {kind: 'mismatch'; bytes: Buffer; reason: string};

type SourceReader = {format: () => ObjectFormat; sleep: (ms: number) => Promise<void>};

// The text a page shows: the base side for a deleted file, else the
// reviewed side, read by the object id git printed for it where there is
// one. A pure rename has no id; its text is the blob the branch holds at its
// new path, read the same way.
async function readSource(cwd: string, range: DiffRange, file: ReviewFile, ids: {before?: string; after?: string}, reader: SourceReader): Promise<SourceRead> {
  if (file.status === 'deleted') {
    if (!ids.before) throw new Error('no base version to show');
    return readBlob(cwd, ids.before, file.path);
  }
  if (range.includeWorktree || file.status === 'untracked') return readCheckedWorktreeSource(cwd, file.path, ids.after, reader);
  return readBlob(cwd, ids.after ?? runOperation(objectAtRefOperation(cwd, range.branch, file.path)), file.path);
}

/**
 * A work tree file is read after the review read its diff, and an editor
 * or an agent can write it in between. The marks come from that diff, so
 * the bytes must hash to the id the diff names, as the media reader checks
 * its images, or a mark could land on other text. A mismatch is read once
 * more after a pause, for a write in progress. Bytes that differ only in
 * CRLF line ends, which git turns into LF as it reads the file, still line
 * up with the diff.
 */
async function readCheckedWorktreeSource(cwd: string, filePath: string, id: string | undefined, reader: SourceReader): Promise<SourceRead> {
  const matches = (read: SourceRead) => {
    if (read.kind !== 'text' || id === undefined) return true;
    const format = reader.format();
    if (gitBlobId(read.bytes, format).startsWith(id)) return true;
    return gitBlobId(Buffer.from(read.bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'), format).startsWith(id);
  };
  const first = await readWorktreeSource(cwd, filePath);
  if (matches(first)) return first;
  await reader.sleep(REREAD_DELAY_MS);
  const again = await readWorktreeSource(cwd, filePath);
  if (matches(again) || again.kind !== 'text') return again;
  const same = first.kind === 'text' && first.bytes.equals(again.bytes);
  return {
    kind: 'mismatch',
    bytes: again.bytes,
    reason: same ? "doesn't match the diff: changed since the review read it, or changed by a git filter" : 'changed on disk while rendering',
  };
}

async function readBlob(cwd: string, abbrevId: string, displayPath: string): Promise<SourceRead> {
  const facts = runOperation(blobFactsOperation(cwd, abbrevId));
  if (facts.size > RENDER_LIMIT) return {kind: 'tooLarge', bytes: facts.size, head: await readBlobHead(cwd, facts.oid, RAW_HEAD_BYTES)};
  return {kind: 'text', bytes: runOperation(catFileBlobOperation(cwd, facts.oid, RENDER_LIMIT, displayPath))};
}

// Opened the way the review opens work tree files: no symlinks, nothing
// outside the repo.
async function readWorktreeSource(cwd: string, filePath: string): Promise<SourceRead> {
  const {handle, stat} = await openWorktreeFile(cwd, filePath);
  try {
    const wanted = Math.min(stat.size, RENDER_LIMIT) + 1;
    const buffer = Buffer.alloc(wanted);
    let total = 0;
    while (total < wanted) {
      const {bytesRead} = await handle.read(buffer, total, wanted - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > RENDER_LIMIT) return {kind: 'tooLarge', bytes: Math.max(stat.size, total), head: buffer.subarray(0, RAW_HEAD_BYTES)};
    return {kind: 'text', bytes: buffer.subarray(0, total)};
  } finally {
    await handle.close();
  }
}

function railLabel(status: FileStatus, body: PageBody) {
  if (status === 'added' || status === 'untracked') return '+';
  if (status === 'deleted') return '−';
  if (body.kind !== 'rendered') return '·';
  const total = body.fragment.changes.changed + body.fragment.changes.removed;
  return total > 0 ? String(total) : '·';
}

// A reason fit for a page: its first line, with no absolute home path.
function oneLine(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0] || 'unknown error';
  const home = os.homedir();
  return home ? message.split(home).join('~') : message;
}

function writeFailure(outLabel: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  const reason = code === 'ENOSPC' ? 'disk full'
    : code === 'ENOTDIR' || code === 'EEXIST' ? 'not a directory'
      : code === 'EACCES' || code === 'EPERM' ? 'permission denied'
        : code === 'EROFS' ? 'read-only file system' : oneLine(error);
  return new Error(`can't write the pages to ${outLabel}: ${reason}`);
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
