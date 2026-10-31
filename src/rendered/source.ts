import os from 'node:os';
import {isUtf8} from 'node:buffer';
import {
  blobFactsOperation,
  catFileBlobOperation,
  matchingBlobId,
  objectAtRefOperation,
  objectFormatOperation,
  openWorktreeFile,
  readBlobHead,
  runOperationAsync,
  type DiffRange,
  type ObjectFormat,
} from '../git.js';
import type {ReviewFile} from '../review/model.js';
import type {RenderedFragment} from './markdown.js';
import type {PageBody} from './page.js';

// A markdown file's text for its page, read the same way for the TUI's
// pages and for `--render-out`: the side the review shows, proven to be the
// text its diff was read from, or a card that says why not.

// Larger files show a card and their first bytes instead of a page, and no
// more than that is read.
export const RENDER_LIMIT = 2 * 1024 * 1024;
const RAW_HEAD_BYTES = 64 * 1024;
// After a work tree file reads as other text than its diff, how long to wait
// before reading it again, as the media reader does, to let a write finish.
const REREAD_DELAY_MS = 500;

/**
 * Where a page's text comes from: a blob the diff named, the work tree file
 * (checked against the id the diff named, when it named one), or what a ref
 * holds at a path, for a pure rename, whose patch names no id.
 */
export type SourceSpec =
  | {kind: 'blob'; id: string}
  | {kind: 'worktree'; path: string; id?: string}
  | {kind: 'atRef'; ref: string; path: string}
  | {kind: 'none'; reason: string};

/**
 * The text a page shows: the base side for a deleted file, else the
 * reviewed side. Pure: reads only the review entry.
 */
export function sourceSpec(file: ReviewFile, range: Pick<DiffRange, 'branch' | 'includeWorktree'>, ids: {before?: string; after?: string}): SourceSpec {
  if (file.status === 'deleted') return ids.before ? {kind: 'blob', id: ids.before} : {kind: 'none', reason: 'no base version to show'};
  if (range.includeWorktree || file.status === 'untracked') return {kind: 'worktree', path: file.path, ...(ids.after ? {id: ids.after} : {})};
  return ids.after ? {kind: 'blob', id: ids.after} : {kind: 'atRef', ref: range.branch, path: file.path};
}

// A file's text, or for a file over the render limit its size and first
// bytes, read without the rest. A work tree file whose text isn't the text
// its diff was read from is `mismatch`, with what it holds now.
type SourceRead =
  | {kind: 'text'; bytes: Buffer}
  | {kind: 'tooLarge'; bytes: number; head: Buffer}
  | {kind: 'mismatch'; bytes: Buffer; reason: string};

export function createSourceReader({sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}: {sleep?: (ms: number) => Promise<void>} = {}) {
  const formats = new Map<string, Promise<ObjectFormat>>();
  const formatFor = (cwd: string) => {
    let format = formats.get(cwd);
    if (!format) {
      format = runOperationAsync(objectFormatOperation(cwd));
      formats.set(cwd, format);
      format.catch(() => formats.delete(cwd));
    }
    return format;
  };

  /**
   * A work tree file is read after the review read its diff, and an editor
   * or an agent can write it in between. The marks come from that diff, so
   * the bytes must hash to the id the diff names, as the media reader checks
   * its images, or a mark could land on other text. A mismatch is read once
   * more after a pause, for a write in progress. Bytes that differ only in
   * CRLF line ends still line up with the diff.
   */
  async function readCheckedWorktree(cwd: string, filePath: string, id: string | undefined): Promise<SourceRead> {
    const format = id === undefined ? null : await formatFor(cwd);
    const matches = (read: SourceRead) => read.kind !== 'text' || id === undefined || format === null || matchingBlobId(read.bytes, id, format) !== null;
    const first = await readWorktreeSource(cwd, filePath);
    if (matches(first)) return first;
    await sleep(REREAD_DELAY_MS);
    const again = await readWorktreeSource(cwd, filePath);
    if (matches(again) || again.kind !== 'text') return again;
    const same = first.kind === 'text' && first.bytes.equals(again.bytes);
    return {
      kind: 'mismatch',
      bytes: again.bytes,
      reason: same ? "doesn't match the diff: changed since the review read it, or changed by a git filter" : 'changed on disk while rendering',
    };
  }

  return {
    read(cwd: string, spec: SourceSpec): Promise<SourceRead> {
      switch (spec.kind) {
        case 'blob':
          return readBlob(cwd, spec.id, spec.id);
        case 'worktree':
          return readCheckedWorktree(cwd, spec.path, spec.id);
        case 'atRef':
          return runOperationAsync(objectAtRefOperation(cwd, spec.ref, spec.path)).then((id) => readBlob(cwd, id, spec.path));
        case 'none':
          return Promise.reject(new Error(spec.reason));
      }
    },
  };
}

export type SourceReader = ReturnType<typeof createSourceReader>;

async function readBlob(cwd: string, abbrevId: string, displayPath: string): Promise<SourceRead> {
  const facts = await runOperationAsync(blobFactsOperation(cwd, abbrevId));
  if (facts.size > RENDER_LIMIT) return {kind: 'tooLarge', bytes: facts.size, head: await readBlobHead(cwd, facts.oid, RAW_HEAD_BYTES)};
  return {kind: 'text', bytes: await runOperationAsync(catFileBlobOperation(cwd, facts.oid, RENDER_LIMIT, displayPath))};
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

/**
 * A page's body: the rendered fragment, or the card for a file that is
 * empty, too large, not UTF-8 text, not the text its diff named, or that
 * failed to read or render. One file that won't render is a card on its
 * page, never a failed job.
 */
export async function pageBody(read: () => Promise<SourceRead>, render: (source: string) => Promise<RenderedFragment>): Promise<PageBody> {
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
    return {kind: 'failed', reason: oneLine(error), source};
  }
}

/** A reason fit for a page or a toast: its first line, with no absolute home path. */
export function oneLine(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0] || 'unknown error';
  const home = os.homedir();
  return home ? message.split(home).join('~') : message;
}
