import type {DiffRange} from '../../git.js';
import {isBinaryPatch, patchObjectIds} from '../../media/classify.js';
import type {ReviewFile} from '../../review/model.js';
import type {ReviewCardRequest, ReviewFragmentRequest} from '../backend.js';
import type {SourceSpec} from '../source.js';

// The Review in browser page's cards as the UI process plans them, from the
// review the TUI already built: no git runs here, only the review's patches
// are read. The worker reads each side's text, colors it and draws the page.

/** What the review renders of a file besides its diff: a markdown file's rich view, or an image's sides. */
export type CardRender = {kind: 'markdown' | 'raster' | 'svg'; fragment: ReviewFragmentRequest | null; failure?: string; brokenRefs?: readonly number[]};

export function reviewCardRequest(file: ReviewFile, range: Pick<DiffRange, 'branch' | 'includeWorktree'>, render: CardRender | null): ReviewCardRequest {
  const notice = cardNotice(file);
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
    sides: file.blocks.length > 0 ? textSides(file, range) : {},
    ...(fragment ? {fragment} : {}),
    ...(render?.failure !== undefined ? {renderFailure: render.failure} : {}),
    ...(render?.brokenRefs && render.brokenRefs.length > 0 ? {brokenRefs: render.brokenRefs} : {}),
    ...(notice !== undefined ? {notice} : {}),
  };
}

// Where each side's text is: the blob its patch names, or for the reviewed
// side of uncommitted work the file itself, checked against that id, as
// the markdown pages read it. A side with no id has none to read.
// A submodule's patch names commits of the submodule, which the repo
// itself never holds: it has no text to read on either side.
const GITLINK = /^(?:(?:new file |deleted file |old |new )mode 160000|index \S+ 160000)$/m;

function textSides(file: ReviewFile, range: Pick<DiffRange, 'branch' | 'includeWorktree'>): ReviewCardRequest['sides'] {
  if (file.pathError || GITLINK.test(file.rawDiff)) return {};
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

/** Why a file has no diff to show, in one line, or undefined when it has one. */
export function cardNotice(file: ReviewFile): string | undefined {
  if (file.blocks.length > 0) return undefined;
  if (file.rawDiff === '' && file.error) return `This file's diff couldn't be read: ${file.error}`;
  if (isBinaryPatch(file.rawDiff)) return 'Binary file not shown.';
  const mode = MODE_CHANGE.exec(file.rawDiff);
  if (mode) return `File mode changed from ${mode[1]} to ${mode[2]}.`;
  if (file.status === 'renamed') return 'File renamed without changes.';
  if (file.status === 'added' || file.status === 'untracked') return 'Empty file added.';
  if (file.status === 'deleted') return 'Empty file deleted.';
  return 'No changes to show.';
}
