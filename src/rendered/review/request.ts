import type {DiffRange} from '../../git.js';
import {isBinaryPatch, patchObjectIds} from '../../media/classify.js';
import type {ReviewFile} from '../../review/model.js';
import type {ReviewCardRequest, ReviewFragmentRequest} from '../backend.js';
import type {SourceSpec} from '../source.js';
import {lfsPointerSize, type CardSpecial} from './special.js';

// The Review in browser page's cards as the UI process plans them, from the
// review the TUI already built: no git runs here, only the review's patches
// are read. The worker reads each side's text, colors it and draws the page.

/** What the review renders of a file besides its diff: a markdown file's rich view, or an image's sides. */
export type CardRender = {kind: 'markdown' | 'raster' | 'svg'; fragment: ReviewFragmentRequest | null; failure?: string; brokenRefs?: readonly number[]; deferred?: true};

export function reviewCardRequest(file: ReviewFile, range: Pick<DiffRange, 'branch' | 'includeWorktree'>, render: CardRender | null): ReviewCardRequest {
  const special = cardSpecial(file);
  const mode = MODE_CHANGE.exec(file.rawDiff);
  const fragment = render?.fragment;
  return {
    path: file.path,
    ...(file.oldPath ? {oldPath: file.oldPath} : {}),
    status: file.status,
    additions: file.metrics.additions,
    deletions: file.metrics.deletions,
    kind: render?.kind ?? 'text',
    identity: fileIdentity(file),
    blocks: file.blocks.map((block) => ({rawDiff: block.rawDiff})),
    // A Git LFS pointer's side is read too: the worker checks that the whole
    // file is the pointer its hunk shows.
    sides: file.blocks.length > 0 && (!special || special.kind === 'lfs') ? textSides(file, range) : {},
    ...(fragment ? {fragment} : {}),
    ...(!fragment && render?.deferred ? {deferred: true as const} : {}),
    ...(render?.failure !== undefined ? {renderFailure: render.failure} : {}),
    ...(render?.brokenRefs && render.brokenRefs.length > 0 ? {brokenRefs: render.brokenRefs} : {}),
    ...(special ? {special} : {}),
    ...(mode && !special ? {mode: {from: mode[1]!, to: mode[2]!}} : {}),
  };
}

// Where each side's text is: the blob its patch names, or for the reviewed
// side of uncommitted work the file itself, checked against that id, as
// the markdown pages read it. A side with no id has none to read.
// A submodule's patch names commits of the submodule, which the repo
// itself never holds: it has no text to read on either side. Only git's
// own header says so, the lines before the first hunk, split at newlines
// alone: a hunk's line is the file's text, and a carriage return or a
// Unicode line break in it could otherwise pass for a header line.
const GITLINK = /^(?:(?:new file |deleted file |old |new )mode 160000|index \S+ 160000)$/;

function isGitlink(rawDiff: string) {
  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('@@ ')) return false;
    if (GITLINK.test(line)) return true;
  }
  return false;
}

function textSides(file: ReviewFile, range: Pick<DiffRange, 'branch' | 'includeWorktree'>): ReviewCardRequest['sides'] {
  if (file.pathError || isGitlink(file.rawDiff)) return {};
  const ids = patchObjectIds(file.rawDiff) ?? {};
  const before: SourceSpec | undefined = ids.before && file.status !== 'added' && file.status !== 'untracked' ? {kind: 'blob', id: ids.before} : undefined;
  let after: SourceSpec | undefined;
  if (file.status !== 'deleted') {
    if (range.includeWorktree || file.status === 'untracked') after = {kind: 'worktree', path: file.path, ...(ids.after ? {id: ids.after} : {})};
    else if (ids.after) after = {kind: 'blob', id: ids.after};
  }
  return {...(before ? {before} : {}), ...(after ? {after} : {})};
}

const MODE_CHANGE = /^old mode (\d+)\nnew mode (\d+)$/m;
const MODE_LINE = /^(?:old|new|new file|deleted file) mode \d+$/gm;

// What a file is on each side besides its hunks: both blobs, its modes and
// where it moved from. A viewed mark on an image, a binary file or a mode
// change, none of which has hunks, holds only while these stay the same.
function fileIdentity(file: ReviewFile) {
  const ids = patchObjectIds(file.rawDiff) ?? {};
  return JSON.stringify([ids.before ?? null, ids.after ?? null, file.rawDiff.match(MODE_LINE) ?? [], file.oldPath ?? null]);
}

/**
 * What a file shows in place of a diff, or undefined when its diff is the
 * card: a submodule's commits and a Git LFS pointer's file have hunks, but
 * the lines are no text of the file.
 */
export function cardSpecial(file: ReviewFile): CardSpecial | undefined {
  if (isGitlink(file.rawDiff)) return submodule(file);
  const lfs = lfsPointer(file);
  if (lfs) return lfs;
  if (file.blocks.length > 0) return undefined;
  if (file.rawDiff === '' && file.error) return {kind: 'unreadable', reason: file.error};
  if (isBinaryPatch(file.rawDiff)) return {kind: 'binary'};
  const mode = MODE_CHANGE.exec(file.rawDiff);
  if (mode) return {kind: 'mode', from: mode[1]!, to: mode[2]!};
  if (file.status === 'renamed') return {kind: 'renamed'};
  if (file.status === 'added' || file.status === 'untracked' || file.status === 'deleted') return {kind: 'empty'};
  return {kind: 'none'};
}

// The lines a side of the patch holds: `-` for the base side, `+` for the
// reviewed side, with the unchanged lines on both.
function sideLines(file: ReviewFile, marker: '-' | '+') {
  return file.blocks.flatMap((block) => block.rawDiff.split('\n').slice(1).filter((line) => line[0] === marker || line[0] === ' ').map((line) => line.slice(1)));
}

const SUBPROJECT = /^Subproject commit ([0-9a-f]{40,64})/;

function submodule(file: ReviewFile): CardSpecial {
  const commit = (marker: '-' | '+') => sideLines(file, marker).map((line) => SUBPROJECT.exec(line)?.[1]).find(Boolean);
  const before = commit('-');
  const after = commit('+');
  return {kind: 'submodule', ...(before ? {before} : {}), ...(after ? {after} : {})};
}

// The side the review shows, or the base side of a deleted file, whose
// lines in the patch must all be the pointer's. The patch shows only the
// hunk, so a file that opens like a pointer could go on past it: the
// worker reads the side to check (review/build.ts).
function lfsPointer(file: ReviewFile): CardSpecial | undefined {
  if (file.blocks.length !== 1) return undefined;
  const bytes = lfsPointerSize(sideLines(file, file.status === 'deleted' ? '-' : '+'));
  return bytes === undefined ? undefined : {kind: 'lfs', bytes};
}
