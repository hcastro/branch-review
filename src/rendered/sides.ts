import type {DiffRange} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import type {ReviewModel} from '../review/model.js';

// The two sides of a review as the asset rule reads them, from the review's
// patches alone. The UI process plans its pages with these, so this module
// imports no renderer.

/**
 * A file the work tree review changed, from its patch: the id of its new
 * content and its mode, null when it's gone, or `unreadable` when the
 * review couldn't read its diff. A pure rename names no id; its content is
 * what `from` holds at the base. `untracked`: not part of a push yet.
 */
export type WorktreeChange = {
  path: string;
  id: string | null;
  mode: 'regular' | 'symlink' | 'submodule' | 'unreadable' | null;
  from?: string;
  untracked?: true;
};

/**
 * The two sides of a review, as the asset rule reads them. `base` is a ref
 * (`main...feature` names their merge base, as the diff does). The after
 * side is a ref, or the work tree: there a file the review changed reads
 * from disk under the id its diff named, and every other file is as `base`
 * holds it, which is what the diff found on disk. `epoch` names the review,
 * so answers about the work tree are asked again for the next one.
 */
export type AssetSides = {base: string | null; after: {tree: string} | {worktree: WorktreeChange[]}; epoch: number};

export type AssetSide = 'base' | 'after';

// The mode git printed for a patch's new side, when it is a link.
const LINK_AFTER = /^(?:new file mode|new mode|index [0-9a-f]+\.\.[0-9a-f]+) (120000|160000)$/m;
// Where a patch's header ends: its first hunk, or its binary content.
const PATCH_BODY = /^(?:@@ |GIT binary patch$|Binary files )/m;

/**
 * Every path the review's files go by, a moved file's old one included:
 * none of them is a file the review left alone.
 */
export function reviewPaths(files: ReadonlyArray<Pick<ReviewModel['files'][number], 'path' | 'oldPath'>>): Set<string> {
  return new Set(files.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])));
}

// Where the last patch of a file's diff starts: a `diff --git ` header at
// the start of a line, never one inside a changed line's text. Lines split
// on LF only, as git writes them; a lone CR inside a line ends nothing.
// -1 when the diff holds no patch.
function lastPatchStart(rawDiff: string) {
  const header = 'diff --git ';
  const after = rawDiff.lastIndexOf(`\n${header}`);
  if (after >= 0) return after + 1;
  return rawDiff.startsWith(header) ? 0 : -1;
}

/** The asset sides of a review. Pure: reads only the patches. */
export function reviewAssetSides(review: Pick<ReviewModel, 'files'>, range: Pick<DiffRange, 'diffArg' | 'branch' | 'includeWorktree'>, epoch: number): AssetSides {
  if (!range.includeWorktree) return {base: range.diffArg, after: {tree: range.branch}, epoch};
  const changes: WorktreeChange[] = [];
  for (const file of review.files) {
    // A name that isn't UTF-8 names no file a link can reach.
    if (file.pathError) continue;
    if (file.oldPath) changes.push({path: file.oldPath, id: null, mode: null});
    if (file.status === 'deleted') {
      changes.push({path: file.path, id: null, mode: null});
      continue;
    }
    // A diff that failed to load, for a file nobody can read, has no patch.
    const start = lastPatchStart(file.rawDiff);
    if (start < 0) {
      changes.push({path: file.path, id: null, mode: 'unreadable'});
      continue;
    }
    // A file that changed type prints two patches; the last is its new side.
    // Its id and mode are in the header, so the hunks are never searched.
    const patch = file.rawDiff.slice(start);
    const body = patch.search(PATCH_BODY);
    const header = body < 0 ? patch : patch.slice(0, body);
    const id = patchObjectIds(header)?.after ?? null;
    const link = LINK_AFTER.exec(header)?.[1];
    if (link) changes.push({path: file.path, id, mode: link === '160000' ? 'submodule' : 'symlink'});
    else {
      changes.push({
        path: file.path,
        id,
        mode: 'regular',
        ...(id === null && file.oldPath ? {from: file.oldPath} : {}),
        ...(file.status === 'untracked' ? {untracked: true as const} : {}),
      });
    }
  }
  return {base: range.diffArg, after: {worktree: changes}, epoch};
}

