import {fileKey, type DiffRange} from '../git.js';
import type {ReviewFile} from '../review/model.js';
import type {MediaFormat, MediaKind, MediaRef, SideName, SideRef} from './types.js';

// Which review files are media, read from the patch git already printed, so
// the review model and its build need no change. The `index <old>..<new>`
// line carries the object ids git computed for both sides (the work tree
// side included), which every byte read is later verified against. Anything
// that does not fit the rules below is not media and keeps today's view.

const FORMATS: Record<string, {format: MediaFormat; kind: MediaKind}> = {
  png: {format: 'png', kind: 'raster'},
  jpg: {format: 'jpeg', kind: 'raster'},
  jpeg: {format: 'jpeg', kind: 'raster'},
  gif: {format: 'gif', kind: 'raster'},
  webp: {format: 'webp', kind: 'raster'},
  avif: {format: 'avif', kind: 'raster'},
  svg: {format: 'svg', kind: 'svg'},
  mp4: {format: 'mp4', kind: 'video'},
  m4v: {format: 'mp4', kind: 'video'},
  mov: {format: 'mov', kind: 'video'},
  webm: {format: 'webm', kind: 'video'},
};

// Symlinks (120000) and gitlinks (160000): their "content" is a link target
// or a commit id, never image bytes.
const LINK_MODE_LINE = /^(?:(?:new|deleted) file mode 1[26]0000|(?:old|new) mode 1[26]0000|index [0-9a-f]+\.\.[0-9a-f]+ 1[26]0000)$/m;
const INDEX_LINE = /^index ([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})(?: [0-7]{6})?$/m;
const BINARY_LINE = /^(?:Binary files .* differ|GIT binary patch)$/m;
const ABSENT_ID = /^0+$/;

type Memo = {includeWorktree: boolean; ref: MediaRef | null};
const memo = new WeakMap<ReviewFile, Memo>();

function formatFor(filePath: string) {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return FORMATS[name.slice(dot + 1).toLowerCase()];
}

function sideRef(side: SideName, source: SideRef['source'], filePath: string, abbrevId: string): SideRef {
  return {side, source, path: filePath, abbrevId, key: `${source}|${filePath}|${abbrevId}`};
}

function classify(file: ReviewFile, includeWorktree: boolean): MediaRef | null {
  if (file.pathError || file.error) return null;

  const type = formatFor(file.path);
  if (!type) return null;

  // A type change (file to symlink, say) is two patches in one diff.
  if (file.rawDiff.split('\n').filter((line) => line.startsWith('diff --git ')).length !== 1) return null;
  if (LINK_MODE_LINE.test(file.rawDiff)) return null;

  // A pure rename or a mode-only change has no index line, so there is no
  // content id to verify bytes against; today's line already describes it.
  const index = INDEX_LINE.exec(file.rawDiff);
  if (!index) return null;

  const binary = BINARY_LINE.test(file.rawDiff);
  const hasHunks = file.blocks.length > 0;
  // An image or video drawn as text hunks is a Git LFS pointer or a text file
  // with a media name.
  if (type.kind !== 'svg' && (!binary || hasHunks)) return null;
  if (type.kind === 'svg' && !binary && !hasHunks) return null;

  const oldId = index[1]!;
  const newId = index[2]!;
  const before = ABSENT_ID.test(oldId) ? undefined : sideRef('before', 'blob', file.oldPath ?? file.path, oldId);
  const afterSource = includeWorktree || file.status === 'untracked' ? 'worktree' : 'blob';
  const after = ABSENT_ID.test(newId) ? undefined : sideRef('after', afterSource, file.path, newId);
  if (!before && !after) return null;

  return {
    fileKey: fileKey({path: file.path, nameError: file.pathError}),
    kind: type.kind,
    format: type.format,
    ...(before ? {before} : {}),
    ...(after ? {after} : {}),
    hasSourceBlocks: type.kind === 'svg' && hasHunks,
    contentKey: `${type.format}|${before?.key ?? '-'}|${after?.key ?? '-'}`,
  };
}

/**
 * The media descriptor for a review file, or null when the file is not media
 * and keeps today's view. Pure: no file or git reads. Remembered per review
 * file object, so an unchanged file in a new review costs nothing.
 */
export function classifyMedia(file: ReviewFile, range: Pick<DiffRange, 'includeWorktree'>): MediaRef | null {
  const cached = memo.get(file);
  if (cached && cached.includeWorktree === range.includeWorktree) return cached.ref;

  const ref = classify(file, range.includeWorktree);
  memo.set(file, {includeWorktree: range.includeWorktree, ref});
  return ref;
}
